// QA Audit forms — Applications / Emails / Chats.
//
// Phase 1 only defines "applications" (see qa-quality/page.tsx). "emails" and
// "chats" are typed and wired everywhere else (DB, repository, API routes,
// the UI panel) so adding them later is just adding their AuditDefinition
// here — no other file needs to change shape.
//
// Kept dependency-free (no React/Next imports), same philosophy as
// lib/scoring/types.ts — the scoring math here is unit-testable on its own.

export type QaAuditType = "applications" | "emails" | "chats";

export const QA_AUDIT_TYPE_LABELS: Record<QaAuditType, string> = {
  applications: "Applications Quality Audit",
  emails: "Emails Audit",
  chats: "Chats Audit",
};

export type QaAnswerValue = "yes" | "no" | "na";

/** What kind of application an Applications audit reviewed. Only asked on the
 *  Applications form; Emails and Chats audits leave it empty. */
export type QaApplicationType = "new_application" | "additional_account";

export const QA_APPLICATION_TYPE_LABELS: Record<QaApplicationType, string> = {
  new_application: "New Application",
  additional_account: "Additional Account",
};

export const QA_APPLICATION_TYPES: QaApplicationType[] = ["new_application", "additional_account"];

export function isQaApplicationType(value: unknown): value is QaApplicationType {
  return typeof value === "string" && (QA_APPLICATION_TYPES as string[]).includes(value);
}

export type QaAuditStatus = "submitted" | "published";

export interface QaAuditAnswer {
  questionKey: string;
  value: QaAnswerValue;
}

/** One reviewable checklist item. `key` is a stable id used to store the
 *  answer — it must never change once audits have been submitted against
 *  it, or old records' answers will stop lining up with their questions. */
export interface AuditQuestionDef {
  key: string;
  label: string;
}

export interface AuditSectionDef {
  key: string;
  title: string;
  /** Zero-tolerance section. Its questions are phrased as violations (e.g.
   *  "Incorrectly Approved/Declined") rather than as correct-practice checks,
   *  so the Yes/No polarity is intentionally flipped here versus every other
   *  section: "No" (the violation did not occur) is the normal, no-penalty
   *  answer and earns the point same as "Yes" does elsewhere; "Yes" (the
   *  violation did occur) earns no point AND makes the whole audit an
   *  Auto-Fail: 0% (band 0) for audits dated 1 Nov 2026 or later, band 0 only
   *  for earlier ones. See computeAuditScore() and AUTO_FAIL_ZERO_FROM. */
  autoFail?: boolean;
  questions: AuditQuestionDef[];
}

export interface AuditBandThreshold {
  grade: 0 | 1 | 2 | 3;
  label: string;
  min: number | null;
  max: number | null;
}

export interface AuditDefinition {
  type: QaAuditType;
  label: string;
  /** Name of the source form, shown on the PDF export footer for traceability. */
  sourceFormName: string;
  sections: AuditSectionDef[];
  /** How an "N/A" answer affects the denominator, per audit type (they were
   *  deliberately built to differ):
   *  - Applications: false/unset — the denominator is fixed at the form's
   *    full question count and never shrinks; N/A earns its point the same
   *    way "Yes" would.
   *  - Emails / Chats: true — N/A is excluded from BOTH the numerator and
   *    the denominator (the denominator shrinks by one for every N/A). */
  naExcludedFromDenominator?: boolean;
}

// Same BAND QUALITY AUDITS reference table printed at the bottom of all
// three source forms (Applications/Emails/Chats) — identical thresholds
// across all audit types.
export const QA_AUDIT_BANDS: AuditBandThreshold[] = [
  { grade: 3, label: "Exceptional", min: 95, max: null },
  { grade: 2, label: "On Target", min: 85, max: 95 },
  { grade: 1, label: "Below Target", min: 75, max: 85 },
  { grade: 0, label: "Failing", min: null, max: 75 },
];

const APPLICATIONS_DEFINITION: AuditDefinition = {
  type: "applications",
  label: QA_AUDIT_TYPE_LABELS.applications,
  sourceFormName: "FMGP - KYC Client Success QA Form",
  sections: [
    {
      key: "decision_accuracy",
      title: "Decision Accuracy",
      questions: [
        { key: "da_1", label: "Did the agent review that all required identity documents valid, acceptable, and matched to the applicant?" },
        {
          key: "da_2",
          label:
            "Did the agent review that all required verification checks are completed before making a decision? (Address, duplicate accounts, IP, Sumsub, country restrictions, etc., as applicable)",
        },
        { key: "da_3", label: "Were all fraud or high-risk indicators identified and handled according to SOP?" },
        { key: "da_4", label: "Did the agent gather sufficient evidence before approving or declining the application?" },
        { key: "da_5", label: "Was the final approval/decline decision correct based on policy and requirements provided?" },
        { key: "da_6", label: "Were policy exceptions identified and handled correctly? (if applicable)" },
        { key: "da_7", label: "Was the appropriate SOP/Knowledge Base followed throughout the review?" },
        {
          key: "da_8",
          label:
            "If Sumsub approved - did the agent follow the correct process/action to take? Ensuring that the pending matters are addressed.",
        },
      ],
    },
    {
      key: "case_handling",
      title: "Case Handling",
      questions: [
        { key: "ch_1", label: "Was the correct workflow followed (pend, escalate, or continue review) when required?" },
        { key: "ch_2", label: "Was the application assigned to the correct referral, CXD, or manager group (if applicable)?" },
        { key: "ch_3", label: "Were all required customer communications and follow-ups (if applicable) completed correctly?" },
        {
          key: "ch_4",
          label:
            "Were SLA/timeframe requirements met (including the 48-hour follow-up rule if applicable)? Normal application - follows processing in less than 30 minutes",
        },
        { key: "ch_5", label: "Was the case endorsed/escalated to the correct team/authorities?" },
      ],
    },
    {
      key: "documentation_closing",
      title: "Documentation & Closing",
      questions: [
        { key: "dc_1", label: "Were the agent's notes accurate, complete, and sufficient to support the decision?" },
        { key: "dc_2", label: "Were the correct ticket status, and group applied?" },
        { key: "dc_3", label: "Was the application actioned in the IDV page?" },
        { key: "dc_4", label: "Was the KYC Status appropriately updated?" },
        { key: "dc_5", label: "Was the ticket closed correctly according to SOP? (No premature tagging?)" },
      ],
    },
    {
      key: "auto_fail",
      title: "Auto-Fail",
      autoFail: true,
      questions: [
        // The source spreadsheet's text was cut off mid-parenthesis here
        // ("Incorrectly Approved/Declined (Approved t...") — kept to the
        // clearly-legible part rather than guessing at the rest. Adjust the
        // wording below if you want the full original phrasing restored.
        { key: "af_1", label: "Incorrectly Approved/Declined" },
        { key: "af_2", label: "Inactioned/Missed Application" },
      ],
    },
  ],
};

const CHATS_DEFINITION: AuditDefinition = {
  type: "chats",
  label: QA_AUDIT_TYPE_LABELS.chats,
  sourceFormName: "Chats Audits Form",
  naExcludedFromDenominator: true,
  sections: [
    {
      key: "opening",
      title: "Soft Skills — Opening",
      questions: [
        { key: "op_1", label: "Did the agent use the opening script consistently?" },
        { key: "op_2", label: "Did the agent follow the FRT threshold? (<=10 seconds)" },
        { key: "op_3", label: "Did the agent provide the correct branding?" },
      ],
    },
    {
      key: "cx_handling",
      title: "Customer Experience and Chat Handling",
      questions: [
        {
          key: "cx_1",
          label:
            "Did the agent communicate effectively and professionally? (tone/politeness, acknowledgement of frustration, willingness to help)",
        },
        {
          key: "cx_2",
          label: "Did the agent review previous conversation? (applicable for returned clients with same concern as before)",
        },
      ],
    },
    {
      key: "probing",
      title: "Technical Skills & Product Knowledge — Probing",
      questions: [
        {
          key: "pr_1",
          label: "Were necessary probing questions asked? (account number, trade details, resolution-necessary info, error details)",
        },
        { key: "pr_2", label: "Did the probing questions relate appropriately to the client's concern?" },
        { key: "pr_3", label: "Did the agent demonstrate active listening by immediately understanding the query?" },
      ],
    },
    {
      key: "resolution",
      title: "Resolution",
      questions: [
        { key: "res_1", label: "Was the provided resolution correct? (aligned with existing process/standards/instructions)" },
        {
          key: "res_2",
          label:
            "Was the provided resolution complete? (answered all questions, FCR: anticipated follow-up concerns and offered proactive solutions)",
        },
        { key: "res_3", label: "Was the provided resolution explained correctly and appropriately?" },
        { key: "res_4", label: "Did the agent escalate the concern to the correct department, if necessary?" },
        {
          key: "res_5",
          label:
            "Were security guidelines observed? (sensitive info only to authorized holders, Tip-off laws, no disclosure of internal security procedures, SQ applied for relevant scenarios)",
        },
        { key: "res_6", label: "Did the associate utilize all available resources? (Knowledge Base, Account Hub, etc.)" },
        { key: "res_7", label: "Did the associate add value to the interaction and provided extra mile when applicable?" },
      ],
    },
    {
      key: "closing",
      title: "Closing",
      questions: [
        {
          key: "cl_1",
          label: 'Were proper chat closing procedures followed? ("2 plus 2" rule, asking for further concerns, auto-resolved conversations)',
        },
        { key: "cl_2", label: "Did the agent use the standard closing script?" },
        { key: "cl_3", label: "Did the agent close the chat in a timely manner? (not abrupt closure/not late closure)" },
      ],
    },
    {
      key: "auto_fail",
      title: "AutoFail — Zero Tolerance",
      autoFail: true,
      questions: [
        { key: "af_1", label: "Is there Rudeness: any unprofessional or disrespectful behavior" },
        { key: "af_2", label: "Is there a Misinformation: providing incorrect data that impacts the client" },
        { key: "af_3", label: "Is there Work Avoidance: abandonment of chats, calls, or emails" },
        { key: "af_4", label: "Are there Business-Impacting Errors: critical mistakes affecting company operations or finances" },
      ],
    },
  ],
};

const EMAILS_DEFINITION: AuditDefinition = {
  type: "emails",
  label: QA_AUDIT_TYPE_LABELS.emails,
  sourceFormName: "Emails Audits Form",
  naExcludedFromDenominator: true,
  sections: [
    {
      key: "opening",
      title: "Soft Skills — Opening",
      questions: [
        { key: "op_1", label: "Did the agent use a proper greeting/acknowledgment spiel?" },
        { key: "op_2", label: "Did the agent use the correct client's name?" },
        { key: "op_3", label: "Did the agent provide the correct branding?" },
      ],
    },
    {
      key: "cx_handling",
      title: "Customer Experience and Email Handling",
      questions: [
        {
          key: "cx_1",
          label:
            "Did the agent communicate effectively and professionally? (tone/politeness, acknowledgement of frustration, willingness to help)",
        },
        {
          key: "cx_2",
          label: "Did the agent review previous/duplicate conversations? (applicable for returned clients with same concern as before)",
        },
      ],
    },
    {
      key: "probing",
      title: "Technical Skills & Product Knowledge — Probing",
      questions: [
        {
          key: "pr_1",
          label: "Were necessary probing questions asked? (account number, trade details, resolution-necessary info, error details)",
        },
        { key: "pr_2", label: "Did the probing questions relate appropriately to the client's concern?" },
        { key: "pr_3", label: "Did the agent demonstrate active listening by immediately understanding the query?" },
      ],
    },
    {
      key: "resolution",
      title: "Resolution",
      questions: [
        { key: "res_1", label: "Was the provided resolution correct? (aligned with existing process/standards/instructions)" },
        {
          key: "res_2",
          label:
            "Was the provided resolution complete? (answered all questions, FCR: anticipated follow-up concerns and offered proactive solutions)",
        },
        { key: "res_3", label: "Was the provided resolution explained correctly and appropriately?" },
        { key: "res_4", label: "Did the agent escalate the concern to the correct department, if necessary?" },
        {
          key: "res_5",
          label:
            "Were security guidelines observed? (sensitive info only to authorized holders, Tip-off laws, no disclosure of internal security procedures, SQ applied for relevant scenarios)",
        },
        { key: "res_6", label: "Did the associate utilize all available resources? (Knowledge Base, Account Hub, etc.)" },
        { key: "res_7", label: "Did the associate add value to the interaction and provided extra mile when applicable?" },
      ],
    },
    {
      key: "email_handling",
      title: "Channel Specific Metrics — Proper Email Handling",
      questions: [
        {
          key: "eh_1",
          label: "Was the correct email format followed? (signature, spacing, grammar, spelling, ticket status tagging)",
        },
        { key: "eh_2", label: "Is the correct signature used?" },
        { key: "eh_3", label: "Is the ticket properties updated correctly and properly?" },
        { key: "eh_4", label: "Was the email handled within reasonable threshold? (30mins)" },
      ],
    },
    {
      key: "closing",
      title: "Closing",
      questions: [
        { key: "cl_1", label: "Did the agent use a standard closing script?" },
        { key: "cl_2", label: "Did the agent close the ticket in a timely manner? (not premature closure/not late closure)" },
        { key: "cl_3", label: "Were the ticket properties updated appropriately? (Ticket Status, Type, Group, Agent Assigned)" },
      ],
    },
    {
      key: "auto_fail",
      title: "AutoFail — Zero Tolerance",
      autoFail: true,
      questions: [
        { key: "af_1", label: "Is there Rudeness: any unprofessional or disrespectful behavior" },
        { key: "af_2", label: "Is there a Misinformation: providing incorrect data that impacts the client" },
        { key: "af_3", label: "Is there Work Avoidance: abandonment of chats, calls, or emails" },
        { key: "af_4", label: "Are there Business-Impacting Errors: critical mistakes affecting company operations or finances" },
      ],
    },
  ],
};

export const AUDIT_DEFINITIONS: Partial<Record<QaAuditType, AuditDefinition>> = {
  applications: APPLICATIONS_DEFINITION,
  chats: CHATS_DEFINITION,
  emails: EMAILS_DEFINITION,
};

export function getAuditDefinition(type: QaAuditType): AuditDefinition {
  const def = AUDIT_DEFINITIONS[type];
  if (!def) throw new Error(`No audit definition for "${type}" yet.`);
  return def;
}

export function allQuestionKeys(def: AuditDefinition): string[] {
  return def.sections.flatMap((s) => s.questions.map((q) => q.key));
}

/**
 * Default answers a fresh submit form starts pre-filled with, so the
 * auditor only has to click the exceptions rather than every question:
 * "Yes" for ordinary correct-practice questions, and "No" for Auto-Fail
 * section questions (i.e. the violation they describe did not occur — the
 * normal, no-penalty case; see AuditSectionDef.autoFail). The auditor can
 * still change any answer, including to N/A.
 */
export function buildDefaultAnswers(def: AuditDefinition): Record<string, QaAnswerValue> {
  const defaults: Record<string, QaAnswerValue> = {};
  for (const section of def.sections) {
    for (const q of section.questions) {
      defaults[q.key] = section.autoFail ? "no" : "yes";
    }
  }
  return defaults;
}

/** Audits dated on or after this day (the "Audit date" on the form) score 0%
 *  when an Auto-Fail is triggered. Audits dated before it keep the earlier
 *  rule: the percentage stays as computed and only the band drops to 0. */
export const AUTO_FAIL_ZERO_FROM = "2026-11-01";

export interface ComputedAuditScore {
  /** For Applications: fixed at the form's full question count and never
   *  shrinks, even for N/A answers. For Emails/Chats (naExcludedFromDenominator):
   *  shrinks by one for every question answered N/A. See computeAuditScore(). */
  applicablePoints: number;
  totalPoints: number;
  /** null only when nothing is applicable yet (e.g. an Emails/Chats audit
   *  where every question so far is N/A or unanswered). */
  percentage: number | null;
  autoFail: boolean;
  band: 0 | 1 | 2 | 3 | null;
}

/**
 * Pure scoring function — same math for every audit type, mirroring the
 * "TOTAL SCORE / Percentage / BAND QUALITY AUDITS" rules printed on all
 * three source forms, with one deliberate per-type departure controlled by
 * AuditDefinition.naExcludedFromDenominator:
 * - Applications (false/unset): the denominator is fixed at the form's full
 *   question count and never shrinks; an N/A answer earns its point the
 *   same way "Yes" would (so marking something N/A never counts against
 *   the score).
 * - Emails / Chats (true): N/A is excluded from BOTH the numerator and the
 *   denominator, same as an unanswered question — the denominator shrinks
 *   by one for every N/A.
 * Auto-Fail sections have flipped Yes/No polarity either way (see the doc
 * comment on AuditSectionDef.autoFail) — "No" earns the point same as
 * "Yes" does everywhere else, and "Yes" earns no point and makes the audit
 * an Auto-Fail. For an audit dated on or after AUTO_FAIL_ZERO_FROM (1 Nov
 * 2026) the percentage is forced to 0% and the band to 0, whatever the other
 * answers add up to. For an earlier audit date only the band is forced to 0
 * and the percentage stays as computed (the original rule). totalPoints /
 * applicablePoints always show the raw correct-answer tally, so the
 * per-section counts on the PDF still add up.
 *
 * auditDate is the audit's own "Audit date" (YYYY-MM-DD). If it is missing
 * the current rule applies.
 */
export function computeAuditScore(
  answers: Record<string, QaAnswerValue | undefined>,
  def: AuditDefinition,
  auditDate?: string | null
): ComputedAuditScore {
  const excludeNa = def.naExcludedFromDenominator === true;
  let applicablePoints = excludeNa ? 0 : allQuestionKeys(def).length;
  let totalPoints = 0;
  let autoFail = false;

  for (const section of def.sections) {
    for (const q of section.questions) {
      const value = answers[q.key];

      if (excludeNa) {
        // Emails/Chats: N/A (and unanswered) drop out of both the
        // numerator and denominator entirely.
        if (value !== "yes" && value !== "no") continue;
        applicablePoints += 1;
        if (section.autoFail) {
          if (value === "no") totalPoints += 1;
          if (value === "yes") autoFail = true;
        } else {
          if (value === "yes") totalPoints += 1;
        }
      } else {
        // Applications: denominator is fixed above; N/A earns its point
        // the same way "Yes" would. An unanswered question earns no point
        // but still counts toward that fixed denominator.
        if (section.autoFail) {
          if (value === "no" || value === "na") totalPoints += 1;
          if (value === "yes") autoFail = true;
        } else {
          if (value === "yes" || value === "na") totalPoints += 1;
        }
      }
    }
  }

  // From AUTO_FAIL_ZERO_FROM an Auto-Fail scores 0% outright. (A triggered
  // auto-fail question always counts toward the denominator, so there is
  // always something to score.) Earlier audits keep their computed percentage.
  const zeroOnAutoFail = !auditDate || auditDate >= AUTO_FAIL_ZERO_FROM;
  const computedPct = applicablePoints > 0 ? (totalPoints / applicablePoints) * 100 : null;
  const percentage = autoFail && zeroOnAutoFail ? 0 : computedPct;

  let band: 0 | 1 | 2 | 3 | null = null;
  if (percentage !== null) {
    band = percentage >= 95 ? 3 : percentage >= 85 ? 2 : percentage >= 75 ? 1 : 0;
  }
  if (autoFail && band !== null) band = 0;

  return { applicablePoints, totalPoints, percentage, autoFail, band };
}

export function bandLabel(band: 0 | 1 | 2 | 3 | null): string {
  if (band === null) return "No data";
  return QA_AUDIT_BANDS.find((b) => b.grade === band)?.label ?? "—";
}

/**
 * A submitted (or published) audit record — the confidential form data plus
 * its computed score. Agent name / period label / auditor name are
 * denormalized onto the record at creation time purely for display and PDF
 * export, so the list/detail UI and the PDF never need extra joins against
 * agents/periods/roster — none of those three ever change after the fact
 * for a given audit (an agent being renamed later doesn't rewrite history).
 *
 * CONFIDENTIALITY: `answers` and `overallRemarks` are exactly the "contents/
 * comments/remarks" that must stay hidden from agents — every server route
 * that returns a full QaAuditRecord is guarded by requireActionAccess() (the
 * same shared Lead/Manager password as Data Import), and the QA Quality
 * page never fetches this shape until that password has been entered in the
 * browser. Only the computed, blended qaAuditPct that publishing writes
 * onto the agent's period (see the publish route) is ever public — that's
 * the existing "QA Audit %" already shown on Scorecards/Dashboard/Trends,
 * completely unchanged by any of this.
 */
export interface QaAuditRecord {
  id: string;
  auditType: QaAuditType;
  agentId: string;
  agentName: string;
  periodId: string;
  periodLabel: string;
  auditorEmail: string;
  auditorName: string;
  caseReference: string | null;
  auditDate: string; // YYYY-MM-DD
  /** Applications audits only: "New Application" or "Additional Account".
   *  Null for Emails/Chats audits, and for Applications audits saved before
   *  this was asked. */
  applicationType?: QaApplicationType | null;
  answers: QaAuditAnswer[];
  overallRemarks: string | null;
  applicablePoints: number;
  totalPoints: number;
  percentage: number | null;
  autoFail: boolean;
  band: 0 | 1 | 2 | 3 | null;
  status: QaAuditStatus;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for creating a new audit — everything the score is computed
 *  from, before the server attaches an id/timestamps/computed fields. */
export interface NewQaAuditInput {
  auditType: QaAuditType;
  agentId: string;
  agentName: string;
  periodId: string;
  periodLabel: string;
  auditorEmail: string;
  auditorName: string;
  caseReference: string | null;
  auditDate: string;
  applicationType?: QaApplicationType | null;
  answers: QaAuditAnswer[];
  overallRemarks: string | null;
}
