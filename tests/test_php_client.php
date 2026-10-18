<?php
declare(strict_types=1);
require __DIR__ . '/../plugins/bkash-payment-gateway/skills/bkash-payment-gateway/templates/php/BkashClient.php';

use Bkash\{BkashClient, BkashException, FileTokenStore};

function check(bool $cond, string $msg): void { if (!$cond) { fwrite(STDERR, "FAIL: $msg\n"); exit(1); } }

$base = getenv('MOCK_URL') ?: 'http://127.0.0.1:8765';
$tokenFile = sys_get_temp_dir() . '/bkash_test_token_' . getmypid() . '.json';
$c = new BkashClient("$base/v2/tokenized-checkout", 'user', 'pass', 'test_app_key', 'secret', new FileTokenStore($tokenFile));

$r = $c->createPayment('100', 'INV-1', 'https://shop.test/cb', 'CUST1');
check(str_starts_with($r['bkashURL'], 'https://'), 'bkashURL');
check($r['signature'] === 'sig' . $r['paymentId'], 'signature');
$e = $c->executeWithRecovery($r['paymentId']);
check($e['status'] === 'Completed', 'execute');
check($c->executeWithRecovery($r['paymentId'])['status'] === 'Completed', '2062 recovery');

$r2 = $c->createPayment('503.00', 'INV-2', 'https://shop.test/cb', 'C');
check($c->executeWithRecovery($r2['paymentId'])['status'] === 'Completed', '503 recovery');

try { $c->createPayment('999.99', 'INV-3', 'https://shop.test/cb', 'C'); check(false, 'expected error'); }
catch (BkashException $ex) { check($ex->bkashCode === '2006' && $ex->getMessage() === 'Invalid amount.', 'error mapping'); }

foreach (['0', '-1', 'abc'] as $bad) {
    try { BkashClient::amount($bad); check(false, "amount $bad"); } catch (InvalidArgumentException) {}
}
check(BkashClient::amount(12.5) === '12.50', 'amount format');

check($c->refund($r['paymentId'], $e['data']['trxId'], '10', 'SKU', 'test')['refundTransactionStatus'] === 'Completed', 'refund');
check($c->voidPayment('P')['transactionStatus'] === 'Cancelled', 'void');

// a second client instance sharing the same store must reuse the token
$c2 = new BkashClient("$base/v2/tokenized-checkout", 'user', 'pass', 'test_app_key', 'secret', new FileTokenStore($tokenFile));
$c2->queryPayment($r['paymentId']);

$stats = json_decode(file_get_contents("$base/stats"), true);
check($stats['grant'] === 1, 'single grant: ' . json_encode($stats));
@unlink($tokenFile); @unlink("$tokenFile.lock");
echo "php client OK " . json_encode($stats) . "\n";
