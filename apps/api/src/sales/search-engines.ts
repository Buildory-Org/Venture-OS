// The two web search APIs Sales uses to find companies: TinyFish Search (free, 1,500 calls a day) and Exa (category "company", paid per call,
// kept inside its free monthly credit). Shared by the connector's search_companies tool and the built-in lead finder. A workspace may have
// several keys per engine (sales/search-keys.ts): calls are counted per key and period (mcp_search_usage), and withSearchKeys moves on to the
// next key when one is used up, refused or busy. Failures become short messages that carry no URL, header or response body, so no key can leak.
import type { AppDb } from "../db.js";
import { clean } from "../mcp/format.js";

const TINYFISH_URL = "https://api.search.tinyfish.ai";
const EXA_URL = "https://api.exa.ai/search";
const TIMEOUT_MS = 15_000;
/** Hosts that are never a company's own website: directories, marketplaces and social networks (the old engine's blocklist). */
export const NOT_A_COMPANY_SITE = ["indiamart.com", "justdial.com", "tradeindia.com", "exportersindia.com", "indiantradebird.com", "sulekha.com", "amazon.in", "flipkart.com", "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "pinterest.com", "quora.com", "reddit.com", "wikipedia.org"];
/** What the workspace may spend: TinyFish is free at 1,500 calls a day; Exa is paid per call, kept inside the free monthly credit (about 1,200 fast searches). */
export const SEARCH_CAPS = { tinyfish: { limit: 1_500, period: "day" }, exa: { limit: 1_200, period: "month" } } as const;

export type SearchEngine = "tinyfish" | "exa";
export type SearchHit = { url: string; title: string; snippet: string; engine: SearchEngine };
/** One key in use: its id (shown to admins, never the key) and the key. */
export type SearchKey = { id: string; key: string };
/** The keys in use per engine, in the order they are tried. */
export type SearchKeys = { tinyfish: SearchKey[]; exa: SearchKey[] };
export const noSearchKeys = (): SearchKeys => ({ tinyfish: [], exa: [] });
/** The id of the key saved before several keys per engine were allowed. */
export const LEGACY_KEY_ID = "main";
/** The id of the first key in the server's environment (the one key it held before several were allowed). */
export const FIRST_SERVER_KEY_ID = "server-1";
/**
 * How long search leaves a key alone after the engine refused it. A refusal can be the engine's own (a firewall or outage answering 403 for
 * every key), so a key is tried again after an hour rather than written off for the rest of the day or month; a test that works clears it at once.
 */
export const REFUSAL_PAUSE_MS = 60 * 60_000;

/** Why a search call failed: the key was refused (rejected, or its quota is used up), the engine is busy (rate limited), or anything else. */
export class SearchError extends Error {
  constructor(message: string, readonly reason: "refused" | "busy" | "failed") { super(message); this.name = "SearchError"; }
}

export const hostOf = (url: string): string | undefined => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return undefined; } };
export const isDirectory = (host: string) => NOT_A_COMPANY_SITE.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));

/** A company name from a page title ("Sharma Foods | Namkeen makers in Jaipur" → "Sharma Foods"), or from the domain when the title says nothing. */
export function guessCompany(title: string, domain: string): string {
  const first = clean(title).replace(/\s+/g, " ").trim().split(/\s[|–—:·-]\s/)[0]?.replace(/^(home|welcome( to)?)\s*[:|-]?\s*/i, "").trim() ?? "";
  if (first && first.length <= 80 && !/^(home|index|welcome)$/i.test(first)) return first;
  const label = domain.split(".")[0] ?? domain;
  return label.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * What searches from a chat (search_companies) may use of each allowance: the rest stays for the lead finder, so a busy chat never leaves
 * queued find runs without searches. Both count on the same counter.
 */
export const CHAT_SEARCH_SHARE = { tinyfish: 1_000, exa: 1_000 } as const;

/** The current period of an engine's allowance: the day (TinyFish) or the month (Exa), in UTC. */
export const periodOf = (engine: SearchEngine, now = new Date()) => now.toISOString().slice(0, SEARCH_CAPS[engine].period === "day" ? 10 : 7);
/**
 * One key's counter for one period. The key saved before several keys were allowed ("main") and the server's first key keep the counter the
 * workspace had then, so the calls made earlier in the period still count (the two are never in use together: saved keys replace the
 * server's, and sharing a counter can only over-count, never let an allowance be spent twice).
 */
export const usageId = (workspaceId: string, engine: SearchEngine, keyId: string, period: string) => keyId === LEGACY_KEY_ID || keyId === FIRST_SERVER_KEY_ID ? `${workspaceId}:${engine}:${period}` : `${workspaceId}:${engine}:${keyId}:${period}`;

/**
 * One call against a key's counter for the period `now` falls in, while the counter is under `limit` (the engine's cap per key unless a
 * smaller share is given) and the key is not paused after a refusal (unless `evenIfRefused`, for an admin's test); false once it is not. A
 * call that is not allowed is not counted, so asking again after the share is used up never eats into the rest.
 */
export async function reserveSearch(db: AppDb, workspaceId: string, engine: SearchEngine, keyId: string, limit: number = SEARCH_CAPS[engine].limit, evenIfRefused = false, now = new Date()): Promise<boolean> {
  const period = periodOf(engine, now);
  const usage = db.collection("mcp_search_usage");
  const _id = usageId(workspaceId, engine, keyId, period) as never;
  // First the period's counter exists (two first calls at once both end up here: the server retries an upsert that matches on _id alone),
  // then one call is counted only while the counter is under the limit.
  try {
    await usage.updateOne({ _id }, { $setOnInsert: { calls: 0, workspaceId, engine, keyId, period, createdAt: now, expiresAt: new Date(now.getTime() + 62 * 86_400_000) } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  return (await usage.updateOne({ _id, calls: { $lt: limit }, ...(evenIfRefused ? {} : { refusedUntil: { $not: { $gt: now } } }) }, { $inc: { calls: 1 } })).matchedCount === 1;
}

/**
 * Pauses a key for REFUSAL_PAUSE_MS after the engine refused it (search skips it meanwhile), or clears that after a test with it worked.
 * `countedAt` is when the refused call was counted, so the mark lands on that period's counter even when the answer came after midnight.
 */
export async function markRefused(db: AppDb, workspaceId: string, engine: SearchEngine, keyId: string, refused: boolean, countedAt = new Date()): Promise<void> {
  const _id = usageId(workspaceId, engine, keyId, periodOf(engine, countedAt)) as never;
  await db.collection("mcp_search_usage").updateOne({ _id }, refused ? { $set: { refusedAt: new Date(), refusedUntil: new Date(Date.now() + REFUSAL_PAUSE_MS) } } : { $unset: { refusedAt: "", refusedUntil: "" } });
}

/** What a call with an engine's keys came to: the answer and the key that gave it, or every key used up or paused after a refusal. */
export type KeyedResult<T> = { ok: true; value: T; keyId: string } | { ok: false };

/**
 * Calls an engine with the workspace's keys in turn. Each key counts against its own allowance for the period (TinyFish a day, Exa a month;
 * `limit` is a smaller share, for chat), and a key at its allowance or paused after a refusal is skipped. A refusal (the key was rejected or
 * its quota is used up) pauses the key for an hour and the next key is tried; busy (HTTP 429) tries the next key without pausing it. Any
 * other failure (the engine can't be reached, or answered with an error) is the engine's, not the key's: it is thrown. When no key answered,
 * a busy answer is thrown if there was one (the engine is only slowing down), else the refusal, so the engine's own words are reported;
 * when every key was already used up or paused before this call, it says so.
 */
export async function withSearchKeys<T>(db: AppDb, workspaceId: string, engine: SearchEngine, keys: readonly SearchKey[], call: (key: string) => Promise<T>, limit: number = SEARCH_CAPS[engine].limit): Promise<KeyedResult<T>> {
  let busy: unknown;
  let refused: unknown;
  for (const entry of keys) {
    const countedAt = new Date();
    if (!(await reserveSearch(db, workspaceId, engine, entry.id, limit, false, countedAt))) continue;
    try {
      return { ok: true, value: await call(entry.key), keyId: entry.id };
    } catch (error) {
      const reason = error instanceof SearchError ? error.reason : "failed";
      if (reason === "failed") throw error;
      if (reason === "refused") { await markRefused(db, workspaceId, engine, entry.id, true, countedAt); refused = error; } else busy = error;
    }
  }
  if (busy ?? refused) throw busy ?? refused;
  return { ok: false };
}

/** One request to a search API. Failures become short messages that carry no URL, header or response body (so no key can leak). */
async function send(label: string, url: string, init: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SearchError(`could not reach ${label}`, "failed");
  }
  // 402: the account behind the key has run out of credit.
  if (response.status === 401 || response.status === 402 || response.status === 403) throw new SearchError(`${label} refused the request: its key was rejected or its quota is used up`, "refused");
  if (response.status === 429) { const wait = Number(response.headers.get("retry-after")); throw new SearchError(`${label} is busy${Number.isFinite(wait) && wait > 0 ? `: try again in ${Math.min(Math.round(wait), 120)} s` : ": try again in a minute"}`, "busy"); }
  if (!response.ok) throw new SearchError(`${label} answered with an error (HTTP ${response.status})`, "failed");
  try { return await response.json(); } catch { throw new SearchError(`${label} returned something that is not JSON`, "failed"); }
}

export async function searchTinyfish(key: string, query: string, country: string, page: number): Promise<SearchHit[]> {
  const params = new URLSearchParams({ query, language: "en", domain_type: "web", page: String(Math.min(Math.max(page - 1, 0), 10)), location: country, exclude_domains: NOT_A_COMPANY_SITE.join(",") });
  const payload = await send("TinyFish Search", `${TINYFISH_URL}?${params}`, { method: "GET", headers: { "X-API-Key": key, accept: "application/json" } });
  return (Array.isArray(payload?.results) ? payload.results : []).flatMap((item: any) => item && typeof item.url === "string" ? [{ url: item.url.trim(), title: String(item.title ?? item.site_name ?? "").trim(), snippet: String(item.snippet ?? "").trim(), engine: "tinyfish" as const }] : []);
}

export async function searchExa(key: string, query: string, country: string, count: number): Promise<SearchHit[]> {
  const payload = await send("Exa", EXA_URL, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query, type: "fast", category: "company", numResults: count, excludeDomains: NOT_A_COMPANY_SITE, userLocation: country }) });
  return (Array.isArray(payload?.results) ? payload.results : []).flatMap((item: any) => {
    if (!item || typeof item.url !== "string") return [];
    const snippet = Array.isArray(item.highlights) ? item.highlights.slice(0, 2).join(" ") : String(item.text ?? item.summary ?? "");
    return [{ url: item.url.trim(), title: String(item.title ?? "").trim(), snippet: snippet.trim().slice(0, 400), engine: "exa" as const }];
  });
}
