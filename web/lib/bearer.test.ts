import { describe, it, expect } from "vitest";
import { bearerMatches } from "./bearer";

describe("bearerMatches", () => {
  it("accepts the exact secret, with the scheme in any case", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects anything that is not exactly the secret", () => {
    expect(bearerMatches("Bearer nope", "s3cret")).toBe(false);
    expect(bearerMatches("Bearer s3cre", "s3cret")).toBe(false); // a prefix
    expect(bearerMatches("Bearer s3cretX", "s3cret")).toBe(false); // longer
    expect(bearerMatches("Bearer S3CRET", "s3cret")).toBe(false); // the token is case-sensitive
    expect(bearerMatches("s3cret", "s3cret")).toBe(false); // no scheme
    expect(bearerMatches("Basic s3cret", "s3cret")).toBe(false);
    expect(bearerMatches("Bearer ", "s3cret")).toBe(false);
    expect(bearerMatches("", "s3cret")).toBe(false);
    expect(bearerMatches(null, "s3cret")).toBe(false);
  });

  it("never matches an empty secret, so a missing check fails closed", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer x", "")).toBe(false);
  });
});
