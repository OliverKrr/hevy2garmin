import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

// Auth configured (H2G_PASSWORD), no session cookie on any request: the shape of a
// Vercel Cron / GitHub Actions caller. The epoch endpoint is stubbed so the proxy
// never fetches.
function req(path: string, headers: Record<string, string> = {}, method = "GET"): NextRequest {
  return new NextRequest(`http://h${path}`, { headers, method });
}
const passedThrough = (res: Response) => res.status === 200 && res.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  process.env.H2G_PASSWORD = "test-pw";
  delete process.env.HEVY2GARMIN_SECRET;
  delete process.env.DEMO_MODE;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ n: 0 }), { status: 200 })));
});
afterEach(() => {
  delete process.env.H2G_PASSWORD;
  delete process.env.DEMO_MODE;
  vi.unstubAllGlobals();
});

describe("proxy: /api/cron is public so the route's own CRON_SECRET check runs (#473)", () => {
  it("a bearer on /api/cron/sync reaches the route", async () => {
    const res = await proxy(req("/api/cron/sync", { authorization: "Bearer test-cron-secret" }));
    expect(passedThrough(res)).toBe(true);
  });

  it("/api/cron/webhook passes too; the route, not the proxy, decides on the secret", async () => {
    const res = await proxy(req("/api/cron/webhook"));
    expect(passedThrough(res)).toBe(true);
  });

  it("/api/cronjobs is NOT public: the prefix match is on the path segment", async () => {
    const res = await proxy(req("/api/cronjobs/x", { authorization: "Bearer test-cron-secret" }));
    expect(res.status).toBe(401);
  });

  it("an ordinary API route without a session stays gated with the proxy's plain 401", async () => {
    const res = await proxy(req("/api/settings", { authorization: "Bearer test-cron-secret" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
  });

  it("a page without a session is redirected to /login with ?next=", async () => {
    const res = await proxy(req("/dashboard"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("location")).toBe("http://h/login?next=%2Fdashboard");
  });

  it("the login and epoch endpoints stay public", async () => {
    expect(passedThrough(await proxy(req("/login")))).toBe(true);
    expect(passedThrough(await proxy(req("/api/login")))).toBe(true);
    expect(passedThrough(await proxy(req("/api/session-epoch")))).toBe(true);
  });

  it("with auth disabled outside production everything is open, including /api/settings", async () => {
    delete process.env.H2G_PASSWORD;
    // The check-web CI job runs with VERCEL=1 at job level; this case is about development.
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "test");
    try {
      expect(passedThrough(await proxy(req("/api/settings")))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// The README's promise (Securing the dashboard): without H2G_PASSWORD the app refuses to serve
// anything but the setup page, so a public URL is never open by accident (#550). Production is
// what a forker's Vercel deploy runs; a local `next dev` without a password stays open.
describe("proxy: production without a password serves only the setup and login pages (#550)", () => {
  beforeEach(() => {
    delete process.env.H2G_PASSWORD;
    delete process.env.H2G_PASSWORD_HASH;
    delete process.env.H2G_SECRET;
    delete process.env.HEVY2GARMIN_SECRET;
    process.env.VERCEL = "1";
  });
  afterEach(() => {
    delete process.env.VERCEL;
    vi.unstubAllEnvs();
  });

  it("a page is redirected to /setup with 307", async () => {
    const res = await proxy(req("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://h/setup");
  });

  it("an API route answers 401 JSON that names the missing variable", async () => {
    const res = await proxy(req("/api/settings"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("H2G_PASSWORD");
  });

  it("a mutating API call is refused the same way", async () => {
    const res = await proxy(req("/api/settings", {}, "POST"));
    expect(res.status).toBe(401);
  });

  it("the setup and login pages, login/logout/epoch and cron stay served", async () => {
    expect(passedThrough(await proxy(req("/setup")))).toBe(true);
    expect(passedThrough(await proxy(req("/login")))).toBe(true);
    expect(passedThrough(await proxy(req("/api/login", {}, "POST")))).toBe(true);
    expect(passedThrough(await proxy(req("/api/logout", {}, "POST")))).toBe(true);
    expect(passedThrough(await proxy(req("/api/session-epoch")))).toBe(true);
    expect(passedThrough(await proxy(req("/api/cron/sync", { authorization: "Bearer x" })))).toBe(true);
  });

  it("NODE_ENV=production without VERCEL is production too", async () => {
    delete process.env.VERCEL;
    vi.stubEnv("NODE_ENV", "production");
    expect((await proxy(req("/dashboard"))).status).toBe(307);
    expect((await proxy(req("/api/settings"))).status).toBe(401);
  });

  it("a password hash alone counts as configured", async () => {
    process.env.H2G_PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$abc$def";
    const res = await proxy(req("/dashboard"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("location")).toBe("http://h/login?next=%2Fdashboard");
  });

  it("the demo refusal still comes first for a mutating call", async () => {
    process.env.DEMO_MODE = "true";
    const res = await proxy(req("/api/settings", {}, "POST"));
    expect(res.status).toBe(403);
  });
});

describe("proxy: DEMO_MODE refuses every mutating /api method (#471)", () => {
  const demoBody = { ok: false, error: "Read-only in demo mode" };

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`${method} /api/mapping is 403 JSON, even with a valid-looking bearer`, async () => {
      process.env.DEMO_MODE = "true";
      const res = await proxy(req("/api/mapping", { authorization: "Bearer x" }, method));
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual(demoBody);
    });
  }

  it("the refusal comes before auth: a signed-in session is still refused", async () => {
    process.env.DEMO_MODE = "1";
    const res = await proxy(req("/api/unsync-all", {}, "POST"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(demoBody);
  });

  it("a demo with auth disabled is still read-only", async () => {
    process.env.DEMO_MODE = "yes";
    delete process.env.H2G_PASSWORD;
    expect((await proxy(req("/api/settings", {}, "POST"))).status).toBe(403);
    expect(passedThrough(await proxy(req("/api/settings")))).toBe(true);
  });

  it("GET stays readable and login/logout stay allowed in demo", async () => {
    process.env.DEMO_MODE = "on";
    expect(passedThrough(await proxy(req("/api/login", {}, "POST")))).toBe(true);
    expect(passedThrough(await proxy(req("/api/logout", {}, "POST")))).toBe(true);
    // GET /api/settings without a session is the normal auth 401, not the demo 403.
    expect((await proxy(req("/api/settings"))).status).toBe(401);
  });

  it("pages are not affected by demo mode", async () => {
    process.env.DEMO_MODE = "true";
    const res = await proxy(req("/dashboard", {}, "POST"));
    expect(res.headers.get("location")).toBe("http://h/login?next=%2Fdashboard");
  });

  it("with DEMO_MODE off (unset, false, 0) nothing changes", async () => {
    for (const v of [undefined, "false", "0", ""]) {
      if (v === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = v;
      const res = await proxy(req("/api/mapping", {}, "POST"));
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Unauthorized");
    }
  });
});

/**
 * /api/version answers without a session (#616, found while verifying a deploy).
 *
 * The endpoint exists to answer one question, which build is this deployment
 * running, and the person asking it is usually someone whose redeploy may not
 * have taken. The proxy gated it, so the two states the endpoint was built to
 * tell apart both returned 401 and it could not do its job. On an unconfigured
 * production deploy it was unreachable for the same reason, which is the case
 * where the question matters most.
 *
 * It is safe to leave open. It reports a commit sha of a public repository, the
 * branch and the environment name, and it reads no database and no credential.
 */
describe("proxy: /api/version answers without a session (#616)", () => {
  it("passes through when auth is configured and the caller has no cookie", async () => {
    const res = await proxy(req("/api/version"));
    expect(passedThrough(res)).toBe(true);
  });

  it("passes through on a production deploy with no password set", async () => {
    delete process.env.H2G_PASSWORD;
    vi.stubEnv("VERCEL", "1");
    const res = await proxy(req("/api/version"));
    expect(passedThrough(res)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("does not open a neighbour by prefix", async () => {
    // "/api/versions-of-everything" must not inherit this, the same way
    // /api/cronjobs does not inherit /api/cron.
    const res = await proxy(req("/api/versions-of-everything"));
    expect(res.status).toBe(401);
  });

  it("stays read-only in demo mode", async () => {
    // The demo guard runs before the auth gate, so a POST here must still be
    // refused rather than reaching a route because the path is public now.
    process.env.DEMO_MODE = "1";
    const res = await proxy(req("/api/version", {}, "POST"));
    expect(res.status).toBe(403);
  });
});

/**
 * A demo with no password is browsable (#634).
 *
 * The public demo had DEMO_MODE set and no password, so the #550 gate refused
 * every path and redirected each visitor to /setup, where they read
 * instructions for configuring a deployment they do not own. The README's first
 * link, "Try the live demo", landed there.
 *
 * The two features disagreed. #550 protects a forker's own deployment from
 * being public by accident, and DEMO_MODE says this one is public on purpose
 * and already refuses every mutating API call above the auth gate. So the
 * accident the gate guards against cannot happen here, and the gate was the
 * only thing standing between a visitor and the product.
 *
 * DEMO_MODE therefore opens reads while no password is configured, and nothing
 * else. It must not weaken a deployment that HAS one, and it must not let a
 * write through, which is what the last two tests here are for.
 */
describe("proxy: DEMO_MODE makes an unconfigured deploy browsable (#634)", () => {
  beforeEach(() => {
    delete process.env.H2G_PASSWORD;
    process.env.DEMO_MODE = "1";
    vi.stubEnv("VERCEL", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("serves the dashboard instead of redirecting to /setup", async () => {
    const res = await proxy(req("/dashboard"));
    expect(passedThrough(res)).toBe(true);
  });

  it("serves a read API call", async () => {
    const res = await proxy(req("/api/workouts"));
    expect(passedThrough(res)).toBe(true);
  });

  it("still refuses a write, with the demo's own 403 and not a 401", async () => {
    // The distinction matters. 401 reads as "sign in and you may", which is
    // false here, and it is the answer the auth gate would give.
    const res = await proxy(req("/api/sync-one", {}, "POST"));
    expect(res.status).toBe(403);
  });

  it("leaves a deployment with no DEMO_MODE refusing, as #550 asks", async () => {
    delete process.env.DEMO_MODE;
    const res = await proxy(req("/dashboard"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") as string).pathname).toBe("/setup");
  });

  it("is not an auth bypass on a deploy that HAS a password", async () => {
    // The whole exemption lives inside the no-password branch. A configured
    // deploy that also sets DEMO_MODE must still send a visitor to /login.
    process.env.H2G_PASSWORD = "test-pw";
    const res = await proxy(req("/dashboard"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") as string).pathname).toBe("/login");
  });
});

describe("proxy: a trusted reverse proxy vouches with H2G_PROXY_SECRET", () => {
  afterEach(() => {
    delete process.env.H2G_PROXY_SECRET;
  });

  it("the right secret passes a gated API route without a session", async () => {
    process.env.H2G_PROXY_SECRET = "s3cret";
    const res = await proxy(req("/api/settings", { "x-h2g-proxy-secret": "s3cret" }));
    expect(passedThrough(res)).toBe(true);
  });

  it("a wrong or missing secret meets the normal gate", async () => {
    process.env.H2G_PROXY_SECRET = "s3cret";
    expect((await proxy(req("/api/settings", { "x-h2g-proxy-secret": "s3crez" }))).status).toBe(401);
    expect((await proxy(req("/api/settings"))).status).toBe(401);
  });

  it("without H2G_PROXY_SECRET the header does nothing", async () => {
    const res = await proxy(req("/api/settings", { "x-h2g-proxy-secret": "" }));
    expect(res.status).toBe(401);
    const res2 = await proxy(req("/api/settings", { "x-h2g-proxy-secret": "anything" }));
    expect(res2.status).toBe(401);
  });

  it("vouches even in production with no password set, and only for the secret", async () => {
    delete process.env.H2G_PASSWORD;
    vi.stubEnv("NODE_ENV", "production");
    process.env.H2G_PROXY_SECRET = "s3cret";
    expect(passedThrough(await proxy(req("/dashboard", { "x-h2g-proxy-secret": "s3cret" })))).toBe(true);
    expect((await proxy(req("/api/settings"))).status).toBe(401);
    vi.unstubAllEnvs();
  });
});
