"""bKash PGW v2 Tokenized Checkout client — Python 3.9+, depends only on `requests`.

Docs: https://developer.bka.sh

Use a shared TokenStore (Redis / Django cache / DB) in production: bKash allows at most
2 grant/refresh calls per hour and blocks the app for an hour beyond that.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, Iterator, Optional, Protocol

import requests

SANDBOX_URL = "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout"
PRODUCTION_URL = "https://tokenized.pay.bka.sh/v2/tokenized-checkout"
_SAFE = re.compile(r"^[^<>&]*$")
_HOUR = 3600
_REFRESH_BEFORE = 480  # refresh ~minute 52
_DONE_CODES = {"2062", "2068", "2117", "2119"}


class BkashError(Exception):
    def __init__(self, message: str, code: Optional[str] = None, http_status: int = 200,
                 raw: Any = None, internal_code: Optional[str] = None):
        super().__init__(message)
        self.code = code  # externalCode / statusCode
        self.http_status = http_status
        self.raw = raw
        self.internal_code = internal_code


class BkashTimeout(Exception):
    """Status unknown — call the Query APIs before doing anything else."""


class TokenStore(Protocol):
    def get(self) -> Optional[Dict[str, Any]]: ...
    def set(self, state: Dict[str, Any]) -> None: ...
    def lock(self) -> Any: ...  # context manager


class MemoryTokenStore:
    """Single-process store (dev/tests)."""

    def __init__(self) -> None:
        self._state: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()

    def get(self):
        return self._state

    def set(self, state):
        self._state = state

    @contextmanager
    def lock(self) -> Iterator[None]:
        with self._lock:
            yield


class RedisTokenStore:
    """Shared store using redis-py (`pip install redis`)."""

    def __init__(self, redis_client: Any, key: str = "bkash:token") -> None:
        self.r = redis_client
        self.key = key

    def get(self):
        v = self.r.get(self.key)
        return json.loads(v) if v else None

    def set(self, state):
        self.r.set(self.key, json.dumps(state))

    def lock(self):
        return self.r.lock(f"{self.key}:lock", timeout=35, blocking_timeout=40)


class BkashClient:
    def __init__(self, base_url: str, username: str, password: str, app_key: str, app_secret: str,
                 store: Optional[TokenStore] = None, bearer_prefix: bool = False, timeout: int = 30,
                 session: Optional[requests.Session] = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.username, self.password = username, password
        self.app_key, self.app_secret = app_key, app_secret
        self.store: TokenStore = store or MemoryTokenStore()
        self.bearer_prefix = bearer_prefix
        self.timeout = timeout
        self.http = session or requests.Session()

    @classmethod
    def from_env(cls, store: Optional[TokenStore] = None) -> "BkashClient":
        def need(k: str) -> str:
            v = os.environ.get(k)
            if not v:
                raise RuntimeError(f"Missing env {k}")
            return v

        return cls(os.environ.get("BKASH_BASE_URL", SANDBOX_URL), need("BKASH_USERNAME"), need("BKASH_PASSWORD"),
                   need("BKASH_APP_KEY"), need("BKASH_APP_SECRET"), store,
                   os.environ.get("BKASH_BEARER_PREFIX") == "true")

    # ------------------------------------------------------------------ tokens
    def get_token(self) -> str:
        s = self.store.get()
        if s and time.time() < s["expires_at"] - _REFRESH_BEFORE:
            return s["id_token"]
        with self.store.lock():
            s = self.store.get()
            now = time.time()
            if s and now < s["expires_at"] - _REFRESH_BEFORE:
                return s["id_token"]
            recent = [t for t in (s or {}).get("auth_calls", []) if now - t < _HOUR]
            if len(recent) >= 2:
                if s and now < s["expires_at"]:
                    return s["id_token"]
                raise BkashError("Refusing grant/refresh: 2 calls already in the last hour")

            res = None
            if s and now < s.get("refresh_expires_at", 0):
                try:
                    res = self._auth("/auth/refresh-token", {"app_key": self.app_key, "app_secret": self.app_secret,
                                                             "refresh_token": s["refresh_token"]})
                    recent.append(now)
                except BkashError:
                    recent.append(now)
                    if len(recent) >= 2:
                        raise
            if res is None:
                res = self._auth("/auth/grant-token", {"app_key": self.app_key, "app_secret": self.app_secret})
                recent.append(time.time())

            state = {
                "id_token": res["id_token"],
                "refresh_token": res["refresh_token"],
                "expires_at": time.time() + int(res.get("expires_in", 3600)),
                "refresh_expires_at": time.time() + 29 * 86400,
                "auth_calls": recent,
            }
            self.store.set(state)
            return state["id_token"]

    def _auth(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        r = self._post(path, body, {"username": self.username, "password": self.password})
        if r.get("statusCode") != "0000" or not r.get("id_token"):
            raise BkashError(r.get("statusMessage", "Token request failed"), r.get("statusCode"), 200, r)
        return r

    # ------------------------------------------------------------------ transport
    def _post(self, path: str, body: Dict[str, Any], headers: Dict[str, str]) -> Dict[str, Any]:
        try:
            resp = self.http.post(self.base_url + path, json=body, timeout=self.timeout,
                                  headers={"Content-Type": "application/json", "Accept": "application/json", **headers})
        except requests.Timeout as e:
            raise BkashTimeout(f"bKash timeout on {path}") from e
        except requests.RequestException as e:
            raise BkashError(f"Network error: {e}", None, 0) from e
        try:
            data = resp.json() if resp.content else {}
        except ValueError:
            raise BkashError(f"Non-JSON response ({resp.status_code})", None, resp.status_code, resp.text)
        if resp.status_code >= 400 and "externalCode" not in data and "statusCode" not in data:
            raise BkashError(data.get("message", f"HTTP {resp.status_code}"), str(resp.status_code), resp.status_code, data)
        return data

    def _call(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        token = self.get_token()
        data = self._post(path, body, {
            "Authorization": f"Bearer {token}" if self.bearer_prefix else token,
            "X-App-Key": self.app_key,
        })
        if data.get("externalCode") or (data.get("statusCode") and data["statusCode"] != "0000"):
            raise BkashError(data.get("errorMessageEn") or data.get("statusMessage") or "bKash error",
                             data.get("externalCode") or data.get("statusCode"), 200, data, data.get("internalCode"))
        if "bKashURL" in data and "bkashURL" not in data:
            data["bkashURL"] = data["bKashURL"]
        return data

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def amount(v: Any) -> str:
        try:
            d = Decimal(str(v)).quantize(Decimal("0.01"))
        except InvalidOperation:
            raise ValueError(f"Invalid amount: {v}")
        if d <= 0:
            raise ValueError(f"Invalid amount: {v}")
        return f"{d:.2f}"

    @staticmethod
    def safe(v: str, max_len: int = 255) -> str:
        if not _SAFE.match(v) or len(v) > max_len:
            raise ValueError(f"Invalid text for bKash (no < > &, max {max_len})")
        return v

    def _payment_body(self, amount, invoice, callback_url, intent, sub_merchant_name, merchant_association_info):
        body = {"callbackURL": callback_url, "amount": self.amount(amount), "currency": "BDT",
                "intent": intent, "merchantInvoiceNumber": self.safe(invoice)}
        if sub_merchant_name:
            body["subMerchantName"] = self.safe(sub_merchant_name, 80)
        if merchant_association_info:
            body["merchantAssociationInfo"] = self.safe(merchant_association_info)
        return body

    # ------------------------------------------------------------------ agreement
    def create_agreement(self, payer_reference: str, callback_url: str):
        return self._call("/agreement/create", {"payerReference": self.safe(payer_reference), "callbackURL": callback_url})

    def execute_agreement(self, agreement_id: str):
        return self._call("/agreement/execute", {"agreementId": agreement_id})

    def cancel_agreement(self, agreement_id: str):
        return self._call("/agreement/cancel", {"agreementId": agreement_id})

    def query_agreement(self, agreement_id: str):
        return self._call("/query/agreement", {"agreementId": agreement_id})

    # ------------------------------------------------------------------ payments
    def create_payment(self, amount, invoice: str, callback_url: str, payer_reference: str, intent: str = "sale",
                       sub_merchant_name: Optional[str] = None, merchant_association_info: Optional[str] = None):
        body = self._payment_body(amount, invoice, callback_url, intent, sub_merchant_name, merchant_association_info)
        body["payerReference"] = self.safe(payer_reference)
        return self._call("/payment/create", body)

    def execute_payment(self, payment_id: str):
        return self._call("/payment/execute", {"paymentId": payment_id})

    def capture_payment(self, payment_id: str):
        return self._call("/payment/capture", {"paymentId": payment_id})

    def void_payment(self, payment_id: str):
        return self._call("/payment/void", {"paymentId": payment_id})

    def create_payment_with_agreement(self, agreement_id: str, amount, invoice: str, callback_url: str,
                                      intent: str = "sale", sub_merchant_name: Optional[str] = None,
                                      merchant_association_info: Optional[str] = None):
        body = self._payment_body(amount, invoice, callback_url, intent, sub_merchant_name, merchant_association_info)
        body["agreementId"] = agreement_id
        return self._call("/payment-with-agreement/create", body)

    def execute_payment_with_agreement(self, payment_id: str, agreement_id: str):
        return self._call("/payment-with-agreement/execute", {"paymentId": payment_id, "agreementId": agreement_id})

    def capture_payment_with_agreement(self, payment_id: str, agreement_id: str):
        return self._call("/payment-with-agreement/capture", {"paymentId": payment_id, "agreementId": agreement_id})

    def void_payment_with_agreement(self, payment_id: str, agreement_id: str):
        return self._call("/payment-with-agreement/void", {"paymentId": payment_id, "agreementId": agreement_id})

    # ------------------------------------------------------------------ query / refund
    def query_payment(self, payment_id: str):
        return self._call("/query/payment", {"paymentId": payment_id})

    def search_transaction(self, trx_id: str):
        return self._call("/general/search-transaction", {"trxId": trx_id})

    def refund(self, payment_id: str, trx_id: str, amount, sku: str, reason: str):
        return self._call("/refund/payment/transaction", {
            "paymentId": payment_id, "trxId": trx_id, "refundAmount": self.amount(amount),
            "sku": self.safe(sku), "reason": self.safe(reason)})

    def refund_status(self, payment_id: str, trx_id: str):
        return self._call("/refund/payment/status", {"paymentId": payment_id, "trxId": trx_id})

    def execute_with_recovery(self, payment_id: str, agreement_id: Optional[str] = None) -> Dict[str, Any]:
        """Execute once; on timeout/network/5xx or 'already completed', fall back to Query Payment."""
        try:
            d = (self.execute_payment_with_agreement(payment_id, agreement_id) if agreement_id
                 else self.execute_payment(payment_id))
            return {"status": d.get("transactionStatus"), "data": d}
        except BkashTimeout:
            pass
        except BkashError as e:
            unknown = e.http_status == 0 or e.http_status >= 500
            if e.code not in _DONE_CODES and not unknown:
                raise
        q = self.query_payment(payment_id)
        return {"status": q.get("transactionStatus"), "data": q}
