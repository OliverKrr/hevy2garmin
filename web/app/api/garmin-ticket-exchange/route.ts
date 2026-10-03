import { NextResponse } from "next/server";
import { directGarminLogin, localWorkerFetch, LOCAL_WORKER_URL } from "@/lib/garmin-direct-login";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/garmin-ticket-exchange (fork-only)
 * Body: { ticket: "ST-..." }
 *
 * The manual sign-in fallback's ticket exchange, run on this server. Upstream's
 * browser posts the ticket to a Cloudflare Worker; with H2G_DIRECT_GARMIN_LOGIN
 * on, ConnectGarmin posts it here instead and the vendored Worker code exchanges
 * it with Garmin directly. The DI tokens come back to the browser, which hands
 * them to /api/garmin-ticket exactly as on the Worker path. Off, this route
 * does not exist as far as callers are concerned.
 */
export async function POST(request: Request) {
  if (!directGarminLogin()) {
    return NextResponse.json({ error: "Direct Garmin login is off on this server." }, { status: 404 });
  }
  let ticket = "";
  try {
    const body = (await request.json()) as { ticket?: unknown };
    ticket = typeof body.ticket === "string" ? body.ticket : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const res = await localWorkerFetch(`${LOCAL_WORKER_URL}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const data = await res.json().catch(() => ({ error: "The exchange returned no JSON." }));
  return NextResponse.json(data, { status: res.status });
}
