/**
 * Garmin sign-in on this server, never through a Cloudflare Worker (fork-only).
 *
 * Upstream signs in through a Worker on Cloudflare's edge because Garmin blocks
 * the SSO from cloud IPs, so a Vercel deploy cannot reach it. A self-hosted
 * server on a home connection can. With H2G_DIRECT_GARMIN_LOGIN on, the login,
 * the two-factor step and the manual-ticket exchange all run the Worker's own
 * code (./garmin-sso-local/worker.js, vendored from garmin-auth) in this
 * process. The email, password and code then go from here to Garmin
 * (sso.garmin.com, diauth.garmin.com) and nowhere else.
 *
 * It is a hard switch, not a preference. While it is on, GARMIN_LOGIN_WORKER_URL
 * and the shared default Worker are never contacted, and localWorkerFetch
 * refuses anything but this module's own origin and the three routes the
 * sign-in needs. Off (the default), nothing changes.
 */
import worker, { type LocalWorkerKv } from "./garmin-sso-local/worker.js";

export { directGarminLogin } from "./direct-login-flag";

/** A made-up origin: requests to it never touch the network, see localWorkerFetch. */
export const LOCAL_WORKER_URL = "http://garmin-sso.local";

const LOCAL_ROUTES = new Set(["/login", "/login-mfa", "/exchange"]);

/**
 * The Worker keeps two things in Cloudflare KV: the MFA session between the
 * password and the code (10 minutes) and a per-account cooldown after a Garmin
 * 429. In one long-running process a Map does the same. A restart loses both,
 * which costs a fresh password step, never a stored credential.
 */
export class MemoryKv implements LocalWorkerKv {
  private entries = new Map<string, { value: string; expiresAt: number }>();
  constructor(private now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return e.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttl = options?.expirationTtl ?? 600;
    this.entries.set(key, { value, expiresAt: this.now() + ttl * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

const env = { MFA_SESSIONS: new MemoryKv() };

/**
 * A fetch for garmin-auth's Worker client that runs the vendored Worker in this
 * process. Anything not addressed to LOCAL_WORKER_URL and one of the sign-in
 * routes throws, so a misconfigured caller fails loudly instead of reaching a
 * Worker on the internet.
 */
export async function localWorkerFetch(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  const url = new URL(input);
  if (url.origin !== LOCAL_WORKER_URL || !LOCAL_ROUTES.has(url.pathname)) {
    throw new Error(`Direct Garmin login refuses ${url.origin}${url.pathname}: only the local sign-in routes run here.`);
  }
  return worker.fetch(new Request(url, init), env);
}
