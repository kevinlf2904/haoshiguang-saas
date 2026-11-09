# Checkout retention policy

The public checkout path performs opportunistic cleanup inside the same database
transaction as each checkout. This avoids assuming that `pg_cron`, a deployed
Vercel project, or an external scheduler is already configured.

| Data | Retention | Cleanup batch |
| --- | --- | --- |
| `public_order_ip_limits` | 24 hours | Up to 500 rows per tenant per checkout |
| `public_order_rate_limits` | 24 hours | Up to 500 rows per tenant per checkout |
| `public_order_idempotency` | 7 days | Up to 500 rows per tenant per checkout |

Rate-limit decisions continue to use only the rolling 10-minute window. Keeping
hashes for 24 hours provides a short operational investigation window without
retaining them indefinitely.

An idempotency key is guaranteed to replay its original order for 7 days.
After the record expires and is cleaned, reuse of that key can create a new
order. The storefront must reuse a key only for retries of the same checkout
attempt and rotate it when cart or checkout details change.

Cleanup is tenant-scoped and bounded. If a tenant becomes inactive, no
checkout-triggered cleanup will run for it; a future maintenance scheduler may
call `public.cleanup_public_order_retention(uuid)` as `service_role`. This
migration does not configure a scheduler or production database.
