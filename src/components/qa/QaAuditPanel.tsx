"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, Loader2, Send, Download, Mail, Trash2, ChevronDown, ChevronUp, ShieldAlert, Pencil, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { formatDate, getLocalTodayIso } from "@/lib/utils";
import { ROSTER } from "@/lib/auth/roster";
import {
  buildDefaultAnswers,
  computeAuditScore,
  getAuditDefinition,
  bandLabel,
  QA_AUDIT_TYPE_LABELS,
  QA_APPLICATION_TYPES,
  QA_APPLICATION_TYPE_LABELS,
  isQaApplicationType,
  type QaAnswerValue,
  type QaApplicationType,
  type QaAuditRecord,
  type QaAuditType,
} from "@/lib/qa/auditDefinitions";
import { notifyQaAuditsChanged } from "@/lib/qa/auditQuota";
import { AuditProgress } from "@/components/qa/AuditProgress";

interface AgentOption {
  id: string;
  name: string;
}
interface PeriodOption {
  id: string;
  label: string;
  endDate: string;
}

const AUDITORS = ROSTER.filter((r) => r.role === "lead");

const ALL_FILTER = "__all__";

function distinctSorted(names: string[]): string[] {
  return [...new Set(names.filter((n) => n && n.trim().length > 0))].sort((a, b) => a.localeCompare(b));
}

// ── Weekly filter for the History list. Weeks run Monday to Sunday and are
// based on the audit date (the "Audit date" field on the form), not on when the
// record was saved. Everything here works on the plain YYYY-MM-DD text in UTC,
// so the browser's time zone can never push an audit into the wrong week.
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoFromUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** The Monday (YYYY-MM-DD) of the week the given audit date falls in. */
function weekStartIso(dateIso: string): string {
  const [y, m, d] = dateIso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return isoFromUtc(date);
}

function weekLabel(startIso: string): string {
  const [y, m, d] = startIso.split("-").map(Number);
  const start = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const fmt = (dt: Date) => `${MONTH_SHORT[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return sameYear
    ? `${fmt(start)} – ${fmt(end)}, ${end.getUTCFullYear()}`
    : `${fmt(start)}, ${start.getUTCFullYear()} – ${fmt(end)}, ${end.getUTCFullYear()}`;
}

const ANSWER_OPTIONS: { value: QaAnswerValue; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "na", label: "N/A" },
];

function bandBadgeVariant(band: 0 | 1 | 2 | 3 | null): "primary" | "success" | "warning" | "danger" | "outline" {
  if (band === null) return "outline";
  return band === 3 ? "primary" : band === 2 ? "success" : band === 1 ? "warning" : "danger";
}

// ── "Email" button — see qa-quality/page.tsx's PasswordGate: everything in
// this file already sits behind the shared Lead/Manager password, so this
// stays entirely client-side (no new API route). It downloads the audit's
// existing PDF (same file the "PDF" button already produces) and, in the
// same click, opens a pre-filled mailto: draft in the auditor's own email
// app (Outlook or whatever is set as default) — recipients, subject and
// body are all auto-populated, but nothing is actually sent until a human
// reviews the draft and clicks Send there. mailto: links cannot attach a
// file (a browser/OS restriction, not something any amount of code here can
// work around) — the PDF still downloads automatically on the same click,
// it just has to be attached by hand before sending.
//
// Recipient: per an explicit decision (confirmed after flagging that this
// overrides the app's own "answers/remarks stay hidden from agents"
// confidentiality note on QaAuditRecord — see auditDefinitions.ts), this
// intentionally emails the FULL audit, unfiltered, straight to the audited
// agent. Cc defaults to every Lead/Manager on the roster (including the
// auditor) plus anna.go@fusionmarkets.com.au (ALWAYS_CC_EMAILS below), so
// there's always a leadership paper trail on an email that carries
// confidential audit content out to the agent it's about.
function agentEmailFor(agentId: string): string | null {
  return ROSTER.find((r) => r.role === "agent" && r.agentId === agentId)?.email ?? null;
}

// Always copied on every audit email, on top of the auditor and the
// Leads/Managers: not on the roster, so they're listed here by hand.
const ALWAYS_CC_EMAILS = ["anna.go@fusionmarkets.com.au"];

function defaultCcFor(audit: QaAuditRecord): string[] {
  const leadEmails = AUDITORS.map((r) => r.email);
  // De-duplicated ignoring upper/lower case, so nobody is copied twice.
  const seen = new Set<string>();
  const cc: string[] = [];
  for (const email of [audit.auditorEmail, ...leadEmails, ...ALWAYS_CC_EMAILS]) {
    const key = email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cc.push(email.trim());
  }
  return cc;
}

function buildAuditEmailBody(audit: QaAuditRecord): string {
  const lines = [
    `Hi ${audit.agentName},`,
    "",
    `Please see the attached QA Audit results for ${audit.periodLabel} (${QA_AUDIT_TYPE_LABELS[audit.auditType]}).`,
    "",
    `Score: ${audit.percentage !== null ? `${audit.percentage.toFixed(1)}%` : "No data"} — Band ${audit.band ?? "—"} (${bandLabel(audit.band)})`,
  ];
  if (audit.autoFail) lines.push("Note: this audit triggered an Auto-Fail.");
  if (audit.caseReference) lines.push(`Reference: ${audit.caseReference}`);
  lines.push("", "Regards,", audit.auditorName);
  return lines.join("\r\n");
}

/** Downloads the audit PDF and opens a pre-filled mailto: draft for it.
 *  Returns an error string if the agent has no roster email on file
 *  (nothing is downloaded or opened in that case), or null on success. */
function emailAudit(audit: QaAuditRecord): string | null {
  const to = agentEmailFor(audit.agentId);
  if (!to) return `${audit.agentName} has no email on file in the roster — can't address this draft.`;

  window.open(`/api/qa-audits/${audit.id}/pdf`, "_blank");

  const cc = defaultCcFor(audit).join(",");
  const subject = `QA Audit — ${audit.agentName} — ${QA_AUDIT_TYPE_LABELS[audit.auditType]}`;
  const body = buildAuditEmailBody(audit);
  const mailto = `mailto:${to}?cc=${cc}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
  return null;
}

function bandBarClass(band: 0 | 1 | 2 | 3 | null): string {
  if (band === null) return "bg-muted-foreground/40";
  return band === 3 ? "bg-primary-500" : band === 2 ? "bg-success" : band === 1 ? "bg-warning" : "bg-danger";
}

/** The live score for the audit being filled in or edited. Deliberately the
 *  loudest thing on the form: big percentage, big points tally, band, and a
 *  bar. While editing (inside the pop-up) it also sticks just under the
 *  pop-up's header so it stays visible as the answers are changed. */
function ScorePreview({
  answers,
  auditType,
  auditDate,
  sticky = false,
}: {
  answers: Record<string, QaAnswerValue | undefined>;
  auditType: QaAuditType;
  auditDate: string;
  sticky?: boolean;
}) {
  const definition = getAuditDefinition(auditType);
  const score = computeAuditScore(answers, definition, auditDate);
  const pct = score.percentage;
  const barWidth = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div
      className={
        "rounded-xl border-2 bg-card p-4 shadow-sm " +
        (score.autoFail ? "border-danger/60" : "border-primary-500/40") +
        (sticky ? " sticky top-[3.25rem] z-10" : "")
      }
    >
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Audit score</p>
          <p className="text-4xl font-bold leading-none tabular-nums text-foreground">{pct !== null ? `${pct.toFixed(1)}%` : "—"}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Points</p>
          <p className="text-3xl font-bold leading-none tabular-nums text-foreground">
            {score.totalPoints}
            <span className="text-xl font-semibold text-muted-foreground"> / {score.applicablePoints}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 pb-0.5">
          <Badge variant={bandBadgeVariant(score.band)} className="px-3 py-1 text-sm">
            {score.band !== null ? `Band ${score.band} — ${bandLabel(score.band)}` : "No data"}
          </Badge>
          {score.autoFail && (
            <Badge variant="danger" className="gap-1 px-3 py-1 text-sm">
              <ShieldAlert className="h-3.5 w-3.5" /> Auto-Fail triggered
            </Badge>
          )}
        </div>
      </div>
      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
        <div className={"h-full rounded-full transition-all " + bandBarClass(score.band)} style={{ width: `${barWidth}%` }} />
      </div>
    </div>
  );
}

/** This one form does double duty: with no `editing` it submits a brand-new
 *  audit (POST), and with `editing` set it opens that already-submitted
 *  audit pre-filled and saves changes to it in place (PUT) -- same fields,
 *  same validation, same live score preview either way. */
function SubmitAuditForm({
  auditType,
  agents,
  periods,
  onSubmitted,
  editing = null,
  onCancel,
}: {
  auditType: QaAuditType;
  agents: AgentOption[];
  periods: PeriodOption[];
  onSubmitted: () => void | Promise<void>;
  editing?: QaAuditRecord | null;
  onCancel?: () => void;
}) {
  const { showToast } = useToast();
  const definition = getAuditDefinition(auditType);
  const [agentId, setAgentId] = React.useState(editing?.agentId ?? agents[0]?.id ?? "");
  const [periodId, setPeriodId] = React.useState(editing?.periodId ?? periods[0]?.id ?? "");
  const [auditorEmail, setAuditorEmail] = React.useState(editing?.auditorEmail ?? AUDITORS[0]?.email ?? "");
  const [caseReference, setCaseReference] = React.useState(editing?.caseReference ?? "");
  const [auditDate, setAuditDate] = React.useState(() => editing?.auditDate ?? getLocalTodayIso());
  // Applications audits only. Starts empty on a new audit so the auditor has
  // to choose it on purpose rather than submitting whatever was pre-selected.
  const [applicationType, setApplicationType] = React.useState<QaApplicationType | "">(editing?.applicationType ?? "");
  const [answers, setAnswers] = React.useState<Record<string, QaAnswerValue | undefined>>(() => {
    const base: Record<string, QaAnswerValue | undefined> = buildDefaultAnswers(definition);
    if (editing) {
      for (const a of editing.answers) base[a.questionKey] = a.value;
    }
    return base;
  });
  const [overallRemarks, setOverallRemarks] = React.useState(editing?.overallRemarks ?? "");

  // The pickers only list active agents / existing periods, so an audit
  // whose agent has since been deactivated (or whose period is gone) would
  // otherwise open with a blank-looking dropdown. Keep its current value
  // selectable so editing something else on it still works.
  const agentChoices = React.useMemo(
    () =>
      editing && !agents.some((a) => a.id === editing.agentId)
        ? [{ id: editing.agentId, name: `${editing.agentName} (inactive)` }, ...agents]
        : agents,
    [agents, editing]
  );
  const periodChoices = React.useMemo(
    () =>
      editing && !periods.some((p) => p.id === editing.periodId)
        ? [{ id: editing.periodId, label: `${editing.periodLabel} (no longer available)`, endDate: "" }, ...periods]
        : periods,
    [periods, editing]
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // A plain ref, not state: it's set synchronously the instant handleSubmit
  // runs, so it blocks a second click that lands before React has had a
  // chance to re-render the button as disabled (a fast double-click, or a
  // stray duplicate click event) -- the `submitting` state above is still
  // what disables the button visually, but this is what actually prevents
  // two identical audits from being created from one submission.
  const submittingRef = React.useRef(false);

  function setAnswer(key: string, value: QaAnswerValue) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  function resetForm() {
    setAnswers(buildDefaultAnswers(definition));
    setCaseReference("");
    setOverallRemarks("");
    setAuditDate(getLocalTodayIso());
    setApplicationType("");
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    setError(null);
    if (!agentId || !periodId || !auditorEmail) {
      setError("Pick an agent, a period, and an auditor.");
      return;
    }
    // Required for Applications audits -- except an older audit that never had
    // a type, which can still be edited without picking one.
    const typeOptional = editing !== null && !editing.applicationType;
    if (auditType === "applications" && !isQaApplicationType(applicationType) && !typeOptional) {
      setError("Pick whether this is a New Application or an Additional Account.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch(editing ? `/api/qa-audits/${editing.id}` : "/api/qa-audits", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditType,
          agentId,
          periodId,
          auditorEmail,
          caseReference: caseReference || null,
          auditDate,
          applicationType: auditType === "applications" && isQaApplicationType(applicationType) ? applicationType : null,
          answers,
          overallRemarks: overallRemarks || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save the audit.");
        return;
      }
      notifyQaAuditsChanged();
      if (editing) {
        if (data.republished) {
          showToast(
            data.qaAuditPct !== null && data.qaAuditPct !== undefined
              ? `Audit updated — the scorecard's QA Audit % was recalculated to ${data.qaAuditPct}%.`
              : "Audit updated — the scorecard's QA Audit % was recalculated (no published audit with a score remains for that agent/period).",
            "success"
          );
        } else {
          showToast("Audit updated. It isn't published, so no scorecard number changed.", "success");
        }
        await onSubmitted();
      } else {
        showToast("Audit submitted. Publish it from the History tab to reflect its score on the scorecard.", "success");
        resetForm();
        await onSubmitted();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      {editing && (
        <div className="flex items-start gap-3 rounded-lg border border-primary-500/30 bg-primary-50 p-4">
          <Pencil className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary-700" />
          <div className="text-sm text-foreground">
            <p className="font-medium">
              Editing the {QA_AUDIT_TYPE_LABELS[editing.auditType].toLowerCase()} audit for {editing.agentName} · {editing.periodLabel}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {editing.status === "published"
                ? "This audit is published — saving recalculates the agent's QA Audit % on the scorecard straight away."
                : "This audit isn't published, so saving won't change any scorecard number."}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 p-4">
          <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" />
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Audit details</CardTitle>
          <CardDescription>Who this audit is for, who conducted it, and which reporting period it counts toward.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Agent</label>
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-full">
              {agentChoices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Counts toward period</label>
            <Select value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="w-full">
              {periodChoices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Auditor (Lead/Manager)</label>
            <Select value={auditorEmail} onChange={(e) => setAuditorEmail(e.target.value)} className="w-full">
              {AUDITORS.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          {auditType === "applications" && (
            <div>
              <label htmlFor={`audit-application-type-${editing?.id ?? "new"}`} className="mb-1 block text-xs font-medium text-muted-foreground">
                Application type
              </label>
              <Select
                id={`audit-application-type-${editing?.id ?? "new"}`}
                value={applicationType}
                onChange={(e) => setApplicationType(isQaApplicationType(e.target.value) ? e.target.value : "")}
                className="w-full"
              >
                <option value="">Select type…</option>
                {QA_APPLICATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {QA_APPLICATION_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Audit date</label>
            <Input type="date" value={auditDate} onChange={(e) => setAuditDate(e.target.value)} className="w-full" />
          </div>
          <div className="sm:col-span-2 lg:col-span-2">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Case / ticket reference (optional)</label>
            <Input
              placeholder="e.g. application or ticket #"
              value={caseReference}
              onChange={(e) => setCaseReference(e.target.value)}
              className="w-full"
            />
          </div>
        </CardContent>
      </Card>

      <ScorePreview answers={answers} auditType={auditType} auditDate={auditDate} sticky={editing !== null} />

      {definition.sections.map((section) => (
        <Card key={section.key} className={section.autoFail ? "border-danger/40" : undefined}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {section.title}
              {section.autoFail && (
                <Badge variant="danger" className="gap-1">
                  <ShieldAlert className="h-3 w-3" /> Zero tolerance
                </Badge>
              )}
            </CardTitle>
            {section.autoFail && (
              <CardDescription>
                Defaults to &ldquo;No&rdquo; (violation did not occur) with no penalty. A single &ldquo;Yes&rdquo; here fails the whole audit
                (Band 0), regardless of the overall percentage.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {section.questions.map((q) => (
              <div key={q.key} className="flex flex-col gap-2 border-b border-border pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-foreground sm:max-w-[70%]">{q.label}</p>
                <div className="flex gap-1.5">
                  {ANSWER_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setAnswer(q.key, opt.value)}
                      className={
                        "h-8 rounded-md border px-3 text-xs font-medium transition-colors " +
                        (answers[q.key] === opt.value
                          ? opt.value === "no"
                            ? "border-danger bg-danger/10 text-danger"
                            : "border-primary-500 bg-primary-50 text-primary-700"
                          : "border-border bg-card text-muted-foreground hover:bg-muted")
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Overall remarks (optional)</CardTitle>
          <CardDescription>Visible only to Leads/Managers — never shown to the audited agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            value={overallRemarks}
            onChange={(e) => setOverallRemarks(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-input bg-card p-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Context, evidence, or coaching notes for this audit…"
          />
        </CardContent>
      </Card>

      <div
        className={
          editing
            ? "sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t border-border bg-card px-5 py-3"
            : "flex flex-wrap items-center gap-2"
        }
      >
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {editing ? "Saving…" : "Submitting…"}
            </>
          ) : editing ? (
            <>
              <Save className="h-4 w-4" /> Save changes
            </>
          ) : (
            <>
              <Send className="h-4 w-4" /> Submit audit
            </>
          )}
        </Button>
        {editing && onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/** Pop-up wrapper for editing an audit. Built on the native <dialog> element
 *  (focus trap + Esc come free). It is mounted only while an audit is being
 *  edited and opens itself on mount. Clicking the backdrop does NOT close it,
 *  so a stray click can't throw away a half-edited audit. */
function EditAuditModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto max-h-[92vh] w-[min(900px,95vw)] overflow-y-auto rounded-xl border border-border bg-card p-0 text-card-foreground shadow-popover backdrop:bg-foreground/40 open:animate-slide-up"
    >
      <div className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-card px-5 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}

function AuditDetail({ audit }: { audit: QaAuditRecord }) {
  const definition = getAuditDefinition(audit.auditType);
  const answerByKey = new Map(audit.answers.map((a) => [a.questionKey, a.value]));
  return (
    <div className="space-y-3 border-t border-border pt-3">
      {definition.sections.map((section) => (
        <div key={section.key}>
          <p className="text-xs font-semibold uppercase text-muted-foreground">{section.title}</p>
          <ul className="mt-1 space-y-1">
            {section.questions.map((q) => {
              const value = answerByKey.get(q.key);
              return (
                <li key={q.key} className="flex items-start justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{q.label}</span>
                  <span
                    className={
                      "flex-shrink-0 font-medium " +
                      (value === "no" ? "text-danger" : value === "yes" ? "text-success" : "text-muted-foreground")
                    }
                  >
                    {value === "yes" ? "Yes" : value === "no" ? "No" : "N/A"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {audit.overallRemarks && (
        <div className="rounded-md bg-muted/40 p-3">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Overall remarks</p>
          <p className="mt-1 text-xs text-foreground">{audit.overallRemarks}</p>
        </div>
      )}
    </div>
  );
}

function AuditHistory({ auditType, agents, periods }: { auditType: QaAuditType; agents: AgentOption[]; periods: PeriodOption[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [audits, setAudits] = React.useState<QaAuditRecord[] | null>(null);
  const [editing, setEditing] = React.useState<QaAuditRecord | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [publishingId, setPublishingId] = React.useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<QaAuditRecord | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [auditorFilter, setAuditorFilter] = React.useState(ALL_FILTER);
  const [agentFilter, setAgentFilter] = React.useState(ALL_FILTER);
  const [weekFilter, setWeekFilter] = React.useState(ALL_FILTER);

  // The dropdowns list every auditor / agent that actually appears in the
  // loaded audits (not the whole roster), so each choice is guaranteed to
  // match at least one row.
  const auditorNames = React.useMemo(() => distinctSorted((audits ?? []).map((a) => a.auditorName)), [audits]);
  const agentNames = React.useMemo(() => distinctSorted((audits ?? []).map((a) => a.agentName)), [audits]);

  // A selection that no longer exists in the list (e.g. after switching audit
  // type, or after the last audit by that person was deleted) quietly counts
  // as "All" instead of leaving the list mysteriously empty.
  const activeAuditor = auditorNames.includes(auditorFilter) ? auditorFilter : ALL_FILTER;
  const activeAgent = agentNames.includes(agentFilter) ? agentFilter : ALL_FILTER;

  // Only weeks that actually contain an audit are offered, newest first.
  const weekStarts = React.useMemo(
    () => [...new Set((audits ?? []).map((a) => weekStartIso(a.auditDate)))].sort((a, b) => b.localeCompare(a)),
    [audits]
  );
  const activeWeek = weekStarts.includes(weekFilter) ? weekFilter : ALL_FILTER;

  const visibleAudits = React.useMemo(
    () =>
      (audits ?? []).filter(
        (a) =>
          (activeAuditor === ALL_FILTER || a.auditorName === activeAuditor) &&
          (activeAgent === ALL_FILTER || a.agentName === activeAgent) &&
          (activeWeek === ALL_FILTER || weekStartIso(a.auditDate) === activeWeek)
      ),
    [audits, activeAuditor, activeAgent, activeWeek]
  );
  const filtersActive = activeAuditor !== ALL_FILTER || activeAgent !== ALL_FILTER || activeWeek !== ALL_FILTER;

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/qa-audits?type=${auditType}`);
    const data = await res.json();
    setAudits(res.ok ? data.audits : []);
  }, [auditType]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function publish(audit: QaAuditRecord) {
    setPublishingId(audit.id);
    try {
      const res = await fetch(`/api/qa-audits/${audit.id}/publish`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? "Failed to publish.", "error");
        return;
      }
      if (data.blendedQaAuditPct !== null && data.blendedQaAuditPct !== undefined) {
        showToast(`Published — this agent's QA Audit % for ${audit.periodLabel} is now ${data.blendedQaAuditPct}%.`, "success");
      } else {
        showToast(data.message ?? "Published.", "success");
      }
      await load();
      router.refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Unexpected error.", "error");
    } finally {
      setPublishingId(null);
    }
  }

  // The inverse of publish: sets the audit back to "submitted" (kept, just
  // no longer counted) and recomputes the scorecard the exact same way
  // Delete does (see refreshQaAuditPct.ts) -- re-blend whatever else is
  // still published, fall back to the last Manual Entry/PDF import value if
  // nothing else is, or clear to null if there's genuinely nothing. This is
  // the action that actually changes the scorecard number; Delete (below)
  // does the same recompute and additionally removes the record.
  async function unpublish(audit: QaAuditRecord) {
    setUnpublishingId(audit.id);
    try {
      const res = await fetch(`/api/qa-audits/${audit.id}/unpublish`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? "Failed to unpublish.", "error");
        return;
      }
      if (data.blendedFrom > 0) {
        showToast(`Unpublished — scorecard's QA Audit % recalculated to ${data.qaAuditPct}% from ${data.blendedFrom} remaining published audit${data.blendedFrom === 1 ? "" : "s"}.`, "success");
      } else if (data.restoredFromImport) {
        showToast(`Unpublished — no published audits remain, so the scorecard's QA Audit % reverted to the last Manual Entry/Import value: ${data.qaAuditPct}%.`, "success");
      } else {
        showToast("Unpublished — no published audits remain for that agent/period, and no earlier Manual Entry/Import value was found, so the scorecard's QA Audit % was cleared.", "success");
      }
      await load();
      router.refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Unexpected error.", "error");
    } finally {
      setUnpublishingId(null);
    }
  }

  function handleEmail(audit: QaAuditRecord) {
    const error = emailAudit(audit);
    if (error) {
      showToast(error, "error");
      return;
    }
    showToast("PDF downloading, and a draft email just opened in your email app — attach the PDF and review before sending.", "success");
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/qa-audits/${pendingDelete.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? "Failed to delete.", "error");
        return;
      }
      if (data.blendedFrom > 0) {
        showToast(`Audit deleted — scorecard's QA Audit % recalculated to ${data.qaAuditPct}% from ${data.blendedFrom} remaining published audit${data.blendedFrom === 1 ? "" : "s"}.`, "success");
      } else if (data.restoredFromImport) {
        showToast(`Audit deleted — no published audits remain, so the scorecard's QA Audit % reverted to the last Manual Entry/Import value: ${data.qaAuditPct}%.`, "success");
      } else {
        showToast("Audit deleted — no published audits remain for that agent/period, and no earlier Manual Entry/Import value was found, so the scorecard's QA Audit % was cleared.", "success");
      }
      setPendingDelete(null);
      notifyQaAuditsChanged();
      await load();
      router.refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Unexpected error.", "error");
    } finally {
      setDeleting(false);
    }
  }

  if (audits === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading audits…
      </p>
    );
  }
  if (audits.length === 0) {
    return <p className="text-sm text-muted-foreground">No audits submitted yet.</p>;
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/40 p-3">
        <div>
          <label htmlFor={`audit-filter-auditor-${auditType}`} className="mb-1 block text-xs font-semibold uppercase text-muted-foreground">
            Auditor
          </label>
          <Select id={`audit-filter-auditor-${auditType}`} value={activeAuditor} onChange={(e) => setAuditorFilter(e.target.value)} className="min-w-[11rem]">
            <option value={ALL_FILTER}>All auditors</option>
            {auditorNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor={`audit-filter-agent-${auditType}`} className="mb-1 block text-xs font-semibold uppercase text-muted-foreground">
            Agent
          </label>
          <Select id={`audit-filter-agent-${auditType}`} value={activeAgent} onChange={(e) => setAgentFilter(e.target.value)} className="min-w-[11rem]">
            <option value={ALL_FILTER}>All agents</option>
            {agentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor={`audit-filter-week-${auditType}`} className="mb-1 block text-xs font-semibold uppercase text-muted-foreground">
            Week (Mon–Sun)
          </label>
          <Select id={`audit-filter-week-${auditType}`} value={activeWeek} onChange={(e) => setWeekFilter(e.target.value)} className="min-w-[13rem]">
            <option value={ALL_FILTER}>All weeks</option>
            {weekStarts.map((start) => (
              <option key={start} value={start}>
                {weekLabel(start)}
              </option>
            ))}
          </Select>
        </div>
        {filtersActive && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAuditorFilter(ALL_FILTER);
              setAgentFilter(ALL_FILTER);
              setWeekFilter(ALL_FILTER);
            }}
          >
            <X className="h-3.5 w-3.5" /> Clear filters
          </Button>
        )}
        <p className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {filtersActive ? `Showing ${visibleAudits.length} of ${audits.length} audit${audits.length === 1 ? "" : "s"}` : `${audits.length} audit${audits.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {visibleAudits.length === 0 && <p className="py-4 text-sm text-muted-foreground">No audits match the selected filters.</p>}

      <ul className="divide-y divide-border">
        {visibleAudits.map((audit) => (
          <li key={audit.id} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {audit.agentName} · {audit.periodLabel}
                  {audit.applicationType ? ` · ${QA_APPLICATION_TYPE_LABELS[audit.applicationType]}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  Audited {formatDate(audit.auditDate)} by {audit.auditorName}
                  {audit.caseReference ? ` · ${audit.caseReference}` : ""}
                </p>
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                <div className="mr-1 text-right">
                  <p className="text-2xl font-bold leading-none tabular-nums text-foreground">
                    {audit.percentage !== null ? `${audit.percentage.toFixed(1)}%` : "—"}
                  </p>
                  <p className="mt-1 text-xs font-medium tabular-nums text-muted-foreground">
                    {audit.totalPoints}/{audit.applicablePoints} pts
                  </p>
                </div>
                <Badge variant={bandBadgeVariant(audit.band)}>Band {audit.band ?? "—"}</Badge>
                {audit.autoFail && <Badge variant="danger">Auto-Fail</Badge>}
                <Badge variant={audit.status === "published" ? "success" : "outline"}>{audit.status}</Badge>
                <Button size="sm" variant="outline" onClick={() => window.open(`/api/qa-audits/${audit.id}/pdf`, "_blank")}>
                  <Download className="h-3.5 w-3.5" /> PDF
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleEmail(audit)} title="Download the PDF and open a pre-filled email draft">
                  <Mail className="h-3.5 w-3.5" /> Email
                </Button>
                <Button size="sm" onClick={() => publish(audit)} disabled={publishingId === audit.id}>
                  {publishingId === audit.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : audit.status === "published" ? "Re-publish" : "Publish"}
                </Button>
                {audit.status === "published" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => unpublish(audit)}
                    disabled={unpublishingId === audit.id}
                    title="Pull this audit's score off the scorecard without deleting the record"
                  >
                    {unpublishingId === audit.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Unpublish"}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setEditing(audit)} title="Edit this audit's answers, remarks, date, auditor, agent or period">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(audit)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                  aria-label="Delete audit"
                  title="Delete this audit"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === audit.id ? null : audit.id)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  aria-label="Toggle detail"
                >
                  {expandedId === audit.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {expandedId === audit.id && <AuditDetail audit={audit} />}
          </li>
        ))}
      </ul>

      {editing && (
        <EditAuditModal title="Edit audit" onClose={() => setEditing(null)}>
          <SubmitAuditForm
            key={editing.id}
            auditType={auditType}
            agents={agents}
            periods={periods}
            editing={editing}
            onCancel={() => setEditing(null)}
            onSubmitted={async () => {
              setEditing(null);
              await load();
              router.refresh();
            }}
          />
        </EditAuditModal>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}
        title="Delete this audit?"
        description="This removes the audit record permanently. If it was already published, the scorecard's QA Audit % is automatically recalculated from whatever other audits are still published for that agent/period — or, if none are, reverted to the last Manual Entry/Import value for that agent/period, or cleared if there's no earlier value either."
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </>
        }
      />
    </>
  );
}

export function QaAuditPanel({ auditType, agents, periods }: { auditType: QaAuditType; agents: AgentOption[]; periods: PeriodOption[] }) {
  const [tab, setTab] = React.useState("submit");

  if (agents.length === 0 || periods.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4" /> Import at least one period of data first — audits count toward an existing period.
      </p>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab} defaultValue="submit">
      <TabsList>
        <TabsTrigger value="submit">Submit New</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      <TabsContent value="submit" className="mt-4">
        <SubmitAuditForm auditType={auditType} agents={agents} periods={periods} onSubmitted={() => setTab("history")} />
      </TabsContent>
      <TabsContent value="history" className="mt-4">
        <AuditHistory auditType={auditType} agents={agents} periods={periods} />
      </TabsContent>
    </Tabs>
  );
}

const AUDIT_TYPE_OPTIONS: { value: QaAuditType; label: string }[] = [
  { value: "applications", label: QA_AUDIT_TYPE_LABELS.applications },
  { value: "chats", label: QA_AUDIT_TYPE_LABELS.chats },
  { value: "emails", label: QA_AUDIT_TYPE_LABELS.emails },
];

/**
 * One shared workspace for all three audit types, with a dropdown to pick
 * which form the auditor is filling out -- replaces showing all three
 * forms spread down the page at once. Meant to sit inside a single
 * PasswordGate (see qa-quality/page.tsx): switching the dropdown only
 * swaps which QaAuditPanel is mounted (the `key` below forces a fresh
 * Submit/History tab state per type), it never re-locks the password.
 */
export function QaAuditWorkspace({ agents, periods }: { agents: AgentOption[]; periods: PeriodOption[] }) {
  const [auditType, setAuditType] = React.useState<QaAuditType>("applications");

  return (
    <div className="space-y-4">
      <AuditProgress agents={agents} />
      <div className="max-w-xs">
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Audit form</label>
        <Select value={auditType} onChange={(e) => setAuditType(e.target.value as QaAuditType)} className="w-full">
          {AUDIT_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>
      <QaAuditPanel key={auditType} auditType={auditType} agents={agents} periods={periods} />
    </div>
  );
}
