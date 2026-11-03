"use client";

import * as React from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { clearScorecardsMonthAction } from "@/app/import/actions";

export interface ScorecardAgentOption {
  id: string;
  name: string;
}

export interface ScorecardMonthOption {
  key: string;
  label: string;
}

/** Data Import page's "clear individual scorecards for a month" action --
 *  Lead/Auditor-only, same access as ClearMetricFieldForm. It blanks every
 *  scorecard KPI except QA Audit % for one agent, or for the whole roster,
 *  across every day already imported in the selected month. Penalties and QA
 *  audit records are not touched. */
export function ClearScorecardsForm({
  agents,
  months,
}: {
  agents: ScorecardAgentOption[];
  months: ScorecardMonthOption[];
}) {
  const { showToast } = useToast();
  const [agentId, setAgentId] = React.useState("all");
  const [monthKey, setMonthKey] = React.useState(months[0]?.key ?? "");
  const [pending, setPending] = React.useState(false);

  if (months.length === 0) {
    return <p className="text-sm text-muted-foreground">No imported months yet.</p>;
  }

  const monthLabel = months.find((m) => m.key === monthKey)?.label ?? "this month";
  const agentLabel = agentId === "all" ? "ALL agents" : (agents.find((a) => a.id === agentId)?.name ?? "this agent");

  async function handleClear() {
    if (
      !window.confirm(
        `Clear every scorecard KPI for ${agentLabel} across every imported day in ${monthLabel}? QA Audit % and penalties are kept. This can't be undone.`
      )
    ) {
      return;
    }
    setPending(true);
    try {
      const formData = new FormData();
      formData.set("monthKey", monthKey);
      formData.set("agentId", agentId);
      const result = await clearScorecardsMonthAction(formData);
      if (!result.ok) {
        showToast(result.error, "error");
        return;
      }
      showToast(
        result.clearedCount > 0
          ? `Cleared scorecard KPIs for ${agentLabel} (${result.clearedCount} daily record${result.clearedCount === 1 ? "" : "s"}) in ${monthLabel}.`
          : `No scorecard records for ${agentLabel} in ${monthLabel} — nothing to clear.`,
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
          <span className="text-sm text-muted-foreground">Agent</span>
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="all">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
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
      </div>
      <Button variant="danger" size="sm" onClick={handleClear} disabled={pending}>
        {pending ? "Clearing…" : "Clear scorecards for the whole month"}
      </Button>
    </div>
  );
}
