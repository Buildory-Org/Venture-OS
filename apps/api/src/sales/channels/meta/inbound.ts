// WhatsApp and Instagram messages that arrive through a venture's account (docs/sales-channels.md section 6): matched to a lead and filed
// on it as an inbound activity (the reply rules run: stage, follow-up stopped, Inbox item, the WhatsApp opt-in "they messaged", STOP as an
// opt-out), or kept as a new conversation (`sales_inbound`) for a person to link to a lead or dismiss. Who a sender is comes first from a
// link a person made (`sales_channel_contacts`), then from the lead's WhatsApp/phone routes (exactly one lead) or its Instagram handle
// (exactly one lead); anyone else, and anyone matching several leads, starts a conversation. Media is never downloaded: a short label
// stands in for it. Each provider message id is stored once (a unique index on activities; the conversation's kept items), so Meta's
// retries add nothing.
import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import { atomic, type AppDb, type AppDocument, type Database } from "../../../db.js";
import { AppError } from "../../../errors.js";
import { actorFor } from "../../../middleware.js";
import { canSeeVenture, canWriteIn, forbidden, notFound, requireWriter, type Actor } from "../../access.js";
import { auditSales, type SalesCtx } from "../../ctx.js";
import { applyActivity, loadLead, requireLeadEditor } from "../../leads.js";
import { leadJson, present } from "../../present.js";
import { extractPhones, normalizePhone } from "../../suppression.js";
import { ACCOUNTS } from "../accounts.js";

export const INBOUND = "sales_inbound";
export const CONTACTS = "sales_channel_contacts";
/** A conversation keeps its latest 50 messages (the count goes on). */
const KEPT_ITEMS = 50;
const MAX_BODY = 10_000;
const LIST_LIMIT = 200;
const KIND_LABEL: Record<string, string> = { whatsapp: "WhatsApp", instagram: "Instagram" };

export type InboundKind = "whatsapp" | "instagram";
export type InboundMessage = {
  kind: InboundKind;
  /** Meta's message id (WhatsApp `wamid…`, Instagram `mid`). */
  externalId: string;
  /** WhatsApp: "+<digits>" (or the business-scoped user id when Meta withholds the number). Instagram: the sender's Instagram-scoped id. */
  from: string;
  /** WhatsApp: the sender's business-scoped user id when Meta sends one (kept so a later message without the number still matches). */
  userId?: string | undefined;
  /** WhatsApp: the name on their profile. */
  name?: string | undefined;
  body: string;
  at: Date;
};
export type InboundResult = "filed" | "conversation" | "duplicate";
type Profile = { username?: string; name?: string };
type ActivityInput = Parameters<typeof applyActivity>[2];

const ventureIdsOf = (doc: AppDocument): string[] => (Array.isArray(doc.ventureIds) ? doc.ventureIds.map(String) : []);
const clip = (text: string, max = MAX_BODY) => (text.length > max ? text.slice(0, max) : text);
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

// ---- Opt-out words ----------------------------------------------------------------------------------------------------------

const OPT_OUT_WORDS = new Set(["stop", "unsubscribe", "stop messages", "band karo", "बंद करो"]);

/** The whole message is one of the opt-out words (any case, punctuation ignored): STOP, UNSUBSCRIBE, "stop messages", "band karo". */
export function isOptOut(body: string): boolean {
  return OPT_OUT_WORDS.has(body.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim());
}

// ---- Who the sender is ------------------------------------------------------------------------------------------------------

/** A link a person made (or an earlier exact match recorded) for this sender on this account, to a live lead the account still serves. */
async function linkedLead(db: AppDb, account: AppDocument, keys: string[]): Promise<AppDocument | undefined> {
  if (!keys.length) return undefined;
  const links = await db.collection(CONTACTS).find({ workspaceId: account.workspaceId, accountId: String(account._id), externalUserId: { $in: keys } }).toArray();
  links.sort((a, b) => keys.indexOf(String(a.externalUserId)) - keys.indexOf(String(b.externalUserId)));
  for (const link of links) {
    const lead = await db.collection("opportunities").findOne({ _id: link.leadId, workspaceId: account.workspaceId, deletedAt: null, ventureId: { $in: ventureIdsOf(account) } });
    if (lead) return lead;
  }
  return undefined;
}

/** The phone numbers a WhatsApp or phone route holds, normalised (India +91 by default). */
const routePhones = (value: unknown): string[] => {
  const text = String(value ?? "");
  return [normalizePhone(text), ...extractPhones(text)].filter((phone): phone is string => Boolean(phone));
};

/** Exactly one live lead in the account's ventures whose WhatsApp or phone route is this number; several or none: undefined. */
async function leadByPhone(db: AppDb, account: AppDocument, phone: string): Promise<AppDocument | undefined> {
  // The lead's match keys (suppression.ts) hold every number it can be reached on: they narrow the search, the routes decide.
  const rows = await db.collection("opportunities").find({ workspaceId: account.workspaceId, ventureId: { $in: ventureIdsOf(account) }, deletedAt: null, suppressKeys: `phone:${phone}` }, { limit: 20 }).toArray();
  const matching = rows.filter((lead) => (Array.isArray(lead.contactRoutes) ? lead.contactRoutes : []).some((route: any) => (route?.kind === "whatsapp" || route?.kind === "phone") && routePhones(route.value).includes(phone)));
  return matching.length === 1 ? matching[0] : undefined;
}

/** Exactly one live lead in the account's ventures whose Instagram route is @username or instagram.com/username; several or none: undefined. */
async function leadByUsername(db: AppDb, account: AppDocument, username: string): Promise<AppDocument | undefined> {
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) return undefined;
  const name = username.replace(/\./g, "\\.");
  const value = new RegExp(`^(?:@?${name}|https?://(?:www\\.)?instagram\\.com/${name}/?)$`, "i");
  const rows = await db.collection("opportunities").find({ workspaceId: account.workspaceId, ventureId: { $in: ventureIdsOf(account) }, deletedAt: null, contactRoutes: { $elemMatch: { kind: "instagram", value } } }, { limit: 2 }).toArray();
  return rows.length === 1 ? rows[0] : undefined;
}

/** The Instagram username already looked up for this sender (kept on their conversation), so it is asked for once. */
async function knownProfile(db: AppDb, account: AppDocument, igsid: string): Promise<Profile | undefined> {
  const row = await db.collection(INBOUND).findOne({ workspaceId: account.workspaceId, accountId: String(account._id), from: igsid, username: { $type: "string" } }, { sort: { at: -1 }, projection: { username: 1, profileName: 1 } });
  return row ? { username: String(row.username), ...(typeof row.profileName === "string" ? { name: row.profileName } : {}) } : undefined;
}

/**
 * Who inbound work on a lead is done as: its owner while they are an active member who opens the lead's venture, else the person who
 * connected the account. Activities are still marked `via: "system"`.
 */
async function actorForLead(db: AppDb, account: AppDocument, lead: AppDocument): Promise<Actor | undefined> {
  for (const userId of [lead.ownerId, account.createdBy]) {
    if (typeof userId !== "string" || !userId) continue;
    const user = await db.collection("users").findOne({ _id: userId, status: "active" }, { projection: { email: 1, name: 1 } });
    if (!user) continue;
    const actor = await actorFor(db, { id: userId, email: String(user.email ?? ""), name: String(user.name ?? "") });
    if (actor && actor.membership.workspaceId === account.workspaceId && canSeeVenture(actor, lead.ventureId)) return actor;
  }
  return undefined;
}

/** Remembers which lead a sender is on this account (a person linked them, or one exact match was found). */
async function linkContact(db: AppDb, account: { workspaceId?: unknown; _id: unknown; kind?: unknown }, externalUserId: string, lead: AppDocument, details: { how: string; by: string; name?: string | undefined; username?: string | undefined }, now: Date, session?: ClientSession): Promise<void> {
  const filter = { workspaceId: account.workspaceId, accountId: String(account._id), externalUserId };
  const update = {
    $set: { kind: account.kind, leadId: lead._id, ventureId: lead.ventureId, how: details.how, linkedBy: details.by, ...(details.name ? { name: details.name } : {}), ...(details.username ? { username: details.username } : {}), updatedAt: now },
    $setOnInsert: { _id: randomUUID(), createdAt: now },
  };
  try {
    await db.collection(CONTACTS).updateOne(filter, update, { upsert: true, session });
  } catch (error) {
    // Two upserts raced to create the link: the second one updates the row the first made.
    if (!isDuplicateKey(error) || session) throw error;
    await db.collection(CONTACTS).updateOne(filter, { $set: update.$set });
  }
}

/** What an activity records about the message: the account, Meta's id, the chat it belongs to, who wrote and to which number/account. */
function messageMeta(account: AppDocument, externalId: string, from: string): Record<string, unknown> {
  const settings = (account.settings ?? {}) as Record<string, unknown>;
  const to = account.kind === "whatsapp" ? settings.displayNumber : typeof settings.username === "string" && settings.username ? `@${String(settings.username).replace(/^@/, "")}` : undefined;
  return { accountId: String(account._id), externalId, threadKey: `${String(account._id)}:${from}`, from, ...(typeof to === "string" && to ? { to } : {}) };
}

const activityInput = (kind: InboundKind, body: string, at: Date): ActivityInput => ({ kind, direction: "in", body: clip(body), at: at.toISOString(), ...(isOptOut(body) ? { replyType: "opt_out" as const } : {}) });

// ---- Receiving one message --------------------------------------------------------------------------------------------------

/** Whether this message is already stored: as an activity, or in one of the sender's conversations. */
async function alreadyStored(db: AppDb, account: AppDocument, message: InboundMessage): Promise<boolean> {
  if (await db.collection("sales_activities").findOne({ "message.accountId": String(account._id), "message.externalId": message.externalId }, { projection: { _id: 1 } })) return true;
  return Boolean(await db.collection(INBOUND).findOne({ workspaceId: account.workspaceId, accountId: String(account._id), from: message.from, "items.externalId": message.externalId }, { projection: { _id: 1 } }));
}

/** Files the message on the lead as an inbound activity with every reply rule, as `actor`; "duplicate" when it was stored meanwhile. */
async function fileOnLead(database: Database, account: AppDocument, actor: Actor, lead: AppDocument, message: InboundMessage): Promise<"filed" | "duplicate" | "gone"> {
  const ctx: SalesCtx = { database, db: database.db, actor, via: "app", channel: "api", workspaceId: String(account.workspaceId), settings: new Map() };
  const now = new Date();
  const input = activityInput(message.kind, message.body, message.at.getTime() > now.getTime() ? now : message.at);
  const meta = messageMeta(account, message.externalId, message.from);
  let current: AppDocument | null = lead;
  for (let attempt = 0; ; attempt++) {
    if (!current) return "gone";
    const target: AppDocument = current;
    try {
      await atomic(database, (session) => applyActivity(ctx, target, input, now, session, "system", { message: meta }));
      return "filed";
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      // The lead moved while the activity was planned (another message, an edit): plan again from where it is now.
      if (error instanceof AppError && error.status === 409 && attempt === 0) { current = await database.db.collection("opportunities").findOne({ _id: lead._id, workspaceId: account.workspaceId, deletedAt: null }); continue; }
      throw error;
    }
  }
}

/** Adds the message to the sender's open conversation on this account, or starts one (one open conversation per account and sender). */
async function addToConversation(db: AppDb, account: AppDocument, message: InboundMessage, profile?: Profile): Promise<InboundResult> {
  const conversations = db.collection(INBOUND);
  const base = { workspaceId: account.workspaceId, accountId: String(account._id), from: message.from };
  const item = { externalId: message.externalId, body: clip(message.body), at: message.at };
  const name = message.kind === "instagram" ? (profile?.username ? `@${profile.username}` : profile?.name) : message.name;
  const details = { ...(name ? { name } : {}), ...(profile?.username ? { username: profile.username } : {}), ...(profile?.name ? { profileName: profile.name } : {}), ...(message.userId ? { userId: message.userId } : {}) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = new Date();
    const open = await conversations.findOne({ ...base, open: true });
    if (open) {
      if (Array.isArray(open.items) && open.items.some((kept: any) => kept?.externalId === message.externalId)) return "duplicate";
      const newest = !open.at || message.at.getTime() >= new Date(open.at).getTime();
      const added = await conversations.updateOne(
        { _id: open._id, open: true, "items.externalId": { $ne: message.externalId } },
        { $push: { items: { $each: [item], $sort: { at: 1 }, $slice: -KEPT_ITEMS } }, $inc: { messages: 1 }, $set: { ...details, ...(newest ? { body: item.body, at: message.at } : {}), updatedAt: now } } as never,
      );
      if (added.matchedCount) return "conversation";
      continue; // handled or added meanwhile: look again
    }
    try {
      await conversations.insertOne({ _id: randomUUID(), ...base, kind: message.kind, ventureIds: ventureIdsOf(account), open: true, ...details, body: item.body, at: message.at, messages: 1, items: [item], createdAt: now, updatedAt: now });
      return "conversation";
    } catch (error) {
      if (!isDuplicateKey(error)) throw error; // another delivery opened it first: add to that one
    }
  }
  throw new Error("The conversation kept changing while a message was added to it");
}

/**
 * Receives one WhatsApp or Instagram message for a verified account: filed on its lead, kept in a new conversation, or ignored as already
 * stored. `lookupProfile` (Instagram) asks Instagram for the sender's username when nothing links them yet.
 */
export async function receiveMessage(database: Database, account: AppDocument, message: InboundMessage, lookupProfile?: (igsid: string) => Promise<Profile | undefined>): Promise<InboundResult> {
  const db = database.db;
  if (await alreadyStored(db, account, message)) return "duplicate";
  const keys = [message.from, message.userId].filter((key): key is string => typeof key === "string" && key.length > 0);
  let lead = await linkedLead(db, account, keys);
  let how: "phone" | "username" | undefined;
  let profile: Profile | undefined;
  if (!lead && message.kind === "whatsapp" && message.from.startsWith("+")) {
    lead = await leadByPhone(db, account, message.from);
    if (lead) how = "phone";
  }
  if (!lead && message.kind === "instagram") {
    profile = (await knownProfile(db, account, message.from)) ?? (await lookupProfile?.(message.from).catch(() => undefined));
    if (profile?.username) {
      lead = await leadByUsername(db, account, profile.username);
      if (lead) how = "username";
    }
  }
  if (lead) {
    const actor = await actorForLead(db, account, lead);
    if (actor) {
      const filed = await fileOnLead(database, account, actor, lead, message);
      if (filed === "duplicate") return "duplicate";
      if (filed === "filed") {
        const now = new Date();
        // An Instagram reply goes to the sender's Instagram-scoped id, found through this link; a WhatsApp business-scoped id is kept so
        // a later message that comes without the number still finds the lead.
        if (how === "username") await linkContact(db, account, message.from, lead, { how, by: actor.id, username: profile?.username, name: profile?.name }, now);
        if (how === "phone" && message.userId) await linkContact(db, account, message.userId, lead, { how, by: actor.id, name: message.name }, now);
        return "filed";
      }
    }
  }
  // Nobody (or several leads) matches, or there is no one left to act for the lead: a person decides.
  return addToConversation(db, account, message, profile);
}

// ---- The conversations API --------------------------------------------------------------------------------------------------

/** A conversation as API JSON (InboundConversation), with the messages it keeps. */
export function conversationJson(row: AppDocument): Record<string, unknown> {
  const items = Array.isArray(row.items) ? row.items : [];
  return present({
    _id: row._id, workspaceId: row.workspaceId, accountId: row.accountId, kind: row.kind, ventureIds: ventureIdsOf(row), from: row.from, name: row.name, body: row.body ?? "", at: row.at,
    messages: typeof row.messages === "number" && row.messages > 0 ? row.messages : Math.max(1, items.length), handledAt: row.handledAt, handledBy: row.handledBy, leadId: row.leadId,
    items: items.map((item: any) => ({ externalId: item?.externalId, body: item?.body ?? "", at: item?.at })),
  });
}

/** The open conversations of accounts serving the ventures the person writes in (or one of them), newest first. */
export async function listConversations(ctx: SalesCtx, ventureId?: string): Promise<Record<string, unknown>[]> {
  const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId, open: true };
  if (ventureId) {
    requireWriter(ctx.actor, ventureId, "see new conversations");
    filter.ventureIds = ventureId;
  } else if (ctx.actor.membership.role !== "admin") {
    const mine = ctx.actor.membership.ventureIds.filter((id) => canWriteIn(ctx.actor, id));
    if (!mine.length) throw forbidden("Your role is read-only: new conversations are for people who write in a venture");
    filter.ventureIds = { $in: mine };
  }
  const rows = await ctx.db.collection(INBOUND).find(filter).sort({ at: -1, _id: -1 }).limit(LIST_LIMIT).toArray();
  return rows.filter((row) => ventureIdsOf(row).some((id) => canWriteIn(ctx.actor, id))).map(conversationJson);
}

/** One conversation a writer of one of its ventures may handle; others read it as missing (or read-only for learners). */
async function loadConversation(ctx: SalesCtx, id: string): Promise<AppDocument> {
  const row = await ctx.db.collection(INBOUND).findOne({ _id: id, workspaceId: ctx.workspaceId });
  if (!row || !ventureIdsOf(row).some((ventureId) => canSeeVenture(ctx.actor, ventureId))) throw notFound("Conversation");
  if (!ventureIdsOf(row).some((ventureId) => canWriteIn(ctx.actor, ventureId))) throw forbidden("Your role in this venture is read-only: you cannot handle new conversations");
  return row;
}

const alreadyHandled = () => new AppError(409, "CONFLICT", "This conversation was already handled: reload the Inbox");

/**
 * Links the conversation's sender to a lead and files the messages it kept as inbound activities on that lead (oldest first, with every
 * reply rule; STOP counts as an opt-out), then marks it handled. The lead must be one the person can edit, in a venture the account serves.
 * Later messages from the sender go straight to the lead.
 */
export async function attachConversation(ctx: SalesCtx, id: string, leadId: string): Promise<{ conversation: Record<string, unknown>; lead: Record<string, unknown> }> {
  const conversation = await loadConversation(ctx, id);
  if (conversation.open !== true) throw alreadyHandled();
  const lead = await loadLead(ctx, leadId);
  requireLeadEditor(ctx, lead, "link a conversation to this lead");
  const kind = conversation.kind === "instagram" ? "instagram" : "whatsapp";
  const account = await ctx.db.collection(ACCOUNTS).findOne({ _id: conversation.accountId, workspaceId: ctx.workspaceId });
  const ventures = account ? ventureIdsOf(account) : ventureIdsOf(conversation);
  if (!ventures.includes(String(lead.ventureId))) throw new AppError(409, "CONFLICT", `That lead's venture doesn't use this ${KIND_LABEL[kind]} account: link a lead from a venture it serves`);
  const accountId = String(conversation.accountId);
  const from = String(conversation.from);
  const metaAccount = account ?? { _id: accountId, workspaceId: ctx.workspaceId, kind, settings: {} };
  const items = (Array.isArray(conversation.items) ? conversation.items : [])
    .filter((item: any) => typeof item?.externalId === "string")
    .map((item: any) => ({ externalId: String(item.externalId), body: String(item.body ?? ""), at: new Date(item.at) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const now = new Date();
  let claimed = false;
  let filed = 0;
  try {
    await atomic(ctx.database, async (session) => {
      filed = 0;
      const claim = await ctx.db.collection(INBOUND).updateOne({ _id: conversation._id, workspaceId: ctx.workspaceId, open: true }, { $unset: { open: "" }, $set: { handledAt: now, handledBy: ctx.actor.id, leadId: lead._id, updatedAt: now } }, { session });
      if (!claim.modifiedCount) throw alreadyHandled();
      claimed = true;
      const senders = new Set([from, conversation.userId].filter((key): key is string => typeof key === "string" && key.length > 0));
      for (const sender of senders) await linkContact(ctx.db, { workspaceId: ctx.workspaceId, _id: accountId, kind }, sender, lead, { how: "attached", by: ctx.actor.id, name: typeof conversation.profileName === "string" ? conversation.profileName : typeof conversation.name === "string" ? conversation.name : undefined, username: typeof conversation.username === "string" ? conversation.username : undefined }, now, session);
      // Messages already on a lead (an earlier attempt without transactions, a delivery filed meanwhile) are skipped.
      const stored = new Set((await ctx.db.collection("sales_activities").find({ "message.accountId": accountId, "message.externalId": { $in: items.map((item) => item.externalId) } }, { session, projection: { message: 1 } }).toArray()).map((row) => String(row.message?.externalId)));
      for (const item of items) {
        if (stored.has(item.externalId)) continue;
        // Each message is planned from the lead as the previous one left it (the first reply moves the stage, a STOP closes it).
        const current = await loadLead(ctx, String(lead._id), session);
        await applyActivity(ctx, current, activityInput(kind, item.body, item.at.getTime() > now.getTime() ? now : item.at), now, session, "system", { message: messageMeta(metaAccount, item.externalId, from) });
        filed += 1;
      }
      await auditSales(ctx, "sales.inbound.attach", "sales_inbound", String(conversation._id), String(lead.ventureId), { kind, messages: filed }, session);
    });
  } catch (error) {
    // Without transactions what was filed stays filed: the conversation opens again so a person can retry (filed messages are skipped then).
    if (claimed && !ctx.database.transactions) await ctx.db.collection(INBOUND).updateOne({ _id: conversation._id }, { $set: { open: true }, $unset: { handledAt: "", handledBy: "", leadId: "" } }).catch(() => undefined);
    throw error;
  }
  const [row, fresh] = await Promise.all([ctx.db.collection(INBOUND).findOne({ _id: conversation._id }), ctx.db.collection("opportunities").findOne({ _id: lead._id, workspaceId: ctx.workspaceId })]);
  return { conversation: conversationJson(row ?? conversation), lead: leadJson(fresh ?? lead) };
}

/** Marks a conversation handled without a lead (spam, a wrong number, nothing to do). Its messages stay where they are. */
export async function dismissConversation(ctx: SalesCtx, id: string): Promise<Record<string, unknown>> {
  const conversation = await loadConversation(ctx, id);
  if (conversation.open !== true) throw alreadyHandled();
  const now = new Date();
  const ventureId = ventureIdsOf(conversation).find((venture) => canWriteIn(ctx.actor, venture));
  await atomic(ctx.database, async (session) => {
    const done = await ctx.db.collection(INBOUND).updateOne({ _id: conversation._id, workspaceId: ctx.workspaceId, open: true }, { $unset: { open: "" }, $set: { handledAt: now, handledBy: ctx.actor.id, updatedAt: now } }, { session });
    if (!done.modifiedCount) throw alreadyHandled();
    await auditSales(ctx, "sales.inbound.dismiss", "sales_inbound", String(conversation._id), ventureId, { kind: String(conversation.kind), messages: Number(conversation.messages ?? 1) }, session);
  });
  return conversationJson((await ctx.db.collection(INBOUND).findOne({ _id: conversation._id })) ?? conversation);
}
