/**
 * Express wiring for bKash Tokenized Checkout (without + with agreement, refund).
 * Replace `db` with your ORM (Prisma, TypeORM, Sequelize, Knex...).
 */
import express from "express";
import crypto from "node:crypto";
import { BkashError, BkashTimeoutError, bkashFromEnv } from "./bkash";
import { RedisTokenStore } from "./redis-token-store";
import { createClient } from "redis";

// ---- your persistence layer (sketch) ----
declare const db: {
  orders: { get(id: string, userId: string): Promise<{ id: string; total: string; status: string } | null>; markPaid(id: string): Promise<void> };
  payments: {
    insert(p: Record<string, unknown>): Promise<void>;
    byPaymentId(paymentId: string): Promise<Record<string, any> | null>;
    /** UPDATE ... WHERE payment_id=? AND status IN (...) — returns affected rows */
    transition(paymentId: string, from: string[], to: string, patch?: Record<string, unknown>): Promise<number>;
  };
  agreements: { activeFor(userId: string): Promise<{ agreementId: string } | null> };
};

const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch((e) => { console.error("Redis connect failed", e); process.exit(1); });
const bkash = bkashFromEnv(new RedisTokenStore(redis as any));
const CALLBACK = `${process.env.APP_URL}/payments/bkash/callback`;

const app = express();
app.use(express.json());

// 1) Start payment — amount comes from the order, never from the client
app.post("/payments/bkash", async (req: any, res) => {
  const order = await db.orders.get(req.body.orderId, req.user.id);
  if (!order || order.status !== "PENDING") return res.status(404).json({ error: "Order not payable" });

  const invoice = `${order.id}-${crypto.randomBytes(4).toString("hex")}`;
  const agreement = req.body.useSavedWallet ? await db.agreements.activeFor(req.user.id) : null;
  try {
    const r: any = agreement
      ? await bkash.createPaymentWithAgreement({ agreementId: agreement.agreementId, amount: order.total, merchantInvoiceNumber: invoice, callbackURL: CALLBACK })
      : await bkash.createPayment({ amount: order.total, merchantInvoiceNumber: invoice, callbackURL: CALLBACK, payerReference: String(req.user.id) });

    await db.payments.insert({
      orderId: order.id, invoiceNumber: invoice, paymentId: r.paymentId, agreementId: agreement?.agreementId ?? null,
      amount: order.total, status: "INITIATED", createSignature: r.signature, rawCreate: r,
    });
    res.json({ redirectUrl: r.bkashURL }); // frontend does window.location.href = redirectUrl
  } catch (e) {
    if (e instanceof BkashError) return res.status(400).json({ error: e.message, code: e.code });
    throw e;
  }
});

// 2) Callback — browser redirect from bKash
app.get("/payments/bkash/callback", async (req, res) => {
  const { paymentID, status, signature } = req.query as Record<string, string>;
  const p = paymentID ? await db.payments.byPaymentId(paymentID) : null;
  if (!p) return res.status(400).send("Unknown payment");
  const fail = (reason: string) => res.redirect(`/orders/${p.orderId}?payment=${reason}`);

  if (p.status === "COMPLETED") return res.redirect(`/orders/${p.orderId}?payment=success`); // reload-safe
  if (p.createSignature && signature &&
      (signature.length !== p.createSignature.length ||
       !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(p.createSignature)))) {
    return res.status(400).send("Signature mismatch");
  }
  if (status === "cancel") { await db.payments.transition(paymentID, ["INITIATED"], "CANCELLED"); return fail("cancelled"); }
  if (status !== "success") { await db.payments.transition(paymentID, ["INITIATED"], "FAILED"); return fail("failed"); }

  // claim the row so concurrent callbacks don't execute twice
  if ((await db.payments.transition(paymentID, ["INITIATED"], "PENDING_VERIFICATION")) === 0) {
    return res.redirect(`/orders/${p.orderId}?payment=processing`);
  }
  try {
    const { status: s, data } = await bkash.executeWithRecovery(paymentID, p.agreementId ?? undefined);
    if (s === "Completed") {
      if (await db.payments.transition(paymentID, ["PENDING_VERIFICATION"], "COMPLETED", { trxId: data.trxId, rawExecute: data })) {
        await db.orders.markPaid(p.orderId);
      }
      return res.redirect(`/orders/${p.orderId}?payment=success`);
    }
    await db.payments.transition(paymentID, ["PENDING_VERIFICATION"], "FAILED", { rawExecute: data });
    return fail("failed");
  } catch (e) {
    if (e instanceof BkashError) {
      await db.payments.transition(paymentID, ["PENDING_VERIFICATION"], "FAILED", { errorCode: e.code, errorMessage: e.message });
      return fail(encodeURIComponent(e.message));
    }
    if (e instanceof BkashTimeoutError) return res.redirect(`/orders/${p.orderId}?payment=processing`); // recovery job finishes it
    throw e;
  }
});

// 3) Refund (admin only)
app.post("/admin/payments/:paymentId/refund", async (req, res) => {
  const p = await db.payments.byPaymentId(req.params.paymentId);
  if (!p || p.status !== "COMPLETED") return res.status(404).end();
  try {
    const r = await bkash.refund({ paymentId: p.paymentId, trxId: p.trxId, refundAmount: req.body.amount, sku: req.body.sku ?? "ORDER", reason: req.body.reason });
    res.json(r);
  } catch (e) {
    if (e instanceof BkashTimeoutError) return res.status(202).json({ status: "unknown — check refund status" });
    if (e instanceof BkashError) return res.status(400).json({ error: e.message, code: e.code });
    throw e;
  }
});

app.listen(3000);
