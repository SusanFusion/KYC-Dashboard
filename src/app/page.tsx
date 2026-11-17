import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Target, Users, Trophy, Gauge, ArrowRight, Sparkles } from "lucide-react";
import { GateInfoButton } from "@/components/metrics/GateInfoButton";
import { TeamVisibilityCards } from "@/components/metrics/TeamVisibilityCards";
import { computeTeamQaAverage } from "@/lib/qa/teamQaAverage";
import { loadRejectionQuality } from "@/lib/rejections/rejectionQuality";
import { TopHeader } from "@/components/layout/TopHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ScoreRing } from "@/components/dashboard/ScoreRing";
import { GradeBadge, TierBadge, tierTone, gradeTone, type Tone } from "@/components/dashboard/PerformanceBadge";
import { MetricBlockCard } from "@/components/metrics/MetricBlockCard";
import { RankMedal } from "@/components/rankings/RankMedal";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/EmptyState";
import { loadRangeDataset, listAvailableMonths } from "@/lib/data/query";
import { hasSufficientDataCoverage, SCORE_PASS_THRESHOLD } from "@/lib/scoring/thresholds";
import { cn, formatDate, initials } from "@/lib/utils";

// Scores are derived fresh from live data on every request — see
// rankings/page.tsx for why this must never be served from a cached/stale
// build snapshot.
export const dynamic = "force-dynamic";

// Shared with the icon chips on the KPI cards elsewhere in the app — a
// gradient "chip" so each tile's tone reads at a glance rather than through
// a flat icon color alone.
const TONE_CHIP: Record<Tone, string> = {
  primary: "bg-gradient-to-br from-primary to-primary-600 text-white shadow-md shadow-primary/30",
  success: "bg-gradient-to-br from-success to-success/70 text-white shadow-md shadow-success/30",
  warning: "bg-gradient-to-br from-warning to-warning/70 text-white shadow-md shadow-warning/30",
  danger: "bg-gradient-to-br from-danger to-danger/70 text-white shadow-md shadow-danger/30",
  muted: "bg-muted text-muted-foreground",
};

const TONE_BAR: Record<Tone, string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-muted-foreground/40",
};

/**
 * One glass-effect tile inside the hero band — a smaller, calmer sibling of
 * the big ScoreRing centerpiece. Kept local to this page since nothing else
 * needs this exact "hero stat" treatment.
 */
function SpotlightStat({
  icon: Icon,
  label,
  value,
  sublabel,
  tone = "primary",
  progress,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sublabel?: string;
  tone?: Tone;
  progress?: number;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/80 p-4 shadow-card backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-popover/50">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-110 group-hover:rotate-3",
            TONE_CHIP[tone]
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-2 truncate text-xl font-bold tracking-tight text-foreground">{value}</div>
      {sublabel && <p className="mt-1 truncate text-xs text-muted-foreground">{sublabel}</p>}
      {progress !== undefined && <Progress value={progress} className="mt-3" barClassName={TONE_BAR[tone]} />}
    </div>
  );
}

export default async function DashboardPage() {
  const months = await listAvailableMonths();

  if (months.length === 0) {
    return (
      <>
        <TopHeader title="Dashboard" description="Overall KYC team performance" />
        <PageShell>
          <EmptyState
            icon={Gauge}
            title="No performance data yet"
            description="Use Data Import to load a report, and this page turns into your team's live scorecard."
            actionLabel="Go to Data Import"
            actionHref="/import"
          />
        </PageShell>
      </>
    );
  }

  // Month-to-date, the same aggregated view Rankings/Scorecards already use
  // (see loadRangeDataset in query.ts) -- this used to call
  // loadPeriodDataset() with no id, which scoped the whole Dashboard to just
  // the single most-recently-imported day. That's why "Top Performer" here
  // and the "Top Rankings" preview below could disagree with the actual
  // Rankings page: this page was reading one day's snapshot while Rankings
  // had already been switched to a running month-to-date total.
  const selectedMonth = months[0]!;
  const monthThruLabel = `${selectedMonth.label} (thru ${formatDate(selectedMonth.end)})`;
  const { period, results, ranked, tieForTop, gate: rawGate } = await loadRangeDataset({
    start: selectedMonth.start,
    end: selectedMonth.end,
    label: monthThruLabel,
    id: `mtd-${selectedMonth.key}`,
    type: "month-to-date",
  });
  // Visibility only -- neither of these touches the Business Gate or any score.
  const qaAverage = computeTeamQaAverage(results);
  const rejectionQuality = await loadRejectionQuality({ start: selectedMonth.start, end: selectedMonth.end });

  const teamAverage = results.length
    ? results.reduce((sum, r) => sum + r.individual.finalScore, 0) / results.length
    : 0;
  const onTarget = results.filter((r) => r.individual.finalScore >= SCORE_PASS_THRESHOLD).length;
  const incompleteCount = results.filter((r) => r.individual.hasIncompleteData).length;

  // Same "rankable" rule Rankings/RankingTable uses (see isRankable there):
  // an agent with no data yet, or too thin a sample to renormalize fairly
  // (MIN_SCORE_COVERAGE, thresholds.ts), never counts as "Top Performer" or
  // appears in the Top Rankings preview just because an incomplete score
  // happens to renormalize high -- keeps this card and this preview always
  // agreeing with whoever the Rankings page itself shows as #1.
  const rankable = ranked.filter(
    (r) => r.individual.effectiveWeight > 0 && hasSufficientDataCoverage(r.individual.effectiveWeight)
  );
  const topPerformer = rankable[0];

  const teamTone = teamAverage >= SCORE_PASS_THRESHOLD ? "success" : "warning";
  const gateMetricsAvailable = results[0]?.gate.metrics.filter((m) => m.tier !== null).length ?? 0;
  const completePct = results.length > 0 ? ((results.length - incompleteCount) / results.length) * 100 : 0;

  return (
    <>
      <TopHeader
        title="Dashboard"
        description={`Overview for ${monthThruLabel}`}
        actions={<Badge variant="outline">month to date</Badge>}
      />
      <PageShell>
        {/* Hero — the page's centerpiece: a big animated score ring flanked
            by three glass spotlight tiles, on a softly lit gradient band. */}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-card via-card to-primary-50/60 p-6 shadow-popover sm:p-8">
          <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -right-16 h-64 w-64 rounded-full bg-success/15 blur-3xl" />

          <div className="relative z-10 flex flex-col gap-8 lg:flex-row lg:items-center">
            <div className="flex flex-col items-center gap-4 text-center lg:items-start lg:border-r lg:border-border/60 lg:pr-8 lg:text-left">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary-700">
                <Sparkles className="h-3.5 w-3.5" /> Team Average Score
              </span>
              <ScoreRing value={teamAverage} max={3} size={184} tone={teamTone} label="out of 3.00" />
              <div className="flex flex-col items-center gap-1 lg:items-start">
                <Badge variant={teamTone}>{teamAverage >= SCORE_PASS_THRESHOLD ? "On Target" : "Needs Attention"}</Badge>
                <p className="text-xs text-muted-foreground">Individual Scorecard (Layer 2) · {monthThruLabel}</p>
              </div>
            </div>

            <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-3">
              <SpotlightStat
                icon={Target}
                label="Business Gate Multiplier"
                value={results[0] ? `${results[0].gate.gateMultiplier.toFixed(4)}×` : "—"}
                sublabel={results[0] ? `${results[0].gate.overallTier} · Layer 1, team-level` : "Team-level multiplier (Layer 1)"}
                tone={results[0] ? tierTone(results[0].gate.overallTier) : "muted"}
              />
              <SpotlightStat
                icon={Users}
                label="Agents On Target"
                value={`${onTarget} / ${results.length}`}
                sublabel={`Final score ≥ ${SCORE_PASS_THRESHOLD.toFixed(2)}`}
                tone={results.length > 0 && onTarget === results.length ? "success" : "primary"}
                progress={results.length > 0 ? (onTarget / results.length) * 100 : 0}
              />
              <SpotlightStat
                icon={Trophy}
                label="Top Performer"
                value={topPerformer ? topPerformer.agent.name : "—"}
                sublabel={topPerformer ? `Score ${topPerformer.individual.finalScore.toFixed(2)}${tieForTop ? " (tied — confirm manually)" : ""}` : undefined}
                tone="primary"
                progress={topPerformer ? (topPerformer.individual.finalScore / 3) * 100 : undefined}
              />
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="flex items-center gap-1.5">
                  Business Gate — Layer 1
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <GateInfoButton gate={results[0]?.gate ?? null} periodLabel={monthThruLabel} />
                </CardTitle>
                <CardDescription>Team-level multiplier applied to every agent&apos;s score this period.</CardDescription>
              </div>
              <Link href="/team-performance" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                View details <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-semibold text-foreground">
                  {(results[0]?.gate.gateMultiplier ?? 1).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}×
                </span>
                <TierBadge tier={results[0]?.gate.overallTier ?? null} />
                <span className="text-xs text-muted-foreground">
                  = {((results[0]?.gate.gateMultiplier ?? 1) * 100).toFixed(2)}% applied to the base score
                </span>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {results[0]?.gate.metrics.map((m) => (
                  <MetricBlockCard
                    key={m.key}
                    label={m.name}
                    value={m.actualDisplay}
                    tone={tierTone(m.tier)}
                    badge={<TierBadge tier={m.tier} />}
                    bufferLabel={m.tierScore === null ? "Not available this period" : m.bufferLabel}
                    bufferGood={m.bufferGood}
                    emphasized
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Data Quality</CardTitle>
              <CardDescription>Coverage for this period.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Agents scored</span>
                  <span className="font-medium text-foreground">{results.length}</span>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Complete data</span>
                  <span className="font-medium text-foreground">{results.length - incompleteCount} / {results.length}</span>
                </div>
                <Progress value={completePct} className="mt-1.5" barClassName={incompleteCount === 0 ? "bg-success" : "bg-warning"} />
              </div>
              <div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Gate metrics available</span>
                  <span className="font-medium text-foreground">{gateMetricsAvailable} / 4</span>
                </div>
                <Progress value={(gateMetricsAvailable / 4) * 100} className="mt-1.5" />
              </div>
              <Link href="/settings" className="block text-xs text-primary hover:underline">See data notes &amp; assumptions →</Link>
            </CardContent>
          </Card>
        </div>

        <div className="mt-4">
          <TeamVisibilityCards
            periodNoun="this month"
            qaAveragePct={qaAverage.averagePct}
            qaAgentCount={qaAverage.agentCount}
            rejectionQualityPct={rejectionQuality.pct}
            rejectionQualityState={rejectionQuality.state}
            rejectionRatePct={rawGate?.teamRejectionRatePct ?? null}
          />
        </div>

        <Card className="mt-4">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Top Rankings</CardTitle>
              <CardDescription>Highest final scores for {monthThruLabel}.</CardDescription>
            </div>
            <Link href="/rankings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Full rankings <ArrowRight className="h-3.5 w-3.5" /></Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {rankable.slice(0, 5).map((r, i) => {
                const grade = (r.individual.finalScore >= 3 ? 3 : r.individual.finalScore >= 2 ? 2 : r.individual.finalScore >= 1 ? 1 : 0) as
                  | 0
                  | 1
                  | 2
                  | 3;
                const tone = gradeTone(grade);
                return (
                  <Link
                    key={r.agent.id}
                    href={`/scorecards/${r.agent.id}`}
                    className={cn(
                      "group flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted hover:shadow-card",
                      i === 0 && "rank-row-gold",
                      i === 1 && "rank-row-silver",
                      i === 2 && "rank-row-bronze"
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <RankMedal rank={i + 1} size="sm" />
                      <span
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white transition-transform duration-200 group-hover:scale-105",
                          TONE_CHIP[tone]
                        )}
                      >
                        {initials(r.agent.name)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn("truncate text-foreground", i < 3 ? "font-semibold" : "font-medium")}>{r.agent.name}</span>
                          {r.individual.hasIncompleteData && <Badge variant="outline">Incomplete</Badge>}
                        </div>
                        <div className="mt-1 hidden w-32 sm:block">
                          <Progress value={(r.individual.finalScore / 3) * 100} barClassName={TONE_BAR[tone]} />
                        </div>
                      </div>
                    </div>
                    <GradeBadge grade={grade} label={r.individual.finalScore.toFixed(2)} />
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </PageShell>
    </>
  );
}
