// Repository abstraction — see README.md "Data architecture" section.
//
// Raw imported data and calculated scores are kept strictly separate: this
// layer only ever stores/returns RAW metrics (agents, teams, periods, raw
// per-agent numbers, penalty records, import records). Scores, gate
// multipliers and bonuses are always derived on read by the /scoring engine
// — never persisted — so changing a scoring rule instantly re-scores every
// period without a data migration.
import type { Agent, ImportRecord, ImportRow, Period, Team } from "@/types/domain";
import type { PenaltyEntry, RawAgentMetrics, RawGateMetrics, RawIndividualMetricKey } from "@/lib/scoring/types";

/** The numeric Business Gate fields stored on a gate row (RawGateMetrics, minus periodId). */
export type GateFieldKey = "clientAvgWaitTimeMin" | "teamProcessingTimeMin" | "chatTeamAvgResponseSec" | "teamTicketAHTMin" | "teamRejectionRatePct";
import type { NewQaAuditInput, QaAuditRecord, QaAuditStatus, QaAuditType } from "@/lib/qa/auditDefinitions";

export interface DataRepository {
  getTeams(): Promise<Team[]>;
  getAgents(): Promise<Agent[]>;
  getPeriods(): Promise<Period[]>;
  getRawMetrics(periodId?: string): Promise<RawAgentMetrics[]>;
  getGateMetrics(periodId: string): Promise<RawGateMetrics | null>;
  getAllGateMetrics(): Promise<RawGateMetrics[]>;
  getPenalties(periodId?: string): Promise<PenaltyEntry[]>;
  // createdAt is set by the store itself on insert (DB default / server
  // clock) -- never something the "Record a penalty" form supplies -- so
  // it's excluded here the same way "id" already is.
  addPenalty(entry: Omit<PenaltyEntry, "id" | "createdAt">): Promise<PenaltyEntry>;
  deletePenalty(id: string): Promise<void>;

  getImports(): Promise<ImportRecord[]>;
  createImport(record: Omit<ImportRecord, "id">, rows: Omit<ImportRow, "id" | "importId">[]): Promise<{ record: ImportRecord; rows: ImportRow[] }>;
  getImportRows(importId: string): Promise<ImportRow[]>;
  commitImport(
    importId: string,
    period: Omit<Period, "id"> & { id?: string },
    metrics: RawAgentMetrics[],
    gate: RawGateMetrics
  ): Promise<Period>;

  /** Removes just this import's own audit-trail record (and its parsed
   *  rows) — never touches a period or its data. Use this when the import's
   *  periodId is shared with another import (deleting the period would
   *  also erase what that other import contributed), or when it has no
   *  periodId at all (never committed, or committed before that link
   *  existed). See deletePeriod for the "wipe this whole day" case. */
  deleteImport(importId: string): Promise<void>;

  /** Removes exactly one agent's single performance_entries row for one
   *  period — the Data Import page's per-record delete, scoped to just
   *  that agent+period pair rather than the whole day (see deletePeriod
   *  for that). (agentId, periodId) uniquely identifies the row (see the
   *  `unique (agent_id, period_id)` constraint in supabase/schema.sql), so
   *  no separate id needs to be threaded through RawAgentMetrics just for
   *  this to work. */
  deleteRawMetric(agentId: string, periodId: string): Promise<void>;

  /** Nulls one individual-metric field, for one agent, across every one of
   *  the given periods that currently has a row for them -- the Data
   *  Import page's "clear a KPI field across a month" action (see
   *  clearIndividualMetricFieldAction in app/import/actions.ts). Distinct
   *  from deleteRawMetric: this leaves the row (and every OTHER field on
   *  it) in place for each day, only blanking the one chosen field, across
   *  potentially many days in one call instead of one day at a time. A
   *  periodId with no existing row for this agent is simply skipped (no
   *  row means no value for any field already, so there's nothing to
   *  clear). Returns how many of the given periods actually had a row that
   *  got cleared. */
  clearIndividualMetricField(agentId: string, periodIds: string[], field: RawIndividualMetricKey): Promise<number>;

  /** Nulls one Business Gate field on every one of the given periods that
   *  has a gate row with a value in it -- the Data Import page's "clear a
   *  Business Gate field across a month" action (see
   *  clearGateFieldRangeAction in app/import/actions.ts). Needed because the
   *  month view keeps a value from ANY import on a day (an empty value never
   *  overrides it), so a leftover from an old PDF import can only be
   *  removed by blanking it at the source. Leaves every other field on the
   *  row untouched. Returns how many periods actually had a value cleared. */
  clearGateMetricField(periodIds: string[], field: GateFieldKey): Promise<number>;

  /** Removes a period and everything stored against it — its raw
   *  individual metrics, its Business Gate metrics, any penalties logged
   *  against it, and any import records that point to it (with their
   *  rows) — so it's immediately gone from every page that reads periods
   *  (Team Performance, Trends, Overall MTD, Dashboard, Rankings,
   *  Scorecards, Reports, Penalties). This is what "delete an imported
   *  file so it's no longer read anywhere" actually means for a period
   *  that only one import ever touched — the normal case now that every
   *  import mints its own daily period. */
  deletePeriod(periodId: string): Promise<void>;

  // QA Audits — see src/lib/qa/auditDefinitions.ts. Kept entirely separate
  // from the raw-metrics tables above: an audit is its own confidential
  // record, and "publish" (see /api/qa-audits/[id]/publish) writes its
  // computed score into performance_entries.qa_audit_pct through the
  // EXISTING commitImportRows() path, the same merge-safe write every PDF
  // import and manual entry already goes through — so no new method was
  // needed here for that half of the feature, only for the audits
  // themselves.
  getQaAudits(filter?: { auditType?: QaAuditType; periodId?: string; agentId?: string }): Promise<QaAuditRecord[]>;
  getQaAuditById(id: string): Promise<QaAuditRecord | null>;
  createQaAudit(input: NewQaAuditInput & { applicablePoints: number; totalPoints: number; percentage: number | null; autoFail: boolean; band: 0 | 1 | 2 | 3 | null }): Promise<QaAuditRecord>;
  /** Rewrites an existing audit in place (answers, remarks, dates, auditor,
   *  agent, period, and the score recomputed from them) while keeping its id,
   *  status ("submitted"/"published") and createdAt untouched -- see the PUT
   *  handler in api/qa-audits/[id]/route.ts, which is what recomputes the
   *  scorecard's QA Audit % afterwards when the audit is published. */
  updateQaAudit(id: string, input: NewQaAuditInput & { applicablePoints: number; totalPoints: number; percentage: number | null; autoFail: boolean; band: 0 | 1 | 2 | 3 | null }): Promise<QaAuditRecord>;
  setQaAuditStatus(id: string, status: QaAuditStatus): Promise<QaAuditRecord>;
  deleteQaAudit(id: string): Promise<void>;
}

let cachedRepo: DataRepository | null = null;

/**
 * Returns the active repository. When Supabase env vars are present, uses
 * the Supabase-backed implementation (durable persistence). Otherwise falls
 * back to an in-memory store seeded from the source PDF data — this is what
 * lets the app run and demo correctly on Vercel with ZERO configuration,
 * per the build requirement of "no missing environment variables at build
 * time" — but it is NOT durable: it resets on every cold start. See
 * .env.example and README.md.
 */
export async function getRepository(): Promise<DataRepository> {
  if (cachedRepo) return cachedRepo;

  const hasSupabase =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (hasSupabase) {
    const { SupabaseRepository } = await import("./supabaseRepository");
    cachedRepo = new SupabaseRepository();
  } else {
    const { LocalRepository } = await import("./localRepository");
    cachedRepo = new LocalRepository();
  }
  return cachedRepo;
}
