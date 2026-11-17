// Team QA Average: the average of every agent's own QA Audit score for the
// period on screen, as a percentage.
//
// It is the same per-agent QA figure shown on each Individual Scorecard (the
// "QA Audit" column), averaged across the agents who have one. Each agent
// counts once, however many audits they had, and an agent with no QA score
// for the period is left out rather than counted as 0.
//
// Shown on the Dashboard, Team Performance and Overall MTD for visibility
// only. It is not a Business Gate metric and never changes the Gate
// multiplier or any agent's score.

import type { IndividualScoreResult } from "@/lib/scoring/types";

export interface TeamQaAverage {
  /** Average of the agents' QA scores, one decimal; null when no agent has one. */
  averagePct: number | null;
  /** How many agents the average is built from. */
  agentCount: number;
}

export function computeTeamQaAverage(results: { individual: Pick<IndividualScoreResult, "metrics"> }[]): TeamQaAverage {
  const scores: number[] = [];
  for (const r of results) {
    const qa = r.individual.metrics.find((m) => m.key === "qaAudit")?.actual;
    if (typeof qa === "number" && Number.isFinite(qa)) scores.push(qa);
  }
  if (scores.length === 0) return { averagePct: null, agentCount: 0 };
  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return { averagePct: Math.round(average * 10) / 10, agentCount: scores.length };
}
