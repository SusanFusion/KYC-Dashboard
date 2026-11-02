import type { DataRepository, GateFieldKey } from "./repository";
import type { Agent, ImportRecord, ImportRow, Period, Team } from "@/types/domain";
import type { PenaltyEntry, RawAgentMetrics, RawGateMetrics, RawIndividualMetricKey } from "@/lib/scoring/types";
import type { NewQaAuditInput, QaAuditRecord, QaAuditStatus, QaAuditType } from "@/lib/qa/auditDefinitions";
import { getSupabaseClient, getSupabaseServiceClient } from "./supabaseClient";

// Maps each RawIndividualMetricKey to its actual performance_entries column
// name -- needed here (and only here) because clearIndividualMetricField
// takes the field to null out as a dynamic parameter, unlike every other
// method in this file where each column is written out by hand.
const INDIVIDUAL_FIELD_COLUMN: Record<RawIndividualMetricKey, string> = {
  totalChatConversations: "total_chat_conversations",
  avgFirstResponseTimeSec: "avg_first_response_time_sec",
  avgResponseTimeSec: "avg_response_time_sec",
  emailAHTSec: "email_aht_sec",
  appAHTSec: "app_aht_sec",
  totalChats: "total_chats",
  csatCount: "csat_count",
  dsatCount: "dsat_count",
  qaAuditPct: "qa_audit_pct",
  emailTicketCount: "email_ticket_count",
};

// Column name of each Business Gate field on gate_metrics, for the same reason
// as INDIVIDUAL_FIELD_COLUMN above.
const GATE_FIELD_COLUMN: Record<GateFieldKey, string> = {
  clientAvgWaitTimeMin: "client_avg_wait_time_min",
  teamProcessingTimeMin: "team_processing_time_min",
  chatTeamAvgResponseSec: "chat_team_avg_response_sec",
  teamTicketAHTMin: "team_ticket_aht_min",
  teamRejectionRatePct: "team_rejection_rate_pct",
};

/**
 * Supabase-backed repository. Mirrors LocalRepository's contract exactly so
 * UI code never needs to know which one it's talking to. See
 * supabase/schema.sql for the table definitions this expects.
 *
 * Reads go through the anon-key client (schema.sql only grants public
 * SELECT policies, which is exactly the read access every page needs).
 * Writes go through the service-role client instead: schema.sql
 * deliberately grants NO insert/update/delete policies to the anon role
 * (writes are only ever meant to happen from validated server code), so a
 * write attempted with the anon key is rejected by Postgres's row-level
 * security — every commit would otherwise fail with a policy-violation
 * error, regardless of how correct the surrounding logic is.
 */
export class SupabaseRepository implements DataRepository {
  private get client() {
    return getSupabaseClient();
  }

  private get writeClient() {
    return getSupabaseServiceClient();
  }

  async getTeams(): Promise<Team[]> {
    const { data, error } = await this.client.from("teams").select("*");
    if (error) throw error;
    return data ?? [];
  }

  async getAgents(): Promise<Agent[]> {
    const { data, error } = await this.client.from("agents").select("*").order("name");
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      teamId: row.team_id as string,
      department: row.department as string,
      status: row.status as Agent["status"],
      tenureEligible: Boolean(row.tenure_eligible),
      createdAt: row.created_at as string,
    }));
  }

  async getPeriods(): Promise<Period[]> {
    const { data, error } = await this.client.from("periods").select("*").order("start_date", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      label: row.label as string,
      type: row.type as Period["type"],
      startDate: row.start_date as string,
      endDate: row.end_date as string,
      generatedAt: row.generated_at as string,
    }));
  }

  async getRawMetrics(periodId?: string): Promise<RawAgentMetrics[]> {
    let query = this.client.from("performance_entries").select("*");
    if (periodId) query = query.eq("period_id", periodId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(mapPerformanceRow);
  }

  async getGateMetrics(periodId: string): Promise<RawGateMetrics | null> {
    const { data, error } = await this.client
      .from("gate_metrics")
      .select("*")
      .eq("period_id", periodId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapGateRow(data) : null;
  }

  async getAllGateMetrics(): Promise<RawGateMetrics[]> {
    const { data, error } = await this.client.from("gate_metrics").select("*");
    if (error) throw error;
    return (data ?? []).map(mapGateRow);
  }

  async getPenalties(periodId?: string): Promise<PenaltyEntry[]> {
    let query = this.client.from("penalties").select("*");
    if (periodId) query = query.eq("period_id", periodId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      agentId: row.agent_id as string,
      periodId: row.period_id as string,
      code: row.code as PenaltyEntry["code"],
      count: row.count as number,
      note: (row.note as string) ?? undefined,
      occurredOn: row.occurred_on as string,
      // Rows recorded before this column existed read back null -- "Unknown"
      // rather than a blank cell, so old records aren't mistaken for a bug.
      recordedBy: (row.recorded_by as string | null) ?? "Unknown",
            createdAt: row.created_at as string,
    }));
  }
  async addPenalty(entry: Omit<PenaltyEntry, "id" | "createdAt">): Promise<PenaltyEntry> {
    const { data, error } = await this.writeClient
      .from("penalties")
      .insert({
        agent_id: entry.agentId,
        period_id: entry.periodId,
        code: entry.code,
        count: entry.count,
        note: entry.note ?? null,
        occurred_on: entry.occurredOn,
        recorded_by: entry.recordedBy,
      })
      .select()
      .single();
    if (error) throw error;
    return {
      id: data.id,
      agentId: data.agent_id,
      periodId: data.period_id,
      code: data.code,
      count: data.count,
      note: data.note ?? undefined,
      occurredOn: data.occurred_on,
      recordedBy: data.recorded_by ?? "Unknown",
            createdAt: data.created_at,
    };
  }

  async deletePenalty(id: string): Promise<void> {
    const { error } = await this.writeClient.from("penalties").delete().eq("id", id);
    if (error) throw error;
  }

  async getImports(): Promise<ImportRecord[]> {
    const { data, error } = await this.client.from("imports").select("*").order("uploaded_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      fileName: row.file_name as string,
      uploadedAt: row.uploaded_at as string,
      periodLabel: (row.period_label as string) ?? null,
      status: row.status as ImportRecord["status"],
      rowCount: row.row_count as number,
      committedAt: (row.committed_at as string) ?? undefined,
      periodId: (row.period_id as string) ?? null,
    }));
  }

  async createImport(
    record: Omit<ImportRecord, "id">,
    rows: Omit<ImportRow, "id" | "importId">[]
  ): Promise<{ record: ImportRecord; rows: ImportRow[] }> {
    const { data: importRow, error } = await this.writeClient
      .from("imports")
      .insert({
        file_name: record.fileName,
        uploaded_at: record.uploadedAt,
        period_label: record.periodLabel,
        status: record.status,
        row_count: record.rowCount,
      })
      .select()
      .single();
    if (error) throw error;

    const importId = importRow.id as string;
    const { data: rowData, error: rowError } = await this.writeClient
      .from("import_rows")
      .insert(
        rows.map((r) => ({
          import_id: importId,
          agent_name_raw: r.agentNameRaw,
          matched_agent_id: r.matchedAgentId,
          metric_key: r.metricKey,
          raw_value: r.rawValue,
          parsed_value: r.parsedValue,
          status: r.status,
          note: r.note ?? null,
        }))
      )
      .select();
    if (rowError) throw rowError;

    return {
      record: { ...record, id: importId },
      rows: (rowData ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        importId,
        agentNameRaw: r.agent_name_raw as string,
        matchedAgentId: (r.matched_agent_id as string) ?? null,
        metricKey: r.metric_key as string,
        rawValue: r.raw_value as string,
        parsedValue: (r.parsed_value as number) ?? null,
        status: r.status as ImportRow["status"],
        note: (r.note as string) ?? undefined,
      })),
    };
  }

  async getImportRows(importId: string): Promise<ImportRow[]> {
    const { data, error } = await this.client.from("import_rows").select("*").eq("import_id", importId);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      importId,
      agentNameRaw: r.agent_name_raw as string,
      matchedAgentId: (r.matched_agent_id as string) ?? null,
      metricKey: r.metric_key as string,
      rawValue: r.raw_value as string,
      parsedValue: (r.parsed_value as number) ?? null,
      status: r.status as ImportRow["status"],
      note: (r.note as string) ?? undefined,
    }));
  }

  async commitImport(
    importId: string,
    period: Omit<Period, "id"> & { id?: string },
    metrics: RawAgentMetrics[],
    gate: RawGateMetrics
  ): Promise<Period> {
    const periodId = period.id ?? crypto.randomUUID();

    const { error: periodError } = await this.writeClient.from("periods").upsert({
      id: periodId,
      label: period.label,
      type: period.type,
      start_date: period.startDate,
      end_date: period.endDate,
      generated_at: period.generatedAt,
    });
    if (periodError) throw periodError;

    const { error: metricsError } = await this.writeClient.from("performance_entries").upsert(
      metrics.map((m) => ({
        agent_id: m.agentId,
        period_id: periodId,
        total_chat_conversations: m.totalChatConversations,
        avg_first_response_time_sec: m.avgFirstResponseTimeSec,
        avg_response_time_sec: m.avgResponseTimeSec,
        email_aht_sec: m.emailAHTSec,
        app_aht_sec: m.appAHTSec,
        total_chats: m.totalChats,
        csat_count: m.csatCount,
        dsat_count: m.dsatCount,
        qa_audit_pct: m.qaAuditPct,
        email_ticket_count: m.emailTicketCount,
      })),
      { onConflict: "agent_id,period_id" }
    );
    if (metricsError) throw metricsError;

    const { error: gateError } = await this.writeClient.from("gate_metrics").upsert(
      {
        period_id: periodId,
        client_avg_wait_time_min: gate.clientAvgWaitTimeMin,
        team_processing_time_min: gate.teamProcessingTimeMin,
        chat_team_avg_response_sec: gate.chatTeamAvgResponseSec,
        team_ticket_aht_min: gate.teamTicketAHTMin,
        // Only sent when this write actually carries a value for it, so
        // saving the four Gate numbers never touches a stored rejection rate
        // (and never fails on a database that doesn't have the column yet).
        ...(gate.teamRejectionRatePct !== undefined ? { team_rejection_rate_pct: gate.teamRejectionRatePct } : {}),
      },
      { onConflict: "period_id" }
    );
    if (gateError) throw gateError;

    await this.writeClient
      .from("imports")
      .update({
        status: "committed",
        committed_at: new Date().toISOString(),
        period_label: period.label,
        period_id: periodId,
      })
      .eq("id", importId);

    return { ...period, id: periodId };
  }

  async deleteImport(importId: string): Promise<void> {
    // import_rows references imports(id) on delete cascade (see schema.sql),
    // so this alone takes the parsed rows with it. Never touches a period
    // or its data — see deletePeriod for that.
    const { error } = await this.writeClient.from("imports").delete().eq("id", importId);
    if (error) throw error;
  }

  async deletePeriod(periodId: string): Promise<void> {
    // Children before the parent — periods' referencing tables have no
    // ON DELETE CASCADE (see schema.sql), so the period row itself would
    // otherwise fail on a foreign-key violation.
    const { error: metricsError } = await this.writeClient.from("performance_entries").delete().eq("period_id", periodId);
    if (metricsError) throw metricsError;

    const { error: gateError } = await this.writeClient.from("gate_metrics").delete().eq("period_id", periodId);
    if (gateError) throw gateError;

    const { error: penaltiesError } = await this.writeClient.from("penalties").delete().eq("period_id", periodId);
    if (penaltiesError) throw penaltiesError;

    // Any import that points to this period no longer refers to anything
    // real once the period is gone — remove it (its rows cascade) rather
    // than leave a dangling audit-trail entry.
    const { error: importsError } = await this.writeClient.from("imports").delete().eq("period_id", periodId);
    if (importsError) throw importsError;

    const { error: periodError } = await this.writeClient.from("periods").delete().eq("id", periodId);
    if (periodError) throw periodError;
  }

  async deleteRawMetric(agentId: string, periodId: string): Promise<void> {
    const { error } = await this.writeClient
      .from("performance_entries")
      .delete()
      .eq("agent_id", agentId)
      .eq("period_id", periodId);
    if (error) throw error;
  }

  async clearIndividualMetricField(agentId: string, periodIds: string[], field: RawIndividualMetricKey): Promise<number> {
    if (periodIds.length === 0) return 0;
    const column = INDIVIDUAL_FIELD_COLUMN[field];
    const { data, error } = await this.writeClient
      .from("performance_entries")
      .update({ [column]: null })
      .eq("agent_id", agentId)
      .in("period_id", periodIds)
      .select("period_id");
    if (error) throw error;
    return (data ?? []).length;
  }

  async clearGateMetricField(periodIds: string[], field: GateFieldKey): Promise<number> {
    if (periodIds.length === 0) return 0;
    const column = GATE_FIELD_COLUMN[field];
    const { data, error } = await this.writeClient
      .from("gate_metrics")
      .update({ [column]: null })
      .in("period_id", periodIds)
      .not(column, "is", null)
      .select("period_id");
    if (error) throw error;
    return (data ?? []).length;
  }

  async getQaAudits(filter?: { auditType?: QaAuditType; periodId?: string; agentId?: string }): Promise<QaAuditRecord[]> {
    // Full audit content (answers/remarks) — every caller of this method is
    // itself behind requireActionAccess() (see the API routes), so reads go
    // through the SERVICE-role client, not the public anon client. There is
    // deliberately no "public read qa_audits" RLS policy for the full table
    // (see the migration SQL) — the anon key must not be able to read this
    // table's confidential columns under any circumstance, including a bug
    // in application code that forgets the password check.
    let query = this.writeClient.from("qa_audits").select("*").order("created_at", { ascending: false });
    if (filter?.auditType) query = query.eq("audit_type", filter.auditType);
    if (filter?.periodId) query = query.eq("period_id", filter.periodId);
    if (filter?.agentId) query = query.eq("agent_id", filter.agentId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(mapQaAuditRow);
  }

  async getQaAuditById(id: string): Promise<QaAuditRecord | null> {
    const { data, error } = await this.writeClient.from("qa_audits").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? mapQaAuditRow(data) : null;
  }

  async createQaAudit(
    input: NewQaAuditInput & {
      applicablePoints: number;
      totalPoints: number;
      percentage: number | null;
      autoFail: boolean;
      band: 0 | 1 | 2 | 3 | null;
    }
  ): Promise<QaAuditRecord> {
    const { data, error } = await this.writeClient
      .from("qa_audits")
      .insert({
        audit_type: input.auditType,
        agent_id: input.agentId,
        agent_name: input.agentName,
        period_id: input.periodId,
        period_label: input.periodLabel,
        auditor_email: input.auditorEmail,
        auditor_name: input.auditorName,
        case_reference: input.caseReference,
        audit_date: input.auditDate,
        // Only sent when there is one, so Emails/Chats audits never touch the
        // application_type column.
        ...(input.applicationType ? { application_type: input.applicationType } : {}),
        answers: input.answers,
        overall_remarks: input.overallRemarks,
        applicable_points: input.applicablePoints,
        total_points: input.totalPoints,
        percentage: input.percentage,
        auto_fail: input.autoFail,
        band: input.band,
        status: "submitted",
      })
      .select()
      .single();
    if (error) throw error;
    return mapQaAuditRow(data);
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
  ): Promise<QaAuditRecord> {
    // status and created_at are deliberately NOT part of this update -- an
    // edit never changes whether an audit is published, only its contents.
    const { data, error } = await this.writeClient
      .from("qa_audits")
      .update({
        audit_type: input.auditType,
        agent_id: input.agentId,
        agent_name: input.agentName,
        period_id: input.periodId,
        period_label: input.periodLabel,
        auditor_email: input.auditorEmail,
        auditor_name: input.auditorName,
        case_reference: input.caseReference,
        audit_date: input.auditDate,
        ...(input.auditType === "applications" ? { application_type: input.applicationType ?? null } : {}),
        answers: input.answers,
        overall_remarks: input.overallRemarks,
        applicable_points: input.applicablePoints,
        total_points: input.totalPoints,
        percentage: input.percentage,
        auto_fail: input.autoFail,
        band: input.band,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return mapQaAuditRow(data);
  }

  async setQaAuditStatus(id: string, status: QaAuditStatus): Promise<QaAuditRecord> {
    const { data, error } = await this.writeClient
      .from("qa_audits")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return mapQaAuditRow(data);
  }

  async deleteQaAudit(id: string): Promise<void> {
    const { error } = await this.writeClient.from("qa_audits").delete().eq("id", id);
    if (error) throw error;
  }
}

function mapPerformanceRow(row: Record<string, unknown>): RawAgentMetrics {
  return {
    agentId: row.agent_id as string,
    periodId: row.period_id as string,
    totalChatConversations: (row.total_chat_conversations as number) ?? null,
    avgFirstResponseTimeSec: (row.avg_first_response_time_sec as number) ?? null,
    avgResponseTimeSec: (row.avg_response_time_sec as number) ?? null,
    emailAHTSec: (row.email_aht_sec as number) ?? null,
    appAHTSec: (row.app_aht_sec as number) ?? null,
    totalChats: (row.total_chats as number) ?? null,
    csatCount: (row.csat_count as number) ?? null,
    dsatCount: (row.dsat_count as number) ?? null,
    qaAuditPct: (row.qa_audit_pct as number) ?? null,
    emailTicketCount: (row.email_ticket_count as number) ?? null,
  };
}

function mapGateRow(row: Record<string, unknown>): RawGateMetrics {
  return {
    periodId: row.period_id as string,
    clientAvgWaitTimeMin: (row.client_avg_wait_time_min as number) ?? null,
    teamProcessingTimeMin: (row.team_processing_time_min as number) ?? null,
    chatTeamAvgResponseSec: (row.chat_team_avg_response_sec as number) ?? null,
    teamTicketAHTMin: (row.team_ticket_aht_min as number) ?? null,
    // Left undefined (not null) when the database has no such column yet, so
    // a read-then-write of this row can never try to write a column that
    // isn't there.
    ...("team_rejection_rate_pct" in row ? { teamRejectionRatePct: (row.team_rejection_rate_pct as number) ?? null } : {}),
  };
}

function mapQaAuditRow(row: Record<string, unknown>): QaAuditRecord {
  return {
    id: row.id as string,
    auditType: row.audit_type as QaAuditType,
    agentId: row.agent_id as string,
    agentName: row.agent_name as string,
    periodId: row.period_id as string,
    periodLabel: row.period_label as string,
    auditorEmail: row.auditor_email as string,
    auditorName: row.auditor_name as string,
    caseReference: (row.case_reference as string) ?? null,
    auditDate: row.audit_date as string,
    applicationType: (row.application_type as QaAuditRecord["applicationType"]) ?? null,
    answers: (row.answers as QaAuditRecord["answers"]) ?? [],
    overallRemarks: (row.overall_remarks as string) ?? null,
    applicablePoints: row.applicable_points as number,
    totalPoints: row.total_points as number,
    percentage: (row.percentage as number) ?? null,
    autoFail: Boolean(row.auto_fail),
    band: (row.band as QaAuditRecord["band"]) ?? null,
    status: row.status as QaAuditRecord["status"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
