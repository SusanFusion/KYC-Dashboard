// Rejection Quality %, read from the separate Rejection Audit Tracker app.
//
// This app never signs in to the tracker as a person. Instead the tracker
// exposes ONE read-only endpoint that returns the percentage as JSON, and this
// app calls it from the server. The address and the access token live in
// Vercel environment variables, so they are never in the code or in the
// browser:
//
//   REJECTION_TRACKER_API_URL    full https address of the tracker's endpoint
//   REJECTION_TRACKER_API_TOKEN  optional; sent as "Authorization: Bearer ..."
//
// The call adds ?start=YYYY-MM-DD&end=YYYY-MM-DD for the period on screen so
// the tracker can answer for that week or month. The response must be JSON
// with the percentage (0 to 100) in `rejectionQualityPct`, for example
//   { "rejectionQualityPct": 94.2 }
// or `null` when nothing was audited in that period.
//
// Shown for visibility only: it is not a Business Gate metric and never
// changes the Gate multiplier or any score. If the endpoint is not set up or
// cannot be reached, the card says so and the rest of the page loads normally.

export type RejectionQualityState = "ok" | "no_data" | "not_configured" | "unavailable";

export interface RejectionQuality {
  pct: number | null;
  state: RejectionQualityState;
}

const TIMEOUT_MS = 5000;

function readPct(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const candidate = record.rejectionQualityPct ?? (record.data as Record<string, unknown> | undefined)?.rejectionQualityPct;
  const value = typeof candidate === "string" ? Number(candidate) : candidate;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

export async function loadRejectionQuality(range: { start: string; end: string }): Promise<RejectionQuality> {
  const base = process.env.REJECTION_TRACKER_API_URL?.trim();
  if (!base) return { pct: null, state: "not_configured" };

  try {
    const url = new URL(base);
    if (url.protocol !== "https:") return { pct: null, state: "unavailable" };
    url.searchParams.set("start", range.start);
    url.searchParams.set("end", range.end);

    const token = process.env.REJECTION_TRACKER_API_TOKEN?.trim();
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { pct: null, state: "unavailable" };

    const body: unknown = await res.json();
    if (body && typeof body === "object" && (body as Record<string, unknown>).rejectionQualityPct === null) {
      return { pct: null, state: "no_data" };
    }
    const pct = readPct(body);
    return pct === null ? { pct: null, state: "unavailable" } : { pct, state: "ok" };
  } catch {
    return { pct: null, state: "unavailable" };
  }
}
