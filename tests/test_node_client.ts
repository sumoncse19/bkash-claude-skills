// Run: node --experimental-transform-types tests/test_node_client.ts  (Node 22.7+)
import assert from "node:assert/strict";
import { BkashClient, BkashError } from "../plugins/bkash-payment-gateway/skills/bkash-payment-gateway/templates/node/bkash.ts";

const BASE = process.env.MOCK_URL ?? "http://127.0.0.1:8765";
const c = new BkashClient({ baseUrl: BASE + "/v2/tokenized-checkout", username: "user", password: "pass", appKey: "test_app_key", appSecret: "secret" });

const r: any = await c.createPayment({ amount: "100", merchantInvoiceNumber: "INV-1", callbackURL: "https://shop.test/cb", payerReference: "CUST1" });
assert.ok(r.bkashURL.startsWith("https://"));
assert.equal(r.signature, "sig" + r.paymentId);
const e = await c.executeWithRecovery(r.paymentId);
assert.equal(e.status, "Completed");
assert.equal((await c.executeWithRecovery(r.paymentId)).status, "Completed"); // 2062 -> query

const r2: any = await c.createPayment({ amount: "503.00", merchantInvoiceNumber: "INV-2", callbackURL: "https://shop.test/cb", payerReference: "C" });
assert.equal((await c.executeWithRecovery(r2.paymentId)).status, "Completed"); // 503 -> query

await assert.rejects(
  c.createPayment({ amount: "999.99", merchantInvoiceNumber: "INV-3", callbackURL: "https://shop.test/cb", payerReference: "C" }),
  (err: any) => err instanceof BkashError && err.code === "2006" && err.message === "Invalid amount.",
);
for (const bad of ["0", "-1", "abc", "1.234"]) assert.throws(() => BkashClient.amount(bad));
assert.equal(BkashClient.amount(12.5), "12.50");
assert.throws(() => BkashClient.safeText("a&b"));

// concurrent calls must share one grant
await Promise.all(Array.from({ length: 10 }, () => c.queryPayment(r.paymentId)));
const refund: any = await c.refund({ paymentId: r.paymentId, trxId: e.data.trxId, refundAmount: 10, sku: "SKU", reason: "test" });
assert.equal(refund.refundTransactionStatus, "Completed");
assert.equal(((await c.capturePaymentWithAgreement("P", "A")) as any).transactionStatus, "Completed");

const stats = await (await fetch(BASE + "/stats")).json();
assert.equal(stats.grant, 1);

// refresh window + rate-limit guard
const store = (c as any).store;
const s = await store.get();
await store.set({ ...s, expiresAt: Date.now() + 60_000, authCalls: [Date.now() - 4_000_000] });
await c.getToken();
assert.deepEqual(await (await fetch(BASE + "/stats")).json(), { grant: 1, refresh: 1 });
await store.set({ ...(await store.get()), expiresAt: Date.now() - 1, authCalls: [Date.now() - 100, Date.now() - 50] });
await assert.rejects(c.getToken(), /2 calls already/);
console.log("node client OK", stats);
