# bKash products — what to choose

| Product | Status in docs | Use it for |
|---|---|---|
| **Tokenized Checkout** (with or without agreement) | Highly recommended; full v2 API docs | Standard way to accept payments. Server creates payment, customer confirms on bKash's hosted page, result comes back via callback + Execute. Base for most other products. |
| **Agreement** | Full v2 API docs | Save a customer's wallet once (wallet + OTP); later payments need only PIN. Any business with repeat customers. |
| **Auth & Capture** | Full v2 API docs | Reserve funds, then capture after delivery or void if not. Bookings, reservations, service-first platforms. |
| **Refund** | Full v2 API docs | Full/partial refunds (≤10 per txn, 60 days). |
| **Query / Search** | Full v2 API docs | Status checks, timeout recovery, reconciliation, support tooling. |
| **Webhook / IPN** | Documented (SNS payloads) | Server notifications for successful payments across PGW, App, USSD, QR, Bangla QR, M2M. |
| **Dynamic Charging** | Product description only | Collect service/convenience fees (fixed, percentage, slab) during payment, split to beneficiaries. PGW-only channel. Customer sees fee breakdown after entering wallet number. |
| **Recurring Payment** | Product description only (Advanced) | Subscriptions on top of an Agreement — scheduled charges without per-payment approval. Error codes 2004 (firstPaymentDate) / 2005 (frequency) hint at its request fields. |
| **Direct Charge** | Product description only (Advanced) | Charge a bound wallet from your server with no redirect after one-time binding (wallet + OTP + PIN). More compliance responsibility. Customers can unlink from the bKash App "Linked Apps"; unlink requests are forwarded to the merchant. |
| **Disbursement / Payout** | Product description only (Advanced) | Send money out: B2C (customers, cashback, driver earnings), B2B (other merchants; 2-minute duplicate block; fee on sender), B2A (agents). |
| **Checkout iFrame** | Not recommended (legacy) | Embedded form inside your page. Migrate to Tokenized redirect flow. |
| **M2M / A2M payments** | FAQ | Merchants/agents paying a merchant through PGW (merchant/agent wallet + OTP + PIN, or PIN with agreement). Whitelisted categories only; no coupons for M2M. |
| **Coupons** | FAQ + response fields | UI-based or API-based discounts. Watch `couponAmount`, `creditedAmount`, `maxRefundableAmount`, `merchantShareAmount`. |

For the "description only" products: implement shared infrastructure (config, token manager, persistence, IPN) and request the merchant-specific API spec from bKash. Do not guess endpoints.

## Onboarding steps

1. **Become a bKash merchant** — KYC documents + agreement via your Merchant Account Manager.
2. **Sandbox** — open to everyone: `https://<service>.sandbox.bka.sh` (Tokenized: `tokenized.sandbox.bka.sh`).
3. **Production** — after onboarding, bKash issues production credentials: `https://<service>.pay.bka.sh`. Real e-money moves.
