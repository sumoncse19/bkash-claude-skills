# Python — Django, FastAPI, Flask

Copy `templates/python/bkash_client.py` (`pip install requests`, plus `redis` for `RedisTokenStore`). Exposes `BkashClient`, `BkashError`, `BkashTimeout`, `MemoryTokenStore`, `RedisTokenStore`.

## Django

`settings.py`: read `BKASH_*` from env (django-environ). Token store backed by the Django cache (use Redis cache backend in production):

```python
# payments/bkash.py
from django.core.cache import cache
from django_redis import get_redis_connection          # if using django-redis
from .bkash_client import BkashClient, RedisTokenStore

bkash = BkashClient.from_env(RedisTokenStore(get_redis_connection("default")))
```

Model:
```python
class BkashPayment(models.Model):
    class Status(models.TextChoices):
        INITIATED = "INITIATED"; PENDING = "PENDING_VERIFICATION"; COMPLETED = "COMPLETED"
        AUTHORIZED = "AUTHORIZED"; FAILED = "FAILED"; CANCELLED = "CANCELLED"; EXPIRED = "EXPIRED"
    order = models.ForeignKey("shop.Order", on_delete=models.PROTECT, related_name="bkash_payments")
    invoice_number = models.CharField(max_length=255, unique=True)
    payment_id = models.CharField(max_length=64, unique=True, null=True)
    agreement_id = models.CharField(max_length=64, null=True, blank=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(max_length=32, choices=Status.choices, db_index=True)
    create_signature = models.CharField(max_length=64, blank=True)
    trx_id = models.CharField(max_length=32, blank=True)
    error_code = models.CharField(max_length=16, blank=True)
    error_message = models.TextField(blank=True)
    raw = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

Views:
```python
import secrets
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.http import HttpResponseBadRequest
from django.shortcuts import get_object_or_404, redirect
from django.urls import reverse
from django.views.decorators.http import require_GET, require_POST
from .bkash import bkash
from .bkash_client import BkashError, BkashTimeout

@login_required
@require_POST
def bkash_create(request):
    order = get_object_or_404(Order, pk=request.POST["order_id"], user=request.user, status="pending")
    invoice = f"{order.pk}-{secrets.token_hex(4)}"
    try:
        r = bkash.create_payment(order.total, invoice, request.build_absolute_uri(reverse("bkash-callback")),
                                 payer_reference=str(request.user.pk))
    except BkashError as e:
        messages.error(request, str(e)); return redirect("checkout")
    BkashPayment.objects.create(order=order, invoice_number=invoice, payment_id=r["paymentId"], amount=order.total,
                                status="INITIATED", create_signature=r.get("signature", ""), raw={"create": r})
    return redirect(r["bkashURL"])

@require_GET
def bkash_callback(request):
    pid, status, sig = request.GET.get("paymentID"), request.GET.get("status"), request.GET.get("signature", "")
    p = BkashPayment.objects.filter(payment_id=pid).first()
    if not p or not secrets.compare_digest(p.create_signature, sig):
        return HttpResponseBadRequest("Invalid callback")
    if p.status == "COMPLETED":
        return redirect("order-detail", p.order_id)
    if status != "success":
        BkashPayment.objects.filter(pk=p.pk, status="INITIATED").update(status="CANCELLED" if status == "cancel" else "FAILED")
        return redirect("checkout")
    if not BkashPayment.objects.filter(pk=p.pk, status="INITIATED").update(status="PENDING_VERIFICATION"):
        return redirect("order-detail", p.order_id)
    try:
        res = bkash.execute_with_recovery(p.payment_id, p.agreement_id)
    except BkashTimeout:
        return redirect("order-detail", p.order_id)          # recovery task will finish it
    except BkashError as e:
        BkashPayment.objects.filter(pk=p.pk).update(status="FAILED", error_code=e.code or "", error_message=str(e))
        return redirect("checkout")
    if res["status"] == "Completed":
        with transaction.atomic():
            BkashPayment.objects.filter(pk=p.pk).update(status="COMPLETED", trx_id=res["data"].get("trxId", ""))
            Order.objects.filter(pk=p.order_id).update(status="paid")
        return redirect("order-detail", p.order_id)
    BkashPayment.objects.filter(pk=p.pk).update(status="FAILED")
    return redirect("checkout")
```

URLs: `path("payments/bkash/", bkash_create)`, `path("payments/bkash/callback/", bkash_callback, name="bkash-callback")`, `path("webhooks/bkash/", csrf_exempt(bkash_ipn))`.

Recovery: Celery beat task every 10 min doing Query Payment on `INITIATED`/`PENDING_VERIFICATION` rows older than 15 min (see `references/flows.md`).

Webhook: read `request.body.decode()`, verify with `sns-message-validator` (`pip install sns-message-validator`) or manual `cryptography` verification per `references/webhook-ipn.md`.

## FastAPI

```python
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from starlette.concurrency import run_in_threadpool
import redis
from bkash_client import BkashClient, RedisTokenStore, BkashError

app = FastAPI()
bkash = BkashClient.from_env(RedisTokenStore(redis.Redis.from_url(os.environ["REDIS_URL"])))

@app.post("/payments/bkash")
async def create(body: CreateIn, user=Depends(current_user)):
    order = await orders.get_payable(body.order_id, user.id)
    invoice = f"{order.id}-{secrets.token_hex(4)}"
    try:
        r = await run_in_threadpool(bkash.create_payment, order.total, invoice, f"{APP_URL}/payments/bkash/callback", str(user.id))
    except BkashError as e:
        raise HTTPException(400, detail={"code": e.code, "message": str(e)})
    await payments.insert(order.id, invoice, r["paymentId"], r.get("signature"), order.total)
    return {"redirectUrl": r["bkashURL"]}

@app.get("/payments/bkash/callback")
async def callback(paymentID: str, status: str, signature: str = ""):
    ...  # same logic as the Django view; wrap blocking client calls in run_in_threadpool
    return RedirectResponse(f"/orders/{order_id}?payment=success", status_code=303)
```
(The client uses `requests` — call it via `run_in_threadpool`, or port `_post` to `httpx.AsyncClient` for a fully async version.)

## Flask

Same as Django: create a module-level `bkash = BkashClient.from_env(RedisTokenStore(...))`, a `POST /payments/bkash` view that `redirect(r["bkashURL"])`, and a `GET /payments/bkash/callback` view with the claim → execute → mark-paid logic. Use Flask-WTF CSRF exemption for the webhook route.
