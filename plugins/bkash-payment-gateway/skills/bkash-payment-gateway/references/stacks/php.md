# PHP — plain PHP, Laravel, WordPress/WooCommerce (also CodeIgniter, Symfony)

Copy `templates/php/BkashClient.php` (namespace `Bkash`, PHP 8.1+, ext-curl). It contains `BkashClient`, `TokenStore`, `FileTokenStore`, `BkashException`, `BkashTimeoutException`. With Composer, split classes into PSR-4 files under `src/Bkash/` or load the file via `"autoload": {"files": [...]}`.

## Plain PHP

```php
require __DIR__ . '/BkashClient.php';
use Bkash\{BkashClient, BkashException, BkashTimeoutException};

$bkash = BkashClient::fromEnv();          // FileTokenStore by default (single server)

// create.php
$order = findOrder($_POST['order_id']);   // amount from DB
$invoice = $order['id'] . '-' . bin2hex(random_bytes(4));
$r = $bkash->createPayment($order['total'], $invoice, 'https://shop.example.com/bkash/callback.php', (string) $order['user_id']);
savePayment($order['id'], $invoice, $r['paymentId'], $r['signature'], 'INITIATED');
header('Location: ' . $r['bkashURL']);

// callback.php
$paymentId = $_GET['paymentID'] ?? '';
$p = findPaymentByPaymentId($paymentId);
if (!$p || !hash_equals((string) $p['create_signature'], (string) ($_GET['signature'] ?? ''))) { http_response_code(400); exit; }
if (($_GET['status'] ?? '') !== 'success') { markPayment($paymentId, $_GET['status'] === 'cancel' ? 'CANCELLED' : 'FAILED'); header('Location: /checkout?payment=failed'); exit; }
if (!claimPayment($paymentId)) { header('Location: /orders/' . $p['order_id']); exit; }   // UPDATE ... WHERE status='INITIATED'
$res = $bkash->executeWithRecovery($paymentId);
if ($res['status'] === 'Completed') { markPaid($paymentId, $res['data']['trxId']); header('Location: /orders/' . $p['order_id'] . '?payment=success'); }
else { markPayment($paymentId, 'FAILED'); header('Location: /checkout?payment=failed'); }
```

## Laravel (10/11/12)

`config/services.php`:
```php
'bkash' => [
    'base_url' => env('BKASH_BASE_URL', 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout'),
    'username' => env('BKASH_USERNAME'),
    'password' => env('BKASH_PASSWORD'),
    'app_key' => env('BKASH_APP_KEY'),
    'app_secret' => env('BKASH_APP_SECRET'),
    'bearer_prefix' => env('BKASH_BEARER_PREFIX', false),
],
```

Shared token store using the cache (Redis recommended) and atomic locks:
```php
namespace App\Services\Bkash;

use Bkash\TokenStore;
use Illuminate\Support\Facades\Cache;

class LaravelTokenStore implements TokenStore
{
    public function get(): ?array { return Cache::get('bkash:token'); }
    public function set(array $state): void { Cache::forever('bkash:token', $state); }
    public function withLock(callable $fn): mixed { return Cache::lock('bkash:token:lock', 35)->block(40, $fn); }
}
```

`AppServiceProvider::register()`:
```php
$this->app->singleton(\Bkash\BkashClient::class, fn () => new \Bkash\BkashClient(
    config('services.bkash.base_url'), config('services.bkash.username'), config('services.bkash.password'),
    config('services.bkash.app_key'), config('services.bkash.app_secret'),
    new \App\Services\Bkash\LaravelTokenStore(), (bool) config('services.bkash.bearer_prefix'),
));
```

Migration:
```php
Schema::create('bkash_payments', function (Blueprint $t) {
    $t->id();
    $t->foreignId('order_id')->constrained();
    $t->string('invoice_number')->unique();
    $t->string('payment_id')->nullable()->unique();
    $t->string('agreement_id')->nullable();
    $t->string('intent', 16)->default('sale');
    $t->decimal('amount', 12, 2);
    $t->string('status', 32)->index();
    $t->string('create_signature', 64)->nullable();
    $t->string('trx_id', 32)->nullable();
    $t->string('error_code', 16)->nullable();
    $t->text('error_message')->nullable();
    $t->json('raw')->nullable();
    $t->timestamps();
});
```

Routes (`routes/web.php`):
```php
Route::middleware('auth')->post('/payments/bkash', [BkashController::class, 'create'])->name('bkash.create');
Route::get('/payments/bkash/callback', [BkashController::class, 'callback'])->name('bkash.callback');
Route::post('/webhooks/bkash', BkashWebhookController::class);   // exclude from CSRF
```
Exclude the webhook from CSRF: Laravel 11+ `->withMiddleware(fn ($m) => $m->validateCsrfTokens(except: ['webhooks/bkash']))` in `bootstrap/app.php`; Laravel 10 `$except` in `VerifyCsrfToken`.

Controller:
```php
class BkashController extends Controller
{
    public function __construct(private \Bkash\BkashClient $bkash) {}

    public function create(Request $request)
    {
        $order = $request->user()->orders()->where('status', 'pending')->findOrFail($request->integer('order_id'));
        $invoice = $order->id . '-' . Str::random(8);
        try {
            $r = $this->bkash->createPayment($order->total, $invoice, route('bkash.callback'), (string) $request->user()->id);
        } catch (\Bkash\BkashException $e) {
            return back()->withErrors(['bkash' => $e->getMessage()]);
        }
        BkashPayment::create(['order_id' => $order->id, 'invoice_number' => $invoice, 'payment_id' => $r['paymentId'],
            'amount' => $order->total, 'status' => 'INITIATED', 'create_signature' => $r['signature'], 'raw' => $r]);
        return redirect()->away($r['bkashURL']);
    }

    public function callback(Request $request)
    {
        $p = BkashPayment::where('payment_id', $request->query('paymentID'))->firstOrFail();
        if ($p->status === 'COMPLETED') return redirect()->route('orders.show', $p->order_id);
        abort_unless(hash_equals((string) $p->create_signature, (string) $request->query('signature')), 400);

        if ($request->query('status') !== 'success') {
            BkashPayment::whereKey($p->id)->where('status', 'INITIATED')
                ->update(['status' => $request->query('status') === 'cancel' ? 'CANCELLED' : 'FAILED']);
            return redirect()->route('checkout')->with('error', 'bKash payment was not completed.');
        }
        $claimed = BkashPayment::whereKey($p->id)->where('status', 'INITIATED')->update(['status' => 'PENDING_VERIFICATION']);
        if (!$claimed) return redirect()->route('orders.show', $p->order_id);

        try {
            $res = $this->bkash->executeWithRecovery($p->payment_id, $p->agreement_id);
        } catch (\Bkash\BkashException $e) {
            $p->update(['status' => 'FAILED', 'error_code' => $e->bkashCode, 'error_message' => $e->getMessage()]);
            return redirect()->route('checkout')->with('error', $e->getMessage());
        } catch (\Bkash\BkashTimeoutException) {
            return redirect()->route('orders.show', $p->order_id)->with('info', 'Verifying your payment...');
        }
        if ($res['status'] === 'Completed') {
            DB::transaction(function () use ($p, $res) {
                $p->update(['status' => 'COMPLETED', 'trx_id' => $res['data']['trxId'] ?? null]);
                $p->order()->update(['status' => 'paid']);
            });
            return redirect()->route('orders.show', $p->order_id)->with('success', 'Payment successful');
        }
        $p->update(['status' => 'FAILED']);
        return redirect()->route('checkout')->with('error', 'bKash payment failed.');
    }
}
```

Recovery job — `routes/console.php` (Laravel 11+) or `Kernel::schedule`:
```php
Schedule::call(function (\Bkash\BkashClient $bkash) {
    BkashPayment::whereIn('status', ['INITIATED', 'PENDING_VERIFICATION'])
        ->where('created_at', '<', now()->subMinutes(15))->each(function ($p) use ($bkash) {
            try {
                $q = $bkash->queryPayment($p->payment_id);
                if (($q['transactionStatus'] ?? null) === 'Completed') { /* mark paid */ }
                elseif ($p->created_at->lt(now()->subDay())) { $p->update(['status' => 'EXPIRED']); }
            } catch (\Throwable $e) { report($e); }
        });
})->everyTenMinutes();
```

Webhook: install `aws/aws-php-sns-message-validator`:
```php
use Aws\Sns\{Message, MessageValidator};
class BkashWebhookController {
    public function __invoke(Request $r) {
        $m = Message::fromRawPostData();            // reads php://input
        (new MessageValidator())->validate($m);     // throws on invalid signature
        if ($m['Type'] === 'SubscriptionConfirmation') { Http::get($m['SubscribeURL']); return response('', 200); }
        if ($m['Type'] === 'Notification') {
            $evt = is_string($m['Message']) ? json_decode($m['Message'], true) : $m['Message'];
            ProcessBkashIpn::dispatch($evt);        // dedupe by trxID in the job
        }
        return response('', 200);
    }
}
```

## WordPress / WooCommerce

Create a plugin with a `WC_Payment_Gateway` subclass:
- `id = 'bkash_tokenized'`, settings fields for sandbox toggle + credentials (stored in `wp_options`; never output to the page).
- Token store: implement `TokenStore` with `get_transient`/`set_transient` and a lock via `wp_cache_add` or a `GET_LOCK()` MySQL query.
- `process_payment($order_id)`: create payment with `$order->get_total()`, invoice `$order->get_order_number().'-'.wp_generate_password(6,false)`, callback `WC()->api_request_url('bkash_callback')`; save `paymentId`/`signature` with `$order->update_meta_data()`; return `['result' => 'success', 'redirect' => $r['bkashURL']]`.
- `add_action('woocommerce_api_bkash_callback', ...)`: validate signature vs order meta, Execute with recovery, then `$order->payment_complete($trxId)` or `$order->update_status('failed', $msg)`; redirect to `$this->get_return_url($order)`.
- `process_refund($order_id, $amount, $reason)`: call `refund()` with stored paymentId/trxId; return `true` or `WP_Error`. Set `$this->supports = ['products', 'refunds']`.
- Declare HPOS compatibility (`FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true)`) and, for block checkout, register an `AbstractPaymentMethodType`.

## CodeIgniter / Symfony

Register `BkashClient` as a service (Symfony: `services.yaml` with `%env(BKASH_...)%`; token store via `symfony/lock` + cache pool). Controllers follow the Laravel example.
