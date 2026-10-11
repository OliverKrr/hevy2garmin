import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { directGarminLogin } from "./direct-login-flag";
import { workerLogin, workerLoginMfa } from "./garmin-login-worker";
import { POST as ticketExchange } from "@/app/api/garmin-ticket-exchange/route";

/**
 * H2G_DIRECT_GARMIN_LOGIN (#685): the password must go to Garmin and nowhere else. These drive
 * the real login client against a fake Garmin and record every host the code contacts.
 */

const ENV = { ...process.env };
let hosts: string[] = [];

/** A JWT-shaped token whose payload names a client id, as Garmin's DI token does. */
const DI_TOKEN = `x.${Buffer.from(JSON.stringify({ client_id: "TEST_CLIENT" })).toString("base64url")}.y`;

/** Fake Garmin: warmup GET, login POST (success or MFA), MFA POST, DI token POST. */
function fakeGarmin(loginReply: "success" | "mfa") {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    hosts.push(url.host);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.host === "diauth.garmin.com") {
      return new Response(JSON.stringify({ access_token: DI_TOKEN, refresh_token: "refresh" }));
    }
    if (method !== "POST") {
      return new Response("", { status: 200, headers: { "set-cookie": "s=1" } });
    }
    if (url.pathname.includes("mfa")) {
      return new Response(JSON.stringify({ responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-2" }));
    }
    return new Response(
      JSON.stringify(
        loginReply === "success"
          ? { responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-1" }
          : { responseStatus: { type: "MFA_REQUIRED" }, customerMfaInfo: { mfaLastMethodUsed: "email" } },
      ),
    );
  });
}

function exchangeRequest(body: unknown) {
  return new Request("http://app.test/api/garmin-ticket-exchange", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  hosts = [];
  delete process.env.H2G_DIRECT_GARMIN_LOGIN;
  delete process.env.GARMIN_LOGIN_WORKER_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ENV };
});

describe("the flag", () => {
  it("is off unless set to a true value", () => {
    expect(directGarminLogin()).toBe(false);
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) {
      process.env.H2G_DIRECT_GARMIN_LOGIN = v;
      expect(directGarminLogin()).toBe(true);
    }
    for (const v of ["", "0", "false", "off", "no"]) {
      process.env.H2G_DIRECT_GARMIN_LOGIN = v;
      expect(directGarminLogin()).toBe(false);
    }
  });
});

describe("direct login on: only Garmin is contacted", () => {
  beforeEach(() => {
    process.env.H2G_DIRECT_GARMIN_LOGIN = "true";
  });

  it("a password login runs here and returns the tokens", async () => {
    vi.stubGlobal("fetch", fakeGarmin("success"));
    const r = await workerLogin("athlete@example.com", "pw");
    expect(r).toMatchObject({ status: "success", di_token: DI_TOKEN, di_refresh_token: "refresh", di_client_id: "TEST_CLIENT" });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.every((h) => h === "sso.garmin.com" || h === "diauth.garmin.com")).toBe(true);
  });

  it("the two-factor step finds its session from the password step, across the two route calls", async () => {
    vi.stubGlobal("fetch", fakeGarmin("mfa"));
    const first = await workerLogin("athlete@example.com", "pw");
    expect(first.status).toBe("needs_mfa");
    expect(first.session_id).toBeTruthy();
    const second = await workerLoginMfa(first.session_id!, "123456");
    expect(second).toMatchObject({ status: "success", di_token: DI_TOKEN });
    expect(hosts.every((h) => h.endsWith(".garmin.com"))).toBe(true);
  });

  it("ignores GARMIN_LOGIN_WORKER_URL: no Worker is reached even when one is configured", async () => {
    process.env.GARMIN_LOGIN_WORKER_URL = "https://garmin-auth-sso.example.workers.dev";
    vi.stubGlobal("fetch", fakeGarmin("success"));
    await workerLogin("athlete@example.com", "pw");
    expect(hosts.some((h) => h.endsWith("workers.dev"))).toBe(false);
  });

  it("the manual-ticket exchange runs here and returns the Worker's token shape", async () => {
    vi.stubGlobal("fetch", fakeGarmin("success"));
    const res = await ticketExchange(exchangeRequest({ ticket: "ST-9" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ di_token: DI_TOKEN, di_refresh_token: "refresh", di_client_id: "TEST_CLIENT" });
    expect(hosts).toEqual(["diauth.garmin.com"]);
  });

  it("the exchange refuses a body without a ticket, before calling Garmin", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await ticketExchange(exchangeRequest({ ticket: "nope" }))).status).toBe(400);
    expect((await ticketExchange(new Request("http://app.test/x", { method: "POST", body: "{" }))).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a ticket Garmin refuses answers 502 with an error, not tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
    const res = await ticketExchange(exchangeRequest({ ticket: "ST-9" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toHaveProperty("error");
  });
});

describe("direct login off: nothing changes", () => {
  it("the login goes to the shared Worker, as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).host);
      return new Response(JSON.stringify({ status: "invalid_credentials" }));
    }));
    await workerLogin("athlete@example.com", "pw");
    expect(hosts).toEqual(["garmin-auth-sso.gkos.workers.dev"]);
  });

  it("the ticket-exchange route answers 404", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await ticketExchange(exchangeRequest({ ticket: "ST-9" }));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
