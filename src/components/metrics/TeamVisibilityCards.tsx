import { AlertTriangle, CheckCircle2, HelpCircle, ShieldCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricBlockCard } from "@/components/metrics/MetricBlockCard";
import type { Tone } from "@/components/dashboard/PerformanceBadge";
import type { RejectionQualityState } from "@/lib/rejections/rejectionQuality";

// Color of the Team QA Average. Display only: it never feeds the Business
// Gate or any score. 90% and above is green, 80% up to (not including) 90% is
// amber, below 80% is red. The check uses the same one-decimal number that is
// shown on the card, so 89.9% reads amber and 90.0% reads green.
export const QUALITY_GREEN_MIN = 90;
export const QUALITY_AMBER_MIN = 80;

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
 * Team QA Average, Rejection Quality and Team Rejection Rate, side by side.
 *
 * All three are here for visibility only: none is a Business Gate metric, so
 * none has a weight and none changes the Gate multiplier or any score.
 *  - Team QA Average: the average of every agent's QA Audit score for the
 *    period on screen. Color-coded (green 90%+, amber 80% to under 90%, red
 *    under 80%).
 *  - Rejection Quality: read from the Rejection Audit Tracker app. No color.
 *  - Team Rejection Rate: typed in by hand in Data Import. No color.
 * Used on the Dashboard, Team Performance and Overall MTD.
 */
export function TeamVisibilityCards({
  periodNoun,
  qaAveragePct,
  qaAgentCount,
  rejectionQualityPct,
  rejectionQualityState,
  rejectionRatePct,
}: {
  /** "this week", "this month" -- how the period is worded under each figure. */
  periodNoun: string;
  qaAveragePct: number | null;
  qaAgentCount: number;
  rejectionQualityPct: number | null;
  rejectionQualityState: RejectionQualityState;
  rejectionRatePct: number | null;
}) {
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            label="Rejection Quality"
            value={rejectionQualityPct === null ? "\u2014" : `${rejectionQualityPct.toFixed(1)}%`}
            tone="muted"
            badge={<Badge variant="outline">Rejection Audit Tracker</Badge>}
            weightLabel={
              rejectionQualityState === "ok"
                ? `From the Rejection Audit Tracker, ${periodNoun}`
                : rejectionQualityState === "not_configured"
                  ? "Not connected to the Rejection Audit Tracker yet"
                  : "Couldn\u2019t reach the Rejection Audit Tracker"
            }
            tooltip="Read from the separate Rejection Audit Tracker app for the same period shown on this page. It is not a Business Gate metric and does not change any score."
            emphasized
          />
          <MetricBlockCard
            label="Team Rejection Rate"
            value={rejectionRatePct === null ? "\u2014" : `${rejectionRatePct.toFixed(2)}%`}
            tone="muted"
            badge={<Badge variant="outline">Visibility only</Badge>}
            weightLabel={rejectionRatePct === null ? `No rejection rate entered ${periodNoun} yet` : `Average of the daily figures entered ${periodNoun}`}
            tooltip="Typed in by hand each day in Data Import, Manual Entry. A week or month is the plain average of the days that have a figure."
            emphasized
          />
        </div>
      </CardContent>
    </Card>
  );
}
