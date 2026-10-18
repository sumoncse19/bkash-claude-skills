#!/usr/bin/env bash
# Builds dist/bkash-payment-gateway.zip with bkash-payment-gateway/SKILL.md at the top level (Claude.ai upload format).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/bkash-payment-gateway.zip"
cd "$ROOT/plugins/bkash-payment-gateway/skills"
zip -rq "$ROOT/dist/bkash-payment-gateway.zip" bkash-payment-gateway -x '*/__pycache__/*' '*.pyc' '*/.DS_Store'
echo "Built $ROOT/dist/bkash-payment-gateway.zip"
