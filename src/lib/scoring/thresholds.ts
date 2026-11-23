// All numeric rules below are transcribed directly from:
//  - "KYC KPI Realignment Framework" (07/29/2026), pages: Business Gate (Layer 1),
//    Proposed Individual Grading Scales (Layer 2), Individual Bonus Bracket,
//    Disciplinary Penalty System, Attendance Penalty.
// Per explicit user instruction, grading uses the "Proposed Individual Grading
// Scales" threshold tables — NOT the arithmetic shown in the framework's
// "Elena" worked example, which contradicts its own tables (see notes.ts).

import type {
  BonusBracket,
  GateMetricDefinition,
  GateTierScore,
  IndividualMetricDefinition,
  PenaltyDefinition,
} from "./types";

/** Layer 1 tier scores — identical scale used across all four Business Gate metrics. */
export const GATE_TIER_SCORES: GateTierScore[] = [
  { tier: "Exceptional", score: 1.15 },
  { tier: "Green", score: 1.0 },
  { tier: "Amber", score: 0.7 },
  { tier: "Red", score: 0.5 },
];

export const GATE_MULTIPLIER_MIN = 0.5;
export const GATE_MULTIPLIER_MAX = 1.15;

/** Layer 1 — The Business Gate. Team-level, applies to every agent's bonus. */
export const GATE_METRICS: GateMetricDefinition[] = [
  {
    key: "clientAvgWaitTime",
    name: "KYC Applications - Client Avg Wait Time (All statuses)",
    weight: 0.35,
    unit: "minutes",
    direction: "lower-is-better",
    bands: [
      { tier: "Exceptional", min: null, max: 60 }, // ≤1hr
      { tier: "Green", min: 60, max: 120 }, // >1hr to 2hrs
      { tier: "Amber", min: 120, max: 180 }, // >2hrs - 3hrs
      { tier: "Red", min: 180, max: null }, // >3hrs
    ],
  },
  {
    key: "teamProcessingTime",
    name: "KYC Applications – Avg Team Processing Time (CS and KYC Statuses)",
    weight: 0.3,
    unit: "minutes",
    direction: "lower-is-better",
    bands: [
      { tier: "Exceptional", min: null, max: 30 }, // ≤30 min
      { tier: "Green", min: 30, max: 90 }, // >30min - 1.5hrs
      { tier: "Amber", min: 90, max: 180 }, // >1.5hrs - 3hrs
      { tier: "Red", min: 180, max: null }, // >3hrs
    ],
  },
  {
    key: "chatTeamAvgResponse",
    name: "Chat - Team Average Response Time",
    weight: 0.2,
    unit: "seconds",
    direction: "lower-is-better",
    bands: [
      { tier: "Exceptional", min: null, max: 30 }, // ≤30 sec
      { tier: "Green", min: 30, max: 40 }, // >30-40 sec
      { tier: "Amber", min: 40, max: 50 }, // >40-50 sec
      { tier: "Red", min: 50, max: null }, // >50 sec
    ],
  },
  {
    key: "teamTicketAHT",
    name: "Team Ticket AHT (includes KYB Application Tickets)",
    weight: 0.15,
    unit: "minutes",
    direction: "lower-is-better",
    bands: [
      { tier: "Exceptional", min: null, max: 30 }, // ≤30 min
      { tier: "Green", min: 30, max: 60 }, // >30min - 1hr
      { tier: "Amber", min: 60, max: 120 }, // >1hr - 2hrs
      { tier: "Red", min: 120, max: null }, // >2hrs
    ],
  },
];

/** Layer 2 — Proposed Individual Grading Scales (the authoritative thresholds). */
export const INDIVIDUAL_METRICS: IndividualMetricDefinition[] = [
  {
    key: "appAHT",
    name: "Agent KYC Application Ave Handling Time – FD",
    weight: 0.35,
    unit: "minutes",
    direction: "lower-is-better",
    target: "≤ 20 minutes average",
    bands: [
      { grade: 3, label: "Exceptional", min: null, max: 20 },
      { grade: 2, label: "On Target", min: 20, max: 25 },
      { grade: 1, label: "Below Target", min: 25, max: 30 },
      { grade: 0, label: "Failing", min: 30, max: null },
    ],
  },
  {
    key: "emailAHT",
    name: "Agent KYC Email Ave Handling Time (Ticket AHT) - includes KYB",
    weight: 0.25,
    unit: "minutes",
    direction: "lower-is-better",
    target: "≤ 15 minutes average",
    bands: [
      { grade: 3, label: "Exceptional", min: null, max: 15 },
      { grade: 2, label: "On Target", min: 15, max: 25 },
      { grade: 1, label: "Below Target", min: 25, max: 35 },
      { grade: 0, label: "Failing", min: 35, max: null },
    ],
  },
  {
    key: "chatAvgResponse",
    name: "Agent Chat Avg Response Time",
    weight: 0.15,
    unit: "seconds",
    direction: "lower-is-better",
    target: "≤ 19 sec",
    bands: [
      { grade: 3, label: "Exceptional", min: null, max: 19 },
      { grade: 2, label: "On Target", min: 19, max: 25 },
      { grade: 1, label: "Below Target", min: 25, max: 30 },
      { grade: 0, label: "Failing", min: 30, max: null },
    ],
  },
  {
    key: "chatFRT",
    name: "Agent Chat First Response Time",
    weight: 0.1,
    unit: "seconds",
    direction: "lower-is-better",
    target: "≤ 10 seconds",
    bands: [
      { grade: 3, label: "Exceptional", min: null, max: 10 },
      { grade: 2, label: "On Target", min: 10, max: 15 },
      { grade: 1, label: "Below Target", min: 15, max: 20 },
      { grade: 0, label: "Failing", min: 20, max: null },
    ],
  },
  {
    key: "csatDsat",
    name: "CSAT / DSAT",
    weight: 0.1,
    unit: "percent",
    direction: "higher-is-better",
    target: "≥ 95%",
    bands: [
      { grade: 3, label: "Exceptional", min: 95, max: null },
      { grade: 2, label: "On Target", min: 90, max: 95 },
      { grade: 1, label: "Below Target", min: 80, max: 90 },
      { grade: 0, label: "Failing", min: null, max: 80 },
    ],
  },
  {
    key: "qaAudit",
    name: "QA Audits",
    weight: 0.05,
    unit: "percent",
    direction: "higher-is-better",
    target: "95% – 100%",
    bands: [
      { grade: 3, label: "Exceptional", min: 95, max: null },
      { grade: 2, label: "On Target", min: 85, max: 95 },
      { grade: 1, label: "Below Target", min: 75, max: 85 },
      { grade: 0, label: "Failing", min: null, max: 75 },
    ],
  },
];

export const INDIVIDUAL_MAX_SCORE = 3;

/**
 * The single pass/fail line used wherever an agent's overall final score
 * (0-3) is shown as green vs red — the Dashboard, Individual Scorecards,
 * Rankings, Quarter, the Score Calculator and the reports all import this
 * rather than each hardcoding their own number, precisely so the pages
 * can't drift out of sync on what counts as "passing" (deliberately
 * independent of the per-metric grade bands above, which use their own
 * 3/2/1/0 thresholds for a different purpose, and of the bonus brackets
 * below, which have their own score cut-offs). Set to 2.50 per Susan.
 */
export const SCORE_PASS_THRESHOLD = 2.5;

/**
 * Minimum share of the individual scorecard's total weight (0-1) that must
 * actually have data before a renormalized finalScore is treated as a real,
 * comparable number in rankings — i.e. before an agent is ranked at all
 * rather than shown separately as not-yet-comparable. calculateIndividualScore
 * renormalizes whatever metrics ARE present back up to a full 0-3 scale (see
 * its own comment) — deliberately, so a small, uniform gap like QA Audit %
 * (5% weight) doesn't drag anyone's score down. QA Audit % is the ONE metric
 * genuinely missing for the whole roster today (see notes.ts
 * "missing-qa-audit-data": "The Daily KYC Team Performance Report has no QA
 * Audit % column for any agent") — that's the actual, documented reason the
 * renormalization exists at all. Set at 0.95 (= 1 − QA Audit's 5% weight),
 * this tolerates exactly that one known gap and nothing more: an agent
 * missing only QA Audit still scores/ranks normally, same as everyone else.
 * An agent missing anything beyond that — e.g. only 2 of 6 metrics reported,
 * both happening to land "Exceptional" — drops below this bar. Per Susan's
 * direction, agents below it are excluded from the ranked comparison
 * entirely and shown as a separate, clearly-unranked group instead of tying
 * or beating fully-reported agents on a number built from a lucky sliver of
 * data. This does NOT change finalScore itself or bonus calculations — only
 * how thin-data agents are ranked/displayed — changing the underlying payout
 * math is a separate decision this doesn't make.
 */
export const MIN_SCORE_COVERAGE = 0.95;

/**
 * Weekly-report-specific counterpart to MIN_SCORE_COVERAGE above (which
 * stays at 0.95 for Month-to-Date views — Dashboard, Rankings, Overall MTD
 * — and is untouched by this). A single calendar week is a much narrower
 * window than Month-to-Date, so a gap that easily gets covered somewhere
 * across a whole month can land entirely inside one specific week: Chat
 * Avg Response, Chat First Response, and CSAT/DSAT often have zero data
 * points within a given week even though the agent reports them fine over
 * the full month — chat/CSAT depend on whether they worked the chat queue
 * that day, not a data gap — and QA Audit is entered roughly once a month,
 * not weekly. Set at 0.60 (= 1 − QA's 5% − Chat Avg's 15% − Chat First's
 * 10% − CSAT's 10%), this tolerates losing all four of those the same way
 * MIN_SCORE_COVERAGE already tolerates losing QA Audit alone, so an agent
 * with a normal App AHT + Email AHT week (0.60 remaining) is still
 * scored/ranked in the Weekly Report instead of flipping to "Insufficient
 * data" purely because the week hasn't finished filling in yet, or their
 * chat volume was light that particular week. Used only by
 * weeklyReportHtml.ts's own isRankable — every other view keeps using the
 * stricter MIN_SCORE_COVERAGE above.
 */
export const MIN_SCORE_COVERAGE_WEEKLY = 0.6;

/** True once at least `minCoverage` (MIN_SCORE_COVERAGE by default) of the
 *  scorecard's total weight is backed by real data — see that constant's
 *  comment for why this matters separately from hasIncompleteData (which
 *  is true for ANY missing metric, even just QA Audit alone, and stays
 *  as-is for the existing "Incomplete" name badge — nearly every agent has
 *  that badge today since QA Audit is missing app-wide; this check is
 *  deliberately stricter). Pass MIN_SCORE_COVERAGE_WEEKLY explicitly for
 *  the Weekly Report's more forgiving bar. A small epsilon guards against
 *  float rounding on the weight sum. */
export function hasSufficientDataCoverage(effectiveWeight: number, minCoverage: number = MIN_SCORE_COVERAGE): boolean {
  return effectiveWeight >= minCoverage - 0.001;
}

/** Individual Bonus Bracket (Department: KYC). */
export const BONUS_BRACKETS: BonusBracket[] = [
  { scoreMin: 3, scoreMax: null, percentage: 0.05, phpAmount: 27001, label: "3.00" },
  { scoreMin: 2.8, scoreMax: 3, percentage: 0.04, phpAmount: 21601, label: "2.80 – 2.99" },
  { scoreMin: 2.6, scoreMax: 2.8, percentage: 0.03, phpAmount: 16201, label: "2.60 – 2.79" },
  { scoreMin: 2.4, scoreMax: 2.6, percentage: 0.02, phpAmount: 10800, label: "2.40 – 2.59" },
  { scoreMin: 2.2, scoreMax: 2.4, percentage: 0.01, phpAmount: 5400, label: "2.20 – 2.39" },
  { scoreMin: -Infinity, scoreMax: 2.2, percentage: 0, phpAmount: 0, label: "2.19 and below" },
];

export const TOP_PERFORMER_BONUS_PHP = 1350;

export const BONUS_TENURE_RULE =
  "Only qualifies for a quarter bonus if the agent has passed 6 months tenure and completed the current quarter.";

/** Disciplinary Penalty System (replaces the old Progressive Sanction KPI). */
export const DISCIPLINARY_PENALTIES: PenaltyDefinition[] = [
  {
    code: "coaching_opportunity",
    category: "disciplinary",
    label: "Coaching Opportunity",
    deduction: 0.05,
    example:
      "Wrong Process, Incomplete and/or No Action Taken, No Notes Left, Missed Application, Failed to Update KYC Status",
  },
  {
    code: "major_quality_defect",
    category: "disciplinary",
    label: "Major Quality Defect",
    deduction: 0.2,
    example:
      "Caused customer escalation, Compliance issues and Potential Company Loss (i.e. Setting to RO when client has open trades, Approving High Risk and Fraudulent Clients)",
  },
  {
    code: "brand_misuse",
    category: "disciplinary",
    label: "Brand Misuse",
    deduction: 0.15,
    example: "Per current brand misuse policy",
  },
  {
    code: "invalid_approval",
    category: "disciplinary",
    label: "Invalid/Incorrect Approval",
    deduction: 0.1,
    example: "Every single instance of invalid/incorrect application approvals",
  },
  {
    code: "invalid_rejection",
    category: "disciplinary",
    label: "Invalid/Incorrect Rejection",
    deduction: 0.05,
    example: "Every single instance of invalid/incorrect application rejection",
  },
  {
    code: "repeated_offenses",
    category: "disciplinary",
    label: "Repeated Offenses (3+ in quarter)",
    deduction: 0.5,
    example: "3 repeated offenses within the quarter = 1 count",
  },
];

/** Attendance Penalty. */
export const ATTENDANCE_PENALTIES: PenaltyDefinition[] = [
    {
    code: "late_onsite_under_15",
    category: "attendance",
    label: "Late Onsite (less than 15 minutes)",
    deduction: 0.05,
    example:
      "Free for the first 3 times in a calendar month. Every 4th time that month (the 4th, 8th, 12th, …) deducts -0.05; the ones in between stay free. Resets at the start of each month.",
    monthlyGrace: { every: 4, deduction: 0.05 },
  },
  {
    code: "late_onsite_15_plus",
    category: "attendance",
    label: "Late Onsite (15 minutes or more)",
    deduction: 0.1,
    example: "—",
  },
  {
    code: "late_wfh_under_15",
    category: "attendance",
    label: "Late WFH (less than 15 minutes)",
    deduction: 0.05,
    example: "—",
  },
  {
    code: "late_wfh_15_plus",
    category: "attendance",
    label: "Late WFH (15 minutes or more)",
    deduction: 0.1,
    example: "—",
  },
  {
    code: "undertime",
    category: "attendance",
    label: "Undertime",
    deduction: 0.1,
    example: "—",
  },
  {
    code: "half_day",
    category: "attendance",
    label: "Half-Day",
    deduction: 0.2,
    example: "—",
  },
  {
    code: "unexcused_absence",
    category: "attendance",
    label: "Unexcused Absence (No/Late Notice/No Documentation)",
    deduction: 0.5,
    example: "—",
  },
  {
    code: "absence_with_documentation",
    category: "attendance",
    label: "Absence with documentation",
    deduction: 0.3,
    example:
      "A run of consecutive days off (e.g. 3 days in a row, one doctor's note) deducts -0.30 once for the whole run, not per day. Separate, non-consecutive dates still deduct -0.30 each.",
    consecutiveRun: true,
  },
];

/**
 * Employment track-record actions -- distinct from the Disciplinary/
 * Attendance tables above in that deduction is always 0: these never touch
 * an agent's score. They exist so an escalation path (feedback → verbal →
 * written → final warning → suspension → dismissal) has an actual place to
 * be logged, alongside the score-affecting infractions, instead of living
 * only in a side conversation. `status` drives the badge shown in place of
 * a numeric deduction wherever these are displayed (see PenaltyTable and
 * the "Recorded this period" table in app/penalties/page.tsx).
 */
export const EMPLOYMENT_ACTIONS: PenaltyDefinition[] = [
  {
    code: "feedback",
    category: "escalation",
    label: "Feedback",
    deduction: 0,
    example: "Informal coaching conversation — no score impact, not an employment record.",
    status: { label: "No deduction", variant: "outline" },
  },
  {
    code: "verbal_warning",
    category: "escalation",
    label: "Verbal Warning",
    deduction: 0,
    example: "No penalty deduction — included in employment track record.",
    status: { label: "Track record", variant: "default" },
  },
  {
    code: "written_warning",
    category: "escalation",
    label: "Written Warning",
    deduction: 0,
    example: "No penalty deduction — included in employment track record.",
    status: { label: "Track record", variant: "default" },
  },
  {
    code: "final_warning",
    category: "escalation",
    label: "Final Warning",
    deduction: 0,
    example: "No penalty deduction — included in employment track record.",
    status: { label: "Track record", variant: "warning" },
  },
  {
    code: "suspension",
    category: "escalation",
    label: "Suspension",
    deduction: 0,
    example: "No penalty deduction — agent is at risk.",
    status: { label: "At risk", variant: "danger" },
  },
  {
    code: "dismissal",
    category: "escalation",
    label: "Dismissal",
    deduction: 0,
    example: "Employment ended.",
    status: { label: "Dismissed", variant: "danger" },
  },
];

export const ALL_PENALTIES: PenaltyDefinition[] = [
  ...DISCIPLINARY_PENALTIES,
  ...ATTENDANCE_PENALTIES,
  ...EMPLOYMENT_ACTIONS,
];

export const PENALTY_NOTE_DEDUCTION_TIMING =
  "Deductions apply to the individual weighted score before the Business Gate multiplier is applied. Feedback, Verbal Warning, Written Warning, Final Warning, Suspension, and Dismissal carry no score deduction — they're employment track-record actions instead (see the table below).";
