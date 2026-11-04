import { ALL_PENALTIES, DISCIPLINARY_PENALTIES } from "./thresholds";
import type { PenaltyEntry, PenaltyCategory, PenaltyStatus, PenaltyMonthlyGrace } from "./types";

export interface AppliedPenalty {
  id: string;
  code: PenaltyEntry["code"];
  label: string;
  category: PenaltyCategory;
  deduction: number;
  count: number;
  /** ISO date the infraction actually occurred on (as entered on the
   *  "Record a penalty" form) -- distinct from when it was logged. */
  occurredOn: string;
  /** Who recorded this entry -- see PenaltyEntry.recordedBy. */
  recordedBy: string;
  /** When this entry was actually submitted -- see PenaltyEntry.createdAt. */
  createdAt: string;
  /** Free-text note typed on the "Record a penalty" form, if any. */
  note?: string;
  /** Present only for employment track-record actions (deduction is always
   *  0 for these) -- see EMPLOYMENT_ACTIONS in thresholds.ts. */
  status?: PenaltyStatus;
}

/** Sorts one agent's entries for a single code chronologically (by
 *  occurredOn, then by id as a stable tiebreak for two entries on the same
 *  day) -- see monthlyGraceShare. Exact same-day ordering never changes the
 *  MONTH's total deduction (that's always a plain floor(totalCount / every),
 *  order-independent); it only decides which specific entry visually
 *  "carries" the deduction when two land on the same date. */
function chronological(entries: PenaltyEntry[]): PenaltyEntry[] {
  return [...entries].sort((a, b) => {
    if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * For a monthlyGrace-metered code (see PenaltyMonthlyGrace -- e.g. "Late
 * Onsite (less than 15 minutes)": free for the first 3 times a calendar
 * month, the 4th time deducts -0.05, 5th-7th free again, 8th deducts, and so
 * on), works out ONE entry's own share of that month's deduction.
 *
 * `sameCodeThisAgent` must be this agent's FULL history for this one code —
 * not just what's in view for the period/range currently being rendered —
 * otherwise an agent's real 4th time this month could read as their "1st"
 * simply because the page happens to only show a single day or one week.
 * See resolveEntry below for where that full history comes from, and count
 * as the running total -- a single entry recorded with count > 1 (several
 * occurrences logged at once) is handled correctly too, since a telescoping
 * floor-division still lands the deduction on whichever occurrence
 * position(s) inside that entry cross a multiple of `every`.
 */
function monthlyGraceShare(entry: PenaltyEntry, sameCodeThisAgent: PenaltyEntry[], grace: PenaltyMonthlyGrace): number {
  const month = entry.occurredOn.slice(0, 7); // YYYY-MM
  const monthEntries = chronological(sameCodeThisAgent.filter((e) => e.occurredOn.slice(0, 7) === month));

  let cumulative = 0;
  for (const e of monthEntries) {
    const before = cumulative;
    cumulative += e.count;
    if (e.id === entry.id) {
      const triggers = Math.floor(cumulative / grace.every) - Math.floor(before / grace.every);
      return triggers * grace.deduction;
    }
  }
  return 0; // unreachable -- entry is always a member of sameCodeThisAgent
}

/**
 * For a consecutiveRun-flagged code (e.g. "Absence with documentation"): a
 * run of entries on consecutive calendar days is ONE absence event, worth
 * one flat deduction -- not one deduction per day. A 3-day documented
 * absence (Mon, Tue, Wed all recorded) deducts -0.30 once, the same as a
 * single one-day absence would. Separate, non-consecutive dates are
 * untouched -- each one is its own run and still deducts on its own, same
 * as before this existed.
 *
 * Mirrors monthlyGraceShare just above: walks the agent's FULL history for
 * this code (same reason as there -- a run can span whichever single
 * date/period happens to be in view right now), groups it into maximal
 * consecutive-day runs, and returns this one entry's *share* of its run's
 * flat deduction -- the earliest entry in each run carries the whole
 * deduction, every other entry in that run carries 0, so the total shown
 * across the log always adds up to exactly one deduction per run (the
 * table already renders a 0-deduction entry as a plain dash, same as a free
 * monthlyGrace occurrence -- see PenaltyRecordsTable).
 *
 * A run only merges entries whose occurredOn dates are back-to-back
 * calendar days (a gap of exactly 1 day, including two entries landing on
 * the very same date) -- any bigger gap (a weekend with no entries logged
 * in between, or any other gap) starts a new run. This treats "consecutive"
 * as literal calendar days; if it's meant to skip scheduled days off, that
 * would need each agent's working-day calendar, which isn't modeled
 * anywhere in this app today.
 */
function consecutiveRunShare(entry: PenaltyEntry, sameCodeThisAgent: PenaltyEntry[], flatDeduction: number): number {
  const sorted = chronological(sameCodeThisAgent);

  // Walked with for...of (not index access) deliberately -- this project's
  // tsconfig has noUncheckedIndexedAccess on, so sorted[i] would type-check
  // as "possibly undefined" even though i is always in range here.
  let prevOccurredOn: string | null = null;
  let isRunStart = true;
  for (const current of sorted) {
    if (prevOccurredOn !== null) {
      const prevDay = Date.parse(`${prevOccurredOn}T00:00:00Z`);
      const curDay = Date.parse(`${current.occurredOn}T00:00:00Z`);
      const dayGap = Math.round((curDay - prevDay) / 86_400_000);
      isRunStart = dayGap > 1;
    }
    if (current.id === entry.id) {
      return isRunStart ? flatDeduction : 0;
    }
    prevOccurredOn = current.occurredOn;
  }
  return 0; // unreachable -- entry is always a member of sameCodeThisAgent
}

/** Resolves one penalty entry against the Disciplinary + Attendance Penalty
 *  tables and works out its deduction (per-occurrence deduction × count, the
 *  monthly-grace share for a metered code like Late Onsite <15min -- see
 *  monthlyGraceShare -- or the consecutive-run share for a code like
 *  Absence with documentation -- see consecutiveRunShare). Shared by
 *  calculatePenalty (period/range-scoped) and calculateAllPenalties (every
 *  entry, no period scoping) below -- both need the exact same per-entry
 *  math, just over a different slice of entries. */
function resolveEntry(p: PenaltyEntry, sameCodeThisAgent: PenaltyEntry[]): AppliedPenalty {
  const def = ALL_PENALTIES.find((d) => d.code === p.code);
  const deduction = def?.monthlyGrace
    ? monthlyGraceShare(p, sameCodeThisAgent, def.monthlyGrace)
    : def?.consecutiveRun
      ? consecutiveRunShare(p, sameCodeThisAgent, def.deduction)
      : (def?.deduction ?? 0) * p.count;
  return {
    id: p.id,
    code: p.code,
    label: def?.label ?? p.code,
    category: def?.category ?? "disciplinary",
    deduction,
    count: p.count,
    occurredOn: p.occurredOn,
    recordedBy: p.recordedBy,
    createdAt: p.createdAt,
    note: p.note,
    status: def?.status,
  };
}

/**
 * Resolves the penalty entries recorded for one agent/period against the
 * Disciplinary + Attendance Penalty tables and returns each with its total
 * deduction. No cap is applied — see notes.ts "penalty-floor".
 *
 * `penalties` must be the agent's FULL penalty history, not just this
 * period/range's -- entries outside `periodId` are filtered out of the
 * RETURNED list same as before, but are still needed internally so a
 * monthly-grace code can see the whole calendar month regardless of which
 * single day or range is actually being viewed (see loadPeriodDataset and
 * loadRangeDataset in query.ts, which both now pass the full list through
 * for exactly this reason).
 */
export function calculatePenalty(
  agentId: string,
  periodId: string,
  penalties: PenaltyEntry[]
): AppliedPenalty[] {
  const agentPenalties = penalties.filter((p) => p.agentId === agentId);

  return agentPenalties
    .filter((p) => p.periodId === periodId)
    .map((p) => resolveEntry(p, agentPenalties.filter((e) => e.code === p.code)));
}

/**
 * Every penalty entry ever recorded for one agent, regardless of which
 * period it's tagged with -- used by the Penalties admin page's "Recorded
 * this period" log (see penalties/page.tsx), which is meant to be a durable
 * running record of everything anyone has logged, not scoped to whichever
 * daily import happens to be "current" today. (calculatePenalty above IS
 * meant to be period/range-scoped -- that's what actually feeds an agent's
 * score on Scorecards/Rankings/Team Performance -- so it stays as-is.)
 * Deductions, including monthlyGrace shares, are computed exactly the same
 * way as calculatePenalty.
 */
export function calculateAllPenalties(agentId: string, penalties: PenaltyEntry[]): AppliedPenalty[] {
  const agentPenalties = penalties.filter((p) => p.agentId === agentId);
  return agentPenalties.map((p) => resolveEntry(p, agentPenalties.filter((e) => e.code === p.code)));
}

export function totalPenaltyDeduction(applied: AppliedPenalty[]): number {
  return applied.reduce((sum, p) => sum + p.deduction, 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Repeated Offenses (3+ in a quarter)
//
// When an agent is recorded for the SAME Disciplinary penalty 3 or more
// times inside one calendar quarter, the quarter score takes one extra
// Repeated Offenses deduction (-0.50 -- see the "repeated_offenses" row in
// DISCIPLINARY_PENALTIES). It is applied ONCE per agent per quarter, no
// matter how many different codes reach 3 or how far past 3 any of them go.
//
// Only Disciplinary codes count (Coaching Opportunity, Major Quality Defect,
// Brand Misuse, Invalid Approval, Invalid Rejection) -- never Attendance
// codes, employment track-record actions, or Repeated Offenses itself. The
// count is the sum of each entry's `count` (one entry can log several
// occurrences at once) for entries whose occurredOn falls inside the quarter.
// ─────────────────────────────────────────────────────────────────────────

/** How many times the SAME Disciplinary penalty must be recorded inside one
 *  calendar quarter before the Repeated Offenses deduction kicks in. */
export const REPEATED_OFFENSE_THRESHOLD = 3;

export interface RepeatedOffenseCode {
  code: PenaltyEntry["code"];
  label: string;
  /** Total occurrences of this code inside the quarter. */
  count: number;
}

export interface RepeatedOffenseSummary {
  agentId: string;
  /** Every Disciplinary code that reached the threshold this quarter, most-recorded first. */
  codes: RepeatedOffenseCode[];
  /** The date the threshold was first crossed (the 3rd occurrence of whichever code got there first). */
  triggeredOn: string;
  /** True when someone already recorded a Repeated Offenses entry by hand inside this quarter -- the automatic deduction is then skipped so it can't count twice. */
  alreadyRecorded: boolean;
  /** The deduction automatically added to the quarter score (0 when alreadyRecorded). */
  deduction: number;
}

const REPEATED_OFFENSES_DEFINITION = DISCIPLINARY_PENALTIES.find((d) => d.code === "repeated_offenses");
const COUNTED_DISCIPLINARY_CODES = new Set<PenaltyEntry["code"]>(
  DISCIPLINARY_PENALTIES.filter((d) => d.code !== "repeated_offenses").map((d) => d.code)
);

/**
 * Finds every agent who hit the Repeated Offenses rule between `start` and
 * `end` (inclusive YYYY-MM-DD -- pass a calendar quarter's first and last
 * day). `penalties` can be the full, unfiltered list for every agent.
 */
export function findRepeatedOffenses(penalties: PenaltyEntry[], start: string, end: string): RepeatedOffenseSummary[] {
  const inWindow = penalties.filter((p) => p.occurredOn >= start && p.occurredOn <= end && p.count > 0);

  const byAgent = new Map<string, PenaltyEntry[]>();
  for (const p of inWindow) {
    const list = byAgent.get(p.agentId);
    if (list) list.push(p);
    else byAgent.set(p.agentId, [p]);
  }

  const summaries: RepeatedOffenseSummary[] = [];
  for (const [agentId, entries] of byAgent) {
    const alreadyRecorded = entries.some((e) => e.code === "repeated_offenses");

    const codes: RepeatedOffenseCode[] = [];
    let triggeredOn: string | null = null;
    for (const code of COUNTED_DISCIPLINARY_CODES) {
      const sameCode = chronological(entries.filter((e) => e.code === code));
      let running = 0;
      let crossedOn: string | null = null;
      for (const e of sameCode) {
        running += e.count;
        if (crossedOn === null && running >= REPEATED_OFFENSE_THRESHOLD) crossedOn = e.occurredOn;
      }
      if (crossedOn === null) continue;
      codes.push({ code, label: ALL_PENALTIES.find((d) => d.code === code)?.label ?? code, count: running });
      if (triggeredOn === null || crossedOn < triggeredOn) triggeredOn = crossedOn;
    }

    if (codes.length === 0 || triggeredOn === null) continue;
    codes.sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
    summaries.push({
      agentId,
      codes,
      triggeredOn,
      alreadyRecorded,
      deduction: alreadyRecorded ? 0 : (REPEATED_OFFENSES_DEFINITION?.deduction ?? 0),
    });
  }

  return summaries.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

/**
 * Turns the summaries from findRepeatedOffenses into ordinary penalty
 * entries tagged with `periodId`, so they flow through calculatePenalty /
 * calculateIndividualScore exactly like a hand-recorded Repeated Offenses
 * entry would (score, "Total Deduction", penalty breakdown) -- no separate
 * scoring path. Summaries that were already recorded by hand are skipped.
 */
export function repeatedOffenseEntries(summaries: RepeatedOffenseSummary[], periodId: string): PenaltyEntry[] {
  return summaries
    .filter((s) => !s.alreadyRecorded)
    .map((s) => ({
      id: `auto-repeated-offenses-${s.agentId}-${periodId}`,
      agentId: s.agentId,
      periodId,
      code: "repeated_offenses" as const,
      count: 1,
      note: `Automatic: ${s.codes.map((c) => `${c.label} x${c.count}`).join(", ")}`,
      occurredOn: s.triggeredOn,
      recordedBy: "Automatic (Repeated Offenses rule)",
      createdAt: `${s.triggeredOn}T00:00:00.000Z`,
    }));
}
