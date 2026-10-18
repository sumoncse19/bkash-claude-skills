"""Tiny mock of the bKash v2 tokenized-checkout API for template tests (no real money, no network).

Run: python3 tests/mock_bkash_server.py 8765
Base URL for clients: http://127.0.0.1:8765/v2/tokenized-checkout
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "/v2/tokenized-checkout"
STATE = {"grant": 0, "refresh": 0, "executed": set(), "counter": 0}
TOKEN = "mock-id-token"
APP_KEY = "test_app_key"


def err(code, msg, internal="mock_error"):
    return 200, {"internalCode": internal, "externalCode": code, "errorMessageEn": msg, "errorMessageBn": None}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/stats":
            return self._send(200, {"grant": STATE["grant"], "refresh": STATE["refresh"]})
        self._send(404, {})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        path = self.path[len(PREFIX):] if self.path.startswith(PREFIX) else self.path
        self._send(*self.route(path, body))

    def route(self, path, b):
        if path == "/auth/grant-token":
            if self.headers.get("username") != "user" or self.headers.get("password") != "pass":
                return 200, {"statusCode": "9999", "statusMessage": "Invalid or unrecognized access credentials"}
            STATE["grant"] += 1
            return 200, {"statusCode": "0000", "statusMessage": "Successful", "token_type": "Bearer",
                         "id_token": TOKEN, "refresh_token": "mock-refresh", "expires_in": 3600}
        if path == "/auth/refresh-token":
            STATE["refresh"] += 1
            return 200, {"statusCode": "0000", "statusMessage": "Successful", "token_type": "Bearer",
                         "id_token": TOKEN, "refresh_token": "mock-refresh-2", "expires_in": 3600}

        if self.headers.get("Authorization") not in (TOKEN, "Bearer " + TOKEN) or self.headers.get("X-App-Key") != APP_KEY:
            return err("2079", "Invalid app Token")

        if path in ("/payment/create", "/payment-with-agreement/create"):
            if b.get("amount") == "999.99":
                return err("2006", "Invalid amount.", "invalid_amount")
            for k in ("callbackURL", "amount", "currency", "intent", "merchantInvoiceNumber"):
                if k not in b:
                    return err("2065", "Mandatory field missing")
            STATE["counter"] += 1
            pid = f"TR00{STATE['counter']:04d}{'X' if b['amount'] == '503.00' else ''}"
            cb = b["callbackURL"]
            return 200, {"paymentId": pid, "bkashURL": f"https://sandbox.payment.bkash.com/?paymentId={pid}",
                         "callbackURL": cb, "successCallbackURL": f"{cb}?paymentID={pid}&status=success&signature=sig{pid}",
                         "amount": b["amount"], "intent": b["intent"], "currency": "BDT",
                         "transactionStatus": "Initiated", "merchantInvoiceNumber": b["merchantInvoiceNumber"],
                         "signature": f"sig{pid}"}
        if path in ("/payment/execute", "/payment-with-agreement/execute"):
            pid = b["paymentId"]
            if pid.endswith("X"):
                STATE["executed"].add(pid)
                return 503, {"message": "Service Unavailable"}
            if pid in STATE["executed"]:
                return err("2062", "The payment has already been completed", "payment_already_completed")
            STATE["executed"].add(pid)
            return 200, {"paymentId": pid, "trxId": "TRX" + pid[-4:], "transactionStatus": "Completed",
                         "amount": "100.00", "currency": "BDT", "intent": "sale", "maxRefundableAmount": "100.00"}
        if path == "/query/payment":
            pid = b["paymentId"]
            st = "Completed" if pid in STATE["executed"] else "Initiated"
            return 200, {"paymentId": pid, "transactionStatus": st, "trxId": "TRX" + pid[-4:], "verificationStatus": "Complete"}
        if path == "/refund/payment/transaction":
            return 200, {"originalTrxId": b["trxId"], "refundTrxId": "RFD1", "refundTransactionStatus": "Completed",
                         "refundAmount": b["refundAmount"], "currency": "BDT", "sku": b["sku"], "reason": b["reason"]}
        if path == "/refund/payment/status":
            return 200, {"originalTrxId": b["trxId"], "refundTransactions": []}
        if path == "/agreement/create":
            return 200, {"paymentId": "TRA1", "agreementId": "AGR1", "bkashURL": "https://x/?a=1", "agreementStatus": "Initiated", "signature": "s"}
        if path in ("/agreement/execute", "/agreement/cancel", "/query/agreement"):
            return 200, {"agreementId": b["agreementId"], "agreementStatus": "Cancelled" if "cancel" in path else "Completed"}
        if path in ("/payment/capture", "/payment-with-agreement/capture"):
            return 200, {"paymentId": b["paymentId"], "trxId": "T", "transactionStatus": "Completed"}
        if path in ("/payment/void", "/payment-with-agreement/void"):
            return 200, {"paymentId": b["paymentId"], "trxId": "T", "transactionStatus": "Cancelled"}
        if path == "/general/search-transaction":
            return 200, {"trxId": b["trxId"], "transactionStatus": "Completed"}
        return 404, {"message": "not found"}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
