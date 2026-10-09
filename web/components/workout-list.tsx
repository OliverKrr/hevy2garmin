"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { editedAfterResync, showsEditedBadge, type ResyncOutcome } from "@/lib/resync-row";
import { WorkoutRow, type WorkoutItem } from "./workout-row";

/**
 * The Workouts page's list of synced and in-flight workouts.
 *
 * The "Edited in Hevy" badges (#701) load after the list has rendered, from
 * /api/edited-workouts, so the page never waits on Hevy. Any failure there
 * means no badges and nothing else: no banner, no error, the list as it was.
 * A successful Resync takes its row's badge away at once; the ledger row it
 * rewrote keeps it away after a reload.
 */
export function WorkoutList({ items }: { items: WorkoutItem[] }) {
  const [editedIds, setEditedIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch(withBasePath("/api/edited-workouts"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { editedIds?: unknown } | null) => {
        const ids = Array.isArray(d?.editedIds) ? d.editedIds.filter((id): id is string => typeof id === "string") : [];
        if (!cancelled) setEditedIds(new Set(ids));
      })
      .catch(() => {
        // No badges. The list is complete without them.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onResyncOutcome(hevyId: string, outcome: ResyncOutcome) {
    setEditedIds((current) => editedAfterResync(current, hevyId, outcome));
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-elevated">
      {items.map((w) => (
        <WorkoutRow
          key={w.hevy_id}
          item={w}
          edited={showsEditedBadge(w, editedIds)}
          onResyncOutcome={onResyncOutcome}
        />
      ))}
    </ul>
  );
}
