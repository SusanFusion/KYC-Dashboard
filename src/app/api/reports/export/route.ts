import { NextResponse } from "next/server";
import { loadPeriodDataset, loadRangeDataset, listAvailableWeeks, type RangeSpec } from "@/lib/data/query";
import { getRepository, type DataRepository } from "@/lib/data/repository";
import { formatWeekLabel } from "@/lib/data/dateRanges";
import { generatePeriodReportHtml } from "@/lib/reports/generateReportHtml";
import { generateWeeklyReportHtml, type WeeklyReportWeekData } from "@/lib/reports/weeklyReportHtml";
import { generateMtdReportHtml } from "@/lib/reports/mtdReportHtml";
import { loadMtdReportData } from "@/lib/data/mtdReportData";
import { computeTeamQaAverage } from "@/lib/qa/teamQaAverage";
import { loadRejectionQuality } from "@/lib/rejections/rejectionQuality";
import { requireActionAccess } from "@/lib/auth/actionAccess";
import { APP_NAME } from "@/lib/appConfig";
import { slugify } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Serves a downloadable, self-contained HTML report (inline CSS only, no
 * external requests) so it opens correctly as an email attachment or a
 * standalone double-clicked file. `?type=` selects which report:
 *   - "weekly" (default, see reports/page.tsx's Weekly Report card) — the
 *     week-on-week Business Gate / Agent Scoreboard / Movement Table /
 *     Coach Watch report (weeklyReportHtml.ts). `?week=` is that week's
 *     Sunday start date (YYYY-MM-DD); omitted, defaults to the most
 *     recently imported week.
 *   - "snapshot" — the original single-period outlier-flagged summary
 *     (generateReportHtml.ts), kept for any existing link/bookmark that
 *     still points at this route without a `type`.
 *   - "mtd" (see reports/page.tsx's MTD Report card) — the full
 *     Month-to-Date report: alerts, executive summary, Business Gate MTD
 *     trend charts, Individual Agent Rankings (KPI heatmap + per-department
 *     tables), a Month-over-Month score comparison against the prior
 *     calendar month, and Consistent Performers / Agents Needing Attention
 *     streak tables (mtdReportHtml.ts / mtdReportData.ts). `?month=` is
 *     that month's "YYYY-MM" key; omitted, defaults to the most recently
 *     imported month.
 */
export async function GET(request: Request) {
  const denied = await requireActionAccess();
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? "weekly";

  if (type === "snapshot") {
    const periodId = searchParams.get("periodId") ?? undefined;
    const dataset = await loadPeriodDataset(periodId);
    // Used to key QA Audit restriction off the signed-in user's role — see
    // the note this line originally shipped with, still accurate: this
    // whole route already requires the shared Lead/Manager action
    // password (requireActionAccess above), so nothing further is
    // restricted once past it.
    const html = generatePeriodReportHtml(dataset, { restrictQaAudit: false });
    const slug = slugify(dataset.period?.label ?? "report");
    return htmlResponse(html, `kyc-performance-report-${slug || "snapshot"}.html`);
  }

  if (type === "mtd") {
    const monthParam = searchParams.get("month") ?? undefined;
    const data = await loadMtdReportData(monthParam);
    if (!data) {
      return htmlResponse(noDataHtml("MTD"), "kyc-mtd-report.html");
    }
    const html = generateMtdReportHtml(data);
    const slug = slugify(data.monthLabel);
    return htmlResponse(html, `kyc-mtd-report-${slug || "report"}.html`);
  }

  // type === "weekly" (also the fallback for any unrecognized value)
  const weeks = await listAvailableWeeks();
  if (weeks.length === 0) {
    return htmlResponse(noDataHtml("Weekly"), "kyc-weekly-report.html");
  }

  const weekParam = searchParams.get("week");
  const selectedIndex = weekParam ? weeks.findIndex((w) => w.start === weekParam) : 0;
  const thisWeekOpt = weeks[selectedIndex >= 0 ? selectedIndex : 0]!;
  const lastWeekOpt = weeks[(selectedIndex >= 0 ? selectedIndex : 0) + 1];

  const repo = await getRepository();
  const [thisWeekData, lastWeekData] = await Promise.all([
    buildWeekData(thisWeekOpt.start, thisWeekOpt.end, repo),
    lastWeekOpt ? buildWeekData(lastWeekOpt.start, lastWeekOpt.end, repo) : Promise.resolve(null),
  ]);

  const html = generateWeeklyReportHtml(thisWeekData, lastWeekData);
  const slug = slugify(thisWeekData.label);
  return htmlResponse(html, `kyc-weekly-report-${slug}.html`);
}

async function buildWeekData(start: string, end: string, repo: DataRepository): Promise<WeeklyReportWeekData> {
  const spec: RangeSpec = {
    start,
    end,
    label: `Week of ${start}`,
    id: `week-${start}`,
    type: "weekly",
  };
  const [dataset, allPenalties, allQaAudits, rejection] = await Promise.all([
    loadRangeDataset(spec),
    repo.getPenalties(),
    repo.getQaAudits(),
    loadRejectionQuality({ start, end }),
  ]);
  const penaltyCount = allPenalties
    .filter((p) => p.occurredOn >= start && p.occurredOn <= end)
    .reduce((sum, p) => sum + p.count, 0);
  const qaCount = allQaAudits.filter((a) => a.auditDate >= start && a.auditDate <= end).length;

  return {
    range: { start, end },
    label: formatWeekLabel({ start, end }),
    dataset,
    penaltyCount,
    qaCount,
    teamQuality: { qa: computeTeamQaAverage(dataset.results), rejection },
  };
}

function htmlResponse(html: string, filename: string): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function noDataHtml(reportName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME} — ${reportName} Report</title></head>
    <body style="font-family:Inter,system-ui,sans-serif;padding:40px;color:#222"><h1>${APP_NAME} — ${reportName} Report</h1>
    <p>No performance data has been imported yet.</p></body></html>`;
}
