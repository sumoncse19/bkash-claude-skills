# bKash Payment Gateway — Claude Skill

An open-source [Claude skill](https://claude.com/docs/skills/how-to) (packaged as a Claude Code plugin marketplace) that teaches Claude how to implement the **bKash Payment Gateway v2 (Tokenized Checkout)** in any website, app or backend, correctly and safely.

Ask Claude things like:

- "Add bKash checkout to this Laravel shop"
- "Let returning customers pay with their saved bKash wallet in our Next.js app"
- "Implement bKash auth & capture for hotel bookings in Spring Boot"
- "Add bKash refunds and an IPN webhook to our Django backend"
- "Review my bKash integration before we go live"

and it will follow the official v2 flow: token caching within bKash's 2-calls-per-hour limit, create → redirect → callback → execute, Query fallback on timeouts, idempotent order updates, refunds, SNS-signed webhooks, error-code handling and a go-live checklist.

> **Unofficial.** This project is community-maintained and is not affiliated with or endorsed by bKash Limited. "bKash" is a trademark of its owner. Always check https://developer.bka.sh for the latest API behaviour.

## What's covered

| Area | Details |
|---|---|
| Auth | Grant / Refresh token, shared cache + lock, 50–55 min refresh, rate-limit guard |
| Tokenized Checkout | Without agreement (Checkout URL), with agreement (saved wallet, PIN-only), cancel agreement |
| Auth & Capture | `intent: authorization`, capture, void — with and without agreement |
| Query & Search | Query Payment, Query Agreement, Search Transaction, recovery job |
| Refund | Full/partial (≤10, 60 days, `maxRefundableAmount`, 10-min duplicate rule), Refund Status |
| Webhook / IPN | AWS SNS subscription confirmation, signature verification, payload fields, transaction-type codes |
| Errors | All payment & refund error codes with handling strategy |
| Stacks | Node (Express, Next.js, NestJS), PHP (plain, Laravel, WordPress/WooCommerce), Python (Django, FastAPI, Flask), Java (Spring Boot), .NET, Go, Ruby on Rails, React/Vue SPAs, Flutter, React Native, Android, iOS |
| Drop-in clients | `templates/` for TypeScript, PHP, Python, Java, C#, Go, Ruby — tested against a mock bKash server |
| Other products | Recurring, Direct Charge, Dynamic Charging, Payout, iFrame — explained; Claude asks for the merchant-specific spec instead of inventing endpoints |

## Install

### Claude Code (plugin marketplace)

```text
/plugin marketplace add sumoncse19/bkash-claude-skills
/plugin install bkash-payment-gateway@bkash-skills
```

or from a shell:

```bash
claude plugin marketplace add sumoncse19/bkash-claude-skills
claude plugin install bkash-payment-gateway@bkash-skills
```

### Claude.ai / Claude desktop (upload the skill)

1. Download `bkash-payment-gateway.zip` from the [latest release](https://github.com/sumoncse19/bkash-claude-skills/releases) (or build it with `scripts/package-skill.sh`).
2. In Claude, open **Customize → Skills** and upload the zip, then turn the skill on.

### Manual (Claude Code, no marketplace)

```bash
git clone https://github.com/sumoncse19/bkash-claude-skills
cp -r bkash-claude-skills/plugins/bkash-payment-gateway/skills/bkash-payment-gateway ~/.claude/skills/        # personal
# or: cp -r ... your-project/.claude/skills/                                                                  # per project
```

## Repository layout

```
.claude-plugin/marketplace.json            # marketplace "bkash-skills"
plugins/bkash-payment-gateway/
  .claude-plugin/plugin.json
  skills/bkash-payment-gateway/
    SKILL.md                               # workflow + non-negotiable rules
    references/                            # API reference, flows, errors, IPN, security, products, stack guides
    templates/                             # drop-in clients: node, php, python, java, csharp, go, ruby
tests/                                     # mock bKash server + client tests
scripts/package-skill.sh                   # builds the .zip for Claude.ai upload
```

## Development

```bash
tests/run_all.sh                     # runs python, node, php, go, ruby clients against tests/mock_bkash_server.py
claude plugin validate . --strict    # validate marketplace + plugin manifests
```

CI (`.github/workflows/ci.yml`) also compiles the Java and C# templates.

When bKash updates its docs, update `references/` first, then the templates, then bump `version` in `plugins/bkash-payment-gateway/.claude-plugin/plugin.json`.

## Contributing

PRs welcome — especially new stack guides, framework adapters (token stores, webhook handlers) and doc updates. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
