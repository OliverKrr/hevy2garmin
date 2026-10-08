/**
 * The sync schedule of a self-hosted server whose cron calls /api/cron/sync
 * (H2G_SERVER_SYNC_SCHEDULE, e.g. "every 2 hours").
 *
 * The dashboard's auto-sync toggle and interval drive the GitHub Actions
 * workflow on Vercel. Off Vercel they only write app_cache 'auto_sync', which
 * nothing reads, so a server that syncs from its own cron showed "Off — sync
 * only when you run it". With this set, the pages show the schedule the server
 * actually runs and hide the controls that would do nothing. Unset, nothing
 * changes.
 */
export function serverSyncSchedule(): string | null {
  const s = process.env.H2G_SERVER_SYNC_SCHEDULE?.trim();
  return s ? s : null;
}
