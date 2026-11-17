// The "Team Quality & Rejection" block in the exported Weekly and MTD reports:
// Team QA Average and Rejection Quality / Markdown Percentage, the same two
// figures (and the same colors and 95% passing mark) as the Dashboard, Team
// Performance and Overall MTD pages. Visibility only: neither is a Business
// Gate metric and neither changes any score. Pure string output with inline
// styles, like the rest of the report HTML.

import type { TeamQaAverage } from "../qa/teamQaAverage";
import type { RejectionQuality } from "../rejections/rejectionQuality";
import { QUALITY_GREEN_MIN, QUALITY_AMBER_MIN, REJECTION_QUALITY_PASSING_MARK } from "../qa/qualityMarks";

export interface ReportTeamQuality {
  qa: TeamQaAverage;
  rejection: RejectionQuality;
}

const GREEN = "#1b5e20";
const AMBER = "#e65100";
const RED = "#b71c1c";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";
const INK = "#1a1d29";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function card(label: string, value: string, badge: string, note: string, color: string): string {
  return `<div style="border-left:4px solid ${color};background:${color}0d;border-radius:8px;padding:10px 12px;">
    <p style="margin:0;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:${MUTED};">${escapeHtml(label)}</p>
    <p style="margin:3px 0 0;font-size:22px;font-weight:700;color:${color};">${escapeHtml(value)}</p>
    <p style="margin:2px 0 0;font-size:11px;font-weight:700;color:${color};">${escapeHtml(badge)}</p>
    <p style="margin:2px 0 0;font-size:10px;color:${MUTED};">${escapeHtml(note)}</p>
  </div>`;
}

/** periodNoun: "this week" or "this month". */
export function renderTeamQualitySection(quality: ReportTeamQuality, periodNoun: string): string {
  const { qa, rejection } = quality;

  const qaPct = qa.averagePct;
  const qaColor = qaPct === null ? MUTED : qaPct >= QUALITY_GREEN_MIN ? GREEN : qaPct >= QUALITY_AMBER_MIN ? AMBER : RED;
  const qaBadge = qaPct === null ? "No Data" : qaPct >= QUALITY_GREEN_MIN ? "Green" : qaPct >= QUALITY_AMBER_MIN ? "Amber" : "Red";
  const qaNote =
    qaPct === null
      ? `No QA scores recorded ${periodNoun} yet`
      : `Average of ${qa.agentCount} agent${qa.agentCount === 1 ? "" : "s"}’ QA scores ${periodNoun}`;

  const rqPct = rejection.pct;
  const passing = rqPct !== null && rqPct >= REJECTION_QUALITY_PASSING_MARK;
  const rqColor = rqPct === null ? MUTED : passing ? GREEN : RED;
  const rqBadge = rqPct === null ? "Rejection Audit Tracker" : passing ? "Passing" : "Below passing mark";
  const rqNote =
    rejection.state === "ok"
      ? `Passing mark ${REJECTION_QUALITY_PASSING_MARK}% · from the Rejection Audit Tracker, ${periodNoun}`
      : rejection.state === "no_data"
        ? `No audited items in the tracker ${periodNoun} yet`
        : rejection.state === "not_configured"
          ? "Not connected to the Rejection Audit Tracker"
          : "Couldn’t reach the Rejection Audit Tracker when this report was created";

  return `
    <div style="background:#fff;border:1px solid ${BORDER};border-left:4px solid hsl(226 64% 52%);border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${INK};">\u{1F6E1}️ Team Quality &amp; Rejection</p>
      <p style="margin:0 0 14px;font-size:12px;color:${MUTED};">Shown for visibility only. These are not part of the Business Gate and do not change any score.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;">
        ${card("Team QA Average", qaPct === null ? "—" : `${qaPct.toFixed(1)}%`, qaBadge, qaNote, qaColor)}
        ${card("Rejection Quality/Markdown Percentage", rqPct === null ? "—" : `${rqPct.toFixed(1)}%`, rqBadge, rqNote, rqColor)}
      </div>
    </div>`;
}
