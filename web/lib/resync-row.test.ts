import { describe, it, expect } from "vitest";
import { canResync, resyncOutcome } from "./resync-row";

/**
 * What a workout row says after Resync (#701). Three outcomes the user acts on
 * differently: it worked, the Garmin activity is gone, or something failed.
 * Anything not positively a success is shown as one of the other two.
 */
describe("resyncOutcome", () => {
  it("synced → success", () => {
    expect(resyncOutcome(true, { status: "synced" })).toEqual({ kind: "success", text: "Resynced from Hevy." });
  });

  it("target_missing → the activity is no longer on Garmin", () => {
    const o = resyncOutcome(true, { status: "target_missing" });
    expect(o.kind).toBe("missing");
    expect(o.text).toMatch(/no longer on Garmin/);
  });

  it("an HTTP error shows the route's message", () => {
    expect(resyncOutcome(false, { error: "This engine version does not support resync yet." })).toEqual({
      kind: "error",
      text: "This engine version does not support resync yet.",
    });
  });

  it("an engine error shows the engine's message", () => {
    const o = resyncOutcome(true, { status: "error", error: "Garmin dropped the exercise names" });
    expect(o).toEqual({ kind: "error", text: "Garmin dropped the exercise names" });
  });

  it("any other status is an error naming it, never a success", () => {
    expect(resyncOutcome(true, { status: "skipped" })).toEqual({
      kind: "error",
      text: "Resync did not complete (skipped).",
    });
    expect(resyncOutcome(true, {}).kind).toBe("error");
    expect(resyncOutcome(false, {}).kind).toBe("error");
  });
});

/**
 * Which rows offer Resync. Only a workout this app synced has an activity it
 * can safely rewrite: a "Marked as synced" row points at whatever the user
 * said, and a skipped one at nothing of ours.
 */
describe("canResync", () => {
  const row = (state: string, garmin_activity_id: string | null = "4242", kind: "terminal" | "pending" = "terminal") => ({
    kind,
    state,
    garmin_activity_id,
  });

  it("a synced row with a Garmin activity", () => {
    expect(canResync(row("success"))).toBe(true);
  });

  it("not without a Garmin activity", () => {
    expect(canResync(row("success", null))).toBe(false);
  });

  it("not on a row marked as synced by hand, or skipped", () => {
    expect(canResync(row("manual"))).toBe(false);
    expect(canResync(row("skipped"))).toBe(false);
  });

  it("not on an in-flight row", () => {
    expect(canResync(row("success", "4242", "pending"))).toBe(false);
  });
});
