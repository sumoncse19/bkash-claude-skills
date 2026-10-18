/**
 * bKash PGW v2 Tokenized Checkout client (Node.js >= 18, TypeScript, zero dependencies).
 * Docs: https://developer.bka.sh
 *
 * - Token is cached in a pluggable TokenStore (use Redis/DB in production so every
 *   process/server shares ONE token — bKash allows max 2 grant/refresh calls per hour).
 * - Refreshes between minute 50 and 55 of the token lifetime.
 * - 30 s timeout on every call; timeouts raise BkashTimeoutError (= status unknown, Query next).
 */

export interface BkashConfig {
  baseUrl: string; // https://tokenized.sandbox.bka.sh/v2/tokenized-checkout
  username: string;
  password: string;
  appKey: string;
  appSecret: string;
  /** Prefix Authorization header with "Bearer ". Official samples send the raw token. */
  bearerPrefix?: boolean;
  timeoutMs?: number;
  tokenStore?: TokenStore;
}

export interface TokenState {
  idToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  refreshTokenExpiresAt: number; // epoch ms (30 days)
  authCalls: number[]; // epoch ms of grant/refresh calls (rate-limit guard)
}

export interface TokenStore {
  get(): Promise<TokenState | null>;
  set(state: TokenState): Promise<void>;
  /** Run fn while holding a cross-process lock (Redis SET NX PX, DB row lock, ...). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Single-process store. Fine for dev; use a shared store in production. */
export class InMemoryTokenStore implements TokenStore {
  private state: TokenState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  async get() { return this.state; }
  async set(s: TokenState) { this.state = s; }
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export class BkashError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined, // externalCode or statusCode
    public readonly httpStatus: number,
    public readonly raw: unknown,
    public readonly internalCode?: string,
  ) {
    super(message);
    this.name = "BkashError";
  }
}

export class BkashTimeoutError extends Error {
  constructor(public readonly path: string) {
    super(`bKash request timed out: ${path} — status unknown, use Query APIs`);
    this.name = "BkashTimeoutError";
  }
}

export class BkashRateLimitGuardError extends Error {
  constructor() {
    super("Refusing to call grant/refresh: 2 calls already made in the last hour (bKash would block the app for 1h)");
    this.name = "BkashRateLimitGuardError";
  }
}

export type Intent = "sale" | "authorization";
type Json = Record<string, any>;

const HOUR = 3_600_000;
const REFRESH_BEFORE_EXPIRY_MS = 8 * 60_000; // refresh at ~minute 52 of 60
const SAFE_TEXT = /^[^<>&]*$/;

export class BkashClient {
  private readonly store: TokenStore;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: BkashConfig) {
    this.store = cfg.tokenStore ?? new InMemoryTokenStore();
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  }

  // ---------------------------------------------------------------- tokens
  async getToken(): Promise<string> {
    const cached = await this.store.get();
    if (cached && Date.now() < cached.expiresAt - REFRESH_BEFORE_EXPIRY_MS) return cached.idToken;

    return this.store.withLock(async () => {
      const s = await this.store.get(); // re-read: another process may have refreshed
      const now = Date.now();
      if (s && now < s.expiresAt - REFRESH_BEFORE_EXPIRY_MS) return s.idToken;

      const recent = (s?.authCalls ?? []).filter((t) => now - t < HOUR);
      if (recent.length >= 2) {
        if (s && now < s.expiresAt) return s.idToken; // still valid, try again later
        throw new BkashRateLimitGuardError();
      }

      let res: Json | null = null;
      if (s && now < s.refreshTokenExpiresAt) {
        try {
          res = await this.authCall("/auth/refresh-token", {
            app_key: this.cfg.appKey, app_secret: this.cfg.appSecret, refresh_token: s.refreshToken,
          });
        } catch (e) {
          recent.push(now);
          if (recent.length >= 2) throw e; // don't burn the last allowed call
          res = null;
        }
        if (res) recent.push(now);
      }
      if (!res) {
        res = await this.authCall("/auth/grant-token", { app_key: this.cfg.appKey, app_secret: this.cfg.appSecret });
        recent.push(Date.now());
      }

      const state: TokenState = {
        idToken: res.id_token,
        refreshToken: res.refresh_token,
        expiresAt: Date.now() + Number(res.expires_in ?? 3600) * 1000,
        refreshTokenExpiresAt: Date.now() + 29 * 24 * HOUR,
        authCalls: recent,
      };
      await this.store.set(state);
      return state.idToken;
    });
  }

  private async authCall(path: string, body: Json): Promise<Json> {
    const res = await this.http(path, body, {
      username: this.cfg.username,
      password: this.cfg.password,
    });
    if (res.statusCode !== "0000" || !res.id_token) {
      throw new BkashError(res.statusMessage ?? "Token request failed", res.statusCode, 200, res);
    }
    return res;
  }

  // ---------------------------------------------------------------- transport
  private async http(path: string, body: Json, headers: Record<string, string>): Promise<Json> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(this.cfg.baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") throw new BkashTimeoutError(path);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    let json: Json;
    try { json = text ? JSON.parse(text) : {}; } catch {
      throw new BkashError(`Non-JSON response (${resp.status})`, undefined, resp.status, text);
    }
    if (!resp.ok && !json.externalCode && !json.statusCode) {
      throw new BkashError(json.message ?? `HTTP ${resp.status}`, String(resp.status), resp.status, json);
    }
    return json;
  }

  private async call<T = Json>(path: string, body: Json): Promise<T> {
    const token = await this.getToken();
    const json = await this.http(path, body, {
      Authorization: this.cfg.bearerPrefix ? `Bearer ${token}` : token,
      "X-App-Key": this.cfg.appKey,
    });
    if (json.externalCode || (json.statusCode && json.statusCode !== "0000")) {
      throw new BkashError(
        json.errorMessageEn ?? json.statusMessage ?? "bKash error",
        json.externalCode ?? json.statusCode,
        200,
        json,
        json.internalCode,
      );
    }
    // Normalise bkashURL / bKashURL spelling
    if (json.bKashURL && !json.bkashURL) json.bkashURL = json.bKashURL;
    return json as T;
  }

  // ---------------------------------------------------------------- helpers
  static amount(v: number | string): string {
    const s = typeof v === "number" ? v.toFixed(2) : v.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw new Error(`Invalid bKash amount: ${v}`);
    return s;
  }
  static safeText(v: string, max = 255): string {
    if (!SAFE_TEXT.test(v) || v.length > max) throw new Error(`Invalid text for bKash (no < > &, max ${max}): ${v}`);
    return v;
  }

  // ---------------------------------------------------------------- agreement
  createAgreement(p: { payerReference: string; callbackURL: string }) {
    return this.call("/agreement/create", { payerReference: BkashClient.safeText(p.payerReference), callbackURL: p.callbackURL });
  }
  executeAgreement(agreementId: string) { return this.call("/agreement/execute", { agreementId }); }
  cancelAgreement(agreementId: string) { return this.call("/agreement/cancel", { agreementId }); }
  queryAgreement(agreementId: string) { return this.call("/query/agreement", { agreementId }); }

  // ---------------------------------------------------------------- payments
  createPayment(p: {
    amount: number | string; merchantInvoiceNumber: string; callbackURL: string;
    payerReference: string; intent?: Intent; subMerchantName?: string; merchantAssociationInfo?: string;
  }) {
    return this.call("/payment/create", {
      payerReference: BkashClient.safeText(p.payerReference),
      callbackURL: p.callbackURL,
      amount: BkashClient.amount(p.amount),
      currency: "BDT",
      intent: p.intent ?? "sale",
      merchantInvoiceNumber: BkashClient.safeText(p.merchantInvoiceNumber),
      ...(p.subMerchantName ? { subMerchantName: BkashClient.safeText(p.subMerchantName, 80) } : {}),
      ...(p.merchantAssociationInfo ? { merchantAssociationInfo: BkashClient.safeText(p.merchantAssociationInfo) } : {}),
    });
  }
  executePayment(paymentId: string) { return this.call("/payment/execute", { paymentId }); }
  capturePayment(paymentId: string) { return this.call("/payment/capture", { paymentId }); }
  voidPayment(paymentId: string) { return this.call("/payment/void", { paymentId }); }

  createPaymentWithAgreement(p: {
    agreementId: string; amount: number | string; merchantInvoiceNumber: string; callbackURL: string;
    intent?: Intent; subMerchantName?: string; merchantAssociationInfo?: string;
  }) {
    return this.call("/payment-with-agreement/create", {
      agreementId: p.agreementId,
      callbackURL: p.callbackURL,
      amount: BkashClient.amount(p.amount),
      currency: "BDT",
      intent: p.intent ?? "sale",
      merchantInvoiceNumber: BkashClient.safeText(p.merchantInvoiceNumber),
      ...(p.subMerchantName ? { subMerchantName: BkashClient.safeText(p.subMerchantName, 80) } : {}),
      ...(p.merchantAssociationInfo ? { merchantAssociationInfo: BkashClient.safeText(p.merchantAssociationInfo) } : {}),
    });
  }
  executePaymentWithAgreement(paymentId: string, agreementId: string) {
    return this.call("/payment-with-agreement/execute", { paymentId, agreementId });
  }
  capturePaymentWithAgreement(paymentId: string, agreementId: string) {
    return this.call("/payment-with-agreement/capture", { paymentId, agreementId });
  }
  voidPaymentWithAgreement(paymentId: string, agreementId: string) {
    return this.call("/payment-with-agreement/void", { paymentId, agreementId });
  }

  // ---------------------------------------------------------------- query / search
  queryPayment(paymentId: string) { return this.call("/query/payment", { paymentId }); }
  searchTransaction(trxId: string) { return this.call("/general/search-transaction", { trxId }); }

  // ---------------------------------------------------------------- refunds
  refund(p: { paymentId: string; trxId: string; refundAmount: number | string; sku: string; reason: string }) {
    return this.call("/refund/payment/transaction", {
      paymentId: p.paymentId,
      trxId: p.trxId,
      refundAmount: BkashClient.amount(p.refundAmount),
      sku: BkashClient.safeText(p.sku),
      reason: BkashClient.safeText(p.reason),
    });
  }
  refundStatus(paymentId: string, trxId: string) {
    return this.call("/refund/payment/status", { paymentId, trxId });
  }

  /**
   * Execute with the documented recovery rule: on timeout/ambiguous failure, Query Payment.
   * Returns the final bKash status ("Completed" | "Authorized" | "Initiated" | ...).
   */
  async executeWithRecovery(paymentId: string, agreementId?: string): Promise<{ status: string; data: Json }> {
    try {
      const data = agreementId
        ? await this.executePaymentWithAgreement(paymentId, agreementId)
        : await this.executePayment(paymentId);
      return { status: data.transactionStatus, data };
    } catch (e) {
      const alreadyDone = e instanceof BkashError && ["2062", "2068", "2117", "2119"].includes(e.code ?? "");
      const unknown =
        e instanceof BkashTimeoutError ||
        (e instanceof BkashError && e.httpStatus >= 500) ||
        (e instanceof TypeError); // fetch network failure (connection reset, DNS...)
      if (!alreadyDone && !unknown) throw e;
      const q = await this.queryPayment(paymentId);
      return { status: q.transactionStatus, data: q };
    }
  }
}

/** Build a client from process.env. */
export function bkashFromEnv(store?: TokenStore): BkashClient {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  return new BkashClient({
    baseUrl: process.env.BKASH_BASE_URL ?? "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout",
    username: need("BKASH_USERNAME"),
    password: need("BKASH_PASSWORD"),
    appKey: need("BKASH_APP_KEY"),
    appSecret: need("BKASH_APP_SECRET"),
    bearerPrefix: process.env.BKASH_BEARER_PREFIX === "true",
    tokenStore: store,
  });
}
