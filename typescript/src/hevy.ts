/** Hevy API v1 client — TS port of hevy2garmin hevy.py::HevyClient. */
export const DEFAULT_BASE_URL = "https://api.hevyapp.com/v1";
export const API_CALL_DELAY_MS = 1000;

export class HevyAuthError extends Error {
  constructor(msg: string) { super(msg); this.name = "HevyAuthError"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One entry from `GET /v1/workouts/events`. An `updated` event carries the
 * workout as it now is. Other types, such as `deleted`, are passed through
 * as Hevy sent them; their shape is not relied on here.
 */
export interface HevyWorkoutEvent {
  type: string;
  workout?: { id?: string; updated_at?: string; created_at?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** One page of workout events. */
export interface HevyWorkoutEventsPage {
  events?: HevyWorkoutEvent[];
  page?: number;
  page_count?: number;
}

/** Injection points, so tests need not stub globals or actually wait. */
export interface HevyClientOptions {
  fetchImpl?: typeof fetch;
  /** Pause after each call. Defaults to the module's pacing constant. */
  callDelayMs?: number;
  /**
   * Base for the retry backoff, waited as `base * attempt`.
   *
   * Injectable because without it the retry path is untestable: the real
   * backoff totals twenty seconds across five attempts, so any test that
   * exercises a 429 or a 500 either times out or takes that long.
   */
  retryBackoffMs?: number;
}

export class HevyClient {
  private baseUrl: string;
  private key: string;
  private fetchImpl: typeof fetch;
  private callDelayMs: number;
  private retryBackoffMs: number;

  constructor(apiKey?: string, baseUrl?: string, opts: HevyClientOptions = {}) {
    this.baseUrl = (baseUrl ?? process.env.HEVY_API_KEY_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.key = apiKey ?? process.env.HEVY_API_KEY ?? "";
    if (!this.key) throw new Error("Hevy API key required (apiKey arg or HEVY_API_KEY env).");
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.callDelayMs = opts.callDelayMs ?? API_CALL_DELAY_MS;
    this.retryBackoffMs = opts.retryBackoffMs ?? 2000;
  }

  private async get<T = any>(path: string, params?: Record<string, string | number>): Promise<T> {
    const qs = params ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : "";
    const url = `${this.baseUrl}${path}${qs}`;
    const retryStatus = new Set([429, 500, 502, 503, 504]);
    let res!: Response;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await this.fetchImpl(url, { headers: { "api-key": this.key, "Accept": "application/json" } });
      if (res.status === 401 || res.status === 403) {
        throw new HevyAuthError("Hevy API key invalid or expired (check Hevy Pro + regenerate at hevy.com/settings).");
      }
      if (retryStatus.has(res.status)) { await sleep(this.retryBackoffMs * (attempt + 1)); continue; }
      break;
    }
    if (!res.ok) throw new Error(`Hevy GET ${path} → ${res.status}`);
    await sleep(this.callDelayMs);
    return res.json() as Promise<T>;
  }

  /**
   * Replace a workout on Hevy (PUT /v1/workouts/{id}) with `body`, which is `{ workout: {...} }` in
   * Hevy's shape. Same handling as a read: 401/403 throws HevyAuthError, 429 and 5xx are retried
   * with backoff, any other failure throws with the status.
   */
  async updateWorkout<T = any>(workoutId: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}/workouts/${encodeURIComponent(workoutId)}`;
    const retryStatus = new Set([429, 500, 502, 503, 504]);
    let res!: Response;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await this.fetchImpl(url, {
        method: "PUT",
        headers: { "api-key": this.key, "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401 || res.status === 403) {
        throw new HevyAuthError("Hevy API key invalid or expired (check Hevy Pro + regenerate at hevy.com/settings).");
      }
      if (retryStatus.has(res.status)) { await sleep(this.retryBackoffMs * (attempt + 1)); continue; }
      break;
    }
    if (!res.ok) throw new Error(`Hevy PUT /v1/workouts/${workoutId} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    await sleep(this.callDelayMs);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getWorkoutCount(): Promise<number> {
    const d = await this.get<{ workout_count?: number }>("/workouts/count");
    return d.workout_count ?? 0;
  }
  getWorkouts(page = 1, pageSize = 10): Promise<{ workouts?: any[]; page_count?: number }> {
    return this.get("/workouts", { page, pageSize });
  }
  async getWorkout(workoutId: string): Promise<any | null> {
    try { return await this.get(`/workouts/${workoutId}`); } catch { return null; }
  }
  /** Fetch all workouts (paginated). */
  /** One page of routines. Ports `get_routines` at `hevy.py:124`. */
  async getRoutines(page = 1, pageSize = 10): Promise<{ routines?: any[]; page_count?: number }> {
    return this.get("/routines", { page, pageSize });
  }

  /**
   * Every routine, paginated.
   *
   * On the client rather than in the web app on purpose. The web reached this
   * endpoint directly and so inherited none of what `get` does: no retry, no
   * pacing, and a 401 surfaced as a bare status code instead of the named error
   * that carries the fix. It also capped at five pages and returned whatever it
   * had when a later page failed, so a rate-limited fragment of twelve routines
   * was indistinguishable from a complete list of four (#606).
   *
   * A failure here THROWS. Ports `fetch_all_routines` at `sync.py:899`.
   */
  async getAllRoutines(pageSize = 10): Promise<any[]> {
    const all: any[] = [];
    let page = 1;
    for (;;) {
      const d = await this.getRoutines(page, pageSize);
      const batch = d.routines ?? [];
      all.push(...batch);
      if (!batch.length || (d.page_count != null && page >= d.page_count)) break;
      page++;
    }
    return all;
  }

  /**
   * One page of workout events since `since` (an ISO timestamp), newest
   * first. Hevy reports a new workout as `updated` too, with `created_at`
   * equal to `updated_at`. `pageSize` is at most 10.
   */
  getWorkoutEvents(since: string, page = 1, pageSize = 10): Promise<HevyWorkoutEventsPage> {
    return this.get("/workouts/events", { page, pageSize, since });
  }

  /**
   * Every workout event since `since`, newest first, up to `maxPages` pages.
   *
   * A failure THROWS, as in `getAllRoutines`: a fragment returned in its place
   * would read as "nothing else changed". Stopping at `maxPages` is different,
   * a limit the caller chose, so it returns what it has and says so with
   * `truncated`, which is true only when Hevy had more pages to give.
   */
  async getWorkoutEventsSince(
    since: string,
    { maxPages = Infinity, pageSize = 10 }: { maxPages?: number; pageSize?: number } = {},
  ): Promise<{ events: HevyWorkoutEvent[]; truncated: boolean }> {
    const events: HevyWorkoutEvent[] = [];
    for (let page = 1; ; page++) {
      const d = await this.getWorkoutEvents(since, page, pageSize);
      const batch = d.events ?? [];
      events.push(...batch);
      const lastPage = !batch.length || (d.page_count != null && page >= d.page_count);
      if (lastPage) return { events, truncated: false };
      if (page >= maxPages) return { events, truncated: true };
    }
  }

  async getAllWorkouts(sincePage = 1, pageSize = 10): Promise<any[]> {
    const all: any[] = [];
    let page = sincePage;
    for (;;) {
      const d = await this.getWorkouts(page, pageSize);
      const batch = d.workouts ?? [];
      all.push(...batch);
      if (!batch.length || (d.page_count != null && page >= d.page_count)) break;
      page++;
    }
    return all;
  }
}
