# Java/Spring Boot, .NET, Go, Ruby on Rails

All four follow the same shape: config from env → client singleton with a shared token store → create endpoint → callback endpoint (validate, claim, execute-with-recovery, mark paid) → optional refund/capture/void → IPN → recovery job. Business logic is identical to `references/flows.md`; only wiring differs.

## Java — Spring Boot 3

Client: `templates/java/BkashClient.java` (needs `com.fasterxml.jackson.core:jackson-databind`, included in `spring-boot-starter-web`).

```java
@Configuration
class BkashConfig {
  @Bean BkashClient bkashClient(RedissonClient redisson, ObjectMapper om) {
    return BkashClient.fromEnv(new RedisTokenStore(redisson, om));
  }
}

class RedisTokenStore implements BkashClient.TokenStore {
  private final RBucket<String> bucket; private final RLock lock; private final ObjectMapper om;
  RedisTokenStore(RedissonClient r, ObjectMapper om) { this.bucket = r.getBucket("bkash:token"); this.lock = r.getLock("bkash:token:lock"); this.om = om; }
  public BkashClient.TokenState get() { try { String v = bucket.get(); return v == null ? null : om.readValue(v, BkashClient.TokenState.class); } catch (Exception e) { throw new IllegalStateException(e); } }
  public void set(BkashClient.TokenState s) { try { bucket.set(om.writeValueAsString(s)); } catch (Exception e) { throw new IllegalStateException(e); } }
  public <T> T withLock(Callable<T> fn) throws Exception { lock.lock(35, TimeUnit.SECONDS); try { return fn.call(); } finally { lock.unlock(); } }
}

@Controller
@RequiredArgsConstructor
class BkashController {
  private final BkashClient bkash; private final PaymentRepo payments; private final OrderService orders;

  @PostMapping("/payments/bkash")
  String create(@RequestParam long orderId, Principal user) {
    Order o = orders.payableFor(orderId, user.getName());
    String invoice = o.getId() + "-" + UUID.randomUUID().toString().substring(0, 8);
    Map<String, Object> r = bkash.createPayment(o.getTotal(), invoice, appUrl + "/payments/bkash/callback", user.getName(), null, "sale", null, null);
    payments.save(BkashPayment.initiated(o, invoice, (String) r.get("paymentId"), (String) r.get("signature")));
    return "redirect:" + r.get("bkashURL");
  }

  @GetMapping("/payments/bkash/callback")
  @Transactional
  String callback(@RequestParam("paymentID") String paymentId, @RequestParam String status, @RequestParam(defaultValue = "") String signature) {
    BkashPayment p = payments.findByPaymentId(paymentId).orElseThrow();
    if (!MessageDigest.isEqual(p.getCreateSignature().getBytes(), signature.getBytes())) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
    if (!"success".equals(status)) { payments.transition(paymentId, "INITIATED", "cancel".equals(status) ? "CANCELLED" : "FAILED"); return "redirect:/checkout"; }
    if (payments.transition(paymentId, "INITIATED", "PENDING_VERIFICATION") == 0) return "redirect:/orders/" + p.getOrderId();
    Map<String, Object> res = bkash.executeWithRecovery(paymentId, p.getAgreementId());
    if ("Completed".equals(res.get("transactionStatus"))) { payments.markCompleted(paymentId, (String) res.get("trxId")); orders.markPaid(p.getOrderId()); }
    else payments.transition(paymentId, "PENDING_VERIFICATION", "FAILED");
    return "redirect:/orders/" + p.getOrderId();
  }
}
```
`transition` = `@Modifying @Query("update BkashPayment p set p.status=:to where p.paymentId=:id and p.status=:from")`. Recovery job: `@Scheduled(fixedDelay = 600_000)`. IPN: `software.amazon.awssdk:sns` `SnsMessageManager.parseMessage(InputStream)` validates the signature.

## .NET — ASP.NET Core 8 minimal API

Client: `templates/csharp/BkashClient.cs`.

```csharp
builder.Services.Configure<BkashOptions>(builder.Configuration.GetSection("Bkash"));
builder.Services.AddSingleton<IBkashTokenStore, RedisBkashTokenStore>();   // StackExchange.Redis + LockTakeAsync
builder.Services.AddHttpClient<BkashClient>((sp, http) => { })
    .AddTypedClient((http, sp) => new BkashClient(http, sp.GetRequiredService<IOptions<BkashOptions>>().Value, sp.GetRequiredService<IBkashTokenStore>()));

app.MapPost("/payments/bkash", async (CreateReq req, BkashClient bkash, AppDb db, ClaimsPrincipal user) => {
    var order = await db.Orders.SingleAsync(o => o.Id == req.OrderId && o.UserId == user.Id() && o.Status == "pending");
    var invoice = $"{order.Id}-{Guid.NewGuid():N}"[..20];
    var r = await bkash.CreatePaymentAsync(order.Total, invoice, $"{appUrl}/payments/bkash/callback", payerReference: user.Id());
    db.BkashPayments.Add(new() { OrderId = order.Id, Invoice = invoice, PaymentId = r["paymentId"]!.ToString(), Signature = r["signature"]?.ToString(), Status = "INITIATED", Amount = order.Total });
    await db.SaveChangesAsync();
    return Results.Ok(new { redirectUrl = r["bkashURL"]!.ToString() });
}).RequireAuthorization();

app.MapGet("/payments/bkash/callback", async (string paymentID, string status, string? signature, BkashClient bkash, AppDb db) => {
    var p = await db.BkashPayments.SingleOrDefaultAsync(x => x.PaymentId == paymentID);
    if (p is null || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(p.Signature ?? ""), Encoding.UTF8.GetBytes(signature ?? ""))) return Results.BadRequest();
    if (status != "success") { /* mark CANCELLED/FAILED where INITIATED */ return Results.Redirect("/checkout"); }
    var claimed = await db.BkashPayments.Where(x => x.Id == p.Id && x.Status == "INITIATED").ExecuteUpdateAsync(s => s.SetProperty(x => x.Status, "PENDING_VERIFICATION"));
    if (claimed == 0) return Results.Redirect($"/orders/{p.OrderId}");
    var res = await bkash.ExecuteWithRecoveryAsync(paymentID, p.AgreementId);
    /* Completed → mark paid in a transaction */
    return Results.Redirect($"/orders/{p.OrderId}");
});
```
IPN: `AWSSDK.SimpleNotificationService` → `Amazon.SimpleNotificationService.Util.Message.ParseMessage(body).IsMessageSignatureValid()`. Recovery: `BackgroundService` or Hangfire recurring job.

## Go — net/http / chi / gin / echo

Client: `templates/go/bkash.go` (package `bkash`, stdlib only).

```go
client := bkash.FromEnv(redisStore) // implement TokenStore with go-redis: Get/Set JSON, WithLock via SET NX PX + Lua unlock

http.HandleFunc("POST /payments/bkash", func(w http.ResponseWriter, r *http.Request) {
    order := mustPayableOrder(r)                           // amount from DB
    invoice := fmt.Sprintf("%d-%s", order.ID, randHex(4))
    res, err := client.CreatePayment(r.Context(), bkash.PaymentRequest{
        Amount: order.Total.StringFixed(2), MerchantInvoiceNumber: invoice,
        CallbackURL: appURL + "/payments/bkash/callback", PayerReference: strconv.FormatInt(order.UserID, 10),
    })
    if err != nil { http.Error(w, err.Error(), http.StatusBadRequest); return }
    savePayment(order.ID, invoice, res["paymentId"].(string), fmt.Sprint(res["signature"]))
    http.Redirect(w, r, res["bkashURL"].(string), http.StatusSeeOther)
})

http.HandleFunc("GET /payments/bkash/callback", func(w http.ResponseWriter, r *http.Request) {
    q := r.URL.Query()
    p, ok := findPayment(q.Get("paymentID"))
    if !ok || subtle.ConstantTimeCompare([]byte(p.Signature), []byte(q.Get("signature"))) != 1 { http.Error(w, "bad callback", 400); return }
    if q.Get("status") != "success" { markFailedOrCancelled(p, q.Get("status")); http.Redirect(w, r, "/checkout", 303); return }
    if !claim(p.PaymentID) { http.Redirect(w, r, "/orders/"+p.OrderID, 303); return }
    status, data, err := client.ExecuteWithRecovery(r.Context(), p.PaymentID, p.AgreementID)
    if err == nil && status == "Completed" { markPaid(p, fmt.Sprint(data["trxId"])) } else { markFailed(p, err) }
    http.Redirect(w, r, "/orders/"+p.OrderID, 303)
})
```
Use `context.WithTimeout(ctx, 30*time.Second)` per call if your router doesn't set deadlines. IPN: verify per `references/webhook-ipn.md` with `crypto/x509` + `crypto/rsa` (SHA1 for SignatureVersion 1).

## Ruby on Rails 7

Client: `templates/ruby/bkash_client.rb` → `app/services/bkash_client.rb` (or `lib/bkash`). Use `Bkash::RailsCacheTokenStore` with a Redis cache store.

```ruby
# config/initializers/bkash.rb
BKASH = Bkash::Client.from_env(store: Bkash::RailsCacheTokenStore.new)

# config/routes.rb
post "payments/bkash", to: "bkash#create"
get  "payments/bkash/callback", to: "bkash#callback", as: :bkash_callback
post "webhooks/bkash", to: "bkash_webhooks#create"

# app/controllers/bkash_controller.rb
class BkashController < ApplicationController
  before_action :authenticate_user!, only: :create

  def create
    order = current_user.orders.pending.find(params[:order_id])
    invoice = "#{order.id}-#{SecureRandom.hex(4)}"
    r = BKASH.create_payment(amount: order.total, invoice: invoice, callback_url: bkash_callback_url, payer_reference: current_user.id.to_s)
    BkashPayment.create!(order: order, invoice_number: invoice, payment_id: r["paymentId"], amount: order.total,
                         status: "INITIATED", create_signature: r["signature"], raw: r)
    redirect_to r["bkashURL"], allow_other_host: true
  rescue Bkash::Error => e
    redirect_to checkout_path, alert: e.message
  end

  def callback
    p = BkashPayment.find_by!(payment_id: params[:paymentID])
    return head :bad_request unless ActiveSupport::SecurityUtils.secure_compare(p.create_signature.to_s, params[:signature].to_s)
    return redirect_to(order_path(p.order_id)) if p.status == "COMPLETED"
    unless params[:status] == "success"
      BkashPayment.where(id: p.id, status: "INITIATED").update_all(status: params[:status] == "cancel" ? "CANCELLED" : "FAILED")
      return redirect_to checkout_path, alert: "bKash payment not completed"
    end
    return redirect_to(order_path(p.order_id)) if BkashPayment.where(id: p.id, status: "INITIATED").update_all(status: "PENDING_VERIFICATION").zero?

    res = BKASH.execute_with_recovery(p.payment_id, p.agreement_id)
    if res["transactionStatus"] == "Completed"
      ActiveRecord::Base.transaction do
        p.update!(status: "COMPLETED", trx_id: res["trxId"])
        p.order.update!(status: "paid")
      end
      redirect_to order_path(p.order_id), notice: "Payment successful"
    else
      p.update!(status: "FAILED")
      redirect_to checkout_path, alert: "bKash payment failed"
    end
  rescue Bkash::TimeoutError
    redirect_to order_path(p.order_id), notice: "Verifying your payment…"
  rescue Bkash::Error => e
    p&.update(status: "FAILED", error_code: e.code, error_message: e.message)
    redirect_to checkout_path, alert: e.message
  end
end
```
Webhook: `skip_forgery_protection`, `Aws::SNS::MessageVerifier.new.authentic?(request.raw_post)`. Recovery: Sidekiq-cron / GoodJob cron every 10 min.
