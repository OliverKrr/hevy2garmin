// A self-hosted dashboard can live under a path prefix (H2G_BASE_PATH at build
// time, e.g. behind a reverse proxy that serves several tools on one host).
// Next.js prefixes <Link>, router.push and redirect() by itself, but not a
// hand-written fetch("/api/...") or a plain <a href="/...">. Those go through
// withBasePath. Unset, it returns the path unchanged.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBasePath(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? BASE_PATH + path : path;
}
