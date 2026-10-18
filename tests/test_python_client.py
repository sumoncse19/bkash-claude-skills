"""Exercise templates/python/bkash_client.py against tests/mock_bkash_server.py."""
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "plugins/bkash-payment-gateway/skills/bkash-payment-gateway/templates/python"))
from bkash_client import BkashClient, BkashError  # noqa: E402

BASE = os.environ.get("MOCK_URL", "http://127.0.0.1:8765")
c = BkashClient(BASE + "/v2/tokenized-checkout", "user", "pass", "test_app_key", "secret")

r = c.create_payment("100", "INV-1", "https://shop.test/cb", "CUST1")
assert r["bkashURL"].startswith("https://"), r
assert r["signature"] == "sig" + r["paymentId"]
e = c.execute_with_recovery(r["paymentId"])
assert e["status"] == "Completed", e
again = c.execute_with_recovery(r["paymentId"])  # 2062 -> query
assert again["status"] == "Completed", again

r2 = c.create_payment("503.00", "INV-2", "https://shop.test/cb", "CUST1")  # mock returns 503 on execute
assert c.execute_with_recovery(r2["paymentId"])["status"] == "Completed"

try:
    c.create_payment("999.99", "INV-3", "https://shop.test/cb", "CUST1")
    raise AssertionError("expected BkashError")
except BkashError as ex:
    assert ex.code == "2006" and str(ex) == "Invalid amount.", (ex.code, str(ex))

for bad in ("0", "-1", "abc"):
    try:
        BkashClient.amount(bad)
        raise AssertionError("amount should fail: " + bad)
    except ValueError:
        pass
try:
    BkashClient.safe("a<b")
    raise AssertionError("safe should fail")
except ValueError:
    pass

assert c.refund(r["paymentId"], e["data"]["trxId"], "10", "SKU", "test")["refundTransactionStatus"] == "Completed"
assert c.create_payment_with_agreement("AGR1", "50", "INV-4", "https://shop.test/cb", intent="authorization")["intent"] == "authorization"
assert c.capture_payment("P")["transactionStatus"] == "Completed"
assert c.void_payment_with_agreement("P", "AGR1")["transactionStatus"] == "Cancelled"

stats = json.load(urllib.request.urlopen(BASE + "/stats"))
assert stats["grant"] == 1, stats  # token cached

# refresh window: token expiring in 60 s -> refresh (not grant)
import time  # noqa: E402
s = c.store.get()
s["expires_at"] = time.time() + 60
s["auth_calls"] = [time.time() - 4000]
c.store.set(s)
c.get_token()
stats = json.load(urllib.request.urlopen(BASE + "/stats"))
assert stats == {"grant": 1, "refresh": 1}, stats
assert c.store.get()["refresh_token"] == "mock-refresh-2"

# rate-limit guard: 2 calls in the last hour + still-valid token -> reuse, no call
s = c.store.get()
s["expires_at"] = time.time() + 60
s["auth_calls"] = [time.time() - 100, time.time() - 50]
c.store.set(s)
c.get_token()
assert json.load(urllib.request.urlopen(BASE + "/stats"))["refresh"] == 1
# ...and expired token -> refuse instead of getting the app blocked
s["expires_at"] = time.time() - 1
c.store.set(s)
try:
    c.get_token()
    raise AssertionError("expected guard")
except BkashError:
    pass
print("python client OK", stats)
