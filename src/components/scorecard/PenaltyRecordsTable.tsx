"use client";

import * as React from "react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { DeletePenaltyButton } from "@/components/scorecard/DeletePenaltyButton";
import { formatDate } from "@/lib/utils";
import type { PenaltyStatus } from "@/lib/scoring/types";

export type RecordedPenaltyRow = {
  id: string;
  label: string;
  deduction: number;
  count: number;
  occurredOn: string;
  recordedBy: string;
  /** ISO timestamp of when the entry was actually submitted. */
  createdAt?: string;
  note?: string;
  status?: PenaltyStatus;
  agent: string;
  agentId: string;
};

/** "Oct 5, 2026, 3:42 PM" in Manila time (the team's timezone). The zone is
 *  pinned so the server render and the browser render always agree. */
function formatLogged(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  }).format(d);
}

/** Client component so the agent filter can react instantly without a
 *  server round-trip -- every row for the period is already loaded on the
 *  page (loadPeriodDataset already fetched it), so filtering is just a
 *  client-side narrowing of what's already there. */
export function PenaltyRecordsTable({
  records,
  agents,
  periodLabel,
}: {
  records: RecordedPenaltyRow[];
  agents: { id: string; name: string }[];
  periodLabel: string;
}) {
  const [agentId, setAgentId] = React.useState("");

  // Only list agents who actually have a record this period -- picking a
  // name from the full roster only to see "no records" isn't useful.
  const agentsWithRecords = agents.filter((a) => records.some((r) => r.agentId === a.id));
  const filtered = agentId ? records.filter((r) => r.agentId === agentId) : records;

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <label htmlFor="penalty-agent-filter" className="text-xs font-medium text-muted-foreground">
          Filter by agent
        </label>
        <Select
          id="penalty-agent-filter"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full sm:w-56"
        >
          <option value="">All agents ({records.length})</option>
          {agentsWithRecords.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({records.filter((r) => r.agentId === a.id).length})
            </option>
          ))}
        </Select>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {records.length === 0
            ? `No penalties recorded for ${periodLabel}.`
            : "No records for this agent this period."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Infraction</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Logged on</TableHead>
              <TableHead>Recorded by</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Count</TableHead>
              <TableHead className="text-right">Deduction</TableHead>
              <TableHead className="text-right">&nbsp;</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium text-foreground">{p.agent}</TableCell>
                <TableCell>{p.label}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(p.occurredOn)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatLogged(p.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground">{p.recordedBy}</TableCell>
                <TableCell className="max-w-xs whitespace-normal text-xs text-muted-foreground">{p.note ? p.note : "—"}</TableCell>
                <TableCell>{p.count}</TableCell>
                <TableCell className="text-right">
                  {p.status ? (
                    <Badge variant={p.status.variant}>{p.status.label}</Badge>
                  ) : p.deduction === 0 ? (
                    // A monthlyGrace-metered code (e.g. Late Onsite <15min)
                    // can genuinely deduct nothing THIS time -- "-0.00" in
                    // red would misleadingly read as a real, if tiny,
                    // deduction, so a free occurrence shows a plain dash
                    // instead, same treatment as the status badge above.
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="text-danger">-{p.deduction.toFixed(2)}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <DeletePenaltyButton id={p.id} agentId={p.agentId} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
