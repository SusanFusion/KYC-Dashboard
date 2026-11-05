import { TopHeader } from "@/components/layout/TopHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TierBadge, tierTone } from "@/components/dashboard/PerformanceBadge";
import { MetricBlockCard, TONE_GRADIENT } from "@/components/metrics/MetricBlockCard";
import { ScoringScaleTable } from "@/components/metrics/ScoringScaleTable";
import { GateCalculationDetails } from "@/components/metrics/GateCalculationDetails";
import { GateInfoButton } from "@/components/metrics/GateInfoButton";
import { QaScoreWarning } from "@/components/qa/QaScoreWarning";
import { GateMultiplierConfetti } from "@/components/metrics/GateMultiplierConfetti";
import { Progress } from "@/components/ui/progress";
import { RangePicker } from "@/components/shared/RangePicker";
import { RankingTable, type RankingRow } from "@/components/rankings/RankingTable";
import { loadRangeDataset, listAvailableMonths } from "@/lib/data/query";
import { buildGateScaleTable } from "@/lib/scoring/display";
import { GATE_TIER_SCORES, hasSufficientDataCoverage } from "@/lib/scoring/thresholds";
import type { GateTier } from "@/lib/scoring/types";
import { EmptyState } from "@/components/shared/EmptyState";
import { cn, formatDate } from "@/lib/utils";

// Scores are derived fresh from live data on every request — see rankings/page.tsx
// for why this must never be served from a cached/stale build snapshot.
export const dynamic = "force-dynamic";

const GATE_TIER_DESCRIPTION: Record<GateTier, string> = {
  Exceptional: "smashing the target",
  Green: "hitting target",
  Amber: "below target",
  Red: "significantly missing",
};

export default async function MtdPage({ searchParams }: { searchParams: { month?: string } }) {
  const months = await listAvailableMonths();

  if (months.length === 0) {
    return (
      <>
        <TopHeader title="Overall MTD" description="Month-to-date average across every daily import" />
        <PageShell>
          <EmptyState
            title="No daily imports yet"
            description="Import at least one day's report to see month-to-date figures."
            actionLabel="Go to Data Import"
            actionHref="/import"
          />
        </PageShell>
      </>
    );
  }

  const selectedMonth = months.find((m) => m.key === searchParams.month) ?? months[0]!;
  const monthThruLabel = `${selectedMonth.label} (thru ${formatDate(selectedMonth.end)})`;
  const { results, ranked, teams } = await loadRangeDataset({
    start: selectedMonth.start,
    end: selectedMonth.end,
    label: monthThruLabel,
    id: `mtd-${selectedMonth.key}`,
    type: "month-to-date",
  });
  const gate = results[0]?.gate;

  const monthPicker = (
    <RangePicker paramName="month" current={selectedMonth.key} options={months.map((m) => ({ value: m.key, label: m.label }))} />
  );

  if (!gate) {
    return (
      <>
        <TopHeader title="Overall MTD" description="Month-to-date average across every daily import" actions={monthPicker} />
        <PageShell>
          <EmptyState
            title="No team-level data yet"
            description="Import a report to see Business Gate metrics."
            actionLabel="Go to Data Import"
            actionHref="/import"
          />
        </PageShell>
      </>
    );
  }

  // Same exclusion as Team Performance/Trends — an agent with no import yet
  // has a 0.00 placeholder that shouldn't drag the team average down (see
  // query.ts).
  const scoredResults = results.filter((r) => r.individual.effectiveWeight > 0);
  const teamAverage = scoredResults.length
    ? scoredResults.reduce((sum, r) => sum + r.individual.finalScore, 0) / scoredResults.length
    : 0;
  const { columns, rows } = buildGateScaleTable();
  const multiplierToneRaw = tierTone(gate.overallTier);

    const rankingRows: RankingRow[] = ranked.map((r) => ({
    agentId: r.agent.id,
    name: r.agent.name,
    department: r.agent.department,
    finalScore: r.individual.finalScore,
    hasIncompleteData: r.individual.hasIncompleteData,
    hasNoData: r.individual.effectiveWeight === 0,
    // True when SOME data exists but it's under MIN_SCORE_COVERAGE of the
    // scorecard's weight (thresholds.ts) — more missing than just QA Audit
    // (the one metric known to be missing app-wide). Without this, an agent
    // reporting only 2 of 6 metrics that happen to grade "Exceptional"
    // renormalizes to a perfect 3.00 and can tie or outrank agents who
    // reported everything but weren't perfect on every metric.
    hasInsufficientData: r.individual.effectiveWeight > 0 && !hasSufficientDataCoverage(r.individual.effectiveWeight),
    appAHT: r.individual.metrics.find((m) => m.key === "appAHT")?.actualDisplay ?? "—",
    emailAHT: r.individual.metrics.find((m) => m.key === "emailAHT")?.actualDisplay ?? "—",
    chatAvgResponse: r.individual.metrics.find((m) => m.key === "chatAvgResponse")?.actualDisplay ?? "—",
    chatFRT: r.individual.metrics.find((m) => m.key === "chatFRT")?.actualDisplay ?? "—",
    csatDsat: r.individual.metrics.find((m) => m.key === "csatDsat")?.actualDisplay ?? "—",
    qaAudit: r.individual.metrics.find((m) => m.key === "qaAudit")?.actualDisplay ?? "—",
    // The 0-3 grade each metric above earned against its scoring scale --
    // shown as its own "Point" column right next to the raw value (see
    // RankingTable). Null exactly when the raw value is "—" (no data yet).
    appAHTPoint: r.individual.metrics.find((m) => m.key === "appAHT")?.grade ?? null,
    emailAHTPoint: r.individual.metrics.find((m) => m.key === "emailAHT")?.grade ?? null,
    chatAvgResponsePoint: r.individual.metrics.find((m) => m.key === "chatAvgResponse")?.grade ?? null,
    chatFRTPoint: r.individual.metrics.find((m) => m.key === "chatFRT")?.grade ?? null,
    csatDsatPoint: r.individual.metrics.find((m) => m.key === "csatDsat")?.grade ?? null,
    totalChats: r.chatCounts.totalChats,
    csatCount: r.chatCounts.csatCount,
    dsatCount: r.chatCounts.dsatCount,
    qaAuditPoint: r.individual.metrics.find((m) => m.key === "qaAudit")?.grade ?? null,
    // Points deducted from this agent's score by the penalties applied across
    // the month so far, split into Disciplinary and Attendance -- shown as
    // their own columns via RankingTable's showDeductionColumn prop below
    // (Overall MTD only).
    penaltyTotal: r.individual.penaltyTotal,
    disciplinaryTotal: r.individual.disciplinaryTotal,
    attendanceTotal: r.individual.attendanceTotal,
  }));

  return (
    <>
      <TopHeader title="Overall MTD" description={`Month-to-date average for ${monthThruLabel}`} actions={monthPicker} />
      <PageShell>
        <QaScoreWarning start={selectedMonth.start} end={selectedMonth.end} />
        <Card>
          <CardHeader>
            <CardTitle>{monthThruLabel}</CardTitle>
            <CardDescription>Averaged across every day imported so far this month, against the scoring scale below.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {gate.metrics.map((m) => (
                <MetricBlockCard
                  key={m.key}
                  label={m.name}
                  value={m.actualDisplay}
                  tone={tierTone(m.tier)}
                  badge={<TierBadge tier={m.tier} />}
                  bufferLabel={m.tierScore === null ? "Not available this month — excluded, not scored as 0" : m.bufferLabel}
                  bufferGood={m.bufferGood}
                  weightLabel={
                    m.tierScore !== null
                      ? `Weight ${(m.weight * 100).toFixed(0)}% · contributes ${m.weightedContribution?.toFixed(4)}`
                      : `Weight ${(m.weight * 100).toFixed(0)}%`
                  }
                  tooltip="Distance to the Amber threshold (the Green tier's boundary) — how much room is left before this metric needs attention."
                  emphasized
                />
              ))}
            </div>
            {/* Same numeric-focused hero block as Team Performance's Gate
                Multiplier -- tinted with the shared TONE_GRADIENT finish
                instead of always-primary, so it reflects this month's
                actual overall tier at a glance. */}
            <div
              data-confetti-target="gate-multiplier"
              className={cn(
                "mt-5 flex flex-col items-center gap-2 rounded-xl border p-6 text-center transition-all duration-200",
                TONE_GRADIENT[multiplierToneRaw]
              )}
            >
              {/* Confetti only when the month's overall tier is Exceptional --
                  the blue one (tierTone -> "primary"). Keyed by month so
                  switching months in the picker can celebrate again. */}
              {gate.overallTier === "Exceptional" && <GateMultiplierConfetti key={selectedMonth.key} />}
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Gate Multiplier
                <GateInfoButton gate={gate} periodLabel={monthThruLabel} />
              </p>
              <p className="text-5xl font-bold tabular-nums tracking-tight text-foreground">{gate.gateMultiplier.toFixed(4)}×</p>
              <TierBadge tier={gate.overallTier} />
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Weighted average of the four tier scores above — applied to every agent&apos;s bonus this month.
              </p>
            </div>
            <GateCalculationDetails gate={gate} />
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Individual Scorecard Average (Layer 2)</CardTitle>
            <CardDescription>
              Average final score across {scoredResults.length} scored agent{scoredResults.length === 1 ? "" : "s"} this month
              {scoredResults.length !== results.length ? ` (of ${results.length} on the roster)` : ""}, before the gate multiplier.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <span className="text-3xl font-semibold text-foreground">{teamAverage.toFixed(2)}</span>
              <span className="text-sm text-muted-foreground">/ 3.00</span>
              <Progress value={teamAverage} max={3} className="ml-4 flex-1" />
            </div>
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Agent Rankings — MTD</CardTitle>
            <CardDescription>Every agent&apos;s score averaged across each day imported so far this month.</CardDescription>
          </CardHeader>
          <CardContent className="p-5">
            <RankingTable rows={rankingRows} departments={teams.map((t) => t.name)} showDeductionColumn showChatCounts />
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Business Gate Scoring Scale</CardTitle>
            <CardDescription>
              Reference only — each metric above is scored into a tier against these ranges; the weighted average of the tier
              scores becomes this month&apos;s team-level multiplier.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScoringScaleTable columns={columns} rows={rows} title="Metric" />
            <ul className="mt-4 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-border">
              {GATE_TIER_SCORES.map((t) => (
                <li key={t.tier}>
                  <span className="font-semibold text-foreground">
                    {t.tier} = {t.score.toFixed(2)}
                  </span>{" "}
                  ({GATE_TIER_DESCRIPTION[t.tier]})
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </PageShell>
    </>
  );
}
