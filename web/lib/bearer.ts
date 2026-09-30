import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Does `Authorization: Bearer <token>` carry exactly `secret`?
 *
 * Constant-time, like `_bearer_ok` in the Python server. `timingSafeEqual`
 * needs equal lengths and throws otherwise, so both sides are hashed first:
 * the comparison then always runs over 32 bytes and says nothing about how
 * long the secret is. An empty secret never matches, so a caller that forgot
 * to check for one fails closed.
 */
export function bearerMatches(header: string | null | undefined, secret: string): boolean {
  if (!secret) return false;
  const m = (header ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(m[1]), digest(secret));
}
