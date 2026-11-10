import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCronRequest(authorization, secret) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}
