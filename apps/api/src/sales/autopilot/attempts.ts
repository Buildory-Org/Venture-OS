// How often the autopilot tries the same item (a lead, a draft, a reply) before it leaves it for a person (autopilotItemSchema). A try is
// counted on the item once the day's call is reserved and right before the model is asked (`autopilot: { attempts, at, step, nextTryAt,
// lastError }`), so a call that fails on the item still counts. Tries back off (15 minutes, then 2 hours) and stop at AUTOPILOT_MAX_TRIES.
// A failure that is about us, not the item (no budget left, a rate limit, a timeout, no credit, the server stopping) gives the try back.
// Only a change to the item after the last try (its `updatedAt` moving past `autopilot.at`) starts the count again; the counter itself
// never moves `updatedAt`. A reply (an activity) has no `updatedAt`: a new reply is a new item.
import type { Collection, Document } from "mongodb";
import { AUTOPILOT_MAX_TRIES } from "@venture-studio/contracts";
import type { AppDocument } from "../../db.js";

export const MAX_TRIES = AUTOPILOT_MAX_TRIES;
/** The wait after the first and the second failed try. */
export const BACKOFF_MS = [15 * 60_000, 2 * 60 * 60_000] as const;
/** The wait after a try given back because Claude was busy: short, so one item can't take every pass's first call. */
export const BUSY_WAIT_MS = 5 * 60_000;

const time = (value: unknown) => (value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN);
const changedAfterMark = (item: AppDocument) => time(item.updatedAt) > time(item.autopilot?.at);

/** The tries that still count: none once the item changed after the last one. */
export function triesOf(item: AppDocument): number {
  const mark = item.autopilot;
  if (!mark || typeof mark !== "object") return 0;
  return changedAfterMark(item) ? 0 : Number(mark.attempts ?? 0);
}

/** Whether the autopilot may try this item now: under the stop, and not waiting (a back-off, or Claude was busy). */
export function mayTry(item: AppDocument, now: Date): boolean {
  if (triesOf(item) >= MAX_TRIES) return false;
  return changedAfterMark(item) || !(time(item.autopilot?.nextTryAt) > now.getTime());
}

/** The same rule as a query clause (`$expr`), so items at their stop or waiting never fill a page of candidates. */
export function triable(now: Date): Document {
  const at = { $ifNull: ["$autopilot.at", new Date(0)] };
  return { $expr: { $or: [
    { $gt: [{ $ifNull: ["$updatedAt", new Date(0)] }, at] },
    { $and: [{ $lt: [{ $ifNull: ["$autopilot.attempts", 0] }, MAX_TRIES] }, { $lte: [{ $ifNull: ["$autopilot.nextTryAt", new Date(0)] }, now] }] },
  ] } };
}

/** Items at their stop (unchanged since the last try), as a query clause: what the status counts under `stuck`. */
export const stoppedClause: Document = { $expr: { $and: [
  { $gte: [{ $ifNull: ["$autopilot.attempts", 0] }, MAX_TRIES] },
  { $lte: [{ $ifNull: ["$updatedAt", new Date(0)] }, { $ifNull: ["$autopilot.at", new Date(0)] }] },
] } };

export type Try = { mark: Record<string, unknown>; before: unknown };

/**
 * Counts one try on the item, only while the item is as it was read (so two workers never count one try twice). Undefined: it changed
 * meanwhile, skip it this pass. The try can be given back (giveBack).
 */
export async function countTry(collection: Collection<AppDocument>, item: AppDocument, step: string, now: Date): Promise<Try | undefined> {
  const tries = triesOf(item) + 1;
  const mark = { attempts: tries, at: now, step, ...(tries < MAX_TRIES ? { nextTryAt: new Date(now.getTime() + BACKOFF_MS[tries - 1]!) } : {}) };
  const same = item.autopilot?.at ? { "autopilot.at": item.autopilot.at } : { "autopilot.at": null };
  const changed = await collection.updateOne({ _id: item._id, ...same, ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}) }, { $set: { autopilot: mark } });
  return changed.modifiedCount ? { mark, before: item.autopilot ?? null } : undefined;
}

/**
 * Gives a try back: the failure was about us, not the item. The counter is as before; `waitUntil` (Claude was busy) only makes the item
 * wait a little, so the next pass starts with another one.
 */
export async function giveBack(collection: Collection<AppDocument>, id: unknown, taken: Try, waitUntil?: Date): Promise<void> {
  const before = (taken.before && typeof taken.before === "object" ? taken.before : null) as Record<string, unknown> | null;
  // Waiting moves `at` to now, so the count kept is the one that still counted (tries made before a later change don't come back).
  const restored = waitUntil ? { ...(before ?? {}), attempts: Number(taken.mark.attempts) - 1, at: taken.mark.at, nextTryAt: waitUntil } : before;
  await collection.updateOne({ _id: id as never, "autopilot.at": taken.mark.at }, restored ? { $set: { autopilot: restored } } : { $unset: { autopilot: "" } }).catch(() => undefined);
}

/** Keeps why the last try failed, as a short code (never text from a message, a page or a reply). */
export async function noteFailure(collection: Collection<AppDocument>, id: unknown, code: string): Promise<void> {
  await collection.updateOne({ _id: id as never }, { $set: { "autopilot.lastError": code } }).catch(() => undefined);
}
