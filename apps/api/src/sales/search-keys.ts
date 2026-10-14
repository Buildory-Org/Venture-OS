// Where the company-search keys (TinyFish, Exa) come from for a workspace: keys an admin saved in the app (Sales setup) win, then the API's
// environment (TINYFISH_API_KEY, EXA_API_KEY; several keys separated by commas). An engine may have up to 10 saved keys, tried in the order
// they were added (search-engines.ts withSearchKeys moves on when one is used up, refused or busy). Saved keys sit in sales_search_keys, one
// document per workspace, encrypted with AES-256-GCM under a data key derived from BETTER_AUTH_SECRET (HKDF-SHA256); a fresh IV per save, the
// auth tag kept, the workspace and engine bound in as associated data. A key that no longer decrypts (the secret changed, the record was
// damaged) reads as unreadable and is skipped. Keys are never logged or returned: people see an id, where a key comes from, a saved key's
// last four characters, and what it used this period.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ClientSession } from "mongodb";
import { MAX_SEARCH_KEYS, type SalesSearchEngine, type SalesSearchKeyEntry, type SalesSearchKeyStatus, type SalesSearchKeys } from "@venture-studio/contracts";
import type { AppDb } from "../db.js";
import { LEGACY_KEY_ID, SEARCH_CAPS, periodOf, usageId, type SearchKey, type SearchKeys } from "./search-engines.js";

/** The API's config (or the part of it this needs). Pass the whole config: without BETTER_AUTH_SECRET the keys saved in the app can't be read and only the environment's are used. */
export type SearchKeyEnv = { TINYFISH_API_KEY?: string | undefined; EXA_API_KEY?: string | undefined; BETTER_AUTH_SECRET?: string | undefined };
/** One saved key: its id, the ciphertext, its IV and GCM tag (base64), the format version, and what people may see about it. */
export type StoredSearchKey = { id?: string; v: number; iv: string; tag: string; data: string; last4: string; setBy: string; setAt: Date };
/** `tinyfish` / `exa` hold the one key saved before several were allowed (its id is "main"); the lists hold the keys added since. */
type StoredKeys = { _id: string; tinyfish?: StoredSearchKey; exa?: StoredSearchKey; tinyfishKeys?: StoredSearchKey[]; exaKeys?: StoredSearchKey[]; updatedAt?: Date };
type SavedKey = StoredSearchKey & { id: string };

const COLLECTION = "sales_search_keys";
const VERSION = 1;
const SALT = "vso-sales-search-keys-v1";
const CACHE_MS = 60_000;
const ENGINES: readonly SalesSearchEngine[] = ["tinyfish", "exa"];
const ENV_NAME = { tinyfish: "TINYFISH_API_KEY", exa: "EXA_API_KEY" } as const;
const LIST = { tinyfish: "tinyfishKeys", exa: "exaKeys" } as const;

const dataKey = (secret: string) => Buffer.from(hkdfSync("sha256", secret, SALT, "sales search keys: aes-256-gcm", 32));
// The workspace and engine are bound into each ciphertext, so a saved key can't be copied into another workspace's or engine's slot.
const boundTo = (workspaceId: string, engine: SalesSearchEngine) => Buffer.from(`${workspaceId}:${engine}`);
/** The server's keys for an engine: its environment variable, several keys separated by commas, each once. */
const envKeys = (env: SearchKeyEnv, engine: SalesSearchEngine): SearchKey[] =>
  [...new Set((env[ENV_NAME[engine]] ?? "").split(",").map((key) => key.trim()).filter(Boolean))].slice(0, MAX_SEARCH_KEYS).map((key, index) => ({ id: `server-${index + 1}`, key }));
/** An engine's saved keys in the order they are tried: the one saved before several were allowed first, then the others as they were added. */
const savedKeys = (doc: StoredKeys | null | undefined, engine: SalesSearchEngine): SavedKey[] => [
  ...(doc?.[engine] ? [{ ...doc[engine], id: LEGACY_KEY_ID }] : []),
  ...(doc?.[LIST[engine]] ?? []).filter((entry): entry is SavedKey => typeof entry?.id === "string"),
];

/** Encrypts one key for its workspace and engine, with a fresh 12-byte IV. */
export function sealSearchKey(secret: string, workspaceId: string, engine: SalesSearchEngine, key: string): Pick<StoredSearchKey, "v" | "iv" | "tag" | "data"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(secret), iv);
  cipher.setAAD(boundTo(workspaceId, engine));
  const data = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return { v: VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** The saved key in plain text, or undefined when it can't be read (no secret, another secret, a damaged record, an unknown version). */
function openSearchKey(secret: string | undefined, workspaceId: string, engine: SalesSearchEngine, stored: StoredSearchKey | undefined): string | undefined {
  if (!secret || !stored || stored.v !== VERSION) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey(secret), Buffer.from(stored.iv, "base64"), { authTagLength: 16 });
    decipher.setAAD(boundTo(workspaceId, engine));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8") || undefined;
  } catch { return undefined; }
}

// ---- The 60-second cache of each workspace's saved keys (per database, so separate apps in one process never share it) -------------------

type Slot = { at: number; doc?: StoredKeys | null };
const cache = new WeakMap<AppDb, Map<string, Slot>>();

async function storedKeys(db: AppDb, workspaceId: string): Promise<StoredKeys | null> {
  let slots = cache.get(db);
  if (!slots) { slots = new Map(); cache.set(db, slots); }
  const hit = slots.get(workspaceId);
  if (hit?.doc !== undefined && Date.now() - hit.at < CACHE_MS) return hit.doc;
  const slot: Slot = { at: Date.now() };
  slots.set(workspaceId, slot);
  const doc = await db.collection(COLLECTION).findOne({ _id: workspaceId }) as StoredKeys | null;
  // A save or delete while this read was out dropped the slot: what was read before it is not kept.
  if (slots.get(workspaceId) === slot) slot.doc = doc;
  return doc;
}

/** Drops the cached keys of a workspace in this process: call it after a save or delete has committed. */
export function forgetSearchKeys(db: AppDb, workspaceId: string): void { cache.get(db)?.delete(workspaceId); }

/** The readable keys saved in the app for one engine, in order. */
const openSaved = (env: SearchKeyEnv, workspaceId: string, engine: SalesSearchEngine, doc: StoredKeys | null | undefined): SearchKey[] =>
  savedKeys(doc, engine).flatMap((entry) => { const key = openSearchKey(env.BETTER_AUTH_SECRET, workspaceId, engine, entry); return key ? [{ id: entry.id, key }] : []; });

/** The keys search uses for this workspace, per engine and in order: the keys saved in the app, else the environment's. A saved key that can't be read is skipped. */
export async function resolveSearchKeys(db: AppDb, workspaceId: string, env: SearchKeyEnv): Promise<SearchKeys> {
  const stored = await storedKeys(db, workspaceId);
  const pick = (engine: SalesSearchEngine) => { const saved = openSaved(env, workspaceId, engine, stored); return saved.length ? saved : envKeys(env, engine); };
  return { tinyfish: pick("tinyfish"), exa: pick("exa") };
}

// ---- Adding, removing and the status admins see ---------------------------------------------------------------------------------------

/**
 * Adds one key to an engine, encrypted, after the ones saved before. Refused when the same key is already saved, or the engine already has
 * MAX_SEARCH_KEYS keys. Run it in a transaction (the caller's `session`) so two admins adding at once can't pass the limit; the caller clears
 * the cache with forgetSearchKeys once the write has committed.
 */
export async function addSearchKey(db: AppDb, workspaceId: string, engine: SalesSearchEngine, key: string, secret: string, userId: string, session?: ClientSession): Promise<{ added: string } | { refused: "duplicate" | "full" }> {
  const doc = await db.collection(COLLECTION).findOne({ _id: workspaceId }, { session }) as StoredKeys | null;
  const saved = savedKeys(doc, engine);
  if (saved.some((entry) => openSearchKey(secret, workspaceId, engine, entry) === key)) return { refused: "duplicate" };
  if (saved.length >= MAX_SEARCH_KEYS) return { refused: "full" };
  const now = new Date();
  const id = randomBytes(6).toString("hex");
  const entry: SavedKey = { id, ...sealSearchKey(secret, workspaceId, engine, key), last4: key.slice(-4), setBy: userId, setAt: now };
  // The list's last free slot must still be free when the key goes in (the key saved before several were allowed takes one slot), so two
  // admins adding at once can't pass the limit even where there is no transaction; a full document then makes the upsert's insert collide.
  const lastSlot = `${LIST[engine]}.${MAX_SEARCH_KEYS - (doc?.[engine] ? 1 : 0) - 1}`;
  try {
    await db.collection(COLLECTION).updateOne({ _id: workspaceId, [lastSlot]: { $exists: false } }, { $push: { [LIST[engine]]: entry } as never, $set: { updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true, session });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return { refused: "full" };
    throw error;
  }
  return { added: id };
}

/** Removes one saved key; false when no such key was saved. With no saved key left, the environment's keys (if any) are used again. */
export async function removeSearchKey(db: AppDb, workspaceId: string, engine: SalesSearchEngine, keyId: string, session?: ClientSession): Promise<boolean> {
  const collection = db.collection(COLLECTION);
  const result = keyId === LEGACY_KEY_ID
    ? await collection.updateOne({ _id: workspaceId, [engine]: { $exists: true } }, { $unset: { [engine]: "" }, $set: { updatedAt: new Date() } }, { session })
    : await collection.updateOne({ _id: workspaceId, [`${LIST[engine]}.id`]: keyId }, { $pull: { [LIST[engine]]: { id: keyId } } as never, $set: { updatedAt: new Date() } }, { session });
  return result.modifiedCount > 0;
}

/**
 * Per engine: whether search can use it, where its keys come from, and each key (read fresh, not cached): its id, where it comes from, a
 * saved key's last four characters and who saved it when, whether it can't be read, and what it used this period against its allowance
 * (used up when it reached it, or while it is paused after a refusal). Saved keys that can't be read are listed too; the server's keys only
 * while they are the ones used.
 * Never a key.
 */
export async function searchKeyStatus(db: AppDb, workspaceId: string, env: SearchKeyEnv): Promise<SalesSearchKeys> {
  const stored = await db.collection(COLLECTION).findOne({ _id: workspaceId }) as StoredKeys | null;
  const setters = [...new Set(ENGINES.flatMap((engine) => savedKeys(stored, engine).flatMap((entry) => typeof entry.setBy === "string" ? [entry.setBy] : [])))];
  const names = new Map(setters.length ? (await db.collection("users").find({ _id: { $in: setters } }, { projection: { name: 1 } }).toArray()).map((user) => [String(user._id), String(user.name ?? "")]) : []);
  const listed = Object.fromEntries(ENGINES.map((engine) => {
    const saved = savedKeys(stored, engine).map((entry) => ({ entry, readable: openSearchKey(env.BETTER_AUTH_SECRET, workspaceId, engine, entry) !== undefined }));
    const server = saved.some((item) => item.readable) ? [] : envKeys(env, engine);
    return [engine, { saved, server }];
  })) as Record<SalesSearchEngine, { saved: { entry: SavedKey; readable: boolean }[]; server: SearchKey[] }>;
  const ids = ENGINES.flatMap((engine) => [...listed[engine].saved.map((item) => item.entry.id), ...listed[engine].server.map((key) => key.id)].map((id) => usageId(workspaceId, engine, id, periodOf(engine))));
  const usage = new Map(ids.length ? (await db.collection("mcp_search_usage").find({ _id: { $in: ids as never[] } }, { projection: { calls: 1, refusedUntil: 1 } }).toArray()).map((row) => [String(row._id), row]) : []);
  const now = Date.now();
  const one = (engine: SalesSearchEngine): SalesSearchKeyStatus => {
    const { limit, period } = SEARCH_CAPS[engine];
    const used = (id: string) => {
      const row = usage.get(usageId(workspaceId, engine, id, periodOf(engine)));
      const calls = Number.isInteger(row?.calls) ? Number(row!.calls) : 0;
      const paused = row?.refusedUntil instanceof Date && row.refusedUntil.getTime() > now;
      return { used: calls, limit, period, ...(paused || calls >= limit ? { usedUp: true } : {}) };
    };
    const keys: SalesSearchKeyEntry[] = [
      ...listed[engine].saved.map(({ entry, readable }) => ({
        id: entry.id, source: "app" as const, last4: String(entry.last4 ?? "").slice(-4),
        ...(entry.setAt instanceof Date ? { setAt: entry.setAt.toISOString() } : {}), ...(typeof entry.setBy === "string" ? { setBy: entry.setBy, ...(names.get(entry.setBy) ? { setByName: names.get(entry.setBy)! } : {}) } : {}),
        ...(readable ? {} : { unreadable: true }), ...used(entry.id),
      })),
      ...listed[engine].server.map((key) => ({ id: key.id, source: "server" as const, ...used(key.id) })),
    ];
    const readable = listed[engine].saved.some((item) => item.readable);
    return { set: readable || listed[engine].server.length > 0, source: readable ? "app" : listed[engine].server.length ? "server" : null, keys };
  };
  return { tinyfish: one("tinyfish"), exa: one("exa") };
}
