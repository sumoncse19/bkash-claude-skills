# bKash PGW v2 — API reference (Tokenized Checkout)

Source: https://developer.bka.sh (v2 docs, updated 2026-09/10). Every endpoint is `POST`, JSON in/out, 30 s timeout.

## Base URLs

| Env | Base URL |
|---|---|
| Sandbox | `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout` |
| Production | `https://tokenized.pay.bka.sh/v2/tokenized-checkout` (docs pattern `https://<service>.pay.bka.sh`; confirm with your production credentials) |

Sandbox is open to everyone and never moves real money. Production debits/credits real e-money.

## Headers

| Call type | Headers |
|---|---|
| Grant / Refresh token | `Content-Type: application/json`, `Accept: application/json`, `username: <merchant username>`, `password: <merchant password>` |
| Everything else | `Content-Type: application/json`, `Accept: application/json`, `Authorization: <id_token>`, `X-App-Key: <app_key>` |

The docs' tables describe `Authorization` as "Bearer token from Grant Token API" while all cURL samples send the bare `id_token`. Default to the bare token; keep a config flag to prefix `Bearer `.

## Endpoint index

| # | Purpose | Path (append to base URL) |
|---|---|---|
| 1 | Grant token | `/auth/grant-token` |
| 2 | Refresh token | `/auth/refresh-token` |
| 3 | Create agreement | `/agreement/create` |
| 4 | Execute agreement | `/agreement/execute` |
| 5 | Cancel agreement | `/agreement/cancel` |
| 6 | Create payment (no agreement) | `/payment/create` |
| 7 | Execute payment (no agreement) | `/payment/execute` |
| 8 | Capture (no agreement, auth & capture) | `/payment/capture` |
| 9 | Void (no agreement, auth & capture) | `/payment/void` |
| 10 | Create payment with agreement | `/payment-with-agreement/create` |
| 11 | Execute payment with agreement | `/payment-with-agreement/execute` |
| 12 | Capture with agreement | `/payment-with-agreement/capture` |
| 13 | Void with agreement | `/payment-with-agreement/void` |
| 14 | Query payment | `/query/payment` |
| 15 | Query agreement | `/query/agreement` |
| 16 | Search transaction | `/general/search-transaction` |
| 17 | Refund | `/refund/payment/transaction` |
| 18 | Refund status | `/refund/payment/status` |

---

## 1. Grant Token — `/auth/grant-token`

Body: `{ "app_key": "...", "app_secret": "..." }`

Success:
```json
{ "statusCode": "0000", "statusMessage": "Successful", "token_type": "Bearer",
  "id_token": "eyJ...", "refresh_token": "eyJ...", "expires_in": 3600 }
```
Fail: `{ "statusCode": "9999", "statusMessage": "Invalid or unrecognized access credentials..." }`

Rules: `id_token` expires in `expires_in` seconds (3600). `refresh_token` lasts 30 days. **Max 2 Grant/Refresh calls per hour**; exceeding blocks the app for one hour. Refresh at minute 50–55.

## 2. Refresh Token — `/auth/refresh-token`

Body: `{ "app_key": "...", "app_secret": "...", "refresh_token": "..." }` — same response shape as Grant (new `id_token` and `refresh_token`; store both).

---

## 3. Create Agreement — `/agreement/create`

| Body field | Req | Notes |
|---|---|---|
| `payerReference` | Yes | ≤255, `^[^<>&]*$`. If it is the customer's wallet number it is pre-filled on the bKash page. |
| `callbackURL` | Yes | Where bKash redirects the customer after verification (success/failure/cancel). |

Success response fields: `paymentId`, `agreementId`, `agreementCreateTime`, `agreementStatus` (`Initiated`), `payerReference`, `bkashURL`, `callbackURL`, `successCallbackURL`, `failureCallbackURL`, `cancelledCallbackURL`, `signature`.

```json
{ "paymentId": "TR0000U0IYi9s1789633629640",
  "agreementId": "TestnewAdminZNEVVDS1789633629640",
  "bkashURL": "https://sandbox.payment.bkash.com/?paymentId=...&hash=...&mode=0000&apiVersion=v2/",
  "callbackURL": "https://callback.com/",
  "successCallbackURL": "https://callback.com/?agreementId=TestnewAdminZNEVVDS1789633629640&status=success&signature=xNbJLoDibR",
  "failureCallbackURL": "...&status=failure&signature=xNbJLoDibR",
  "cancelledCallbackURL": "...&status=cancel&signature=xNbJLoDibR",
  "payerReference": "TEST442123", "agreementStatus": "Initiated",
  "agreementCreateTime": "2026-09-17T14:27:09:640 GMT+0600", "signature": "xNbJLoDibR" }
```
Error example: `{ "internalCode": "invalid_merchant_callback_url", "externalCode": "2049", "errorMessageEn": "Invalid Merchant Callback URL", "errorMessageBn": null }`

## 4. Execute Agreement — `/agreement/execute`

Body: `{ "agreementId": "..." }` — call only after the success callback.

Success: `paymentId`, `agreementId`, `agreementStatus: "Completed"`, `agreementExecuteTime`, `payerReference`, `payerAccount` (wallet), `payerType` (`Customer`/`Agent`/`Merchant`/`Corporate Merchant`). Store `agreementId` + masked `payerAccount` against the user.

Common error: `2050` Agreement already exists between payer and merchant.

If Execute Agreement doesn't respond → Query Agreement: `Initiated` → restart from Create Agreement; `Completed` → success.

## 5. Cancel Agreement — `/agreement/cancel`

Body: `{ "agreementId": "..." }` → `paymentId`, `agreementId`, `payerReference`, `agreementVoidTime`, `agreementStatus: "Cancelled"`. Error `2053` already cancelled. Use when the customer removes the saved wallet.

---

## 6. Create Payment (without agreement) — `/payment/create`

| Body field | Type | Req | Notes |
|---|---|---|---|
| `payerReference` | string | Yes | ≤255, `^[^<>&]*$`; wallet number here pre-fills the bKash page |
| `callbackURL` | string | Yes | base URL; bKash appends `paymentID`, `status`, `signature` |
| `amount` | decimal string | Yes | e.g. `"2.90"` |
| `currency` | string | Yes | `BDT` only |
| `intent` | string | Yes | `sale` (or `authorization` for auth & capture) |
| `merchantInvoiceNumber` | string | Yes | ≤255, `^[^<>&]*$`, your unique invoice id |
| `subMerchantName` | string | No | ≤80, aggregators only (shown in customer SMS) |
| `merchantAssociationInfo` | string | No | ≤255, aggregators only, TLV e.g. `MI05MID54RF09123456789` (tags MI, MW, RF) |

Success: `paymentId`, `bkashURL`, `callbackURL`, `successCallbackURL`, `failureCallbackURL`, `cancelledCallbackURL`, `amount`, `intent`, `currency`, `paymentCreateTime`, `transactionStatus: "Initiated"`, `merchantInvoiceNumber`, `signature`.

```json
{ "paymentId": "TR0011NaM01uE1789885888970",
  "bkashURL": "https://sandbox.payment.bkash.com/?paymentId=TR0011NaM01uE1789885888970&hash=...&mode=0011&apiVersion=v2/",
  "successCallbackURL": "https://callback.com?paymentID=TR0011NaM01uE1789885888970&status=success&signature=vwJk5FkL4i",
  "amount": "2.90", "intent": "sale", "currency": "BDT",
  "transactionStatus": "Initiated", "merchantInvoiceNumber": "test001", "signature": "vwJk5FkL4i" }
```
Note the callback query key is `paymentID` (capital ID) while JSON uses `paymentId`. No `mode` field is sent in v2 — bKash sets it.

## 7. Execute Payment — `/payment/execute`

Body: `{ "paymentId": "..." }` — once only; paymentId valid 24 h.

Success: `paymentId`, `trxId`, `transactionStatus` (`Completed`; `Authorized` when intent was `authorization`), `amount`, `currency`, `intent`, `paymentExecuteTime`, `merchantInvoiceNumber`, `subMerchantName`, `payerType`, `payerReference`, `payerAccount`, `maxRefundableAmount`, and for coupon payments `couponAmount`, `creditedAmount`.

```json
{ "paymentId": "TR0011ETVFfrZ1789885992067", "trxId": "DIK20PG0H4",
  "transactionStatus": "Completed", "amount": "2.90", "currency": "BDT", "intent": "sale",
  "paymentExecuteTime": "2026-09-20T12:34:11:929 GMT+0600", "merchantInvoiceNumber": "test001",
  "payerType": "Customer", "payerReference": "TEST001ABC", "payerAccount": "01770618575",
  "maxRefundableAmount": "2.90" }
```
Errors: `2062` already completed, `2117` execution already completed, `2119` authorized payment already processed. On timeout → Query Payment.

## 8 / 9. Capture & Void (without agreement) — `/payment/capture`, `/payment/void`

Body: `{ "paymentId": "..." }` (payment must be `Authorized`).

Capture success: `paymentId`, `trxId`, `createTime`, `updateTime`, `transactionStatus: "Completed"`.
Void success: same fields with `transactionStatus: "Cancelled"`. Error `2069` already cancelled.
The without-agreement void page lists a **3–5 day auto-void** window for uncaptured authorizations.

---

## 10. Create Payment with Agreement — `/payment-with-agreement/create`

Same body as Create Payment **plus** `agreementId` (required) and **without** `payerReference`. `intent`: `sale` or `authorization`.
Response adds `agreementId`; the callback URLs also carry `&agreementId=...`. Customer only enters PIN.

## 11. Execute Payment with Agreement — `/payment-with-agreement/execute`

Body: `{ "paymentId": "...", "agreementId": "..." }` → same fields as Execute Payment plus `agreementId`.

## 12 / 13. Capture & Void with Agreement — `/payment-with-agreement/capture`, `/payment-with-agreement/void`

Body: `{ "paymentId": "...", "agreementId": "..." }` → `paymentId`, `agreementId`, `trxId`, `createTime`, `updateTime`, `transactionStatus` (`Completed` / `Cancelled`). The with-agreement void page carries a "30s auto void" badge — confirm the authorization validity window with bKash for your merchant account.

The current capture APIs take **no amount**: capture settles the authorized amount. (The product overview mentions partial capture; if you need it, confirm with bKash first.)

---

## 14. Query Payment — `/query/payment`

Body: `{ "paymentId": "..." }`. Returns `paymentId`, `verificationStatus` (`Incomplete`/`Complete`), `payerReference`, `payerAccount`, `payerType`, `paymentCreateTime`, `paymentExecuteTime`, `paymentUpdateTime` (capture/void time for auth & capture), `trxId`, `transactionStatus`, `amount`, `currency`, `intent`, `merchantInvoice` (note: not `merchantInvoiceNumber`), `subMerchantName`, `serviceFee`, `creditedAmount`, `couponAmount`, `maxRefundableAmount`, and for agreement payments `agreementId`, `agreementStatus`, `agreementCreateTime`, `agreementExecuteTime`.

`transactionStatus` is `Completed` on success and stays `Initiated` when verification was cancelled/failed or Execute was never called.

## 15. Query Agreement — `/query/agreement`

Body: `{ "agreementId": "..." }` → `paymentId`, `verificationStatus`, `payerReference`, `payerAccount`, `payerType`, `agreementId`, `agreementStatus`, `agreementCreateTime`, `agreementExecuteTime`. Error `2051` invalid agreement id.

## 16. Search Transaction — `/general/search-transaction`

Body: `{ "trxId": "..." }` → `trxId`, `initiationTime`, `completedTime`, `transactionType` (e.g. "bKash Tokenized Checkout via API"), `payerAccount`, `transactionStatus`, `amount`, `currency`, `organizationAccount`, `serviceFee`, `payerType`, `creditedAmount`, `couponAmount`, `merchantShareAmount`, `maxRefundableAmount`. Use for support tooling and reconciliation.

---

## 17. Refund — `/refund/payment/transaction`

| Body field | Req | Notes |
|---|---|---|
| `paymentId` | Yes | original paymentId |
| `trxId` | Yes | original trxId |
| `refundAmount` | Yes | ≤2 decimals, ≤ remaining `maxRefundableAmount` |
| `sku` | Yes | ≤255 product tag |
| `reason` | Yes | ≤255 |

Success: `originalTrxId`, `refundTrxId`, `refundTransactionStatus: "Completed"`, `originalTrxAmount`, `refundAmount`, `currency`, `completedTime`, `sku`, `reason`.

Limits: up to **10** refunds per transaction, total ≤ `maxRefundableAmount` (coupon-adjusted), within **60 days**, identical refund blocked for **10 minutes**. Paid from the merchant's current collection balance (error `2023` Insufficient Balance otherwise). On timeout → Refund Status; only re-refund if no matching refund appears.

## 18. Refund Status — `/refund/payment/status`

Body: `{ "paymentId": "...", "trxId": "<original trxId>" }` →
```json
{ "originalTrxId": "DIK80PG0SO", "originalTrxAmount": "20",
  "originalTrxCompletedTime": "2026-09-20T14:39:02:266 GMT+0600",
  "refundTransactions": [
    { "refundTrxId": "DIK50PG0VX", "refundTransactionStatus": "Completed", "refundAmount": "10.00", "completedTime": "2026-09-20T14:47:02:000" } ] }
```

---

## Response handling cheat-sheet

- Token calls: success ⇔ `statusCode === "0000"` and `id_token` present.
- Other calls: error ⇔ body has `externalCode` (or `statusCode` other than `"0000"`, or HTTP ≥ 400). Otherwise check the expected status field (`transactionStatus`, `agreementStatus`, `refundTransactionStatus`).
- Timestamps look like `2026-09-20T12:34:11:929 GMT+0600` (milliseconds after a colon) — parse defensively or store as strings.
- Numbers arrive as strings (`"20.00"`, `"16.0"`) — use decimal types, never floats, for money.
