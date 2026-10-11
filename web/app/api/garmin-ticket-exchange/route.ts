import { NextResponse } from "next/server";
import { directGarminLogin } from "@/lib/direct-login-flag";
import { localGarminLogin } from "@/lib/garmin-login-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/garmin-ticket-exchange
 * Body: { ticket: "ST-..." }
 *
 * The manual sign-in fallback's ticket exchange, run on this server (#685). Without direct
 * login the browser posts the ticket to the Worker; with H2G_DIRECT_GARMIN_LOGIN on,
 * ConnectGarmin posts it here, and garmin-auth's in-process Worker code exchanges it with
 * Garmin. The DI tokens come back in the Worker's shape, so the browser hands them to
 * /api/garmin-ticket exactly as on the Worker path. Off, the route answers 404.
 */
export async function POST(request: Request) {
  if (!directGarminLogin()) {
    return NextResponse.json({ error: "Direct Garmin login is off on this server." }, { status: 404 });
  }
  let ticket = "";
  try {
    const body = (await request.json()) as { ticket?: unknown };
    ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!ticket.startsWith("ST-")) {
    return NextResponse.json({ error: "Missing or malformed ticket." }, { status: 400 });
  }
  const r = await localGarminLogin().exchange(ticket);
  if (r.status !== "success" || !r.di_token || !r.di_refresh_token || !r.di_client_id) {
    return NextResponse.json({ error: r.message ?? "That ticket could not be exchanged." }, { status: 502 });
  }
  return NextResponse.json({ di_token: r.di_token, di_refresh_token: r.di_refresh_token, di_client_id: r.di_client_id });
}
