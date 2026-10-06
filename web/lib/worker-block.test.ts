import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { installWorkerBlock, isWorkerHost } from "./worker-block";
import { proxy, DIRECT_LOGIN_CSP } from "../proxy";

/**
 * The Worker ban (fork, H2G_DIRECT_GARMIN_LOGIN). Three guards, tested here:
 * the server-side fetch block, the browser-side CSP header, and an inventory of
 * every *.workers.dev address in the app and its Garmin dependencies, which
 * fails as soon as an upstream rebase or a dependency bump adds a new one.
 */

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.H2G_DIRECT_GARMIN_LOGIN;
});
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

describe("isWorkerHost", () => {
  it.each([
    ["garmin-auth-sso.gkos.workers.dev", true],
    ["HEVY2GARMIN-EXCHANGE-DI.gkos.workers.dev.", true],
    ["workers.dev", true],
    ["sso.garmin.com", false],
    ["diauth.garmin.com", false],
    ["workers.dev.example.com", false],
    ["notworkers.dev", false],
  ])("%s → %s", (host, blocked) => {
    expect(isWorkerHost(host)).toBe(blocked);
  });
});

describe("the server-side fetch block", () => {
  it("is not installed while the flag is off", () => {
    const target = { fetch: vi.fn() as unknown as typeof fetch };
    expect(installWorkerBlock(target)).toBe(false);
  });

  it("refuses any *.workers.dev request before it is sent, and passes everything else", async () => {
    process.env.H2G_DIRECT_GARMIN_LOGIN = "true";
    const inner = vi.fn(async () => new Response("ok"));
    const target = { fetch: inner as unknown as typeof fetch };
    expect(installWorkerBlock(target)).toBe(true);

    for (const url of [
      "https://garmin-auth-sso.gkos.workers.dev/login",
      new URL("https://hevy2garmin-exchange-di.gkos.workers.dev/exchange"),
      new Request("https://some-new-worker.example.workers.dev/"),
    ]) {
      await expect(target.fetch(url as never, { method: "POST" })).rejects.toThrow(/H2G_DIRECT_GARMIN_LOGIN blocks/);
    }
    expect(inner).not.toHaveBeenCalled();

    await target.fetch("https://sso.garmin.com/mobile/sso/en/sign-in");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("installs once, however often register() runs", () => {
    process.env.H2G_DIRECT_GARMIN_LOGIN = "true";
    const target = { fetch: vi.fn() as unknown as typeof fetch };
    installWorkerBlock(target);
    const once = target.fetch;
    installWorkerBlock(target);
    expect(target.fetch).toBe(once);
  });
});

describe("the browser-side CSP header", () => {
  beforeEach(() => {
    process.env.H2G_PASSWORD = "test-pw";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ n: 0 }))));
  });

  it("limits pages to connecting back to this server while the flag is on", async () => {
    process.env.H2G_DIRECT_GARMIN_LOGIN = "true";
    for (const path of ["/login", "/setup", "/api/settings"]) {
      const res = await proxy(new NextRequest(`http://h${path}`));
      expect(res.headers.get("content-security-policy")).toBe(DIRECT_LOGIN_CSP);
    }
    expect(DIRECT_LOGIN_CSP).toBe("connect-src 'self'");
  });

  it("is absent while the flag is off, so upstream's deploy is unchanged", async () => {
    const res = await proxy(new NextRequest("http://h/login"));
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});

describe("inventory of Worker addresses (fails on a new one)", () => {
  /**
   * Every *.workers.dev address the app or its Garmin dependencies contain,
   * with where it is and what keeps it from being used on a direct-login
   * server. A new entry means new code can reach a Worker: route it through
   * H2G_DIRECT_GARMIN_LOGIN (or prove the block covers it), then add it here.
   */
  const KNOWN: Record<string, string> = {
    "components/connect-garmin.tsx hevy2garmin-exchange-di.gkos.workers.dev":
      "manual-ticket exchange; with directLogin it posts to /api/garmin-ticket-exchange instead",
    "node_modules/garmin-auth/dist/sso-worker.js garmin-auth-sso.gkos.workers.dev":
      "default login Worker; lib/garmin-login-worker.ts never uses it while the flag is on",
    "node_modules/garmin-auth/dist/sso-worker.d.ts garmin-auth-sso.gkos.workers.dev": "type declaration of the same default",
  };
  const WEB = join(__dirname, "..");
  const SCAN = ["app", "components", "lib", "proxy.ts", "instrumentation.ts", "next.config.ts",
    "node_modules/garmin-auth/dist", "node_modules/hevy2garmin/dist"];
  const SKIP = /\.test\.|\/garmin-sso-local\/worker\.js$/;

  function files(p: string): string[] {
    const abs = join(WEB, p);
    if (!statSync(abs, { throwIfNoEntry: false })) return [];
    if (statSync(abs).isFile()) return [abs];
    return readdirSync(abs).flatMap((f) => files(join(p, f)));
  }

  it("matches the reviewed list exactly", () => {
    const found = new Set<string>();
    for (const f of SCAN.flatMap(files)) {
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f) || SKIP.test(f)) continue;
      for (const m of readFileSync(f, "utf8").matchAll(/[a-z0-9.-]+\.workers\.dev/gi)) {
        found.add(`${relative(WEB, f)} ${m[0].toLowerCase()}`);
      }
    }
    expect([...found].sort()).toEqual(Object.keys(KNOWN).sort());
  });
});
