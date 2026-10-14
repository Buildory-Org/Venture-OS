import { z } from "zod";
import {
  activitySchema, channelAccountInputSchema, channelAccountSchema, channelAccountTestSchema, channelAccountUpdateSchema, draftDeliveryReconcileSchema, draftSchema,
  draftSendThroughInputSchema, EMAIL_PROVIDER_PRESETS, inboundAttachSchema, inboundConversationSchema, opportunitySchema, successEnvelope, whatsappTemplateSchema,
  type ChannelAccount, type ChannelAccountTest, type ChannelKind, type InboundConversation,
} from "@venture-studio/contracts";
import { StudioApiError } from "@/lib/studio-api";
import { salesRequest as request } from "@/lib/sales-api";

// Client for Sales channels (docs/sales-channels.md): the accounts a person sends and receives through (their mailbox, the venture's WhatsApp
// number and Instagram account, their LinkedIn profile), sending a ready draft through one, and new WhatsApp/Instagram conversations from
// people who are not leads yet. Every route lives under /v1/sales and takes a signed-in person only. A server without these routes answers
// "Route not found": callers then hide the feature (isRouteMissing).

export type { ChannelAccount, ChannelAccountTest, ChannelKind, InboundConversation };
export type ChannelAccountInput = z.input<typeof channelAccountInputSchema>;
export type ChannelAccountUpdate = z.input<typeof channelAccountUpdateSchema>;
export type WhatsappTemplate = z.infer<typeof whatsappTemplateSchema>;
export type EmailPreset = { label: string; smtp: { host: string; port: number; security: "ssl" | "starttls" }; imap: { host: string; port: number; security: "ssl" | "starttls" }; saveToSent: boolean };

const json = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });
const id = encodeURIComponent;
function query(input: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** True when this server has no such route (an API from before channels): the screen hides the feature instead of showing an error. */
export const isRouteMissing = (cause: unknown) => cause instanceof StudioApiError && cause.code === "NOT_FOUND" && /route not found/i.test(cause.message);
/** The API's error code (TEMPLATE_REQUIRED, SEND_FAILED, CONFLICT…), or undefined for a network failure or anything else. */
export const errorCode = (cause: unknown) => cause instanceof StudioApiError ? cause.code : undefined;

// ---- Accounts ------------------------------------------------------------------------------------------------------------------------------

/** The accounts the person can see: their own mailboxes and LinkedIn profiles, the WhatsApp numbers and Instagram accounts of their ventures (heads also see who connected what). */
export async function listChannelAccounts(input: { ventureId?: string; kind?: ChannelKind } = {}) {
  return successEnvelope(z.array(channelAccountSchema)).parse(await request(`/v1/sales/channels${query(input)}`)).data;
}
/** Connects an account (status "not tested" until Test). Secrets are sent once and never come back. */
export async function createChannelAccount(input: ChannelAccountInput) {
  const account = successEnvelope(channelAccountSchema).parse(await request("/v1/sales/channels", json(channelAccountInputSchema.parse(input)))).data;
  forgetChannelAccounts();
  return account;
}
/** Changes an account: `settings` replaces the whole settings object; `secrets` replaces only the ones given (a new secret or server setting resets the status to "not tested"). */
export async function updateChannelAccount(accountId: string, input: ChannelAccountUpdate) {
  const account = successEnvelope(channelAccountSchema).parse(await request(`/v1/sales/channels/${id(accountId)}`, json(channelAccountUpdateSchema.parse(input), "PATCH"))).data;
  forgetChannelAccounts();
  return account;
}
/** Removes an account. Messages already sent through it keep their history. */
export async function deleteChannelAccount(accountId: string) {
  successEnvelope(z.object({ deleted: z.boolean() }).partial()).parse(await request(`/v1/sales/channels/${id(accountId)}`, { method: "DELETE" }));
  forgetChannelAccounts();
}
/** Checks the connection without sending anything (mail server login, Meta's number and templates) and stores the result on the account. */
export async function testChannelAccount(accountId: string): Promise<ChannelAccountTest> {
  const result = successEnvelope(channelAccountTestSchema).parse(await request(`/v1/sales/channels/${id(accountId)}/test`, json({}))).data;
  forgetChannelAccounts();
  return result;
}

const securitySchema = z.enum(["ssl", "starttls"]);
const serverSchema = z.object({ host: z.string(), port: z.number(), security: securitySchema });
const presetsSchema = z.record(z.string(), z.object({ label: z.string(), smtp: serverSchema, imap: serverSchema, saveToSent: z.boolean() }));
/** Ready-made mail server settings per provider. A server without the route gets the ones this app was built with. */
export async function getEmailPresets(): Promise<Record<string, EmailPreset>> {
  try { return successEnvelope(presetsSchema).parse(await request("/v1/sales/channels/presets")).data; }
  catch (cause) { if (isRouteMissing(cause) || (cause instanceof StudioApiError && cause.code === "NOT_FOUND")) return { ...EMAIL_PROVIDER_PRESETS }; throw cause; }
}
/** The WhatsApp number's approved message templates (for messages outside the 24-hour window). */
export async function listWhatsappTemplates(accountId: string) {
  return successEnvelope(z.array(whatsappTemplateSchema)).parse(await request(`/v1/sales/channels/${id(accountId)}/templates`)).data;
}

/**
 * Every account the person can see, kept for a minute so the draft reader, the lead timeline, the inbox and the setup checklist share one
 * read. `null` when this server has no channels yet. A failed read is not kept; any change through this client forgets it.
 */
const ACCOUNTS_TTL_MS = 60_000;
let accountsCache: { at: number; value: Promise<ChannelAccount[] | null> } | null = null;
export function getCachedChannelAccounts(): Promise<ChannelAccount[] | null> {
  if (accountsCache && Date.now() - accountsCache.at < ACCOUNTS_TTL_MS) return accountsCache.value;
  const value = listChannelAccounts().catch((cause: unknown) => {
    if (isRouteMissing(cause)) return null;
    accountsCache = null;
    throw cause;
  });
  accountsCache = { at: Date.now(), value };
  return value;
}
export function forgetChannelAccounts() { accountsCache = null; }

// ---- Sending a draft through an account -------------------------------------------------------------------------------------------------

const sentSchema = z.object({ draft: draftSchema, activity: activitySchema, lead: opportunitySchema });
const draftOnlySchema = z.union([z.object({ draft: draftSchema }), draftSchema.transform((draft) => ({ draft }))]);
export type SendResult =
  | { outcome: "sent"; draft: z.infer<typeof draftSchema>; activity?: z.infer<typeof activitySchema>; lead?: z.infer<typeof opportunitySchema> }
  | { outcome: "uncertain" | "pending"; draft: z.infer<typeof draftSchema> };

/**
 * Sends a ready draft through a connected account (the person's default for the venture and channel unless `accountId` names one). Keep one
 * `requestId` per attempt: a retry with it gets the first answer instead of sending twice. Answers "sent", or "uncertain" when the provider's
 * answer never came (a person then says whether it went out). Refusals throw: 409 TEMPLATE_REQUIRED (WhatsApp outside 24 hours), 409 with
 * the reason (no route, no account, already being sent), 502 SEND_FAILED with the provider's reason.
 */
export async function sendDraftThrough(draftId: string, input: z.input<typeof draftSendThroughInputSchema>): Promise<SendResult> {
  const body = await request(`/v1/sales/drafts/${id(draftId)}/send`, json(draftSendThroughInputSchema.parse(input)));
  const sent = successEnvelope(sentSchema).safeParse(body);
  if (sent.success) return { outcome: "sent", ...sent.data.data };
  const { draft } = successEnvelope(draftOnlySchema).parse(body).data;
  if (draft.status === "sent") return { outcome: "sent", draft };
  return { outcome: draft.delivery?.state === "uncertain" ? "uncertain" : "pending", draft };
}
/** A person's answer to a send that could not be confirmed: it went out (recorded as sent) or it didn't (the draft can be sent again). */
export async function reconcileDraftDelivery(draftId: string, input: z.input<typeof draftDeliveryReconcileSchema>) {
  const body = await request(`/v1/sales/drafts/${id(draftId)}/delivery`, json(draftDeliveryReconcileSchema.parse(input)));
  return successEnvelope(z.union([z.object({ draft: draftSchema, activity: activitySchema.optional(), lead: opportunitySchema.optional() }), draftSchema.transform((draft) => ({ draft }))])).parse(body).data;
}

// ---- New conversations (WhatsApp and Instagram messages from people who are not leads yet) --------------------------------------------

/** Open conversations on the accounts of the person's ventures, newest first. */
export async function listInbound(input: { ventureId?: string } = {}) {
  return successEnvelope(z.array(inboundConversationSchema)).parse(await request(`/v1/sales/inbound${query(input)}`)).data;
}
/** Links the sender to a lead in one of the account's ventures: the kept messages are filed on the lead and the conversation is handled. */
export async function attachInbound(conversationId: string, input: z.input<typeof inboundAttachSchema>) {
  return successEnvelope(z.object({ conversation: inboundConversationSchema, lead: opportunitySchema })).parse(await request(`/v1/sales/inbound/${id(conversationId)}/attach`, json(inboundAttachSchema.parse(input)))).data;
}
/** Marks a conversation handled without a lead (spam, a wrong number). */
export async function dismissInbound(conversationId: string) {
  successEnvelope(z.unknown()).parse(await request(`/v1/sales/inbound/${id(conversationId)}/dismiss`, json({})));
}
