// Builds a self-contained "Weekly Report" HTML file: a week-on-week
// comparison of the Business Gate, a full Agent Scoreboard with rank
// movement, a Movement Table with per-metric deltas, and a Coach Watch
// section (Stars of the Week / Needs Coaching) — modeled on the reporting
// format Susan uses elsewhere, adapted to this app's own KYC metrics and
// Business Gate model (see generateReportHtml.ts for the older, simpler
// single-period snapshot this supplements rather than replaces).
//
// Deliberately pure: every number this file needs (both weeks' scored
// datasets, plus QA/penalty counts) is computed by the caller (the export
// route) and passed in, so this module has no data-access concerns of its
// own and stays trivially testable.

import {
  INDIVIDUAL_METRICS,
  GATE_METRICS,
  hasSufficientDataCoverage,
  MIN_SCORE_COVERAGE_WEEKLY,
  SCORE_PASS_THRESHOLD,
} from "../scoring/thresholds";
import { formatSeconds, formatMinutesValue } from "../data/time";
import type { PeriodDataset, AgentPeriodResult } from "../data/query";
import type { DateRange } from "../data/dateRanges";
import type { GateMetricKey, GateTier, IndividualMetricKey } from "../scoring/types";
import { APP_NAME } from "../appConfig";
import { renderGateReference, renderGateInfoButton } from "./gateReferenceHtml";
import { renderTeamQualitySection, renderAgentQualityPenaltySection, type ReportTeamQuality } from "./teamQualityHtml";

export interface WeeklyReportWeekData {
  range: DateRange;
  label: string; // e.g. "Mon 14 Sep – Sun 20 Sep 2026"
  dataset: PeriodDataset;
  /** Sum of penalty entry counts whose occurredOn falls inside this week. */
  penaltyCount: number;
  /** Count of QA audit records whose auditDate falls inside this week. */
  qaCount: number;
  /** Team QA Average and Rejection Quality for the week; omitted = the block is left out. */
  teamQuality?: ReportTeamQuality;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Same tone → color mapping as PerformanceBadge.tsx's gradeTone/tierTone,
// expressed as the app's own CSS custom-property values (globals.css) so
// this report reads as part of the same product rather than inventing a
// separate palette.
const COLOR = {
  primary: "hsl(226 64% 52%)",
  success: "hsl(152 58% 36%)",
  warning: "hsl(32 92% 48%)",
  danger: "hsl(358 70% 50%)",
  muted: "#6b7280",
  border: "#e5e7eb",
  ink: "#1a1d29",
};

/** Final-score band → color, matching the >=3 / >=2 / >=1 / else bucketing
 *  already used for the Dashboard's Grade badge (src/app/page.tsx). */
function scoreColor(score: number): string {
  if (score >= 3) return COLOR.primary;
  if (score >= 2) return COLOR.success;
  if (score >= 1) return COLOR.warning;
  return COLOR.danger;
}

function tierColor(tier: GateTier | null): string {
  switch (tier) {
    case "Exceptional":
      return COLOR.primary;
    case "Green":
      return COLOR.success;
    case "Amber":
      return COLOR.warning;
    case "Red":
      return COLOR.danger;
    default:
      return COLOR.muted;
  }
}

const GATE_SHORT_LABEL: Record<GateMetricKey, string> = {
  clientAvgWaitTime: "Client Wait Time",
  teamProcessingTime: "Team Processing Time",
  chatTeamAvgResponse: "Chat Avg Response",
  teamTicketAHT: "Team Ticket AHT",
};

const METRIC_SHORT_LABEL: Record<IndividualMetricKey, string> = {
  chatFRT: "Chat First",
  chatAvgResponse: "Chat Avg",
  appAHT: "App AHT",
  emailAHT: "Email AHT",
  csatDsat: "CSAT %",
  qaAudit: "QA %",
};

function formatGateValue(unit: "minutes" | "seconds", value: number | null): string {
  if (value === null) return "No data";
  return unit === "minutes" ? formatMinutesValue(value) : formatSeconds(value);
}

function formatGateDelta(unit: "minutes" | "seconds", delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const abs = Math.abs(delta);
  const formatted = unit === "minutes" ? formatMinutesValue(abs) : formatSeconds(abs);
  return `${sign}${formatted}`;
}

/** A semicircular gauge (0-120% scale, since the gate multiplier is capped
 *  at 115%) rendered as inline SVG — no external chart library, so the
 *  downloaded file stays fully self-contained. */
function renderGauge(pct: number, color: string, valueLabel: string, caption: string): string {
  const r = 74;
  const cx = 100;
  const cy = 96;
  const halfCirc = Math.PI * r;
  const fraction = Math.max(0, Math.min(1, pct / 120));
  const offset = halfCirc * (1 - fraction);
  return `
    <div style="text-align:center;">
      <svg viewBox="0 0 200 112" width="200" height="112" style="display:block;margin:0 auto;">
        <path d="M ${cx - r},${cy} A ${r},${r} 0 0 1 ${cx + r},${cy}" fill="none" stroke="#e5e7eb" stroke-width="14" stroke-linecap="round" />
        <path d="M ${cx - r},${cy} A ${r},${r} 0 0 1 ${cx + r},${cy}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
          stroke-dasharray="${halfCirc.toFixed(2)} ${halfCirc.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />
        <text x="100" y="88" text-anchor="middle" font-size="24" font-weight="700" fill="${COLOR.ink}" font-family="Inter,system-ui,sans-serif">${escapeHtml(valueLabel)}</text>
      </svg>
      <p style="margin:2px 0 0;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COLOR.muted};">${escapeHtml(caption)}</p>
    </div>`;
}

/** True if this agent's individual metrics show at least one real data
 *  point — distinguishes "actually reported this week" from the
 *  all-null placeholder row every unimported roster agent otherwise gets
 *  (see emptyRawMetrics/computeResults in query.ts). Used only to tell
 *  "zero data" apart from "some but not enough" for display wording below —
 *  ranking itself uses isRankable, not this. */
function hasAnyData(r: AgentPeriodResult): boolean {
  return r.individual.metrics.some((m) => !m.excluded);
}

/** True once this agent has at least MIN_SCORE_COVERAGE_WEEKLY of the
 *  scorecard's total weight backed by real data (see thresholds.ts) — the
 *  Weekly Report's own, more forgiving bar: a single week is a much
 *  narrower window than Month-to-Date, so Chat Avg Response, Chat First
 *  Response and CSAT often have no data at all yet within just this week
 *  even though the agent reports them fine across the full month. Below
 *  that, calculateIndividualScore's renormalization can turn a thin, lucky
 *  sample into a misleadingly perfect score — so those agents are excluded
 *  from ranking/rank-movement here, same as an agent with literally zero
 *  data, rather than letting a thin sample tie or beat someone who
 *  reported everything. */
function isRankable(r: AgentPeriodResult): boolean {
  return hasSufficientDataCoverage(r.individual.effectiveWeight, MIN_SCORE_COVERAGE_WEEKLY);
}

interface RankedActive {
  result: AgentPeriodResult;
  rank: number; // 1-based, among rankable agents only
}

function activeRanked(dataset: PeriodDataset): RankedActive[] {
  return dataset.ranked.filter(isRankable).map((result, i) => ({ result, rank: i + 1 }));
}

/** Active-roster agents without enough data to rank this period — either
 *  literally none, or under the MIN_SCORE_COVERAGE threshold above. These
 *  used to be silently dropped from every section below (activeRanked's old
 *  filter excluded anyone below the threshold too), meaning an agent who
 *  simply hadn't been imported yet — or had only a couple of metrics
 *  reported — just vanished from the report instead of showing up as a gap
 *  to chase down. They're excluded from ranking/rank-movement (there's
 *  nothing meaningfully comparable to rank), but every section still lists
 *  them with an explicit "No data yet" / "Insufficient data" placeholder
 *  rather than omitting them. Inactive-status agents (former staff) are
 *  left out here so they don't clutter the report forever — this only
 *  affects this "not enough data" group; an inactive agent who *does* have
 *  enough data this period still shows normally via activeRanked above,
 *  unchanged from before.
 */
function noDataAgents(dataset: PeriodDataset): AgentPeriodResult[] {
  return dataset.ranked.filter((r) => r.agent.status === "active" && !isRankable(r));
}

export function generateWeeklyReportHtml(thisWeek: WeeklyReportWeekData, lastWeek: WeeklyReportWeekData | null): string {
  const now = new Date();
  const generatedLabel = `${new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now)} · ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(now).toLowerCase()}`;

  const thisActive = activeRanked(thisWeek.dataset);
  const lastActive = lastWeek ? activeRanked(lastWeek.dataset) : [];
  const lastByAgent = new Map(lastActive.map((a) => [a.result.agent.id, a]));
  const thisNoData = noDataAgents(thisWeek.dataset);

  const thisGate = thisWeek.dataset.results[0]?.gate ?? null;
  const lastGate = lastWeek?.dataset.results[0]?.gate ?? null;
  const thisPct = thisGate ? thisGate.gateMultiplier * 100 : null;
  const lastPct = lastGate ? lastGate.gateMultiplier * 100 : null;
  const gateDeltaPct = thisPct !== null && lastPct !== null ? thisPct - lastPct : null;

  const agentCount = thisActive.length + thisNoData.length;

  // ── Header ────────────────────────────────────────────────────────────
  const header = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-radius:12px;padding:24px 28px;margin-bottom:20px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <h1 style="margin:0;font-size:22px;color:${COLOR.ink};">📊 ${escapeHtml(APP_NAME)} — Weekly Report</h1>
          <p style="margin:4px 0 0;font-size:13px;color:${COLOR.muted};">Fusionmarkets · KYC · Week-on-Week Comparison</p>
        </div>
        ${thisPct !== null
          ? `<div style="text-align:right;">
              <p style="margin:0;font-size:11px;color:${COLOR.muted};text-transform:uppercase;letter-spacing:.04em;">Gate</p>
              <p style="margin:2px 0 0;font-size:22px;font-weight:700;color:${tierColor(thisGate!.overallTier)};">${thisPct.toFixed(2)}%
                ${gateDeltaPct !== null ? `<span style="font-size:13px;font-weight:600;color:${gateDeltaPct >= 0 ? COLOR.success : COLOR.danger};">${gateDeltaPct >= 0 ? "▲" : "▼"} ${gateDeltaPct >= 0 ? "+" : ""}${gateDeltaPct.toFixed(2)}% WoW</span>` : ""}
              </p>
            </div>`
          : ""}
      </div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:16px;">
        <div>
          <p style="margin:0;font-size:10px;color:${COLOR.muted};text-transform:uppercase;letter-spacing:.04em;">Last week</p>
          <p style="margin:2px 0 0;font-size:14px;font-weight:600;color:${COLOR.ink};">${lastWeek ? escapeHtml(lastWeek.label) : "No prior week imported"}</p>
        </div>
        <div style="align-self:center;color:${COLOR.muted};">→</div>
        <div>
          <p style="margin:0;font-size:10px;color:${COLOR.muted};text-transform:uppercase;letter-spacing:.04em;">This week</p>
          <p style="margin:2px 0 0;font-size:14px;font-weight:600;color:${COLOR.ink};">${escapeHtml(thisWeek.label)}</p>
        </div>
      </div>
      <p style="margin:16px 0 0;font-size:11px;color:${COLOR.muted};">
        Generated: <strong style="color:${COLOR.ink};">${escapeHtml(generatedLabel)}</strong>
        &nbsp;·&nbsp; Agents: <strong style="color:${COLOR.ink};">${agentCount}</strong>${thisNoData.length > 0 ? ` <span style="color:${COLOR.muted};">(${thisActive.length} reported, ${thisNoData.length} no data yet)</span>` : ""}
        &nbsp;·&nbsp; QA: <strong style="color:${COLOR.ink};">${thisWeek.qaCount}</strong>
        &nbsp;·&nbsp; Penalties: <strong style="color:${COLOR.ink};">${thisWeek.penaltyCount}</strong>
      </p>
    </div>`;

  // ── Business Gate — Week-on-Week ────────────────────────────────────────
  const gauges = `
    <div style="display:flex;align-items:center;justify-content:center;gap:24px;flex-wrap:wrap;padding:12px 0 4px;">
      ${lastPct !== null ? renderGauge(lastPct, tierColor(lastGate!.overallTier), `${lastPct.toFixed(1)}%`, "Last week") : `<div style="color:${COLOR.muted};font-size:13px;">No prior gate data</div>`}
      ${lastPct !== null && thisPct !== null ? `<div style="color:${COLOR.muted};font-size:20px;">→</div>` : ""}
      ${thisPct !== null ? renderGauge(thisPct, tierColor(thisGate!.overallTier), `${thisPct.toFixed(1)}%`, "This week") : `<div style="color:${COLOR.muted};font-size:13px;">No gate data this week</div>`}
    </div>
    ${thisGate ? `<p style="text-align:center;margin:4px 0 0;font-size:13px;color:${COLOR.muted};">Status: <strong style="color:${tierColor(thisGate.overallTier)};">${thisGate.overallTier}</strong></p>` : ""}`;

  const kpiBars = GATE_METRICS.map((def) => {
    const thisM = thisGate?.metrics.find((m) => m.key === def.key) ?? null;
    const lastM = lastGate?.metrics.find((m) => m.key === def.key) ?? null;
    const thisVal = thisM?.actual ?? null;
    const lastVal = lastM?.actual ?? null;
    // Lower-is-better for all four gate metrics — bar length is drawn
    // relative to whichever of the two values is larger this row, so the
    // comparison is always readable regardless of unit/scale.
    const maxVal = Math.max(thisVal ?? 0, lastVal ?? 0, 1);
    const lastWidth = lastVal !== null ? Math.max(2, (lastVal / maxVal) * 100) : 0;
    const thisWidth = thisVal !== null ? Math.max(2, (thisVal / maxVal) * 100) : 0;
    const delta = thisVal !== null && lastVal !== null ? thisVal - lastVal : null;
    const improved = delta !== null && delta < 0;
    const regressed = delta !== null && delta > 0;
    return `
      <div style="margin-bottom:14px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:${COLOR.ink};">${escapeHtml(GATE_SHORT_LABEL[def.key])}</p>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
          <div style="flex:1;background:#f1f2f4;border-radius:4px;height:8px;position:relative;">
            <div style="width:${lastWidth}%;background:#c7cbd4;height:8px;border-radius:4px;"></div>
          </div>
          <span style="font-size:11px;color:${COLOR.muted};min-width:70px;text-align:right;">${escapeHtml(formatGateValue(def.unit, lastVal))}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;background:#f1f2f4;border-radius:4px;height:8px;position:relative;">
            <div style="width:${thisWidth}%;background:${COLOR.primary};height:8px;border-radius:4px;"></div>
          </div>
          <span style="font-size:11px;font-weight:700;color:${COLOR.ink};min-width:70px;text-align:right;">${escapeHtml(formatGateValue(def.unit, thisVal))}</span>
        </div>
        ${delta !== null ? `<p style="margin:2px 0 0;text-align:right;font-size:11px;font-weight:600;color:${improved ? COLOR.success : regressed ? COLOR.danger : COLOR.muted};">${improved ? "↓" : regressed ? "↑" : "→"}${formatGateDelta(def.unit, delta)}</p>` : ""}
      </div>`;
  }).join("");

  const gateSummaryRows = [
    `<tr style="border-top:1px solid ${COLOR.border};background:#fbfaf5;">
      <td style="padding:8px 10px;font-weight:700;">📊 Gate Score</td>
      <td style="padding:8px 10px;font-weight:700;color:${thisGate ? tierColor(thisGate.overallTier) : COLOR.muted};">${thisPct !== null ? `${thisPct.toFixed(2)}%` : "No data"}</td>
      <td style="padding:8px 10px;">${lastPct !== null ? `${lastPct.toFixed(2)}%` : "—"}</td>
      <td style="padding:8px 10px;font-weight:700;color:${gateDeltaPct === null ? COLOR.muted : gateDeltaPct > 0 ? COLOR.success : gateDeltaPct < 0 ? COLOR.danger : COLOR.muted};">${gateDeltaPct === null ? "—" : gateDeltaPct === 0 ? "→ no change" : `${gateDeltaPct > 0 ? "↑" : "↓"} ${gateDeltaPct > 0 ? "+" : ""}${gateDeltaPct.toFixed(2)}%`}</td>
      <td style="padding:8px 10px;">${gateDeltaPct === null ? "—" : gateDeltaPct === 0 ? "No change" : gateDeltaPct > 0 ? "Improved" : "Regressed"}</td>
    </tr>`,
    ...GATE_METRICS.map((def) => {
      const thisM = thisGate?.metrics.find((m) => m.key === def.key) ?? null;
      const lastM = lastGate?.metrics.find((m) => m.key === def.key) ?? null;
      const thisVal = thisM?.actual ?? null;
      const lastVal = lastM?.actual ?? null;
      const delta = thisVal !== null && lastVal !== null ? thisVal - lastVal : null;
      const improved = delta !== null && delta < 0; // lower-is-better
      const regressed = delta !== null && delta > 0;
      return `<tr style="border-top:1px solid ${COLOR.border};">
        <td style="padding:8px 10px;color:${COLOR.ink};">${escapeHtml(GATE_SHORT_LABEL[def.key])}</td>
        <td style="padding:8px 10px;font-weight:600;color:${COLOR.primary};">${escapeHtml(formatGateValue(def.unit, thisVal))}</td>
        <td style="padding:8px 10px;color:${COLOR.muted};">${escapeHtml(formatGateValue(def.unit, lastVal))}</td>
        <td style="padding:8px 10px;font-weight:600;color:${delta === null ? COLOR.muted : improved ? COLOR.success : regressed ? COLOR.danger : COLOR.muted};">${delta === null ? "—" : delta === 0 ? "→ no change" : `${regressed ? "↑" : "↓"} ${formatGateDelta(def.unit, delta)}`}</td>
        <td style="padding:8px 10px;color:${COLOR.muted};">${delta === null ? "—" : delta === 0 ? "No change" : improved ? "Improved" : "Regressed"}</td>
      </tr>`;
    }),
  ].join("");

  const businessGateSection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.primary};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${COLOR.ink};">📘 Business Gate — Week-on-Week${renderGateInfoButton()}</p>
      ${gauges}
      <p style="margin:16px 0 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COLOR.muted};">KPI Comparison — Last Week vs This Week</p>
      <div style="border:1px solid ${COLOR.border};border-radius:8px;padding:14px 16px;">
        ${kpiBars}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:14px;">
        <thead>
          <tr style="text-align:left;color:${COLOR.muted};font-size:11px;text-transform:uppercase;letter-spacing:.03em;">
            <th style="padding:6px 10px;">Metric</th><th style="padding:6px 10px;">This Week</th><th style="padding:6px 10px;">Last Week</th><th style="padding:6px 10px;">Change</th><th style="padding:6px 10px;">Trend</th>
          </tr>
        </thead>
        <tbody>${gateSummaryRows}</tbody>
      </table>
      <p style="margin:16px 0 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COLOR.muted};">QA &amp; Penalties</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div style="border:1px solid ${COLOR.border};border-radius:8px;padding:12px 14px;">
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:${COLOR.muted};">QA Audits</p>
          <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:${COLOR.ink};">${thisWeek.qaCount}</p>
          <p style="margin:2px 0 0;font-size:11px;color:${COLOR.muted};">${qaPenaltyDeltaLabel(thisWeek.qaCount, lastWeek?.qaCount ?? null)}</p>
        </div>
        <div style="border:1px solid ${COLOR.border};border-radius:8px;padding:12px 14px;">
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:${COLOR.muted};">Penalties</p>
          <p style="margin:4px 0 0;font-size:22px;font-weight:700;color:${COLOR.ink};">${thisWeek.penaltyCount}</p>
          <p style="margin:2px 0 0;font-size:11px;color:${COLOR.muted};">${qaPenaltyDeltaLabel(thisWeek.penaltyCount, lastWeek?.penaltyCount ?? null)}</p>
          <div style="margin-top:6px;background:#f1f2f4;border-radius:4px;height:6px;">
            <div style="width:${Math.min(100, (thisWeek.penaltyCount / Math.max(1, thisWeek.penaltyCount, lastWeek?.penaltyCount ?? 0)) * 100)}%;background:${thisWeek.penaltyCount === 0 ? COLOR.success : COLOR.warning};height:6px;border-radius:4px;"></div>
          </div>
        </div>
      </div>
    </div>`;

  // ── Agent Scoreboard ─────────────────────────────────────────────────
  const scoreboardRows = thisActive
    .map(({ result, rank }) => {
      const score = result.individual.finalScore;
      const width = Math.max(1, (score / 3) * 100);
      const last = lastByAgent.get(result.agent.id);
      const lastScore = last?.result.individual.finalScore ?? null;
      const lastMarkerPct = lastScore !== null ? Math.max(0, Math.min(100, (lastScore / 3) * 100)) : null;
      const rankChange = last ? last.rank - rank : null; // positive = moved up (better)
      const rankBadge =
        rankChange === null
          ? `<span style="color:${COLOR.primary};font-weight:600;">NEW</span>`
          : rankChange === 0
          ? `<span style="color:${COLOR.muted};">=</span>`
          : `<span style="color:${rankChange > 0 ? COLOR.success : COLOR.danger};font-weight:600;">${rankChange > 0 ? "▲" : "▼"}${Math.abs(rankChange)}</span>`;
      return `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="width:120px;font-size:12px;color:${COLOR.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(result.agent.name)}</div>
          <div style="flex:1;background:#f1f2f4;border-radius:4px;height:14px;position:relative;">
            <div style="width:${width}%;background:${scoreColor(score)};height:14px;border-radius:4px;"></div>
            ${lastMarkerPct !== null ? `<div style="position:absolute;left:${lastMarkerPct}%;top:-2px;width:2px;height:18px;background:${COLOR.warning};"></div>` : ""}
          </div>
          <div style="width:56px;text-align:right;font-size:12px;font-weight:700;color:${COLOR.ink};">${score.toFixed(2)}</div>
          <div style="width:44px;text-align:right;font-size:12px;">${rankBadge}</div>
        </div>`;
    })
    .join("");

  const scoreChangeRows = thisActive
    .map(({ result }) => {
      const last = lastByAgent.get(result.agent.id);
      if (!last) return "";
      const delta = result.individual.finalScore - last.result.individual.finalScore;
      // A 0.50-point swing (roughly the largest seen in practice) fills
      // half the diverging chart's width; larger swings just cap there
      // rather than blowing out the layout.
      const pct = Math.min(50, Math.abs(delta) * 100);
      const improved = delta > 0;
      return `
        <div style="display:flex;align-items:center;margin-bottom:4px;font-size:11px;">
          <div style="width:120px;color:${COLOR.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(result.agent.name)}</div>
          <div style="flex:1;display:flex;align-items:center;">
            <div style="width:50%;display:flex;justify-content:flex-end;">
              ${!improved && delta !== 0 ? `<div style="width:${pct}%;background:${COLOR.danger};height:10px;border-radius:2px 0 0 2px;"></div>` : ""}
            </div>
            <div style="width:1px;height:14px;background:${COLOR.border};"></div>
            <div style="width:50%;">
              ${improved ? `<div style="width:${pct}%;background:${COLOR.success};height:10px;border-radius:0 2px 2px 0;"></div>` : ""}
            </div>
          </div>
          <div style="width:56px;text-align:right;font-weight:600;color:${delta === 0 ? COLOR.muted : improved ? COLOR.success : COLOR.danger};">${delta === 0 ? "±0" : `${improved ? "+" : ""}${delta.toFixed(2)}`}</div>
        </div>`;
    })
    .join("");

  const noDataScoreboardRows = thisNoData
    .map(
      (r) => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;opacity:0.65;">
          <div style="width:120px;font-size:12px;color:${COLOR.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.agent.name)}</div>
          <div style="flex:1;background:#f1f2f4;border-radius:4px;height:14px;display:flex;align-items:center;">
            <span style="margin-left:8px;font-size:10px;font-style:italic;color:${COLOR.muted};">${hasAnyData(r) ? "Insufficient data" : "No data yet"}</span>
          </div>
          <div style="width:56px;text-align:right;font-size:12px;color:${COLOR.muted};">—</div>
          <div style="width:44px;text-align:right;font-size:12px;color:${COLOR.muted};">—</div>
        </div>`
    )
    .join("");

  const scoreboardSection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid #6b46c1;border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${COLOR.ink};">👥 Agent Scoreboard — Week-on-Week</p>
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${COLOR.muted};">Score bars — this week (amber marker = last week · right column = rank change)</p>
      ${scoreboardRows}
      ${noDataScoreboardRows ? `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed ${COLOR.border};">${noDataScoreboardRows}</div>` : ""}
      ${lastWeek ? `
        <p style="margin:20px 0 8px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${COLOR.muted};">Score change vs last week</p>
        ${scoreChangeRows || `<p style="font-size:12px;color:${COLOR.muted};">No agents overlap between both weeks.</p>`}
      ` : ""}
    </div>`;

  // ── Movement Table ───────────────────────────────────────────────────
  const movementRows = thisActive
    .map(({ result, rank }) => {
      const last = lastByAgent.get(result.agent.id);
      const score = result.individual.finalScore;
      const lastScore = last?.result.individual.finalScore ?? null;
      const change = lastScore !== null ? score - lastScore : null;
      const rankChange = last ? last.rank - rank : null;
      const positionLabel = last ? `#${rank} (was #${last.rank})` : `#${rank} (NEW)`;
      const rankDeltaLabel =
        rankChange === null ? "—" : rankChange === 0 ? "→" : `${rankChange > 0 ? "▲" : "▼"} ${Math.abs(rankChange)}`;
      const metricLine = INDIVIDUAL_METRICS.map((def) => {
        const m = result.individual.metrics.find((x) => x.key === def.key);
        const lm = last?.result.individual.metrics.find((x) => x.key === def.key);
        if (!m || m.excluded || m.actual === null) return `${escapeHtml(METRIC_SHORT_LABEL[def.key])}: <span style="color:${COLOR.muted};">—</span>`;
        let deltaStr = "";
        if (lm && !lm.excluded && lm.actual !== null) {
          const d = m.actual - lm.actual;
          if (Math.abs(d) > 0.005) {
            const arrow = d > 0 ? "↑" : "↓";
            const unit = def.unit === "percent" ? "%" : def.unit === "minutes" ? "m" : "s";
            deltaStr = ` <span style="color:${COLOR.muted};">${arrow}${Math.abs(d).toFixed(2)}${unit}</span>`;
          }
        }
        return `${escapeHtml(METRIC_SHORT_LABEL[def.key])}: <strong style="color:${COLOR.ink};">${escapeHtml(m.actualDisplay)}</strong>${deltaStr}`;
      }).join(" &nbsp;·&nbsp; ");
      return `
        <tr style="border-top:1px solid ${COLOR.border};">
          <td style="padding:10px 10px 2px;font-weight:700;color:${COLOR.ink};">${escapeHtml(result.agent.name)}</td>
          <td style="padding:10px 10px 2px;font-weight:700;color:${scoreColor(score)};">${score.toFixed(2)}/3</td>
          <td style="padding:10px 10px 2px;color:${COLOR.muted};">${lastScore !== null ? lastScore.toFixed(2) : "—"}</td>
          <td style="padding:10px 10px 2px;font-weight:600;color:${change === null ? COLOR.muted : change > 0 ? COLOR.success : change < 0 ? COLOR.danger : COLOR.muted};">${change === null ? "—" : change === 0 ? "→ no change" : `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(2)}`}</td>
          <td style="padding:10px 10px 2px;">${rankDeltaLabel}</td>
          <td style="padding:10px 10px 2px;color:${COLOR.muted};">${positionLabel}</td>
        </tr>
        <tr style="border-top:none;">
          <td colspan="6" style="padding:0 10px 10px;font-size:11px;color:${COLOR.muted};">${metricLine}</td>
        </tr>`;
    })
    .join("");

  const absentAgents = lastActive.filter((a) => !thisActive.some((t) => t.result.agent.id === a.result.agent.id));
  const absentRows = absentAgents
    .map(
      (a) => `<tr style="border-top:1px solid ${COLOR.border};color:${COLOR.muted};">
        <td style="padding:8px 10px;">${escapeHtml(a.result.agent.name)}</td>
        <td style="padding:8px 10px;">—</td>
        <td style="padding:8px 10px;">${a.result.individual.finalScore.toFixed(2)}/3</td>
        <td style="padding:8px 10px;">—</td>
        <td style="padding:8px 10px;font-weight:600;">ABSENT</td>
        <td style="padding:8px 10px;">— (was #${a.rank})</td>
      </tr>`
    )
    .join("");

  // Roster agents with no data this week who ALSO aren't in absentAgents
  // above (i.e. they had no data last week either, or there's no prior week
  // at all) — agents who had data last week but not this week are already
  // covered by the ABSENT table, so this stays a distinct, non-overlapping
  // group rather than double-listing the same person.
  const neverReported = thisNoData.filter((r) => !absentAgents.some((a) => a.result.agent.id === r.agent.id));
  const neverReportedRows = neverReported
    .map(
      (r) => `<tr style="border-top:1px solid ${COLOR.border};color:${COLOR.muted};">
        <td style="padding:8px 10px;">${escapeHtml(r.agent.name)}</td>
        <td style="padding:8px 10px;">—</td>
        <td style="padding:8px 10px;">—</td>
        <td style="padding:8px 10px;">—</td>
        <td style="padding:8px 10px;font-style:italic;">${hasAnyData(r) ? "Insufficient data" : "No data yet"}</td>
        <td style="padding:8px 10px;">—</td>
      </tr>`
    )
    .join("");

  const movementSection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.success};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${COLOR.ink};">Movement Table</p>
      <p style="margin:0 0 12px;font-size:11px;color:${COLOR.muted};">KPI deltas shown inline. Rank change = leaderboard movement vs last week.</p>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:${COLOR.muted};font-size:11px;text-transform:uppercase;letter-spacing:.03em;">
              <th style="padding:6px 10px;">Agent</th><th style="padding:6px 10px;">This Week</th><th style="padding:6px 10px;">Last Week</th><th style="padding:6px 10px;">Change</th><th style="padding:6px 10px;">Rank Δ</th><th style="padding:6px 10px;">Position</th>
            </tr>
          </thead>
          <tbody>${movementRows}</tbody>
        </table>
      </div>
      ${absentAgents.length > 0 ? `
        <p style="margin:18px 0 6px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${COLOR.muted};">No entries this week (had data last week)</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tbody>${absentRows}</tbody>
        </table>
      ` : ""}
      ${neverReported.length > 0 ? `
        <p style="margin:18px 0 6px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${COLOR.muted};">No data yet (no import on record)</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tbody>${neverReportedRows}</tbody>
        </table>
      ` : ""}
    </div>`;

  // ── Coach Watch ──────────────────────────────────────────────────────
  // "Star" requires BOTH: no individual KPI graded below On Target, AND the
  // final score (after penalties) still clears the same 2.80 "On Target"
  // bar used everywhere else in the app (Scorecards, Dashboard). Without
  // the finalScore check, an agent with every KPI at exactly "On Target"
  // (grade 2, not "Exceptional") — or one who cleared every KPI but then
  // took a penalty — could weight/penalty their way down to a final score
  // under 2.80 and still show up here as a "star", which read as
  // inconsistent with the 2.80 line used everywhere else.
  const stars = thisActive.filter(
    ({ result }) =>
      result.individual.finalScore >= SCORE_PASS_THRESHOLD &&
      result.individual.metrics.every((m) => m.excluded || (m.grade !== null && m.grade >= 2))
  );
  const needsCoaching = thisActive.filter(
    ({ result }) => result.individual.metrics.filter((m) => !m.excluded && m.grade !== null && m.grade <= 1).length >= 2
  );

  const starChips = stars
    .map(
      ({ result }) => `<span style="display:inline-flex;align-items:center;gap:6px;border:1px solid ${COLOR.border};border-radius:999px;padding:6px 12px;margin:0 6px 6px 0;font-size:12px;">
        ⭐ <strong style="color:${COLOR.ink};">${escapeHtml(result.agent.name)}</strong> <span style="color:${COLOR.muted};">${result.individual.finalScore.toFixed(2)}/3</span>
      </span>`
    )
    .join("");

  const coachingCards = needsCoaching
    .map(({ result }) => {
      const belowTarget = result.individual.metrics.filter((m) => !m.excluded && m.grade !== null && m.grade <= 1);
      const labels = belowTarget.map((m) => METRIC_SHORT_LABEL[m.key]).join(", ");
      const status = result.individual.finalScore >= 2.0 ? "Almost There" : "Needs Improvement";
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;border:1px solid ${COLOR.danger}33;border-radius:8px;padding:12px 14px;margin-bottom:8px;">
          <div>
            <p style="margin:0;font-weight:700;color:${COLOR.danger};">🔻 ${escapeHtml(result.agent.name)}</p>
            <p style="margin:2px 0 0;font-size:12px;color:${COLOR.muted};">Below target: ${escapeHtml(labels)}</p>
          </div>
          <div style="text-align:right;">
            <p style="margin:0;font-weight:700;color:${COLOR.ink};">${result.individual.finalScore.toFixed(2)}/3</p>
            <p style="margin:2px 0 0;font-size:11px;color:${status === "Almost There" ? COLOR.warning : COLOR.danger};">${status}</p>
          </div>
        </div>`;
    })
    .join("");

  const coachWatchSection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.warning};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:${COLOR.ink};">🎯 Coach Watch</p>
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:${COLOR.ink};">⭐ Stars of the Week (on target in all KPIs)</p>
      <div style="margin-bottom:16px;">${starChips || `<span style="font-size:12px;color:${COLOR.muted};">No agents were on target in every KPI this week.</span>`}</div>
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:${COLOR.ink};">🔻 Needs Coaching (2+ KPIs below target)</p>
      ${coachingCards || `<p style="font-size:12px;color:${COLOR.muted};">No agents fell below target on 2 or more KPIs this week.</p>`}
    </div>`;

  const gateReferenceSection = renderGateReference({ gate: thisGate, scope: "week", periodLabel: thisWeek.label });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(APP_NAME)} — Weekly Report — ${escapeHtml(thisWeek.label)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Inter,system-ui,-apple-system,sans-serif;color:${COLOR.ink};">
  <div style="max-width:920px;margin:0 auto;padding:32px 24px 60px;">
    ${header}
    ${thisWeek.teamQuality ? renderTeamQualitySection(thisWeek.teamQuality, "this week") : ""}
    ${renderAgentQualityPenaltySection(thisWeek.dataset.results, "this week")}
    ${businessGateSection}
    ${gateReferenceSection}
    ${scoreboardSection}
    ${movementSection}
    ${coachWatchSection}
    <p style="text-align:center;font-size:11px;color:${COLOR.muted};margin-top:8px;">Generated by ${escapeHtml(APP_NAME)} · Weekly Report · ${escapeHtml(generatedLabel)}</p>
  </div>
</body>
</html>`;
}

function qaPenaltyDeltaLabel(current: number, previous: number | null): string {
  if (previous === null) return "No prior week to compare";
  const delta = current - previous;
  if (delta === 0) return `→ no change vs prev (${previous})`;
  return `${delta > 0 ? "↑" : "↓"} ${delta > 0 ? "+" : ""}${delta} vs prev (${previous})`;
}
