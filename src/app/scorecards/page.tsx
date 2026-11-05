import type { ReactNode } from "react";
import Link from "next/link";
import { TopHeader } from "@/components/layout/TopHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AgentSearch } from "@/components/scorecard/AgentSearch";
import { RangePicker } from "@/components/shared/RangePicker";
import { DateRangePicker } from "@/components/shared/DateRangePicker";
import { gradeTone } from "@/components/dashboard/PerformanceBadge";
import { loadRangeDataset, listAvailableMonths, listAvailableWeeks, type RangeSpec } from "@/lib/data/query";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";
import type { Grade, IndividualMetricKey, MetricScoreBreakdown } from "@/lib/scoring/types";
// Overall-score highlight line: one pass/fail line across the final 0–3 score,
// shared with every other page (see thresholds.ts).
import { SCORE_PASS_THRESHOLD } from "@/lib/scoring/thresholds";
import { cn, formatDate } from "@/lib/utils";
import { EmptyState } from "@/components/shared/EmptyState";
import { QaScoreWarning } from "@/components/qa/QaScoreWarning";

// Scores are derived fresh from live data on every request — see
// rankings/page.tsx for why this must never be served from a cached/stale
// build snapshot.
export const dynamic = "force-dynamic";

// The three period modes this page can be viewed in — same RangePicker
// component used for the mode switch itself as for the mtd/week presets it
// switches between.
const MODE_OPTIONS = [
  { value: "mtd", label: "Month to Date" },
  { value: "week", label: "Week" },
  { value: "range", label: "Date Range" },
];

function metricValue(metrics: MetricScoreBreakdown[], key: IndividualMetricKey) {
  return metrics.find((m) => m.key === key)?.actualDisplay ?? "—";
}

// Plain count cell (Total Chats / CSAT / DSAT) -- a dash when there's no data.
function countValue(n: number | null) {
  return n === null ? "—" : String(n);
}

// The 0-3 grade a metric earned against its scoring scale (thresholds.ts
// bands) -- same value that drives that metric's color everywhere else,
// shown here as its own "Point" column right next to the raw value.
function metricPoint(metrics: MetricScoreBreakdown[], key: IndividualMetricKey): Grade | null {
  return metrics.find((m) => m.key === key)?.grade ?? null;
}

// Compact companion cell for a "Point" column -- just the digit, colored by
// the same gradeTone every other grade indicator in the app uses.
function pointCell(point: Grade | null) {
  if (point === null) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={gradeTone(point) as "primary" | "success" | "warning" | "danger"}>{point}</Badge>;
}

// The same elegant, tone-tinted look used everywhere else color-coding
// appears (see MetricBlockCard's TONE_GRADIENT), adapted for a full-width
// table row: a left-to-right gradient wash instead of a corner-lit tile,
// and no ambient shadow -- rows sit flush against each other with no room
// for one to read cleanly, and a stack of shadowed rows would just look
// muddy. Kept as its own map since these three states (pass/fail/no data)
// aren't literally Tone values the way MetricBlockCard's tiles are.
const ROW_GRADIENT = {
  pass: "bg-gradient-to-r from-success/20 via-success/5 to-transparent",
  fail: "bg-gradient-to-r from-danger/20 via-danger/5 to-transparent",
  noData: "bg-gradient-to-r from-muted/40 via-muted/10 to-transparent",
};

export default async function ScorecardsPage({
  searchParams,
}: {
  searchParams: { mode?: string; month?: string; week?: string; start?: string; end?: string };
}) {
  // Both lists come from the exact same underlying daily imports (see
  // listAvailableMonths/listAvailableWeeks in query.ts), so months being
  // non-empty guarantees weeks is too -- one guard below covers both.
  const [months, weeks] = await Promise.all([listAvailableMonths(), listAvailableWeeks()]);

  if (months.length === 0) {
    return (
      <>
        <TopHeader title="Individual Scorecards" description="Per-agent performance breakdown" />
        <PageShell>
          <EmptyState title="No agents scored yet" actionLabel="Import a report" actionHref="/import" />
        </PageShell>
      </>
    );
  }

  const mode = searchParams.mode === "week" || searchParams.mode === "range" ? searchParams.mode : "mtd";

  // The full span of days actually on record -- months is sorted
  // most-recent-first, so the earliest month with data is the last entry;
  // its "start" is that calendar month's first day. Used only to bound the
  // Date Range picker's native min/max, not to change any scoring.
  const earliestStart = months[months.length - 1]!.start;
  const latestEnd = months[0]!.end;

  let rangeSpec: RangeSpec;
  let periodLabel: string;
  let secondaryPicker: ReactNode;

  if (mode === "week") {
    // Same weekly view Team Performance uses — defaults to the most
    // recently imported week, with older weeks reachable via the picker.
    const selectedWeek = weeks.find((w) => w.start === searchParams.week) ?? weeks[0]!;
    periodLabel = `Week of ${selectedWeek.label}`;
    rangeSpec = {
      start: selectedWeek.start,
      end: selectedWeek.end,
      label: periodLabel,
      id: `week-${selectedWeek.start}`,
      type: "weekly",
    };
    secondaryPicker = (
      <RangePicker paramName="week" current={selectedWeek.start} options={weeks.map((w) => ({ value: w.start, label: w.label }))} />
    );
  } else if (mode === "range") {
    // Free-form date range, clamped to the span of days actually on record
    // (a date outside that span, or an end before start, silently falls
    // back rather than sending loadRangeDataset a window with no data).
    const requestedStart =
      searchParams.start && searchParams.start >= earliestStart && searchParams.start <= latestEnd
        ? searchParams.start
        : earliestStart;
    const requestedEnd =
      searchParams.end && searchParams.end >= requestedStart && searchParams.end <= latestEnd
        ? searchParams.end
        : latestEnd;
    periodLabel = `${formatDate(requestedStart)} – ${formatDate(requestedEnd)}`;
    rangeSpec = {
      start: requestedStart,
      end: requestedEnd,
      label: periodLabel,
      id: `range-${requestedStart}-${requestedEnd}`,
      type: "custom",
    };
    secondaryPicker = (
      <DateRangePicker currentStart={requestedStart} currentEnd={requestedEnd} min={earliestStart} max={latestEnd} />
    );
  } else {
    // Month-to-date rather than a single imported day — same reason Rankings
    // moved to loadRangeDataset (see rankings/page.tsx): a single day's import
    // can legitimately be missing a field most of the roster only has from a
    // different day's import (e.g. chat metrics land from a separate import
    // step than the main KYC report), which used to make most of the roster
    // read as "No data" here even though Rankings, aggregating the same
    // month, had it.
    const selectedMonth = months.find((m) => m.key === searchParams.month) ?? months[0]!;
    periodLabel = `${selectedMonth.label} (thru ${formatDate(selectedMonth.end)})`;
    rangeSpec = {
      start: selectedMonth.start,
      end: selectedMonth.end,
      label: periodLabel,
      id: `mtd-${selectedMonth.key}`,
      type: "month-to-date",
    };
    secondaryPicker = (
      <RangePicker paramName="month" current={selectedMonth.key} options={months.map((m) => ({ value: m.key, label: m.label }))} />
    );
  }

  const [{ ranked }, user] = await Promise.all([loadRangeDataset(rangeSpec), getCurrentUser()]);

  // Alphabetical by name rather than by rank — this page is a roster to
  // look someone up in, not a leaderboard (that's what Rankings is for).
  const agentsAlphabetical = [...ranked].sort((a, b) => a.agent.name.localeCompare(b.agent.name));

  return (
    <>
      <TopHeader
        title="Individual Scorecards"
        description={`${ranked.length} agents · ${periodLabel}`}
        actions={
          <>
            <AgentSearch agents={ranked.map((r) => ({ id: r.agent.id, name: r.agent.name }))} />
            <RangePicker paramName="mode" current={mode} options={MODE_OPTIONS} />
            {secondaryPicker}
          </>
        }
      />
      <PageShell>
        <QaScoreWarning start={rangeSpec.start} end={rangeSpec.end} />
        <Card>
          <CardContent className="p-5">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="sticky left-0 z-[1] min-w-[200px] border-r border-border"
                      style={{ backgroundColor: "hsl(var(--muted))" }}
                    >
                      Agent
                    </TableHead>
                    <TableHead>App AHT</TableHead>
                    <TableHead>Point</TableHead>
                    <TableHead>Email AHT</TableHead>
                    <TableHead>Point</TableHead>
                    <TableHead>Chat Response</TableHead>
                    <TableHead>Point</TableHead>
                    <TableHead>First Response</TableHead>
                    <TableHead>Point</TableHead>
                    <TableHead>CSAT</TableHead>
                    <TableHead>Point</TableHead>
                    <TableHead>Total Chats</TableHead>
                    <TableHead>CSAT Count</TableHead>
                    <TableHead>DSAT Count</TableHead>
                    <TableHead>QA Audit</TableHead>
                    <TableHead>Point</TableHead>
                    <TableHead className="text-right">Disciplinary</TableHead>
                    <TableHead className="text-right">Attendance</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agentsAlphabetical.map((r) => {
                    // Same rule as the individual Scorecard page: an agent sees
                    // their own QA Audit result; Leads/Managers see everyone's.
                    const canSeeQaAudit = !user || user.role === "lead" || user.agentId === r.agent.id;
                    const passing = r.individual.finalScore >= SCORE_PASS_THRESHOLD;
                    // True only when NOT ONE metric has data yet this period —
                    // distinct from hasIncompleteData, which can also mean
                    // just one metric (e.g. QA Audit) is still missing. Shown
                    // as a plain "No data yet" pill instead of a 0.00 score,
                    // which would otherwise misrepresent an unimported agent
                    // as having failed.
                    const noDataYet = r.individual.effectiveWeight === 0;

                    return (
                      <TableRow key={r.agent.id} className={noDataYet ? ROW_GRADIENT.noData : passing ? ROW_GRADIENT.pass : ROW_GRADIENT.fail}>
                        <TableCell
                          className={cn(
                            "sticky left-0 z-[1] min-w-[200px] border-r border-border",
                            noDataYet ? ROW_GRADIENT.noData : passing ? ROW_GRADIENT.pass : ROW_GRADIENT.fail
                          )}
                          style={{ backgroundColor: "hsl(var(--card))" }}
                        >
                          <Link href={`/scorecards/${r.agent.id}`} className="font-medium text-foreground hover:underline">
                            {r.agent.name}
                          </Link>
                          {r.individual.hasIncompleteData && (
                            <Badge variant="outline" className="ml-2">
                              Incomplete
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{metricValue(r.individual.metrics, "appAHT")}</TableCell>
                        <TableCell>{pointCell(metricPoint(r.individual.metrics, "appAHT"))}</TableCell>
                        <TableCell className="text-muted-foreground">{metricValue(r.individual.metrics, "emailAHT")}</TableCell>
                        <TableCell>{pointCell(metricPoint(r.individual.metrics, "emailAHT"))}</TableCell>
                        <TableCell className="text-muted-foreground">{metricValue(r.individual.metrics, "chatAvgResponse")}</TableCell>
                        <TableCell>{pointCell(metricPoint(r.individual.metrics, "chatAvgResponse"))}</TableCell>
                        <TableCell className="text-muted-foreground">{metricValue(r.individual.metrics, "chatFRT")}</TableCell>
                        <TableCell>{pointCell(metricPoint(r.individual.metrics, "chatFRT"))}</TableCell>
                        <TableCell className="text-muted-foreground">{metricValue(r.individual.metrics, "csatDsat")}</TableCell>
                        <TableCell>{pointCell(metricPoint(r.individual.metrics, "csatDsat"))}</TableCell>
                        <TableCell className="text-muted-foreground">{countValue(r.chatCounts.totalChats)}</TableCell>
                        <TableCell className="text-muted-foreground">{countValue(r.chatCounts.csatCount)}</TableCell>
                        <TableCell className="text-muted-foreground">{countValue(r.chatCounts.dsatCount)}</TableCell>
                        <TableCell
                          className="text-muted-foreground"
                          title={canSeeQaAudit ? undefined : "Visible to this agent and Leads/Managers only"}
                        >
                          {canSeeQaAudit ? metricValue(r.individual.metrics, "qaAudit") : "—"}
                        </TableCell>
                        <TableCell title={canSeeQaAudit ? undefined : "Visible to this agent and Leads/Managers only"}>
                          {canSeeQaAudit ? pointCell(metricPoint(r.individual.metrics, "qaAudit")) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.individual.disciplinaryTotal > 0 ? (
                            <span className="font-medium text-danger">-{r.individual.disciplinaryTotal.toFixed(2)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.individual.attendanceTotal > 0 ? (
                            <span className="font-medium text-danger">-{r.individual.attendanceTotal.toFixed(2)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {noDataYet ? (
                            // Plain text here, not a pill — the row itself is
                            // already tinted (ROW_GRADIENT.noData), so a second
                            // background on top of that would just look muddy.
                            <span className="text-xs font-medium text-muted-foreground">No data yet</span>
                          ) : (
                            <span className={cn("text-sm font-semibold", passing ? "text-success" : "text-danger")}>
                              {r.individual.finalScore.toFixed(2)}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </PageShell>
    </>
  );
}
