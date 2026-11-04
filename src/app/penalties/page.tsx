import { TopHeader } from "@/components/layout/TopHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PasswordGate } from "@/components/shared/PasswordGate";
import { PenaltyForm } from "@/components/scorecard/PenaltyForm";
import { PenaltyRecordsTable } from "@/components/scorecard/PenaltyRecordsTable";
import {
  DISCIPLINARY_PENALTIES,
  ATTENDANCE_PENALTIES,
  EMPLOYMENT_ACTIONS,
  PENALTY_NOTE_DEDUCTION_TIMING,
  REPEATED_OFFENSE_THRESHOLD,
} from "@/lib/scoring";
import type { PenaltyDefinition } from "@/lib/scoring/types";
import { loadPeriodDataset } from "@/lib/data/query";
import { getRepository } from "@/lib/data/repository";
import { calculateAllPenalties, findRepeatedOffenses } from "@/lib/scoring/penalties";
import { quarterRange, formatQuarterLabel } from "@/lib/data/dateRanges";
import { formatDate } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";

/** columnLabel switches this between the two disciplinary/attendance tables
 *  (a plain numeric "Deduction" column, every row here) and the employment
 *  track-record table (a "Status" column instead -- those rows all carry a
 *  `status` badge rather than a deduction, since it's always 0 for them). */
function PenaltyTable({ title, rows, columnLabel = "Deduction" }: { title: string; rows: PenaltyDefinition[]; columnLabel?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Infraction</TableHead>
              <TableHead>{columnLabel}</TableHead>
              <TableHead>Examples</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.code}>
                <TableCell className="font-medium text-foreground">{r.label}</TableCell>
                <TableCell>
                  {r.status ? (
                    <Badge variant={r.status.variant}>{r.status.label}</Badge>
                  ) : (
                    <Badge variant="danger">-{r.deduction.toFixed(2)}</Badge>
                  )}
                </TableCell>
                <TableCell className="max-w-md whitespace-normal text-xs text-muted-foreground">{r.example}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default async function PenaltiesPage() {
  const { period, agents } = await loadPeriodDataset();

  // Every penalty ever recorded, for every agent -- NOT scoped to
  // `period.id`. This list is meant to be a durable running log of
  // everything anyone has recorded, and used to only look that way by
  // coincidence: every entry happened to share whatever period was
  // "current" at the time it was typed in, until a new daily import rolled
  // "current" forward and the whole list silently went to zero. See
  // calculateAllPenalties in penalties.ts.
  const repo = await getRepository();
  const allPenalties = await repo.getPenalties();
  const recorded = agents
    .flatMap((a) => calculateAllPenalties(a.id, allPenalties).map((p) => ({ ...p, agent: a.name, agentId: a.id })))
    .filter((p) => p.count > 0)
    // Newest submission first (when each entry was actually logged, not the
    // date of the infraction), so the log reads latest -> oldest instead of
    // grouped alphabetically by agent. Same-moment entries (e.g. several
    // logged back-to-back) fall back to the infraction date, then id, so
    // the order is always stable.
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

  // Who has already hit the Repeated Offenses rule (the same Disciplinary
  // penalty 3+ times) in the quarter of the current period -- the matching
  // -0.50 shows up in that quarter's score on the Quarter page.
  const quarterAnchor = period?.startDate ?? new Date().toISOString().slice(0, 10);
  const quarterWindow = quarterRange(quarterAnchor);
  const quarterLabel = formatQuarterLabel(quarterAnchor);
  const repeatedOffenders = findRepeatedOffenses(allPenalties, quarterWindow.start, quarterWindow.end);
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  // The disciplinary/attendance reference tables and the "Record a penalty"
  // form above stay visible to everyone (recording is already its own
  // password-gated action) -- only the actual log of WHO was penalized and
  // WHY, below, is restricted. Same !user-fails-open convention as
  // canSeeQaAudit elsewhere (e.g. scorecards/[agentId]/page.tsx) for when
  // there's no session to read.
  const user = await getCurrentUser();
  const canSeePenaltyLog = !user || user.role === "lead";

  return (
    <>
      <TopHeader title="Penalties" description="Disciplinary Penalty System & Attendance Penalty — replaces the old Progressive Sanction KPI" />
      <PageShell>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PenaltyTable title="Disciplinary Penalty System" rows={DISCIPLINARY_PENALTIES} />
          <PenaltyTable title="Attendance Penalty" rows={ATTENDANCE_PENALTIES} />
        </div>

        {/* Own row, full width -- these carry no deduction, so keeping them
            visually separate from the two score-affecting tables above
            makes that distinction obvious at a glance rather than needing
            the reader to check every row's numbers. */}
        <div className="mt-4">
          <PenaltyTable title="Employment Track Record Actions" rows={EMPLOYMENT_ACTIONS} columnLabel="Status" />
        </div>

        <p className="mt-3 text-xs text-muted-foreground">{PENALTY_NOTE_DEDUCTION_TIMING}</p>

        {/* One shared unlock for both "Record a penalty" and "Recorded this
            period" below -- entering the password once used to only unlock
            whichever of the two you typed it into (each had its own
            PasswordGate, and each one's unlock state lives in that
            component's own client-side state), so you'd get asked again for
            the other. Wrapping both cards in a single PasswordGate instance
            means there's exactly one prompt and one unlock for the whole
            section. The Lead-only role check on the records table
            underneath is unchanged and independent of this -- an agent who
            knows the password can still open "Record a penalty" (unchanged
            from before), but the records table stays role-gated regardless
            of whether the password was entered. */}
        <PasswordGate description="Enter the shared Lead/Manager password to record or view penalties.">
          {period && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Record a penalty</CardTitle>
                <CardDescription>Applies to {period.label}. Deductions apply immediately to the agent&apos;s individual score.</CardDescription>
              </CardHeader>
              <CardContent>
                <PenaltyForm agents={agents.map((a) => ({ id: a.id, name: a.name }))} periodId={period.id} />
              </CardContent>
            </Card>
          )}

          {canSeePenaltyLog && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Repeated Offenses — {quarterLabel}</CardTitle>
                <CardDescription>
                  Agents recorded for the same Disciplinary penalty {REPEATED_OFFENSE_THRESHOLD} or more times this quarter. Each takes
                  an automatic -0.50 off their score on the Quarter page (once per quarter).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {repeatedOffenders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No agent has reached {REPEATED_OFFENSE_THRESHOLD} of the same penalty this quarter.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Agent</TableHead>
                        <TableHead>Repeated penalty (times in quarter)</TableHead>
                        <TableHead>Hit on</TableHead>
                        <TableHead>Deduction</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {repeatedOffenders.map((o) => (
                        <TableRow key={o.agentId}>
                          <TableCell className="font-medium text-foreground">{agentNameById.get(o.agentId) ?? o.agentId}</TableCell>
                          <TableCell className="whitespace-normal">{o.codes.map((c) => `${c.label} ×${c.count}`).join(", ")}</TableCell>
                          <TableCell>{formatDate(o.triggeredOn)}</TableCell>
                          <TableCell>
                            {o.alreadyRecorded ? (
                              <Badge variant="outline">Already recorded by hand</Badge>
                            ) : (
                              <Badge variant="danger">-{o.deduction.toFixed(2)}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Penalty log (all periods)</CardTitle>
              {!canSeePenaltyLog && <CardDescription>Visible to Leads/Managers only.</CardDescription>}
            </CardHeader>
            <CardContent>
              {canSeePenaltyLog ? (
                <PenaltyRecordsTable
                  records={recorded}
                  agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                  periodLabel={period?.label ?? "this period"}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Penalty records are visible to Leads/Managers only.</p>
              )}
            </CardContent>
          </Card>
        </PasswordGate>
      </PageShell>
    </>
  );
}
