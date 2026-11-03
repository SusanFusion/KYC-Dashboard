import { TopHeader } from "@/components/layout/TopHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ImportWorkflow } from "@/components/shared/ImportWorkflow";
import { ManualEntryForm } from "@/components/shared/ManualEntryForm";
import { ImportHistoryList } from "@/components/shared/ImportHistoryList";
import { RawMetricRecordsManager } from "@/components/shared/RawMetricRecordsManager";
import { ClearMetricFieldForm } from "@/components/shared/ClearMetricFieldForm";
import { ClearGateFieldForm } from "@/components/shared/ClearGateFieldForm";
import { ClearScorecardsForm } from "@/components/shared/ClearScorecardsForm";
import { PasswordGate } from "@/components/shared/PasswordGate";
import { getRepository } from "@/lib/data/repository";
import { listAvailableMonths } from "@/lib/data/query";
import { metricFieldLabel } from "@/lib/data/metricLabels";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";

// Matches RawAgentMetrics's own fields (see lib/scoring/types.ts), minus
// agentId/periodId -- used only to tell which of a record's individual
// fields actually carry a value, for the per-record badges below.
const INDIVIDUAL_FIELD_KEYS = [
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

export default async function ImportPage() {
  const repo = await getRepository();
  const [imports, agents, periods, rawMetrics, user, months] = await Promise.all([
    repo.getImports(),
    repo.getAgents(),
    repo.getPeriods(),
    repo.getRawMetrics(),
    getCurrentUser(),
    listAvailableMonths(),
  ]);
  const periodOptions = periods.map((p) => ({ id: p.id, label: p.label, endDate: p.endDate }));

  // Same fail-open convention as the Penalties page's canSeePenaltyLog --
  // there's no session at all for most visits (login is optional, see
  // getCurrentUser.ts), so this only HIDES these controls for someone
  // signed in as a plain agent; the real enforcement is the Lead/Manager
  // password this whole page is already behind (see deleteRawMetricAction
  // and clearIndividualMetricFieldAction).
  const canManageRawMetrics = !user || user.role === "lead";

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const rawMetricRecords = rawMetrics.map((m) => ({
    agentId: m.agentId,
    agentName: agentNameById.get(m.agentId) ?? m.agentId,
    periodId: m.periodId,
    fieldsTouched: INDIVIDUAL_FIELD_KEYS.filter((key) => m[key] !== null && m[key] !== undefined).map(metricFieldLabel),
  }));
  const metricFieldOptions = INDIVIDUAL_FIELD_KEYS.map((key) => ({ key, label: metricFieldLabel(key) }));
  const monthOptions = months.map((m) => ({ key: m.key, label: m.label }));

  // Only Manual Entry submissions carry a meaningful "which metrics did you
  // tick" story — a PDF import's rows are just whatever it managed to parse
  // off the report, not a deliberate selection. So this only fetches rows
  // (and only shows the resulting badges in ImportHistoryList) for imports
  // named "Manual entry", rather than doing it for every row in history.
  const manualImports = imports.filter((imp) => imp.fileName === "Manual entry");
  const manualImportRows = await Promise.all(manualImports.map((imp) => repo.getImportRows(imp.id)));
  const fieldsTouchedByImportId = new Map<string, string[]>();
  manualImports.forEach((imp, i) => {
    const rows = manualImportRows[i] ?? [];
    fieldsTouchedByImportId.set(imp.id, Array.from(new Set(rows.map((r) => r.metricKey))).map(metricFieldLabel));
  });

  return (
    <>
      <TopHeader
        title="Data Import"
        description="Upload one or more Daily/Monthly KYC Team Performance Report PDFs, or enter data manually — review before anything is saved"
      />
      <PageShell>
        {/* Covers the whole Data Import feature — uploading/parsing a PDF,
            Manual Entry (which is also how QA Audit numbers get submitted;
            there's no separate audit-submission form), and Import history's
            delete action. Viewing the rest of the app no longer needs a
            password (or a login at all) — only actions that write or remove
            the team's data do. The actual enforcement is server-side, on
            each route these components call (see requireActionAccess.ts) —
            this is just the matching UI. */}
        <PasswordGate description="Enter the shared Lead/Manager password to import, enter, or delete data.">
          <Tabs defaultValue="upload">
            <TabsList>
              <TabsTrigger value="upload">Upload PDF</TabsTrigger>
              <TabsTrigger value="manual">Manual Entry</TabsTrigger>
            </TabsList>
            <TabsContent value="upload" className="mt-4">
              <ImportWorkflow periods={periodOptions} />
            </TabsContent>
            <TabsContent value="manual" className="mt-4">
              <ManualEntryForm agents={agents.map((a) => ({ id: a.id, name: a.name }))} periods={periodOptions} />
            </TabsContent>
          </Tabs>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Import history</CardTitle>
              <CardDescription>
                Every upload, whether committed or not. Deleting a committed import removes the day&apos;s data everywhere
                it&apos;s read — Team Performance, Trends, Overall MTD, Dashboard, Rankings, Scorecards, Reports, and Penalties.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ImportHistoryList
                imports={imports.map((imp) => ({
                  id: imp.id,
                  fileName: imp.fileName,
                  uploadedAt: imp.uploadedAt,
                  periodLabel: imp.periodLabel,
                  status: imp.status,
                  rowCount: imp.rowCount,
                  periodId: imp.periodId ?? null,
                  fieldsTouched: fieldsTouchedByImportId.get(imp.id) ?? [],
                }))}
              />
            </CardContent>
          </Card>

          {canManageRawMetrics && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Delete a KPI record</CardTitle>
                <CardDescription>
                  Removes one agent&apos;s individual KPI record for one period — not the whole day&apos;s import. This
                  immediately updates that agent&apos;s score, Scorecard, and Rankings position. Visible to Leads/Auditors
                  only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RawMetricRecordsManager records={rawMetricRecords} periods={periodOptions.map((p) => ({ id: p.id, label: p.label }))} />
              </CardContent>
            </Card>
          )}

          {canManageRawMetrics && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Clear a KPI field across a month</CardTitle>
                <CardDescription>
                  Nulls out one chosen KPI for one agent across every day already imported in a selected month — e.g. to
                  wipe a bad QA Audit % for their whole month-to-date without touching any other field or any other day.
                  Visible to Leads/Auditors only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ClearMetricFieldForm
                  agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                  months={monthOptions}
                  fields={metricFieldOptions}
                />
              </CardContent>
            </Card>
          )}

          {canManageRawMetrics && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Clear a Business Gate field across a month</CardTitle>
                <CardDescription>
                  Blanks one team-level Business Gate figure (or Client Avg Wait Time and Team Processing Time together)
                  on every day already imported in a selected month, including values left behind by an old PDF import.
                  Agent data is not touched. Visible to Leads/Auditors only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ClearGateFieldForm months={monthOptions} />
              </CardContent>
            </Card>
          )}

          {canManageRawMetrics && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Clear individual scorecards for a month</CardTitle>
                <CardDescription>
                  Blanks every KPI on the individual scorecards (AHT, chat response, CSAT/DSAT, ticket counts) for one
                  agent or for all agents, across every day already imported in a selected month. QA Audit % and
                  penalties are kept. Visible to Leads/Auditors only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ClearScorecardsForm agents={agents.map((a) => ({ id: a.id, name: a.name }))} months={monthOptions} />
              </CardContent>
            </Card>
          )}
        </PasswordGate>
      </PageShell>
    </>
  );
}
