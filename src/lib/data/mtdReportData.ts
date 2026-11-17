// Data-loading layer for the "MTD Report" export (mtdReportHtml.ts renders
// what this file computes — same split as weeklyReportHtml.ts/route.ts,
// kept so the render module stays pure and testable).
//
// Deliberately does ONE shared pass over this month's daily periods rather
// than calling loadAgentDailyTrend per agent (which would refetch the same
// day's raw-metrics row once per agent — fine for a single officer's
// Scorecard page, wasteful across the whole roster here) — see rawByDay
// below.

import { getRepository } from "./repository";
import {
  calculateIndividualScore,
  calculateBusinessGate,
  INDIVIDUAL_METRICS,
  GATE_METRICS,
  hasSufficientDataCoverage,
} from "@/lib/scoring";
import { computeTeamQaAverage, type TeamQaAverage } from "@/lib/qa/teamQaAverage";
import { loadRejectionQuality, type RejectionQuality } from "@/lib/rejections/rejectionQuality";
import { getDailyPeriods, loadRangeDataset, type PeriodDataset, type AgentPeriodResult, type RangeSpec } from "./query";
import { monthRange, monthKey as toMonthKey, formatMonthLabel, formatDayLabel, type DateRange } from "./dateRanges";
import type { Agent } from "@/types/domain";
import type {
  Grade,
  GateTier,
  IndividualMetricKey,
  GateMetricKey,
  RawAgentMetrics,
  BusinessGateResult,
} from "@/lib/scoring/types";

export interface MtdAgentMetricDay {
  date: string;
  label: string;
  actual: number | null;
  actualDisplay: string;
  /** null = no data this day for this metric — a genuine gap, never a fabricated grade. */
  grade: Grade | null;
}

export interface MtdAgentMetricSeries {
  key: IndividualMetricKey;
  name: string;
  unit: "minutes" | "seconds" | "percent";
  target: string;
  weight: number;
  /** One entry per daily period in the month, oldest → newest, gap days included as null. */
  days: MtdAgentMetricDay[];
}

export interface MtdAgentSummary {
  agent: Agent;
  result: AgentPeriodResult;
  /** 1-based, among rankable agents only — see MIN_SCORE_COVERAGE in thresholds.ts (same bar Rankings/Dashboard use). Null if not rankable. */
  rank: number | null;
  rankable: boolean;
  /** Count of distinct days this month with at least one real metric value. */
  daysLogged: number;
  metricSeries: MtdAgentMetricSeries[];
}

export interface MtdStreak {
  agentId: string;
  agentName: string;
  metricKey: IndividualMetricKey;
  metricName: string;
  direction: "onTarget" | "belowTarget";
  length: number;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  latestActual: number;
  latestDisplay: string;
  /** Last up to 3 actualDisplay strings in the streak, oldest → newest. */
  recentValues: string[];
  /** Every actual value in the streak (oldest → newest) — sparkline bar heights. */
  sparklineValues: number[];
  target: string;
  unit: "minutes" | "seconds" | "percent";
}

export interface MtdMoMRow {
  agent: Agent;
  prevScore: number | null;
  currentScore: number | null;
  currentRankable: boolean;
  /** True when this agent has no comparable prior-month score at all (excluded from the % splits, still listed). */
  excludedFromComparison: boolean;
}

export interface MtdGateDayPoint {
  date: string;
  label: string;
  /** Gate score as a percentage (multiplier * 100) — null = no Business Gate data at all that day. */
  scorePct: number | null;
}

export interface MtdGateMetricDay {
  date: string;
  label: string;
  actual: number | null;
  actualDisplay: string;
  tier: GateTier | null;
}

export interface MtdGateMetricSeries {
  key: GateMetricKey;
  name: string;
  unit: "minutes" | "seconds";
  weight: number;
  days: MtdGateMetricDay[];
}

export interface MtdReportData {
  monthKey: string;
  monthLabel: string;
  range: DateRange;
  generatedLabel: string;
  currentDataset: PeriodDataset;
  /** Team QA Average and Rejection Quality for the month, shown in the report for visibility only. */
  teamQuality: { qa: TeamQaAverage; rejection: RejectionQuality };
  agents: MtdAgentSummary[];
  rankableAgents: MtdAgentSummary[];
  qaCount: number;
  penaltyCount: number;
  gateOverall: BusinessGateResult | null;
  gateDaily: MtdGateDayPoint[];
  gateMetricSeries: MtdGateMetricSeries[];
  gateDaysLogged: number;
  mom: { prevMonthLabel: string; rows: MtdMoMRow[] } | null;
  /** length >= 3, sorted longest-first. */
  consistentStreaks: MtdStreak[];
  /** length >= 3, sorted longest-first. */
  attentionStreaks: MtdStreak[];
}

/** Same categorization used for calculateIndividualScore's per-metric
 *  grading, applied to a whole day's raw row so a day with real data for a
 *  metric but that lands in the "On Target" or better band counts toward a
 *  Consistent Performers streak, and "Below Target"/"Failing" toward
 *  Agents Needing Attention — mirrors the grade thresholds already defined
 *  per-metric in thresholds.ts, never a separate formula. */
function gradeOf(scored: ReturnType<typeof calculateIndividualScore>, key: IndividualMetricKey): { grade: Grade | null; actual: number | null; display: string } {
  const m = scored.metrics.find((mm) => mm.key === key);
  if (!m || m.excluded || m.actual === null) return { grade: null, actual: null, display: "No data" };
  return { grade: m.grade, actual: m.actual, display: m.actualDisplay };
}

/** Longest CURRENT streak (ending at the most recent real data point) of
 *  consecutive real (non-null) days satisfying `test` — a gap day (no data
 *  for this metric that day) is skipped over, neither breaking nor
 *  extending the streak, same "don't fabricate for a missing day" stance
 *  used everywhere else in this app (MetricTrendChart's connectNulls:
 *  false, etc.). Returns null if the current streak is under 3 days (the
 *  "3+ consecutive" bar both report sections use) or there's no data at all. */
function findCurrentStreak(
  days: MtdAgentMetricDay[],
  test: (grade: Grade) => boolean
): { start: number; end: number; values: MtdAgentMetricDay[] } | null {
  const real = days.filter((d) => d.grade !== null);
  if (real.length === 0) return null;
  let i = real.length - 1;
  if (!test(real[i]!.grade!)) return null;
  let start = i;
  while (start > 0 && test(real[start - 1]!.grade!)) start--;
  const length = i - start + 1;
  if (length < 3) return null;
  return { start, end: i, values: real.slice(start, i + 1) };
}

export async function loadMtdReportData(monthKeyParam?: string): Promise<MtdReportData | null> {
  const repo = await getRepository();
  const [allPeriods, agentsRoster] = await Promise.all([repo.getPeriods(), repo.getAgents()]);
  const dayPeriodsAll = getDailyPeriods(allPeriods);
  if (dayPeriodsAll.length === 0) return null;

  // Every calendar month with at least one daily import, most recent first —
  // duplicated in miniature from listAvailableMonths() (query.ts) rather
  // than imported, because this also needs the FULL list (to find the
  // month right before the selected one for Month-over-Month) where that
  // function's own callers only ever needed the list itself.
  const latestByMonth = new Map<string, string>();
  for (const p of dayPeriodsAll) {
    const key = toMonthKey(p.startDate);
    const prev = latestByMonth.get(key);
    if (!prev || p.startDate > prev) latestByMonth.set(key, p.startDate);
  }
  const monthKeys = [...latestByMonth.keys()].sort((a, b) => (a < b ? 1 : -1));
  if (monthKeys.length === 0) return null;
  const monthKey = monthKeyParam && monthKeys.includes(monthKeyParam) ? monthKeyParam : monthKeys[0]!;
  const monthIndex = monthKeys.indexOf(monthKey);
  const latestDayThisMonth = latestByMonth.get(monthKey)!;
  const prevMonthKey = monthKeys[monthIndex + 1] ?? null;

  const fullMonthRange = monthRange(latestDayThisMonth);
  const range: DateRange = { start: fullMonthRange.start, end: latestDayThisMonth };
  const monthLabel = formatMonthLabel(latestDayThisMonth);

  const now = new Date();
  const generatedLabel = `${new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now)} · ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(now).toLowerCase()}`;

  const spec: RangeSpec = { start: range.start, end: range.end, label: monthLabel, id: `mtd-report-${monthKey}`, type: "month-to-date" };

  const dayPeriods = dayPeriodsAll.filter((p) => p.startDate >= range.start && p.endDate <= range.end);

  const [currentDataset, rejectionQuality, rawByDay, gateByDay, allQaAudits, allPenalties] = await Promise.all([
    loadRangeDataset(spec),
    loadRejectionQuality({ start: range.start, end: range.end }),
    Promise.all(dayPeriods.map((p) => repo.getRawMetrics(p.id))),
    Promise.all(dayPeriods.map((p) => repo.getGateMetrics(p.id))),
    repo.getQaAudits(),
    repo.getPenalties(),
  ]);

  const qaCount = allQaAudits.filter((a) => a.auditDate >= range.start && a.auditDate <= range.end).length;
  // The report's headline "Penalties" count, same as weeklyReportHtml.ts's,
  // is the count of penalty ENTRIES (not deduction amount) -- pulled the
  // same way route.ts's buildWeekData does, straight from repo.getPenalties().
  const penaltyCount = allPenalties
    .filter((p) => p.occurredOn >= range.start && p.occurredOn <= range.end)
    .reduce((sum, p) => sum + p.count, 0);

  const activeAgents = agentsRoster.filter((a) => a.status === "active");

  // ── Per-agent, per-metric daily series (shared across streaks + charts) ──
  const agents: MtdAgentSummary[] = activeAgents.map((agent) => {
    const result = currentDataset.results.find((r) => r.agent.id === agent.id)!;
    let daysLogged = 0;
    const metricSeries: MtdAgentMetricSeries[] = INDIVIDUAL_METRICS.map((def) => ({
      key: def.key,
      name: def.name,
      unit: def.unit,
      target: def.target,
      weight: def.weight,
      days: [],
    }));

    dayPeriods.forEach((period, i) => {
      const raw = rawByDay[i]!.find((r) => r.agentId === agent.id) ?? null;
      const scored = raw ? calculateIndividualScore(raw, []) : null;
      const label = formatDayLabel(period.startDate);
      if (raw && hasAnyRawValue(raw)) daysLogged++;
      for (const s of metricSeries) {
        const g = scored ? gradeOf(scored, s.key) : { grade: null, actual: null, display: "No data" };
        s.days.push({ date: period.startDate, label, actual: g.actual, actualDisplay: g.display, grade: g.grade });
      }
    });

    return { agent, result, rank: null, rankable: false, daysLogged, metricSeries };
  });

  const rankableSet = new Set(
    currentDataset.ranked.filter((r) => hasSufficientDataCoverage(r.individual.effectiveWeight)).map((r) => r.agent.id)
  );
  const rankedActiveOnly = currentDataset.ranked.filter((r) => r.agent.status === "active" && rankableSet.has(r.agent.id));
  rankedActiveOnly.forEach((r, i) => {
    const summary = agents.find((a) => a.agent.id === r.agent.id);
    if (summary) {
      summary.rankable = true;
      summary.rank = i + 1;
    }
  });

  const rankableAgents = agents.filter((a) => a.rankable).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  // ── Streaks ──────────────────────────────────────────────────────────
  const consistentStreaks: MtdStreak[] = [];
  const attentionStreaks: MtdStreak[] = [];
  for (const a of agents) {
    for (const s of a.metricSeries) {
      const onTarget = findCurrentStreak(s.days, (g) => g >= 2);
      if (onTarget) consistentStreaks.push(buildStreak(a.agent, s, onTarget, "onTarget"));
      const belowTarget = findCurrentStreak(s.days, (g) => g <= 1);
      if (belowTarget) attentionStreaks.push(buildStreak(a.agent, s, belowTarget, "belowTarget"));
    }
  }
  consistentStreaks.sort((x, y) => y.length - x.length);
  attentionStreaks.sort((x, y) => y.length - x.length);

  // ── Business Gate — daily series for this month ─────────────────────
  const gateResultByDay = gateByDay.map((raw) => (raw ? calculateBusinessGate(raw) : null));
  const gateDaily: MtdGateDayPoint[] = dayPeriods.map((period, i) => {
    const g = gateResultByDay[i];
    const hasData = g ? g.metrics.some((m) => m.actual !== null) : false;
    return { date: period.startDate, label: formatDayLabel(period.startDate), scorePct: hasData ? g!.gateMultiplier * 100 : null };
  });
  const gateMetricSeries: MtdGateMetricSeries[] = GATE_METRICS.map((def) => ({
    key: def.key,
    name: def.name,
    unit: def.unit,
    weight: def.weight,
    days: dayPeriods.map((period, i) => {
      const m = gateResultByDay[i]?.metrics.find((mm) => mm.key === def.key);
      return {
        date: period.startDate,
        label: formatDayLabel(period.startDate),
        actual: m?.actual ?? null,
        actualDisplay: m?.actualDisplay ?? "No data",
        tier: m?.tier ?? null,
      };
    }),
  }));
  const gateDaysLogged = gateDaily.filter((d) => d.scorePct !== null).length;
  const gateOverall = currentDataset.results[0]?.gate ?? null;

  // ── Month-over-Month ─────────────────────────────────────────────────
  let mom: MtdReportData["mom"] = null;
  if (prevMonthKey) {
    const prevLatestDay = latestByMonth.get(prevMonthKey)!;
    const prevFullRange = monthRange(prevLatestDay);
    // Always the FULL calendar month (not capped at latest-imported-day,
    // unlike the current/selected month) -- every month before the selected
    // one is, by definition, already over.
    const prevSpec: RangeSpec = {
      start: prevFullRange.start,
      end: prevFullRange.end,
      label: formatMonthLabel(prevLatestDay),
      id: `mtd-report-prev-${prevMonthKey}`,
      type: "month-to-date",
    };
    const prevDataset = await loadRangeDataset(prevSpec);
    const prevRankable = new Map(
      prevDataset.ranked
        .filter((r) => hasSufficientDataCoverage(r.individual.effectiveWeight))
        .map((r) => [r.agent.id, r.individual.finalScore])
    );
    const rows: MtdMoMRow[] = agents
      .map((a): MtdMoMRow => {
        const prevScore = prevRankable.get(a.agent.id) ?? null;
        const currentScore = a.rankable ? a.result.individual.finalScore : null;
        // A real, comparable delta needs a rankable score on BOTH sides —
        // an agent ranked last month but not yet this month (or vice
        // versa) has nothing honest to subtract, so they're excluded from
        // the comparison table (still listed in its footnote) rather than
        // rendering a fabricated/NaN change.
        return {
          agent: a.agent,
          prevScore,
          currentScore,
          currentRankable: a.rankable,
          excludedFromComparison: prevScore === null || currentScore === null,
        };
      })
      .filter((r) => r.prevScore !== null || r.currentRankable); // drop agents with no real score in EITHER month
    mom = { prevMonthLabel: formatMonthLabel(prevLatestDay), rows };
  }

  return {
    monthKey,
    monthLabel,
    range,
    generatedLabel,
    currentDataset,
    teamQuality: { qa: computeTeamQaAverage(currentDataset.results), rejection: rejectionQuality },
    agents,
    rankableAgents,
    qaCount,
    penaltyCount,
    gateOverall,
    gateDaily,
    gateMetricSeries,
    gateDaysLogged,
    mom,
    consistentStreaks,
    attentionStreaks,
  };
}

function hasAnyRawValue(raw: RawAgentMetrics): boolean {
  return (
    raw.avgFirstResponseTimeSec !== null ||
    raw.avgResponseTimeSec !== null ||
    raw.emailAHTSec !== null ||
    raw.appAHTSec !== null ||
    raw.qaAuditPct !== null ||
    (raw.csatCount !== null && raw.dsatCount !== null)
  );
}

function buildStreak(
  agent: Agent,
  series: MtdAgentMetricSeries,
  streak: { start: number; end: number; values: MtdAgentMetricDay[] },
  direction: "onTarget" | "belowTarget"
): MtdStreak {
  const latest = streak.values[streak.values.length - 1]!;
  const recent = streak.values.slice(-3);
  return {
    agentId: agent.id,
    agentName: agent.name,
    metricKey: series.key,
    metricName: series.name,
    direction,
    length: streak.values.length,
    periodStart: streak.values[0]!.date,
    periodEnd: latest.date,
    periodLabel: `${streak.values[0]!.date} → ${latest.date}`,
    latestActual: latest.actual!,
    latestDisplay: latest.actualDisplay,
    recentValues: recent.map((d) => d.actualDisplay),
    sparklineValues: streak.values.map((d) => d.actual!),
    target: series.target,
    unit: series.unit,
  };
}
