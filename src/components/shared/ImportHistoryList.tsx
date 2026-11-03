"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { formatDate } from "@/lib/utils";

export interface ImportHistoryRow {
  id: string;
  fileName: string;
  uploadedAt: string;
  periodLabel: string | null;
  status: "pending_review" | "committed" | "failed";
  rowCount: number;
  periodId: string | null;
  /** Human-readable labels of the metrics this import actually touched —
   *  for a Manual Entry submission, this is exactly the set of ticked
   *  metrics it was saved with (see ManualEntryForm.tsx and the gate-row
   *  logging in /api/import/manual). Empty for PDF imports and anything
   *  else that doesn't carry a deliberate per-metric selection. */
  fieldsTouched: string[];
}

/** Calls the same single-import delete route the lone Trash2 button always
 *  has -- bulk delete is just this, called once per selected import. Always
 *  SEQUENTIAL (never Promise.all): the route decides whether to delete the
 *  whole period by re-querying "does any OTHER import still point at this
 *  period" at the moment it runs. If two imports sharing one period were
 *  deleted in parallel, both requests would see each other as a surviving
 *  sibling and neither would ever delete the period, orphaning it. Calling
 *  them one at a time means the second call sees the first's deletion
 *  already applied, so the period correctly goes when the last import
 *  pointing at it is removed. */
async function deleteOne(importId: string): Promise<{ ok: true; deletedPeriod: boolean; periodLabel?: string; message?: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/import/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importId }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.detail ? `${data.error} (${data.detail})` : data.error ?? "Failed to delete." };
    }
    return { ok: true, deletedPeriod: Boolean(data.deletedPeriod), periodLabel: data.periodLabel, message: data.message };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unexpected error." };
  }
}

export function ImportHistoryList({ imports }: { imports: ImportHistoryRow[] }) {
  const router = useRouter();
  const { showToast } = useToast();

  // Single-item delete (unchanged) -----------------------------------------
  const [pending, setPending] = React.useState<ImportHistoryRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // Multi-select bulk delete -------------------------------------------------
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = React.useState(false);
  const [bulkDeleting, setBulkDeleting] = React.useState(false);
  const selectAllRef = React.useRef<HTMLInputElement>(null);

  const busy = deleting || bulkDeleting;

  const allSelected = imports.length > 0 && selected.size === imports.length;
  const someSelected = selected.size > 0 && !allSelected;

  React.useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === imports.length ? new Set() : new Set(imports.map((i) => i.id))));
  }

  // For each selected import, whether deleting it (together with the rest
  // of this batch) will remove its whole period -- true only when EVERY
  // import that shares that periodId is also part of this selection. An
  // import whose period is still referenced by something outside the
  // selection just loses its own audit-trail record; the day's data stays,
  // same distinction the single-delete dialog already makes.
  const periodsFullyCovered = React.useMemo(() => {
    const byPeriod = new Map<string, ImportHistoryRow[]>();
    for (const imp of imports) {
      if (!imp.periodId) continue;
      const arr = byPeriod.get(imp.periodId) ?? [];
      arr.push(imp);
      byPeriod.set(imp.periodId, arr);
    }
    const covered = new Set<string>();
    for (const [periodId, group] of byPeriod) {
      if (group.every((g) => selected.has(g.id))) covered.add(periodId);
    }
    return covered;
  }, [imports, selected]);

  const selectedRows = imports.filter((i) => selected.has(i.id));
  const periodsToDelete = new Set(selectedRows.map((r) => r.periodId).filter((id): id is string => id !== null && periodsFullyCovered.has(id)));
  const recordOnlyCount = selectedRows.length - selectedRows.filter((r) => r.periodId && periodsToDelete.has(r.periodId)).length;

  async function confirmDelete() {
    if (!pending) return;
    setDeleting(true);
    try {
      const result = await deleteOne(pending.id);
      if (!result.ok) {
        showToast(result.error, "error");
        return;
      }
      showToast(
        result.deletedPeriod
          ? `Deleted "${result.periodLabel}" — removed from every page that reads it.`
          : (result.message ?? "Import record removed."),
        "success"
      );
      setPending(null);
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  async function confirmBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    let periodsDeleted = 0;
    let recordsRemoved = 0;
    const failures: string[] = [];

    for (const id of ids) {
      const row = imports.find((i) => i.id === id);
      const result = await deleteOne(id);
      if (result.ok) {
        if (result.deletedPeriod) periodsDeleted += 1;
        else recordsRemoved += 1;
      } else {
        failures.push(`${row?.fileName ?? id}: ${result.error}`);
      }
    }

    setBulkDeleting(false);
    setBulkConfirmOpen(false);
    setSelected(new Set());

    const parts: string[] = [];
    if (periodsDeleted > 0) parts.push(`${periodsDeleted} day${periodsDeleted === 1 ? "" : "s"} of data deleted`);
    if (recordsRemoved > 0) parts.push(`${recordsRemoved} import${recordsRemoved === 1 ? "" : "s"} removed with the values ${recordsRemoved === 1 ? "it" : "they"} wrote`);
    const summary = parts.length > 0 ? parts.join(", ") + "." : "Nothing was deleted.";

    if (failures.length === 0) {
      showToast(summary, "success");
    } else {
      showToast(`${summary} ${failures.length} failed: ${failures.join("; ")}`, "error");
    }
    router.refresh();
  }

  if (imports.length === 0) {
    return <p className="text-sm text-muted-foreground">No imports yet.</p>;
  }

  return (
    <>
      {selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
          <span className="font-medium text-foreground">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={busy}>
              Clear
            </Button>
            <Button variant="danger" size="sm" onClick={() => setBulkConfirmOpen(true)} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5" /> Delete selected
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 border-b border-border pb-2">
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          disabled={busy}
          aria-label="Select all imports"
          className="h-4 w-4 rounded border-border accent-primary"
        />
        <span className="text-xs text-muted-foreground">Select all</span>
      </div>

      <ul className="divide-y divide-border">
        {imports.map((imp) => (
          <li key={imp.id} className="flex items-center justify-between gap-3 py-3 text-sm">
            <div className="flex min-w-0 items-center gap-3">
              <input
                type="checkbox"
                checked={selected.has(imp.id)}
                onChange={() => toggleOne(imp.id)}
                disabled={busy}
                aria-label={`Select ${imp.fileName}`}
                className="h-4 w-4 flex-shrink-0 rounded border-border accent-primary"
              />
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{imp.fileName}</p>
                <p className="text-xs text-muted-foreground">
                  Uploaded {formatDate(imp.uploadedAt)} · {imp.rowCount} rows
                  {imp.periodLabel ? ` · ${imp.periodLabel}` : ""}
                </p>
                {imp.fieldsTouched.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {imp.fieldsTouched.map((label) => (
                      <Badge key={label} variant="outline" className="text-[10px] font-normal">
                        {label}
                      </Badge>
                    ))}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <Badge variant={imp.status === "committed" ? "success" : imp.status === "failed" ? "danger" : "outline"}>
                {imp.status.replace("_", " ")}
              </Badge>
              <button
                type="button"
                onClick={() => setPending(imp)}
                disabled={busy}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-50"
                aria-label={`Delete ${imp.fileName}`}
                title="Delete this import"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => !open && !deleting && setPending(null)}
        title="Delete this import?"
        description={
          pending?.periodId
            ? `This removes this import and the data it recorded. If it is the only import on "${pending.periodLabel ?? "this period"}", the whole day goes: individual metrics, Business Gate numbers, and any penalties logged against it. If another import shares that day, only the values this import wrote are removed (a value another import also wrote goes back to that import's value) and the other import's data and penalties stay. It disappears from Team Performance, Trends, Overall MTD, Dashboard, Rankings, Scorecards, and Reports. This can't be undone.`
            : "This removes the import record from the history above. It never affected any period's data (it wasn't committed, or was committed before this link was tracked), so nothing else on the app changes."
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </>
        }
      />

      <Dialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => !open && !bulkDeleting && setBulkConfirmOpen(false)}
        title={`Delete ${selectedRows.length} import${selectedRows.length === 1 ? "" : "s"}?`}
        description={
          periodsToDelete.size > 0
            ? `This permanently deletes ${periodsToDelete.size} full day${periodsToDelete.size === 1 ? "" : "s"} of data — individual metrics, Business Gate numbers, and any penalties logged against ${periodsToDelete.size === 1 ? "it" : "them"} — removed from every page that reads it.${
                recordOnlyCount > 0
                  ? ` The other ${recordOnlyCount} selected import${recordOnlyCount === 1 ? "" : "s"} share${recordOnlyCount === 1 ? "s" : ""} a day with an import outside this selection, so only the values ${recordOnlyCount === 1 ? "it wrote are" : "they wrote are"} removed and the other import's data stays.`
                  : ""
              } This can't be undone.`
            : "None of the selected imports will remove a full day. Each one that shares its day with an import outside this selection has only its own values removed, and the other import's data stays. An import that was never committed only loses its history record. This can't be undone."
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)} disabled={bulkDeleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmBulkDelete} disabled={bulkDeleting}>
              {bulkDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                `Delete ${selectedRows.length}`
              )}
            </Button>
          </>
        }
      />
    </>
  );
}
