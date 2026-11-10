import { isIP } from "node:net";

/**
 * Resolve the client address only from Vercel's ingress-provided header.
 * Never fall back to client-supplied forwarding headers for security controls.
 *
 * Vercel documents x-vercel-forwarded-for as its deployment request header.
 * Its value must be one address; chains and malformed values are rejected.
 */
export function getTrustedVercelClientIp(headers) {
  const value = headers.get("x-vercel-forwarded-for");
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 45 ||
    value !== value.trim() ||
    /[\s,]/.test(value)
  ) {
    return null;
  }

  const version = isIP(value);
  if (version === 0) return null;

  try {
    // URL canonicalizes equivalent IPv6 spellings so the same address cannot
    // rotate its rate-limit key by changing letter case or zero compression.
    const hostname = new URL(
      version === 6 ? `http://[${value}]/` : `http://${value}/`,
    ).hostname;
    const normalized = version === 6 ? hostname.slice(1, -1) : hostname;
    return isIP(normalized) === version ? normalized : null;
  } catch {
    return null;
  }
}
