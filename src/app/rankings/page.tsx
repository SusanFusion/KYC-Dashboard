import { TopHeader } from "@/components/layout/TopHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { RankingTable, type RankingRow } from "@/components/rankings/RankingTable";
import { TopPerformersSpotlight } from "@/components/rankings/TopPerformersSpotlight";
import { EncouragementBand, type WeakMetric } from "@/components/rankings/EncouragementBand";
import { EmptyState } from "@/components/shared/EmptyState";
import { loadRangeDataset, listAvailableMonths } from "@/lib/data/query";
import { hasSufficientDataCoverage } from "@/lib/scoring/thresholds";
import type { Grade, MetricScoreBreakdown } from "@/lib/scoring/types";
import { formatDate } from "@/lib/utils";

// The metrics behind "Room to Grow"'s specific "Focus on" chips -- Below
// Target (1) or Failing (0) only; On Target/Exceptional metrics aren't a
// "focus area". Worst grade first, and among ties the more heavily-weighted
// metric first (that's the one actually moving the score most). Capped at
// `max` so a card with several weak metrics still stays readable -- the
// count of anything left over is reported separately so it isn't just
// silently dropped.
function weakestMetrics(metrics: MetricScoreBreakdown[], max = 2): { shown: WeakMetric[]; extraCount: number } {
  const weak = metrics
    .filter((m) => m.grade !== null && m.grade <= 1)
    .sort((a, b) => (a.grade as Grade) - (b.grade as Grade) || b.weight - a.weight);
  return {
    shown: weak.slice(0, max).map((m) => ({ key: m.key, name: m.name, grade: m.grade as Grade })),
    extraCount: Math.max(0, weak.length - max),
  };
}

// Scores are derived fresh from live data on every request — this page must
// never be served from a cached/stale build snapshot (Vercel/Next can
// otherwise reuse a pre-rendered page across deployments if it can't tell
// the underlying data is dynamic), which is exactly what caused already-
// fixed bugs to keep reappearing on the live site after a real fix shipped.
export const dynamic = "force-dynamic";

export default async function RankingsPage() {
  const months = await listAvailableMonths();

  if (months.length === 0) {
    return (
      <>
        <TopHeader title="Rankings" description="Leaderboard across the team" />
        <PageShell>
          <EmptyState title="No rankings yet" actionLabel="Import a report" actionHref="/import" />
        </PageShell>
      </>
    );
  }

  // Rankings is now month-to-date cumulative rather than a single day's
  // snapshot. It used to call loadPeriodDataset() with no id, which always
  // scoped the whole page to just the single most-recently-imported day.
  // That's a problem because a day's import can legitimately be missing a
  // field for most of the roster — e.g. chat metrics land here from a
  // separate import step than the main KYC report, and don't always get
  // merged in for every agent on the same day they're imported — which
  // used to strand most of the team in "Not ranked — insufficient data"
  // even though they had perfectly good data earlier in the month. This
  // now aggregates every daily import in the current month exactly the way
  // Overall MTD already does (see loadRangeDataset in query.ts), so a thin
  // single day no longer drags the whole leaderboard down. MIN_SCORE_
  // COVERAGE (thresholds.ts) still decides who's rankable either way.
  const selectedMonth = months[0]!;
  const monthThruLabel = `${selectedMonth.label} (thru ${formatDate(selectedMonth.end)})`;
  const { ranked, teams } = await loadRangeDataset({
    start: selectedMonth.start,
    end: selectedMonth.end,
    label: monthThruLabel,
    id: `mtd-${selectedMonth.key}`,
    type: "month-to-date",
  });

    const rows: RankingRow[] = ranked.map((r) => ({
    agentId: r.agent.id,
    name: r.agent.name,
    department: r.agent.department,
    finalScore: r.individual.finalScore,
    hasIncompleteData: r.individual.hasIncompleteData,
    // Distinct from hasIncompleteData (which is also true when only SOME
    // metrics are missing, e.g. QA Audit isn't measured yet): this is true
    // only when the agent has no data at all for this period — no import
    // row yet. Used to show a plain "No data" badge instead of a 0.00 score
    // that would otherwise look like a genuine failing grade.
    hasNoData: r.individual.effectiveWeight === 0,
    // True when SOME data exists but it's under MIN_SCORE_COVERAGE of the
    // scorecard's weight (thresholds.ts) — more than just the one metric
    // (QA Audit) missing app-wide. A thin sample like that can otherwise
    // renormalize to a misleadingly high score.
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
  }));

  // Top 3 and "room to grow" 3 only ever draw from agents with a genuinely
  // comparable score this period — an agent with no import yet has a 0.00
  // placeholder that would otherwise wrongly land them in "Room to Grow"
  // (or, on a very sparse period, even "Top Performers"), and an agent
  // reporting only a couple of metrics can renormalize to a misleadingly
  // high score that would wrongly land them in "Top Performers" instead
  // (see MIN_SCORE_COVERAGE in thresholds.ts). They still show up in the
  // full table below either way (in RankingTable's separate "not ranked"
  // section). The two groups are otherwise disjoint: the "room to grow" 3
  // are only drawn from whatever's left after the top 3.
  const scoredRows = rows.filter((r) => !r.hasNoData && !r.hasInsufficientData);
  const toSpotlightAgent = (r: RankingRow) => ({ agentId: r.agentId, name: r.name, department: r.department, score: r.finalScore });
  const topThree = scoredRows.slice(0, 3).map(toSpotlightAgent);
  const growCount = Math.min(3, Math.max(0, scoredRows.length - 3));
  // Full per-metric breakdown, keyed by agent, so Room to Grow's cards can
  // point at each agent's own specific weak KPI(s) rather than just their
  // final score -- the flattened RankingRow above only keeps the display
  // string and point per metric, not enough to rank metrics against each
  // other by grade and weight.
  const metricsByAgent = new Map(ranked.map((r) => [r.agent.id, r.individual.metrics]));
  const roomToGrow = (growCount > 0 ? scoredRows.slice(-growCount) : []).map((r) => {
    const { shown, extraCount } = weakestMetrics(metricsByAgent.get(r.agentId) ?? []);
    return { ...toSpotlightAgent(r), weakMetrics: shown, weakMetricsExtraCount: extraCount };
  });

  return (
    <>
      <TopHeader title="Rankings" description={`Leaderboard for ${monthThruLabel}`} />
      <PageShell>
        <TopPerformersSpotlight agents={topThree} />

        <Card className="mt-4">
          <CardContent className="p-5">
            <RankingTable rows={rows} departments={teams.map((t) => t.name)} showChatCounts />
          </CardContent>
        </Card>

        <div className="mt-4">
          <EncouragementBand agents={roomToGrow} />
        </div>
      </PageShell>
    </>
  );
}
