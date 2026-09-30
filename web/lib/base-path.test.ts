import { describe, expect, it, vi } from "vitest";

describe("withBasePath", () => {
  it("returns the path unchanged without a base path", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const { withBasePath } = await import("./base-path");
    expect(withBasePath("/api/sync")).toBe("/api/sync");
  });

  it("prefixes root-absolute paths only", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/tools/h2g");
    const { withBasePath } = await import("./base-path");
    expect(withBasePath("/api/sync?x=1")).toBe("/tools/h2g/api/sync?x=1");
    expect(withBasePath("//evil.example/x")).toBe("//evil.example/x");
    expect(withBasePath("https://example.com/")).toBe("https://example.com/");
    vi.unstubAllEnvs();
  });
});
