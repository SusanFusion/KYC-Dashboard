import { NextResponse } from "next/server";
import { getRepository } from "@/lib/data/repository";
import { describeError } from "@/lib/utils";
import { requireActionAccess } from "@/lib/auth/actionAccess";
import { removeImportContribution } from "@/lib/data/removeImportContribution";

export const runtime = "nodejs";

interface DeleteImportBody {
  importId: string;
}

export async function POST(request: Request) {
  try {
    const denied = await requireActionAccess();
    if (denied) return denied;

    const body = (await request.json()) as DeleteImportBody;
    if (!body.importId) {
      return NextResponse.json({ error: "Missing importId." }, { status: 400 });
    }

    const repo = await getRepository();
    const [imports, periods] = await Promise.all([repo.getImports(), repo.getPeriods()]);
    const record = imports.find((i) => i.id === body.importId);
    if (!record) {
      return NextResponse.json({ error: "Import not found — it may have already been deleted." }, { status: 404 });
    }

    // No period ever got linked to this import — either it was never
    // committed (still "pending_review" or "failed"), or it predates the
    // period_id column being added. Either way there's no period data to
    // touch; just remove the audit-trail record itself.
    if (!record.periodId) {
      await repo.deleteImport(record.id);
      return NextResponse.json({ ok: true, deletedPeriod: false, message: "Import record removed." });
    }

    const period = periods.find((p) => p.id === record.periodId);
    // Every OTHER import that also points at this same period — normally
    // zero, since every import mints its own daily period by default now,
    // but a PDF import and a later manual entry can still be deliberately
    // merged onto one shared day (see commitImportRows.ts's targetPeriodId).
    const siblingImports = imports.filter((i) => i.periodId === record.periodId && i.id !== record.id);

    if (siblingImports.length === 0) {
      // This import is the sole reason this period exists — deleting it
      // means deleting the whole day: its individual metrics, its Business
      // Gate numbers, any penalties logged against it, and the import
      // record itself. This is what makes it "no longer read anywhere" —
      // every page (Team Performance, Trends, Overall MTD, Dashboard,
      // Rankings, Scorecards, Reports, Penalties) reads periods fresh on
      // every request, with nothing cached in between.
      await repo.deletePeriod(record.periodId);
      return NextResponse.json({
        ok: true,
        deletedPeriod: true,
        periodLabel: period?.label ?? record.periodLabel ?? record.periodId,
      });
    }

    // Another import also contributed to this same period, so the whole day
    // can't go. Instead, take back exactly what THIS import wrote (see
    // removeImportContribution.ts) and leave everything the other imports
    // wrote, and every penalty, in place.
    const removed = period ? await removeImportContribution(repo, record, siblingImports, period) : { agentValuesChanged: 0, gateValuesChanged: 0 };
    await repo.deleteImport(record.id);
    return NextResponse.json({
      ok: true,
      deletedPeriod: false,
      agentValuesRemoved: removed.agentValuesChanged,
      gateValuesRemoved: removed.gateValuesChanged,
      periodLabel: period?.label ?? record.periodLabel ?? record.periodId,
      message: `Import removed along with the ${removed.agentValuesChanged} agent value${removed.agentValuesChanged === 1 ? "" : "s"} and ${removed.gateValuesChanged} Business Gate value${removed.gateValuesChanged === 1 ? "" : "s"} it had written for "${period?.label ?? record.periodId}". Data from the other imports on that day was kept.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Unexpected error while deleting the import.", detail: describeError(err) },
      { status: 500 }
    );
  }
}
