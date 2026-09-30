/**
 * The Strava cleanup's two durable values, bound to `app_cache`.
 *
 * `strava_tokens` = { refresh_token } and `strava_observations` = { records }
 * are the keys and shapes the Python wrote, so a database carried over from a
 * Python deployment keeps its rotated token and its open observations.
 *
 * Both have to be durable. Strava invalidates a refresh token once it issues
 * the next one, so a rotation kept only in memory locks the deployment out at
 * the next cold start. And an observation is worthless unless a later request
 * can read the delete-time baseline back.
 */
import type { StravaObservationRecord, StravaStore } from "hevy2garmin";
import type { Sql } from "./pending-store";

const TOKENS_KEY = "strava_tokens";
const OBSERVATIONS_KEY = "strava_observations";

async function read(sql: Sql, key: string): Promise<unknown> {
  const rows = (await sql`
    SELECT value FROM app_cache WHERE key = ${key} LIMIT 1
  `) as Array<{ value: unknown }>;
  return rows[0]?.value ?? null;
}

async function write(sql: Sql, key: string, value: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO app_cache (key, value, updated_at)
    VALUES (${key}, ${sql.json(value as never)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

export function postgresStravaStore(sql: Sql): StravaStore {
  return {
    loadRefreshToken: async () => {
      const v = await read(sql, TOKENS_KEY);
      const t = v && typeof v === "object" ? (v as { refresh_token?: unknown }).refresh_token : null;
      return typeof t === "string" && t ? t : null;
    },
    saveRefreshToken: (token) => write(sql, TOKENS_KEY, { refresh_token: token }),
    // Parsed by the engine, which trusts nothing it reads back.
    loadObservations: () => read(sql, OBSERVATIONS_KEY),
    saveObservations: (records: StravaObservationRecord[]) => write(sql, OBSERVATIONS_KEY, { records }),
  };
}
