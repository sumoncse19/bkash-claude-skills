// bKash PGW v2 Tokenized Checkout client — .NET 6+ (System.Net.Http + System.Text.Json).
// Docs: https://developer.bka.sh
// ASP.NET Core: services.AddHttpClient<BkashClient>(); services.AddSingleton<IBkashTokenStore, RedisBkashTokenStore>();
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Bkash;

public sealed class BkashOptions
{
    public string BaseUrl { get; set; } = "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout";
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public string AppKey { get; set; } = "";
    public string AppSecret { get; set; } = "";
    public bool BearerPrefix { get; set; }
}

public class BkashException : Exception
{
    public string? Code { get; }
    public string? InternalCode { get; }
    public int HttpStatus { get; }
    public JsonObject? Raw { get; }
    public BkashException(string message, string? code, int httpStatus, JsonObject? raw = null, string? internalCode = null)
        : base(message) { Code = code; HttpStatus = httpStatus; Raw = raw; InternalCode = internalCode; }
}

public class BkashTimeoutException : Exception
{
    public BkashTimeoutException(string path) : base($"bKash timeout on {path} — status unknown, use Query APIs") { }
}

public sealed class BkashTokenState
{
    public string IdToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset RefreshExpiresAt { get; set; }
    public List<DateTimeOffset> AuthCalls { get; set; } = new();
}

/// <summary>Use a distributed implementation (Redis + RedLock, SQL row lock) in production.</summary>
public interface IBkashTokenStore
{
    Task<BkashTokenState?> GetAsync(CancellationToken ct);
    Task SetAsync(BkashTokenState state, CancellationToken ct);
    Task<T> WithLockAsync<T>(Func<Task<T>> fn, CancellationToken ct);
}

public sealed class InMemoryBkashTokenStore : IBkashTokenStore
{
    private readonly SemaphoreSlim _lock = new(1, 1);
    private BkashTokenState? _state;
    public Task<BkashTokenState?> GetAsync(CancellationToken ct) => Task.FromResult(_state);
    public Task SetAsync(BkashTokenState s, CancellationToken ct) { _state = s; return Task.CompletedTask; }
    public async Task<T> WithLockAsync<T>(Func<Task<T>> fn, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try { return await fn(); } finally { _lock.Release(); }
    }
}

public sealed class BkashClient
{
    private static readonly Regex Safe = new("^[^<>&]*$", RegexOptions.Compiled);
    private static readonly HashSet<string> DoneCodes = new() { "2062", "2068", "2117", "2119" };
    private static readonly TimeSpan RefreshBefore = TimeSpan.FromMinutes(8);

    private readonly HttpClient _http;
    private readonly BkashOptions _o;
    private readonly IBkashTokenStore _store;

    public BkashClient(HttpClient http, BkashOptions options, IBkashTokenStore? store = null)
    {
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(30);
        _o = options;
        _o.BaseUrl = _o.BaseUrl.TrimEnd('/');
        _store = store ?? new InMemoryBkashTokenStore();
    }

    // ------------------------------------------------------------ tokens
    public async Task<string> GetTokenAsync(CancellationToken ct = default)
    {
        var s = await _store.GetAsync(ct);
        if (s != null && DateTimeOffset.UtcNow < s.ExpiresAt - RefreshBefore) return s.IdToken;

        return await _store.WithLockAsync(async () =>
        {
            var cur = await _store.GetAsync(ct);
            var now = DateTimeOffset.UtcNow;
            if (cur != null && now < cur.ExpiresAt - RefreshBefore) return cur.IdToken;

            var recent = (cur?.AuthCalls ?? new()).Where(t => now - t < TimeSpan.FromHours(1)).ToList();
            if (recent.Count >= 2)
            {
                if (cur != null && now < cur.ExpiresAt) return cur.IdToken;
                throw new BkashException("Refusing grant/refresh: 2 calls already in the last hour", null, 0);
            }

            JsonObject? res = null;
            if (cur != null && now < cur.RefreshExpiresAt)
            {
                recent.Add(now);
                try
                {
                    res = await AuthAsync("/auth/refresh-token", new JsonObject
                    {
                        ["app_key"] = _o.AppKey, ["app_secret"] = _o.AppSecret, ["refresh_token"] = cur.RefreshToken
                    }, ct);
                }
                catch (BkashException) when (recent.Count < 2) { res = null; }
            }
            if (res == null)
            {
                res = await AuthAsync("/auth/grant-token", new JsonObject { ["app_key"] = _o.AppKey, ["app_secret"] = _o.AppSecret }, ct);
                recent.Add(DateTimeOffset.UtcNow);
            }

            var expiresIn = double.Parse(res["expires_in"]?.ToString() ?? "3600", CultureInfo.InvariantCulture);
            var ns = new BkashTokenState
            {
                IdToken = res["id_token"]!.ToString(),
                RefreshToken = res["refresh_token"]!.ToString(),
                ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn),
                RefreshExpiresAt = DateTimeOffset.UtcNow.AddDays(29),
                AuthCalls = recent,
            };
            await _store.SetAsync(ns, ct);
            return ns.IdToken;
        }, ct);
    }

    private async Task<JsonObject> AuthAsync(string path, JsonObject body, CancellationToken ct)
    {
        var r = await PostAsync(path, body, new() { ["username"] = _o.Username, ["password"] = _o.Password }, ct);
        if (r["statusCode"]?.ToString() != "0000" || r["id_token"] is null)
            throw new BkashException(r["statusMessage"]?.ToString() ?? "Token request failed", r["statusCode"]?.ToString(), 200, r);
        return r;
    }

    // ------------------------------------------------------------ transport
    private async Task<JsonObject> PostAsync(string path, JsonObject body, Dictionary<string, string> headers, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, _o.BaseUrl + path)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.TryAddWithoutValidation("Accept", "application/json");
        foreach (var (k, v) in headers) req.Headers.TryAddWithoutValidation(k, v);

        HttpResponseMessage resp;
        try { resp = await _http.SendAsync(req, ct); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { throw new BkashTimeoutException(path); }
        catch (HttpRequestException e) { throw new BkashException("Network error: " + e.Message, null, 0); }

        using (resp)
        {
            var text = await resp.Content.ReadAsStringAsync(ct);
            JsonObject json;
            try { json = string.IsNullOrWhiteSpace(text) ? new JsonObject() : JsonNode.Parse(text)!.AsObject(); }
            catch (JsonException) { throw new BkashException($"Non-JSON response ({(int)resp.StatusCode})", null, (int)resp.StatusCode); }

            if ((int)resp.StatusCode >= 400 && json["externalCode"] is null && json["statusCode"] is null)
                throw new BkashException($"HTTP {(int)resp.StatusCode}", ((int)resp.StatusCode).ToString(), (int)resp.StatusCode, json);
            return json;
        }
    }

    private async Task<JsonObject> CallAsync(string path, JsonObject body, CancellationToken ct)
    {
        var tok = await GetTokenAsync(ct);
        var json = await PostAsync(path, body, new()
        {
            ["Authorization"] = _o.BearerPrefix ? "Bearer " + tok : tok,
            ["X-App-Key"] = _o.AppKey,
        }, ct);
        var ec = json["externalCode"]?.ToString();
        var sc = json["statusCode"]?.ToString();
        if (ec != null || (sc != null && sc != "0000"))
            throw new BkashException(json["errorMessageEn"]?.ToString() ?? json["statusMessage"]?.ToString() ?? "bKash error",
                ec ?? sc, 200, json, json["internalCode"]?.ToString());
        if (json["bkashURL"] is null && json["bKashURL"] is not null) json["bkashURL"] = json["bKashURL"]!.ToString();
        return json;
    }

    // ------------------------------------------------------------ helpers
    public static string Amount(decimal v)
    {
        if (v <= 0 || decimal.Round(v, 2) != v) throw new ArgumentException($"Invalid amount: {v}");
        return v.ToString("0.00", CultureInfo.InvariantCulture);
    }
    public static string Text(string v, int max = 255)
    {
        if (!Safe.IsMatch(v) || v.Length > max) throw new ArgumentException($"Invalid text for bKash (no < > &, max {max})");
        return v;
    }

    // ------------------------------------------------------------ API
    public Task<JsonObject> CreateAgreementAsync(string payerReference, string callbackUrl, CancellationToken ct = default) =>
        CallAsync("/agreement/create", new JsonObject { ["payerReference"] = Text(payerReference), ["callbackURL"] = callbackUrl }, ct);
    public Task<JsonObject> ExecuteAgreementAsync(string agreementId, CancellationToken ct = default) =>
        CallAsync("/agreement/execute", new JsonObject { ["agreementId"] = agreementId }, ct);
    public Task<JsonObject> CancelAgreementAsync(string agreementId, CancellationToken ct = default) =>
        CallAsync("/agreement/cancel", new JsonObject { ["agreementId"] = agreementId }, ct);
    public Task<JsonObject> QueryAgreementAsync(string agreementId, CancellationToken ct = default) =>
        CallAsync("/query/agreement", new JsonObject { ["agreementId"] = agreementId }, ct);

    /// <summary>agreementId null → /payment/create (payerReference required); else /payment-with-agreement/create.</summary>
    public Task<JsonObject> CreatePaymentAsync(decimal amount, string invoice, string callbackUrl, string? payerReference = null,
        string? agreementId = null, string intent = "sale", string? subMerchantName = null, string? merchantAssociationInfo = null,
        CancellationToken ct = default)
    {
        var body = new JsonObject
        {
            ["callbackURL"] = callbackUrl, ["amount"] = Amount(amount), ["currency"] = "BDT",
            ["intent"] = intent, ["merchantInvoiceNumber"] = Text(invoice),
        };
        if (subMerchantName != null) body["subMerchantName"] = Text(subMerchantName, 80);
        if (merchantAssociationInfo != null) body["merchantAssociationInfo"] = Text(merchantAssociationInfo);
        if (agreementId != null)
        {
            body["agreementId"] = agreementId;
            return CallAsync("/payment-with-agreement/create", body, ct);
        }
        body["payerReference"] = Text(payerReference ?? throw new ArgumentNullException(nameof(payerReference)));
        return CallAsync("/payment/create", body, ct);
    }

    private Task<JsonObject> PaymentOpAsync(string op, string paymentId, string? agreementId, CancellationToken ct) =>
        agreementId == null
            ? CallAsync("/payment/" + op, new JsonObject { ["paymentId"] = paymentId }, ct)
            : CallAsync("/payment-with-agreement/" + op, new JsonObject { ["paymentId"] = paymentId, ["agreementId"] = agreementId }, ct);

    public Task<JsonObject> ExecutePaymentAsync(string paymentId, string? agreementId = null, CancellationToken ct = default) => PaymentOpAsync("execute", paymentId, agreementId, ct);
    public Task<JsonObject> CapturePaymentAsync(string paymentId, string? agreementId = null, CancellationToken ct = default) => PaymentOpAsync("capture", paymentId, agreementId, ct);
    public Task<JsonObject> VoidPaymentAsync(string paymentId, string? agreementId = null, CancellationToken ct = default) => PaymentOpAsync("void", paymentId, agreementId, ct);

    public Task<JsonObject> QueryPaymentAsync(string paymentId, CancellationToken ct = default) =>
        CallAsync("/query/payment", new JsonObject { ["paymentId"] = paymentId }, ct);
    public Task<JsonObject> SearchTransactionAsync(string trxId, CancellationToken ct = default) =>
        CallAsync("/general/search-transaction", new JsonObject { ["trxId"] = trxId }, ct);
    public Task<JsonObject> RefundAsync(string paymentId, string trxId, decimal amount, string sku, string reason, CancellationToken ct = default) =>
        CallAsync("/refund/payment/transaction", new JsonObject
        {
            ["paymentId"] = paymentId, ["trxId"] = trxId, ["refundAmount"] = Amount(amount), ["sku"] = Text(sku), ["reason"] = Text(reason),
        }, ct);
    public Task<JsonObject> RefundStatusAsync(string paymentId, string trxId, CancellationToken ct = default) =>
        CallAsync("/refund/payment/status", new JsonObject { ["paymentId"] = paymentId, ["trxId"] = trxId }, ct);

    /// <summary>Execute once; on timeout / network / 5xx / already-completed → Query Payment.</summary>
    public async Task<JsonObject> ExecuteWithRecoveryAsync(string paymentId, string? agreementId = null, CancellationToken ct = default)
    {
        try { return await ExecutePaymentAsync(paymentId, agreementId, ct); }
        catch (BkashTimeoutException) { }
        catch (BkashException e) when (e.HttpStatus == 0 || e.HttpStatus >= 500 || (e.Code != null && DoneCodes.Contains(e.Code))) { }
        return await QueryPaymentAsync(paymentId, ct);
    }
}
