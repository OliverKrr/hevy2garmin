/**
 * The trusted-proxy check (fork-only, H2G_PROXY_SECRET), shared by the proxy
 * gate and the pages that would otherwise ask for a dashboard password.
 *
 * A reverse proxy that does its own login vouches for a request by sending
 * H2G_PROXY_SECRET in X-H2G-Proxy-Secret. It must overwrite any copy a client
 * sent. Anything that bypasses the proxy lacks the secret. Unset, nothing is
 * vouched for.
 */
export const PROXY_SECRET_HEADER = "x-h2g-proxy-secret";

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time: both sides are hashed to 32 bytes and every byte is compared. */
export async function proxySecretMatches(sent: string | null | undefined): Promise<boolean> {
  const secret = process.env.H2G_PROXY_SECRET ?? "";
  if (!secret || !sent) return false;
  const [a, b] = await Promise.all([sha256(sent), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
