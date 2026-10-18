# Security checklist, sandbox test plan, go-live

## Security

- Credentials (`username`, `password`, `app_key`, `app_secret`) and `refresh_token` live server-side only (env vars / secret manager). Never ship them to a browser, mobile app, or public repo. Add them to `.gitignore`d `.env` and to CI secrets.
- Mobile apps and SPAs **never** call bKash directly — they call your backend, which calls bKash.
- TLS 1.2+ for all outbound calls; keep the OS CA bundle current.
- Rotate credentials immediately if a token or secret leaks.
- Callback endpoint:
  - accept only `paymentID`/`agreementId`, `status`, `signature` query params;
  - look up the record by `paymentID` and require it to be in `INITIATED` state;
  - compare `signature` with the value saved from the Create response (constant-time compare);
  - ignore `status` for anything except deciding whether to call Execute;
  - make it idempotent (double clicks, browser back, IPN race).
- Amount is decided **server-side** from the order, never from the client request.
- Never collect PIN/OTP; only redirect to `bkashURL` from the API response.
- Log request/response bodies for audit, but redact `app_secret`, `password`, tokens.
- Rate-limit your "create payment" endpoint per user/session to avoid abuse.
- Validate free-text fields with `^[^<>&]*$` and length limits before sending.
- IPN: verify SNS signatures, restrict `SigningCertURL`/`SubscribeURL` hosts to `sns.*.amazonaws.com`, dedupe by `trxID`.
- Refund / capture / void endpoints are admin-only, audited, and idempotent.

## Sandbox test plan

Use the sandbox base URL and sandbox credentials (from bKash or the merchant integration form). bKash sandbox provides test wallets with fixed OTP/PIN — get the current values from your bKash integration contact or the sandbox page; don't hard-code them in the skill.

| # | Case | Expected |
|---|---|---|
| 1 | Grant token | `statusCode 0000`, `id_token`; cached; second app instance reuses it |
| 2 | Refresh token after simulated 50 min | new token stored; ≤ 2 calls/hour |
| 3 | Create → pay → success callback → Execute | `Completed`, `trxId`, order PAID once |
| 4 | Cancel on bKash page | `status=cancel`, order still unpaid, can retry |
| 5 | Wrong OTP/PIN until failure | `status=failure`, friendly message |
| 6 | Reload callback URL after success | no second Execute; shows success |
| 7 | Execute timeout (simulate) | Query Payment used; correct final state |
| 8 | Invalid amount / currency / callback URL | `2006` / `2007` / `2049` mapped to 4xx with `errorMessageEn` |
| 9 | Agreement create → execute → pay with PIN | `agreementId` stored; payment `Completed` |
| 10 | Bind same wallet again | `2050` handled |
| 11 | Cancel agreement | `Cancelled`; saved wallet hidden |
| 12 | Auth → capture | `Authorized` then `Completed` |
| 13 | Auth → void | `Authorized` then `Cancelled` |
| 14 | Partial refund ×2, then over-refund | two `Completed`, then `2072` |
| 15 | Refund Status | history lists both refunds |
| 16 | Search Transaction by `trxId` | matches order |
| 17 | IPN subscription + notification (replay a captured SNS message) | confirmed; order matched; duplicate ignored |

## Go-live

1. Complete merchant onboarding (KYC, agreement) with your bKash Merchant Account Manager; submit the Merchant Integration Form with the products you use.
2. Receive production credentials; store them in the production secret store.
3. Switch `BKASH_BASE_URL` to production; make sure callback URLs are your public production HTTPS domain.
4. Give bKash your production IPN listener URL; confirm the SNS subscription arrives and is acknowledged.
5. Do a small live payment and refund it; verify settlement in the merchant portal.
6. Turn on monitoring: alerts for token failures, error-rate spikes, payments stuck in `PENDING_VERIFICATION`, IPN signature failures.
