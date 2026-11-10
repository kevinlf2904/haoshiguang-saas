import { createHmac } from "node:crypto";

export type TrackingKeyRing = {
  activeVersion: number;
  keys: Map<number, string>;
};

export function loadTrackingKeyRing(env: NodeJS.ProcessEnv = process.env): TrackingKeyRing | null {
  const rawKeys = env.ORDER_TRACKING_HMAC_KEYS;
  const rawActive = env.ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION;
  if (!rawKeys || !rawActive || !/^[1-9][0-9]*$/.test(rawActive)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const keys = new Map<number, string>();
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

export function hashTrackingValue(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function deriveTrackingToken(storeSlug: string, idempotencyKey: string, secret: string): string {
  return hashTrackingValue(`tracking:${storeSlug}:${idempotencyKey}`, secret);
}

export function hashTrackingToken(token: string, secret: string): string {
  return hashTrackingValue(`tracking-hash:${token}`, secret);
}
