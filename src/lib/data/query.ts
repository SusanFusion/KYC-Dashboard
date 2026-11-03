import { getRepository } from "./repository";
import {
  calculateFullAgentResult,
  calculateIndividualScore,
  calculateBusinessGate,
  INDIVIDUAL_METRICS,
  GATE_METRICS,
  type FullAgentPeriodResult,
} from "@/lib/scoring";
import {
  startOfWeek,
  weekRange,
  monthRange,
  monthKey,
  quarterRange,
  quarterKey,
  formatWeekLabel,
  formatMonthLabel,
  formatQuarterLabel,
  formatDayLabel,
} from "./dateRanges";
import { findRepeatedOffenses, repeatedOffenseEntries, type RepeatedOffenseSummary } from "@/lib/scoring/penalties";
import type { Agent, Period, PeriodType, Team } from "@/types/domain";
import type { IndividualMetricKey, PenaltyEntry, RawAgentMetrics, RawGateMetrics } from "@/lib/scoring/types";

/** A stand-in for an agent with no imported row for this period at all —
 *  every field "No data" rather than the agent being silently left off
 *  Rankings/Scorecards. The scoring engine already treats an all-null raw
 *  record safely: every metric excludes itself, hasIncompleteData is set,
 *  and the final score renormalizes to 0 rather than crashing or dividing
 *  by zero (see individualScore.ts). */
function emptyRawMetrics(agentId: string, periodId: string): RawAgentMetrics {
  return {
    agentId,
    periodId,
    totalChatConversations: null,
    avgFirstResponseTimeSec: null,
    avgResponseTimeSec: null,
    emailAHTSec: null,
    appAHTSec: null,
    totalChats: null,
    csatCount: null,
    dsatCount: null,
    qaAuditPct: null,
    emailTicketCount: null,
  };
}

export interface AgentPeriodResult extends FullAgentPeriodResult {
  agent: Agent;
}

export interface PeriodDataset {
  period: Period | null;
  periods: Period[];
  teams: Team[];
  agents: Agent[];
  gate: RawGateMetrics | null;
  results: AgentPeriodResult[];
  /** Results sorted by final score, descending — index 0 is the Top 1 agent for this period. */
  ranked: AgentPeriodResult[];
  tieForTop: boolean;
  /** Only set for a quarter-to-date dataset: every agent who hit the
   *  Repeated Offenses rule (the same Disciplinary penalty 3+ times in the
   *  quarter) -- see findRepeatedOffenses in scoring/penalties.ts. */
  repeatedOffenses?: RepeatedOffenseSummary[];
}

/**
 * The shared scoring pass used by every dataset loader below, whether the
 * raw metrics came from a single imported period (loadPeriodDataset) or
 * were aggregated across several daily periods (loadRangeDataset) — kept in
 * one place so a single-day view and a weekly/MTD view can never silently
 * diverge on how a score, tie, or "no data" placeholder is derived.
 */
function computeResults(
  agents: Agent[],
  rawMetrics: RawAgentMetrics[],
  gateInput: RawGateMetrics,
  penalties: PenaltyEntry[]
): { results: AgentPeriodResult[]; ranked: AgentPeriodResult[]; tieForTop: boolean } {
  // Every agent on the roster gets a row — even one with no import for this
  // period at all. Previously this started from the imported rows and
  // looked up the agent, so an agent nobody had gotten around to importing
  // yet simply never appeared anywhere (Rankings, Scorecards) with no
  // indication they existed. Starting from the full roster instead means
  // they still show up, just with every metric reading "No data" (and the
  // existing "Incomplete" badge, same as any other partial-data agent).
  const prelim = agents.map((agent) => {
    const raw = rawMetrics.find((r) => r.agentId === agent.id) ?? emptyRawMetrics(agent.id, gateInput.periodId);
    return { raw, agent };
  });

  const scored = prelim.map(({ raw, agent }) => ({
    agent,
    raw,
    finalScore: calculateFullAgentResult({
      rawMetrics: raw,
      rawGate: gateInput,
      penalties,
      isTopPerformer: false,
      tenureEligible: agent.tenureEligible,
    }).individual.finalScore,
  }));

  const maxScore = scored.reduce((max, s) => Math.max(max, s.finalScore), -Infinity);
  const topScorers = scored.filter((s) => s.finalScore === maxScore);
  const tieForTop = topScorers.length > 1;
  const topAgentIds = new Set(topScorers.map((s) => s.agent.id));

  const results: AgentPeriodResult[] = scored.map(({ agent, raw }) =>
    ({
      agent,
      ...calculateFullAgentResult({
        rawMetrics: raw,
        rawGate: gateInput,
        penalties,
        isTopPerformer: topAgentIds.has(agent.id) && !tieForTop,
        tenureEligible: agent.tenureEligible,
      }),
    })
  );

  const ranked = [...results].sort((a, b) => b.individual.finalScore - a.individual.finalScore);
  return { results, ranked, tieForTop };
}

/**
 * The single place page code should call to get a fully-computed dataset
 * for a period: raw data comes from the repository, every score/tier/bonus
 * is derived fresh via the scoring engine (never read pre-calculated from
 * storage — see repository.ts).
 */
export async function loadPeriodDataset(periodId?: string): Promise<PeriodDataset> {
  const repo = await getRepository();
  const [periods, teams, agents] = await Promise.all([repo.getPeriods(), repo.getTeams(), repo.getAgents()]);

  const period = periodId ? periods.find((p) => p.id === periodId) ?? null : periods[0] ?? null;
  if (!period) {
    return { period: null, periods, teams, agents, gate: null, results: [], ranked: [], tieForTop: false };
  }

    // Every penalty ever recorded, not just this period's -- a monthlyGrace
  // -metered code (e.g. Late Onsite <15min, see thresholds.ts) needs to see
  // an agent's whole calendar month to know whether THIS entry is their
  // free 1st-3rd time or a deducting 4th/8th/12th, and this period alone
  // can't tell it that. calculatePenalty still only returns entries whose
  // periodId matches this one -- see its own comment.
  const [rawMetrics, gate, penalties] = await Promise.all([
    repo.getRawMetrics(period.id),
    repo.getGateMetrics(period.id),
    repo.getPenalties(),
  ]);

  const gateInput: RawGateMetrics =
    gate ?? {
      periodId: period.id,
      clientAvgWaitTimeMin: null,
      teamProcessingTimeMin: null,
      chatTeamAvgResponseSec: null,
      teamTicketAHTMin: null,
    };

  const { results, ranked, tieForTop } = computeResults(agents, rawMetrics, gateInput, penalties);

  return { period, periods, teams, agents, gate: gateInput, results, ranked, tieForTop };
}

export async function loadAgentPeriodResult(agentId: string, periodId?: string): Promise<{
  dataset: PeriodDataset;
  result: AgentPeriodResult | null;
  rank: number | null;
}> {
  const dataset = await loadPeriodDataset(periodId);
  const idx = dataset.ranked.findIndex((r) => r.agent.id === agentId);
  return { dataset, result: idx >= 0 ? dataset.ranked[idx]! : null, rank: idx >= 0 ? idx + 1 : null };
}
/** Same shape as loadAgentPeriodResult, but reads a single agent's result out
 *  of an aggregated loadRangeDataset (week/MTD) instead of a single day —
 *  see scorecards/[agentId]/page.tsx, which moved to month-to-date for the
 *  exact reason Rankings did (see loadRangeDataset's own comment): a single
 *  day's import can legitimately be missing a field most of the roster only
 *  has from a different day's import. */
export async function loadAgentRangeResult(agentId: string, spec: RangeSpec): Promise<{
  dataset: PeriodDataset;
  result: AgentPeriodResult | null;
  rank: number | null;
}> {
  const dataset = await loadRangeDataset(spec);
  const idx = dataset.ranked.findIndex((r) => r.agent.id === agentId);
  return { dataset, result: idx >= 0 ? dataset.ranked[idx]! : null, rank: idx >= 0 ? idx + 1 : null };
}
// ─────────────────────────────────────────────────────────────────────────
// Weekly / month-to-date aggregation
//
// A "daily period" is any imported period whose start and end date are the
// same day — every day Susan imports going forward (see commitImportRows.ts,
// which now labels a same-day import "daily" rather than "custom"). A week
// or MTD view is built by gathering every daily period that falls inside
// the target date range and aggregating each agent's raw numbers across
// those days, THEN running that aggregate through the exact same
// computeResults() scoring pass a single day uses — so a week/month view
// can never compute a score by different rules than a single day does.
//
// The two kinds of raw fields aggregate differently:
//   - App AHT and QA Audit % are plain averages with no paired "count of
//     things averaged" field in the data (see notes.ts and the Trends
//     delta-precision fix) — the only honest way to combine several days of
//     them is an unweighted mean across the days that have data.
//   - Email AHT IS paired with a count: each day's email ticket count
//     (emailTicketCount, from the report's "KYC Email Ave Volume" table, the
//     same tickets the AHT is an average of). So Email AHT combines as a
//     ticket-weighted mean, the way Freshdesk's own monthly figure is
//     computed (total handling time / number of tickets), instead of letting
//     a day with a handful of tickets count as much as a day with sixty.
//   - Chat First Response and Chat Avg Response ARE averages over that day's
//     chats, and each day's chat count IS in the data (totalChatConversations),
//     so they combine as a chat-weighted mean -- exactly how the source
//     Freshdesk report computes its own month-to-date figure (total across
//     every chat / number of chats), which a plain mean of daily averages
//     does NOT reproduce when an agent's chat volume varies a lot by day.
//   - Total chats/conversations and CSAT/DSAT counts are true counts, so
//     they SUM across days; CSAT/DSAT % is then re-derived from those
//     summed counts (never averaged as a percentage), which is exact.
// A day with no data for a given agent/field is skipped entirely rather
// than treated as a zero, matching the app's existing "don't penalize for
// missing data" stance (see notes.ts "missing-qa-audit-data").
// ─────────────────────────────────────────────────────────────────────────

const AVERAGE_FIELDS = ["avgFirstResponseTimeSec", "avgResponseTimeSec", "emailAHTSec", "appAHTSec", "qaAuditPct"] as const;
const SUM_FIELDS = ["totalChatConversations", "totalChats", "csatCount", "dsatCount", "emailTicketCount"] as const;
const GATE_FIELDS = ["clientAvgWaitTimeMin", "teamProcessingTimeMin", "chatTeamAvgResponseSec", "teamTicketAHTMin"] as const;

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function sum(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) : null;
}

/** Month/week average of a per-case average (Chat First Response / Chat Avg
 *  Response weighted by chats, Email AHT weighted by email tickets), weighted
 *  by how many cases each day's figure is an average OF. A day explicitly
 *  reporting 0 cases has nothing to contribute and is left out; a day with a
 *  value but no case count at all (an older import, or a report that day
 *  without the volume table) is imputed the average count of the days that do
 *  have one, so it isn't silently dropped. With no usable counts anywhere
 *  this is the plain mean of the days that have a value. */
function volumeWeightedMean(
  dayRows: RawAgentMetrics[],
  field: "avgFirstResponseTimeSec" | "avgResponseTimeSec" | "emailAHTSec",
  weightField: "totalChatConversations" | "emailTicketCount"
): number | null {
  const present: { value: number; cases: number | null }[] = [];
  for (const row of dayRows) {
    const value = row[field];
    if (value === null) continue;
    present.push({ value, cases: row[weightField] });
  }
  if (present.length === 0) return null;

  const counted = present.filter((p) => p.cases !== 0);
  if (counted.length === 0) return mean(present.map((p) => p.value));

  const knownCases = counted.map((p) => p.cases).filter((c): c is number => c !== null && c > 0);
  const fallbackCases = knownCases.length > 0 ? mean(knownCases)! : 1;
  const weightOf = (cases: number | null) => (cases !== null && cases > 0 ? cases : fallbackCases);

  const totalWeight = counted.reduce((s, p) => s + weightOf(p.cases), 0);
  return counted.reduce((s, p) => s + p.value * weightOf(p.cases), 0) / totalWeight;
}

function aggregateAgentRaw(agentId: string, periodId: string, dayRows: RawAgentMetrics[]): RawAgentMetrics {
  if (dayRows.length === 0) return emptyRawMetrics(agentId, periodId);
  const result = emptyRawMetrics(agentId, periodId);
  for (const field of AVERAGE_FIELDS) {
    if (field === "avgFirstResponseTimeSec" || field === "avgResponseTimeSec") {
      result[field] = volumeWeightedMean(dayRows, field, "totalChatConversations");
    } else if (field === "emailAHTSec") {
      result[field] = volumeWeightedMean(dayRows, field, "emailTicketCount");
    } else {
      result[field] = mean(dayRows.map((r) => r[field]).filter((v): v is number => v !== null));
    }
  }
  for (const field of SUM_FIELDS) {
    result[field] = sum(dayRows.map((r) => r[field]).filter((v): v is number => v !== null));
  }
  return result;
}

/** Period average of each Business Gate metric: a plain average of the daily
 *  figures that were entered or imported, every day counting equally. It does
 *  NOT weight by chat or ticket volume and does not look at any individual
 *  agent's numbers -- the Gate is the team figure for the day (typed in, or
 *  read from the PDF's "Chat Team Avg Response Time" and "Team Ticket
 *  Resolution Time" cards), and a week/month/range is the average of those. */
function aggregateGate(dayGates: (RawGateMetrics | null)[], periodId: string): RawGateMetrics {
  const result: RawGateMetrics = {
    periodId,
    clientAvgWaitTimeMin: null,
    teamProcessingTimeMin: null,
    chatTeamAvgResponseSec: null,
    teamTicketAHTMin: null,
  };
  for (const field of GATE_FIELDS) {
    result[field] = mean(dayGates.map((g) => g?.[field] ?? null).filter((v): v is number => v !== null));
  }
  // Team Rejection Rate (visibility only, typed in daily): the same plain
  // average of the days that have a figure. Not a Gate metric, so it plays no
  // part in any tier or multiplier.
  result.teamRejectionRatePct = mean(dayGates.map((g) => g?.teamRejectionRatePct ?? null).filter((v): v is number => v !== null));
  return result;
}

/** Collapses every period imported for the SAME calendar day into one set of
 *  per-agent rows. Each import mints its own period (see commitImportRows.ts),
 *  so a day that was imported twice -- e.g. the chat report re-uploaded after a
 *  correction -- has two daily periods. Averaging across periods would count
 *  that one day twice (and sum its chat/CSAT counts twice). Instead, for each
 *  agent and field the MOST RECENT import that has a value wins, which still
 *  lets a later import fill in fields an earlier one didn't have (e.g. the KYC
 *  report one day, the chat report another) without ever double-counting.
 *  `sets` is ordered oldest import first. */
function collapseDayRaw(sets: RawAgentMetrics[][], periodId: string): RawAgentMetrics[] {
  if (sets.length === 1) return sets[0] ?? [];
  const byAgent = new Map<string, RawAgentMetrics>();
  for (const rows of sets) {
    for (const row of rows) {
      const merged = byAgent.get(row.agentId) ?? emptyRawMetrics(row.agentId, periodId);
      for (const field of [...AVERAGE_FIELDS, ...SUM_FIELDS]) {
        const value = row[field];
        if (value !== null) merged[field] = value;
      }
      byAgent.set(row.agentId, merged);
    }
  }
  return [...byAgent.values()];
}

/** Same idea as collapseDayRaw, for the team-level Business Gate fields. */
function collapseDayGate(gates: (RawGateMetrics | null)[]): RawGateMetrics | null {
  if (gates.length === 1) return gates[0] ?? null;
  let merged: RawGateMetrics | null = null;
  for (const gate of gates) {
    if (!gate) continue;
    merged = merged ?? {
      periodId: gate.periodId,
      clientAvgWaitTimeMin: null,
      teamProcessingTimeMin: null,
      chatTeamAvgResponseSec: null,
      teamTicketAHTMin: null,
    };
    for (const field of GATE_FIELDS) {
      const value = gate[field];
      if (value !== null) merged[field] = value;
    }
    if (gate.teamRejectionRatePct !== undefined && gate.teamRejectionRatePct !== null) merged.teamRejectionRatePct = gate.teamRejectionRatePct;
  }
  return merged;
}

/** Every imported period whose start and end date are the same day. */
export function getDailyPeriods(allPeriods: Period[]): Period[] {
  return allPeriods.filter((p) => p.startDate === p.endDate).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
}

export interface RangeSpec {
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
  label: string;
  id: string;
  type: PeriodType;
}

/**
 * Aggregates every daily period inside [spec.start, spec.end] into one
 * dataset, shaped exactly like loadPeriodDataset's — same result type, same
 * scoring pass — so any page that already knows how to render a
 * PeriodDataset (Team Performance, Trends, Rankings) needs no special
 * casing to render a weekly or MTD one instead of a single day's.
 */
export async function loadRangeDataset(spec: RangeSpec): Promise<PeriodDataset> {
  const repo = await getRepository();
  const [allPeriods, teams, agents] = await Promise.all([repo.getPeriods(), repo.getTeams(), repo.getAgents()]);
  const dayPeriods = getDailyPeriods(allPeriods).filter((p) => p.startDate >= spec.start && p.endDate <= spec.end);

  const period: Period = { id: spec.id, label: spec.label, type: spec.type, startDate: spec.start, endDate: spec.end, generatedAt: spec.end };

  const [perPeriodRaw, perPeriodGate, allPenalties, imports] = await Promise.all([
    Promise.all(dayPeriods.map((p) => repo.getRawMetrics(p.id))),
    Promise.all(dayPeriods.map((p) => repo.getGateMetrics(p.id))),
    repo.getPenalties(),
    repo.getImports(),
  ]);

  // One entry per calendar DAY, not per imported period -- a day imported
  // more than once must still count as a single day in every average (see
  // collapseDayRaw). Within a day, imports are ordered oldest -> newest by
  // when each was committed, so the newest value for a field wins.
  const importedAtByPeriod = new Map<string, string>();
  for (const imp of imports) {
    if (!imp.periodId) continue;
    const stamp = imp.committedAt ?? imp.uploadedAt;
    const prev = importedAtByPeriod.get(imp.periodId);
    if (!prev || stamp > prev) importedAtByPeriod.set(imp.periodId, stamp);
  }
  const periodIndexesByDate = new Map<string, number[]>();
  dayPeriods.forEach((p, i) => {
    const list = periodIndexesByDate.get(p.startDate);
    if (list) list.push(i);
    else periodIndexesByDate.set(p.startDate, [i]);
  });
  const perDayRaw: RawAgentMetrics[][] = [];
  const perDayGate: (RawGateMetrics | null)[] = [];
  for (const date of [...periodIndexesByDate.keys()].sort()) {
    const indexes = [...(periodIndexesByDate.get(date) ?? [])].sort((a, b) => {
      const stampA = importedAtByPeriod.get(dayPeriods[a]!.id) ?? "";
      const stampB = importedAtByPeriod.get(dayPeriods[b]!.id) ?? "";
      return stampA < stampB ? -1 : stampA > stampB ? 1 : 0;
    });
    perDayRaw.push(collapseDayRaw(indexes.map((i) => perPeriodRaw[i] ?? []), spec.id));
    perDayGate.push(collapseDayGate(indexes.map((i) => perPeriodGate[i] ?? null)));
  }

  const rawMetrics = agents.map((agent) => {
    const rows = perDayRaw.flatMap((dayRows) => dayRows.filter((r) => r.agentId === agent.id));
    return aggregateAgentRaw(agent.id, spec.id, rows);
  });

  const gateInput = aggregateGate(perDayGate, spec.id);
    // Penalties carry their own occurredOn date (independent of which period
  // they were logged against), so a range view re-tags every penalty whose
  // date falls in the window with this range's synthetic period id —
  // calculatePenalty() matches strictly on periodId, so without this remap
  // a week/month's penalties (logged against their own daily period ids)
  // would silently fail to apply at all. Entries OUTSIDE the window are
  // deliberately kept in the array (with their original periodId, so they
  // still won't show up in this range's results) rather than dropped —
  // calculatePenalty needs an agent's FULL history for a monthlyGrace
  // -metered code (e.g. Late Onsite <15min, see thresholds.ts) to know
  // whether an entry near a week's edge is really their 4th/8th/12th time
  // that whole calendar month, which a week-long (or even a partial-month)
  // window alone can't tell it.
  //
  // For a month-to-date range specifically, the window's own `end` is
  // capped at the latest day actually IMPORTED this month (see
  // listAvailableMonths -- deliberately, since metrics can't exist for a
  // day nothing's been imported for yet). Penalties aren't tied to imports
  // though -- you can log one for any date, including a day later in the
  // month that hasn't been imported yet -- so capping penalty inclusion at
  // that same import cutoff was silently dropping an otherwise-valid entry
  // from every MTD-based view (Scorecards, Rankings) even though it's
  // sitting right there on the Penalties page. A month-to-date range
  // therefore includes every penalty in the same calendar month as
  // spec.start, regardless of spec.end; a week range keeps the exact
  // [start, end] bound as before.
  //
  // A quarter-to-date range works the same way as month-to-date: it covers
  // the WHOLE calendar quarter regardless of how far imports have got, and
  // additionally gets the automatic Repeated Offenses deduction (the same
  // Disciplinary penalty recorded 3+ times in the quarter -- see
  // findRepeatedOffenses), added below as one ordinary penalty entry per
  // affected agent so it flows through the normal scoring path.
  const quarterWindow = spec.type === "quarter-to-date" ? quarterRange(spec.start) : null;
  const inPenaltyWindow = (occurredOn: string) =>
    quarterWindow
      ? occurredOn >= quarterWindow.start && occurredOn <= quarterWindow.end
      : spec.type === "month-to-date"
        ? occurredOn.slice(0, 7) === spec.start.slice(0, 7)
        : occurredOn >= spec.start && occurredOn <= spec.end;
  const penalties = allPenalties.map((p) =>
    inPenaltyWindow(p.occurredOn) ? { ...p, periodId: spec.id } : p
  );
  const repeatedOffenses = quarterWindow ? findRepeatedOffenses(allPenalties, quarterWindow.start, quarterWindow.end) : undefined;
  if (repeatedOffenses) penalties.push(...repeatedOffenseEntries(repeatedOffenses, spec.id));

  const { results, ranked, tieForTop } = computeResults(agents, rawMetrics, gateInput, penalties);

  return { period, periods: allPeriods, teams, agents, gate: gateInput, results, ranked, tieForTop, repeatedOffenses };
}

export interface WeekOption {
  /** Sunday, YYYY-MM-DD — the value used for the week's ?week= param and as loadRangeDataset's start. */
  start: string;
  end: string;
  label: string;
}

/** Every Sunday–Saturday week that contains at least one daily import, most recent first. */
export async function listAvailableWeeks(): Promise<WeekOption[]> {
  const repo = await getRepository();
  const dayPeriods = getDailyPeriods(await repo.getPeriods());
  const starts = new Set(dayPeriods.map((p) => startOfWeek(p.startDate)));
  return [...starts]
    .sort((a, b) => (a < b ? 1 : -1))
    .map((start) => {
      const range = weekRange(start);
      return { start: range.start, end: range.end, label: formatWeekLabel(range) };
    });
}

export interface MonthOption {
  /** "YYYY-MM" — the value used for the month's ?month= param. */
  key: string;
  start: string;
  /** The latest daily import actually on record this month (not necessarily the calendar month's last day). */
  end: string;
  label: string;
}

/** Every calendar month that contains at least one daily import, most recent first — "end" is the latest day actually imported, so an in-progress month reads as MTD-through-that-day rather than projecting the rest of the month. */
export async function listAvailableMonths(): Promise<MonthOption[]> {
  const repo = await getRepository();
  const dayPeriods = getDailyPeriods(await repo.getPeriods());
  const latestByMonth = new Map<string, string>();
  for (const p of dayPeriods) {
    const key = monthKey(p.startDate);
    const prev = latestByMonth.get(key);
    if (!prev || p.startDate > prev) latestByMonth.set(key, p.startDate);
  }
  return [...latestByMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, latestDay]) => ({ key, start: monthRange(latestDay).start, end: latestDay, label: formatMonthLabel(latestDay) }));
}

export interface QuarterOption {
  /** "YYYY-Qn" — the value used for the quarter's ?quarter= param. */
  key: string;
  start: string;
  /** The latest daily import actually on record this quarter. */
  end: string;
  label: string;
}

/** Every calendar quarter that contains at least one daily import, most recent first — same idea as listAvailableMonths. */
export async function listAvailableQuarters(): Promise<QuarterOption[]> {
  const repo = await getRepository();
  const dayPeriods = getDailyPeriods(await repo.getPeriods());
  const latestByQuarter = new Map<string, string>();
  for (const p of dayPeriods) {
    const key = quarterKey(p.startDate);
    const prev = latestByQuarter.get(key);
    if (!prev || p.startDate > prev) latestByQuarter.set(key, p.startDate);
  }
  return [...latestByQuarter.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, latestDay]) => ({ key, start: quarterRange(latestDay).start, end: latestDay, label: formatQuarterLabel(latestDay) }));
}

// ─────────────────────────────────────────────────────────────────────────
// Per-officer daily KPI trends (Trends page "Individual KPI Trends")
//
// Unlike the weekly views above, this deliberately does NOT aggregate: the
// whole point is to see day-to-day movement, so each daily period's raw
// value is graded on its own via the same calculateIndividualScore() every
// other page uses (no separate formula) and plotted as one point. A day
// where this agent has no row at all is a genuine gap (null), never
// treated as zero or silently dropped — the chart just skips drawing a
// line segment across it, matching the app's "don't fabricate missing
// data" stance used everywhere else.
// ─────────────────────────────────────────────────────────────────────────

export interface DailyMetricPoint {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "Sep 14"
  actual: number | null;
  actualDisplay: string;
}

export interface DailyIndividualMetricSeries {
  key: IndividualMetricKey;
  name: string;
  unit: "minutes" | "seconds" | "percent";
  points: DailyMetricPoint[];
}

/**
 * One line series per individual KPI (appAHT, emailAHT, chatAvgResponse,
 * chatFRT, csatDsat, qaAudit) for a single agent, across their most recent
 * `days` daily periods (oldest → newest) — or every daily period on record
 * when `days` is null ("all time").
 */
export async function loadAgentDailyTrend(agentId: string, days: number | null): Promise<DailyIndividualMetricSeries[]> {
  const repo = await getRepository();
  const allDays = getDailyPeriods(await repo.getPeriods()); // already ascending by startDate
  const dayPeriods = days !== null ? allDays.slice(-days) : allDays;

  const rawByDay = await Promise.all(dayPeriods.map((p) => repo.getRawMetrics(p.id)));

  const series: DailyIndividualMetricSeries[] = INDIVIDUAL_METRICS.map((def) => ({
    key: def.key,
    name: def.name,
    unit: def.unit,
    points: [],
  }));

  dayPeriods.forEach((period, i) => {
    const raw = rawByDay[i]!.find((r) => r.agentId === agentId) ?? null;
    // Penalties never affect a metric's own "actual" value (only the final
    // score), so an empty penalty list here is safe — this is purely about
    // reading each day's raw number through the same grading/formatting
    // logic every other page uses, not recomputing a score.
    const scored = raw ? calculateIndividualScore(raw, []) : null;
    const label = formatDayLabel(period.startDate);
    for (const s of series) {
      const m = scored?.metrics.find((mm) => mm.key === s.key);
      s.points.push({
        date: period.startDate,
        label,
        actual: m?.actual ?? null,
        actualDisplay: m?.actualDisplay ?? "No data",
      });
    }
  });

  return series;
}

// ─────────────────────────────────────────────────────────────────────────
// Business Gate multiplier trend (Trends page "Business Gate Multiplier"
// card — the daily companion line)
//
// The card's headline number and its weekly chart are read straight off the
// same per-week BusinessGateResult already computed for every week's
// dataset (see loadRangeDataset/computeResults) — the gate multiplier is
// team-wide, not per-agent, so every agent's `.gate` for a period is
// identical and trends/page.tsx just reads results[0].gate. This is the
// genuinely-daily companion: one point per calendar day, no aggregation.
// ─────────────────────────────────────────────────────────────────────────

/** calculateBusinessGate() defaults an all-null RawGateMetrics to a neutral
 *  1.0000× multiplier (see businessGate.ts's effectiveWeight === 0
 *  fallback) — reading that as "the team scored exactly average" would be
 *  a fabrication when really no Business Gate numbers were ever imported
 *  for that period. Only treat the multiplier as real once at least one of
 *  the four Business Gate metrics actually has a value. */
export function gateMultiplierOrNull(gate: ReturnType<typeof calculateBusinessGate>): number | null {
  return gate.metrics.some((m) => m.actual !== null) ? gate.gateMultiplier : null;
}

export interface DailyGateMultiplierPoint {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "Sep 14"
  /** Null = no Business Gate metrics at all that day — a genuine gap,
   *  never the multiplier's own neutral-default value. */
  multiplier: number | null;
}

/**
 * One point per calendar day (oldest → newest) across the most recent
 * `days` daily periods on record — or every daily period when `days` is
 * null ("all time") — each the Business Gate multiplier for that day
 * alone, computed through the exact same calculateBusinessGate() pass
 * every other Business Gate number in the app uses.
 */
export async function loadGateDailyTrend(days: number | null): Promise<DailyGateMultiplierPoint[]> {
  const repo = await getRepository();
  const allDays = getDailyPeriods(await repo.getPeriods()); // already ascending by startDate
  const dayPeriods = days !== null ? allDays.slice(-days) : allDays;

  const gateByDay = await Promise.all(dayPeriods.map((p) => repo.getGateMetrics(p.id)));

  return dayPeriods.map((period, i) => {
    const raw = gateByDay[i];
    const multiplier = raw ? gateMultiplierOrNull(calculateBusinessGate(raw)) : null;
    return {
      date: period.startDate,
      label: formatDayLabel(period.startDate),
      multiplier,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Business Gate metric trends (Trends page "Business Gate Trends" card) —
// the daily companion to gateWeeklySeries, same relationship
// loadGateDailyTrend has to the weekly multiplier chart above it.
//
// gateWeeklySeries aggregates every daily import inside each week into ONE
// point (so several days imported in the same Sun–Sat week collapse to a
// single point on that chart, by design — see loadRangeDataset/
// aggregateGate). This is the un-aggregated view: one point per calendar
// day, so newly-imported days show up as new points immediately rather
// than only moving the existing week's average. A day with no report for a
// given metric is a real gap (null), never a fabricated value — same rule
// as every other trend line on this page.
// ─────────────────────────────────────────────────────────────────────────

export interface DailyGateMetricPoint {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "Sep 14"
  actual: number | null;
  actualDisplay: string;
}

export interface DailyGateMetricSeries {
  key: string;
  name: string;
  unit: "minutes" | "seconds";
  points: DailyGateMetricPoint[];
}

/**
 * One line series per Business Gate metric (clientAvgWaitTime,
 * teamProcessingTime, chatTeamAvgResponse, teamTicketAHT), across the most
 * recent `days` daily periods on record — or every daily period when `days`
 * is null ("all time") — each day's value read through the exact same
 * calculateBusinessGate() pass every other Business Gate number in the app
 * uses (no separate formula).
 */
export async function loadGateMetricsDailyTrend(days: number | null): Promise<DailyGateMetricSeries[]> {
  const repo = await getRepository();
  const allDays = getDailyPeriods(await repo.getPeriods()); // already ascending by startDate
  const dayPeriods = days !== null ? allDays.slice(-days) : allDays;

  const gateByDay = await Promise.all(dayPeriods.map((p) => repo.getGateMetrics(p.id)));
  const gateResultByDay = gateByDay.map((raw) => (raw ? calculateBusinessGate(raw) : null));

  return GATE_METRICS.map((def) => ({
    key: def.key,
    name: def.name,
    unit: def.unit,
    points: dayPeriods.map((period, i): DailyGateMetricPoint => {
      const m = gateResultByDay[i]?.metrics.find((mm) => mm.key === def.key);
      return {
        date: period.startDate,
        label: formatDayLabel(period.startDate),
        actual: m?.actual ?? null,
        actualDisplay: m?.actualDisplay ?? "No data",
      };
    }),
  }));
}
