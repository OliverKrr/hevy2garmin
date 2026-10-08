/**
 * Tests for the activity description text. Every set that is not a warmup is
 * a working set, as in the FIT file, so failure and drop sets count (#689).
 */
import { describe, it, expect } from "vitest";
import { generateDescription } from "../src/sync/description";

const workout = (exercises: { title: string; sets: Record<string, unknown>[] }[]) => ({ title: "Workout", exercises });

describe("generateDescription working sets", () => {
  it("counts normal, failure and drop sets", () => {
    const desc = generateDescription(workout([{ title: "Bench Press", sets: [
      { type: "normal", weight_kg: 80, reps: 8 },
      { type: "normal", weight_kg: 80, reps: 8 },
      { type: "failure", weight_kg: 80, reps: 6 },
      { type: "dropset", weight_kg: 60, reps: 10 },
    ] }]), null, null);
    expect(desc).toContain("• Bench Press: 4 sets · 80.0kg × 10");
  });

  it("lists an exercise logged with only failure sets", () => {
    const desc = generateDescription(workout([{ title: "Pull Up", sets: [
      { type: "failure", weight_kg: 0, reps: 12 },
      { type: "failure", weight_kg: 0, reps: 9 },
    ] }]), null, null);
    expect(desc).toContain("• Pull Up: 2 sets · 0.0kg × 12");
  });

  it("leaves warmups out of the working count, and warmup-only shows warmup sets", () => {
    const desc = generateDescription(workout([
      { title: "Squat", sets: [
        { type: "warmup", weight_kg: 60, reps: 10 },
        { type: "warmup", weight_kg: 80, reps: 5 },
        { type: "normal", weight_kg: 120, reps: 5 },
        { type: "failure", weight_kg: 120, reps: 4 },
      ] },
      { title: "Band Pull Apart", sets: [
        { type: "warmup", weight_kg: 0, reps: 15 },
        { type: "warmup", weight_kg: 0, reps: 15 },
      ] },
    ]), null, null);
    expect(desc).toContain("• Squat: 2 sets · 120.0kg × 5");
    expect(desc).toContain("• Band Pull Apart: 2 warmup sets");
  });

  it("counts a set with no type", () => {
    const desc = generateDescription(workout([{ title: "Curl", sets: [
      { type: "normal", weight_kg: 15, reps: 10 },
      { weight_kg: 15, reps: 10 },
    ] }]), null, null);
    expect(desc).toContain("• Curl: 2 sets · 15.0kg × 10");
  });

  it("takes the top weight and reps from a failure set", () => {
    const desc = generateDescription(workout([{ title: "Overhead Press", sets: [
      { type: "normal", weight_kg: 40, reps: 8 },
      { type: "failure", weight_kg: 45, reps: 11 },
    ] }]), null, null);
    expect(desc).toContain("• Overhead Press: 2 sets · 45.0kg × 11");
  });

  it("counts failure sets on cardio exercises", () => {
    const desc = generateDescription(workout([{ title: "Treadmill", sets: [
      { type: "normal", distance_meters: 3000, duration_seconds: 900 },
      { type: "failure", distance_meters: 2000, duration_seconds: 900 },
    ] }]), null, null);
    expect(desc).toContain("• Treadmill: 2 sets · 5.0km · 30min");
  });
});
