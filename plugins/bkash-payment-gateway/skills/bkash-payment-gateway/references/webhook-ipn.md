# Webhook / Instant Payment Notification (IPN)

bKash pushes **successfully completed** payment events to your listener using **Amazon SNS** HTTP(S) delivery. Covers payments via PGW, bKash App, USSD (*247#), QR / Bangla QR, M2M. Share your listener URL with bKash technical support during onboarding; they provision it.

## What your endpoint receives

- `POST`, `Content-Type: text/plain; charset=UTF-8` (JSON body as text — read the **raw** body, don't rely on a JSON body parser).
- Header `x-amz-sns-message-type`: `SubscriptionConfirmation` | `Notification` | `UnsubscribeConfirmation`.
- Body fields: `Type`, `MessageId`, `TopicArn`, `Message`, `Timestamp`, `SignatureVersion`, `Signature`, `SigningCertURL`, plus `Token` + `SubscribeURL` (confirmation) or `UnsubscribeURL` (notification).
- `Message` is a JSON **string** in real SNS deliveries (the docs show it as an object) — parse it if it is a string.

## Handling algorithm

1. Read raw body → `JSON.parse`.
2. **Verify the signature** (below). Reject with 403 if invalid.
3. If `Type == "SubscriptionConfirmation"`: check `TopicArn` is the one bKash gave you (or matches `arn:aws:sns:*:*:bpt_<your-wallet>`), then `GET SubscribeURL` (must be `https://sns.<region>.amazonaws.com/...`). Return 200.
4. If `Type == "Notification"`: parse `Message`, then
   - dedupe by `trxID` (unique index on an `bkash_ipn_events` table),
   - store the raw event,
   - match to your order by `merchantInvoiceNumber` (PGW payments) or `transactionReference`; for QR/USSD/App payments there may be no invoice — reconcile by amount/wallet/time or treat as standalone income,
   - optionally confirm with Search Transaction (`trxId`) before fulfilling,
   - mark the order paid using the same atomic update as the callback flow (IPN and callback may both arrive).
5. Return **200 quickly** (do heavy work async). SNS retries on non-2xx.

## Message fields

| Field | Example | Notes |
|---|---|---|
| `dateTime` | `20180419122246` | `yyyyMMddHHmmss` (Asia/Dhaka) |
| `debitMSISDN` | `8801700000001` | payer wallet |
| `creditOrganizationName` | `Org 01` | |
| `creditShortCode` | `01929918***` | your merchant wallet |
| `trxID` | `4J420ANOXC` | unique — dedupe key |
| `transactionStatus` | `Completed` | only successful txns are sent |
| `transactionType` | `10002294` | see table |
| `amount` | `100` | amount paid by customer |
| `currency` | `BDT` | |
| `transactionReference` | `Test_Payment` | Checkout iFrame / App payments; M2M has `PGW_CPS_<paymentId>` |
| `merchantInvoiceNumber` | `orderId1233` | PGW payments |
| `payerType` | `Merchant` | M2M |
| `serviceFee` | `0.0` | |
| `couponAmount`, `merchantShareAmount`, `saleAmount` | `10`, `5`, `100.00` | coupon payments: `amount = saleAmount − couponAmount` |

## transactionType codes

| Type | Code |
|---|---|
| Payment via API | 10002294 |
| Payment via QR | 10003126 |
| Payment via USSD | 10002175 |
| Redeem Voucher | 10002809 |
| M2M Transfer via API | 10002264 |
| M2M Transfer via QR | 10003209 |
| M2M Transfer via USSD | 10002177 |
| Payment via Bank | 10003476 |
| B2B Collection Wallet to Merchant Plus (BC2M) | 10003237 |
| Distributor to B2B Collection Wallet via USSD (D2BC) | 10003236 |
| DSO to Merchant Plus-B2BC via API | 10004036 |

(Docs samples also show `1003`, `10003936` (Bangla QR) and `10004246` (M2M via PGW) — store unknown codes rather than rejecting them.)

## SNS signature verification (SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA)

1. `SigningCertURL` must be `https`, host matching `^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$`, path ending `.pem`. Never fetch any other URL (SSRF). Cache certs by URL.
2. Build the string to sign — each `key\nvalue\n` in this exact order, skipping absent keys:
   - Notification: `Message, MessageId, Subject (if present), Timestamp, TopicArn, Type`
   - SubscriptionConfirmation / UnsubscribeConfirmation: `Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type`
   - Use `Message` exactly as received (the raw string).
3. Verify base64-decoded `Signature` with the cert's public key.
4. Optionally reject `Timestamp` older than ~1 hour (replay).

Ready-made libraries: Node `sns-validator` / `@aws-sdk`-free `sns-payload-validator`; PHP `aws/aws-php-sns-message-validator`; Python `sns-message-validator` or manual `cryptography`; Java `software.amazon.awssdk:sns` `SnsMessageManager`; .NET `Amazon.SimpleNotificationService.Util.Message.ParseMessage(...).IsMessageSignatureValid()`; Go `github.com/robbiet480/go.sns`; Ruby `aws-sdk-sns` `Aws::SNS::MessageVerifier`.

### Node.js (Express) example

```ts
import express from "express";
import crypto from "node:crypto";

// Your job queue (BullMQ, etc.). jobId = trxID gives free de-duplication.
declare const queue: { add(name: string, data: unknown, opts: { jobId: string }): Promise<unknown> };

const certCache = new Map<string, string>();
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

async function verifySns(m: Record<string, string>): Promise<boolean> {
  const u = new URL(m.SigningCertURL);
  if (u.protocol !== "https:" || !SNS_HOST.test(u.hostname) || !u.pathname.endsWith(".pem")) return false;
  let pem = certCache.get(u.href);
  if (!pem) { pem = await (await fetch(u.href)).text(); certCache.set(u.href, pem); }
  const keys = m.Type === "Notification"
    ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const str = keys.filter(k => m[k] !== undefined).map(k => `${k}\n${m[k]}\n`).join("");
  const algo = m.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  return crypto.createVerify(algo).update(str, "utf8").verify(pem, m.Signature, "base64");
}

const app = express();
app.post("/webhooks/bkash", express.text({ type: "*/*" }), async (req, res) => {
  let m: any;
  try { m = JSON.parse(req.body); } catch { return res.sendStatus(400); }
  if (typeof m.Message !== "string") m.Message = JSON.stringify(m.Message); // docs-style sample
  if (!(await verifySns(m))) return res.sendStatus(403);
  if (m.Type === "SubscriptionConfirmation") {
    const s = new URL(m.SubscribeURL);
    if (SNS_HOST.test(s.hostname)) await fetch(s.href);
    return res.sendStatus(200);
  }
  if (m.Type === "Notification") {
    const evt = JSON.parse(m.Message);
    await queue.add("bkash-ipn", evt, { jobId: evt.trxID }); // dedupe by trxID
  }
  res.sendStatus(200);
});
```

Note: re-stringifying an object `Message` will not match the original signature; real SNS deliveries send a string, so the docs-style object form is only useful for local tests (skip verification behind a test flag).
