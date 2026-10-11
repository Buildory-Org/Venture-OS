// Sending a ready draft through a connected account, and settling a send whose result was unclear (docs/sales-channels.md section 2).
//
// Order of a send: every check that can refuse without side effects (the draft, the account, the recipient, WhatsApp/Instagram's 24-hour
// windows), then the claims (the draft's `sendLock`, set only on a ready draft without one; then one of the day's sends under the venture's
// cap), then the same checks once more against what is stored now (the lead may have been put on the do-not-contact list, the approval or
// the channel withdrawn meanwhile: the claims are given back and nothing goes out), then the provider call outside any transaction with a
// 25-second limit, then the outcome:
//   sent      the draft is marked sent and the outbound activity logged through applyActivity (stage, follow-up date and the other rules),
//             in one transaction where Mongo has them;
//   failed    the day's send is given back and the lock removed; the draft stays ready with `delivery.state: "failed"`;
//   uncertain the send stays counted and the lock stays until a person says whether it went out (POST /drafts/:id/delivery).
// A lock still "sending" two minutes after it was taken belongs to a send whose process died (or whose bookkeeping failed): it reads as
// uncertain, and a person settles it the same way. Every answer is kept on the draft (`sendLog`, the last ten) so the same requestId gets
// the first answer again, and a second request while the lock is held is refused. The provider never touches the database.
import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { ErrorCode } from "@venture-studio/contracts";
import { atomic, type AppDb, type AppDocument } from "../../db.js";
import { AppError } from "../../errors.js";
import { actorFor } from "../../middleware.js";
import { forbidClaude } from "../access.js";
import { auditSales, settingsFor, type SalesCtx } from "../ctx.js";
import { sendBlocker } from "../drafts.js";
import { applyActivity, claimSendSlot, defined, loadLead, markHandled, payloadHash, requireLeadEditor } from "../leads.js";
import { calendarOf } from "../settings.js";
import { hasCountryCode, normalizePhone } from "../suppression.js";
import { localDay } from "../workdays.js";
import { ACCOUNTS, missingSecrets, openSecrets, pickSendAccount, type ChannelEnv } from "./accounts.js";
import { emailMessageId } from "./email/provider.js";
import { providerFor, type SendOutcome, type SendRequest } from "./provider.js";

/**
 * How long a provider gets for one message; past it the send is unclear (it may have gone out). With the 2-second grace below the whole
 * call stays within 25 seconds, well inside the web app's proxy limit.
 */
export const SEND_TIMEOUT_MS = 23_000;
const SEND_GRACE_MS = 2_000;
/** A lock still "sending" after this long is a send nobody is waiting on any more: it reads as uncertain. */
export const STALE_SEND_MS = 2 * 60_000;
/** What an uncertain send from a lock nobody finished says, and what every refusal on such a draft says. */
export const UNCONFIRMED = "We couldn't confirm the last send: say whether it went out";
const UNCONFIRMED_HINT = `${UNCONFIRMED} (It went out / It didn't go)`;
const CHANGED = "This draft changed while it was being sent: reload it";
const WINDOW_MS = 24 * 60 * 60_000;
const LOG_KEEP = 10;
/** How each channel's app send is recorded in `sentVia`. */
export const SENT_VIA = { email: "smtp", whatsapp: "whatsapp_api", instagram: "instagram_api" } as const;
export type SendChannel = keyof typeof SENT_VIA;
const isSendChannel = (channel: unknown): channel is SendChannel => channel === "email" || channel === "whatsapp" || channel === "instagram";

const SEND_FAILED: ErrorCode = "SEND_FAILED";
const TEMPLATE_REQUIRED: ErrorCode = "TEMPLATE_REQUIRED";

export type SendInput = { accountId?: string | undefined; template?: { name: string; language: string; variables: string[] } | undefined; requestId: string };
/** `to`: where it went (the lead's address, or the WhatsApp number as normalised), for the app to show. */
export type SendResult =
  | { outcome: "sent"; draft: AppDocument; activity: AppDocument; lead: AppDocument; to?: string }
  | { outcome: "uncertain"; draft: AppDocument; to?: string };

type LogEntry = { requestId: string; outcome: "sent" | "failed" | "uncertain"; error?: string; attempt: number; at: Date };
type SendLock = { requestId?: string; by?: string; at?: Date; accountId?: string; channel?: string; day?: string; to?: string; subject?: string; externalId?: string; threadKey?: string; template?: SendInput["template"] };
// The driver's update types don't know these fields: the value is cast.
const logPush = (entry: LogEntry) => ({ sendLog: { $each: [defined(entry)], $slice: -LOG_KEEP } }) as never;
const failedSend = (error: string) => new AppError(502, SEND_FAILED, error);
const lockOf = (draft: AppDocument) => (draft.sendLock ?? undefined) as SendLock | undefined;
/** The recipient as the app shows it on the draft: the address or number (an Instagram id means nothing to people). */
const shownTo = (channel: SendChannel, to: string | undefined) => (channel === "instagram" ? undefined : to);

// ---- Locks nobody finished --------------------------------------------------------------------------------------------------------

/** A lock still "sending" more than two minutes after it was taken: the send's process died or its bookkeeping failed. Stored or JSON drafts. */
export function isStaleSend(draft: Record<string, unknown>, now = Date.now()): boolean {
  const lock = draft.sendLock as { at?: unknown } | null | undefined;
  const delivery = draft.delivery as { state?: unknown } | null | undefined;
  if (!lock || delivery?.state !== "sending") return false;
  const at = new Date(lock.at as string | Date).getTime();
  return !Number.isFinite(at) || now - at > STALE_SEND_MS;
}

/** A send nobody finished: still a stale "sending" lock, or already turned into an uncertain one for that reason. */
const isUnconfirmed = (draft: AppDocument) => isStaleSend(draft) || (Boolean(draft.sendLock) && draft.delivery?.state === "uncertain" && draft.delivery?.error === UNCONFIRMED);

/** The draft as people see it: a stale "sending" lock reads as uncertain (with what to do about it). Works on stored and JSON drafts. */
export function shownSendState<T extends Record<string, unknown>>(draft: T, now = Date.now()): T {
  if (!isStaleSend(draft, now)) return draft;
  return { ...draft, delivery: { ...(draft.delivery as Record<string, unknown>), state: "uncertain", error: UNCONFIRMED } };
}

/**
 * Turns a stale "sending" lock into an uncertain send (only if it is still that lock, still sending), so a person can say whether it went
 * out. The dead request's requestId then repeats "uncertain". Returns the draft as stored now.
 */
export async function flipStaleSend(db: AppDb, draft: AppDocument, now = new Date()): Promise<AppDocument> {
  const lock = lockOf(draft);
  if (!lock?.requestId || !isStaleSend(draft, now.getTime())) return draft;
  const delivery = defined({ state: "uncertain", at: now, accountId: lock.accountId ?? draft.delivery?.accountId, to: draft.delivery?.to, error: UNCONFIRMED });
  const flipped = await db.collection("sales_drafts").findOneAndUpdate(
    { _id: draft._id, "sendLock.requestId": lock.requestId, "delivery.state": "sending" },
    { $set: { delivery, updatedAt: now }, $push: logPush({ requestId: lock.requestId, outcome: "uncertain", error: UNCONFIRMED, attempt: Number(draft.sendAttempts ?? 1), at: now }) },
    { returnDocument: "after" },
  );
  return flipped ?? (await db.collection("sales_drafts").findOne({ _id: draft._id })) ?? draft;
}

/** Why a locked draft can't be edited, vetoed, discarded or marked sent now: a send nobody finished asks for an answer; otherwise `fallback`. */
export function lockedMessage(draft: AppDocument, fallback: string): string {
  return isUnconfirmed(draft) ? UNCONFIRMED_HINT : fallback;
}

const beingSent = (draft: AppDocument) => new AppError(409, "CONFLICT", isUnconfirmed(draft)
  ? UNCONFIRMED_HINT
  : draft.delivery?.state === "uncertain"
    ? "This draft is already being sent: its last send is unclear, so first say whether it went out (It went out / It didn't go)"
    : "This draft is already being sent: wait a moment and reload it");

// ---- Who and where it goes to ---------------------------------------------------------------------------------------------------------

type Route = { kind?: unknown; value?: unknown };
const routesOf = (lead: AppDocument): Route[] => (Array.isArray(lead.contactRoutes) ? lead.contactRoutes : []);
const routeValue = (lead: AppDocument, kind: string) => routesOf(lead).find((route) => route.kind === kind && typeof route.value === "string" && route.value.trim())?.value as string | undefined;
const INDIA = new Set(["india", "in", "ind", "bharat", "republicofindia"]);
/** A lead in India, or whose country nobody wrote down: a number without a country code is read as Indian (+91). */
const inIndia = (country: unknown) => { const name = typeof country === "string" ? country.toLowerCase().replace(/[^a-z]/g, "") : ""; return !name || INDIA.has(name); };

/**
 * The recipient: email, the lead's first email route; WhatsApp, the number the lead wrote from on this account (a linked conversation), else
 * its WhatsApp route, else its phone route, normalised (India +91 by default: a lead in another country needs its number written with the
 * country code); Instagram, the person's Instagram-scoped id from a conversation linked to this lead on this account. None: 409 saying what
 * is missing.
 */
export async function recipientFor(ctx: SalesCtx, account: AppDocument, lead: AppDocument, channel: SendChannel): Promise<{ to: string; toName?: string }> {
  const toName = typeof lead.contactName === "string" && lead.contactName.trim() ? lead.contactName.trim() : undefined;
  if (channel === "email") {
    const email = routeValue(lead, "email");
    if (!email) throw new AppError(409, "CONFLICT", "This lead has no email address: add one to the lead first");
    return { to: email.trim(), ...(toName ? { toName } : {}) };
  }
  const contact = await ctx.db.collection("sales_channel_contacts").findOne({ workspaceId: ctx.workspaceId, accountId: String(account._id), leadId: String(lead._id) });
  if (channel === "whatsapp") {
    const linked = typeof contact?.externalUserId === "string" ? normalizePhone(contact.externalUserId) : null;
    const routed = routeValue(lead, "whatsapp") ?? routeValue(lead, "phone");
    // A number Meta gave us is international already; one a person typed for a lead abroad is not guessed as Indian.
    if (!linked && routed && !hasCountryCode(routed) && !inIndia(lead.country)) throw new AppError(409, "CONFLICT", `Write this lead's WhatsApp number with its country code, like +44 … (the lead is in ${String(lead.country).trim().slice(0, 80)})`);
    const phone = linked ?? (routed ? normalizePhone(routed) : null);
    if (!phone) throw new AppError(409, "CONFLICT", "This lead has no WhatsApp or phone number that can be used: add one to the lead first");
    return { to: phone, ...(toName ? { toName } : {}) };
  }
  if (typeof contact?.externalUserId !== "string" || !contact.externalUserId) throw new AppError(409, "CONFLICT", "No Instagram conversation with this lead is linked to this account yet (the app can only answer people who wrote first): send it from the Instagram app and mark it sent");
  return { to: contact.externalUserId, ...(toName ? { toName } : {}) };
}

/** The lead's last message to us on this account and channel (WhatsApp and Instagram only answer freely within 24 hours of it). */
async function lastInbound(ctx: SalesCtx, account: AppDocument, lead: AppDocument, kind: "whatsapp" | "instagram"): Promise<Date | undefined> {
  const row = await ctx.db.collection("sales_activities").find({ workspaceId: ctx.workspaceId, leadId: String(lead._id), kind, direction: "in", "message.accountId": String(account._id) }).sort({ at: -1 }).limit(1).next();
  return row ? new Date(row.at) : undefined;
}

/** WhatsApp free text and Instagram replies only within 24 hours of the lead's last message on this account (Meta's rules). */
async function checkWindow(ctx: SalesCtx, account: AppDocument, lead: AppDocument, channel: SendChannel, template: SendInput["template"], now: Date): Promise<void> {
  if (channel === "email") return;
  const last = await lastInbound(ctx, account, lead, channel);
  const open = last !== undefined && now.getTime() - last.getTime() <= WINDOW_MS;
  if (channel === "whatsapp" && !open && !template) throw new AppError(409, TEMPLATE_REQUIRED, "More than 24 hours have passed since this lead last wrote on WhatsApp (or they never have): pick an approved template to send");
  if (channel === "instagram" && !open) throw new AppError(409, "CONFLICT", "Instagram only lets the app answer within 24 hours of the person's last message: send it from the Instagram app and mark it sent");
}

/** The message a draft answers, as the provider needs it: its provider id and thread (a WhatsApp reply only on the same number). */
function replyRef(replied: AppDocument | null, account: AppDocument, channel: SendChannel): SendRequest["inReplyTo"] | undefined {
  const message = replied?.message as { accountId?: string; externalId?: string; threadKey?: string } | undefined;
  if (!message?.externalId) return undefined;
  if (channel !== "email" && message.accountId !== String(account._id)) return undefined;
  return defined({ externalId: message.externalId, threadKey: message.threadKey });
}

/** An email's subject: the draft's own, else "Re: " the message it answers. */
function subjectOf(draft: AppDocument, replied: AppDocument | null, channel: SendChannel): string | undefined {
  if (channel !== "email") return undefined;
  if (typeof draft.subject === "string" && draft.subject.trim()) return draft.subject.trim();
  const repliedSubject = typeof replied?.message?.subject === "string" ? replied.message.subject as string : undefined;
  return repliedSubject ? `Re: ${repliedSubject.replace(/^re:\s*/i, "")}` : undefined;
}

const bodyOf = (draft: AppDocument, subject: string | undefined, template: SendInput["template"]) => {
  if (template) return `Template ${template.name} (${template.language})${template.variables.length ? `: ${template.variables.join(" | ")}` : ""}`.slice(0, 10_000);
  return `${subject ? `Subject: ${subject}\n\n` : ""}${String(draft.body ?? "")}`.slice(0, 10_000);
};

// ---- The provider call --------------------------------------------------------------------------------------------------------------

/** Calls the provider with a 23-second limit (25 at most). A provider that throws, or doesn't answer in time, leaves the send unclear (never failed: it may have gone out). */
async function callProvider(request: SendRequest): Promise<SendOutcome> {
  const provider = providerFor(request.account.kind);
  if (!provider.send) return { state: "failed", error: "This kind of account can't send from the app: send it yourself and mark it sent" };
  const unclear = "The connection didn't answer in time, so the message may or may not have gone out: check, then say whether it went";
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<SendOutcome>((resolve) => { timer = setTimeout(() => resolve({ state: "uncertain", error: unclear }), SEND_TIMEOUT_MS + SEND_GRACE_MS); });
  try {
    return await Promise.race([provider.send(request, AbortSignal.timeout(SEND_TIMEOUT_MS)).catch((): SendOutcome => ({ state: "uncertain", error: "Something went wrong while the message was being sent: check whether it went out, then say so" })), late]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Recording a sent message -------------------------------------------------------------------------------------------------------

type SentRecord = {
  draft: AppDocument; leadId: string; requestId: string; channel: SendChannel; accountId: string; at: Date; body: string; to?: string | undefined;
  message: Record<string, unknown>; log?: LogEntry;
};

/**
 * Marks the draft sent and logs the outbound activity with every rule (stage, follow-up, next action), clears the Inbox item it answers,
 * and audits. The day's send was already counted. If the rules can't run (the lead was deleted or put on the do-not-contact list while the
 * message was on its way), the message still went out: the draft is marked sent and the activity stored as it is. Nothing is recorded when
 * the lock is no longer this send's (someone said "It didn't go" first): 409, unless this very send was recorded already.
 */
async function recordSent(ctx: SalesCtx, record: SentRecord): Promise<AppDocument> {
  const { draft, requestId, channel, accountId, at } = record;
  const drafts = ctx.db.collection("sales_drafts");
  const now = new Date();
  const sentVia = SENT_VIA[channel];
  const sentSet = { status: "sent", sentAt: at, sentBy: ctx.actor.id, sentVia, sentAccountId: accountId, delivery: defined({ state: "sent", at: now, accountId, to: shownTo(channel, record.to) }), updatedAt: now };
  const hash = payloadHash({ draftId: String(draft._id), sentVia, accountId });
  const update = { $set: sentSet, $unset: { sendLock: "" }, ...(record.log ? { $push: logPush(record.log) } : {}) };
  const recorded = () => ctx.db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, draftId: String(draft._id), direction: "out", requestId });
  const write = () => atomic(ctx.database, async (session?: ClientSession) => {
    const before = await drafts.findOneAndUpdate({ _id: draft._id, workspaceId: ctx.workspaceId, "sendLock.requestId": requestId }, update, { session, returnDocument: "before" });
    if (!before) throw new AppError(409, "CONFLICT", CHANGED);
    try {
      const lead = await loadLead(ctx, record.leadId, session);
      const logged = await applyActivity(ctx, lead, { kind: channel, direction: "out", body: record.body, at: at.toISOString(), draftId: String(draft._id), requestId }, now, session, ctx.via, { payloadHash: hash, sendClaimed: true, message: record.message });
      // Answering a reply clears it from the Inbox.
      if (draft.inReplyTo) {
        const replied = await ctx.db.collection("sales_activities").findOne({ _id: String(draft.inReplyTo), workspaceId: ctx.workspaceId }, { session });
        if (replied && !replied.handledAt) await markHandled(ctx, await loadLead(ctx, record.leadId, session), replied, now, session);
      }
      await auditSales(ctx, "sales.draft.sent", "draft", String(draft._id), String(draft.ventureId), { channel, sentVia, ...(logged.stageTo ? { stageTo: logged.stageTo } : {}) }, session);
      return logged.activity;
    } catch (error) {
      // Without transactions the draft is already marked: put it back as it was, so the next try (or the fallback below) starts clean.
      if (!session) await drafts.replaceOne({ _id: draft._id }, before).catch(() => undefined);
      throw error;
    }
  });
  try {
    try { return await write(); }
    catch (error) {
      // The lead moved between reading it and writing the activity (a reply, another edit): once more with the fresh lead.
      if (error instanceof AppError && error.status === 409 && /lead changed/i.test(error.message)) return await write();
      throw error;
    }
  } catch (error) {
    // The lock is not this send's any more: nothing is recorded (an activity here would let the draft be sent again with a message logged).
    if (error instanceof AppError && error.status === 409 && error.message === CHANGED) {
      const stored = await recorded();
      if (stored) return stored;
      throw error;
    }
    console.warn(JSON.stringify({ level: "warn", event: "sales.send.recorded_without_rules", draftId: String(draft._id), message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    const marked = await drafts.updateOne({ _id: draft._id, workspaceId: ctx.workspaceId, "sendLock.requestId": requestId }, update);
    if (!marked.matchedCount) {
      const stored = await recorded();
      if (stored) return stored;
      throw new AppError(409, "CONFLICT", CHANGED);
    }
    const activity = defined({
      _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: draft.ventureId, leadId: record.leadId, actorId: ctx.actor.id, via: ctx.via, kind: channel, direction: "out", body: record.body, at,
      draftId: String(draft._id), requestId, payloadHash: hash, message: record.message, createdAt: now,
    });
    try { await ctx.db.collection("sales_activities").insertOne(activity); }
    catch (insertError) {
      if ((insertError as { code?: number }).code !== 11000) throw insertError;
      const stored = await ctx.db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, draftId: String(draft._id), direction: "out" });
      if (stored) return stored;
      throw insertError;
    }
    await auditSales(ctx, "sales.draft.sent", "draft", String(draft._id), String(draft.ventureId), { channel, sentVia, rules: false });
    return activity;
  }
}

// ---- Replays ------------------------------------------------------------------------------------------------------------------------

const logOf = (draft: AppDocument, requestId: string): LogEntry | undefined => (Array.isArray(draft.sendLog) ? (draft.sendLog as LogEntry[]).find((entry) => entry.requestId === requestId) : undefined);
const toOf = (draft: AppDocument) => (typeof draft.delivery?.to === "string" ? draft.delivery.to as string : undefined);

/** The first answer to this requestId, again. */
async function replay(ctx: SalesCtx, draft: AppDocument, entry: LogEntry): Promise<SendResult> {
  if (entry.outcome === "failed") throw failedSend(entry.error ?? "The message was not sent");
  const to = toOf(draft);
  if (entry.outcome === "uncertain") return { outcome: "uncertain", draft, ...(to ? { to } : {}) };
  const activity = await ctx.db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, draftId: String(draft._id), direction: "out" });
  const lead = await ctx.db.collection("opportunities").findOne({ _id: String(draft.leadId), workspaceId: ctx.workspaceId });
  if (!activity || !lead) return { outcome: "uncertain", draft, ...(to ? { to } : {}) };
  return { outcome: "sent", draft, activity, lead, ...(to ? { to } : {}) };
}

// ---- Send ---------------------------------------------------------------------------------------------------------------------------

type Prepared = { request: SendRequest; subject?: string | undefined; to: string; inReplyTo?: SendRequest["inReplyTo"]; body: string; externalId?: string | undefined; threadKey?: string | undefined };

/**
 * Right before the provider call, under the claims: the lead, the play and the venture's settings read again and every send rule checked
 * against the claimed draft (do-not-contact, WhatsApp opt-in, approval, the channel allowed), the recipient worked out from the stored lead,
 * and the message built from the claimed draft's own subject and text. What a person's "It went out" (or a bounce) needs is kept on the
 * lock before anything goes out. Throws a refusal; the caller gives the claims back.
 */
async function prepareSend(ctx: SalesCtx, env: ChannelEnv, claimed: AppDocument, leadId: string, account: AppDocument, channel: SendChannel, input: SendInput, attempt: number): Promise<Prepared> {
  const db = ctx.db;
  const lead = await loadLead(ctx, leadId);
  const ventureId = String(lead.ventureId);
  const play = claimed.playId ? await db.collection("sales_plays").findOne({ _id: claimed.playId, workspaceId: ctx.workspaceId }) : null;
  const settings = await settingsFor({ ...ctx, settings: new Map() }, ventureId);
  const blocker = sendBlocker(claimed, lead, play, settings);
  if (blocker) throw new AppError(409, "CONFLICT", blocker);
  const target = await recipientFor(ctx, account, lead, channel);
  const replied = claimed.inReplyTo ? await db.collection("sales_activities").findOne({ _id: String(claimed.inReplyTo), workspaceId: ctx.workspaceId }) : null;
  const inReplyTo = replyRef(replied, account, channel);
  const subject = subjectOf(claimed, replied, channel);
  const idempotencyKey = `draft-${String(claimed._id)}-${attempt}`;
  const externalId = channel === "email" ? emailMessageId(String(account.settings?.address ?? ""), idempotencyKey) : undefined;
  const threadKey = channel === "email" ? inReplyTo?.threadKey ?? inReplyTo?.externalId ?? externalId : undefined;
  const lockDetails = defined({ "sendLock.to": target.to, "sendLock.subject": subject, "sendLock.externalId": externalId, "sendLock.threadKey": threadKey, "sendLock.template": input.template, "delivery.to": shownTo(channel, target.to) });
  const kept = await db.collection("sales_drafts").updateOne({ _id: claimed._id, "sendLock.requestId": input.requestId }, { $set: lockDetails });
  if (!kept.matchedCount) throw new AppError(409, "CONFLICT", CHANGED);
  const request: SendRequest = {
    account, secrets: openSecrets(env, account), to: target.to, ...(target.toName ? { toName: target.toName } : {}), ...(subject ? { subject } : {}), body: String(claimed.body ?? ""),
    ...(input.template ? { template: input.template } : {}), ...(inReplyTo ? { inReplyTo } : {}), idempotencyKey,
  };
  return { request, subject, to: target.to, inReplyTo, body: bodyOf(claimed, subject, input.template), externalId, threadKey };
}

/** Sends one ready draft through a connected account (POST /drafts/:id/send). Throws 4xx for refusals and 502 SEND_FAILED when it didn't go. */
export async function sendDraftThrough(ctx: SalesCtx, env: ChannelEnv, draft: AppDocument, lead: AppDocument, input: SendInput): Promise<SendResult> {
  forbidClaude(ctx.via, "Sending a message");
  requireLeadEditor(ctx, lead, "send this draft");
  const db = ctx.db;
  const drafts = db.collection("sales_drafts");
  const prior = logOf(draft, input.requestId);
  if (prior) return replay(ctx, draft, prior);
  if (draft.sendLock) {
    // A lock nobody finished becomes an uncertain send first (its own requestId then repeats "uncertain").
    const current = await flipStaleSend(db, draft);
    const logged = logOf(current, input.requestId);
    if (logged) return replay(ctx, current, logged);
    throw beingSent(current);
  }
  const channel = draft.channel;
  if (channel === "linkedin") throw new AppError(409, "CONFLICT", "LinkedIn messages can't be sent from the app: open the profile, send it yourself and mark it sent");
  if (!isSendChannel(channel)) throw new AppError(409, "CONFLICT", "A call opener is a script for call mode: it is not sent");
  if (input.template && channel !== "whatsapp") throw new AppError(400, "BAD_REQUEST", "Only WhatsApp messages are sent with a template");
  const ventureId = String(lead.ventureId);
  const play = draft.playId ? await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }) : null;
  const settings = await settingsFor(ctx, ventureId);
  const blocker = sendBlocker(draft, lead, play, settings);
  if (blocker) throw new AppError(409, "CONFLICT", blocker);
  const account = await pickSendAccount(ctx, ventureId, channel, input.accountId);
  const accountId = String(account._id);
  if (missingSecrets(env, account).length) throw new AppError(409, "CONFLICT", `${String(account.label)} needs to be reconnected: its saved ${channel === "email" ? "password" : "token"} can't be read. Enter it again in Sales > Channels`);
  const now = new Date();
  const target = await recipientFor(ctx, account, lead, channel);
  await checkWindow(ctx, account, lead, channel, input.template, now);
  const day = localDay(now, calendarOf(settings));

  // Claim the draft: only one request sets the lock on a ready draft, so a repeated or parallel click never sends twice.
  const claimed = await drafts.findOneAndUpdate(
    { _id: draft._id, workspaceId: ctx.workspaceId, status: "ready", sendLock: null },
    { $set: { sendLock: { requestId: input.requestId, by: ctx.actor.id, at: now, accountId, channel, day }, delivery: defined({ state: "sending", at: now, accountId, to: shownTo(channel, target.to) }), updatedAt: now }, $inc: { sendAttempts: 1 } },
    { returnDocument: "after" },
  );
  if (!claimed) {
    const current = await drafts.findOne({ _id: draft._id, workspaceId: ctx.workspaceId });
    const raced = current ? logOf(current, input.requestId) : undefined;
    if (current && raced) return replay(ctx, current, raced);
    if (current?.sendLock) throw beingSent(current);
    throw new AppError(409, "CONFLICT", "This draft was already sent, or changed: reload it");
  }
  const attempt = Number(claimed.sendAttempts ?? 1);
  // The draft as it was before the claim (nothing went out): its earlier delivery state comes back.
  const giveBack = () => drafts.updateOne({ _id: draft._id, "sendLock.requestId": input.requestId }, draft.delivery ? { $unset: { sendLock: "" }, $set: { delivery: draft.delivery, updatedAt: new Date() } } : { $unset: { sendLock: "", delivery: "" }, $set: { updatedAt: new Date() } });
  const unlock = async (set: Record<string, unknown>, extra: Record<string, unknown> = {}) => drafts.updateOne({ _id: draft._id, "sendLock.requestId": input.requestId }, { $unset: { sendLock: "" }, $set: { ...set, updatedAt: new Date() }, ...extra });

  // Then one of the day's sends (the venture's cap per person and channel); refused when used up, and the draft is given back.
  let release: () => Promise<void>;
  try {
    release = await claimSendSlot(ctx, ventureId, channel, now);
  } catch (error) {
    await giveBack();
    throw error;
  }

  let prepared: Prepared;
  try {
    prepared = await prepareSend(ctx, env, claimed, String(lead._id), account, channel, input, attempt);
  } catch (error) {
    // Refused at the last moment (or the bookkeeping broke): nothing went out, so both claims are given back.
    await release();
    await giveBack();
    throw error;
  }
  const outcome = await callProvider(prepared.request);
  const at = new Date();
  const to = shownTo(channel, prepared.to);

  if (outcome.state === "failed") {
    await release();
    await unlock({ delivery: defined({ state: "failed", at, accountId, to, error: outcome.error }) }, { $push: logPush({ requestId: input.requestId, outcome: "failed", error: outcome.error, attempt, at }) });
    await auditSales(ctx, "sales.draft.send_failed", "draft", String(draft._id), ventureId, { channel, attempt });
    throw failedSend(outcome.error);
  }

  const markUncertain = async (error: string) => {
    await drafts.updateOne({ _id: draft._id, "sendLock.requestId": input.requestId }, {
      $set: { delivery: defined({ state: "uncertain", at, accountId, to, error }), updatedAt: at },
      $push: logPush({ requestId: input.requestId, outcome: "uncertain", error, attempt, at }),
    });
    await auditSales(ctx, "sales.draft.send_uncertain", "draft", String(draft._id), ventureId, { channel, attempt });
    return { outcome: "uncertain" as const, draft: (await drafts.findOne({ _id: draft._id }))!, ...(to ? { to } : {}) };
  };
  if (outcome.state === "uncertain") return markUncertain(outcome.error);

  const message = defined({
    accountId, externalId: outcome.externalId, threadKey: outcome.threadKey, subject: prepared.subject, from: outcome.from ?? (channel === "email" ? account.settings?.address : undefined), to: outcome.to ?? prepared.to,
    delivery: { state: "sent", at, accountId },
  });
  let activity: AppDocument;
  try {
    activity = await recordSent(ctx, { draft: claimed, leadId: String(lead._id), requestId: input.requestId, channel, accountId, at: now, body: prepared.body, to: prepared.to, message, log: { requestId: input.requestId, outcome: "sent", attempt, at } });
  } catch (error) {
    // It went out but couldn't be written down: never a bare error (a retry would send it twice). Unless it was recorded after all, it
    // waits as an unclear send, and "It went out" records it.
    console.warn(JSON.stringify({ level: "warn", event: "sales.send.not_recorded", draftId: String(draft._id), message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    const current = await drafts.findOne({ _id: draft._id });
    const stored = current?.status === "sent" ? await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, draftId: String(draft._id), direction: "out" }) : null;
    if (current && stored) return { outcome: "sent", draft: current, activity: stored, lead: (await db.collection("opportunities").findOne({ _id: lead._id }))!, ...(to ? { to } : {}) };
    return markUncertain("The message went out, but it couldn't be recorded: say it went out to record it");
  }
  return { outcome: "sent", draft: (await drafts.findOne({ _id: draft._id }))!, activity, lead: (await db.collection("opportunities").findOne({ _id: lead._id }))!, ...(to ? { to } : {}) };
}

// ---- Settling an unclear send -------------------------------------------------------------------------------------------------------

/** The person who started the send, to log the message as theirs (their day's count holds it); the confirming person when that person is gone. */
async function senderCtx(ctx: SalesCtx, userId: unknown): Promise<SalesCtx> {
  if (typeof userId !== "string" || userId === ctx.actor.id) return ctx;
  const user = await ctx.db.collection("users").findOne({ _id: userId, status: "active" }, { projection: { email: 1, name: 1 } });
  const actor = user ? await actorFor(ctx.db, { id: userId, email: String(user.email ?? ""), name: String(user.name ?? "") }) : undefined;
  return actor && actor.membership.workspaceId === ctx.workspaceId ? { ...ctx, actor, settings: new Map() } : ctx;
}

/** An unclear send recorded as sent like any send (the account kind's `sentVia`, the account, the day's send already counted), as its sender's. */
async function recordUnclearAsSent(ctx: SalesCtx, draft: AppDocument, lead: AppDocument, lock: SendLock & { requestId: string }): Promise<AppDocument> {
  const channel = (isSendChannel(lock.channel) ? lock.channel : draft.channel) as SendChannel;
  const accountId = String(lock.accountId ?? draft.delivery?.accountId ?? "");
  const now = new Date();
  const account = accountId ? await ctx.db.collection(ACCOUNTS).findOne({ _id: accountId, workspaceId: ctx.workspaceId }) : null;
  const at = lock.at ? new Date(lock.at) : now;
  const message = defined({
    accountId, externalId: lock.externalId, threadKey: lock.threadKey, subject: lock.subject, from: channel === "email" ? account?.settings?.address : undefined, to: lock.to,
    delivery: { state: "sent", at: now, accountId },
  });
  const sender = await senderCtx(ctx, lock.by);
  return recordSent(sender, { draft, leadId: String(lead._id), requestId: lock.requestId, channel, accountId, at, body: bodyOf(draft, lock.subject, lock.template), to: lock.to, message });
}

/**
 * A person says whether an unclear send went out (POST /drafts/:id/delivery). `sent`: recorded as sent like any send. `not_sent`: the lock
 * is removed, the delivery reads failed, and the counted send is given back when it was today's. A lock still "sending" after two minutes
 * (a send nobody finished) is unclear too.
 */
export async function settleDelivery(ctx: SalesCtx, draft: AppDocument, lead: AppDocument, outcome: "sent" | "not_sent"): Promise<{ draft: AppDocument; activity?: AppDocument; lead?: AppDocument }> {
  forbidClaude(ctx.via, "Saying whether a message went out");
  requireLeadEditor(ctx, lead, "say whether this message went out");
  const current = draft.sendLock ? await flipStaleSend(ctx.db, draft) : draft;
  const lock = lockOf(current);
  if (current.delivery?.state === "sending" && lock?.requestId) throw new AppError(409, "CONFLICT", "This draft is still being sent: wait a moment and reload it");
  if (current.delivery?.state !== "uncertain" || !lock?.requestId) throw new AppError(409, "CONFLICT", "Only a send whose result was unclear can be confirmed here");
  const drafts = ctx.db.collection("sales_drafts");
  const channel = (isSendChannel(lock.channel) ? lock.channel : current.channel) as SendChannel;
  const accountId = String(lock.accountId ?? current.delivery?.accountId ?? "");
  const now = new Date();

  if (outcome === "not_sent") {
    const changed = await drafts.findOneAndUpdate(
      { _id: current._id, workspaceId: ctx.workspaceId, "sendLock.requestId": lock.requestId, "delivery.state": "uncertain" },
      { $unset: { sendLock: "" }, $set: { delivery: { state: "failed", at: now, ...(accountId ? { accountId } : {}), error: `Not sent (confirmed by ${ctx.actor.name || "a teammate"})` }, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!changed) throw new AppError(409, "CONFLICT", "This draft changed: reload it");
    // The send was counted for its sender on the day it was tried: give it back if that day is today (never below zero).
    const settings = await settingsFor(ctx, String(lead.ventureId));
    if (lock.day && lock.by && lock.day === localDay(now, calendarOf(settings))) {
      await ctx.db.collection("sales_send_counters").updateOne({ _id: `${ctx.workspaceId}:${String(lead.ventureId)}:${lock.by}:${channel}:${lock.day}`, count: { $gt: 0 } }, { $inc: { count: -1 }, $set: { updatedAt: now } });
    }
    await auditSales(ctx, "sales.draft.delivery", "draft", String(current._id), String(lead.ventureId), { channel, outcome });
    return { draft: changed };
  }

  const activity = await recordUnclearAsSent(ctx, current, lead, { ...lock, requestId: lock.requestId });
  await auditSales(ctx, "sales.draft.delivery", "draft", String(current._id), String(lead.ventureId), { channel, outcome });
  return { draft: (await drafts.findOne({ _id: current._id }))!, activity, lead: (await ctx.db.collection("opportunities").findOne({ _id: lead._id }))! };
}

/**
 * A bounce of our email `externalId` from the mailbox `accountId` for a send whose result is still unclear: the bounce proves it went out, so
 * it is recorded exactly as a person's "It went out" would be (the lock cleared, the outbound activity logged once); the caller then marks
 * the message bounced. False when this draft isn't waiting on that send.
 */
export async function settleSentByBounce(ctx: SalesCtx, draftId: string, accountId: string, externalId: string): Promise<boolean> {
  const draft = await ctx.db.collection("sales_drafts").findOne({ _id: draftId, workspaceId: ctx.workspaceId, "sendLock.accountId": accountId, "sendLock.channel": "email", "sendLock.externalId": externalId });
  if (!draft || !(draft.delivery?.state === "uncertain" || isStaleSend(draft))) return false;
  let lead: AppDocument;
  try { lead = await loadLead(ctx, String(draft.leadId)); } catch { return false; }
  const current = await flipStaleSend(ctx.db, draft);
  const lock = lockOf(current);
  if (current.delivery?.state !== "uncertain" || !lock?.requestId || lock.externalId !== externalId) return false;
  try {
    await recordUnclearAsSent(ctx, current, lead, { ...lock, requestId: lock.requestId });
  } catch (error) {
    if (error instanceof AppError && error.status === 409) return false;
    throw error;
  }
  await auditSales(ctx, "sales.draft.delivery", "draft", String(current._id), String(lead.ventureId), { channel: "email", outcome: "sent", bounced: true });
  return true;
}
