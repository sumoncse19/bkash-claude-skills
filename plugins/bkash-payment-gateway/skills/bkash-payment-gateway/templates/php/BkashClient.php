<?php
declare(strict_types=1);

/**
 * bKash PGW v2 Tokenized Checkout client — PHP 8.1+, ext-curl, ext-json, no framework.
 * Docs: https://developer.bka.sh
 *
 * Laravel: bind BkashClient in a service provider with LaravelTokenStore (see references/stacks/php.md).
 */

namespace Bkash;

class BkashException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly ?string $bkashCode = null,   // externalCode / statusCode
        public readonly int $httpStatus = 200,
        public readonly array $raw = [],
        public readonly ?string $internalCode = null,
    ) {
        parent::__construct($message);
    }
}

class BkashTimeoutException extends \RuntimeException {}

interface TokenStore
{
    public function get(): ?array;           // ['id_token','refresh_token','expires_at','refresh_expires_at','auth_calls'=>[]]
    public function set(array $state): void;
    /** @template T @param callable():T $fn @return T */
    public function withLock(callable $fn): mixed;
}

/** File-based store with flock — works for single-server deployments. */
class FileTokenStore implements TokenStore
{
    public function __construct(private string $path = '') {
        $this->path = $path ?: sys_get_temp_dir() . '/bkash_token.json';
    }
    public function get(): ?array {
        if (!is_file($this->path)) return null;
        $d = json_decode((string) file_get_contents($this->path), true);
        return is_array($d) ? $d : null;
    }
    public function set(array $state): void {
        file_put_contents($this->path, json_encode($state), LOCK_EX);
        @chmod($this->path, 0600);
    }
    public function withLock(callable $fn): mixed {
        $h = fopen($this->path . '.lock', 'c');
        flock($h, LOCK_EX);
        try { return $fn(); } finally { flock($h, LOCK_UN); fclose($h); }
    }
}

final class BkashClient
{
    private const HOUR = 3600;
    private const REFRESH_BEFORE = 480; // refresh ~minute 52
    private const SAFE = '/^[^<>&]*$/';

    private TokenStore $store;

    public function __construct(
        private string $baseUrl,
        private string $username,
        private string $password,
        private string $appKey,
        private string $appSecret,
        ?TokenStore $store = null,
        private bool $bearerPrefix = false,
        private int $timeout = 30,
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->store = $store ?? new FileTokenStore();
    }

    public static function fromEnv(?TokenStore $store = null): self
    {
        $e = static fn(string $k) => getenv($k) ?: ($_ENV[$k] ?? throw new \RuntimeException("Missing env $k"));
        return new self(
            getenv('BKASH_BASE_URL') ?: 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout',
            $e('BKASH_USERNAME'), $e('BKASH_PASSWORD'), $e('BKASH_APP_KEY'), $e('BKASH_APP_SECRET'),
            $store, getenv('BKASH_BEARER_PREFIX') === 'true',
        );
    }

    // ------------------------------------------------------------ tokens
    public function getToken(): string
    {
        $s = $this->store->get();
        if ($s && time() < $s['expires_at'] - self::REFRESH_BEFORE) return $s['id_token'];

        return $this->store->withLock(function (): string {
            $s = $this->store->get();
            $now = time();
            if ($s && $now < $s['expires_at'] - self::REFRESH_BEFORE) return $s['id_token'];

            $recent = array_values(array_filter($s['auth_calls'] ?? [], fn($t) => $now - $t < self::HOUR));
            if (count($recent) >= 2) {
                if ($s && $now < $s['expires_at']) return $s['id_token'];
                throw new BkashException('Refusing grant/refresh: 2 calls already in the last hour (bKash would block for 1h)');
            }

            $res = null;
            if ($s && $now < ($s['refresh_expires_at'] ?? 0)) {
                try {
                    $res = $this->authCall('/auth/refresh-token', [
                        'app_key' => $this->appKey, 'app_secret' => $this->appSecret, 'refresh_token' => $s['refresh_token'],
                    ]);
                } catch (BkashException $e) {
                    $recent[] = $now;
                    if (count($recent) >= 2) throw $e;
                }
                if ($res) $recent[] = $now;
            }
            if (!$res) {
                $res = $this->authCall('/auth/grant-token', ['app_key' => $this->appKey, 'app_secret' => $this->appSecret]);
                $recent[] = time();
            }
            $state = [
                'id_token' => $res['id_token'],
                'refresh_token' => $res['refresh_token'],
                'expires_at' => time() + (int) ($res['expires_in'] ?? 3600),
                'refresh_expires_at' => time() + 29 * 86400,
                'auth_calls' => $recent,
            ];
            $this->store->set($state);
            return $state['id_token'];
        });
    }

    private function authCall(string $path, array $body): array
    {
        $r = $this->http($path, $body, ['username: ' . $this->username, 'password: ' . $this->password]);
        if (($r['statusCode'] ?? null) !== '0000' || empty($r['id_token'])) {
            throw new BkashException($r['statusMessage'] ?? 'Token request failed', $r['statusCode'] ?? null, 200, $r);
        }
        return $r;
    }

    // ------------------------------------------------------------ transport
    private function http(string $path, array $body, array $headers): array
    {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_SSLVERSION => CURL_SSLVERSION_TLSv1_2,
            CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json', 'Accept: application/json'], $headers),
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES),
        ]);
        $raw = curl_exec($ch);
        $errno = curl_errno($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($errno === CURLE_OPERATION_TIMEDOUT) throw new BkashTimeoutException("bKash timeout on $path — status unknown, use Query APIs");
        if ($raw === false) throw new BkashException("Network error: $err", null, 0);

        $json = json_decode((string) $raw, true);
        if (!is_array($json)) throw new BkashException("Non-JSON response ($status)", null, $status, ['body' => $raw]);
        if ($status >= 400 && !isset($json['externalCode']) && !isset($json['statusCode'])) {
            throw new BkashException($json['message'] ?? "HTTP $status", (string) $status, $status, $json);
        }
        return $json;
    }

    private function call(string $path, array $body): array
    {
        $token = $this->getToken();
        $json = $this->http($path, $body, [
            'Authorization: ' . ($this->bearerPrefix ? 'Bearer ' : '') . $token,
            'X-App-Key: ' . $this->appKey,
        ]);
        if (isset($json['externalCode']) || (isset($json['statusCode']) && $json['statusCode'] !== '0000')) {
            throw new BkashException(
                $json['errorMessageEn'] ?? $json['statusMessage'] ?? 'bKash error',
                $json['externalCode'] ?? $json['statusCode'], 200, $json, $json['internalCode'] ?? null,
            );
        }
        if (isset($json['bKashURL']) && !isset($json['bkashURL'])) $json['bkashURL'] = $json['bKashURL'];
        return $json;
    }

    // ------------------------------------------------------------ helpers
    public static function amount(string|int|float $v): string
    {
        $s = is_string($v) ? trim($v) : number_format((float) $v, 2, '.', '');
        if (!preg_match('/^\d+(\.\d{1,2})?$/', $s) || (float) $s <= 0) throw new \InvalidArgumentException("Invalid amount: $v");
        return $s;
    }
    public static function safe(string $v, int $max = 255): string
    {
        if (!preg_match(self::SAFE, $v) || mb_strlen($v) > $max) throw new \InvalidArgumentException("Invalid text (no < > &, max $max)");
        return $v;
    }

    // ------------------------------------------------------------ agreement
    public function createAgreement(string $payerReference, string $callbackURL): array
    { return $this->call('/agreement/create', ['payerReference' => self::safe($payerReference), 'callbackURL' => $callbackURL]); }
    public function executeAgreement(string $agreementId): array { return $this->call('/agreement/execute', ['agreementId' => $agreementId]); }
    public function cancelAgreement(string $agreementId): array { return $this->call('/agreement/cancel', ['agreementId' => $agreementId]); }
    public function queryAgreement(string $agreementId): array { return $this->call('/query/agreement', ['agreementId' => $agreementId]); }

    // ------------------------------------------------------------ payments
    public function createPayment(string|float $amount, string $invoice, string $callbackURL, string $payerReference,
                                  string $intent = 'sale', ?string $subMerchantName = null, ?string $merchantAssociationInfo = null): array
    {
        return $this->call('/payment/create', array_filter([
            'payerReference' => self::safe($payerReference),
            'callbackURL' => $callbackURL,
            'amount' => self::amount($amount),
            'currency' => 'BDT',
            'intent' => $intent,
            'merchantInvoiceNumber' => self::safe($invoice),
            'subMerchantName' => $subMerchantName !== null ? self::safe($subMerchantName, 80) : null,
            'merchantAssociationInfo' => $merchantAssociationInfo !== null ? self::safe($merchantAssociationInfo) : null,
        ], fn($v) => $v !== null));
    }
    public function executePayment(string $paymentId): array { return $this->call('/payment/execute', ['paymentId' => $paymentId]); }
    public function capturePayment(string $paymentId): array { return $this->call('/payment/capture', ['paymentId' => $paymentId]); }
    public function voidPayment(string $paymentId): array { return $this->call('/payment/void', ['paymentId' => $paymentId]); }

    public function createPaymentWithAgreement(string $agreementId, string|float $amount, string $invoice, string $callbackURL,
                                               string $intent = 'sale', ?string $subMerchantName = null, ?string $merchantAssociationInfo = null): array
    {
        return $this->call('/payment-with-agreement/create', array_filter([
            'agreementId' => $agreementId,
            'callbackURL' => $callbackURL,
            'amount' => self::amount($amount),
            'currency' => 'BDT',
            'intent' => $intent,
            'merchantInvoiceNumber' => self::safe($invoice),
            'subMerchantName' => $subMerchantName !== null ? self::safe($subMerchantName, 80) : null,
            'merchantAssociationInfo' => $merchantAssociationInfo !== null ? self::safe($merchantAssociationInfo) : null,
        ], fn($v) => $v !== null));
    }
    public function executePaymentWithAgreement(string $paymentId, string $agreementId): array
    { return $this->call('/payment-with-agreement/execute', compact('paymentId', 'agreementId')); }
    public function capturePaymentWithAgreement(string $paymentId, string $agreementId): array
    { return $this->call('/payment-with-agreement/capture', compact('paymentId', 'agreementId')); }
    public function voidPaymentWithAgreement(string $paymentId, string $agreementId): array
    { return $this->call('/payment-with-agreement/void', compact('paymentId', 'agreementId')); }

    // ------------------------------------------------------------ query / search / refund
    public function queryPayment(string $paymentId): array { return $this->call('/query/payment', ['paymentId' => $paymentId]); }
    public function searchTransaction(string $trxId): array { return $this->call('/general/search-transaction', ['trxId' => $trxId]); }

    public function refund(string $paymentId, string $trxId, string|float $amount, string $sku, string $reason): array
    {
        return $this->call('/refund/payment/transaction', [
            'paymentId' => $paymentId, 'trxId' => $trxId, 'refundAmount' => self::amount($amount),
            'sku' => self::safe($sku), 'reason' => self::safe($reason),
        ]);
    }
    public function refundStatus(string $paymentId, string $trxId): array
    { return $this->call('/refund/payment/status', compact('paymentId', 'trxId')); }

    /** Execute once; on timeout / 5xx / "already completed" fall back to Query Payment. */
    public function executeWithRecovery(string $paymentId, ?string $agreementId = null): array
    {
        try {
            $d = $agreementId ? $this->executePaymentWithAgreement($paymentId, $agreementId) : $this->executePayment($paymentId);
            return ['status' => $d['transactionStatus'] ?? null, 'data' => $d];
        } catch (BkashTimeoutException) {
            // fall through to query
        } catch (BkashException $e) {
            $done = in_array($e->bkashCode, ['2062', '2068', '2117', '2119'], true);
            $unknown = $e->httpStatus === 0 || $e->httpStatus >= 500; // network error / gateway error
            if (!$done && !$unknown) throw $e;
        }
        $q = $this->queryPayment($paymentId);
        return ['status' => $q['transactionStatus'] ?? null, 'data' => $q];
    }
}
