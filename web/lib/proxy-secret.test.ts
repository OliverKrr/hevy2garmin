import { describe, it, expect, afterEach } from "vitest";
import { proxySecretMatches } from "./proxy-secret";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe("proxySecretMatches", () => {
  it("vouches only for the configured secret", async () => {
    process.env.H2G_PROXY_SECRET = "s3cret";
    expect(await proxySecretMatches("s3cret")).toBe(true);
    expect(await proxySecretMatches("s3crez")).toBe(false);
    expect(await proxySecretMatches("s3cret ")).toBe(false);
    expect(await proxySecretMatches(null)).toBe(false);
    expect(await proxySecretMatches("")).toBe(false);
  });

  it("vouches for nothing without H2G_PROXY_SECRET, not even an empty header", async () => {
    delete process.env.H2G_PROXY_SECRET;
    expect(await proxySecretMatches("")).toBe(false);
    expect(await proxySecretMatches("anything")).toBe(false);
  });
});
