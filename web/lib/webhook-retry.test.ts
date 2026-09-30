import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncOneResult } from "@/lib/sync-one";
import {
  WEBHOOK_DEFAULTS,
  runStagedSync,
  stagedSyncsInFlight,
  startStagedSync,
  webhookRetryConfig,
  type AttemptOutcome,
  type WebhookRetryConfig,
} from "./webhook-retry";

const CONFIG: WebhookRetryConfig = { delaySeconds: 300, retryIntervalSeconds: 600, maxAttempts: 3, maxInFlight: 4 };

function result(status: string, hevyId = "w1"): AttemptOutcome {
  return {
    busy: false,
    result: { status, workout: { hevy_id: hevyId, title: "Push day", start_time: null } } as unknown as SyncOneResult,
  };
}

/** An attempt that answers from a script, one entry per call. */
function scripted(...answers: Array<AttemptOutcome | Error>) {
  return vi.fn(async (_opts: { mergeOnly: boolean; targetHevyId?: string }) => {
    const next = answers.shift();
    if (!next) throw new Error("attempt called more often than scripted");
    if (next instanceof Error) throw next;
    return next;
  });
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("webhookRetryConfig", () => {
  it("uses the Python server's defaults", () => {
    expect(webhookRetryConfig({})).toEqual(WEBHOOK_DEFAULTS);
  });

  it("reads the same variable names the Python server read", () => {
    expect(
      webhookRetryConfig({
        WEBHOOK_DELAY_SECONDS: "60",
        WEBHOOK_RETRY_INTERVAL_SECONDS: "120",
        WEBHOOK_MAX_ATTEMPTS: "5",
        WEBHOOK_MAX_INFLIGHT: "2",
      }),
    ).toEqual({ delaySeconds: 60, retryIntervalSeconds: 120, maxAttempts: 5, maxInFlight: 2 });
  });

  it("falls back to the default for anything that is not a whole number in range", () => {
    // Each of these coerces to something harmful with Number(): "" is 0,
    // "-1" skips the loop, "1e10" overflows setTimeout into a 1 ms timer.
    for (const bad of ["abc", "-1", "3.5", "1e3", "0x10", "1e10", "99999999"]) {
      expect(webhookRetryConfig({ WEBHOOK_DELAY_SECONDS: bad }).delaySeconds).toBe(300);
    }
    expect(webhookRetryConfig({ WEBHOOK_DELAY_SECONDS: "  " }).delaySeconds).toBe(300);
    expect(webhookRetryConfig({ WEBHOOK_MAX_ATTEMPTS: "0" }).maxAttempts).toBe(3);
    expect(webhookRetryConfig({ WEBHOOK_MAX_ATTEMPTS: "11" }).maxAttempts).toBe(3);
    expect(webhookRetryConfig({ WEBHOOK_MAX_INFLIGHT: "0" }).maxInFlight).toBe(4);
  });

  it("allows zero waits, for a user who wants the attempts back to back", () => {
    const c = webhookRetryConfig({ WEBHOOK_DELAY_SECONDS: "0", WEBHOOK_RETRY_INTERVAL_SECONDS: "0" });
    expect(c.delaySeconds).toBe(0);
    expect(c.retryIntervalSeconds).toBe(0);
  });
});

describe("runStagedSync", () => {
  it("waits, tries merge-only, and lets only the last attempt upload", async () => {
    const attempt = scripted(result("merge_pending"), result("merge_pending"), result("synced"));
    const sleep = vi.fn(async (_ms: number) => {});
    const end = await runStagedSync(CONFIG, { attempt, sleep });

    expect(end).toEqual({ outcome: "done", attempt: 3, status: "synced" });
    expect(attempt.mock.calls.map((c) => c[0].mergeOnly)).toEqual([true, true, false]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([300_000, 600_000, 600_000]);
  });

  it("stops at the first attempt that syncs, which is where a replace match now lands", async () => {
    // The Python bug: a replace match came back as a merge fallback and was
    // refused, so every workout waited for attempt 3. The engine now reports
    // it as synced on attempt 1, and the runner must stop there.
    const attempt = scripted(result("synced"));
    const sleep = vi.fn(async (_ms: number) => {});
    const end = await runStagedSync(CONFIG, { attempt, sleep });
    expect(end).toEqual({ outcome: "done", attempt: 1, status: "synced" });
    expect(attempt).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce(); // the initial delay, and no retry wait
  });

  it("asks for the pending workout by id once it knows it", async () => {
    const attempt = scripted(result("merge_pending", "w7"), result("merge_pending", "w7"), result("synced", "w7"));
    await runStagedSync(CONFIG, { attempt, sleep: async () => {} });
    expect(attempt.mock.calls.map((c) => c[0].targetHevyId)).toEqual([undefined, "w7", "w7"]);
  });

  it("retries on a busy lock and on a thrown attempt", async () => {
    const attempt = scripted({ busy: true }, new Error("Garmin 500"), result("synced"));
    const end = await runStagedSync(CONFIG, { attempt, sleep: async () => {} });
    expect(end).toEqual({ outcome: "done", attempt: 3, status: "synced" });
  });

  it("gives up after the last attempt without rejecting", async () => {
    const attempt = scripted(new Error("a"), new Error("b"), new Error("c"));
    const end = await runStagedSync(CONFIG, { attempt, sleep: async () => {} });
    expect(end).toEqual({ outcome: "gave_up", attempts: 3, last: "error: c" });
  });

  it("gives up rather than uploading when the last attempt finds the lock busy", async () => {
    const attempt = scripted(result("merge_pending"), result("merge_pending"), { busy: true });
    const end = await runStagedSync(CONFIG, { attempt, sleep: async () => {} });
    expect(end).toEqual({ outcome: "gave_up", attempts: 3, last: "busy" });
  });

  it.each(["deferred", "processing", "failed", "skipped", "none", "error", "needs_review"])(
    "does not re-drive a %s answer",
    async (status) => {
      const attempt = scripted(result(status));
      const end = await runStagedSync(CONFIG, { attempt, sleep: async () => {} });
      expect(end).toEqual({ outcome: "done", attempt: 1, status });
      expect(attempt).toHaveBeenCalledOnce();
    },
  );

  it("against an engine without merge-only, stops after the first attempt's grace deferral", async () => {
    // Such an engine ignores mergeOnly and never says merge_pending. The route
    // passes respectGrace on the early attempts, so it defers, and nothing is
    // uploaded ahead of the watch.
    const attempt = scripted(result("deferred"));
    const end = await runStagedSync(CONFIG, { attempt, sleep: async () => {} });
    expect(end.outcome).toBe("done");
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("with one attempt allowed, that attempt is the upload", async () => {
    const attempt = scripted(result("synced"));
    await runStagedSync({ ...CONFIG, maxAttempts: 1 }, { attempt, sleep: async () => {} });
    expect(attempt.mock.calls[0][0].mergeOnly).toBe(false);
  });

  it("resolves even when the wait itself throws", async () => {
    const attempt = scripted();
    const end = await runStagedSync(CONFIG, {
      attempt,
      sleep: async () => {
        throw new Error("timer broke");
      },
    });
    expect(end).toEqual({ outcome: "gave_up", attempts: 0, last: "error: timer broke" });
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe("startStagedSync", () => {
  it("caps the staged syncs in flight and frees a slot when one ends", async () => {
    const gates: Array<() => void> = [];
    const sleep = () => new Promise<void>((r) => gates.push(r));
    const attempt = vi.fn(async () => result("synced"));
    const config = { ...CONFIG, maxInFlight: 2 };

    expect(startStagedSync(config, { attempt, sleep })).toEqual({ accepted: true });
    expect(startStagedSync(config, { attempt, sleep })).toEqual({ accepted: true });
    // Counted at accept time, before any wait has started.
    expect(startStagedSync(config, { attempt, sleep })).toEqual({ accepted: false, inFlight: 2 });
    expect(stagedSyncsInFlight()).toBe(2);

    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[0]();
    await vi.waitFor(() => expect(stagedSyncsInFlight()).toBe(1));
    expect(startStagedSync(config, { attempt, sleep })).toEqual({ accepted: true });

    // Let the rest finish so this test leaves nothing in flight.
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[1]();
    gates[2]();
    await vi.waitFor(() => expect(stagedSyncsInFlight()).toBe(0));
  });
});
