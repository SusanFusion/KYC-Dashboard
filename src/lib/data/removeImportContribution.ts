// Deleting one import that shares a day (a period) with other imports.
//
// A period normally belongs to a single import, and deleting that import
// deletes the whole day. But a PDF import and a Manual Entry can be merged
// onto the same day, and then deleting one of them used to remove only its
// history record and leave every number it had written behind. This removes
// what the deleted import itself wrote, and nothing else:
//
//  - Every agent metric the import wrote goes back to what the newest OTHER
//    import on that day wrote for the same agent and metric, or to empty when
//    no other import wrote it.
//  - Business Gate numbers typed in by a Manual Entry are handled the same
//    way. A PDF import's two Gate numbers (Chat Team Avg Response and Team
//    Ticket Resolution Time) are not stored row by row, so they are cleared
//    unless another import on that day could have supplied them.
//  - Everything written by the other imports on the day, and every penalty,
//    is left alone. An import that was itself a "Manual clear" only wrote
//    blanks, so deleting it changes no values.

import type { DataRepository } from "./repository";
import type { ImportRecord, ImportRow, Period } from "@/types/domain";
import type { RawAgentMetrics, RawGateMetrics } from "@/lib/scoring/types";

const AGENT_FIELDS = [
  "totalChatConversations",
  "avgFirstResponseTimeSec",
  "avgResponseTimeSec",
  "emailAHTSec",
  "appAHTSec",
  "totalChats",
  "csatCount",
  "dsatCount",
  "qaAuditPct",
  "emailTicketCount",
] as const;

const GATE_FIELDS = ["clientAvgWaitTimeMin", "teamProcessingTimeMin", "chatTeamAvgResponseSec", "teamTicketAHTMin", "teamRejectionRatePct"] as const;
type GateField = (typeof GATE_FIELDS)[number];

// What a PDF import writes to the Business Gate.
const PDF_GATE_FIELDS: GateField[] = ["chatTeamAvgResponseSec", "teamTicketAHTMin"];

const isAgentField = (k: string): k is (typeof AGENT_FIELDS)[number] => (AGENT_FIELDS as readonly string[]).includes(k);
const isGateField = (k: string): k is GateField => (GATE_FIELDS as readonly string[]).includes(k);
const isManualClear = (imp: ImportRecord) => imp.fileName.startsWith("Manual clear");
const isManualEntry = (imp: ImportRecord) => imp.fileName === "Manual entry";

export interface RemoveContributionResult {
  /** How many agent-metric values were removed or put back to another import's value. */
  agentValuesChanged: number;
  /** How many Business Gate numbers were removed or put back to another import's value. */
  gateValuesChanged: number;
}

type SiblingWithRows = { record: ImportRecord; rows: ImportRow[] };

/** The value the newest other import wrote for one agent metric, if any import did. */
function siblingAgentValue(siblings: SiblingWithRows[], agentId: string, key: string): { found: boolean; value: number | null } {
  for (let i = siblings.length - 1; i >= 0; i -= 1) {
    const s = siblings[i]!;
    for (const row of s.rows) {
      if (row.matchedAgentId !== agentId || row.metricKey !== key) continue;
      if (isManualClear(s.record)) return { found: true, value: null };
      if (row.status !== "failed" && row.parsedValue !== null) return { found: true, value: row.parsedValue };
    }
  }
  return { found: false, value: null };
}

/** Same, for a Business Gate number typed in by a Manual Entry or blanked by a Manual clear. */
function siblingGateValue(siblings: SiblingWithRows[], key: string): { found: boolean; value: number | null } {
  for (let i = siblings.length - 1; i >= 0; i -= 1) {
    const s = siblings[i]!;
    for (const row of s.rows) {
      if (row.matchedAgentId !== null || row.metricKey !== key) continue;
      if (isManualClear(s.record)) return { found: true, value: null };
      if (row.parsedValue !== null) return { found: true, value: row.parsedValue };
    }
  }
  return { found: false, value: null };
}

export async function removeImportContribution(
  repo: DataRepository,
  record: ImportRecord,
  siblingRecords: ImportRecord[],
  period: Period
): Promise<RemoveContributionResult> {
  const result: RemoveContributionResult = { agentValuesChanged: 0, gateValuesChanged: 0 };
  // A Manual clear only ever wrote blanks: nothing of its own to take back.
  if (isManualClear(record)) return result;

  const orderedSiblings = [...siblingRecords].sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : a.uploadedAt > b.uploadedAt ? 1 : 0));
  const siblings: SiblingWithRows[] = await Promise.all(
    orderedSiblings.map(async (s) => ({ record: s, rows: await repo.getImportRows(s.id) }))
  );
  const ownRows = await repo.getImportRows(record.id);

  // --- Agent metrics ------------------------------------------------------
  const metrics = await repo.getRawMetrics(period.id);
  const byAgent = new Map<string, RawAgentMetrics>(metrics.map((m) => [m.agentId, { ...m }]));
  const touchedAgents = new Set<string>();

  for (const row of ownRows) {
    if (!row.matchedAgentId || row.status === "failed" || row.parsedValue === null) continue;
    if (!isAgentField(row.metricKey)) continue;
    const entry = byAgent.get(row.matchedAgentId);
    if (!entry) continue;
    const replacement = siblingAgentValue(siblings, row.matchedAgentId, row.metricKey);
    const next = replacement.found ? replacement.value : null;
    if (entry[row.metricKey] !== next) {
      entry[row.metricKey] = next;
      result.agentValuesChanged += 1;
    }
    touchedAgents.add(row.matchedAgentId);
  }

  // --- Business Gate ------------------------------------------------------
  const existingGate = await repo.getGateMetrics(period.id);
  const gate: RawGateMetrics = existingGate
    ? { ...existingGate }
    : { periodId: period.id, clientAvgWaitTimeMin: null, teamProcessingTimeMin: null, chatTeamAvgResponseSec: null, teamTicketAHTMin: null };

  const gateKeysToCheck = new Set<GateField>();
  if (isManualEntry(record)) {
    for (const row of ownRows) {
      if (row.matchedAgentId === null && row.parsedValue !== null && isGateField(row.metricKey)) gateKeysToCheck.add(row.metricKey);
    }
  } else {
    for (const key of PDF_GATE_FIELDS) gateKeysToCheck.add(key);
  }
  const otherPdfExists = siblings.some((s) => !isManualEntry(s.record) && !isManualClear(s.record));

  for (const key of gateKeysToCheck) {
    const replacement = siblingGateValue(siblings, key);
    let next: number | null;
    if (replacement.found) {
      next = replacement.value;
    } else if (!isManualEntry(record) && otherPdfExists) {
      // Another PDF on this day may be where this number came from, and a
      // PDF's Gate numbers are not stored row by row: leave it as it is.
      continue;
    } else {
      next = null;
    }
    // A stored rejection rate is only touched when the column exists.
    if (key === "teamRejectionRatePct" && gate.teamRejectionRatePct === undefined) continue;
    if (gate[key] !== next) {
      gate[key] = next;
      result.gateValuesChanged += 1;
    }
  }

  if (result.agentValuesChanged === 0 && result.gateValuesChanged === 0) return result;

  // Write the day back. commitImport needs an import to attach to; use a
  // surviving one (every sibling here already points at this period).
  const anchor = siblingRecords.find((s) => s.status === "committed") ?? siblingRecords[0]!;
  await repo.commitImport(anchor.id, period, [...byAgent.values()], gate);

  // An agent whose every field is now empty has no record left for this day.
  for (const agentId of touchedAgents) {
    const entry = byAgent.get(agentId);
    if (entry && AGENT_FIELDS.every((f) => entry[f] === null)) await repo.deleteRawMetric(agentId, period.id);
  }
  return result;
}
