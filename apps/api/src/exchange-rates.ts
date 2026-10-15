import { z } from "zod";
import type { ExpenseRates } from "@venture-studio/contracts";
import type { AppDb } from "./db.js";

// Daily reference exchange rates for expenses paid in another currency: the European Central Bank's, served by Frankfurter (no key;
// only dates and currency codes go out). Each working day's rates are kept once fetched, so a day is asked for once; the days kept are
// recorded as one span, widened when an earlier day is needed and topped up with the latest days every few hours.

const RATES = "exchange_rates"; // _id: an ECB working day (YYYY-MM-DD); rates: units of each currency for one euro.
const COVERAGE = "exchange_rate_coverage"; // _id: "ecb"; from, to: the span of days kept; checkedAt: when the latest days were asked for.
const REFRESH_MS = 6 * 3_600_000;
/** After the source fails, it isn't asked again for this long (pages use the kept rates meanwhile instead of waiting on it). */
const RETRY_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;
/** Days looked back from a day for the latest published rate (weekends and holidays have none). */
const LOOKBACK_DAYS = 10;
/** Days fetched per request at most, and the widest gap filled to keep the kept days one span. */
const CHUNK_DAYS = 366;
const GAP_DAYS = 400;
export const RATE_SOURCE = "European Central Bank reference rates";

export type RateSource = { url: string; fetch?: typeof fetch };
const seriesSchema = z.object({ rates: z.record(z.string(), z.record(z.string(), z.number().positive())) });

const DAY_MS = 86_400_000;
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Asks the source for every working day from `from` to `to` and keeps them, a year at most per request. */
async function fetchSpan(db: AppDb, from: string, to: string, source: RateSource) {
  for (let first = from; first <= to; first = shift(first, CHUNK_DAYS)) {
    const last = shift(first, CHUNK_DAYS - 1) < to ? shift(first, CHUNK_DAYS - 1) : to;
    const response = await (source.fetch ?? fetch)(`${source.url.replace(/\/$/, "")}/${first}..${last}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Exchange rates answered ${response.status}`);
    const { rates } = seriesSchema.parse(await response.json());
    // A span of only a weekend answers with the Friday before: kept too, it's a real day.
    const days = Object.entries(rates).filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day));
    if (days.length) await db.collection(RATES).bulkWrite(days.map(([day, values]) => ({ updateOne: { filter: { _id: day as never }, update: { $set: { rates: { ...values, EUR: 1 }, fetchedAt: new Date() } }, upsert: true } })), { ordered: false });
  }
}

/** Fetches, unless the source failed a moment ago (then it isn't asked for a while, and the kept rates serve). */
async function fetchUnlessResting(db: AppDb, spans: [string, string][], source: RateSource) {
  const record = await db.collection(COVERAGE).findOne({ _id: "ecb" as never });
  if (record?.failedAt instanceof Date && Date.now() - record.failedAt.getTime() < RETRY_MS) throw new Error("Exchange rates were unreachable a moment ago");
  try { for (const [a, b] of spans) await fetchSpan(db, a, b, source); }
  catch (error) {
    await db.collection(COVERAGE).updateOne({ _id: "ecb" as never }, { $set: { failedAt: new Date() } }, { upsert: true });
    throw error;
  }
}

/**
 * Makes sure the rates from `from` to `to` (no later than today) are kept, fetching only what is missing or a few hours old. The days
 * kept are one span: widened to take in a request next to it (or a year or so from it, the gap fetched too); a request far from it is
 * fetched on its own and the span stays as it was, so no request makes it fetch years it wasn't asked for.
 */
export async function ensureRates(db: AppDb, from: string, to: string, source: RateSource): Promise<void> {
  const end = to > todayUtc() ? todayUtc() : to;
  if (from > end) return;
  const record = await db.collection(COVERAGE).findOne({ _id: "ecb" as never });
  const kept = record?.from && record?.to ? { from: String(record.from), to: String(record.to), checkedAt: record.checkedAt as Date | undefined } : null;
  const stale = !(kept?.checkedAt instanceof Date) || Date.now() - kept.checkedAt.getTime() > REFRESH_MS;
  if (!kept) {
    await fetchUnlessResting(db, [[from, end]], source);
    await db.collection(COVERAGE).updateOne({ _id: "ecb" as never }, { $set: { from, to: end, checkedAt: new Date() }, $unset: { failedAt: "" } }, { upsert: true });
    return;
  }
  // Far from the kept span (more than a year or so of gap): fetched on its own when not kept yet, the span left alone.
  const far = end < shift(kept.from, -GAP_DAYS) || from > shift(kept.to, GAP_DAYS);
  if (far) {
    const have = await db.collection(RATES).countDocuments({ _id: { $gte: from, $lte: end } as never });
    if (!have) await fetchUnlessResting(db, [[from, end]], source);
    return;
  }
  const spans: [string, string][] = [];
  if (from < kept.from) spans.push([from, shift(kept.from, -1)]);
  if (end > kept.to || (end === kept.to && stale)) spans.push([kept.to, end]);
  if (!spans.length) return;
  await fetchUnlessResting(db, spans, source);
  await db.collection(COVERAGE).updateOne({ _id: "ecb" as never }, { $set: { from: from < kept.from ? from : kept.from, to: end > kept.to ? end : kept.to, checkedAt: new Date() }, $unset: { failedAt: "" } }, { upsert: true });
}

/** Rupees for one unit of `currency`, from a day's rates (units for one euro); ten significant digits (an IDR is about ₹0.005). */
const rupeesFor = (rates: Record<string, number>, currency: string) => (rates.INR && rates[currency] ? Number((rates.INR / rates[currency]!).toPrecision(10)) : null);
const warn = (error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "exchange_rates.fetch_failed", message: error instanceof Error ? error.message : String(error) }));

/**
 * The rate an expense paid on `day` converts at: the latest published on or before it, at most `LOOKBACK_DAYS` before (a weekend's is
 * the Friday's; a day still to come takes today's latest). Null when none could be had (the source unreachable and none kept that
 * close); `{ rate: null }` when the day has rates but none for this currency (before the source had it).
 */
export async function rupeeRate(db: AppDb, currency: string, day: string, source: RateSource): Promise<{ rate: number | null; day: string } | null> {
  const on = day > todayUtc() ? todayUtc() : day;
  const first = shift(on, -LOOKBACK_DAYS);
  await ensureRates(db, first, on, source).catch(warn);
  const found = await db.collection(RATES).find({ _id: { $gte: first, $lte: on } as never }).sort({ _id: -1 }).limit(1).next();
  return found ? { rate: rupeesFor(found.rates as Record<string, number>, currency), day: String(found._id) } : null;
}

/**
 * Every working day's rates from `from` to `to` (and the last one before `from`), as rupees for one unit of each currency asked for.
 * A span still to come gets the latest kept day. Served from what is kept when the source can't be reached; `unavailable` when there
 * is nothing at all.
 */
export async function ratesBetween(db: AppDb, from: string, to: string, currencies: string[], source: RateSource): Promise<ExpenseRates> {
  const start = shift(from, -LOOKBACK_DAYS);
  await ensureRates(db, start, to, source).catch(warn);
  const docs = await db.collection(RATES).find({ _id: { $gte: start, $lte: to } as never }).sort({ _id: 1 }).toArray();
  const firstInSpan = docs.findIndex((doc) => String(doc._id) >= from);
  let kept = firstInSpan > 0 ? docs.slice(firstInSpan - 1) : firstInSpan === 0 ? docs : docs.slice(-1);
  if (!kept.length) kept = await db.collection(RATES).find({ _id: { $lte: to } as never }).sort({ _id: -1 }).limit(1).toArray();
  const days = kept.map((doc) => ({ day: String(doc._id), rupees: Object.fromEntries(currencies.flatMap((currency) => { const rate = rupeesFor(doc.rates as Record<string, number>, currency); return rate ? [[currency, rate]] : []; })) }));
  return { source: RATE_SOURCE, days, unavailable: days.length === 0 };
}
