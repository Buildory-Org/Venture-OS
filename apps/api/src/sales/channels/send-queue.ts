// The send queue (docs/sales-autopilot.md section 5): ready email drafts a person approved to send (or, under a venture's "automatic"
// mode, that passed review and need no person's approval) wait here and go out through the sender's mailbox, spaced, on working days
// between 10:00 and 19:00, inside the daily cap. Every send goes through sendDraftThrough, which checks everything again at that moment.
//
// What keeps it safe:
// - A draft that changed is never sent: `sendQueue.version` is the `updatedAt` the enqueue itself wrote, and the worker sends with it as
//   `expectedUpdatedAt`. Editing, vetoing, discarding or sending it by hand takes it out of the queue (the routes unset `sendQueue`).
// - Never twice: a worker claims a draft (`queueClaim`, one at a time) before it sends, the requestId is fixed per draft, queue entry and
//   attempt (a retry of the same attempt replays the first answer), and sendDraftThrough's own lock stops a second send.
// - Spaced per sender and venture (4 to 10 minutes, never like clockwork), in the venture's working window, and never past the day's cap
//   (claimSendSlot): a cap reached waits for the next working day, quietly.
// - The sender's mailbox and domain are protected (mailbox-guard.ts): a warm-up limit per mailbox, spacing per mailbox across ventures, no
//   mail to an address that bounced or whose domain takes no mail, a pause when emails bounce or the mail server pushes back (the emails
//   stay queued), and no automatic sending from a domain without SPF and DMARC records.
// - Whatever takes a draft out of the queue without a person asking (a changed draft, a blocker, no mailbox, three failures, an unclear send)
//   is audited with the reason and told to the sender, with a link to the draft.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { audit } from "../../audit.js";
import type { AppDb, AppDocument, Database } from "../../db.js";
import { atomic } from "../../db.js";
import { AppError } from "../../errors.js";
import { actorFor } from "../../middleware.js";
import { forbidden, isHeadOf } from "../access.js";
import { auditSales, settingsFor, type SalesCtx } from "../ctx.js";
import { CHANNEL_WORDS, sendBlocker } from "../drafts.js";
import { loadLead, requireLeadEditor, versionBlocker } from "../leads.js";
import { calendarOf, loadSettings } from "../settings.js";
import { WORK_START_HOUR, inWorkingWindow, localDay, localMoment, nextWorkingDate } from "../workdays.js";
import { chooseSendAccount, missingSecrets, pickSendAccount, usableAccounts, type ChannelEnv } from "./accounts.js";
import { STALE_SEND_MS, SendCapReached, SendFailed, flipStaleSend, sendDraftThrough } from "./dispatch.js";
import { DNS_RECHECK_MS, PASSWORD_PAUSE_MS, SLOW_DOWN_PAUSE_MS, addressBlocker, canReceiveMail, guardOf, noteBadAddress, pauseMailbox, pausedNow, recordsProblem, senderRecordsFor, spaceMailbox } from "./mailbox-guard.js";

/** The queue worker runs in the API process when SALES_AUTOPILOT is on, never under the test runner. */
export const sendQueueEnabled = (config: { SALES_AUTOPILOT: "on" | "off"; NODE_ENV: string }) => config.SALES_AUTOPILOT === "on" && config.NODE_ENV !== "test";

export type EnqueueResult = { queued: true; notBefore: Date } | { queued: false; reason: string };
export type SendQueueOptions = { database: Database; env: ChannelEnv; pollMs?: number; now?: () => Date; gapMs?: () => number; log?: (line: Record<string, unknown>) => void };
export type SendQueue = { runOnce: () => Promise<number>; start: () => void; stop: () => Promise<void> };

export const QUEUE_POLL_MS = 60_000;
/** A provider failure is tried again this much later, three tries in all. */
export const RETRY_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 3;
/**
 * How often one email may be put off because the mail server's answer to it paused its mailbox ("slow down", a block). Past it the answer
 * counts as that email's own failed try: an answer only this email keeps getting is about this email, not about the mailbox.
 */
export const MAX_WAITS = 2;
/** How long a worker holds a draft it is sending (a worker that died lets go after this). */
const CLAIM_MS = 5 * 60_000;
/** 4 minutes between one sender's messages, plus up to 6 more so they don't go out like clockwork: a day's 20 emails take over two hours. */
export const defaultGapMs = () => 4 * 60_000 + Math.floor(Math.random() * 6 * 60_000);

/** Why a draft on another channel isn't queued, in the words the person sees. */
const NOT_EMAIL: Readonly<Record<string, string>> = {
  whatsapp: "WhatsApp is sent by hand: only emails go out from the send queue",
  instagram: "Instagram is sent by hand: only emails go out from the send queue",
  linkedin: "LinkedIn is sent by hand: only emails go out from the send queue",
  call_opener: "A call opener is a script for call mode: it is not sent",
};
export const NO_MAILBOX = "Connect your mailbox to send from the app: Sales > Channels";
const CHANGED = "It changed after it was queued, so it was not sent: read it again and queue it again";
export const HELD = "It was taken out of the send queue: a person queues it again";
const UNCLEAR = "We couldn't confirm it went out: check your Sent folder, then say whether it went";
export const AUTO_OFF = "Automatic sending was switched off for this venture";
/** What the queue sends: a first message or the one follow-up (a reply is answered from the Inbox). */
const QUEUED_PURPOSES = ["first_touch", "follow_up"] as const;
/** One sender's sends in one venture: a lock row per `workspace:venture:sender`, so two API processes never send for them at once. */
const SENDER_LOCKS = "sales_send_queue_senders";

/** `waits`: how often a send of it was put off because its mailbox was paused by the mail server's answer (not a failed try: `attempts` stays). */
type QueueEntry = { at: Date; by: string; auto?: boolean; accountId?: string; version: Date; notBefore: Date; attempts: number; waits?: number; lastError?: string };
const entryOf = (draft: AppDocument): QueueEntry | undefined => (draft.sendQueue && typeof draft.sendQueue === "object" ? draft.sendQueue as QueueEntry : undefined);
const time = (value: unknown) => (value instanceof Date ? value.getTime() : Date.parse(String(value)));
const hasEmail = (lead: AppDocument) => Array.isArray(lead.contactRoutes) && lead.contactRoutes.some((route: { kind?: unknown; value?: unknown }) => route?.kind === "email" && typeof route.value === "string" && route.value.trim().length > 0);
const reasonOf = (error: unknown) => (error instanceof AppError ? error.message : "Something went wrong with this draft: try it again").slice(0, 300);
/** The address an email to this lead goes to: its first email route (as dispatch.ts picks it). */
const emailOf = (lead: AppDocument): string | undefined => {
  const route = Array.isArray(lead.contactRoutes) ? lead.contactRoutes.find((item: { kind?: unknown; value?: unknown }) => item?.kind === "email" && typeof item.value === "string" && item.value.trim().length > 0) : undefined;
  return route ? String(route.value).trim() : undefined;
};

/**
 * When the sender's next message in this venture may go: the later of now and their last queued message plus the gap, moved into the next
 * working window when it falls outside one.
 */
async function nextSlot(ctx: SalesCtx, ventureId: string, now: Date, gapMs: number): Promise<Date> {
  const last = await ctx.db.collection("sales_drafts").find({ workspaceId: ctx.workspaceId, ventureId, "sendQueue.by": ctx.actor.id, "sendQueue.notBefore": { $exists: true } }, { projection: { sendQueue: 1 } }).sort({ "sendQueue.notBefore": -1 }).limit(1).next();
  const after = last ? time(entryOf(last)!.notBefore) + gapMs : now.getTime();
  return inWorkingWindow(new Date(Math.max(now.getTime(), after)), calendarOf(await settingsFor(ctx, ventureId)));
}

/**
 * Puts a ready email draft in the queue to go from `ctx.actor`'s mailbox. Refuses, with the reason in plain words, what a send would refuse.
 * `gapMs` (tests) fixes the spacing; it defaults to 4 to 10 minutes.
 */
export async function enqueueDraft(ctx: SalesCtx, env: ChannelEnv, draft: AppDocument, lead: AppDocument, options: { auto?: boolean; accountId?: string; now?: Date; gapMs?: () => number } = {}): Promise<EnqueueResult> {
  const now = options.now ?? new Date();
  const refuse = (reason: string): EnqueueResult => ({ queued: false, reason });
  if (draft.channel !== "email") return refuse(NOT_EMAIL[String(draft.channel)] ?? `${CHANNEL_WORDS[String(draft.channel)] ?? String(draft.channel)} is sent by hand: only emails go out from the send queue`);
  // The answer to a reply is a draft a person sends from the Inbox, never queued; only first messages and the one follow-up are.
  if (draft.purpose === "reply") return refuse("A reply is sent right away from the Inbox, not from the queue");
  if (!(QUEUED_PURPOSES as readonly unknown[]).includes(draft.purpose)) return refuse("Only first messages and follow-ups go out from the send queue: send this one yourself");
  if (draft.status === "sent") return refuse("This draft was already sent");
  if (draft.status !== "ready") return refuse("Only a draft that passed review (ready) can be queued to send");
  if (draft.sendLock) return refuse("This draft is being sent already, or its last send is unclear: settle that first");
  if (entryOf(draft)) return refuse("This draft is already queued to send");
  // A person (or the worker) took it out of the queue: the autopilot never puts it back, only a person does.
  if (options.auto && draft.queueHold) return refuse(HELD);
  try { requireLeadEditor(ctx, lead, "send this draft"); } catch (error) { return refuse(reasonOf(error)); }
  const ventureId = String(lead.ventureId);
  const play = typeof draft.playId === "string" ? await ctx.db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }) : null;
  const blocker = sendBlocker(draft, lead, play, await settingsFor(ctx, ventureId)) ?? await versionBlocker(ctx, draft);
  if (blocker) return refuse(blocker);
  if (!hasEmail(lead)) return refuse("This lead has no email address: add one to the lead first");
  // An address that bounced, was refused or takes no mail is never queued again (mailbox-guard.ts).
  const badAddress = await addressBlocker(ctx, draft, lead);
  if (badAddress) return refuse(badAddress);
  // The mailbox it would go from: the one named, else the sender's default for the venture (or their only one). Checked now so the person
  // hears at once; the worker picks it again when it sends.
  let account: AppDocument | undefined;
  try {
    if (options.accountId) account = await pickSendAccount(ctx, ventureId, "email", options.accountId);
    else {
      const usable = await usableAccounts(ctx, ventureId, "email");
      account = chooseSendAccount(usable, ventureId);
      if (!account) return refuse(usable.length ? "You have several mailboxes for this venture: choose one, or make one the default in Sales > Channels" : NO_MAILBOX);
    }
  } catch (error) {
    return refuse(error instanceof AppError && error.status === 404 ? "That mailbox wasn't found: pick another one" : reasonOf(error));
  }
  if (missingSecrets(env, account).length) return refuse(`${String(account.label)} needs to be reconnected: its saved password can't be read. Enter it again in Sales > Channels`);

  const notBefore = await nextSlot(ctx, ventureId, now, (options.gapMs ?? defaultGapMs)());
  // `version` is the `updatedAt` this write sets: anything that changes the draft after it moves `updatedAt` again, and the worker won't send.
  const entry = { at: now, by: ctx.actor.id, ...(options.auto ? { auto: true } : {}), ...(options.accountId ? { accountId: String(account._id) } : {}), version: now, notBefore, attempts: 0 };
  const queued = await atomic(ctx.database, async (session) => {
    const changed = await ctx.db.collection("sales_drafts").updateOne(
      // The autopilot queues only a draft nobody held; a person queueing it lifts the hold in the same write.
      { _id: draft._id, workspaceId: ctx.workspaceId, status: "ready", sendLock: null, sendQueue: null, updatedAt: draft.updatedAt, ...(options.auto ? { queueHold: null } : {}) },
      { $set: { sendQueue: entry, updatedAt: now }, $unset: { queueClaim: "", ...(options.auto ? {} : { queueHold: "" }) } }, { session },
    );
    if (!changed.matchedCount) return false;
    await auditSales(ctx, "sales.draft.queue", "draft", String(draft._id), ventureId, { auto: Boolean(options.auto), account: Boolean(options.accountId) }, session);
    return true;
  });
  return queued ? { queued: true, notBefore } : refuse("This draft changed while it was being queued: reload it and try again");
}

/**
 * Takes a draft back out of the queue: the person who queued it, a head of the venture or an admin (403 for anyone else). False when it was
 * not queued, or is being sent right now. The draft's `updatedAt` doesn't move: its text didn't change.
 */
export async function unqueueDraft(ctx: SalesCtx, draft: AppDocument, now: Date = new Date()): Promise<boolean> {
  const entry = entryOf(draft);
  if (!entry) return false;
  if (entry.by !== ctx.actor.id && !isHeadOf(ctx.actor, draft.ventureId)) throw forbidden("Only the person who queued it, a venture head or an admin can take it out of the send queue");
  // A person's decision about this message: held, so the autopilot's automatic step never queues it again (a person still can).
  const hold = { at: now, by: ctx.actor.id, reason: `Taken out of the send queue by ${ctx.actor.name || "a teammate"}`.slice(0, 300) };
  const changed = await ctx.db.collection("sales_drafts").updateOne({ _id: draft._id, workspaceId: ctx.workspaceId, "sendQueue.at": entry.at, sendLock: null }, { $unset: { sendQueue: "", queueClaim: "" }, $set: { queueHold: hold } });
  if (!changed.modifiedCount) return false;
  await auditSales(ctx, "sales.draft.unqueue", "draft", String(draft._id), String(draft.ventureId), { reason: "taken_out", auto: Boolean(entry.auto) });
  return true;
}

/**
 * The venture's automatic sending stopped (the autopilot switched off, its send mode left "automatic", or the person it works as changed):
 * every entry the autopilot queued (`sendQueue.auto`) on the venture's drafts leaves the queue. No hold is written (the setting changed, not a
 * decision about the message: a person may queue it, and the autopilot may again once switched back on). A draft already locked by a send
 * (`sendLock`) is past the point of no return and is left to that send. One a worker has claimed but not locked yet is taken out all the
 * same: the worker's send claims the draft only while its queue entry is still there, so that send is refused and nothing goes. Each draft
 * taken out is audited with the reason. Returns how many.
 */
export async function dropAutoQueued(scope: { db: AppDb; workspaceId: string }, ventureId: string, reason: string, now: Date = new Date()): Promise<number> {
  const drafts = scope.db.collection("sales_drafts");
  const rows = await drafts.find({ workspaceId: scope.workspaceId, ventureId, "sendQueue.auto": true, sendLock: null }, { projection: { sendQueue: 1 } }).toArray();
  let dropped = 0;
  for (const row of rows) {
    const entry = entryOf(row)!;
    const changed = await drafts.updateOne({ _id: row._id, "sendQueue.at": entry.at, "sendQueue.auto": true, sendLock: null }, { $unset: { sendQueue: "", queueClaim: "" } });
    if (!changed.modifiedCount) continue;
    dropped++;
    await audit(scope.db, { workspaceId: scope.workspaceId, actorId: null, channel: "engine", action: "sales.draft.unqueue", objectType: "draft", objectId: String(row._id), ventureId, result: "success", metadata: { reason: reason.slice(0, 200), auto: true, at: now.toISOString() } });
  }
  return dropped;
}

type Outcome = "sent" | "uncertain" | "waiting" | "retry" | "removed" | "skipped";

export function createSendQueue(options: SendQueueOptions): SendQueue {
  const { database, env } = options;
  const db = database.db;
  const drafts = db.collection("sales_drafts");
  const clock = options.now ?? (() => new Date());
  const gap = options.gapMs ?? defaultGapMs;
  const log = options.log ?? ((line: Record<string, unknown>) => console.info(JSON.stringify(line)));
  const workerId = `${hostname()}-${process.pid}-queue-${randomUUID().slice(0, 8)}`.slice(0, 100);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<unknown> | undefined;

  /** The person who queued it, acting in the app (their membership and ventures), or why they can't. */
  async function senderCtx(workspaceId: string, userId: string): Promise<SalesCtx | string> {
    const user = await db.collection("users").findOne({ _id: userId, status: "active" }, { projection: { email: 1, name: 1 } });
    const actor = user ? await actorFor(db, { id: userId, email: String(user.email ?? ""), name: String(user.name ?? "") }) : undefined;
    if (!actor || actor.membership.workspaceId !== workspaceId) return "The person who queued it is no longer an active member, so it was not sent";
    return { database, db, actor, via: "app", channel: "engine", workspaceId, settings: new Map() };
  }

  /** "Not sent: email to Acme" to the sender, once per queue entry, with the draft as the link. */
  async function tell(draft: AppDocument, entry: QueueEntry, reason: string, at: Date) {
    const lead = await db.collection("opportunities").findOne({ _id: String(draft.leadId), workspaceId: draft.workspaceId }, { projection: { companyName: 1 } });
    const key = `draft:${String(draft._id)}:queue:${time(entry.at)}:stopped`;
    const title = `Not sent: email to ${String(lead?.companyName ?? "a lead")}`;
    const body = `${reason.replace(/[.\s]+$/, "")}. It is out of the send queue: open the draft to fix it or send it.`;
    // "draft" (not "sales_draft", which only shows while the draft waits for approval) so the notice stays until it is read.
    await db.collection("notification_outbox").updateOne({ idempotencyKey: key }, { $setOnInsert: {
      _id: randomUUID(), workspaceId: String(draft.workspaceId), userId: entry.by, type: "sales_needs_you", title: title.slice(0, 200), body: body.slice(0, 500), resourceType: "draft", resourceId: String(draft._id),
      idempotencyKey: key, state: "pending", attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at,
    } }, { upsert: true });
  }

  /** A notice to the sender that isn't about one draft leaving the queue (the mailbox's domain needs something): once per `key`. It opens Channels. */
  async function tellSender(draft: AppDocument, entry: QueueEntry, accountId: string, key: string, title: string, body: string, at: Date) {
    await db.collection("notification_outbox").updateOne({ idempotencyKey: key }, { $setOnInsert: {
      _id: randomUUID(), workspaceId: String(draft.workspaceId), userId: entry.by, type: "sales_needs_you", title: title.slice(0, 200), body: body.slice(0, 500), resourceType: "channel_account", resourceId: accountId,
      idempotencyKey: key, state: "pending", attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at,
    } }, { upsert: true });
  }

  /** The mailbox a queued email would go from: the one named when it was queued, else the sender's default for the venture (or their only one). */
  async function mailboxOf(ctx: SalesCtx, ventureId: string, entry: QueueEntry): Promise<AppDocument | undefined> {
    try { return entry.accountId ? await pickSendAccount(ctx, ventureId, "email", entry.accountId) : chooseSendAccount(await usableAccounts(ctx, ventureId, "email"), ventureId); }
    catch { return undefined; }
  }

  /** Held: the autopilot's automatic step never queues it again (a person still can, which lifts the hold). */
  const holdOf = (reason: string, at: Date) => ({ at, reason: reason.slice(0, 300) });

  /**
   * Out of the queue, unsent, with the reason audited and told to the sender (only when this entry was still there). Held (`queueHold`) unless
   * `hold` is false, so the same failure isn't queued and tried again by the autopilot, round after round.
   */
  async function remove(draft: AppDocument, entry: QueueEntry, reason: string, at: Date, notify = true, hold = true): Promise<Outcome> {
    const changed = await drafts.updateOne({ _id: draft._id, "sendQueue.at": entry.at }, { $unset: { sendQueue: "", queueClaim: "" }, ...(hold ? { $set: { queueHold: holdOf(reason, at) } } : {}) });
    if (!changed.modifiedCount) return "skipped";
    await audit(db, { workspaceId: String(draft.workspaceId), actorId: entry.by, channel: "engine", action: "sales.draft.unqueue", objectType: "draft", objectId: String(draft._id), ventureId: String(draft.ventureId), result: "success", metadata: { reason: reason.slice(0, 200), auto: Boolean(entry.auto) } });
    if (notify) await tell(draft, entry, reason, at);
    log({ level: "info", event: "sales.send_queue.removed", draftId: String(draft._id), ventureId: String(draft.ventureId) });
    return "removed";
  }

  /** The sender's other waiting messages in this venture go no earlier than `notBefore` (after a send, outside hours, the cap reached). */
  async function holdSender(draft: AppDocument, entry: QueueEntry, notBefore: Date, others: boolean) {
    await drafts.updateMany(
      { workspaceId: draft.workspaceId, ventureId: draft.ventureId, "sendQueue.by": entry.by, "sendQueue.notBefore": { $lt: notBefore }, ...(others ? { _id: { $ne: draft._id } } : {}) },
      { $set: { "sendQueue.notBefore": notBefore } },
    );
  }

  /** Drafts still marked queued that can't go any more: no longer ready (a rule discarded them, a person sent them), or a send that died. */
  async function sweep(at: Date) {
    const gone = await drafts.find({ "sendQueue.notBefore": { $exists: true }, status: { $ne: "ready" } }, { projection: { workspaceId: 1, ventureId: 1, leadId: 1, status: 1, discardedReason: 1, sendQueue: 1 } }).limit(100).toArray();
    for (const draft of gone) {
      const reason = draft.status === "discarded" ? `It was discarded${draft.discardedReason ? `: ${String(draft.discardedReason)}` : ""}` : draft.status === "vetoed" ? "It was vetoed" : CHANGED;
      // A draft that went out some other way needs no notice.
      await remove(draft, entryOf(draft)!, draft.status === "sent" ? "It was sent another way" : reason, at, draft.status !== "sent", draft.status !== "sent");
    }
    // A queue send whose process died mid-send: its lock reads as an unclear send (flipStaleSend also takes it out of the queue).
    const stale = await drafts.find({ "sendQueue.notBefore": { $exists: true }, "delivery.state": "sending", "sendLock.at": { $lt: new Date(at.getTime() - STALE_SEND_MS) } }).limit(100).toArray();
    for (const draft of stale) {
      const entry = entryOf(draft)!;
      const flipped = await flipStaleSend(db, draft, at);
      if (entryOf(flipped)) continue;
      await drafts.updateOne({ _id: draft._id }, { $set: { queueHold: holdOf(UNCLEAR, at) } });
      await audit(db, { workspaceId: String(draft.workspaceId), actorId: entry.by, channel: "engine", action: "sales.draft.unqueue", objectType: "draft", objectId: String(draft._id), ventureId: String(draft.ventureId), result: "success", metadata: { reason: "uncertain", auto: Boolean(entry.auto) } });
      await tell(draft, entry, UNCLEAR, at);
    }
  }

  /**
   * An entry the autopilot queued goes only while the venture still sends automatically as that person: the autopilot on, its send mode
   * "automatic", and the person it works as the entry's sender. Otherwise it leaves the queue without a hold (the setting changed, not a
   * decision about the message) and without a notice. A person's own entries are never touched by the venture's switch.
   */
  async function autoStillOn(draft: AppDocument, entry: QueueEntry): Promise<boolean> {
    if (!entry.auto) return true;
    const autopilot = (await loadSettings(db, String(draft.workspaceId), String(draft.ventureId))).autopilot;
    return Boolean(autopilot?.enabled && autopilot.send === "automatic" && autopilot.runAsUserId === entry.by);
  }

  /** `workspace:venture:sender`: one lock row and spacing record per sender and venture, shared by every API process. */
  const senderKey = (draft: AppDocument, entry: QueueEntry) => `${String(draft.workspaceId)}:${String(draft.ventureId)}:${entry.by}`;
  /** Takes the sender's lock (free, or held past `busyUntil` by a worker that died), or null when another worker holds it. */
  async function lockSender(key: string, at: Date): Promise<AppDocument | null> {
    try {
      return await db.collection(SENDER_LOCKS).findOneAndUpdate(
        { _id: key as never, $or: [{ busyUntil: null }, { busyUntil: { $lt: at } }] },
        { $set: { busyUntil: new Date(at.getTime() + CLAIM_MS), workerId } }, { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      // The row exists and is busy: the upsert collides with it.
      if ((error as { code?: number }).code === 11000) return null;
      throw error;
    }
  }

  /** One queued draft, claimed: checked, then sent through sendDraftThrough as the sender. */
  async function attempt(draft: AppDocument, entry: QueueEntry, at: Date, nextAt: Date | undefined): Promise<Outcome> {
    const workspaceId = String(draft.workspaceId);
    const ventureId = String(draft.ventureId);
    if (!await autoStillOn(draft, entry)) return remove(draft, entry, AUTO_OFF, at, false, false);
    const ctx = await senderCtx(workspaceId, entry.by);
    if (typeof ctx === "string") return remove(draft, entry, ctx, at);
    const cal = calendarOf(await settingsFor(ctx, ventureId));
    // Outside working hours (the venture's days and blackout dates changed, or the worker was late): it waits for the next window.
    const window = inWorkingWindow(at, cal);
    if (window.getTime() > at.getTime()) { await holdSender(draft, entry, window, false); return "waiting"; }
    // This sender's last send in this venture (by any API process) was less than the gap ago: it waits for its turn.
    if (nextAt && nextAt.getTime() > at.getTime()) { await holdSender(draft, entry, inWorkingWindow(nextAt, cal), false); return "waiting"; }
    let lead: AppDocument;
    try { lead = await loadLead(ctx, String(draft.leadId)); }
    catch { return remove(draft, entry, "The lead was deleted, or the sender can no longer open it", at); }
    if (time(draft.updatedAt) !== time(entry.version)) return remove(draft, entry, CHANGED, at);
    // The mailbox it goes from (mailbox-guard.ts). Not found or not usable: the send below refuses in its own words.
    const mailbox = await mailboxOf(ctx, ventureId, entry);
    if (mailbox) {
      // Paused (bounces, the mail server's push-back, a refused password): the sender's emails stay queued and wait for the pause to end.
      const paused = pausedNow(mailbox, at);
      if (paused) { await holdSender(draft, entry, inWorkingWindow(paused.until, cal), false); return "waiting"; }
      // This mailbox's last message (for any venture) went less than the gap ago.
      const turn = guardOf(mailbox).nextAt;
      if (turn && turn.getTime() > at.getTime()) { await holdSender(draft, entry, inWorkingWindow(turn, cal), false); return "waiting"; }
      // Nobody reads an automatic email before it goes, so it only goes from a domain that publishes SPF and DMARC records.
      if (entry.auto) {
        const problem = recordsProblem(mailbox, await senderRecordsFor(db, mailbox, at));
        if (problem) {
          await holdSender(draft, entry, inWorkingWindow(new Date(at.getTime() + DNS_RECHECK_MS), cal), false);
          await tellSender(draft, entry, String(mailbox._id), `mailbox:${String(mailbox._id)}:records:${localDay(at, cal)}`, "Automatic sending is waiting", `${problem}. Until then nothing is sent without a person's approval; approved emails still go.`, at);
          return "waiting";
        }
      }
      // The lead's domain takes no mail at all: sending would only bounce.
      const to = emailOf(lead);
      if (to && !await canReceiveMail(to)) {
        await noteBadAddress(db, { workspaceId, email: to, kind: "no_mail_server", reason: "Its domain has no mail server", leadId: String(lead._id), accountId: String(mailbox._id), at });
        return remove(draft, entry, `${to} can't receive mail (its domain has no mail server): put another address on the lead`, at);
      }
    }
    // Fixed per draft, queue entry and try, so a repeated call replays the first answer; a try after a pause is a new one.
    const requestId = `queue-${String(draft._id)}-${time(entry.at)}-${entry.attempts}${entry.waits ? `-w${entry.waits}` : ""}`;
    const started = Date.now();
    const line = (outcome: string) => log({ level: "info", event: "sales.send_queue.send", draftId: String(draft._id), ventureId, attempt: entry.attempts + 1, outcome, ms: Date.now() - started });
    try {
      const result = await sendDraftThrough(ctx, env, draft, lead, { requestId, expectedUpdatedAt: new Date(time(entry.version)).toISOString(), queueEntry: entry.at, ...(entry.accountId ? { accountId: entry.accountId } : {}) });
      if (result.outcome === "uncertain") {
        // dispatch.ts took it out of the queue; the person says whether it went (It went out / It didn't go).
        line("uncertain");
        await drafts.updateOne({ _id: draft._id }, { $set: { queueHold: holdOf(UNCLEAR, at) } });
        await audit(db, { workspaceId, actorId: entry.by, channel: "engine", action: "sales.draft.unqueue", objectType: "draft", objectId: String(draft._id), ventureId, result: "success", metadata: { reason: "uncertain", auto: Boolean(entry.auto) } });
        await tell(draft, entry, UNCLEAR, at);
        return "uncertain";
      }
      line("sent");
      const spaced = new Date(at.getTime() + gap());
      const next = inWorkingWindow(spaced, cal);
      await db.collection(SENDER_LOCKS).updateOne({ _id: senderKey(draft, entry) as never }, { $set: { lastSentAt: at, nextAt: next } });
      // The mailbox's own turn is the bare gap: another venture it sends for has its own working days.
      if (mailbox) await spaceMailbox(db, String(mailbox._id), spaced);
      await holdSender(draft, entry, next, true);
      const day = localDay(at, cal);
      // The day's `sent` (autopilot/days.ts keeps the same row shape, with $inc so no count is lost).
      await db.collection("sales_autopilot_days").updateOne({ _id: `${ventureId}:${day}` as never }, { $inc: { sent: 1 }, $set: { updatedAt: new Date() }, $setOnInsert: { workspaceId, ventureId, day } }, { upsert: true }).catch(() => undefined);
      return "sent";
    } catch (error) {
      if (error instanceof SendCapReached) {
        // Not an error: the day's emails are used up, so it (and the sender's others) wait for the next working day.
        line("cap_reached");
        await holdSender(draft, entry, localMoment(nextWorkingDate(localDay(at, cal), cal), WORK_START_HOUR, 0, cal), false);
        return "waiting";
      }
      // What the mail server said decides what happens to the mailbox (mailbox-guard.ts). In each case this email stays queued, untried.
      const kind = error instanceof SendFailed ? error.kind : undefined;
      // A refused password is never about the email. "Slow down" or a block usually isn't either, but an email that alone keeps getting
      // that answer (the others go) has used its waits: from then on the answer is its own failed try, below.
      const pauses = kind === "password" || ((kind === "slow_down" || kind === "blocked") && (entry.waits ?? 0) < MAX_WAITS);
      if (mailbox && pauses) {
        line(kind!);
        const until = kind === "password" ? new Date(at.getTime() + PASSWORD_PAUSE_MS) : kind === "slow_down" ? new Date(at.getTime() + SLOW_DOWN_PAUSE_MS) : localMoment(nextWorkingDate(localDay(at, cal), cal), WORK_START_HOUR, 0, cal);
        const reason = kind === "password" ? "The mailbox refused its password: enter it again in Sales > Channels" : kind === "slow_down" ? "The mail server asked to slow down" : "The mail server limited or blocked sending from this mailbox";
        await pauseMailbox(db, mailbox, { kind: kind as "password" | "slow_down" | "blocked", reason, until }, at);
        const resume = inWorkingWindow(until, cal);
        await holdSender(draft, entry, resume, false);
        // Nothing went out: it keeps its tries, and its next send is a new request (not a replay of this answer). After a "slow down" or a
        // block it goes to the back of the sender's line, so the other emails show whether the answer was about the mailbox or about this one.
        await drafts.updateOne({ _id: draft._id, "sendQueue.at": entry.at }, { $inc: { "sendQueue.waits": 1 }, ...(kind === "password" ? {} : { $set: { "sendQueue.notBefore": new Date(resume.getTime() + 1_000) } }) });
        return "waiting";
      }
      // The lead's address was refused (dispatch.ts remembered it): trying again would only be refused again.
      if (kind === "address") { line("refused"); return remove(draft, entry, (error as SendFailed).message, at); }
      const providerFailed = !(error instanceof AppError) || error.code === "SEND_FAILED";
      if (!providerFailed) {
        // A refusal (a blocker, the draft changed, no mailbox, someone else sending it): it leaves the queue unsent.
        line("refused");
        return remove(draft, entry, (error as AppError).code === "DRAFT_CHANGED" ? CHANGED : reasonOf(error), at);
      }
      line("failed");
      const attempts = entry.attempts + 1;
      const message = error instanceof AppError ? error.message : "The send failed";
      if (attempts >= MAX_ATTEMPTS) return remove(draft, entry, `It didn't go after ${attempts} tries: ${message}`, at);
      await drafts.updateOne({ _id: draft._id, "sendQueue.at": entry.at }, { $set: { "sendQueue.attempts": attempts, "sendQueue.lastError": message.slice(0, 300), "sendQueue.notBefore": inWorkingWindow(new Date(at.getTime() + RETRY_MS), cal) } });
      return "retry";
    }
  }

  /**
   * Takes the sender's lock for this venture (so two API processes never send two of one sender's messages at once), then claims the draft
   * (one worker per draft), works it, and lets go of both.
   */
  async function work(found: AppDocument, at: Date): Promise<Outcome> {
    const entry = entryOf(found)!;
    const key = senderKey(found, entry);
    const sender = await lockSender(key, at);
    if (!sender) return "skipped";
    try {
      const claimed = await drafts.findOneAndUpdate(
        { _id: found._id, "sendQueue.at": entry.at, "sendQueue.attempts": entry.attempts, status: "ready", sendLock: null, $or: [{ queueClaim: null }, { "queueClaim.until": { $lt: at } }] },
        { $set: { queueClaim: { by: workerId, until: new Date(at.getTime() + CLAIM_MS) } } }, { returnDocument: "after" },
      );
      if (!claimed) return "skipped";
      try { return await attempt(claimed, entryOf(claimed)!, at, sender.nextAt instanceof Date ? sender.nextAt : undefined); }
      finally { await drafts.updateOne({ _id: found._id, "queueClaim.by": workerId }, { $unset: { queueClaim: "" } }).catch(() => undefined); }
    } finally {
      await db.collection(SENDER_LOCKS).updateOne({ _id: key as never, workerId }, { $set: { busyUntil: new Date(0) } }).catch(() => undefined);
    }
  }

  /** One pass: what is due, oldest first, one per sender and venture. Returns how many went out. */
  async function runOnce(): Promise<number> {
    const at = clock();
    await sweep(at);
    const due = await drafts.find(
      { "sendQueue.notBefore": { $exists: true, $lte: at }, status: "ready", sendLock: null, $or: [{ queueClaim: null }, { "queueClaim.until": { $lt: at } }] },
      { projection: { workspaceId: 1, ventureId: 1, sendQueue: 1 } },
    ).sort({ "sendQueue.notBefore": 1, _id: 1 }).limit(200).toArray();
    const taken = new Set<string>();
    let sent = 0;
    for (const row of due) {
      const key = `${String(row.workspaceId)}:${String(row.ventureId)}:${entryOf(row)!.by}`;
      if (taken.has(key)) continue;
      taken.add(key);
      try {
        const full = await drafts.findOne({ _id: row._id });
        if (full && entryOf(full) && await work(full, at) === "sent") sent++;
      } catch (error) {
        log({ level: "warn", event: "sales.send_queue.failed", draftId: String(row._id), message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
    }
    return sent;
  }

  function start(): void {
    if (timer || stopped) return;
    const tick = () => {
      if (running || stopped) return;
      running = runOnce().catch((error: unknown) => log({ level: "warn", event: "sales.send_queue.loop_failed", message: error instanceof Error ? error.message.slice(0, 200) : "unknown" })).finally(() => { running = undefined; });
    };
    timer = setInterval(tick, options.pollMs ?? QUEUE_POLL_MS);
    timer.unref();
    log({ level: "info", event: "sales.send_queue.started", workerId });
    tick();
  }

  /** Stops the loop and waits for a pass in progress (a send is never cut off halfway). */
  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    await running;
  }

  return { runOnce, start, stop };
}
