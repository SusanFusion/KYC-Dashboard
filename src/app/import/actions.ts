"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getRepository } from "@/lib/data/repository";
import { getDailyPeriods, listAvailableMonths } from "@/lib/data/query";
import type { RawIndividualMetricKey } from "@/lib/scoring/types";
import type { GateFieldKey } from "@/lib/data/repository";
import { ACTION_ACCESS_COOKIE_NAME, verifyActionAccessToken } from "@/lib/auth/actionAccess";

// Mirrors the same validation /api/import/clear-field/route.ts does for its
// own metricKey -- a plain allowlist Set is cheap insurance against a
// malformed or tampered form field ever reaching the repository layer as an
// arbitrary string.
const INDIVIDUAL_FIELD_KEYS = new Set<RawIndividualMetricKey>([
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
]);

// Business Gate fields the "clear across a month" action may blank. "manualOnly"
// is a shortcut for the two fields that are typed in by hand and never read
// from a PDF (Client Avg Wait Time and Team Processing Time).
const GATE_FIELD_KEYS = new Set<GateFieldKey>([
  "clientAvgWaitTimeMin",
  "teamProcessingTimeMin",
  "chatTeamAvgResponseSec",
  "teamTicketAHTMin",
  "teamRejectionRatePct",
]);
const MANUAL_ONLY_GATE_FIELDS: GateFieldKey[] = ["clientAvgWaitTimeMin", "teamProcessingTimeMin"];

/** Same pattern as src/app/penalties/actions.ts's own copy of this helper --
 *  requireActionAccess() in actionAccess.ts returns a NextResponse, built
 *  for route handlers, so a "use server" action checks the identical
 *  cookie/token directly instead and returns the plain {ok, error} shape
 *  this action already uses. */
async function checkActionAccess(): Promise<string | null> {
  const token = cookies().get(ACTION_ACCESS_COOKIE_NAME)?.value;
  const ok = await verifyActionAccessToken(token);
  return ok ? null : "Password required — unlock this section and try again.";
}

/** Deletes one agent's single KPI record for one period (Data Import page
 *  only — see page.tsx's canDeleteRawMetric, which hides this control
 *  unless the signed-in user is a Lead/Auditor, matching the Penalties
 *  page's existing convention). The shared Lead/Manager password check
 *  above is the REAL enforcement (this route-level gate can't be bypassed
 *  by calling the action directly); the role check is a visibility nicety
 *  layered on top, same relationship as everywhere else this pattern is
 *  used. */
export async function deleteRawMetricAction(formData: FormData) {
  const accessError = await checkActionAccess();
  if (accessError) return { ok: false, error: accessError };

  const agentId = String(formData.get("agentId") ?? "");
  const periodId = String(formData.get("periodId") ?? "");
  if (!agentId || !periodId) return { ok: false, error: "Missing agent or period." };

  const repo = await getRepository();
  await repo.deleteRawMetric(agentId, periodId);

  // Every score is always derived fresh from raw data on read (see
  // src/lib/data/query.ts), so removing the underlying performance_entries
  // row here is all that's needed -- nothing cached to recalculate, just
  // tell every page that reads it to refetch.
  revalidatePath("/import");
  revalidatePath("/team-performance");
  revalidatePath("/trends");
  revalidatePath("/mtd");
  revalidatePath("/");
  revalidatePath("/rankings");
  revalidatePath("/reports");
  revalidatePath(`/scorecards/${agentId}`);
  return { ok: true };
}

/** Nulls one chosen KPI field, for one agent, across every day already
 *  imported in one chosen month -- the "wipe a bad KPI for an agent's
 *  whole month in one click, without deleting the rest of their data"
 *  action (Data Import page, Lead/Auditor-only -- see page.tsx's
 *  canDeleteRawMetric, reused here since this is just as destructive).
 *  Recomputes the month's day-period ids itself from the month key
 *  (the same way the Overall MTD page does, via getDailyPeriods +
 *  listAvailableMonths) rather than trusting a client-supplied id list,
 *  so this can never be tricked into touching a day outside the month it
 *  claims to be clearing. */
export async function clearIndividualMetricFieldAction(formData: FormData) {
  const accessError = await checkActionAccess();
  if (accessError) return { ok: false as const, error: accessError };

  const agentId = String(formData.get("agentId") ?? "");
  const monthKey = String(formData.get("monthKey") ?? "");
  const fieldRaw = String(formData.get("field") ?? "");
  if (!agentId || !monthKey || !fieldRaw) {
    return { ok: false as const, error: "Missing agent, month, or KPI field." };
  }
  if (!INDIVIDUAL_FIELD_KEYS.has(fieldRaw as RawIndividualMetricKey)) {
    return { ok: false as const, error: "Unknown KPI field." };
  }
  const field = fieldRaw as RawIndividualMetricKey;

  const repo = await getRepository();
  const [periods, months] = await Promise.all([repo.getPeriods(), listAvailableMonths()]);
  const month = months.find((m) => m.key === monthKey);
  if (!month) return { ok: false as const, error: "That month no longer has any imports." };

  const periodIds = getDailyPeriods(periods)
    .filter((p) => p.startDate >= month.start && p.endDate <= month.end)
    .map((p) => p.id);

  const clearedCount = await repo.clearIndividualMetricField(agentId, periodIds, field);

  // Same reasoning as deleteRawMetricAction -- every score is derived
  // fresh from raw data on read, so this is all that's needed to make the
  // change visible everywhere it's shown.
  revalidatePath("/import");
  revalidatePath("/team-performance");
  revalidatePath("/trends");
  revalidatePath("/mtd");
  revalidatePath("/");
  revalidatePath("/rankings");
  revalidatePath("/reports");
  revalidatePath(`/scorecards/${agentId}`);
  return { ok: true as const, clearedCount };
}

/** Nulls one Business Gate field (or both hand-typed ones) on every day
 *  already imported in one chosen month. Day periods are recomputed here
 *  from the month key, never taken from the client, exactly like
 *  clearIndividualMetricFieldAction. Individual agent data is untouched. */
export async function clearGateFieldRangeAction(formData: FormData) {
  const accessError = await checkActionAccess();
  if (accessError) return { ok: false as const, error: accessError };

  const monthKey = String(formData.get("monthKey") ?? "");
  const fieldRaw = String(formData.get("field") ?? "");
  if (!monthKey || !fieldRaw) {
    return { ok: false as const, error: "Missing month or Business Gate field." };
  }
  let fields: GateFieldKey[];
  if (fieldRaw === "manualOnly") {
    fields = MANUAL_ONLY_GATE_FIELDS;
  } else if (GATE_FIELD_KEYS.has(fieldRaw as GateFieldKey)) {
    fields = [fieldRaw as GateFieldKey];
  } else {
    return { ok: false as const, error: "Unknown Business Gate field." };
  }

  const repo = await getRepository();
  const [periods, months] = await Promise.all([repo.getPeriods(), listAvailableMonths()]);
  const month = months.find((m) => m.key === monthKey);
  if (!month) return { ok: false as const, error: "That month no longer has any imports." };

  const periodIds = getDailyPeriods(periods)
    .filter((p) => p.startDate >= month.start && p.endDate <= month.end)
    .map((p) => p.id);

  let clearedCount = 0;
  for (const field of fields) {
    clearedCount += await repo.clearGateMetricField(periodIds, field);
  }

  revalidatePath("/import");
  revalidatePath("/team-performance");
  revalidatePath("/trends");
  revalidatePath("/mtd");
  revalidatePath("/");
  revalidatePath("/rankings");
  revalidatePath("/reports");
  return { ok: true as const, clearedCount };
}

/** Blanks every scorecard KPI (all except QA Audit %) for one agent, or for
 *  every agent, across every day already imported in one chosen month.
 *  Penalties and QA audit records are not touched. The month's day periods
 *  are recomputed here from the month key, never taken from the client. */
export async function clearScorecardsMonthAction(formData: FormData) {
  const accessError = await checkActionAccess();
  if (accessError) return { ok: false as const, error: accessError };

  const monthKey = String(formData.get("monthKey") ?? "");
  const agentRaw = String(formData.get("agentId") ?? "");
  if (!monthKey || !agentRaw) {
    return { ok: false as const, error: "Missing month or agent." };
  }

  const repo = await getRepository();
  const [periods, months, agents] = await Promise.all([repo.getPeriods(), listAvailableMonths(), repo.getAgents()]);
  const month = months.find((m) => m.key === monthKey);
  if (!month) return { ok: false as const, error: "That month no longer has any imports." };

  let agentId: string | null = null;
  if (agentRaw !== "all") {
    if (!agents.some((a) => a.id === agentRaw)) return { ok: false as const, error: "Unknown agent." };
    agentId = agentRaw;
  }

  const periodIds = getDailyPeriods(periods)
    .filter((p) => p.startDate >= month.start && p.endDate <= month.end)
    .map((p) => p.id);

  const clearedCount = await repo.clearScorecardKpis(agentId, periodIds);

  revalidatePath("/import");
  revalidatePath("/team-performance");
  revalidatePath("/trends");
  revalidatePath("/mtd");
  revalidatePath("/");
  revalidatePath("/rankings");
  revalidatePath("/reports");
  revalidatePath("/scorecards");
  if (agentId) revalidatePath(`/scorecards/${agentId}`);
  return { ok: true as const, clearedCount };
}
