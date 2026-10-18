# Node.js — Express, Next.js, NestJS, Fastify

Copy `templates/node/bkash.ts` (client), `templates/node/redis-token-store.ts` (shared token store) and adapt `templates/node/express-example.ts`. Requires Node 18+ (global `fetch`). Plain JS projects: strip the types or compile with `tsc`.

```bash
npm i redis            # or ioredis — adapt RedisLike
```

`.env`:
```
BKASH_BASE_URL=https://tokenized.sandbox.bka.sh/v2/tokenized-checkout
BKASH_USERNAME=...
BKASH_PASSWORD=...
BKASH_APP_KEY=...
BKASH_APP_SECRET=...
APP_URL=https://shop.example.com
REDIS_URL=redis://localhost:6379
```

## Express

See `templates/node/express-example.ts` — routes `POST /payments/bkash`, `GET /payments/bkash/callback`, `POST /admin/payments/:paymentId/refund`. Add the IPN route from `references/webhook-ipn.md` (it needs `express.text({ type: "*/*" })`, registered **before** any global `express.json()` for that path).

## Next.js (App Router)

```ts
// lib/bkash.ts
import { createClient } from "redis";
import { bkashFromEnv } from "./bkash-client";      // templates/node/bkash.ts
import { RedisTokenStore } from "./redis-token-store";

const g = globalThis as any;
g.__redis ??= createClient({ url: process.env.REDIS_URL });
if (!g.__redis.isOpen) g.__redis.connect();
export const bkash = (g.__bkash ??= bkashFromEnv(new RedisTokenStore(g.__redis)));
```

```ts
// app/api/bkash/create/route.ts
import { NextResponse } from "next/server";
import { bkash } from "@/lib/bkash";
export const runtime = "nodejs"; // not edge: needs node:crypto + redis

export async function POST(req: Request) {
  const { orderId } = await req.json();
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } }); // server-side amount
  const invoice = `${order.id}-${Date.now()}`;
  const r: any = await bkash.createPayment({
    amount: order.total.toFixed(2), merchantInvoiceNumber: invoice, payerReference: String(order.userId),
    callbackURL: `${process.env.APP_URL}/api/bkash/callback`,
  });
  await db.bkashPayment.create({ data: { orderId, invoiceNumber: invoice, paymentId: r.paymentId, amount: order.total, status: "INITIATED", createSignature: r.signature } });
  return NextResponse.json({ redirectUrl: r.bkashURL });
}
```

```ts
// app/api/bkash/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { bkash } from "@/lib/bkash";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const paymentID = q.get("paymentID"), status = q.get("status"), signature = q.get("signature");
  const p = paymentID ? await db.bkashPayment.findUnique({ where: { paymentId: paymentID } }) : null;
  const go = (path: string) => NextResponse.redirect(new URL(path, process.env.APP_URL));
  if (!p) return go("/checkout?payment=invalid");
  if (p.status === "COMPLETED") return go(`/orders/${p.orderId}?payment=success`);
  if (signature !== p.createSignature) return go("/checkout?payment=invalid");
  if (status !== "success") {
    await db.bkashPayment.updateMany({ where: { paymentId: paymentID!, status: "INITIATED" }, data: { status: status === "cancel" ? "CANCELLED" : "FAILED" } });
    return go(`/checkout?payment=${status}`);
  }
  const claimed = await db.bkashPayment.updateMany({ where: { paymentId: paymentID!, status: "INITIATED" }, data: { status: "PENDING_VERIFICATION" } });
  if (claimed.count === 0) return go(`/orders/${p.orderId}?payment=processing`);
  try {
    const { status: s, data } = await bkash.executeWithRecovery(paymentID!);
    if (s === "Completed") {
      await db.$transaction([
        db.bkashPayment.update({ where: { paymentId: paymentID! }, data: { status: "COMPLETED", trxId: data.trxId } }),
        db.order.update({ where: { id: p.orderId }, data: { status: "PAID" } }),
      ]);
      return go(`/orders/${p.orderId}?payment=success`);
    }
    await db.bkashPayment.update({ where: { paymentId: paymentID! }, data: { status: "FAILED" } });
    return go(`/checkout?payment=failed`);
  } catch (e: any) {
    return go(`/checkout?payment=failed&msg=${encodeURIComponent(e.message)}`);
  }
}
```

Client button:
```tsx
"use client";
export function PayWithBkash({ orderId }: { orderId: string }) {
  return <button onClick={async () => {
    const r = await fetch("/api/bkash/create", { method: "POST", body: JSON.stringify({ orderId }) });
    const { redirectUrl, error } = await r.json();
    if (redirectUrl) window.location.href = redirectUrl; else alert(error);
  }}>Pay with bKash</button>;
}
```

Prisma model:
```prisma
model BkashPayment {
  id              Int      @id @default(autoincrement())
  orderId         String
  invoiceNumber   String   @unique
  paymentId       String?  @unique
  agreementId     String?
  intent          String   @default("sale")
  amount          Decimal  @db.Decimal(12, 2)
  status          String
  createSignature String?
  trxId           String?
  errorCode       String?
  errorMessage    String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

## NestJS

```ts
@Module({
  providers: [
    { provide: "REDIS", useFactory: async () => { const c = createClient({ url: process.env.REDIS_URL }); await c.connect(); return c; } },
    { provide: BkashClient, inject: ["REDIS"], useFactory: (r) => bkashFromEnv(new RedisTokenStore(r)) },
    BkashPaymentService,
  ],
  controllers: [BkashController],
  exports: [BkashClient],
})
export class BkashModule {}
```
Controller methods mirror the Express routes. Use `@Redirect()` or `res.redirect()` for the callback. Run the recovery job with `@nestjs/schedule` `@Cron('*/10 * * * *')`.

## Fastify / Hono / Koa

Same client. For IPN register a raw/text content-type parser (`fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, ...)`).

## Recovery job (any framework)

```ts
// every 10 minutes
for (const p of await db.bkashPayment.findMany({ where: { status: { in: ["INITIATED", "PENDING_VERIFICATION"] }, createdAt: { lt: new Date(Date.now() - 15 * 60_000) } } })) {
  try {
    const q: any = await bkash.queryPayment(p.paymentId!);
    if (q.transactionStatus === "Completed") await markPaid(p, q.trxId);
    else if (Date.now() - p.createdAt.getTime() > 24 * 3600_000) await markExpired(p);
  } catch (e) { /* log and continue */ }
}
```

## Testing

Mock `fetch` (e.g. `undici` MockAgent or `msw`) with the sample payloads from `references/api-reference.md`; assert the token is requested once across many calls and that Execute is never called twice for the same paymentId.
