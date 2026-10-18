package com.example.bkash;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.Callable;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/**
 * bKash PGW v2 Tokenized Checkout client — Java 17+, java.net.http + Jackson.
 * Docs: https://developer.bka.sh
 * In Spring Boot, expose it as a @Bean and back TokenStore with Redis (Redisson lock) or a DB row lock.
 */
public class BkashClient {

    public static final String SANDBOX_URL = "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout";
    public static final String PRODUCTION_URL = "https://tokenized.pay.bka.sh/v2/tokenized-checkout";
    private static final Pattern SAFE = Pattern.compile("^[^<>&]*$");
    private static final Set<String> DONE_CODES = Set.of("2062", "2068", "2117", "2119");
    private static final long REFRESH_BEFORE_SEC = 480;

    // ------------------------------------------------------------------ errors
    public static class BkashException extends RuntimeException {
        public final String code; public final String internalCode; public final int httpStatus; public final Map<String, Object> raw;
        public BkashException(String msg, String code, String internalCode, int httpStatus, Map<String, Object> raw) {
            super(msg); this.code = code; this.internalCode = internalCode; this.httpStatus = httpStatus; this.raw = raw;
        }
    }
    public static class BkashTimeoutException extends RuntimeException {
        public BkashTimeoutException(String path) { super("bKash timeout on " + path + " — status unknown, use Query APIs"); }
    }

    // ------------------------------------------------------------------ token store
    public static class TokenState {
        public String idToken, refreshToken;
        public long expiresAt, refreshExpiresAt; // epoch seconds
        public List<Long> authCalls = new ArrayList<>();
    }
    public interface TokenStore {
        TokenState get();
        void set(TokenState s);
        <T> T withLock(Callable<T> fn) throws Exception;
    }
    public static class InMemoryTokenStore implements TokenStore {
        private final ReentrantLock lock = new ReentrantLock();
        private volatile TokenState state;
        public TokenState get() { return state; }
        public void set(TokenState s) { state = s; }
        public <T> T withLock(Callable<T> fn) throws Exception { lock.lock(); try { return fn.call(); } finally { lock.unlock(); } }
    }

    private final String baseUrl, username, password, appKey, appSecret;
    private final boolean bearerPrefix;
    private final TokenStore store;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ObjectMapper om = new ObjectMapper();

    public BkashClient(String baseUrl, String username, String password, String appKey, String appSecret,
                       TokenStore store, boolean bearerPrefix) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.username = username; this.password = password; this.appKey = appKey; this.appSecret = appSecret;
        this.store = store != null ? store : new InMemoryTokenStore();
        this.bearerPrefix = bearerPrefix;
    }

    public static BkashClient fromEnv(TokenStore store) {
        String base = Optional.ofNullable(System.getenv("BKASH_BASE_URL")).orElse(SANDBOX_URL);
        return new BkashClient(base, req("BKASH_USERNAME"), req("BKASH_PASSWORD"), req("BKASH_APP_KEY"),
                req("BKASH_APP_SECRET"), store, "true".equals(System.getenv("BKASH_BEARER_PREFIX")));
    }
    private static String req(String k) {
        String v = System.getenv(k);
        if (v == null || v.isEmpty()) throw new IllegalStateException("Missing env " + k);
        return v;
    }

    // ------------------------------------------------------------------ tokens
    public String token() {
        TokenState s = store.get();
        long now0 = Instant.now().getEpochSecond();
        if (s != null && now0 < s.expiresAt - REFRESH_BEFORE_SEC) return s.idToken;
        try {
            return store.withLock(() -> {
                TokenState cur = store.get();
                long now = Instant.now().getEpochSecond();
                if (cur != null && now < cur.expiresAt - REFRESH_BEFORE_SEC) return cur.idToken;
                List<Long> recent = new ArrayList<>();
                if (cur != null) for (Long t : cur.authCalls) if (now - t < 3600) recent.add(t);
                if (recent.size() >= 2) {
                    if (cur != null && now < cur.expiresAt) return cur.idToken;
                    throw new BkashException("Refusing grant/refresh: 2 calls already in the last hour", null, null, 0, Map.of());
                }
                Map<String, Object> res = null;
                if (cur != null && now < cur.refreshExpiresAt) {
                    recent.add(now);
                    try {
                        res = auth("/auth/refresh-token", Map.of("app_key", appKey, "app_secret", appSecret, "refresh_token", cur.refreshToken));
                    } catch (BkashException e) {
                        if (recent.size() >= 2) throw e;
                    }
                }
                if (res == null) {
                    res = auth("/auth/grant-token", Map.of("app_key", appKey, "app_secret", appSecret));
                    recent.add(Instant.now().getEpochSecond());
                }
                TokenState ns = new TokenState();
                ns.idToken = String.valueOf(res.get("id_token"));
                ns.refreshToken = String.valueOf(res.get("refresh_token"));
                long exp = Long.parseLong(String.valueOf(res.getOrDefault("expires_in", 3600)));
                ns.expiresAt = Instant.now().getEpochSecond() + exp;
                ns.refreshExpiresAt = Instant.now().getEpochSecond() + 29L * 86400;
                ns.authCalls = recent;
                store.set(ns);
                return ns.idToken;
            });
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private Map<String, Object> auth(String path, Map<String, Object> body) {
        Map<String, Object> r = post(path, body, Map.of("username", username, "password", password));
        if (!"0000".equals(String.valueOf(r.get("statusCode"))) || r.get("id_token") == null) {
            throw new BkashException(String.valueOf(r.getOrDefault("statusMessage", "Token request failed")),
                    String.valueOf(r.get("statusCode")), null, 200, r);
        }
        return r;
    }

    // ------------------------------------------------------------------ transport
    private Map<String, Object> post(String path, Map<String, Object> body, Map<String, String> headers) {
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path))
                    .timeout(Duration.ofSeconds(30))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(om.writeValueAsString(body)));
            headers.forEach(b::header);
            HttpResponse<String> resp = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
            Map<String, Object> json;
            try {
                json = resp.body() == null || resp.body().isEmpty() ? new HashMap<>()
                        : om.readValue(resp.body(), new TypeReference<Map<String, Object>>() {});
            } catch (IOException e) {
                throw new BkashException("Non-JSON response (" + resp.statusCode() + ")", null, null, resp.statusCode(), Map.of());
            }
            if (resp.statusCode() >= 400 && !json.containsKey("externalCode") && !json.containsKey("statusCode")) {
                throw new BkashException("HTTP " + resp.statusCode(), String.valueOf(resp.statusCode()), null, resp.statusCode(), json);
            }
            return json;
        } catch (HttpTimeoutException e) {
            throw new BkashTimeoutException(path);
        } catch (IOException e) {
            throw new BkashException("Network error: " + e.getMessage(), null, null, 0, Map.of());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BkashException("Interrupted", null, null, 0, Map.of());
        }
    }

    private Map<String, Object> call(String path, Map<String, Object> body) {
        String tok = token();
        Map<String, Object> json = post(path, body, Map.of("Authorization", bearerPrefix ? "Bearer " + tok : tok, "X-App-Key", appKey));
        Object ec = json.get("externalCode");
        Object sc = json.get("statusCode");
        if (ec != null || (sc != null && !"0000".equals(String.valueOf(sc)))) {
            Object msg = json.getOrDefault("errorMessageEn", json.getOrDefault("statusMessage", "bKash error"));
            throw new BkashException(String.valueOf(msg), String.valueOf(ec != null ? ec : sc),
                    (String) json.get("internalCode"), 200, json);
        }
        if (!json.containsKey("bkashURL") && json.containsKey("bKashURL")) json.put("bkashURL", json.get("bKashURL"));
        return json;
    }

    // ------------------------------------------------------------------ helpers
    public static String amount(BigDecimal v) {
        if (v == null || v.signum() <= 0 || v.scale() > 2 && v.stripTrailingZeros().scale() > 2)
            throw new IllegalArgumentException("Invalid amount: " + v);
        return v.setScale(2, RoundingMode.UNNECESSARY).toPlainString();
    }
    public static String safe(String v, int max) {
        if (v == null || !SAFE.matcher(v).matches() || v.length() > max)
            throw new IllegalArgumentException("Invalid text for bKash (no < > &, max " + max + ")");
        return v;
    }
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) if (kv[i + 1] != null) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    // ------------------------------------------------------------------ API
    public Map<String, Object> createAgreement(String payerReference, String callbackURL) {
        return call("/agreement/create", map("payerReference", safe(payerReference, 255), "callbackURL", callbackURL));
    }
    public Map<String, Object> executeAgreement(String agreementId) { return call("/agreement/execute", map("agreementId", agreementId)); }
    public Map<String, Object> cancelAgreement(String agreementId) { return call("/agreement/cancel", map("agreementId", agreementId)); }
    public Map<String, Object> queryAgreement(String agreementId) { return call("/query/agreement", map("agreementId", agreementId)); }

    /** agreementId null → /payment/create (payerReference required); otherwise /payment-with-agreement/create. */
    public Map<String, Object> createPayment(BigDecimal amount, String invoice, String callbackURL, String payerReference,
                                             String agreementId, String intent, String subMerchantName, String merchantAssociationInfo) {
        Map<String, Object> body = map(
                "callbackURL", callbackURL, "amount", amount(amount), "currency", "BDT",
                "intent", intent == null ? "sale" : intent, "merchantInvoiceNumber", safe(invoice, 255),
                "subMerchantName", subMerchantName == null ? null : safe(subMerchantName, 80),
                "merchantAssociationInfo", merchantAssociationInfo == null ? null : safe(merchantAssociationInfo, 255));
        if (agreementId != null) {
            body.put("agreementId", agreementId);
            return call("/payment-with-agreement/create", body);
        }
        body.put("payerReference", safe(payerReference, 255));
        return call("/payment/create", body);
    }
    private Map<String, Object> paymentOp(String op, String paymentId, String agreementId) {
        return agreementId == null
                ? call("/payment/" + op, map("paymentId", paymentId))
                : call("/payment-with-agreement/" + op, map("paymentId", paymentId, "agreementId", agreementId));
    }
    public Map<String, Object> executePayment(String paymentId, String agreementId) { return paymentOp("execute", paymentId, agreementId); }
    public Map<String, Object> capturePayment(String paymentId, String agreementId) { return paymentOp("capture", paymentId, agreementId); }
    public Map<String, Object> voidPayment(String paymentId, String agreementId) { return paymentOp("void", paymentId, agreementId); }

    public Map<String, Object> queryPayment(String paymentId) { return call("/query/payment", map("paymentId", paymentId)); }
    public Map<String, Object> searchTransaction(String trxId) { return call("/general/search-transaction", map("trxId", trxId)); }
    public Map<String, Object> refund(String paymentId, String trxId, BigDecimal amount, String sku, String reason) {
        return call("/refund/payment/transaction", map("paymentId", paymentId, "trxId", trxId,
                "refundAmount", amount(amount), "sku", safe(sku, 255), "reason", safe(reason, 255)));
    }
    public Map<String, Object> refundStatus(String paymentId, String trxId) {
        return call("/refund/payment/status", map("paymentId", paymentId, "trxId", trxId));
    }

    /** Execute once; on timeout / network / 5xx / already-completed → Query Payment. Returns the bKash response with transactionStatus. */
    public Map<String, Object> executeWithRecovery(String paymentId, String agreementId) {
        try {
            return executePayment(paymentId, agreementId);
        } catch (BkashTimeoutException e) {
            return queryPayment(paymentId);
        } catch (BkashException e) {
            boolean unknown = e.httpStatus == 0 || e.httpStatus >= 500 || DONE_CODES.contains(e.code);
            if (!unknown) throw e;
            return queryPayment(paymentId);
        }
    }
}
