# Integration flows, state machines and data model

All flows assume a valid token from the token manager (see SKILL.md "Token rules").

## Without agreement

One-time payment; customer enters wallet number → OTP → PIN on bKash's page.

```
Customer        Your frontend         Your server                     bKash
   | click Pay ------> | POST /payments/bkash ->|                          |
   |                   |                        |-- payment/create ------->|
   |                   |                        |<- paymentId, bkashURL ---|
   |                   |                        | save {order, paymentId, signature, status=INITIATED}
   |<------------- redirect to bkashURL --------|                          |
   |------------------------ wallet / OTP / PIN on bKash page ------------>|
   |<---- 302 to callbackURL?paymentID=..&status=success&signature=.. -----|
   |------------------------------------------->| GET /payments/bkash/callback
   |                                            | validate paymentID + signature
   |                                            |-- payment/execute ------>|
   |                                            |<- trxId, Completed ------|
   |                                            | mark PAID (in a transaction)
   |<------- redirect to /orders/:id/success ---|
```

Callback handling:

| `status` | Action |
|---|---|
| `success` | Execute Payment → `Completed` ⇒ paid; error ⇒ show `errorMessageEn`; timeout ⇒ Query Payment |
| `failure` | Mark attempt FAILED, let the user retry (new Create) |
| `cancel` | Mark attempt CANCELLED, back to checkout |
| missing / unknown paymentID | 400; log; do not call bKash |

Execute timeout / 5xx / network error → **Query Payment**:

| Query `transactionStatus` | Meaning | Action |
|---|---|---|
| `Completed` | paid | mark PAID, store `trxId` |
| `Authorized` | auth & capture hold succeeded | mark AUTHORIZED |
| `Initiated` | not executed / verification incomplete | mark FAILED; user must start a new Create |
| query also fails | unknown | keep `PENDING_VERIFICATION`; recovery job retries Query |

## With agreement

**Phase 1 — Agreement (once per customer)**
1. `agreement/create` with `payerReference` (your customer id or their wallet no.) and `callbackURL` → save `agreementId`, `paymentId`, `signature`, status `INITIATED`.
2. Redirect to `bkashURL`; customer enters wallet number + OTP.
3. Callback `?agreementId=...&status=success|failure|cancel&signature=...`.
4. On success → `agreement/execute` → `agreementStatus: Completed` → save `agreementId`, `payerAccount` (show masked, e.g. `017*****575`) against the user.
5. Execute timeout → `query/agreement`: `Initiated` ⇒ restart create; `Completed` ⇒ success.
6. Error `2050` (agreement already exists): the wallet is already bound to your merchant; look it up in your DB, or ask the user to remove it and bind again.

**Phase 2 — Payment (every purchase)**
1. `payment-with-agreement/create` with `agreementId`, amount, invoice, `intent: sale`.
2. Redirect to `bkashURL`; customer enters PIN only.
3. Callback `?paymentID=...&status=...&signature=...&agreementId=...`.
4. `payment-with-agreement/execute` with `paymentId` + `agreementId` → `Completed`.
5. Same Query fallback as above.

**Remove saved wallet** → `agreement/cancel` → `Cancelled`; mark the agreement inactive. Also handle `2051`/`2053`/`2055` by marking the stored agreement inactive and falling back to the without-agreement flow.

UI tip: offer "Pay with saved bKash (017*****575)" + "Use another bKash account". If the user has no active agreement, either run Phase 1 first or use the without-agreement flow.

## Auth & capture

Use `intent: "authorization"` in either Create Payment or Create Payment with Agreement.

```
Payment status:  INITIATED --execute--> AUTHORIZED --capture--> CAPTURED (Completed)
                                         |--void-----------> VOIDED (Cancelled)
                                         |--no action------> EXPIRED (auto-void)
Order status:    PENDING --> SERVICE_PROVIDED --> COMPLETED   (or CANCELLED)
```

- Execute returns `transactionStatus: "Authorized"` — funds are held, **not** settled. Do not mark the order paid.
- After fulfilling: Capture (`/payment/capture` or `/payment-with-agreement/capture`) → `Completed`.
- If you cannot fulfil: Void → `Cancelled`; money returns immediately.
- Capture/Void can be called once per authorization; on timeout retry the same call (guarded by a DB lock / idempotency key) or Query Payment to see whether it already applied (`paymentUpdateTime`, `transactionStatus`).
- Schedule a job to capture/void before the authorization window closes (docs: 3–5 days without agreement; check your merchant config).

## Refund

1. Admin/user requests refund for an order with `paymentId` + `trxId`.
2. Check locally: within 60 days, `refund_count < 10`, `sum(refunds) + amount ≤ maxRefundableAmount`, no identical refund in the last 10 minutes.
3. Insert a `bkash_refunds` row `PENDING` (unique idempotency key) **before** calling bKash.
4. Call `/refund/payment/transaction` → `refundTransactionStatus: Completed` → store `refundTrxId`.
5. Timeout → `/refund/payment/status` (`paymentId`, original `trxId`) → find a refund with the same amount after your request time; if none, it is safe to retry (after the 10-minute duplicate window if bKash rejected it as duplicate).

## Data model

```sql
CREATE TABLE bkash_payments (
  id                BIGSERIAL PRIMARY KEY,
  order_id          VARCHAR(64)  NOT NULL,
  invoice_number    VARCHAR(255) NOT NULL UNIQUE,      -- merchantInvoiceNumber
  payment_id        VARCHAR(64)  UNIQUE,                -- bKash paymentId
  agreement_id      VARCHAR(64),
  intent            VARCHAR(16)  NOT NULL DEFAULT 'sale',
  amount            DECIMAL(12,2) NOT NULL,
  currency          CHAR(3)      NOT NULL DEFAULT 'BDT',
  status            VARCHAR(32)  NOT NULL,              -- INITIATED|PENDING_VERIFICATION|COMPLETED|AUTHORIZED|CAPTURED|VOIDED|FAILED|CANCELLED
  create_signature  VARCHAR(64),
  trx_id            VARCHAR(32),
  payer_account     VARCHAR(20),
  max_refundable    DECIMAL(12,2),
  error_code        VARCHAR(16),
  error_message     TEXT,
  raw_create        JSON, raw_execute JSON, raw_query JSON,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bkash_agreements (
  id             BIGSERIAL PRIMARY KEY,
  user_id        VARCHAR(64) NOT NULL,
  agreement_id   VARCHAR(64) NOT NULL UNIQUE,
  payer_account  VARCHAR(20),
  status         VARCHAR(16) NOT NULL,   -- INITIATED|ACTIVE|CANCELLED
  create_signature VARCHAR(64),
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at   TIMESTAMP
);

CREATE TABLE bkash_refunds (
  id               BIGSERIAL PRIMARY KEY,
  payment_id       VARCHAR(64) NOT NULL,
  original_trx_id  VARCHAR(32) NOT NULL,
  refund_trx_id    VARCHAR(32) UNIQUE,
  amount           DECIMAL(12,2) NOT NULL,
  sku              VARCHAR(255) NOT NULL,
  reason           VARCHAR(255) NOT NULL,
  status           VARCHAR(16) NOT NULL,  -- PENDING|COMPLETED|FAILED|UNKNOWN
  idempotency_key  VARCHAR(64) NOT NULL UNIQUE,
  raw_response     JSON,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bkash_tokens (           -- only if you don't use Redis
  id             SMALLINT PRIMARY KEY,  -- single row per credential set
  id_token       TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     TIMESTAMP NOT NULL,
  refreshed_at   TIMESTAMP NOT NULL,
  calls_this_hour SMALLINT NOT NULL DEFAULT 0,
  hour_window_start TIMESTAMP NOT NULL
);
```

Make the PAID transition atomic: `UPDATE bkash_payments SET status='COMPLETED', trx_id=? WHERE payment_id=? AND status IN ('INITIATED','PENDING_VERIFICATION')` and only fulfil the order if one row changed — this makes double callbacks, IPN and recovery jobs safe.

## Recovery / reconciliation job

Every 5–15 minutes:
- Payments in `INITIATED` older than ~15 min or in `PENDING_VERIFICATION`: Query Payment, apply the table above. After 24 h a paymentId can no longer be executed — mark `FAILED`/`EXPIRED` if still `Initiated`.
- `AUTHORIZED` payments approaching the auto-void window: alert or auto-void/capture per business rules.
- Refunds in `UNKNOWN`: Refund Status.
- Optionally cross-check IPN `trxID`s with Search Transaction.
