import { NextResponse } from "next/server";
import { getRepository } from "@/lib/data/repository";
import { requireActionAccess } from "@/lib/auth/actionAccess";
import { ROSTER } from "@/lib/auth/roster";
import { describeError } from "@/lib/utils";
import {
  allQuestionKeys,
  computeAuditScore,
  getAuditDefinition,
  isQaApplicationType,
  type QaAnswerValue,
  type QaApplicationType,
  type QaAuditType,
} from "@/lib/qa/auditDefinitions";

export const runtime = "nodejs";

const VALID_ANSWER_VALUES = new Set<string>(["yes", "no", "na"]);

function isAnswerValue(v: QaAnswerValue | undefined): v is QaAnswerValue {
  return typeof v === "string" && VALID_ANSWER_VALUES.has(v);
}

interface CreateAuditBody {
  auditType?: QaAuditType;
  agentId?: string;
  periodId?: string;
  auditorEmail?: string;
  caseReference?: string | null;
  auditDate?: string;
  applicationType?: QaApplicationType | null;
  answers?: Record<string, QaAnswerValue>;
  overallRemarks?: string | null;
}

// GET  /api/qa-audits?type=applications[&periodId=][&agentId=]
// POST /api/qa-audits   (create a new submitted audit)
//
// Both protected by the same shared Lead/Manager password as Data Import —
// this is where the confidential answers/remarks live (see the
// CONFIDENTIALITY note on QaAuditRecord in auditDefinitions.ts), so nothing
// here is ever fetched by a page before that password has been entered in
// the browser.

export async function GET(request: Request) {
  const denied = await requireActionAccess();
  if (denied) return denied;

  try {
    const { searchParams } = new URL(request.url);
    const auditType = (searchParams.get("type") as QaAuditType | null) ?? undefined;
    const periodId = searchParams.get("periodId") ?? undefined;
    const agentId = searchParams.get("agentId") ?? undefined;

    const repo = await getRepository();
    const audits = await repo.getQaAudits({ auditType, periodId, agentId });
    return NextResponse.json({ audits });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error while loading audits.", detail: describeError(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await requireActionAccess();
  if (denied) return denied;

  try {
    const body = (await request.json()) as CreateAuditBody;

    if (!body.auditType) {
      return NextResponse.json({ error: "Missing audit type." }, { status: 400 });
    }
    let definition;
    try {
      definition = getAuditDefinition(body.auditType);
    } catch {
      return NextResponse.json({ error: `"${body.auditType}" audits aren't available yet.` }, { status: 400 });
    }

    if (!body.agentId) return NextResponse.json({ error: "Pick the agent this audit is for." }, { status: 400 });
    if (!body.periodId) return NextResponse.json({ error: "Pick the period this audit counts toward." }, { status: 400 });
    const auditorEmailInput = body.auditorEmail;
    if (!auditorEmailInput) return NextResponse.json({ error: "Pick who conducted this audit." }, { status: 400 });
    if (!body.auditDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.auditDate)) {
      return NextResponse.json({ error: "Pick the date this audit was performed." }, { status: 400 });
    }

    // Applications audits must say whether this was a New Application or an
    // Additional Account; Emails and Chats audits never carry one.
    let applicationType: QaApplicationType | null = null;
    if (body.auditType === "applications") {
      if (!isQaApplicationType(body.applicationType)) {
        return NextResponse.json({ error: "Pick whether this is a New Application or an Additional Account." }, { status: 400 });
      }
      applicationType = body.applicationType;
    }

    const auditor = ROSTER.find((r) => r.role === "lead" && r.email === auditorEmailInput.trim().toLowerCase());
    if (!auditor) {
      return NextResponse.json({ error: "The auditor must be one of the KYC Leads/Managers on the roster." }, { status: 400 });
    }

    const requiredKeys = allQuestionKeys(definition);
    const answers = body.answers ?? {};
    const missing = requiredKeys.filter((k) => !isAnswerValue(answers[k]));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Answer every question before submitting — ${missing.length} question(s) still need a Yes/No/N/A.` },
        { status: 422 }
      );
    }

    const repo = await getRepository();
    const [agents, periods] = await Promise.all([repo.getAgents(), repo.getPeriods()]);
    const agent = agents.find((a) => a.id === body.agentId);
    if (!agent) return NextResponse.json({ error: "That agent wasn't found." }, { status: 400 });
    const period = periods.find((p) => p.id === body.periodId);
    if (!period) return NextResponse.json({ error: "That period wasn't found." }, { status: 400 });

    // Recomputed server-side from the submitted answers — never trust a
    // client-supplied score, even though the UI shows a live preview of the
    // same calculation as you fill the form in.
    const score = computeAuditScore(answers, definition, body.auditDate);

    const record = await repo.createQaAudit({
      auditType: body.auditType,
      agentId: agent.id,
      agentName: agent.name,
      periodId: period.id,
      periodLabel: period.label,
      auditorEmail: auditor.email,
      auditorName: auditor.name,
      caseReference: body.caseReference?.trim() || null,
      auditDate: body.auditDate,
      applicationType,
      // Every key in requiredKeys already passed isAnswerValue() above (the
      // "missing" check returned early otherwise), so this cast is safe.
      answers: requiredKeys.map((questionKey) => ({ questionKey, value: answers[questionKey] as QaAnswerValue })),
      overallRemarks: body.overallRemarks?.trim() || null,
      applicablePoints: score.applicablePoints,
      totalPoints: score.totalPoints,
      percentage: score.percentage,
      autoFail: score.autoFail,
      band: score.band,
    });

    return NextResponse.json({ audit: record });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error while saving the audit.", detail: describeError(err) }, { status: 500 });
  }
}
