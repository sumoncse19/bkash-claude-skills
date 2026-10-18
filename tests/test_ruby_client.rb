# frozen_string_literal: true

require "json"
require "net/http"
require_relative "../plugins/bkash-payment-gateway/skills/bkash-payment-gateway/templates/ruby/bkash_client"

def check(cond, msg) = (cond || abort("FAIL: #{msg}"))

base = ENV.fetch("MOCK_URL", "http://127.0.0.1:8765")
c = Bkash::Client.new(base_url: "#{base}/v2/tokenized-checkout", username: "user", password: "pass",
                      app_key: "test_app_key", app_secret: "secret")

r = c.create_payment(amount: "100", invoice: "INV-1", callback_url: "https://shop.test/cb", payer_reference: "CUST1")
check(r["bkashURL"].start_with?("https://"), "bkashURL")
e = c.execute_with_recovery(r["paymentId"])
check(e["transactionStatus"] == "Completed", "execute")
check(c.execute_with_recovery(r["paymentId"])["transactionStatus"] == "Completed", "2062 recovery")
r2 = c.create_payment(amount: "503.00", invoice: "INV-2", callback_url: "https://shop.test/cb", payer_reference: "C")
check(c.execute_with_recovery(r2["paymentId"])["transactionStatus"] == "Completed", "503 recovery")
begin
  c.create_payment(amount: "999.99", invoice: "INV-3", callback_url: "https://shop.test/cb", payer_reference: "C")
  check(false, "expected error")
rescue Bkash::Error => ex
  check(ex.code == "2006" && ex.message == "Invalid amount.", "error mapping")
end
%w[0 -1 abc 1.234].each do |bad|
  Bkash::Client.amount(bad)
  check(false, "amount #{bad}")
rescue ArgumentError
  nil
end
check(Bkash::Client.amount(12.5) == "12.50", "amount format")
check(c.refund(payment_id: r["paymentId"], trx_id: e["trxId"], amount: 10, sku: "SKU", reason: "t")["refundTransactionStatus"] == "Completed", "refund")
stats = JSON.parse(Net::HTTP.get(URI("#{base}/stats")))
check(stats["grant"] == 1, "single grant #{stats}")
puts "ruby client OK #{stats}"
