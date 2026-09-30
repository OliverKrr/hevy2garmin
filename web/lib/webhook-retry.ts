/**
 * The staged sync behind the Hevy webhook on a self-hosted server.
 *
 * Hevy fires the webhook when a workout is saved, and the watch's own activity
 * usually reaches Garmin a few minutes later. Syncing at once either uploads a
 * copy the merge would have avoided or, with the grace period on, does nothing
 * and leaves the workout to the next cron. So the sync is staged, as the Python
 * server did it: wait, try merge-only a few times, and let only the last
 * attempt upload a fresh activity, so the workout still syncs when no watch
 * recorded it.
 *
 * It runs in this process, detached from the request, and not in `after()`.
 * `next start` runs every pending `after()` callback before it exits, so a
 * callback that waits 25 minutes would hold every restart hostage. The
 * trade-off is the Python one: a restart drops the staged work, and the
 * scheduled `/api/cron/sync` picks the workout up. Timers are unref'd for the
 * same reason, so a wait never keeps the process alive.
 *
 * Only for long-running servers. On Vercel the process stops at the response,
 * and the route keeps its single inline sync there.
 */
import type { SyncOneResult } from "@/lib/sync-one";

/** Defaults and names match the Python server, so an existing .env carries over. */
export const WEBHOOK_DEFAULTS = {
  delaySeconds: 300,
  retryIntervalSeconds: 600,
  maxAttempts: 3,
  maxInFlight: 4,
} as const;

export interface WebhookRetryConfig {
  delaySeconds: number;
  retryIntervalSeconds: number;
  maxAttempts: number;
  maxInFlight: number;
}

type Env = Record<string, string | undefined>;

/**
 * Read one bounded integer from the environment.
 *
 * A malformed or out-of-range value falls back to the default rather than
 * being coerced, because the coerced values are the dangerous ones: `Number("")`
 * is 0, a negative count would skip the upload attempt entirely, and a delay
 * past 2^31 ms makes Node fire the timer after 1 ms instead of never.
 */
function envInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim();
  if (!/^\d+$/.test(v)) {
    console.warn(`[webhook] ${name}=${JSON.stringify(raw)} is not a whole number; using ${fallback}`);
    return fallback;
  }
  const n = Number(v);
  if (n < min || n > max) {
    console.warn(`[webhook] ${name}=${n} is outside ${min}..${max}; using ${fallback}`);
    return fallback;
  }
  return n;
}

export function webhookRetryConfig(env: Env = process.env): WebhookRetryConfig {
  const d = WEBHOOK_DEFAULTS;
  return {
    delaySeconds: envInt(env, "WEBHOOK_DELAY_SECONDS", d.delaySeconds, 0, 86_400),
    retryIntervalSeconds: envInt(env, "WEBHOOK_RETRY_INTERVAL_SECONDS", d.retryIntervalSeconds, 0, 86_400),
    maxAttempts: envInt(env, "WEBHOOK_MAX_ATTEMPTS", d.maxAttempts, 1, 10),
    maxInFlight: envInt(env, "WEBHOOK_MAX_INFLIGHT", d.maxInFlight, 1, 100),
  };
}

/** What one attempt reported. `busy` means another sync held the lock. */
export type AttemptOutcome = { busy: true } | { busy: false; result: SyncOneResult };

export interface StagedSyncDeps {
  /**
   * One sync attempt under the sync lock. `mergeOnly` is true on every attempt
   * but the last. `targetHevyId` is set once an attempt has named the workout
   * it is waiting on. May throw; the runner catches it.
   */
  attempt(opts: { mergeOnly: boolean; targetHevyId?: string }): Promise<AttemptOutcome>;
  /** Injectable for tests. Default: an unref'd timer. */
  sleep?: (ms: number) => Promise<void>;
}

const unrefSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** Why the runner stopped, for tests and the log line. */
export type StagedSyncEnd =
  | { outcome: "done"; attempt: number; status: string }
  | { outcome: "gave_up"; attempts: number; last: string };

/**
 * Run the staged attempts. NEVER rejects: it is detached from any request,
 * so a rejection would surface as an unhandled one with nobody to handle it.
 *
 * Retries on `merge_pending`, on a busy lock and on a thrown error, and stops
 * on any other answer. The rest are final in the sense that matters here:
 * `synced`, `skipped` and `none` need nothing more, `processing` and `failed`
 * are the recovery path's to resolve and must not be re-driven from here, and
 * `deferred` means a grace period or a claim held elsewhere, which the cron
 * handles. An engine older than merge-only never answers `merge_pending`, so
 * against one this stops after the first attempt, which is the old behaviour
 * five minutes later.
 */
export async function runStagedSync(config: WebhookRetryConfig, deps: StagedSyncDeps): Promise<StagedSyncEnd> {
  const sleep = deps.sleep ?? unrefSleep;
  let last = "not started";
  // The workout a merge_pending answer was about. Later attempts ask for it by
  // id: the engine otherwise takes the next candidate, and if the scheduled
  // sync finished this one in between, the last attempt would upload some
  // other workout without the merge-first wait it was owed.
  let target: string | undefined;
  try {
    await sleep(config.delaySeconds * 1000);
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      const isLast = attempt === config.maxAttempts;
      const tag = `[webhook] attempt ${attempt}/${config.maxAttempts}`;
      try {
        const out = await deps.attempt({ mergeOnly: !isLast, targetHevyId: target });
        if (out.busy) {
          last = "busy";
          console.info(`${tag}: another sync is running`);
        } else if (out.result.status === "merge_pending") {
          last = "merge_pending";
          target = out.result.workout?.hevy_id ?? target;
          console.info(`${tag}: no watch activity on Garmin yet`);
        } else {
          const title = out.result.workout?.title;
          // Quoted: the title is the user's text from Hevy, and a raw newline
          // in it would forge a second log line.
          console.info(`${tag}: ${out.result.status}${title ? ` ${JSON.stringify(title)}` : ""}`);
          return { outcome: "done", attempt, status: out.result.status };
        }
      } catch (err) {
        last = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        console.error(`${tag} failed: ${last}`);
      }
      if (!isLast) await sleep(config.retryIntervalSeconds * 1000);
    }
    console.warn(`[webhook] still pending after ${config.maxAttempts} attempts; the scheduled sync will retry`);
    return { outcome: "gave_up", attempts: config.maxAttempts, last };
  } catch (err) {
    // Only `sleep` or a log call can land here. Report and stop.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] staged sync stopped: ${message}`);
    return { outcome: "gave_up", attempts: 0, last: `error: ${message}` };
  }
}

/**
 * Staged syncs this process is running. Held strongly, and counted
 * synchronously at accept time, so two webhooks in the same tick cannot both
 * pass the cap.
 */
const inFlight = new Set<Promise<StagedSyncEnd>>();

export function stagedSyncsInFlight(): number {
  return inFlight.size;
}

export type StartOutcome = { accepted: true } | { accepted: false; inFlight: number };

/**
 * Start a staged sync unless `maxInFlight` are already running.
 *
 * Each one lives for up to delay + (attempts - 1) * interval, about 25 minutes
 * by default, so a burst of webhooks would otherwise stack up runs that only
 * queue on the sync lock. Past the cap the webhook is declined, not queued:
 * the runs already staged and the scheduled sync cover the workout.
 */
export function startStagedSync(
  config: WebhookRetryConfig,
  deps: StagedSyncDeps,
): StartOutcome {
  if (inFlight.size >= config.maxInFlight) {
    return { accepted: false, inFlight: inFlight.size };
  }
  const run: Promise<StagedSyncEnd> = runStagedSync(config, deps).finally(() => {
    inFlight.delete(run);
  });
  inFlight.add(run);
  return { accepted: true };
}
