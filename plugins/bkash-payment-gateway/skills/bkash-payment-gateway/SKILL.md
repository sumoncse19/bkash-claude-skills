---
name: bkash-payment-gateway
description: Implement, review or debug a bKash Payment Gateway (PGW) v2 Tokenized Checkout integration in any website, app or backend — grant/refresh token, create/execute payment, agreements (saved wallets), auth & capture/void, query/search, refunds, IPN webhooks, error codes and go-live. Use whenever the user mentions bKash, bka.sh, tokenized checkout, bKash agreement, or accepting BDT mobile-wallet payments in Bangladesh, in any stack (Node, PHP/Laravel/WordPress, Python, Java, .NET, Go, Ruby, mobile).
---

# bKash Payment Gateway v2 (Tokenized Checkout)

This skill turns the official bKash v2 developer docs (https://developer.bka.sh, index at https://developer.bka.sh/llms.txt) into a repeatable implementation workflow. All endpoint paths, fields, limits and error codes in `references/` were taken from those docs (Sept–Oct 2026 revision).

## When the user asks for a bKash integration

1. **Pick the product** (ask only if unclear — default to *Tokenized Without Agreement*):

   | Need | Product | Flow file |
   |---|---|---|
   | One-off checkout, guest users | Tokenized **Without** Agreement ("Checkout URL") | `references/flows.md#without-agreement` |
   | Returning customers pay with PIN only | Tokenized **With** Agreement | `references/flows.md#with-agreement` |
   | Bookings / hold then charge or release | **Auth & Capture** (with or without agreement) | `references/flows.md#auth-capture` |
   | Return money for a paid order | **Refund** + Refund Status | `references/flows.md#refund` |
   | Server notification of completed payments (PGW, App, USSD, QR) | **Webhook / IPN** (AWS SNS) | `references/webhook-ipn.md` |
   | Recurring, Direct Charge, Dynamic Charging, Payout (B2C/B2B/B2A), Checkout iFrame | Not specified in the public v2 pages — see "Products without public v2 specs" below |

2. **Detect the stack** from the repo (package.json, composer.json, requirements.txt/pyproject, pom.xml/build.gradle, *.csproj, go.mod, Gemfile, pubspec.yaml) and open the matching guide in `references/stacks/`. Copy the matching client from `templates/` instead of writing one from scratch, then adapt names/DI/config to the project's conventions.

3. **Build these pieces, in this order** (every stack):
   1. Config: `BKASH_BASE_URL`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_CALLBACK_URL` from env/secret store — never in code or the frontend bundle.
   2. Token manager (grant → cache → refresh at ~50–55 min) backed by a **shared** cache (Redis/DB/cache table) with a lock. See "Token rules".
   3. Thin API client: one method per endpoint in `references/api-reference.md`, 30 s timeout, JSON in/out, error normalisation.
   4. Persistence: a `bkash_payments` record per attempt (order_id, payment_id, signature, amount, invoice, status, trx_id, raw responses, timestamps) and `bkash_agreements` per customer if agreements are used. Schema in `references/flows.md#data-model`.
   5. Routes: `POST /payments/bkash` (create → return/redirect to `bkashURL`), `GET /payments/bkash/callback` (status handling → execute → redirect user to result page), optional refund/capture/void admin endpoints, optional `POST /webhooks/bkash` (IPN).
   6. Recovery job: reconcile `Initiated`/`unknown` payments via Query Payment.
   7. Tests against the sandbox, then the go-live checklist in `references/security-and-go-live.md`.

4. **Before finishing**, walk the checklist at the bottom of this file and tell the user which items still need their input (credentials, callback domain, IPN listener URL to give bKash).

## Non-negotiable rules (from the docs)

- **Environments**: sandbox `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout`, production `https://tokenized.pay.bka.sh/v2/tokenized-checkout` (pattern `https://<service>.pay.bka.sh`; confirm against the production credentials bKash issues). TLS 1.2+ only.
- **Headers** on every non-auth call: `Content-Type: application/json`, `Accept: application/json`, `Authorization: <id_token>`, `X-App-Key: <app_key>`. The docs' tables say "Bearer token" but every official cURL sample sends the raw `id_token`; send the raw token by default and make the `Bearer ` prefix a config switch.
- **Token rules**: `id_token` lives 3600 s; `refresh_token` 30 days. Grant/Refresh may be called **at most twice per hour** — exceeding it blocks the app for an hour. So: never grant per request, cache across all processes/servers, refresh between minute 50 and 55, fall back to a fresh grant only if refresh fails, and serialise with a lock.
- **Never collect wallet number, OTP or PIN** on your own pages. Always redirect to the `bkashURL` returned by the Create call — never build or reuse it. (Responses spell it `bkashURL`; the tables say `bKashURL` — read both.)
- **The callback is not proof of payment.** bKash redirects the browser to `callbackURL?paymentID=…&status=success|failure|cancel&signature=…` (agreements: `agreementId=…`). Only call Execute on `status=success`, look the paymentID up in your own DB, compare `signature` with the one saved from Create, and mark paid **only** after Execute returns `transactionStatus: Completed` (or `Authorized` for auth & capture) or Query confirms it.
- **Execute exactly once.** A `paymentId` is valid 24 h and can be executed once, regardless of outcome. If Execute times out or errors ambiguously → call **Query Payment**: `Completed`/`Authorized` → success; `Initiated` → start over with a new Create. Never blindly retry Create/Execute (duplicate payments).
- **Capture/Void** may be retried on timeout, but guard with an idempotency lock so you never double-capture/void.
- **Errors**: v2 errors return `internalCode`, `externalCode`, `errorMessageEn`, `errorMessageBn`. Branch on `externalCode`, show `errorMessageEn` to the customer. Token endpoints use `statusCode` (`"0000"` = success) / `statusMessage`. Codes in `references/error-codes.md`.
- **Amounts** are BDT decimal strings with ≤ 2 decimals (`"100.00"`); `currency: "BDT"`; `intent: "sale"` (or `"authorization"` for auth & capture). Validate `merchantInvoiceNumber`/`payerReference`/`sku`/`reason` against `^[^<>&]*$`, max 255 chars (`subMerchantName` 80).
- **Refunds**: up to 10 partial refunds per transaction, total ≤ `maxRefundableAmount` (coupon-aware), within 60 days, and no identical refund within 10 minutes. On timeout call Refund Status before retrying.
- **Timeouts**: use 30 s client timeouts on every call; a timeout is "unknown", not "failed".
- Keep **order status** and **payment status** as separate fields.

## Products without public v2 specs

The v2 portal currently publishes full API pages only for Tokenized Checkout (with/without agreement, auth & capture), Query/Search, Refund, error codes and IPN. Recurring Payment, Direct Charge, Dynamic Charging, Disbursement/Payout (B2C/B2B/B2A) and Checkout iFrame are only described at product level. For those: explain the product (see `references/products.md`), scaffold the surrounding code (config, token manager, persistence, webhooks), and ask the user for the merchant-specific API spec from their bKash account manager — **do not invent endpoints or fields**.

## Files in this skill

- `references/api-reference.md` — every v2 endpoint: method, path, headers, body, response fields, sample payloads.
- `references/flows.md` — step-by-step state machines, data model, recovery logic, callback handling.
- `references/error-codes.md` — payment, refund and token error codes with handling advice.
- `references/webhook-ipn.md` — SNS subscription confirmation, signature verification, payload fields, transaction type codes.
- `references/security-and-go-live.md` — security checklist, sandbox test plan, production cut-over.
- `references/products.md` — what each bKash product is for and when to choose it.
- `references/stacks/node.md` — Express, Next.js (App Router), NestJS, Fastify; Prisma model; recovery job.
- `references/stacks/php.md` — plain PHP, Laravel (service provider, cache-lock token store, controller, migration, scheduler, SNS webhook), WordPress/WooCommerce gateway, Symfony/CodeIgniter.
- `references/stacks/python.md` — Django, FastAPI, Flask.
- `references/stacks/jvm-dotnet-go-ruby.md` — Spring Boot, ASP.NET Core, Go net/http, Ruby on Rails.
- `references/stacks/frontend-mobile.md` — SPA button/redirect, Flutter, React Native, Android, iOS WebView callback interception.
- `templates/<lang>/` — drop-in API clients with token caching, for Node (TypeScript), PHP, Python, Java, C#, Go, Ruby.

## Final checklist (tell the user what's left)

- [ ] Credentials (username, password, app_key, app_secret) in env/secret manager, separate for sandbox and production
- [ ] Token cached in shared store; ≤ 2 grant/refresh calls per hour verified
- [ ] Create → redirect → callback → Execute → Query fallback implemented and idempotent
- [ ] Callback validates paymentID ownership + signature; never trusts `status` alone
- [ ] Payment and order states stored separately; raw bKash responses logged (no secrets)
- [ ] Refund (and Capture/Void if used) guarded against duplicates
- [ ] IPN listener confirms SNS subscription, verifies signatures, dedupes by `trxID`
- [ ] Error messages from `errorMessageEn` shown to users
- [ ] Sandbox test cases in `references/security-and-go-live.md` pass
- [ ] Production base URL + credentials switched by config only; callback URL is public HTTPS
