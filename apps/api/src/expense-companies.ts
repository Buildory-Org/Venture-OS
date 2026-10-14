import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { companyKey, companyName, isSharedDomain, websiteHost } from "@venture-studio/contracts";
import type { AppDb } from "./db.js";
import { isPhoto } from "./expense-receipts.js";
import { abortable, checkUrl, nodeFetch, readCapped, safeAddress, systemLookup, type FetchImpl, type LookupImpl } from "./sales/finder/fetch.js";

// The companies expenses are paid to (docs/expenses.md#companies): grouped without any model, by the name's key (companyKey), else
// GSTIN, else website (never a shared mail or payment domain such as gmail.com or razorpay.com). A logo is a 128 px WebP made from an image someone uploads, or from the icon the company's own website names,
// fetched with the lead finder's safety checks (public https hosts only, every redirect checked, the connection pinned to the checked
// address, small time and size limits). Nothing goes to a third-party icon service.

export const COMPANIES = "expense_companies";
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * The company for an expense paid to `name`: the one with the same name key, else the same GSTIN, else the same website; a new one
 * otherwise. The name wins, so a misread website or GSTIN never pulls a known name into another company. A company found by GSTIN or
 * website learns this spelling; one without a GSTIN or website gains it. `websiteAdded` when it gained a website.
 */
export async function resolveCompany(db: AppDb, workspaceId: string, name: string, hints: { gstin?: string | null; website?: string | null } = {}, actorId?: string): Promise<{ id: string; created: boolean; websiteAdded: boolean }> {
  const companies = db.collection(COMPANIES);
  const key = companyKey(name);
  const gstin = hints.gstin && GSTIN.test(hints.gstin) ? hints.gstin : null;
  const host = websiteHost(hints.website);
  const website = host && !isSharedDomain(host) ? host : null;
  const found = await companies.findOne({ workspaceId, keys: key }) ?? (gstin ? await companies.findOne({ workspaceId, gstin }) : null) ?? (website ? await companies.findOne({ workspaceId, website }) : null);
  if (found) {
    // A GSTIN or website it lacked, unless another company already has it (then it was misread here, and stays with that one).
    const taken = async (field: "gstin" | "website", value: string) => Boolean(await companies.findOne({ workspaceId, [field]: value, _id: { $ne: found._id } }, { projection: { _id: 1 } }));
    const set = { ...(!found.gstin && gstin && !await taken("gstin", gstin) ? { gstin } : {}), ...(!found.website && website && !await taken("website", website) ? { website } : {}) };
    if (Object.keys(set).length) await companies.updateOne({ _id: found._id }, { $set: set });
    // Unless another company already goes by this name.
    if (!(found.keys as string[]).includes(key)) await companies.updateOne({ _id: found._id }, { $addToSet: { keys: key } }).catch((error: { code?: number }) => { if (error.code !== 11000) throw error; });
    return { id: String(found._id), created: false, websiteAdded: "website" in set };
  }
  const doc = { _id: randomUUID(), workspaceId, name: companyName(name).slice(0, 120), keys: [key], gstin, website, createdBy: actorId ?? null, createdAt: new Date() };
  try {
    await companies.insertOne(doc as never);
    return { id: doc._id, created: true, websiteAdded: Boolean(website) };
  } catch (error) {
    // Added by someone else at the same moment: the unique index on (workspace, key) keeps it one company.
    const again = (error as { code?: number }).code === 11000 ? await companies.findOne({ workspaceId, keys: key }) : null;
    if (!again) throw error;
    return { id: String(again._id), created: false, websiteAdded: false };
  }
}

/** Gives every expense without a company its company, by its "Paid to" (the first time companies run, and safe to repeat). */
export async function assignExpenseCompanies(db: AppDb, limit = 5_000): Promise<number> {
  const pending = await db.collection("expenses").find({ companyId: { $exists: false } }).project({ workspaceId: 1, paidTo: 1 }).limit(limit).toArray();
  let assigned = 0;
  for (const expense of pending) {
    const { id } = await resolveCompany(db, String(expense.workspaceId), String(expense.paidTo ?? ""));
    // Not a change to the expense itself, so its version (updatedAt) stays.
    assigned += (await db.collection("expenses").updateOne({ _id: expense._id, companyId: { $exists: false } }, { $set: { companyId: id } })).modifiedCount;
  }
  return assigned;
}

// ---- Logos -------------------------------------------------------------------------------------------------------------------------

const LOGO_SIZE = 128;
type IcoPicture = { png: Buffer } | { raw: Buffer; width: number; height: number };
/**
 * A 32- or 24-bit bitmap picture from a .ico as RGBA pixels (rows stored bottom up; a 24-bit one takes its transparency from the 1-bit
 * mask after it), or null for any other kind.
 */
function icoBitmap(entry: Buffer): IcoPicture | null {
  if (entry.length < 40 || entry.readUInt32LE(0) !== 40 || entry.readUInt32LE(16) !== 0) return null;
  const width = entry.readInt32LE(4);
  const height = entry.readInt32LE(8) / 2;
  const bits = entry.readUInt16LE(14);
  if (!Number.isInteger(height) || width < 1 || width > 256 || height < 1 || height > 256 || (bits !== 32 && bits !== 24)) return null;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const maskStart = 40 + stride * height;
  if (entry.length < maskStart + (bits === 24 ? maskStride * height : 0)) return null;
  const raw = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = 40 + (height - 1 - y) * stride + x * (bits / 8);
    const out = (y * width + x) * 4;
    raw[out] = entry[at + 2]!; raw[out + 1] = entry[at + 1]!; raw[out + 2] = entry[at]!;
    raw[out + 3] = bits === 32 ? entry[at + 3]! : (entry[maskStart + (height - 1 - y) * maskStride + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255;
    anyAlpha ||= raw[out + 3]! > 0;
  }
  // A 32-bit picture that left its alpha empty is meant to be opaque.
  if (!anyAlpha) for (let out = 3; out < raw.length; out += 4) raw[out] = 255;
  return { raw, width, height };
}
/** The largest picture inside a .ico file: a PNG, or a 32- or 24-bit bitmap (the kinds favicons use); null when it has neither. */
export function imageInIco(bytes: Buffer): IcoPicture | null {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  let best: IcoPicture | null = null;
  let bestWidth = 0;
  for (let index = 0, count = bytes.readUInt16LE(4); index < count && 6 + (index + 1) * 16 <= bytes.length; index++) {
    const entry = 6 + index * 16;
    const width = bytes[entry] || 256;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (width <= bestWidth || size < 8 || offset + size > bytes.length) continue;
    const data = bytes.subarray(offset, offset + size);
    const picture = data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? { png: data } : icoBitmap(data);
    if (picture) { best = picture; bestWidth = width; }
  }
  return best;
}
/** A logo as kept: at most 128 px (a small icon keeps its size, so it isn't lost in padding), transparency kept, as WebP; from a PNG, JPEG, WebP, GIF or a .ico (never SVG). Null otherwise. */
export async function logoFromImage(bytes: Buffer): Promise<Buffer | null> {
  const ico = isPhoto(bytes) ? null : imageInIco(bytes);
  if (!isPhoto(bytes) && !ico) return null;
  try {
    const source = ico && "raw" in ico ? sharp(ico.raw, { raw: { width: ico.width, height: ico.height, channels: 4 } }) : sharp(ico ? ico.png : bytes, { limitInputPixels: 25_000_000, animated: false, failOn: "error" });
    return await source
      .resize(LOGO_SIZE, LOGO_SIZE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  } catch { return null; }
}

/**
 * The icons a home page names, best first: Apple touch icons, then other icons by size. SVG icons are skipped. Only the page's head (at
 * most its first 100 KB) is read, with bounded patterns, so a hostile page can't make the scan slow.
 */
export function iconLinks(html: string, base: string): string[] {
  const start = html.slice(0, 100_000);
  const end = start.search(/<\/head\s*>/i);
  const head = end >= 0 ? start.slice(0, end) : start;
  const found: { href: string; score: number }[] = [];
  for (const tag of head.match(/<link\b[^<>]{0,1000}>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([a-z-]{1,40})\s{0,8}=\s{0,8}(?:"([^"]{0,1000})"|'([^']{0,1000})'|([^\s>]{1,1000}))/gi)].map((match) => [match[1]!.toLowerCase(), (match[2] ?? match[3] ?? match[4] ?? "").trim()]));
    const rel = (attrs.rel ?? "").toLowerCase();
    if (!/(^|\s)(icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel) || !attrs.href || /svg/i.test(attrs.type ?? "") || /\.svg(\?|#|$)/i.test(attrs.href)) continue;
    const size = Math.max(0, ...(attrs.sizes ?? "").split(/\s+/).map((one) => Number(one.toLowerCase().split("x")[0]) || 0));
    try { found.push({ href: new URL(attrs.href, base).href, score: (rel.includes("apple-touch-icon") ? 1_000 : 0) + Math.min(size || 48, 512) }); } catch { /* a broken link */ }
  }
  return [...new Set(found.sort((a, b) => b.score - a.score).map((one) => one.href))];
}

export type LogoFetchers = { fetchImpl?: FetchImpl; lookupImpl?: LookupImpl; userAgent?: string };
const LOGO_TIMEOUT_MS = 8_000;
const LOOKUP_TIMEOUT_MS = 5_000;
/** All of one website's logo look-up (the page and up to five icons) ends within this. */
const LOGO_DEADLINE_MS = 30_000;
const MAX_HOME_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;

/** One GET of a public https address, following up to 3 redirects (each checked again), the body cut at `max`; null when refused or failed. */
async function getPublic(url: string, max: number, accept: string, deps: LogoFetchers): Promise<{ url: string; type: string; bytes: Buffer; truncated: boolean } | null> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    const checked = checkUrl(current);
    if (typeof checked === "string" || checked.protocol !== "https:") return null;
    const lookup = deps.lookupImpl ?? systemLookup;
    const address = await safeAddress(checked.hostname, (name) => Promise.race([lookup(name), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lookup timed out")), LOOKUP_TIMEOUT_MS).unref())]));
    if (typeof address === "string") return null;
    const signal = AbortSignal.timeout(LOGO_TIMEOUT_MS);
    try {
      const response = await abortable((deps.fetchImpl ?? nodeFetch)(checked.href, { headers: { accept, "user-agent": deps.userAgent ?? "VentureStudioOS-logo/1.0" }, signal, address }), signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        const next = response.headers.get("location");
        if (!next) return null;
        current = new URL(next, checked).href;
        continue;
      }
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); return null; }
      const { bytes, truncated } = await readCapped(response, max, signal);
      return { url: checked.href, type: response.headers.get("content-type") ?? "", bytes: Buffer.from(bytes), truncated };
    } catch { return null; }
  }
  return null;
}

/** The logo a company's website names (its best icon, else /apple-touch-icon.png, else /favicon.ico), as kept; null when there is none. */
export async function fetchLogo(host: string, deps: LogoFetchers = {}): Promise<Buffer | null> {
  const deadline = Date.now() + LOGO_DEADLINE_MS;
  const home = await getPublic(`https://${host}/`, MAX_HOME_BYTES, "text/html", deps);
  const named = home && /html/i.test(home.type) ? iconLinks(home.bytes.toString("utf8"), home.url) : [];
  for (const url of [...named, `https://${host}/apple-touch-icon.png`, `https://${host}/favicon.ico`].slice(0, 5)) {
    if (Date.now() > deadline) return null;
    const icon = await getPublic(url, MAX_ICON_BYTES, "image/*", deps);
    const logo = icon && !icon.truncated ? await logoFromImage(icon.bytes) : null;
    if (logo) return logo;
  }
  return null;
}

// At most two websites are read for logos at once in this process, and a short queue after that (more are skipped: the company keeps
// its initial, and a manager can set the website again later).
let reading = 0;
const queue: (() => void)[] = [];
/** fetchLogo, two at a time; null when the queue is full. */
export async function fetchLogoInTurn(host: string, deps: LogoFetchers = {}): Promise<Buffer | null> {
  if (reading >= 2) {
    if (queue.length >= 20) return null;
    await new Promise<void>((resolve) => queue.push(resolve));
  } else reading++;
  try { return await fetchLogo(host, deps); }
  finally { const next = queue.shift(); if (next) next(); else reading--; }
}

/** A fresh name for a logo's stored copy, so a changed logo is never served from an old cache. */
export const logoVersion = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
