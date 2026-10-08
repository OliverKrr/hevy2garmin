import { describe, it, expect } from "vitest";
import { resyncOutcome } from "./resync-outcome";

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
