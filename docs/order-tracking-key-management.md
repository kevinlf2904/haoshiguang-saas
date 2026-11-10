# Order tracking HMAC key management

The public order-tracking bearer token uses a dedicated HMAC key ring. It must never reuse
`SUPABASE_SERVICE_ROLE_KEY`, the anon key, or any client-exposed variable.

## Required server-only environment

- `ORDER_TRACKING_HMAC_KEYS`: JSON object mapping positive integer key versions to independent random secrets.
- `ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION`: positive integer selecting the key used for newly created tracking links.

Generate a secret with at least 32 random bytes, for example:

```sh
openssl rand -base64 48
```

Example shape (replace the example values with independently generated secrets):

```sh
ORDER_TRACKING_HMAC_KEYS='{"1":"<secret-version-1>","2":"<secret-version-2>"}'
ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION=2
```

Keep these variables server-only. Do not prefix them with `NEXT_PUBLIC_`, commit real values,
print them in CI logs, or send them to the browser.

## Rotation procedure

1. Generate a new independent secret and increment the active version (for example, add version
   `3` and set the active version to `3`).
2. Keep every previous key version in `ORDER_TRACKING_HMAC_KEYS`. Existing tracking rows store
   their `key_version`; lookup verifies the supplied token using only the matching version.
3. Deploy the new configuration only after all application instances can read both old and new
   versions. Keep the previous versions for as long as existing customer links must remain valid.
4. Remove an old version only when intentionally expiring every tracking link issued under it.
   Removing a key makes those links return the same not-found response as invalid tokens.
5. A retry of an existing idempotent checkout keeps the original row and key version; it does not
   silently replace an existing customer's tracking URL during rotation.

The application fails closed with HTTP 503 if the key-ring configuration is missing, malformed,
uses a key shorter than 32 UTF-8 bytes, or does not contain its active version. It does not fall
back to the service-role key.

## CI

The isolated storefront E2E workflow injects disposable test-only key material. Never copy those
values into a hosted environment.
