import { NextResponse } from "next/server";
import { getRepository } from "@/lib/data/repository";
import { commitImportRows } from "@/lib/data/commitImportRows";
import type { ImportRow } from "@/types/domain";
import type { RawGateMetrics } from "@/lib/scoring/types";
import { describeError } from "@/lib/utils";
import { requireActionAccess } from "@/lib/auth/actionAccess";

export const runtime = "nodejs";

interface ManualEntryPayload {
  agentId: string;
  metricKey: string;
  value: number;
}

interface ManualImportBody {
  periodLabel?: string | null;
  /** YYYY-MM-DD, from a plain <input type="date"> — required only when
   *  targetPeriodId isn't set (an existing period already has its own
   *  dates; this is only for minting a brand new one). */
  generatedDate?: string | null;
  gate?: Partial<RawGateMetrics>;
  entries: ManualEntryPayload[];
  /** Merge into this existing period instead of creating a new one — see commitImportRows.ts. */
  targetPeriodId?: string | null;
}

// Must match RawAgentMetrics' own fields exactly (see lib/scoring/types.ts) —
// this is the same shape PDF-derived rows populate, so manual entries flow
// through the identical scoring/dashboard pipeline.
const VALID_METRIC_KEYS = new Set([
  "totalChatConversations",
  "avgFirstResponseTimeSec",
  "avgResponseTimeSec",
  "emailAHTSec",
  "appAHTSec",
  "totalChats",
  "csatCount",
  "dsatCount",
  "qaAuditPct",
  "emailTicketCount",
]);

export async function POST(request: Request) {
  try {
    const denied = await requireActionAccess();
    if (denied) return denied;

    const body = (await request.json()) as ManualImportBody;
    if (!Array.isArray(body.entries)) {
      return NextResponse.json({ error: "No values were entered." }, { status: 400 });
    }
    if (!body.targetPeriodId && !body.generatedDate) {
      return NextResponse.json({ error: "Pick a date for this period." }, { status: 400 });
    }
    if (body.generatedDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.generatedDate)) {
      return NextResponse.json({ error: "Date must be in YYYY-MM-DD format." }, { status: 400 });
    }

    const numericEntries = body.entries.filter(
      (e) => VALID_METRIC_KEYS.has(e.metricKey) && typeof e.value === "number" && Number.isFinite(e.value)
    );

    const repo = await getRepository();
    const agents = await repo.getAgents();
    const agentIds = new Set(agents.map((a) => a.id));
    const validEntries = numericEntries.filter((e) => agentIds.has(e.agentId));

    const gateEntries = Object.entries(body.gate ?? {}).filter(
      (pair): pair is [string, number] => typeof pair[1] === "number" && Number.isFinite(pair[1])
    );

    const rejectionRate = body.gate?.teamRejectionRatePct;
    if (typeof rejectionRate === "number" && (!Number.isFinite(rejectionRate) || rejectionRate < 0 || rejectionRate > 100)) {
      return NextResponse.json({ error: "Team Rejection Rate must be a percentage between 0 and 100." }, { status: 422 });
    }

    // Gate-only submissions (e.g. just the two Business Gate fields the team
    // has this week, no per-agent data at all) are valid — only reject if
    // NEITHER kind of value was entered anywhere on the form.
    if (validEntries.length === 0 && gateEntries.length === 0) {
      return NextResponse.json({ error: "Enter at least one value before saving." }, { status: 422 });
    }

    const rowsInput: Omit<ImportRow, "id" | "importId">[] = validEntries.map((e) => {
      const agent = agents.find((a) => a.id === e.agentId)!;
      return {
        agentNameRaw: agent.name,
        matchedAgentId: agent.id,
        metricKey: e.metricKey,
        rawValue: String(e.value),
        parsedValue: e.value,
        status: "extracted" as const,
      };
    });

    // Business Gate values are team-level, not per-agent, so they don't fit
    // the agent-keyed row shape above — but without a row of their own here,
    // they were completely invisible in Import History (no way to tell,
    // after the fact, that a Manual Entry submission ever touched, say,
    // "Avg Team Processing Time" at all). These rows are audit-trail only:
    // commitImportRows below still receives the real values through `gate`,
    // exactly as before, and ignores any row whose matchedAgentId is null
    // (see its `validRows` filter) — so adding these can't cause a gate
    // value to also get miswritten as a fake per-agent metric.
    const gateRowsInput: Omit<ImportRow, "id" | "importId">[] = gateEntries.map(([key, value]) => ({
      agentNameRaw: "Business Gate (team-level)",
      matchedAgentId: null,
      metricKey: key,
      rawValue: String(value),
      parsedValue: value,
      status: "extracted" as const,
    }));

    const allRowsInput = [...rowsInput, ...gateRowsInput];

    const { record, rows } = await repo.createImport(
      {
        fileName: "Manual entry",
        uploadedAt: new Date().toISOString(),
        periodLabel: body.periodLabel ?? null,
        status: "pending_review",
        rowCount: allRowsInput.length,
      },
      allRowsInput
    );

    const result = await commitImportRows({
      importId: record.id,
      rows,
      periodLabel: body.periodLabel ?? null,
      // Only used when minting a brand new period (targetPeriodId unset) —
      // an existing period keeps its own dates, so the fallback here never
      // actually gets used in that case.
      endDateIso: body.generatedDate ?? new Date().toISOString().slice(0, 10),
      gate: body.gate,
      targetPeriodId: body.targetPeriodId,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    return NextResponse.json({ period: result.period, agentsUpdated: result.agentsUpdated, importId: record.id });
  } catch (err) {
    return NextResponse.json(
      { error: "Unexpected error while saving manual entry.", detail: describeError(err) },
      { status: 500 }
    );
  }
}
