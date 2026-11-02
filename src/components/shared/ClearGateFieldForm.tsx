"use client";

import * as React from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { clearGateFieldRangeAction } from "@/app/import/actions";

export interface GateMonthOption {
  key: string;
  label: string;
}

// "manualOnly" is the shortcut for the two fields that are typed in by hand
// and must never come from a PDF.
const GATE_CLEAR_OPTIONS: { key: string; label: string }[] = [
  { key: "manualOnly", label: "Client Avg Wait Time and Team Processing Time (both)" },
  { key: "clientAvgWaitTimeMin", label: "Client Avg Wait Time only" },
  { key: "teamProcessingTimeMin", label: "Team Processing Time only" },
  { key: "chatTeamAvgResponseSec", label: "Chat Team Avg Response" },
  { key: "teamTicketAHTMin", label: "Team Ticket AHT" },
  { key: "teamRejectionRatePct", label: "Team Rejection Rate" },
];

/** Data Import page's "clear a Business Gate field across a month" action --
 *  Lead/Auditor-only, same access as ClearMetricFieldForm. It blanks ONE
 *  team-level Gate field (or the two hand-typed ones together) on every day
 *  already imported in the selected month. Agent data and every other Gate
 *  field are left alone. */
export function ClearGateFieldForm({ months }: { months: GateMonthOption[] }) {
  const { showToast } = useToast();
  const [monthKey, setMonthKey] = React.useState(months[0]?.key ?? "");
  const [field, setField] = React.useState(GATE_CLEAR_OPTIONS[0]?.key ?? "");
  const [pending, setPending] = React.useState(false);

  if (months.length === 0) {
    return <p className="text-sm text-muted-foreground">No imported months yet.</p>;
  }

  const monthLabel = months.find((m) => m.key === monthKey)?.label ?? "this month";
  const fieldLabel = GATE_CLEAR_OPTIONS.find((f) => f.key === field)?.label ?? "this field";

  async function handleClear() {
    if (
      !window.confirm(
        `Clear "${fieldLabel}" on every imported day in ${monthLabel}? Agent data is not touched. This can't be undone.`
      )
    ) {
      return;
    }
    setPending(true);
    try {
      const formData = new FormData();
      formData.set("monthKey", monthKey);
      formData.set("field", field);
      const result = await clearGateFieldRangeAction(formData);
      if (!result.ok) {
        showToast(result.error, "error");
        return;
      }
      showToast(
        result.clearedCount > 0
          ? `Cleared ${result.clearedCount} saved value${result.clearedCount === 1 ? "" : "s"} for "${fieldLabel}" in ${monthLabel}.`
          : `No saved value for "${fieldLabel}" in ${monthLabel} — nothing to clear.`,
        "success"
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Month</span>
          <Select value={monthKey} onChange={(e) => setMonthKey(e.target.value)}>
            {months.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Business Gate field</span>
          <Select value={field} onChange={(e) => setField(e.target.value)}>
            {GATE_CLEAR_OPTIONS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Button variant="danger" size="sm" onClick={handleClear} disabled={pending}>
        {pending ? "Clearing…" : "Clear this Gate field for the whole month"}
      </Button>
    </div>
  );
}
