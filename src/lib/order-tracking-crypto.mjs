import { createHmac } from "node:crypto";

export function loadTrackingKeyRing(env = process.env) {
  const rawKeys = env.ORDER_TRACKING_HMAC_KEYS;
  const rawActive = env.ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION;
  if (!rawKeys || !rawActive || !/^[1-9][0-9]*$/.test(rawActive)) return null;
  let parsed;
  try { parsed = JSON.parse(rawKeys); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = new Map();
  for (const [versionText, secret] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(versionText) || typeof secret !== "string") return null;
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || Buffer.byteLength(secret, "utf8") < 32) return null;
    keys.set(version, secret);
  }
  const activeVersion = Number(rawActive);
  if (!Number.isSafeInteger(activeVersion) || !keys.has(activeVersion)) return null;
  return { activeVersion, keys };
}
export function hashTrackingValue(value, secret) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}
export function deriveTrackingToken(storeSlug, idempotencyKey, secret) {
  return hashTrackingValue(`tracking:${storeSlug}:${idempotencyKey}`, secret);
}
export function hashTrackingToken(token, secret) {
  return hashTrackingValue(`tracking-hash:${token}`, secret);
}
