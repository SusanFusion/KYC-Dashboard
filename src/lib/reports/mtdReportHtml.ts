// Builds the self-contained "MTD Report" HTML file — Susan's request was to
// match the layout/format of a reference report she uses elsewhere (alerts,
// executive summary, Business Gate MTD with trend charts, a full Agent
// Rankings section with a KPI heatmap, a Month-over-Month comparison, and
// Consistent Performers / Agents Needing Attention streak tables) rebuilt
// against this app's own KYC metrics and Business Gate model.
//
// Unlike that reference (which loads Chart.js from a CDN), every chart here
// is inline SVG — no external requests — matching the same "opens correctly
// as a downloaded/emailed file with nothing else running" rule
// weeklyReportHtml.ts already follows (see route.ts's own comment on that).
//
// Deliberately pure: everything this needs is precomputed by
// mtdReportData.ts and passed in, so this module has no data-access
// concerns of its own.

import { renderTeamQualitySection, renderAgentQualityPenaltySection } from "./teamQualityHtml";
import type { MtdReportData, MtdStreak } from "../data/mtdReportData";
import { INDIVIDUAL_METRICS, GATE_METRICS, SCORE_PASS_THRESHOLD } from "../scoring/thresholds";
import { formatSeconds, formatMinutesValue } from "../data/time";
import { formatMagnitude } from "../scoring/display";
import type { Grade, GateTier, IndividualMetricKey, GateMetricKey } from "../scoring/types";
import { APP_NAME } from "../appConfig";
import { renderGateReference, renderGateInfoButton } from "./gateReferenceHtml";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Same tone → color mapping weeklyReportHtml.ts uses, expressed as the
// app's own CSS custom-property values so this report reads as part of the
// same product.
const COLOR = {
  primary: "hsl(226 64% 52%)",
  success: "hsl(152 58% 36%)",
  warning: "hsl(32 92% 48%)",
  danger: "hsl(358 70% 50%)",
  muted: "#6b7280",
  border: "#e5e7eb",
  ink: "#1a1d29",
};

// The reference report's own five-way score categorization (Perfect down to
// At Risk) — not used anywhere else in this app's scoring (which only cares
// about SCORE_PASS_THRESHOLD for pass/fail), so these are report-display
// buckets only, anchored on that same threshold rather than inventing an
// unrelated cutoff.
const CATEGORY = {
  perfect: { label: "Perfect", color: "#b45309" },
  exceptional: { label: "Exceptional", color: "#1565c0" },
  almostThere: { label: "Almost There", color: "#1b5e20" },
  needsImprovement: { label: "Needs Improvement", color: "#e65100" },
  atRisk: { label: "At Risk", color: "#b71c1c" },
};

function scoreCategory(score: number): { label: string; color: string } {
  if (score >= 3) return CATEGORY.perfect;
  if (score >= SCORE_PASS_THRESHOLD) return CATEGORY.exceptional;
  if (score >= 2.0) return CATEGORY.almostThere;
  if (score >= 1.0) return CATEGORY.needsImprovement;
  return CATEGORY.atRisk;
}

const GRADE_COLOR: Record<Grade, string> = {
  3: "#1565c0",
  2: "#1b5e20",
  1: "#e65100",
  0: "#b71c1c",
};

const GRADE_DOT: Record<Grade, string> = { 3: "●", 2: "●", 1: "◑", 0: "○" };

// Short column-header labels for the two metric sets — same names
// weeklyReportHtml.ts's own METRIC_SHORT_LABEL/GATE_SHORT_LABEL use, kept
// consistent across both reports. Needed because the full metric names
// (e.g. "Agent KYC Application Ave Handling Time – FD" and "Agent KYC
// Email Ave Handling Time (Ticket AHT) - includes KYB") share enough
// leading words that a naive truncation collides two different metrics
// onto the same table header.
const METRIC_SHORT_LABEL: Record<IndividualMetricKey, string> = {
  chatFRT: "Chat First",
  chatAvgResponse: "Chat Avg",
  appAHT: "App AHT",
  emailAHT: "Email AHT",
  csatDsat: "CSAT %",
  qaAudit: "QA %",
};

const GATE_SHORT_LABEL: Record<GateMetricKey, string> = {
  clientAvgWaitTime: "Client Wait Time",
  teamProcessingTime: "Team Processing Time",
  chatTeamAvgResponse: "Chat Avg Response",
  teamTicketAHT: "Team Ticket AHT",
};

const GATE_TIER_COLOR: Record<GateTier, string> = {
  Exceptional: "#1565c0",
  Green: "#1b5e20",
  Amber: "#e65100",
  Red: "#b71c1c",
};

function formatGateValue(unit: "minutes" | "seconds", value: number | null): string {
  if (value === null) return "No data";
  return unit === "minutes" ? formatMinutesValue(value) : formatSeconds(value);
}

// ── Inline SVG mini line chart — the self-contained stand-in for the
// reference report's Chart.js "tier-banded" trend charts. Bands are shaded
// rects behind the line (one per grade/tier), the line breaks wherever a
// day has no data (never fabricated across a gap, same rule as
// MetricTrendChart elsewhere in this app), and each point is colored by its
// own day's grade/tier. ──────────────────────────────────────────────────
const CHART_W = 640;
const CHART_H = 150;
const PAD_L = 40;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 20;

interface ChartPoint {
  label: string;
  value: number | null;
  color: string;
}
interface BandRect {
  from: number;
  to: number;
  color: string;
}

function renderMiniLineChart(points: ChartPoint[], bandRects: BandRect[], formatValue: (v: number) => string, targetLine: number | null = null): string {
  const plotW = CHART_W - PAD_L - PAD_R;
  const plotH = CHART_H - PAD_T - PAD_B;
  const realValues = points.map((p) => p.value).filter((v): v is number => v !== null);
  const finiteBandTops = bandRects.map((b) => b.to).filter((v) => Number.isFinite(v));
  const dataMax = realValues.length ? Math.max(...realValues) : 0;
  const bandMax = finiteBandTops.length ? Math.max(...finiteBandTops) : 0;
  const yMax = Math.max(dataMax * 1.15, bandMax * 1.05, targetLine ?? 0, 1);
  const yMin = 0;

  const xFor = (i: number) => PAD_L + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yFor = (v: number) => PAD_T + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const bands = bandRects
    .map((b) => {
      const to = Math.min(b.to, yMax);
      const from = Math.max(b.from, yMin);
      if (to <= from) return "";
      const y1 = yFor(to);
      const y2 = yFor(from);
      return `<rect x="${PAD_L}" y="${y1.toFixed(1)}" width="${plotW}" height="${(y2 - y1).toFixed(1)}" fill="${b.color}" opacity="0.16" />`;
    })
    .join("");

  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length > 1) segments.push(`<polyline points="${current.join(" ")}" fill="none" stroke="${COLOR.primary}" stroke-width="2" />`);
      current = [];
      return;
    }
    current.push(`${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(`<polyline points="${current.join(" ")}" fill="none" stroke="${COLOR.primary}" stroke-width="2" />`);

  const dots = points
    .map((p, i) => (p.value === null ? "" : `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.value).toFixed(1)}" r="3.5" fill="${p.color}" stroke="#fff" stroke-width="1" />`))
    .join("");

  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const xLabels = points
    .map((p, i) => {
      if (i % labelEvery !== 0 && i !== points.length - 1) return "";
      return `<text x="${xFor(i).toFixed(1)}" y="${CHART_H - 4}" font-size="9" fill="${COLOR.muted}" text-anchor="middle">${escapeHtml(p.label)}</text>`;
    })
    .join("");

  const yTicks = [yMin, yMax / 2, yMax];
  const yLabels = yTicks
    .map((v) => `<text x="${PAD_L - 5}" y="${(yFor(v) + 3).toFixed(1)}" font-size="9" fill="${COLOR.muted}" text-anchor="end">${escapeHtml(formatValue(v))}</text>`)
    .join("");

  const target =
    targetLine !== null
      ? `<line x1="${PAD_L}" y1="${yFor(targetLine).toFixed(1)}" x2="${CHART_W - PAD_R}" y2="${yFor(targetLine).toFixed(1)}" stroke="${COLOR.success}" stroke-width="1.5" stroke-dasharray="4 3" />`
      : "";

  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" height="${CHART_H}" style="display:block;">
    ${bands}${yLabels}${target}${segments.join("")}${dots}${xLabels}
  </svg>`;
}

/** Small trailing-days bar sparkline, matching the streak tables' own
 *  "Recent Values" trend column — bar height is proportional to the raw
 *  value (not to "goodness"), same as this report's reference design. */
function renderSparkline(values: number[], color: string): string {
  const max = Math.max(...values, 0.0001);
  const bars = values
    .map((v) => {
      const h = Math.max(2, Math.round((v / max) * 20));
      return `<div style="width:7px;height:${h}px;background:${color};border-radius:2px 2px 0 0;opacity:.75"></div>`;
    })
    .join("");
  return `<div style="display:flex;align-items:flex-end;gap:1.5px;height:20px;">${bars}</div>`;
}

function gateBandRects(key: GateMetricKey): BandRect[] {
  const def = GATE_METRICS.find((d) => d.key === key)!;
  return def.bands.map((b) => ({ from: b.min ?? 0, to: b.max ?? Infinity, color: GATE_TIER_COLOR[b.tier] }));
}

export function generateMtdReportHtml(data: MtdReportData): string {
  const gatePct = data.gateOverall ? data.gateOverall.gateMultiplier * 100 : null;
  const rankable = data.rankableAgents;
  const categorized = rankable.map((a) => ({ agent: a, category: scoreCategory(a.result.individual.finalScore) }));
  const atRisk = categorized.filter((c) => c.category === CATEGORY.atRisk);
  const exceptionalCount = categorized.filter((c) => c.category === CATEGORY.exceptional || c.category === CATEGORY.perfect).length;
  const almostThereCount = categorized.filter((c) => c.category === CATEGORY.almostThere).length;
  const needsImprovementCount = categorized.filter((c) => c.category === CATEGORY.needsImprovement).length;
  const atRiskCount = atRisk.length;

  // ── Header ────────────────────────────────────────────────────────────
  const header = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-radius:12px;padding:24px 28px;margin-bottom:20px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <h1 style="margin:0;font-size:22px;color:${COLOR.ink};">📅 ${escapeHtml(APP_NAME)} — MTD Report</h1>
          <p style="margin:4px 0 0;font-size:13px;color:${COLOR.muted};">Fusionmarkets · KYC · ${escapeHtml(data.monthLabel)} (thru ${escapeHtml(data.range.end)})</p>
        </div>
        ${gatePct !== null
          ? `<div style="text-align:right;">
              <p style="margin:0;font-size:11px;color:${COLOR.muted};text-transform:uppercase;letter-spacing:.04em;">Gate</p>
              <p style="margin:2px 0 0;font-size:22px;font-weight:700;color:${GATE_TIER_COLOR[data.gateOverall!.overallTier]};">${gatePct.toFixed(2)}%</p>
            </div>`
          : ""}
      </div>
      <p style="margin:16px 0 0;font-size:11px;color:${COLOR.muted};">
        Generated: <strong style="color:${COLOR.ink};">${escapeHtml(data.generatedLabel)}</strong>
        &nbsp;·&nbsp; Agents ranked: <strong style="color:${COLOR.ink};">${rankable.length}</strong> of ${data.agents.length}
        &nbsp;·&nbsp; QA: <strong style="color:${COLOR.ink};">${data.qaCount}</strong>
        &nbsp;·&nbsp; Penalties: <strong style="color:${COLOR.ink};">${data.penaltyCount}</strong>
      </p>
    </div>`;

  // ── Alerts & Highlights ──────────────────────────────────────────────
  const alertLines: string[] = [];
  if (atRiskCount > 0) {
    alertLines.push(alertRow("danger", `🔴 ${atRiskCount} agent${atRiskCount === 1 ? " is" : "s are"} At Risk this month (below 1.00/3.00).`));
  }
  const topAttention = data.attentionStreaks[0];
  if (topAttention) {
    alertLines.push(alertRow("warning", `⚠️ ${escapeHtml(topAttention.agentName)} has a ${topAttention.length}-day streak below target on ${escapeHtml(topAttention.metricName)}.`));
  }
  const topConsistent = data.consistentStreaks[0];
  if (topConsistent) {
    alertLines.push(alertRow("success", `✅ ⭐ ${escapeHtml(topConsistent.agentName)} has been on target for ${topConsistent.length} consecutive days on ${escapeHtml(topConsistent.metricName)}.`));
  }
  const alertsSection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.danger};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:${COLOR.ink};">⚠️ Alerts &amp; Highlights</p>
      ${alertLines.length ? alertLines.join("") : `<p style="font-size:13px;color:${COLOR.muted};">Nothing to flag this month — no at-risk agents, no active below-target streaks.</p>`}
    </div>`;

  // ── Executive Summary ────────────────────────────────────────────────
  const topPerformers = rankable.slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const topCards = topPerformers
    .map(
      (a, i) => `
      <div style="border:1px solid ${COLOR.border};border-radius:8px;padding:12px 14px;text-align:center;flex:1;min-width:140px;">
        <p style="margin:0;font-size:20px;">${medals[i]}</p>
        <p style="margin:4px 0 0;font-weight:700;color:${COLOR.ink};font-size:13px;">${escapeHtml(a.agent.name)}</p>
        <p style="margin:2px 0 0;font-size:11px;color:${COLOR.muted};">${a.daysLogged} days logged</p>
        <p style="margin:6px 0 0;font-size:16px;font-weight:700;color:${scoreCategory(a.result.individual.finalScore).color};">${a.result.individual.finalScore.toFixed(2)}/3</p>
      </div>`
    )
    .join("");

  const execSummarySection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.primary};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 14px;font-size:15px;font-weight:700;color:${COLOR.ink};">📋 Executive Summary</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px;">
        ${summaryCard("Gate Score MTD", gatePct !== null ? `${gatePct.toFixed(1)}%` : "—", data.gateOverall ? data.gateOverall.overallTier : "No data", gatePct !== null ? GATE_TIER_COLOR[data.gateOverall!.overallTier] : COLOR.muted)}
        ${summaryCard("🔵 Exceptional", String(exceptionalCount), `${rankable.length ? Math.round((exceptionalCount / rankable.length) * 100) : 0}% of ranked`, CATEGORY.exceptional.color)}
        ${summaryCard("On Track", String(almostThereCount + needsImprovementCount), "Almost There + Needs Improvement", CATEGORY.almostThere.color)}
        ${summaryCard("🔴 At Risk", String(atRiskCount), `${rankable.length ? Math.round((atRiskCount / rankable.length) * 100) : 0}% of ranked`, CATEGORY.atRisk.color)}
        ${summaryCard("⭐ Performer Streaks", String(data.consistentStreaks.length), "3+ days on target", "#1b5e20")}
        ${summaryCard("⚠️ Regression Streaks", String(data.attentionStreaks.length), "3+ days below target", "#b71c1c")}
      </div>
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:${COLOR.ink};">🏆 Top Performers</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        ${topCards || `<p style="font-size:12px;color:${COLOR.muted};">No agents have enough data to rank yet this month.</p>`}
      </div>
    </div>`;

  // ── Business Gate — MTD ──────────────────────────────────────────────
  const gateTrendChart = renderMiniLineChart(
    data.gateDaily.map((d) => ({ label: d.label, value: d.scorePct, color: d.scorePct === null ? COLOR.muted : d.scorePct >= 100 ? "#1b5e20" : d.scorePct >= 85 ? "#e65100" : "#b71c1c" })),
    [],
    (v) => `${v.toFixed(0)}%`,
    100
  );

  const gateMetricCards = GATE_METRICS.map((def) => {
    const series = data.gateMetricSeries.find((s) => s.key === def.key)!;
    const latest = [...series.days].reverse().find((d) => d.actual !== null) ?? null;
    const chart = renderMiniLineChart(
      series.days.map((d) => ({ label: d.label, value: d.actual, color: d.tier ? GATE_TIER_COLOR[d.tier] : COLOR.muted })),
      gateBandRects(def.key),
      (v) => formatGateValue(def.unit, v)
    );
    return `
      <div style="border:1px solid ${COLOR.border};border-radius:8px;padding:12px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;">
          <p style="margin:0;font-size:12px;font-weight:700;color:${COLOR.ink};">${escapeHtml(def.name)}</p>
          <span style="font-size:11px;color:${COLOR.muted};">weight ${(def.weight * 100).toFixed(0)}%</span>
        </div>
        <p style="margin:2px 0 8px;font-size:11px;color:${latest?.tier ? GATE_TIER_COLOR[latest.tier] : COLOR.muted};font-weight:600;">${latest ? `${escapeHtml(latest.actualDisplay)} · ${escapeHtml(latest.tier ?? "")}` : "No data"}</p>
        ${chart}
      </div>`;
  }).join("");

  const gateAverageRows = GATE_METRICS.map((def) => {
    const series = data.gateMetricSeries.find((s) => s.key === def.key)!;
    const values = series.days.map((d) => d.actual).filter((v): v is number => v !== null);
    const avg = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
    const m = data.gateOverall?.metrics.find((mm) => mm.key === def.key) ?? null;
    // "vs. Target" compares the MTD Average to the number printed in the Target
    // column right beside it (the Exceptional threshold). It used to show the
    // room left before the metric would tip into Amber (measured from the Green
    // limit), which has nothing to do with the Target column and read as wrong,
    // e.g. "57m 9s under" next to a 1h 2m 51s average and a 1h target.
    const targetValue = def.bands[0]!.max ?? def.bands[0]!.min ?? 0;
    let vsTarget = "—";
    if (avg !== null) {
      const diff = def.direction === "lower-is-better" ? targetValue - avg : avg - targetValue;
      const word = def.direction === "lower-is-better" ? (diff >= 0 ? "under" : "over") : diff >= 0 ? "above" : "below";
      vsTarget = `${formatMagnitude(def.unit, diff)} ${word}`;
    }
    const vsTargetColor = avg === null ? COLOR.muted : (def.direction === "lower-is-better" ? targetValue - avg : avg - targetValue) >= 0 ? "#1b5e20" : "#b71c1c";
    return `<tr style="border-top:1px solid ${COLOR.border};">
      <td style="padding:8px 10px;color:${COLOR.ink};">${escapeHtml(def.name)}</td>
      <td style="padding:8px 10px;color:${COLOR.muted};">${def.direction === "lower-is-better" ? "≤" : "≥"} ${formatGateValue(def.unit, targetValue)}</td>
      <td style="padding:8px 10px;font-weight:600;color:${COLOR.ink};">${avg !== null ? escapeHtml(formatGateValue(def.unit, avg)) : "—"}</td>
      <td style="padding:8px 10px;color:${m?.tier ? GATE_TIER_COLOR[m.tier] : COLOR.muted};font-weight:600;">${m?.tier ?? "—"}</td>
      <td style="padding:8px 10px;color:${vsTargetColor};">${vsTarget}</td>
      <td style="padding:8px 10px;color:${COLOR.muted};">${(def.weight * 100).toFixed(0)}%</td>
    </tr>`;
  }).join("");

  const dailyEntryRows = data.gateDaily
    .map((d) => {
      const metricsRow = GATE_METRICS.map((def) => {
        const series = data.gateMetricSeries.find((s) => s.key === def.key)!;
        const day = series.days.find((x) => x.date === d.date);
        return `<td style="padding:6px 8px;color:${day?.tier ? GATE_TIER_COLOR[day.tier] : COLOR.muted};font-weight:${day?.tier ? "600" : "400"};">${day ? escapeHtml(day.actualDisplay) : "—"}</td>`;
      }).join("");
      return `<tr style="border-top:1px solid ${COLOR.border};">
        <td style="padding:6px 8px;color:${COLOR.ink};font-weight:600;">${escapeHtml(d.label)}</td>
        <td style="padding:6px 8px;font-weight:700;color:${d.scorePct === null ? COLOR.muted : d.scorePct >= 100 ? "#1b5e20" : d.scorePct >= 85 ? "#e65100" : "#b71c1c"};">${d.scorePct !== null ? `${d.scorePct.toFixed(1)}%` : "—"}</td>
        ${metricsRow}
      </tr>`;
    })
    .join("");

  const businessGateSection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.primary};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${COLOR.ink};">🏢 Business Gate — Month-to-Date${renderGateInfoButton()}</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:14px 0 18px;">
        ${summaryCard("MTD Gate Score", gatePct !== null ? `${gatePct.toFixed(2)}%` : "—", data.gateOverall ? data.gateOverall.overallTier : "No data", gatePct !== null ? GATE_TIER_COLOR[data.gateOverall!.overallTier] : COLOR.muted)}
        ${summaryCard("Days Logged", String(data.gateDaysLogged), `of ${data.gateDaily.length} this month`, COLOR.primary)}
      </div>
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COLOR.muted};">Gate Score Trend</p>
      <div style="border:1px solid ${COLOR.border};border-radius:8px;padding:10px 12px;margin-bottom:18px;">${gateTrendChart}</div>
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COLOR.muted};">Metric Overview — Daily Trends</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:18px;">${gateMetricCards}</div>
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COLOR.muted};">Metric Breakdown (MTD Averages)</p>
      <div style="overflow-x:auto;margin-bottom:18px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="text-align:left;color:${COLOR.muted};font-size:11px;text-transform:uppercase;letter-spacing:.03em;">
            <th style="padding:6px 10px;">Metric</th><th style="padding:6px 10px;">Target</th><th style="padding:6px 10px;">MTD Average</th><th style="padding:6px 10px;">Status</th><th style="padding:6px 10px;">vs. Target</th><th style="padding:6px 10px;">Weight</th>
          </tr></thead>
          <tbody>${gateAverageRows}</tbody>
        </table>
      </div>
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COLOR.muted};">Daily Entries</p>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="text-align:left;color:${COLOR.muted};font-size:10px;text-transform:uppercase;letter-spacing:.03em;">
            <th style="padding:6px 8px;">Day</th><th style="padding:6px 8px;">Gate</th>${GATE_METRICS.map((d) => `<th style="padding:6px 8px;">${escapeHtml(GATE_SHORT_LABEL[d.key])}</th>`).join("")}
          </tr></thead>
          <tbody>${dailyEntryRows}</tbody>
        </table>
      </div>
    </div>`;

  const gateReferenceSection = renderGateReference({ gate: data.gateOverall, scope: "month", periodLabel: data.monthLabel });

  // ── Individual Agent Rankings ────────────────────────────────────────
  const gradeDist = [
    { label: "Exceptional", count: exceptionalCount, color: CATEGORY.exceptional.color },
    { label: "Almost There", count: almostThereCount, color: CATEGORY.almostThere.color },
    { label: "Needs Improvement", count: needsImprovementCount, color: CATEGORY.needsImprovement.color },
    { label: "At Risk", count: atRiskCount, color: CATEGORY.atRisk.color },
  ].filter((g) => g.count > 0);
  const distBar = gradeDist
    .map((g) => `<div title="${g.label}: ${g.count}" style="flex:${g.count};background:${g.color}22;color:${g.color};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;">${g.count}</div>`)
    .join("");
  const distLegend = gradeDist.map((g) => `<span style="font-size:10px;color:${g.color};">● ${escapeHtml(g.label)}: ${g.count}</span>`).join("");

  const heatmapRows = rankable
    .map(
      (a) => `<tr>
        <td style="padding:4px 10px;font-size:11px;font-weight:600;white-space:nowrap;color:${COLOR.ink};background:#f9fafb;border:1px solid ${COLOR.border};">${escapeHtml(a.agent.name)}</td>
        <td style="padding:4px 6px;text-align:center;border:1px solid #fff;background:${scoreCategory(a.result.individual.finalScore).color}18;"><span style="font-size:11px;font-weight:700;color:${scoreCategory(a.result.individual.finalScore).color};">${a.result.individual.finalScore.toFixed(2)}</span></td>
        ${INDIVIDUAL_METRICS.map((def) => {
          const m = a.result.individual.metrics.find((x) => x.key === def.key);
          const grade = m && !m.excluded ? m.grade : null;
          return `<td style="padding:4px 6px;text-align:center;border:1px solid #fff;background:${grade !== null ? GRADE_COLOR[grade] + "18" : "#f3f4f6"};" title="${escapeHtml(def.name)}${grade !== null ? `: ${m!.gradeLabel}` : ": No data"}"><span style="color:${grade !== null ? GRADE_COLOR[grade] : COLOR.muted};font-size:12px;">${grade !== null ? GRADE_DOT[grade] : "—"}</span></td>`;
        }).join("")}
      </tr>`
    )
    .join("");

  const departments = [...new Set(rankable.map((a) => a.agent.department))];
  const departmentTables = departments
    .map((dept) => {
      const inDept = rankable.filter((a) => a.agent.department === dept);
      const rows = inDept
        .map((a, i) => {
          const score = a.result.individual.finalScore;
          const cat = scoreCategory(score);
          const metricCells = INDIVIDUAL_METRICS.map((def) => {
            const m = a.result.individual.metrics.find((x) => x.key === def.key);
            if (!m || m.excluded || m.actual === null) return `<td style="padding:6px;text-align:center;color:${COLOR.muted};">—</td>`;
            const gc = m.grade !== null ? GRADE_COLOR[m.grade] : COLOR.muted;
            return `<td style="padding:6px;text-align:center;color:${gc};">${escapeHtml(m.actualDisplay)}<div style="font-size:9px;font-weight:600;margin-top:1px;">${escapeHtml(m.gradeLabel)}</div></td>`;
          }).join("");
          const disciplinary = a.result.individual.disciplinaryTotal;
          const attendance = a.result.individual.attendanceTotal;
          return `<tr style="${i % 2 === 1 ? `background:#fafafa;` : ""}border-top:1px solid ${COLOR.border};">
            <td style="padding:6px;text-align:center;"><span style="background:${i === 0 ? "#d4a017" : i === 1 ? "#a0a0a0" : i === 2 ? "#b87333" : "#e5e7eb"};color:${i < 3 ? "#fff" : COLOR.ink};border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${i + 1}</span></td>
            <td style="padding:6px 10px;font-weight:600;color:${COLOR.ink};">${escapeHtml(a.agent.name)}<div style="font-size:10px;color:${COLOR.muted};font-weight:400;">${a.daysLogged} days logged</div></td>
            <td style="padding:6px;text-align:center;font-weight:700;color:${cat.color};">${score.toFixed(2)}/3</td>
            <td style="padding:6px;text-align:center;"><span style="background:${cat.color}18;color:${cat.color};border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;">${escapeHtml(cat.label)}</span></td>
            ${metricCells}
            <td style="padding:6px;text-align:center;color:${disciplinary > 0 ? COLOR.danger : COLOR.muted};">${disciplinary > 0 ? `-${disciplinary.toFixed(2)}` : "—"}</td>
            <td style="padding:6px;text-align:center;color:${attendance > 0 ? COLOR.danger : COLOR.muted};">${attendance > 0 ? `-${attendance.toFixed(2)}` : "—"}</td>
          </tr>`;
        })
        .join("");
      return `
        <div style="margin-bottom:22px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <span style="background:${COLOR.primary}18;color:${COLOR.primary};border-radius:20px;padding:3px 12px;font-size:11px;font-weight:700;letter-spacing:.4px;">${escapeHtml(dept)}</span>
            <span style="font-size:11px;color:${COLOR.muted};">${inDept.length} agent${inDept.length === 1 ? "" : "s"}</span>
          </div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead><tr style="text-align:center;color:${COLOR.muted};font-size:10px;text-transform:uppercase;letter-spacing:.03em;">
                <th style="padding:6px;width:32px;">#</th><th style="padding:6px;text-align:left;">Agent</th><th style="padding:6px;">Score</th><th style="padding:6px;">Grade</th>
                ${INDIVIDUAL_METRICS.map((d) => `<th style="padding:6px;">${escapeHtml(METRIC_SHORT_LABEL[d.key])}</th>`).join("")}
                <th style="padding:6px;">Disciplinary</th><th style="padding:6px;">Attendance</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    })
    .join("");

  const noDataAgents = data.agents.filter((a) => !a.rankable);
  const noDataRows = noDataAgents
    .map((a) => `<tr style="border-top:1px solid ${COLOR.border};color:${COLOR.muted};"><td style="padding:6px 10px;">${escapeHtml(a.agent.name)}</td><td style="padding:6px 10px;font-style:italic;">${a.daysLogged > 0 ? "Insufficient data" : "No data yet"}</td></tr>`)
    .join("");

  const agentRankingsSection = `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.success};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${COLOR.ink};">👥 Individual Agent Rankings</p>
      <p style="margin:0 0 16px;font-size:12px;color:${COLOR.muted};">${rankable.length} agent${rankable.length === 1 ? "" : "s"} · ${escapeHtml(data.monthLabel)}</p>
      ${gradeDist.length ? `
        <p style="margin:0 0 7px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${COLOR.muted};">Grade Distribution</p>
        <div style="display:flex;height:26px;border-radius:8px;overflow:hidden;border:1px solid ${COLOR.border};margin-bottom:6px;">${distBar}</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px;">${distLegend}</div>
      ` : ""}
      <p style="margin:0 0 7px;font-size:13px;font-weight:700;color:${COLOR.ink};">KPI Heatmap — At a Glance</p>
      <div style="font-size:10px;color:${COLOR.muted};margin-bottom:8px;">● Exceptional/On Target &nbsp;|&nbsp; ◑ Below Target &nbsp;|&nbsp; ○ Failing</div>
      <div style="overflow-x:auto;margin-bottom:22px;">
        <table style="border-collapse:collapse;font-size:11px;width:100%;">
          <thead><tr>
            <th style="padding:4px 10px;background:#f3f4f6;font-size:9px;font-weight:700;color:${COLOR.muted};border:1px solid ${COLOR.border};white-space:nowrap;text-align:left;">Agent</th>
            <th style="padding:4px 6px;background:#f3f4f6;font-size:9px;font-weight:700;color:${COLOR.muted};border:1px solid ${COLOR.border};">Score</th>
            ${INDIVIDUAL_METRICS.map((d) => `<th style="padding:4px 6px;background:#f3f4f6;font-size:9px;font-weight:700;color:${COLOR.muted};border:1px solid ${COLOR.border};white-space:nowrap;">${escapeHtml(METRIC_SHORT_LABEL[d.key])}</th>`).join("")}
          </tr></thead>
          <tbody>${heatmapRows}</tbody>
        </table>
      </div>
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:${COLOR.ink};">Rankings by Department</p>
      ${departmentTables || `<p style="font-size:12px;color:${COLOR.muted};">No agents have enough data to rank yet.</p>`}
      ${noDataAgents.length ? `
        <p style="margin:6px 0 6px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${COLOR.muted};">Not yet ranked (insufficient data)</p>
        <table style="width:100%;border-collapse:collapse;font-size:12px;"><tbody>${noDataRows}</tbody></table>
      ` : ""}
    </div>`;

  // ── Month-over-Month ─────────────────────────────────────────────────
  let momSection = "";
  if (data.mom) {
    const rows = data.mom.rows
      .filter((r) => !r.excludedFromComparison)
      .map((r) => ({ ...r, delta: r.currentScore! - r.prevScore! }))
      .sort((a, b) => b.delta - a.delta);
    const excluded = data.mom.rows.filter((r) => r.excludedFromComparison);
    const improved = rows.filter((r) => r.delta > 0.005).length;
    const regressed = rows.filter((r) => r.delta < -0.005).length;
    const maintained = rows.length - improved - regressed;
    const total = rows.length || 1;
    const momRows = rows
      .map((r, i) => {
        const status = r.delta > 0.005 ? { label: "▲ Improved", color: "#1b5e20" } : r.delta < -0.005 ? { label: "▼ Regressed", color: "#b71c1c" } : { label: "→ Maintained", color: "#6b7280" };
        return `<tr style="${i % 2 === 1 ? "background:#fafafa;" : ""}border-top:1px solid ${COLOR.border};">
          <td style="padding:6px 10px;color:${COLOR.muted};font-size:12px;">${i + 1}</td>
          <td style="padding:6px 10px;font-weight:600;color:${COLOR.ink};">${escapeHtml(r.agent.name)}</td>
          <td style="padding:6px 10px;text-align:center;">${escapeHtml(r.agent.department)}</td>
          <td style="padding:6px 10px;text-align:center;font-weight:700;color:${scoreCategory(r.prevScore!).color};">${r.prevScore!.toFixed(2)}<div style="font-size:9px;font-weight:500;">${scoreCategory(r.prevScore!).label}</div></td>
          <td style="padding:6px 10px;text-align:center;font-weight:700;color:${scoreCategory(r.currentScore!).color};">${r.currentScore!.toFixed(2)}<div style="font-size:9px;font-weight:500;">${scoreCategory(r.currentScore!).label}</div></td>
          <td style="padding:6px 10px;text-align:center;font-weight:800;color:${status.color};">${r.delta > 0.005 ? "▲" : r.delta < -0.005 ? "▼" : "→"} ${r.delta === 0 ? "±0.00" : `${r.delta > 0 ? "+" : ""}${r.delta.toFixed(2)}`}</td>
          <td style="padding:6px 10px;text-align:center;"><span style="background:${status.color}18;color:${status.color};border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;">${status.label}</span></td>
        </tr>`;
      })
      .join("");
    momSection = `
      <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid #6b46c1;border-radius:10px;padding:20px 22px;margin-bottom:20px;">
        <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${COLOR.ink};">📊 Month-over-Month Score Comparison</p>
        <p style="margin:0 0 14px;font-size:12px;color:${COLOR.muted};">${escapeHtml(data.mom.prevMonthLabel)} final vs ${escapeHtml(data.monthLabel)} MTD &nbsp;·&nbsp; ${rows.length} agents compared</p>
        <div style="display:flex;height:12px;border-radius:8px;overflow:hidden;margin-bottom:8px;border:1px solid ${COLOR.border};">
          <div style="flex:${improved || 0.0001};background:#22c55e;" title="Improved: ${improved}"></div>
          <div style="flex:${maintained || 0.0001};background:#d1d5db;" title="Maintained: ${maintained}"></div>
          <div style="flex:${regressed || 0.0001};background:#ef4444;" title="Regressed: ${regressed}"></div>
        </div>
        <div style="display:flex;gap:20px;font-size:11px;font-weight:700;flex-wrap:wrap;margin-bottom:18px;">
          <span style="color:#16a34a;">▲ ${improved} improved (${Math.round((improved / total) * 100)}%)</span>
          <span style="color:#6b7280;">→ ${maintained} maintained (${Math.round((maintained / total) * 100)}%)</span>
          <span style="color:#dc2626;">▼ ${regressed} regressed (${Math.round((regressed / total) * 100)}%)</span>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="text-align:left;color:${COLOR.muted};font-size:10px;text-transform:uppercase;letter-spacing:.03em;">
              <th style="padding:6px 10px;width:28px;">#</th><th style="padding:6px 10px;">Agent</th><th style="padding:6px 10px;text-align:center;">Dept</th>
              <th style="padding:6px 10px;text-align:center;">${escapeHtml(data.mom.prevMonthLabel)}</th><th style="padding:6px 10px;text-align:center;">${escapeHtml(data.monthLabel)} MTD</th>
              <th style="padding:6px 10px;text-align:center;">Change</th><th style="padding:6px 10px;text-align:center;">Status</th>
            </tr></thead>
            <tbody>${momRows}</tbody>
          </table>
        </div>
        ${excluded.length ? `<p style="font-size:10px;color:${COLOR.muted};margin-top:10px;">${excluded.length} agent${excluded.length === 1 ? "" : "s"} excluded from comparison (no ${escapeHtml(data.mom.prevMonthLabel)} data): ${excluded.map((r) => escapeHtml(r.agent.name)).join(", ")}.</p>` : ""}
      </div>`;
  }

  // ── Consistent Performers / Agents Needing Attention ────────────────
  const consistentSection = renderStreakSection("⭐ Consistent Performers", "Agents with 3+ consecutive on-target days (Recognition candidates)", data.consistentStreaks, "#1b5e20", "#dcfce7");
  const attentionSection = renderStreakSection("⚠️ Agents Needing Attention", "Agents with 3+ consecutive below-target days (Performance Reminder candidates)", data.attentionStreaks, "#b71c1c", "#fee2e2");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(APP_NAME)} — MTD Report — ${escapeHtml(data.monthLabel)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Inter,system-ui,-apple-system,sans-serif;color:${COLOR.ink};">
  <div style="max-width:980px;margin:0 auto;padding:32px 24px 60px;">
    ${header}
    ${alertsSection}
    ${execSummarySection}
    ${renderTeamQualitySection(data.teamQuality, "this month")}
    ${renderAgentQualityPenaltySection(data.currentDataset.results, "this month")}
    ${businessGateSection}
    ${gateReferenceSection}
    ${agentRankingsSection}
    ${momSection}
    ${consistentSection}
    ${attentionSection}
    <p style="text-align:center;font-size:11px;color:${COLOR.muted};margin-top:8px;">Generated by ${escapeHtml(APP_NAME)} · MTD Report · ${escapeHtml(data.generatedLabel)}</p>
  </div>
</body>
</html>`;
}

function summaryCard(label: string, value: string, note: string, color: string): string {
  return `<div style="border-left:4px solid ${color};background:${color}0d;border-radius:8px;padding:10px 12px;">
    <p style="margin:0;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:${COLOR.muted};">${escapeHtml(label)}</p>
    <p style="margin:3px 0 0;font-size:22px;font-weight:700;color:${color};">${escapeHtml(value)}</p>
    <p style="margin:2px 0 0;font-size:10px;color:${color};">${escapeHtml(note)}</p>
  </div>`;
}

function alertRow(tone: "danger" | "warning" | "success", text: string): string {
  const bg = tone === "danger" ? "#fee2e2" : tone === "warning" ? "#fef3c7" : "#dcfce7";
  const color = tone === "danger" ? "#b71c1c" : tone === "warning" ? "#92400e" : "#1b5e20";
  return `<div style="background:${bg};color:${color};border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:13px;font-weight:600;">${text}</div>`;
}

function renderStreakSection(title: string, subtitle: string, streaks: MtdStreak[], color: string, bg: string): string {
  if (streaks.length === 0) return "";
  const byMetric = new Map<string, MtdStreak[]>();
  for (const s of streaks) {
    const list = byMetric.get(s.metricName) ?? [];
    list.push(s);
    byMetric.set(s.metricName, list);
  }
  const groups = [...byMetric.entries()]
    .map(([metricName, list]) => {
      const rows = list
        .map(
          (s) => `<tr style="border-top:1px solid ${COLOR.border};">
        <td style="padding:8px 10px;font-weight:600;color:${COLOR.ink};">${escapeHtml(s.agentName)}</td>
        <td style="padding:8px 10px;text-align:center;"><span style="background:${bg};color:${color};border:1px solid ${color}33;border-radius:20px;padding:2px 9px;font-size:10px;font-weight:700;">${s.length} days</span></td>
        <td style="padding:8px 10px;text-align:center;font-weight:700;color:${color};">${escapeHtml(s.latestDisplay)}</td>
        <td style="padding:8px 10px;text-align:center;color:#888;">${escapeHtml(s.target)}</td>
        <td style="padding:8px 10px;color:#777;font-size:11px;">${escapeHtml(s.periodLabel)}</td>
        <td style="padding:8px 10px;color:#888;font-size:11px;">${s.recentValues.map(escapeHtml).join(", ")}</td>
        <td style="padding:8px 10px;">${renderSparkline(s.sparklineValues, color)}</td>
      </tr>`
        )
        .join("");
      return `
        <div style="margin-bottom:20px;">
          <div style="font-size:12px;font-weight:700;color:${color};margin-bottom:8px;padding:4px 12px;background:${bg};border-radius:6px;display:inline-block;">${escapeHtml(metricName)}</div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead><tr style="text-align:left;color:${COLOR.muted};font-size:10px;text-transform:uppercase;letter-spacing:.03em;">
                <th style="padding:6px 10px;">Agent</th><th style="padding:6px 10px;text-align:center;">Streak</th><th style="padding:6px 10px;text-align:center;">Latest</th><th style="padding:6px 10px;text-align:center;">Target</th><th style="padding:6px 10px;">Period</th><th style="padding:6px 10px;">Recent Values</th><th style="padding:6px 10px;">Trend</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    })
    .join("");

  return `
    <div style="background:#fff;border:1px solid ${COLOR.border};border-left:4px solid ${color};border-radius:10px;padding:20px 22px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${COLOR.ink};">${title}</p>
      <p style="margin:0 0 16px;font-size:12px;color:${COLOR.muted};">${subtitle}</p>
      ${groups}
    </div>`;
}
