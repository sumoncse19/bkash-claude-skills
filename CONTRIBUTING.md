# Contributing

Thanks for helping Bangladeshi developers ship bKash integrations faster.

## Ground rules

1. **Docs are the source of truth.** Every endpoint, field, limit and error code must come from https://developer.bka.sh (or its `llms.txt` index). Link the page in your PR. Never invent endpoints for products without public specs.
2. **Never commit credentials** — not even sandbox ones.
3. Keep `SKILL.md` short: workflow + rules. Put detail in `references/`, code in `templates/`.
4. Templates must keep the shared behaviour: shared token store + lock, ≤ 2 grant/refresh calls per hour, 30 s timeout, raw `id_token` in `Authorization` by default, `bkashURL`/`bKashURL` normalisation, error mapping (`externalCode`/`errorMessageEn`), `executeWithRecovery` (Query Payment on timeout/5xx/already-completed).

## Workflow

```bash
tests/run_all.sh                                   # all clients vs mock server
LANGS="python node" tests/run_all.sh               # subset
claude plugin validate . --strict
```

Adding a language: put the client in `templates/<lang>/`, a test in `tests/`, a case in `tests/run_all.sh`, and wiring notes in `references/stacks/`.

## Releasing

Bump `version` in `plugins/bkash-payment-gateway/.claude-plugin/plugin.json`, tag `vX.Y.Z`, push the tag — the Release workflow attaches `bkash-payment-gateway.zip` for Claude.ai upload.
