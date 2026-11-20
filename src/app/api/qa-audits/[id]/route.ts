import { NextResponse } from "next/server";
import { getRepository } from "@/lib/data/repository";
import { requireActionAccess } from "@/lib/auth/actionAccess";
import { refreshQaAuditPct } from "@/lib/qa/refreshQaAuditPct";
import { ROSTER } from "@/lib/auth/roster";
import { describeError } from "@/lib/utils";
import {
  allQuestionKeys,
  computeAuditScore,
  getAuditDefinition,
  isQaApplicationType,
  type QaAnswerValue,
  type QaApplicationType,
} from "@/lib/qa/auditDefinitions";

export const runtime = "nodejs";

// GET    /api/qa-audits/[id]  — full confidential record, for the detail view.
// PUT    /api/qa-audits/[id]  — edits an already-submitted audit (answers,
//        remarks, audit date, case reference, auditor, agent, period). The
//        score is recomputed server-side from the saved answers, and the
//        audit keeps its status. If the audit is PUBLISHED, the scorecard's
//        QA Audit % is re-blended straight away (for the new agent/period,
//        and for the old one too if either was changed) -- see
//        refreshQaAuditPct.ts. The audit type itself can't be changed.
// DELETE /api/qa-audits/[id]  — removes a mistaken/duplicate audit entirely,
//        then refreshes the scorecard's qaAuditPct for that agent+period so
//        it never reflects a now-deleted audit — see refreshQaAuditPct.ts.
//        Deleting a published audit re-blends whatever else is still
//        published for that agent+period; if nothing else is published,
//        it reverts to whatever Manual Entry/PDF import last set for that
//        agent+period (or clears to null if there's genuinely nothing
//        else). Deleting an unpublished one is a harmless no-op recompute
//        (it was never part of the blend to begin with).

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const denied = await requireActionAccess();
  if (denied) return denied;

  try {
    const repo = await getRepository();
    const audit = await repo.getQaAuditById(params.id);
    if (!audit) return NextResponse.json({ error: "Audit not found." }, { status: 404 });
    return NextResponse.json({ audit });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error while loading the audit.", detail: describeError(err) }, { status: 500 });
  }
}

const VALID_ANSWER_VALUES = new Set<string>(["yes", "no", "na"]);

function isAnswerValue(v: QaAnswerValue | undefined): v is QaAnswerValue {
  return typeof v === "string" && VALID_ANSWER_VALUES.has(v);
}

interface EditAuditBody {
  agentId?: string;
  periodId?: string;
  auditorEmail?: string;
  caseReference?: string | null;
  auditDate?: string;
  applicationType?: QaApplicationType | null;
  answers?: Record<string, QaAnswerValue>;
  overallRemarks?: string | null;
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const denied = await requireActionAccess();
  if (denied) return denied;

  try {
    const body = (await request.json()) as EditAuditBody;

    const repo = await getRepository();
    const existing = await repo.getQaAuditById(params.id);
    if (!existing) return NextResponse.json({ error: "Audit not found — it may have been deleted." }, { status: 404 });

    const definition = getAuditDefinition(existing.auditType);

    if (!body.agentId) return NextResponse.json({ error: "Pick the agent this audit is for." }, { status: 400 });
    if (!body.periodId) return NextResponse.json({ error: "Pick the period this audit counts toward." }, { status: 400 });
    if (!body.auditorEmail) return NextResponse.json({ error: "Pick who conducted this audit." }, { status: 400 });
    if (!body.auditDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.auditDate)) {
      return NextResponse.json({ error: "Pick the date this audit was performed." }, { status: 400 });
    }

    // Applications audits carry a "New Application" / "Additional Account"
    // type. An older Applications audit saved before this was asked may stay
    // without one; once an audit has a type it can be changed but not cleared.
    let applicationType: QaApplicationType | null = null;
    if (existing.auditType === "applications") {
      if (isQaApplicationType(body.applicationType)) {
        applicationType = body.applicationType;
      } else if (existing.applicationType) {
        return NextResponse.json({ error: "Pick whether this is a New Application or an Additional Account." }, { status: 400 });
      }
    }

    const auditor = ROSTER.find((r) => r.role === "lead" && r.email === body.auditorEmail?.trim().toLowerCase());
    if (!auditor) {
      return NextResponse.json({ error: "The auditor must be one of the KYC Leads/Managers on the roster." }, { status: 400 });
    }

    const requiredKeys = allQuestionKeys(definition);
    const answers = body.answers ?? {};
    const missing = requiredKeys.filter((k) => !isAnswerValue(answers[k]));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Answer every question before saving — ${missing.length} question(s) still need a Yes/No/N/A.` },
        { status: 422 }
      );
    }

    const [agents, periods] = await Promise.all([repo.getAgents(), repo.getPeriods()]);
    const agent = agents.find((a) => a.id === body.agentId);
    if (!agent) return NextResponse.json({ error: "That agent wasn't found." }, { status: 400 });
    const period = periods.find((p) => p.id === body.periodId);
    if (!period) return NextResponse.json({ error: "That period wasn't found." }, { status: 400 });

    // Recomputed from the answers, never trusted from the client -- same as
    // when an audit is first submitted.
    const score = computeAuditScore(answers, definition, body.auditDate);

    const updated = await repo.updateQaAudit(existing.id, {
      auditType: existing.auditType,
      agentId: agent.id,
      agentName: agent.name,
      periodId: period.id,
      periodLabel: period.label,
      auditorEmail: auditor.email,
      auditorName: auditor.name,
      caseReference: body.caseReference?.trim() || null,
      auditDate: body.auditDate,
      applicationType,
      answers: requiredKeys.map((questionKey) => ({ questionKey, value: answers[questionKey] as QaAnswerValue })),
      overallRemarks: body.overallRemarks?.trim() || null,
      applicablePoints: score.applicablePoints,
      totalPoints: score.totalPoints,
      percentage: score.percentage,
      autoFail: score.autoFail,
      band: score.band,
    });

    // An unpublished audit was never part of any scorecard number, so
    // there's nothing to recompute. A published one already is -- re-blend
    // for where it now lives, and for where it used to live if it moved.
    if (existing.status !== "published") {
      return NextResponse.json({ audit: updated, republished: false });
    }

    const { qaAuditPct, blendedFrom, restoredFromImport } = await refreshQaAuditPct(updated.agentId, updated.periodId);
    if (existing.agentId !== updated.agentId || existing.periodId !== updated.periodId) {
      await refreshQaAuditPct(existing.agentId, existing.periodId);
    }

    return NextResponse.json({ audit: updated, republished: true, qaAuditPct, blendedFrom, restoredFromImport });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error while saving the audit.", detail: describeError(err) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const denied = await requireActionAccess();
  if (denied) return denied;

  try {
    const repo = await getRepository();
    const audit = await repo.getQaAuditById(params.id);
    if (!audit) return NextResponse.json({ error: "Audit not found — it may have already been deleted." }, { status: 404 });

    await repo.deleteQaAudit(params.id);

    const { qaAuditPct, blendedFrom, restoredFromImport } = await refreshQaAuditPct(audit.agentId, audit.periodId);

    return NextResponse.json({ ok: true, qaAuditPct, blendedFrom, restoredFromImport });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error while deleting the audit.", detail: describeError(err) }, { status: 500 });
  }
}
