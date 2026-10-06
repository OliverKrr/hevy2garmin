/**
 * The server-side half of the Worker ban (fork-only).
 *
 * With H2G_DIRECT_GARMIN_LOGIN on, no request from this server may reach a
 * Cloudflare Worker (*.workers.dev), whichever code path makes it. The login
 * routes already never call one (lib/garmin-direct-login.ts); this catches the
 * paths nobody has reviewed yet, such as one an upstream rebase adds. It wraps
 * the global fetch once at server start (instrumentation.ts) and throws before
 * any byte leaves the process. The browser half is the Content-Security-Policy
 * header set in proxy.ts.
 */
import { directGarminLogin } from "./direct-login-flag";

const MARK = Symbol.for("h2g.workerBlock");

export function isWorkerHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "workers.dev" || h.endsWith(".workers.dev");
}

function hostOf(input: unknown): string | null {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === "object" && "url" in input) return new URL(String((input as { url: string }).url)).hostname;
  } catch {
    // A relative URL cannot leave the server; let fetch report it as usual.
  }
  return null;
}

/** Install the guard on `target` (globalThis by default). Returns whether it is active. */
export function installWorkerBlock(target: { fetch: typeof fetch } = globalThis): boolean {
  if (!directGarminLogin()) return false;
  const current = target.fetch as typeof fetch & { [MARK]?: true };
  if (current[MARK]) return true;
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = hostOf(input);
    if (host && isWorkerHost(host)) {
      throw new Error(`H2G_DIRECT_GARMIN_LOGIN blocks requests to ${host}: this server never contacts a Cloudflare Worker.`);
    }
    return current(input, init);
  }) as typeof fetch & { [MARK]?: true };
  guarded[MARK] = true;
  target.fetch = guarded;
  return true;
}
