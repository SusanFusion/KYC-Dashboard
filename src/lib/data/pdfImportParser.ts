// Parses the "Daily/Monthly KYC Team Performance Report" PDF layout into
// preview rows for the Data Import workflow.
//
// Design note: this does NOT parse raw PDF text linearly (fragile — table
// columns routinely get interleaved in PDF text-extraction order). Instead
// it takes each text item's (x, y) position — as returned by pdfjs-dist's
// getTextContent() — and reconstructs rows/columns from that geometry. This
// was built and verified against the actual structure of the report PDF
// supplied for this project (see scripts/verify-pdf-import.ts), not guessed.
import { parseDurationToSeconds } from "./time";
import type { Agent } from "@/types/domain";
import type { ImportRow } from "@/types/domain";

export interface PageTextItem {
  str: string;
  x: number;
  y: number;
}

export type TableType = "chatMetrics" | "emailAHT" | "appAHT" | "csatDsat" | "qaAudit" | "emailTicketVolume" | "unknown";

const TABLE_MATCHERS: { type: TableType; test: (pageText: string) => boolean }[] = [
  {
    type: "chatMetrics",
    test: (t) => /total chat conversations/i.test(t) && /average first response time/i.test(t),
  },
  {
    type: "emailAHT",
    test: (t) => /email ave handling time/i.test(t) || (/ticket aht/i.test(t) && /kyb/i.test(t) && !/csat/i.test(t)),
  },
  { type: "appAHT", test: (t) => /application ave handling time/i.test(t) },
  { type: "csatDsat", test: (t) => /csat/i.test(t) && /dsat/i.test(t) },
  { type: "qaAudit", test: (t) => /qa audit/i.test(t) },
  // The daily volume behind Team Ticket AHT -- per-agent count of email +
  // KYB tickets that day (NOT application tickets; confirmed with Susan
  // that Team Ticket AHT is scored on email/KYB tickets only). This table
  // only started appearing in the source report recently, so older PDFs
  // simply won't match this and emailTicketCount stays null for that day
  // (aggregateGate's weighting falls back to a plain mean when that
  // happens -- see query.ts).
  { type: "emailTicketVolume", test: (t) => /email ave volume/i.test(t) },
];

// "agent name" added alongside "agent" because this new table's header
// cell has been seen rendered as one two-word cell ("Agent name") rather
// than split the way the older tables' headers are -- listing both means
// detection works regardless of exactly how this particular PDF splits it.
//
// "agents" / "agents name" added after the chat page of a newer report layout
// started rendering its header as "Agents" + "Name". Because the header row
// wasn't recognised, the whole page was skipped -- taking the chat table AND
// the two Business Gate cards (Chat Team Avg Response, Team Ticket Resolution
// Time) printed above it down with it.
const HEADER_FIRST_CELLS = new Set(["agent", "agents", "assigned agent name", "agent name", "agents name"]);
const IGNORE_ROW_PATTERNS = [/^date range/i, /^generated date/i, /^\+\s*\d+\s*additional/i, /^\s*$/];

const TABLE_LABELS: Record<TableType, string> = {
  chatMetrics: "Chat metrics (Total Chats / First Response / Avg Response)",
  emailAHT: "Email AHT",
  appAHT: "Application AHT",
  csatDsat: "CSAT / DSAT",
  qaAudit: "QA Audit",
  emailTicketVolume: "Email Ticket Volume (Team Ticket AHT weighting)",
  unknown: "Unrecognized table",
};

const GATE_CARD_DEFS: { key: string; test: (t: string) => boolean }[] = [
  { key: "chatTeamAvgResponse", test: (t) => /chat.*team.*avg.*response.*time/i.test(t) },
  // The card in the PDF is titled "Team Ticket Resolution Time" (the app
  // itself calls the same metric "Team Ticket AHT"). "Team Ticket AHT" is
  // still accepted as an alternate title. \s+ rather than a single literal
  // space, because PDF text extraction can hand back a double space (or a
  // non-breaking one) between the words of a card title, which a plain
  // "team ticket resolution" pattern silently fails to match. The second
  // alternative covers a title whose "Team" word was split away from the
  // rest of it (e.g. a card title wrapped onto two lines).
  { key: "teamTicketAHT", test: (t) => /team\s+ticket\s+(resolution|aht)|ticket\s+resolution\s+time/i.test(t) },
  { key: "clientAvgWaitTime", test: (t) => /client avg wait time/i.test(t) },
  { key: "teamProcessingTime", test: (t) => /avg team processing time/i.test(t) },
];

const DURATION_LIKE = /^\d+(\.\d+)?\s*(h|hr|hrs|m|min|mins|s|sec|secs|ms)\b/i;

function groupIntoRows(items: PageTextItem[], tolerance = 2.5): PageTextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows: PageTextItem[][] = [];
  for (const item of sorted) {
    const current = rows[rows.length - 1];
    if (current && Math.abs(current[0]!.y - item.y) <= tolerance) current.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

function clusterByX(items: PageTextItem[], gapThreshold = 120): PageTextItem[][] {
  const distinctXs = [...new Set(items.map((i) => i.x))].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let current: number[] = [];
  for (const x of distinctXs) {
    if (current.length && x - current[current.length - 1]! > gapThreshold) {
      clusters.push(current);
      current = [];
    }
    current.push(x);
  }
  if (current.length) clusters.push(current);
  return clusters.map((xs) => items.filter((i) => xs.includes(i.x)));
}

/** Finds each Business Gate card's value by POSITION: locate the card's title
 *  item, then take the duration sitting closest below it within that card's
 *  column (from the title's x up to the next card title's x).
 *
 *  This exists because grouping by x-gaps alone (clusterByX) only works when
 *  neighbouring cards are well separated. In the current report layout the
 *  cards sit close enough together that every card on the page collapses
 *  into ONE cluster; the cluster then matched the first card definition
 *  (Chat Team Avg Response Time) and took the first duration in the cluster,
 *  so the Team Ticket Resolution Time card sitting right beside it was never
 *  read at all. The "30 sec" / "30 minutes" Target lines sit just under each
 *  title, so only durations well below the title (> 30 units) count. */
function findGateCardValues(cardItems: PageTextItem[]): { key: string; seconds: number }[] {
  const titles = cardItems
    .map((item) => ({ item, def: GATE_CARD_DEFS.find((d) => d.test(item.str)) }))
    .filter((t): t is { item: PageTextItem; def: (typeof GATE_CARD_DEFS)[number] } => t.def !== undefined)
    .sort((a, b) => a.item.x - b.item.x);

  const hits: { key: string; seconds: number }[] = [];
  titles.forEach((t, idx) => {
    const left = t.item.x - 5;
    const nextTitle = titles.slice(idx + 1).find((n) => n.item.x > t.item.x + 20);
    const right = nextTitle ? nextTitle.item.x - 5 : Number.POSITIVE_INFINITY;
    const candidates = cardItems
      .filter((i) => DURATION_LIKE.test(i.str.trim()) && i.x >= left && i.x < right && i.y < t.item.y - 30)
      .sort((a, b) => b.y - a.y);
    const best = candidates[0];
    if (!best) return;
    const seconds = parseDurationToSeconds(best.str.trim());
    if (seconds !== null) hits.push({ key: t.def.key, seconds });
  });
  return hits;
}

function matchAgent(nameRaw: string, agents: Agent[]): Agent | null {
  const normalized = nameRaw.trim().toLowerCase().replace(/\s+/g, " ");
  return agents.find((a) => a.name.trim().toLowerCase().replace(/\s+/g, " ") === normalized) ?? null;
}

export interface ParsedGateSnapshot {
  clientAvgWaitTimeMin: number | null;
  teamProcessingTimeMin: number | null;
  chatTeamAvgResponseSec: number | null;
  teamTicketAHTMin: number | null;
}

export interface PdfParseResult {
  rows: Omit<ImportRow, "id" | "importId">[];
  gate: ParsedGateSnapshot;
  gateFieldsFound: string[];
  periodLabelGuess: string | null;
  generatedDateGuess: string | null;
  tablesDetected: TableType[];
  warnings: string[];
}

export function parseKycReportPages(pages: PageTextItem[][], agents: Agent[]): PdfParseResult {
  const rows: Omit<ImportRow, "id" | "importId">[] = [];
  const warnings: string[] = [];
  const tablesDetected = new Set<TableType>();
  const gate: ParsedGateSnapshot = {
    clientAvgWaitTimeMin: null,
    teamProcessingTimeMin: null,
    chatTeamAvgResponseSec: null,
    teamTicketAHTMin: null,
  };
  const gateFieldsFound: string[] = [];
  let periodLabelGuess: string | null = null;
  let generatedDateGuess: string | null = null;

  for (const pageItems of pages) {
    const nonEmpty = pageItems.filter((i) => i.str.trim() !== "");
    if (nonEmpty.length === 0) continue;

    const pageText = nonEmpty.map((i) => i.str).join(" ");

    // When multiple PDFs are merged into one import (see /api/import/parse),
    // each one's pages flow through here in sequence. Keep the FIRST guess
    // found rather than letting a later file silently overwrite it, and
    // flag it instead if a later file disagrees — that's a real signal the
    // files may not all be for the same reporting period.
    const genDateMatch = pageText.match(/Generated Date:\s*([\d-]+)/i);
    if (genDateMatch) {
      const found = genDateMatch[1] ?? null;
      if (generatedDateGuess === null) generatedDateGuess = found;
      else if (found && found !== generatedDateGuess) {
        warnings.push(`One of the uploaded PDFs has a different Generated Date ("${found}") than the first ("${generatedDateGuess}") — confirm they're all for the same period.`);
      }
    }
    const rangeMatch = pageText.match(/Date Range\s*:\s*([A-Za-z0-9 ]+?)(?=\s{2}|$)/i);
    if (rangeMatch) {
      const found = rangeMatch[1]?.trim() ?? null;
      if (periodLabelGuess === null) periodLabelGuess = found;
      else if (found && found !== periodLabelGuess) {
        warnings.push(`One of the uploaded PDFs has a different Date Range ("${found}") than the first ("${periodLabelGuess}") — confirm they're all for the same period.`);
      }
    }

    const tableType = TABLE_MATCHERS.find((m) => m.test(pageText))?.type;
    const allRows = groupIntoRows(nonEmpty);

    // Header row y (used to separate "card" content above the table from
    // the table itself, and to find data rows below the header).
    // Only the row's FIRST cell identifies a real table header ("Agent" /
    // "Assigned Agent name") — checking for "Average Time tracked" anywhere
    // in the row was ambiguous: that exact phrase also appears as a KPI
    // card caption above the table on some pages, which was matching here
    // first and misidentifying the card zone as the table body (caught by
    // scripts/verify-pdf-import.ts against the real PDF).
    const headerRowIdx = allRows.findIndex((row) => {
      const first = row[0]?.str.trim().toLowerCase() ?? "";
      return HEADER_FIRST_CELLS.has(first);
    });

    if (tableType) {
      tablesDetected.add(tableType);

      if (headerRowIdx === -1) {
        // No "Agent" / "Assigned Agent name" header row found at all — this
        // isn't a normal table page with an unusual layout, it means the
        // report rendered NO per-agent table for this metric this period
        // (seen in the wild: a page with just the section title and a
        // literal "No data!" placeholder instead of rows). Treating every
        // other row on the page as agent data here would wrongly turn that
        // placeholder text — and decorative glyphs that sit above every
        // table's real header (e.g. a calendar icon next to "Date Range")
        // — into bogus "failed" rows with a blank or garbled agent name.
        // Skip the page's rows entirely and say clearly what happened.
        if (/no data/i.test(pageText)) {
          warnings.push(`${TABLE_LABELS[tableType]}: the PDF reports "No data" for this period — nothing to import for this metric.`);
        } else {
          warnings.push(`${TABLE_LABELS[tableType]}: couldn't find the table's header row on this page — skipped rather than risk importing garbage rows. Use Manual Entry to add this metric for this period if needed.`);
        }
      } else {
        const dataRows = allRows.slice(headerRowIdx + 1);

        for (const row of dataRows) {
          const cells = row.map((c) => c.str.trim()).filter(Boolean);
          if (cells.length === 0) continue;
          const rowText = cells.join(" ");

          // The page's interactive "Date Range" filter control is normally
          // rendered above the table, in the same zone as the Business Gate
          // cards, where the cardItems scan below already leaves it alone.
          // But on some report layouts (seen in the wild on the AHT/CSAT
          // sub-metric pages of a real report) it instead lands BELOW the
          // table, with a small icon glyph occupying the row's first cell —
          // which pushes "Date Range :" itself into a later cell, so the
          // ^date range/i check a few lines down (anchored to cells[0])
          // never catches it. Left unhandled, that icon becomes a bogus
          // "agent" with every column reading "missing", and the filter's
          // own (truncated) date value on the next line becomes a second
          // bogus agent named "2026-09-01 12:0…". Once this widget is
          // spotted anywhere in a row, everything below it on the page is
          // this filter control's own chrome, not more agent data — so
          // stop reading rows entirely rather than skip just the one row.
          if (/date range\s*:/i.test(rowText)) break;

          const firstCell = cells[0]!.toLowerCase();
          if (HEADER_FIRST_CELLS.has(firstCell)) continue;
          if (IGNORE_ROW_PATTERNS.some((p) => p.test(cells[0]!))) continue;
          // Section-title rows contain a "%)" weight marker or "Target" — not agent data.
          if (/%\)/.test(rowText) || /\btarget\b/i.test(rowText)) continue;

          const agentNameRaw = cells[0]!;
          const agent = matchAgent(agentNameRaw, agents);
          const values = cells.slice(1);

          pushRowsForTable(tableType, agentNameRaw, agent, values, rows, warnings);
        }
      }
    } else if (headerRowIdx === -1 && !/generated date|date range|additional/i.test(pageText)) {
      // A page with tabular-looking data we don't recognize — surface it
      // for manual review rather than silently dropping it.
      const sample = allRows
        .slice(0, 3)
        .map((r) => r.map((c) => c.str).join(" "))
        .join(" / ");
      if (sample.trim()) {
        warnings.push(`Unrecognized table layout on a page (sample: "${sample.slice(0, 120)}")`);
      }
    }

    // Business Gate ("card") values sit above the table header on the page.
    if (headerRowIdx >= 0) {
      const headerY = allRows[headerRowIdx]![0]!.y;
      const cardItems = nonEmpty.filter((i) => i.y > headerY + 15);
      if (cardItems.length > 0) {
        const applyGate = (key: string, seconds: number) => {
          // Client Avg Wait Time and Avg Team Processing Time are typed in by
          // hand (Manual Entry), never read from a PDF, so a PDF can't set or
          // overwrite either of them. Both cards are still listed in
          // GATE_CARD_DEFS only so the other cards' columns are measured
          // correctly if a report ever includes them.
          if (key === "clientAvgWaitTime" || key === "teamProcessingTime") return;
          gateFieldsFound.push(key);
          if (key === "chatTeamAvgResponse") gate.chatTeamAvgResponseSec = seconds;
          if (key === "teamTicketAHT") gate.teamTicketAHTMin = seconds / 60;
        };

        // 1) By position under each card's own title (see findGateCardValues).
        const handledOnPage = new Set<string>();
        for (const hit of findGateCardValues(cardItems)) {
          applyGate(hit.key, hit.seconds);
          handledOnPage.add(hit.key);
        }

        // 2) Fallback for layouts where a card's title is split across
        //    several text items: group by x-gap like before, but never
        //    re-read a card the positional pass already resolved.
        for (const cluster of clusterByX(cardItems)) {
          // Read the card's text top-to-bottom, then left-to-right, rather
          // than in raw PDF stream order, so a title that wraps onto two
          // lines still reads as "Team Ticket Resolution Time".
          const clusterText = [...cluster]
            .sort((a, b) => (Math.abs(b.y - a.y) > 2.5 ? b.y - a.y : a.x - b.x))
            .map((c) => c.str)
            .join(" ");
          const def = GATE_CARD_DEFS.find((d) => d.test(clusterText));
          if (!def || handledOnPage.has(def.key)) continue;
          const valueItem = cluster.find((c) => DURATION_LIKE.test(c.str.trim()));
          if (valueItem) {
            const seconds = parseDurationToSeconds(valueItem.str.trim());
            if (seconds !== null) applyGate(def.key, seconds);
          }
        }
      }
    }
  }

  return {
    rows,
    gate,
    gateFieldsFound,
    periodLabelGuess,
    generatedDateGuess,
    tablesDetected: [...tablesDetected],
    warnings,
  };
}

function pushRowsForTable(
  tableType: TableType,
  agentNameRaw: string,
  agent: Agent | null,
  values: string[],
  out: Omit<ImportRow, "id" | "importId">[],
  warnings: string[]
) {
  function addRow(metricKey: string, rawValue: string | undefined, isDuration: boolean) {
    if (rawValue === undefined) {
      out.push({
        agentNameRaw,
        matchedAgentId: agent?.id ?? null,
        metricKey,
        rawValue: "",
        parsedValue: null,
        status: "failed",
        note: "Expected value missing for this column",
      });
      return;
    }
    const parsedValue = isDuration ? parseDurationToSeconds(rawValue) : Number(rawValue.replace(/[^\d.]/g, ""));
    const status: ImportRow["status"] = !agent
      ? "needs_review"
      : parsedValue === null || Number.isNaN(parsedValue)
        ? "failed"
        : "extracted";
    out.push({
      agentNameRaw,
      matchedAgentId: agent?.id ?? null,
      metricKey,
      rawValue,
      parsedValue: parsedValue === null || Number.isNaN(parsedValue) ? null : parsedValue,
      status,
      note: !agent ? "Agent name not found in roster — confirm match manually" : undefined,
    });
  }

  switch (tableType) {
    case "chatMetrics":
      addRow("totalChatConversations", values[0], false);
      addRow("avgFirstResponseTimeSec", values[1], true);
      addRow("avgResponseTimeSec", values[2], true);
      break;
    case "emailAHT":
      addRow("emailAHTSec", values[0], true);
      break;
    case "appAHT":
      addRow("appAHTSec", values[0], true);
      break;
    case "csatDsat":
      addRow("totalChats", values[0], false);
      addRow("csatCount", values[1], false);
      addRow("dsatCount", values[2], false);
      break;
        case "qaAudit":
      addRow("qaAuditPct", values[0]?.replace("%", ""), false);
      break;
    case "emailTicketVolume":
      addRow("emailTicketCount", values[0], false);
      break;
    default:
      warnings.push(`No column mapping for table type "${tableType}" (agent: ${agentNameRaw})`);
  }
}
