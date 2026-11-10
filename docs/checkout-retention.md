# Checkout retention policy

Each newly created order triggers opportunistic cleanup inside the same database
transaction as checkout. This avoids assuming that `pg_cron`, a deployed
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

## Checkout client-IP trust boundary

The checkout API derives its per-IP rate-limit key only from
`x-vercel-forwarded-for`, the Vercel-provided request header. The value must be
one valid IPv4 or IPv6 address; empty values, comma-separated chains, malformed
values and oversized values are rejected. IPv6 text is canonicalized before
HMAC hashing so equivalent spellings produce the same rate-limit identity.

The API never falls back to `x-forwarded-for`, because values supplied by a
caller or an unverified upstream proxy must not control a security rate limit.
Vercel documents that it overwrites `X-Forwarded-For` to prevent IP spoofing
and describes `x-vercel-forwarded-for` as the deployment-facing equivalent.
If a custom proxy or CDN is placed in front of Vercel, verify the header trust
chain and actual ingress behavior before relying on per-IP protection. This
repository change does not claim a hosted production request-path test.
