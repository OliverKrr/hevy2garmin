"use client";

import { useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";

/**
 * The timezone, asked for during setup (#639).
 *
 * It used to live only in Settings, and the README documented it under "My
 * activity shows the wrong time on Strava" — a symptom you meet after a batch of
 * workouts is already on Garmin at the wrong time. Asking here moves it before
 * the damage, and the browser already knows the answer, so in the normal case
 * there is nothing to type and the only action is Save.
 *
 * The field is uncontrolled on purpose. The browser's zone is only knowable on
 * the client, so a controlled value would either mismatch the server's HTML at
 * hydration or need a setState inside the effect, which
 * `react-hooks/set-state-in-effect` rejects and which does cause the cascading
 * render it warns about. Writing the DOM node from the effect is the case that
 * rule is written to allow.
 */
export function SetupTimezone({ current }: { current: string | null }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only when nothing is stored and nothing has been typed: a value the user
    // already chose must never be replaced by the browser's guess.
    if (current) return;
    const el = ref.current;
    if (!el || el.value) return;
    try {
      el.value = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      /* a browser that cannot say leaves the field blank, as before */
    }
  }, [current]);

  async function save() {
    const value = (ref.current?.value ?? "").trim();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_profile: { timezone: value } }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setSaved(value || "blank, so times stay in UTC");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-3 text-sm text-text-secondary">
        Your workouts carry this as their local time. Without it a 6am session can appear at
        3am once Garmin passes it to Strava. Prefilled from your browser when empty.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={ref}
          id="setup-timezone"
          type="text"
          defaultValue={current ?? ""}
          placeholder="e.g. Europe/Athens"
          aria-label="Timezone (IANA)"
          className="min-w-[16rem] flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {current && !saved && (
        <p className="mt-2 text-xs text-text-muted">Currently saved as {current}.</p>
      )}
      {saved && <p className="mt-2 text-xs text-success">Saved as {saved}.</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
