import { AlertTriangle, CheckCircle2, HelpCircle, ShieldCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricBlockCard } from "@/components/metrics/MetricBlockCard";
import type { Tone } from "@/components/dashboard/PerformanceBadge";
import type { RejectionQualityState } from "@/lib/rejections/rejectionQuality";
import { QUALITY_GREEN_MIN, QUALITY_AMBER_MIN, REJECTION_QUALITY_PASSING_MARK } from "@/lib/qa/qualityMarks";

// Display only: the marks live in qualityMarks.ts so the exported reports use
// the same ones. They never feed the Business Gate or any score.

function qualityTone(pct: number | null): Tone {
  if (pct === null) return "muted";
  if (pct >= QUALITY_GREEN_MIN) return "success";
  if (pct >= QUALITY_AMBER_MIN) return "warning";
  return "danger";
}

function QualityBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <Badge variant="outline">
        <HelpCircle className="h-3 w-3" /> No Data
      </Badge>
    );
  }
  if (pct >= QUALITY_GREEN_MIN) {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" /> Green
      </Badge>
    );
  }
  if (pct >= QUALITY_AMBER_MIN) {
    return (
      <Badge variant="warning">
        <AlertTriangle className="h-3 w-3" /> Amber
      </Badge>
    );
  }
  return (
    <Badge variant="danger">
      <XCircle className="h-3 w-3" /> Red
    </Badge>
  );
}

/**
 * Team QA Average and Rejection Quality / Markdown Percentage, side by side.
 *
 * Both are here for visibility only: neither is a Business Gate metric, so
 * neither has a weight and neither changes the Gate multiplier or any score.
 *  - Team QA Average: the average of every agent's QA Audit score for the
 *    period on screen. Color-coded (green 90%+, amber 80% to under 90%, red
 *    under 80%).
 *  - Rejection Quality / Markdown Percentage: read from the Rejection Audit
 *    Tracker app. Passing mark 95%: green at or above it, red below it.
 * Used on the Dashboard, Team Performance and Overall MTD.
 */
export function TeamVisibilityCards({
  periodNoun,
  qaAveragePct,
  qaAgentCount,
  rejectionQualityPct,
  rejectionQualityState,
}: {
  /** "this week", "this month" -- how the period is worded under each figure. */
  periodNoun: string;
  qaAveragePct: number | null;
  qaAgentCount: number;
  rejectionQualityPct: number | null;
  rejectionQualityState: RejectionQualityState;
  /** No longer shown. Kept optional so existing pages that still pass it compile. */
  rejectionRatePct?: number | null;
}) {
  const rejectionPassing = rejectionQualityPct !== null && rejectionQualityPct >= REJECTION_QUALITY_PASSING_MARK;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Team Quality &amp; Rejection
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
        </CardTitle>
        <CardDescription>Shown for visibility only. These are not part of the Business Gate and do not change any score.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MetricBlockCard
            label="Team QA Average"
            value={qaAveragePct === null ? "\u2014" : `${qaAveragePct.toFixed(1)}%`}
            tone={qualityTone(qaAveragePct)}
            badge={<QualityBadge pct={qaAveragePct} />}
            weightLabel={
              qaAveragePct === null
                ? `No QA scores recorded ${periodNoun} yet`
                : `Average of ${qaAgentCount} agent${qaAgentCount === 1 ? "" : "s"}\u2019 QA scores ${periodNoun}`
            }
            tooltip="The average of each agent's QA Audit score for the period on screen, the same QA figure shown on each Individual Scorecard. Each agent counts once; an agent with no QA score is left out. Green is 90% and above, Amber is 80% up to under 90%, Red is under 80%."
            emphasized
          />
          <MetricBlockCard
            label="Rejection Quality/Markdown Percentage"
            value={rejectionQualityPct === null ? "\u2014" : `${rejectionQualityPct.toFixed(1)}%`}
            tone={rejectionQualityPct === null ? "muted" : rejectionPassing ? "success" : "danger"}
            badge={
              rejectionQualityPct === null ? (
                <Badge variant="outline">Rejection Audit Tracker</Badge>
              ) : rejectionPassing ? (
                <Badge variant="success">
                  <CheckCircle2 className="h-3 w-3" /> Passing
                </Badge>
              ) : (
                <Badge variant="danger">
                  <XCircle className="h-3 w-3" /> Below passing mark
                </Badge>
              )
            }
            weightLabel={
              rejectionQualityState === "ok"
                ? `Passing mark ${REJECTION_QUALITY_PASSING_MARK}% \u00b7 from the Rejection Audit Tracker, ${periodNoun}`
                : rejectionQualityState === "no_data"
                  ? `No audited items in the tracker ${periodNoun} yet`
                  : rejectionQualityState === "not_configured"
                  ? "Not connected to the Rejection Audit Tracker yet"
                  : "Couldn\u2019t reach the Rejection Audit Tracker"
            }
            tooltip={`Read from the separate Rejection Audit Tracker app for the same period shown on this page: the share of audited rejections with no markdown (incorrect rejection, inaccurate reason or inaccurate email template). Passing mark is ${REJECTION_QUALITY_PASSING_MARK}%. It is not a Business Gate metric and does not change any score.`}
            emphasized
          />
        </div>
      </CardContent>
    </Card>
  );
}
