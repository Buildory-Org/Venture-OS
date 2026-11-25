// Sender protection (docs/sales-autopilot.md section 5a): what keeps a mailbox, and the domain behind it, in good standing while the app
// sends for it. Receiving mail servers judge a sender by how it behaves, so the app behaves like a careful person:
//
// - A warm-up limit. A mailbox starts at 5 cold emails a day through the send queue and gains 5 more after every 5 days it has sent on
//   (counted over the last 30 days), up to the venture's daily cap. "Cold" is a first message or a follow-up; answers to replies never count.
//   Every cold email sent through the app counts; only the send queue is held to the limit (a person's own "Send now" is their decision).
// - A bad address is never mailed twice. An address that bounced, that the mail server refused, or whose domain takes no mail is kept in
//   `sales_bad_addresses`: no first message or follow-up goes to it again from the app, by hand or from the queue.
// - Bounces pause the mailbox. Three bounces among a mailbox's last 50 emails (two weeks) stop its queue for three days and start its
//   warm-up again at 5 a day.
// - The mail server's own push-back pauses it too: "slow down" (a 4xx answer) for an hour, a policy or rate block until the next working
//   day, a refused password until it is entered again (tried again every 6 hours).
// - Automatic sending (no person's approval) needs the sending domain to publish SPF and DMARC records.
//
// Each pause is audited and told to the mailbox's owner once, in plain words. Nothing here sends anything.
import { Resolver } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { audit } from "../../audit.js";
import type { AppDb, AppDocument } from "../../db.js";
import type { SalesCtx } from "../ctx.js";
import { isSharedDomain, normalizeEmail } from "../suppression.js";
import { SALES_TZ, localDay, shiftDate, type WorkCalendar } from "../workdays.js";

/** The connected accounts' collection (accounts.ts ACCOUNTS; named here too so the two files don't import each other in a circle). */
const ACCOUNTS = "sales_channel_accounts";

export const MAILBOX_DAYS = "sales_mailbox_days";
export const BAD_ADDRESSES = "sales_bad_addresses";

/** The warm-up: this many cold emails a day at first, this many more after every WARMUP_DAYS_PER_STEP days the mailbox sent on. */
export const WARMUP_START = 5;
export const WARMUP_STEP = 5;
export const WARMUP_DAYS_PER_STEP = 5;
/** Sending days older than this no longer count: a mailbox that went quiet for a month warms up again. */
export const WARMUP_WINDOW_DAYS = 30;
/** This many bounces among the mailbox's last BOUNCE_WINDOW emails (sent in the last BOUNCE_WINDOW_DAYS) pause it for BOUNCE_PAUSE_MS. */
export const BOUNCE_LIMIT = 3;
export const BOUNCE_WINDOW = 50;
export const BOUNCE_WINDOW_DAYS = 14;
export const BOUNCE_PAUSE_MS = 72 * 60 * 60_000;
/** The mail server asked to slow down (a 4xx answer): the queue waits this long. */
export const SLOW_DOWN_PAUSE_MS = 60 * 60_000;
/** A refused password is tried again this much later (and at once after a passing test or a new password). */
export const PASSWORD_PAUSE_MS = 6 * 60 * 60_000;
/** Automatic sending waits this long before it looks at the domain's records again. */
export const DNS_RECHECK_MS = 6 * 60 * 60_000;
const DNS_GOOD_MS = 24 * 60 * 60_000;
const DNS_BAD_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/** Why a send certainly did not go out, where the reason changes what happens next (provider.ts SendOutcome). */
export type FailureKind = "password" | "slow_down" | "blocked" | "address";
export type PauseKind = "bounces" | "slow_down" | "blocked" | "password";
export type DnsState = "ok" | "missing" | "unknown";
export type SenderRecords = { checkedAt: Date; spf: DnsState; dmarc: DnsState };
/** `guard` on a mailbox's row in `sales_channel_accounts`. */
export type Guard = {
  pausedUntil?: Date; pausedAt?: Date; pauseKind?: PauseKind; pauseReason?: string;
  /** The warm-up counts sending days from here (set when bounces paused the mailbox). */
  rampSince?: Date;
  /** The earliest moment the queue sends this mailbox's next message, whichever venture it is for. */
  nextAt?: Date;
  dns?: SenderRecords;
  /** The limit the last cold send was held to, for people to see ("up to 5 a day"). */
  dayLimit?: { day: string; limit: number; cap: number };
};

const date = (value: unknown): Date | undefined => (value instanceof Date ? value : undefined);
export function guardOf(account: AppDocument | null | undefined): Guard {
  const raw = (account?.guard ?? {}) as Record<string, unknown>;
  const dns = raw.dns as Partial<SenderRecords> | undefined;
  const limit = raw.dayLimit as Guard["dayLimit"] | undefined;
  return {
    ...(date(raw.pausedUntil) ? { pausedUntil: raw.pausedUntil as Date } : {}), ...(date(raw.pausedAt) ? { pausedAt: raw.pausedAt as Date } : {}),
    ...(typeof raw.pauseKind === "string" ? { pauseKind: raw.pauseKind as PauseKind } : {}), ...(typeof raw.pauseReason === "string" ? { pauseReason: raw.pauseReason } : {}),
    ...(date(raw.rampSince) ? { rampSince: raw.rampSince as Date } : {}), ...(date(raw.nextAt) ? { nextAt: raw.nextAt as Date } : {}),
    ...(dns && date(dns.checkedAt) && dns.spf && dns.dmarc ? { dns: { checkedAt: dns.checkedAt as Date, spf: dns.spf, dmarc: dns.dmarc } } : {}),
    ...(limit && typeof limit.day === "string" && typeof limit.limit === "number" && typeof limit.cap === "number" ? { dayLimit: limit } : {}),
  };
}

const addressOf = (account: AppDocument) => String((account.settings as { address?: unknown } | undefined)?.address ?? "").trim();
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
const shortDate = (at: Date, timeZone = SALES_TZ) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(at);
const shortMoment = (at: Date, timeZone = SALES_TZ) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(at);

/** A first message or a follow-up: mail to someone who has not written to us. An answer to a reply is not cold. */
export const isCold = (purpose: unknown): boolean => purpose === "first_touch" || purpose === "follow_up";

// ---- The warm-up limit -------------------------------------------------------------------------------------------------------------

/** The limit for a mailbox that has sent on `days` days: 5, then 5 more per 5 days, never above the venture's cap. */
export const warmupLimit = (days: number, cap: number): number => Math.max(0, Math.min(cap, WARMUP_START + WARMUP_STEP * Math.floor(Math.max(0, days) / WARMUP_DAYS_PER_STEP)));

/**
 * How many cold emails the mailbox may send through the queue on `day` (the venture's local day): from the days before it, in the last 30
 * and since its last bounce pause, on which it sent at least one.
 */
export async function mailboxDayLimit(db: AppDb, account: AppDocument, cap: number, day: string, cal: WorkCalendar): Promise<number> {
  const since = guardOf(account).rampSince;
  const window = shiftDate(day, -WARMUP_WINDOW_DAYS);
  const sinceDay = since ? localDay(since, cal) : window;
  const from = sinceDay > window ? sinceDay : window;
  const days = await db.collection(MAILBOX_DAYS).countDocuments({ accountId: String(account._id), day: { $gte: from, $lt: day }, count: { $gt: 0 } });
  return warmupLimit(days, cap);
}

/** The mailbox's warm-up limit for the day is used up: the send queue waits for the next working day. */
export class MailboxLimitReached extends Error {
  constructor(readonly limit: number, address: string) {
    super(`${address || "This mailbox"} is warming up: it sends up to ${limit} first messages and follow-ups a day for now, and today's are used. The rest go on the next working day`);
  }
}

/**
 * Takes one of the mailbox's cold sends for the day (one row per mailbox and local day in `sales_mailbox_days`). Every cold email sent
 * through the app is counted; with `enforce` (the send queue) the claim is refused once the day's limit is reached. Returns the function
 * that gives the send back when nothing went out.
 */
export async function claimMailboxSlot(db: AppDb, account: AppDocument, options: { cap: number; cal: WorkCalendar; now: Date; enforce: boolean }): Promise<() => Promise<void>> {
  const accountId = String(account._id);
  const day = localDay(options.now, options.cal);
  const limit = await mailboxDayLimit(db, account, options.cap, day, options.cal);
  const rows = db.collection(MAILBOX_DAYS);
  const _id = `${accountId}:${day}`;
  if (options.enforce && limit <= 0) throw new MailboxLimitReached(limit, addressOf(account));
  try {
    // One write: the row is made on the day's first send; with a limit, a full row doesn't match and the insert collides with it.
    await rows.updateOne({ _id: _id as never, ...(options.enforce ? { count: { $lt: limit } } : {}) }, { $inc: { count: 1 }, $set: { updatedAt: options.now }, $setOnInsert: { workspaceId: String(account.workspaceId), accountId, day, createdAt: options.now } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    if (options.enforce) {
      // Either the day is full, or two first sends of the day raced to make the row: once more, without the upsert.
      const again = await rows.updateOne({ _id: _id as never, count: { $lt: limit } }, { $inc: { count: 1 }, $set: { updatedAt: options.now } });
      if (!again.matchedCount) throw new MailboxLimitReached(limit, addressOf(account));
    } else {
      await rows.updateOne({ _id: _id as never }, { $inc: { count: 1 }, $set: { updatedAt: options.now } });
    }
  }
  await db.collection(ACCOUNTS).updateOne({ _id: account._id }, { $set: { "guard.dayLimit": { day, limit, cap: options.cap } } }).catch(() => undefined);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rows.updateOne({ _id: _id as never, count: { $gt: 0 } }, { $inc: { count: -1 } }).catch(() => undefined);
  };
}

/** A counted cold send that turned out not to have gone ("It didn't go"): given back when it was that day's (never below zero). */
export async function releaseMailboxSlot(db: AppDb, accountId: string, day: string): Promise<void> {
  await db.collection(MAILBOX_DAYS).updateOne({ _id: `${accountId}:${day}` as never, count: { $gt: 0 } }, { $inc: { count: -1 } }).catch(() => undefined);
}

// ---- Addresses that don't take mail ------------------------------------------------------------------------------------------------

export type BadAddressKind = "bounced" | "refused" | "no_mail_server";
const badId = (workspaceId: string, email: string) => `${workspaceId}:${email}`;

/** Remembers an address that doesn't take mail (the first reason is kept). False when the address can't be read as one. */
export async function noteBadAddress(db: AppDb, entry: { workspaceId: string; email: string; kind: BadAddressKind; reason: string; leadId?: string | undefined; accountId?: string | undefined; at: Date }): Promise<boolean> {
  const email = normalizeEmail(entry.email);
  if (!email) return false;
  await db.collection(BAD_ADDRESSES).updateOne({ _id: badId(entry.workspaceId, email) as never }, { $setOnInsert: {
    workspaceId: entry.workspaceId, email, kind: entry.kind, reason: entry.reason.slice(0, 300), at: entry.at, createdAt: entry.at,
    ...(entry.leadId ? { leadId: entry.leadId } : {}), ...(entry.accountId ? { accountId: entry.accountId } : {}),
  } }, { upsert: true });
  return true;
}

const BAD_WORDS: Record<BadAddressKind, string> = { bounced: "bounced", refused: "was refused by the mail server", no_mail_server: "can't receive mail (its domain has no mail server)" };

/** Why the app won't send a first message or a follow-up to this address, in the words people see. */
export function badAddressWords(row: AppDocument): string {
  const at = date(row.at);
  const kind = (typeof row.kind === "string" && row.kind in BAD_WORDS ? row.kind : "bounced") as BadAddressKind;
  return `${String(row.email)} ${BAD_WORDS[kind]}${at && kind !== "no_mail_server" ? ` on ${shortDate(at)}` : ""}, so the app won't email it again: put another address on the lead, or send it from your own mail and mark it sent`;
}

const firstEmail = (lead: AppDocument): string | undefined => {
  const routes = Array.isArray(lead.contactRoutes) ? lead.contactRoutes as { kind?: unknown; value?: unknown }[] : [];
  const value = routes.find((route) => route?.kind === "email" && typeof route.value === "string" && route.value.trim())?.value;
  return typeof value === "string" ? value.trim() : undefined;
};

/**
 * Why this cold email can't go to the lead's address (it is on the list of addresses that don't take mail), or undefined. `message`: a
 * draft, or the channel and purpose of one about to be written.
 */
export async function addressBlocker(ctx: Pick<SalesCtx, "db" | "workspaceId">, message: AppDocument | { channel: unknown; purpose: unknown }, lead: AppDocument): Promise<string | undefined> {
  const { channel, purpose } = message as { channel?: unknown; purpose?: unknown };
  if (channel !== "email" || !isCold(purpose)) return undefined;
  const email = normalizeEmail(firstEmail(lead) ?? "");
  if (!email) return undefined;
  const row = await ctx.db.collection(BAD_ADDRESSES).findOne({ _id: badId(ctx.workspaceId, email) as never });
  return row ? badAddressWords(row) : undefined;
}

// ---- Pauses ------------------------------------------------------------------------------------------------------------------------

/** One notice for one person; the same key is never queued twice. The link opens Sales > Channels. */
async function tellOwner(db: AppDb, account: AppDocument, notice: { key: string; title: string; body: string; resourceType?: string; resourceId?: string; userId?: string | undefined }, now: Date): Promise<void> {
  const userId = notice.userId ?? (typeof account.ownerUserId === "string" ? account.ownerUserId : undefined);
  if (!userId) return;
  await db.collection("notification_outbox").updateOne({ idempotencyKey: notice.key }, { $setOnInsert: {
    _id: randomUUID(), workspaceId: String(account.workspaceId), userId, type: "sales_needs_you", title: notice.title.slice(0, 200), body: notice.body.slice(0, 500),
    resourceType: notice.resourceType ?? "channel_account", resourceId: notice.resourceId ?? String(account._id), idempotencyKey: notice.key, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
  } }, { upsert: true });
}

/** The pause the mailbox is under at `now`, or undefined. */
export function pausedNow(account: AppDocument | null | undefined, now: Date): { until: Date; reason: string; kind: PauseKind } | undefined {
  const guard = guardOf(account);
  if (!guard.pausedUntil || guard.pausedUntil.getTime() <= now.getTime()) return undefined;
  return { until: guard.pausedUntil, reason: guard.pauseReason ?? "Sending is paused", kind: guard.pauseKind ?? "blocked" };
}

/** "Sending from x is paused until Thu, 26 Nov, 10:00: why." for the mailbox's card and the Autopilot card. */
export function pauseWords(account: AppDocument, now: Date, timeZone = SALES_TZ): string | undefined {
  const pause = pausedNow(account, now);
  if (!pause) return undefined;
  const until = pause.kind === "password" ? "" : ` until ${shortMoment(pause.until, timeZone)}`;
  return `The send queue is paused for ${addressOf(account) || "this mailbox"}${until}: ${pause.reason.replace(/[.\s]+$/, "")}.`;
}

const PAUSE_TITLE: Record<PauseKind, string> = { bounces: "Sending paused: too many bounces", slow_down: "Sending slowed down", blocked: "Sending paused by the mail server", password: "Your mailbox needs its password again" };

/**
 * Pauses the mailbox's send queue until `until` (a pause that already lasts longer stays). The emails stay in the queue. Audited, and the
 * owner is told once per pause. `restartWarmup`: the warm-up starts again at 5 a day (after bounces). True when this call paused it.
 */
export async function pauseMailbox(db: AppDb, account: AppDocument, pause: { kind: PauseKind; reason: string; until: Date; restartWarmup?: boolean; tell?: string }, now: Date): Promise<boolean> {
  const set: Record<string, unknown> = { "guard.pausedUntil": pause.until, "guard.pausedAt": now, "guard.pauseKind": pause.kind, "guard.pauseReason": pause.reason.slice(0, 300), ...(pause.restartWarmup ? { "guard.rampSince": now } : {}) };
  const changed = await db.collection(ACCOUNTS).updateOne({ _id: account._id, $or: [{ "guard.pausedUntil": null }, { "guard.pausedUntil": { $lt: pause.until } }] }, { $set: set });
  if (!changed.modifiedCount) return false;
  const address = addressOf(account);
  await audit(db, { workspaceId: String(account.workspaceId), actorId: null, channel: "engine", action: "sales.channel.pause", objectType: "channel_account", objectId: String(account._id), ventureId: String((account.ventureIds as unknown[] | undefined)?.[0] ?? ""), result: "success", metadata: { kind: pause.kind, until: pause.until.toISOString() } });
  // One notice a day per kind: a mailbox that is pushed back hour after hour doesn't fill the bell.
  const body = pause.tell ?? `${address || "Your mailbox"}: ${pause.reason.replace(/[.\s]+$/, "")}. The emails wait in the send queue${pause.kind === "password" ? "" : ` and go on from ${shortMoment(pause.until)}`}.`;
  await tellOwner(db, account, { key: `mailbox:${String(account._id)}:pause:${pause.kind}:${localDay(now)}`, title: PAUSE_TITLE[pause.kind], body }, now);
  return true;
}

/**
 * Lifts a pause of this kind (a new password, a passing test). The owner's queued emails that were waiting for it are due again now; the
 * queue worker spaces them out and keeps them in working hours as it sends.
 */
export async function clearPause(db: AppDb, account: AppDocument, kind: PauseKind, now: Date): Promise<boolean> {
  const cleared = await db.collection(ACCOUNTS).updateOne({ _id: account._id, "guard.pauseKind": kind }, { $unset: { "guard.pausedUntil": "", "guard.pausedAt": "", "guard.pauseKind": "", "guard.pauseReason": "" } });
  if (!cleared.modifiedCount) return false;
  const ventureIds = Array.isArray(account.ventureIds) ? account.ventureIds.map(String) : [];
  if (typeof account.ownerUserId === "string" && ventureIds.length) {
    await db.collection("sales_drafts").updateMany({ workspaceId: String(account.workspaceId), ventureId: { $in: ventureIds }, "sendQueue.by": account.ownerUserId, "sendQueue.notBefore": { $gt: now }, sendLock: null }, { $set: { "sendQueue.notBefore": now } });
  }
  return true;
}

/** After a queue send: the mailbox's next message waits until `next`, whichever venture it is for. */
export async function spaceMailbox(db: AppDb, accountId: string, next: Date): Promise<void> {
  await db.collection(ACCOUNTS).updateOne({ _id: accountId }, { $set: { "guard.nextAt": next } }).catch(() => undefined);
}

// ---- Bounces -----------------------------------------------------------------------------------------------------------------------

/**
 * Looks at the mailbox's last emails (BOUNCE_WINDOW of them, from the last two weeks and since its last bounce pause): BOUNCE_LIMIT
 * bounces pause its queue for three days and start its warm-up again. True when it paused.
 */
export async function checkBounces(db: AppDb, accountId: string, now: Date): Promise<boolean> {
  const account = await db.collection(ACCOUNTS).findOne({ _id: accountId });
  if (!account) return false;
  const since = Math.max(now.getTime() - BOUNCE_WINDOW_DAYS * DAY_MS, guardOf(account).rampSince?.getTime() ?? 0);
  const recent = await db.collection("sales_activities").find({ "message.accountId": accountId, workspaceId: String(account.workspaceId), direction: "out", kind: "email", at: { $gte: new Date(since) } }, { projection: { "message.delivery.state": 1 } }).sort({ at: -1 }).limit(BOUNCE_WINDOW).toArray();
  const bounced = recent.filter((row) => (row.message as { delivery?: { state?: unknown } } | undefined)?.delivery?.state === "bounced").length;
  if (bounced < BOUNCE_LIMIT) return false;
  const reason = `${bounced} of its last ${recent.length} emails bounced`;
  return pauseMailbox(db, account, {
    kind: "bounces", reason, until: new Date(now.getTime() + BOUNCE_PAUSE_MS), restartWarmup: true,
    tell: `${addressOf(account) || "Your mailbox"}: ${reason}, which hurts how mail servers rate your domain. The send queue is paused until ${shortMoment(new Date(now.getTime() + BOUNCE_PAUSE_MS))} and then starts again at ${WARMUP_START} a day. Check the addresses of the emails that wait.`,
  }, now);
}

/**
 * A sent email bounced: its address is remembered (never mailed again), its sender is told once, and the mailbox's bounces are counted
 * (checkBounces). Safe to call again for the same bounce.
 */
export async function noteBounce(db: AppDb, input: { account: AppDocument; activity?: AppDocument | null | undefined; draft?: AppDocument | null | undefined; reason: string; now: Date }): Promise<void> {
  const { account, activity, draft, now } = input;
  const workspaceId = String(account.workspaceId);
  const accountId = String(account._id);
  const leadId = typeof activity?.leadId === "string" ? activity.leadId : typeof draft?.leadId === "string" ? draft.leadId : undefined;
  const to = (activity?.message as { to?: unknown } | undefined)?.to ?? (draft?.delivery as { to?: unknown } | undefined)?.to;
  if (typeof to === "string") await noteBadAddress(db, { workspaceId, email: to, kind: "bounced", reason: input.reason, leadId, accountId, at: now });
  const draftId = typeof activity?.draftId === "string" ? activity.draftId : draft ? String(draft._id) : undefined;
  const sender = typeof draft?.sentBy === "string" ? draft.sentBy : typeof activity?.actorId === "string" ? activity.actorId : undefined;
  if (draftId && leadId) {
    const lead = await db.collection("opportunities").findOne({ _id: leadId, workspaceId }, { projection: { companyName: 1 } });
    await tellOwner(db, account, {
      key: `draft:${draftId}:bounced`, userId: sender, resourceType: "opportunity", resourceId: leadId, title: `Bounced: email to ${String(lead?.companyName ?? "a lead")}`,
      body: `${input.reason.replace(/[.\s]+$/, "")}. The app won't email that address again: put another address on the lead, or call.`,
    }, now);
  }
  await checkBounces(db, accountId, now);
}

// ---- The domain's records and the lead's mail server ---------------------------------------------------------------------------------

/** The part of a DNS resolver the checks use, so tests hand in their own. */
export type GuardDns = {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string }[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
};

/**
 * A test run: NODE_ENV=test, or Node's own test runner, which marks the process of every test file it starts
 * (NODE_TEST_CONTEXT). `npm test` sets no NODE_ENV, so the second is what keeps the tests off the network.
 */
const underTest = process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT !== undefined;
/** Real DNS, with short waits. In a test run nothing is looked up unless a test hands in a resolver. */
let dns: GuardDns | null = underTest ? null : new Resolver({ timeout: 4_000, tries: 2 });
/** Tests only: the resolver the checks use (null: no lookups); returns the function that puts the previous one back. */
export function useGuardDnsForTests(resolver: GuardDns | null): () => void {
  if (process.env.NODE_ENV === "production") throw new Error("useGuardDnsForTests is for tests only");
  const before = dns;
  dns = resolver;
  mxCache.clear();
  return () => { dns = before; mxCache.clear(); };
}

const codeOf = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? "");
/** The name has no such record (or doesn't exist): a definite "no", unlike a lookup that timed out. */
const noRecord = (error: unknown) => codeOf(error) === "ENODATA" || codeOf(error) === "ENOTFOUND";

async function txtState(resolver: GuardDns, name: string, prefix: string): Promise<DnsState> {
  try {
    const records = await resolver.resolveTxt(name);
    return records.some((chunks) => chunks.join("").trim().toLowerCase().startsWith(prefix)) ? "ok" : "missing";
  } catch (error) {
    return noRecord(error) ? "missing" : "unknown";
  }
}

/**
 * Whether the sending domain publishes an SPF record and a DMARC record (its own, or a parent domain's down to two labels). A shared
 * mail domain (gmail.com and the like) is its provider's business: read as fine. "unknown": the lookup itself failed.
 */
export async function lookUpSenderRecords(domain: string): Promise<{ spf: DnsState; dmarc: DnsState }> {
  if (!dns || !domain) return { spf: "unknown", dmarc: "unknown" };
  if (isSharedDomain(domain)) return { spf: "ok", dmarc: "ok" };
  const spf = await txtState(dns, domain, "v=spf1");
  const labels = domain.split(".").filter(Boolean);
  let dmarc: DnsState = "missing";
  for (let index = 0; index <= labels.length - 2; index++) {
    const state = await txtState(dns, `_dmarc.${labels.slice(index).join(".")}`, "v=dmarc1");
    if (state === "ok") { dmarc = "ok"; break; }
    if (state === "unknown") dmarc = "unknown";
  }
  return { spf, dmarc };
}

/**
 * The mailbox's domain records, looked up at most once a day (once an hour while something is missing, so a fix shows soon) and kept on
 * the mailbox. `force`: look now (the Test button). Undefined when nothing could be looked up.
 */
export async function senderRecordsFor(db: AppDb, account: AppDocument, now: Date, force = false): Promise<SenderRecords | undefined> {
  const cached = guardOf(account).dns;
  const fine = cached?.spf === "ok" && cached.dmarc === "ok";
  if (cached && !force && now.getTime() - cached.checkedAt.getTime() < (fine ? DNS_GOOD_MS : DNS_BAD_MS)) return cached;
  const domain = domainOf(addressOf(account));
  if (!dns || !domain) return cached;
  const fresh: SenderRecords = { checkedAt: now, ...(await lookUpSenderRecords(domain)) };
  await db.collection(ACCOUNTS).updateOne({ _id: account._id }, { $set: { "guard.dns": fresh } }).catch(() => undefined);
  return fresh;
}

/** What is missing on the sending domain, in plain words, or undefined (also when the lookup failed: nothing is held for that). */
export function recordsProblem(account: AppDocument, records: SenderRecords | undefined): string | undefined {
  if (!records) return undefined;
  const missing = [records.spf === "missing" ? "SPF" : "", records.dmarc === "missing" ? "DMARC" : ""].filter(Boolean);
  if (!missing.length) return undefined;
  const domain = domainOf(addressOf(account)) || "The sending domain";
  return `${domain} has no ${missing.join(" or ")} record, so mail servers can't tell its mail is really yours and may treat it as spam: add ${missing.length > 1 ? "them" : "it"} where the domain is managed`;
}

const mxCache = new Map<string, { at: number; ok: boolean }>();
const MX_CACHE_MAX = 5_000;

/**
 * Whether the address's domain takes mail at all: it has a mail server (MX), or at least an address mail falls back to. False only on a
 * definite "no" (the domain doesn't exist, or says it takes no mail); a lookup that fails lets the message go.
 */
export async function canReceiveMail(address: string, now = Date.now()): Promise<boolean> {
  const domain = domainOf(address);
  if (!dns || !domain || isSharedDomain(domain)) return true;
  const cached = mxCache.get(domain);
  if (cached && now - cached.at < (cached.ok ? DNS_GOOD_MS : DNS_BAD_MS)) return cached.ok;
  let ok = true;
  try {
    const servers = await dns.resolveMx(domain);
    // A single "." is the domain saying it takes no mail (RFC 7505).
    ok = servers.some((server) => server.exchange && server.exchange !== ".");
  } catch (error) {
    if (codeOf(error) === "ENOTFOUND") ok = false;
    else if (codeOf(error) === "ENODATA") {
      // No mail server named: mail falls back to the domain's own address (IPv4 or IPv6). Only "neither exists" is a definite no.
      const has = async (look: (name: string) => Promise<string[]>): Promise<boolean | undefined> => {
        try { return (await look(domain)).length > 0; }
        catch (fallback) { return noRecord(fallback) ? false : undefined; }
      };
      const resolver = dns;
      const v4 = await has((name) => resolver.resolve4(name));
      ok = v4 === false ? (await has((name) => resolver.resolve6(name))) !== false : true;
    }
  }
  if (mxCache.size >= MX_CACHE_MAX) mxCache.clear();
  mxCache.set(domain, { at: now, ok });
  return ok;
}

// ---- What people see on the mailbox ------------------------------------------------------------------------------------------------

/** `protection` on a mailbox as the API returns it: a pause, what the domain lacks, and the warm-up limit while it is below the cap. */
export function protectionOf(account: AppDocument, now = new Date()): Record<string, unknown> | undefined {
  if (account.kind !== "email") return undefined;
  const guard = guardOf(account);
  const pause = pausedNow(account, now);
  const domainNote = recordsProblem(account, guard.dns);
  // The limit of its last sending day, while that is recent (a mailbox that stopped sending a week ago says nothing).
  const limit = guard.dayLimit && guard.dayLimit.limit < guard.dayLimit.cap && guard.dayLimit.day >= shiftDate(localDay(now), -7) ? guard.dayLimit : undefined;
  if (!pause && !domainNote && !limit) return undefined;
  return {
    ...(pause ? { pausedUntil: pause.until, pauseKind: pause.kind, pauseNote: pauseWords(account, now) } : {}),
    ...(domainNote ? { domainNote: `${domainNote}.` } : {}),
    ...(limit ? { dayLimit: limit.limit, dayCap: limit.cap } : {}),
  };
}
