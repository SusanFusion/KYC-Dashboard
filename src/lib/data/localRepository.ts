import { SCORECARD_KPI_FIELDS, type DataRepository, type GateFieldKey } from "./repository";
import type { Agent, ImportRecord, ImportRow, Period, Team } from "@/types/domain";
import type { PenaltyEntry, RawAgentMetrics, RawGateMetrics, RawIndividualMetricKey } from "@/lib/scoring/types";
import type { NewQaAuditInput, QaAuditRecord, QaAuditStatus, QaAuditType } from "@/lib/qa/auditDefinitions";
import { SEED_AGENTS } from "./seed/agents";
import { SEED_TEAMS } from "./seed/teams";
import { SEED_PERIODS } from "./seed/periods";
import { buildSeedRawMetrics, buildSeedGateMetrics } from "./seed/rawMetrics";

/**
 * In-memory data store, module-level so it survives across requests within
 * the same warm server process, seeded once from the PDF-derived data. This
 * is the zero-config default (see repository.ts) — fine for evaluating and
 * demoing the app, but NOT durable: a serverless cold start on Vercel resets
 * it back to the seed. Anything imported through Data Import during a
 * session is kept here until that happens.
 */
class Store {
  teams: Team[] = [...SEED_TEAMS];
  agents: Agent[] = [...SEED_AGENTS];
  periods: Period[] = [...SEED_PERIODS];
  rawMetricsByPeriod = new Map<string, RawAgentMetrics[]>();
  gateByPeriod = new Map<string, RawGateMetrics>();
  penalties: PenaltyEntry[] = [];
  imports: ImportRecord[] = [];
  importRows = new Map<string, ImportRow[]>();
  qaAudits: QaAuditRecord[] = [];
  private seq = 0;

  constructor() {
    const period = SEED_PERIODS[0]!;
    this.rawMetricsByPeriod.set(period.id, buildSeedRawMetrics());
    this.gateByPeriod.set(period.id, buildSeedGateMetrics());
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${Date.now()}_${this.seq}`;
  }
}

// A true singleton across hot-reloads in dev / within one lambda instance.
const globalKey = "__kycLocalStore__";
type GlobalWithStore = typeof globalThis & { [globalKey]?: Store };
const g = globalThis as GlobalWithStore;
if (!g[globalKey]) g[globalKey] = new Store();
const store: Store = g[globalKey]!;

export class LocalRepository implements DataRepository {
  async getTeams() {
    return store.teams;
  }

  async getAgents() {
    return store.agents;
  }

  async getPeriods() {
    return [...store.periods].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  }

  async getRawMetrics(periodId?: string) {
    if (periodId) return store.rawMetricsByPeriod.get(periodId) ?? [];
    return [...store.rawMetricsByPeriod.values()].flat();
  }

  async getGateMetrics(periodId: string) {
    return store.gateByPeriod.get(periodId) ?? null;
  }

  async getAllGateMetrics() {
    return [...store.gateByPeriod.values()];
  }

  async getPenalties(periodId?: string) {
    return periodId ? store.penalties.filter((p) => p.periodId === periodId) : store.penalties;
  }

    async addPenalty(entry: Omit<PenaltyEntry, "id" | "createdAt">) {
    // No real DB default now() here (see supabaseRepository.ts) -- this
    // in-memory store has to set the submission timestamp itself.
    const full: PenaltyEntry = { ...entry, id: store.nextId("pen"), createdAt: new Date().toISOString() };
    store.penalties.push(full);
    return full;
  }

  async deletePenalty(id: string) {
    store.penalties = store.penalties.filter((p) => p.id !== id);
  }

  async getImports() {
    return [...store.imports].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  }

  async createImport(record: Omit<ImportRecord, "id">, rows: Omit<ImportRow, "id" | "importId">[]) {
    const importId = store.nextId("imp");
    const fullRecord: ImportRecord = { ...record, id: importId };
    const fullRows: ImportRow[] = rows.map((r) => ({ ...r, id: store.nextId("row"), importId }));
    store.imports.push(fullRecord);
    store.importRows.set(importId, fullRows);
    return { record: fullRecord, rows: fullRows };
  }

  async getImportRows(importId: string) {
    return store.importRows.get(importId) ?? [];
  }

  async commitImport(
    importId: string,
    period: Omit<Period, "id"> & { id?: string },
    metrics: RawAgentMetrics[],
    gate: RawGateMetrics
  ) {
    const periodId = period.id ?? store.nextId("period");
    const fullPeriod: Period = { ...period, id: periodId };

    const existingIdx = store.periods.findIndex((p) => p.id === periodId);
    if (existingIdx >= 0) store.periods[existingIdx] = fullPeriod;
    else store.periods.push(fullPeriod);

    store.rawMetricsByPeriod.set(
      periodId,
      metrics.map((m) => ({ ...m, periodId }))
    );
    store.gateByPeriod.set(periodId, { ...gate, periodId });

    const imp = store.imports.find((i) => i.id === importId);
    if (imp) {
      imp.status = "committed";
      imp.committedAt = new Date().toISOString();
      imp.periodLabel = fullPeriod.label;
      imp.periodId = periodId;
    }

    return fullPeriod;
  }

  async deleteImport(importId: string) {
    store.imports = store.imports.filter((i) => i.id !== importId);
    store.importRows.delete(importId);
  }

  async deletePeriod(periodId: string) {
    store.periods = store.periods.filter((p) => p.id !== periodId);
    store.rawMetricsByPeriod.delete(periodId);
    store.gateByPeriod.delete(periodId);
    store.penalties = store.penalties.filter((p) => p.periodId !== periodId);
    // Any import record that points to this period no longer refers to
    // anything real — drop it (and its rows) along with the period itself,
    // same as the Supabase implementation.
    const orphanedImportIds = store.imports.filter((i) => i.periodId === periodId).map((i) => i.id);
    store.imports = store.imports.filter((i) => i.periodId !== periodId);
    for (const id of orphanedImportIds) store.importRows.delete(id);
  }

  async deleteRawMetric(agentId: string, periodId: string) {
    const rows = store.rawMetricsByPeriod.get(periodId);
    if (!rows) return;
    store.rawMetricsByPeriod.set(
      periodId,
      rows.filter((m) => m.agentId !== agentId)
    );
  }

  async clearIndividualMetricField(agentId: string, periodIds: string[], field: RawIndividualMetricKey) {
    let cleared = 0;
    for (const periodId of periodIds) {
      const rows = store.rawMetricsByPeriod.get(periodId);
      if (!rows) continue;
      const idx = rows.findIndex((m) => m.agentId === agentId);
      if (idx === -1) continue;
      const existing = rows[idx];
      if (!existing) continue;
      const nextRow: RawAgentMetrics = { ...existing };
      (nextRow as unknown as Record<string, number | null>)[field] = null;
      const nextRows = [...rows];
      nextRows[idx] = nextRow;
      store.rawMetricsByPeriod.set(periodId, nextRows);
      cleared += 1;
    }
    return cleared;
  }

  async clearScorecardKpis(agentId: string | null, periodIds: string[]) {
    let cleared = 0;
    for (const periodId of periodIds) {
      const rows = store.rawMetricsByPeriod.get(periodId);
      if (!rows) continue;
      const nextRows = rows.map((row) => {
        if (agentId !== null && row.agentId !== agentId) return row;
        const next: RawAgentMetrics = { ...row };
        for (const field of SCORECARD_KPI_FIELDS) (next as unknown as Record<string, number | null>)[field] = null;
        cleared += 1;
        return next;
      });
      store.rawMetricsByPeriod.set(periodId, nextRows);
    }
    return cleared;
  }

  async clearGateMetricField(periodIds: string[], field: GateFieldKey) {
    let cleared = 0;
    for (const periodId of periodIds) {
      const existing = store.gateByPeriod.get(periodId);
      if (!existing) continue;
      const value = (existing as unknown as Record<string, number | null | undefined>)[field];
      if (value === null || value === undefined) continue;
      const next = { ...existing };
      (next as unknown as Record<string, number | null>)[field] = null;
      store.gateByPeriod.set(periodId, next);
      cleared += 1;
    }
    return cleared;
  }

  async getQaAudits(filter?: { auditType?: QaAuditType; periodId?: string; agentId?: string }) {
    let rows = [...store.qaAudits];
    if (filter?.auditType) rows = rows.filter((a) => a.auditType === filter.auditType);
    if (filter?.periodId) rows = rows.filter((a) => a.periodId === filter.periodId);
    if (filter?.agentId) rows = rows.filter((a) => a.agentId === filter.agentId);
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getQaAuditById(id: string) {
    return store.qaAudits.find((a) => a.id === id) ?? null;
  }

  async createQaAudit(
    input: NewQaAuditInput & {
      applicablePoints: number;
      totalPoints: number;
      percentage: number | null;
      autoFail: boolean;
      band: 0 | 1 | 2 | 3 | null;
    }
  ) {
    const now = new Date().toISOString();
    const record: QaAuditRecord = { ...input, id: store.nextId("qa"), status: "submitted", createdAt: now, updatedAt: now };
    store.qaAudits.push(record);
    return record;
  }

  async updateQaAudit(
    id: string,
    input: NewQaAuditInput & {
      applicablePoints: number;
      totalPoints: number;
      percentage: number | null;
      autoFail: boolean;
      band: 0 | 1 | 2 | 3 | null;
    }
  ) {
    const record = store.qaAudits.find((a) => a.id === id);
    if (!record) throw new Error("Audit not found.");
    // id, status and createdAt are kept as they were -- an edit only
    // rewrites the audit's contents.
    Object.assign(record, input, { updatedAt: new Date().toISOString() });
    return record;
  }

  async setQaAuditStatus(id: string, status: QaAuditStatus) {
    const record = store.qaAudits.find((a) => a.id === id);
    if (!record) throw new Error("Audit not found.");
    record.status = status;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  async deleteQaAudit(id: string) {
    store.qaAudits = store.qaAudits.filter((a) => a.id !== id);
  }
}
