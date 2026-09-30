import type { NextConfig } from "next";

// Optional path prefix for a self-hosted dashboard behind a reverse proxy
// (e.g. "/tools/hevy2garmin"). Read at build time: Next.js bakes it into the
// bundle, so the image is built for the path it is served under.
const basePath = (process.env.H2G_BASE_PATH ?? "").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // `standalone` is for Docker self-hosting. On Vercel it corrupts the Edge
  // middleware bundle (pulls in Node-only `__dirname` → MIDDLEWARE_INVOCATION_FAILED),
  // so only enable it off-Vercel; Vercel uses its own optimized output.
  output: process.env.VERCEL ? undefined : "standalone",
  // Don't auto-generate AGENTS.md / CLAUDE.md on build (those are local-only).
  agentRules: false,
  // Parity with the Python dashboard's GET /sync → dashboard (#461).
  async redirects() {
    return [{ source: "/sync", destination: "/dashboard", permanent: false }];
  },
};

export default nextConfig;
