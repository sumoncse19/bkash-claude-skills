#!/usr/bin/env bash
# Runs every template client against a fresh mock server. Used by CI and locally.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TPL="$ROOT/plugins/bkash-payment-gateway/skills/bkash-payment-gateway/templates"
PORT="${PORT:-8765}"
export MOCK_URL="http://127.0.0.1:$PORT"
SERVER_PID=""

start_mock() {
  python3 "$ROOT/tests/mock_bkash_server.py" "$PORT" & SERVER_PID=$!
  for _ in $(seq 1 50); do curl -s "$MOCK_URL/stats" >/dev/null 2>&1 && return; sleep 0.1; done
  echo "mock server did not start" >&2; exit 1
}
stop_mock() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
trap stop_mock EXIT

run() { local name="$1"; shift; echo "== $name"; start_mock; "$@"; stop_mock; }

LANGS="${LANGS:-python node php go ruby}"
for l in $LANGS; do
  case "$l" in
    python) command -v python3 >/dev/null && run python python3 "$ROOT/tests/test_python_client.py" ;;
    node)   command -v node >/dev/null && run node node --experimental-transform-types --no-warnings "$ROOT/tests/test_node_client.ts" ;;
    php)    command -v php >/dev/null && run php php "$ROOT/tests/test_php_client.php" ;;
    ruby)   command -v ruby >/dev/null && run ruby ruby "$ROOT/tests/test_ruby_client.rb" ;;
    go)
      if command -v go >/dev/null; then
        TMP="$(mktemp -d)"; cp "$TPL/go/bkash.go" "$TMP/"; mkdir -p "$TMP/test"; cp "$ROOT/tests/go/bkash_test.go" "$TMP/test/"
        (cd "$TMP" && go mod init example.com/bkash >/dev/null 2>&1 && go vet ./...)
        run go bash -c "cd '$TMP' && go test ./test/ -count=1"
        rm -rf "$TMP"
      fi ;;
  esac
done
echo "all template tests passed"
