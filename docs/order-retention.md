# Order abuse-prevention retention

## Retention windows

- Per-tenant IP rate-limit hashes: 24 hours.
- Per-tenant phone rate-limit hashes: 24 hours.
- Per-tenant checkout idempotency records: 7 days. A key reused after expiry may create a new order; clients must generate a fresh UUID for a new checkout.
- Each tenant cleanup call deletes at most 500 stale rows from each table. The scheduled all-tenant function applies that bounded cleanup once per tenant.

This cleanup does **not** delete orders, order items, customer names, customer phone numbers, order notes, or public order-tracking links. Those records need a separately approved business/legal retention policy before any deletion is implemented.

## Scheduled execution

Vercel Cron calls `GET /api/cron/order-retention` daily at 03:17 UTC (11:17 Taiwan time). The route requires an exact `Authorization: Bearer <CRON_SECRET>` header and compares the secret in constant time. It uses the server-only Supabase service-role key to invoke `cleanup_all_public_order_retention`.

Configure `CRON_SECRET` as a high-entropy server-only environment variable in the hosting project. Never prefix it with `NEXT_PUBLIC_`, commit its value, or expose it to the browser. The route fails closed if the secret or Supabase server configuration is missing.

The endpoint returns per-run tenant and deleted-row counts; monitor failed HTTP responses and repeated maximum-size cleanup batches as operational signals that the bounded per-tenant backlog may need attention. The migration and local SQL/auth tests validate the scheduled cleanup implementation. Hosted cron execution, hosted secrets, and production database behavior remain unverified until separately configured and explicitly deployed.
