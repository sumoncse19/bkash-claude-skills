# frozen_string_literal: true

# bKash PGW v2 Tokenized Checkout client — Ruby 3.0+, stdlib only (net/http, json).
# Docs: https://developer.bka.sh
# Rails: put in app/services/bkash_client.rb and use RailsCacheTokenStore (Redis cache store recommended).
require "json"
require "net/http"
require "uri"
require "bigdecimal"
require "securerandom"

module Bkash
  SANDBOX_URL = "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout"
  PRODUCTION_URL = "https://tokenized.pay.bka.sh/v2/tokenized-checkout"
  SAFE = /\A[^<>&]*\z/
  DONE_CODES = %w[2062 2068 2117 2119].freeze
  REFRESH_BEFORE = 480

  class Error < StandardError
    attr_reader :code, :internal_code, :http_status, :raw

    def initialize(message, code: nil, http_status: 200, raw: nil, internal_code: nil)
      super(message)
      @code = code
      @http_status = http_status
      @raw = raw
      @internal_code = internal_code
    end
  end

  class TimeoutError < StandardError; end

  # Single-process store.
  class MemoryTokenStore
    def initialize
      @state = nil
      @mutex = Mutex.new
    end

    def get = @state
    def set(state) = (@state = state)
    def with_lock(&block) = @mutex.synchronize(&block)
  end

  # Shared store for Rails (Rails.cache backed by Redis/Memcached).
  class RailsCacheTokenStore
    KEY = "bkash:token"

    def get = Rails.cache.read(KEY)
    def set(state) = Rails.cache.write(KEY, state)

    def with_lock
      lock_key = "#{KEY}:lock"
      id = SecureRandom.uuid
      deadline = Time.now + 40
      until Rails.cache.write(lock_key, id, unless_exist: true, expires_in: 35)
        raise Bkash::Error, "Timed out waiting for token lock" if Time.now > deadline
        sleep 0.2
      end
      begin
        yield
      ensure
        Rails.cache.delete(lock_key) if Rails.cache.read(lock_key) == id
      end
    end
  end

  class Client
    def self.from_env(store: nil)
      fetch = ->(k) { ENV.fetch(k) { raise ArgumentError, "Missing env #{k}" } }
      new(base_url: ENV.fetch("BKASH_BASE_URL", SANDBOX_URL), username: fetch.("BKASH_USERNAME"),
          password: fetch.("BKASH_PASSWORD"), app_key: fetch.("BKASH_APP_KEY"), app_secret: fetch.("BKASH_APP_SECRET"),
          store: store, bearer_prefix: ENV["BKASH_BEARER_PREFIX"] == "true")
    end

    def initialize(base_url:, username:, password:, app_key:, app_secret:, store: nil, bearer_prefix: false, timeout: 30)
      @base_url = base_url.sub(%r{/+\z}, "")
      @username = username
      @password = password
      @app_key = app_key
      @app_secret = app_secret
      @store = store || MemoryTokenStore.new
      @bearer_prefix = bearer_prefix
      @timeout = timeout
    end

    # -------------------------------------------------------------- tokens
    def token
      s = @store.get
      return s["id_token"] if s && Time.now.to_i < s["expires_at"] - REFRESH_BEFORE

      @store.with_lock do
        cur = @store.get
        now = Time.now.to_i
        next cur["id_token"] if cur && now < cur["expires_at"] - REFRESH_BEFORE

        recent = (cur&.dig("auth_calls") || []).select { |t| now - t < 3600 }
        if recent.size >= 2
          next cur["id_token"] if cur && now < cur["expires_at"]
          raise Error, "Refusing grant/refresh: 2 calls already in the last hour"
        end

        res = nil
        if cur && now < cur.fetch("refresh_expires_at", 0)
          recent << now
          begin
            res = auth("/auth/refresh-token", app_key: @app_key, app_secret: @app_secret, refresh_token: cur["refresh_token"])
          rescue Error
            raise if recent.size >= 2
          end
        end
        unless res
          res = auth("/auth/grant-token", app_key: @app_key, app_secret: @app_secret)
          recent << Time.now.to_i
        end
        state = {
          "id_token" => res["id_token"], "refresh_token" => res["refresh_token"],
          "expires_at" => Time.now.to_i + res.fetch("expires_in", 3600).to_i,
          "refresh_expires_at" => Time.now.to_i + (29 * 86_400), "auth_calls" => recent
        }
        @store.set(state)
        state["id_token"]
      end
    end

    # -------------------------------------------------------------- API
    def create_agreement(payer_reference:, callback_url:)
      call("/agreement/create", payerReference: safe(payer_reference), callbackURL: callback_url)
    end

    def execute_agreement(agreement_id) = call("/agreement/execute", agreementId: agreement_id)
    def cancel_agreement(agreement_id) = call("/agreement/cancel", agreementId: agreement_id)
    def query_agreement(agreement_id) = call("/query/agreement", agreementId: agreement_id)

    # agreement_id nil → /payment/create (payer_reference required); else /payment-with-agreement/create
    def create_payment(amount:, invoice:, callback_url:, payer_reference: nil, agreement_id: nil, intent: "sale",
                       sub_merchant_name: nil, merchant_association_info: nil)
      body = { callbackURL: callback_url, amount: self.class.amount(amount), currency: "BDT", intent: intent,
               merchantInvoiceNumber: safe(invoice) }
      body[:subMerchantName] = safe(sub_merchant_name, 80) if sub_merchant_name
      body[:merchantAssociationInfo] = safe(merchant_association_info) if merchant_association_info
      if agreement_id
        call("/payment-with-agreement/create", body.merge(agreementId: agreement_id))
      else
        raise ArgumentError, "payer_reference required" unless payer_reference

        call("/payment/create", body.merge(payerReference: safe(payer_reference)))
      end
    end

    def execute_payment(payment_id, agreement_id = nil) = payment_op("execute", payment_id, agreement_id)
    def capture_payment(payment_id, agreement_id = nil) = payment_op("capture", payment_id, agreement_id)
    def void_payment(payment_id, agreement_id = nil) = payment_op("void", payment_id, agreement_id)
    def query_payment(payment_id) = call("/query/payment", paymentId: payment_id)
    def search_transaction(trx_id) = call("/general/search-transaction", trxId: trx_id)

    def refund(payment_id:, trx_id:, amount:, sku:, reason:)
      call("/refund/payment/transaction", paymentId: payment_id, trxId: trx_id,
                                          refundAmount: self.class.amount(amount), sku: safe(sku), reason: safe(reason))
    end

    def refund_status(payment_id:, trx_id:) = call("/refund/payment/status", paymentId: payment_id, trxId: trx_id)

    # Execute once; on timeout / network / 5xx / already-completed → Query Payment.
    def execute_with_recovery(payment_id, agreement_id = nil)
      execute_payment(payment_id, agreement_id)
    rescue TimeoutError
      query_payment(payment_id)
    rescue Error => e
      raise unless e.http_status.zero? || e.http_status >= 500 || DONE_CODES.include?(e.code)

      query_payment(payment_id)
    end

    def self.amount(value)
      d = BigDecimal(value.to_s)
      raise ArgumentError, "Invalid amount: #{value}" if d <= 0 || d.round(2) != d

      format("%.2f", d)
    rescue ArgumentError, TypeError
      raise ArgumentError, "Invalid amount: #{value}"
    end

    private

    def safe(value, max = 255)
      raise ArgumentError, "Invalid text for bKash (no < > &, max #{max})" unless value.to_s.match?(SAFE) && value.to_s.length <= max

      value.to_s
    end

    def payment_op(op, payment_id, agreement_id)
      if agreement_id
        call("/payment-with-agreement/#{op}", paymentId: payment_id, agreementId: agreement_id)
      else
        call("/payment/#{op}", paymentId: payment_id)
      end
    end

    def auth(path, body)
      r = post(path, body, "username" => @username, "password" => @password)
      unless r["statusCode"] == "0000" && r["id_token"]
        raise Error.new(r["statusMessage"] || "Token request failed", code: r["statusCode"], raw: r)
      end

      r
    end

    def call(path, body)
      tok = token
      json = post(path, body, "Authorization" => @bearer_prefix ? "Bearer #{tok}" : tok, "X-App-Key" => @app_key)
      if json["externalCode"] || (json["statusCode"] && json["statusCode"] != "0000")
        raise Error.new(json["errorMessageEn"] || json["statusMessage"] || "bKash error",
                        code: json["externalCode"] || json["statusCode"], raw: json, internal_code: json["internalCode"])
      end
      json["bkashURL"] ||= json["bKashURL"] if json.key?("bKashURL")
      json
    end

    def post(path, body, headers)
      uri = URI(@base_url + path)
      req = Net::HTTP::Post.new(uri, { "Content-Type" => "application/json", "Accept" => "application/json" }.merge(headers))
      req.body = JSON.generate(body)
      resp = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", min_version: :TLS1_2,
                                                 open_timeout: 10, read_timeout: @timeout, write_timeout: @timeout) do |h|
        h.request(req)
      end
      json = resp.body.to_s.empty? ? {} : JSON.parse(resp.body)
      code = resp.code.to_i
      if code >= 400 && !json.key?("externalCode") && !json.key?("statusCode")
        raise Error.new("HTTP #{code}", code: code.to_s, http_status: code, raw: json)
      end

      json
    rescue Net::ReadTimeout, Net::OpenTimeout, Net::WriteTimeout
      raise TimeoutError, "bKash timeout on #{path} — status unknown, use Query APIs"
    rescue JSON::ParserError
      raise Error.new("Non-JSON response", http_status: code || 0)
    rescue SocketError, Errno::ECONNRESET, Errno::ECONNREFUSED, OpenSSL::SSL::SSLError => e
      raise Error.new("Network error: #{e.message}", http_status: 0)
    end
  end
end
