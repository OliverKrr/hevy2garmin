/**
 * H2G_DIRECT_GARMIN_LOGIN (fork): Garmin sign-in runs on this server and no
 * Cloudflare Worker may be contacted. Kept dependency-free so the proxy and the
 * startup hook can read it without loading the vendored Worker.
 */
export function directGarminLogin(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.H2G_DIRECT_GARMIN_LOGIN ?? "").trim());
}
