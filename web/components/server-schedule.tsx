/**
 * Auto-sync on a self-hosted server, where its own cron syncs and the Hevy
 * webhook syncs each finished workout (fork-only, see lib/server-schedule.ts).
 * Replaces the dashboard's toggle, which would do nothing there.
 */
export function ServerSchedule({ schedule }: { schedule: string }) {
  return (
    <section className="rounded-xl border border-border bg-surface-elevated p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">Auto-sync</h2>
        <span className="text-sm font-medium text-teal">On</span>
      </div>
      <p className="mt-0.5 text-sm text-text-secondary">
        This server syncs {schedule}, and the Hevy webhook syncs each workout shortly after you finish it.
        The schedule is part of the server&apos;s deployment, not a setting here.
      </p>
    </section>
  );
}
