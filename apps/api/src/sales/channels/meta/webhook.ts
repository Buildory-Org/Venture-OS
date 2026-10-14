// Meta's webhook deliveries for WhatsApp and Instagram (docs/sales-channels.md section 6). One address serves every account: the payload
// names the WhatsApp number (or its WhatsApp Business account) or the Instagram account it is for, and a delivery counts only when its
// X-Hub-Signature-256 is the HMAC-SHA256 of the exact body bytes under the app secret of one of the accounts it names. Only the entries of
// accounts whose secret matched are processed. Messages go to inbound.ts; WhatsApp statuses (sent, delivered, read, failed) update the
// delivery of our message and its draft, never backwards and never a stage. A problem with one message never stops the others: it is
// logged in one short line (no bodies, numbers or secrets) and audited as a failure, and the delivery is answered 500 so Meta sends it
// again (messages already stored are skipped on the retry: their ids are unique). Statuses are best effort and never cause a retry.
import { audit } from "../../../audit.js";
import type { AppDocument, Database } from "../../../db.js";
import { AppError } from "../../../errors.js";
import { ACCOUNTS, openSecrets, type ChannelEnv } from "../accounts.js";
import { deliveryErrorMessage, signatureMatches } from "./graph.js";
import { receiveMessage, type InboundMessage } from "./inbound.js";
import { instagramProfile } from "./instagram.js";

export type WebhookAnswer = { status: 200 | 400 | 401 | 500; message: string; processed?: { messages: number; statuses: number; failed: number } };

/** A delivery naming more accounts than this is not one Meta sends: only the first ones are looked up. */
const MAX_IDS = 50;
const SIGNATURE = /^sha256=[0-9a-f]{64}$/i;
const META_ID = /^\d{5,30}$/;
/** A WhatsApp business-scoped user id: two letters for the country, a dot, then letters and digits. */
const BSUID = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
/** WhatsApp message types that are not something a person wrote (a reaction, a number change notice, a welcome request). */
const SKIPPED_TYPES = new Set(["reaction", "system", "request_welcome", "ephemeral"]);

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

/** The account ids a delivery names: WhatsApp numbers and their WhatsApp Business accounts, Instagram professional accounts. */
function namedIds(payload: any): { phones: string[]; wabas: string[]; instagram: string[] } {
  const phones = new Set<string>();
  const wabas = new Set<string>();
  const instagram = new Set<string>();
  for (const entry of list(payload?.entry)) {
    const id = String(entry?.id ?? "");
    if (payload?.object === "whatsapp_business_account") {
      if (META_ID.test(id)) wabas.add(id);
      for (const change of list(entry?.changes)) {
        const phone = String(change?.value?.metadata?.phone_number_id ?? "");
        if (META_ID.test(phone)) phones.add(phone);
      }
    } else if (payload?.object === "instagram" && META_ID.test(id)) instagram.add(id);
  }
  return { phones: [...phones].slice(0, MAX_IDS), wabas: [...wabas].slice(0, MAX_IDS), instagram: [...instagram].slice(0, MAX_IDS) };
}

/** How a WhatsApp message reads in the timeline: its text, the title of the button they tapped, or a short label for media (never downloaded). */
export function whatsappBody(message: any): string {
  const caption = (label: string, value: unknown) => (text(value, 2_000) ? `${label} ${text(value, 2_000)}` : label);
  switch (String(message?.type ?? "")) {
    case "text": return typeof message.text?.body === "string" ? message.text.body : "";
    case "image": return caption("[image]", message.image?.caption);
    case "video": return caption("[video]", message.video?.caption);
    case "document": { const name = text(message.document?.filename, 120); return caption(name ? `[document: ${name}]` : "[document]", message.document?.caption); }
    case "audio": return message.audio?.voice === false ? "[audio]" : "[voice note]";
    case "sticker": return "[sticker]";
    case "location": { const name = text(message.location?.name, 120); return name ? `[location: ${name}]` : "[location]"; }
    case "contacts": return "[contacts]";
    case "interactive": return text(message.interactive?.button_reply?.title, 500) || text(message.interactive?.list_reply?.title, 500) || (message.interactive?.nfm_reply ? "[form reply]" : "[reply]");
    case "button": return text(message.button?.text, 500) || text(message.button?.payload, 500) || "[button]";
    case "order": return "[order]";
    default: return "[a message WhatsApp couldn't show]";
  }
}

/** One WhatsApp message from a `messages` change, or undefined when it is nothing to store (a reaction, a notice, no sender). */
function whatsappMessage(raw: any, contacts: any[]): InboundMessage | undefined {
  if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 256) return undefined;
  if (SKIPPED_TYPES.has(String(raw.type ?? ""))) return undefined;
  const sender = typeof raw.from === "string" ? raw.from.trim() : "";
  const digits = /^\+?\d{8,15}$/.test(sender) ? sender.replace(/\D/g, "") : "";
  const phone = digits && !digits.startsWith("0") ? `+${digits}` : undefined;
  const contact = contacts.find((item) => (digits && item?.wa_id === digits) || (typeof raw.from_user_id === "string" && item?.user_id === raw.from_user_id)) ?? (contacts.length === 1 ? contacts[0] : undefined);
  // Meta is replacing numbers with business-scoped ids for people who hide theirs: keep the id, and use it as the sender when there's no number.
  const userId = [raw.from_user_id, contact?.user_id, sender].find((value): value is string => typeof value === "string" && BSUID.test(value));
  const from = phone ?? userId;
  if (!from) return undefined;
  const seconds = Number(raw.timestamp);
  const name = text(contact?.profile?.name, 120);
  return { kind: "whatsapp", externalId: raw.id, from, ...(userId ? { userId } : {}), ...(name ? { name } : {}), body: whatsappBody(raw) || "[empty message]", at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date() };
}

const INSTAGRAM_ATTACHMENT: Record<string, string> = { image: "[image]", video: "[video]", audio: "[voice note]", file: "[file]", share: "[shared post]", story_mention: "[story mention]", reel: "[reel]", ig_reel: "[reel]", animated_image: "[GIF]", sticker: "[sticker]" };

/** One Instagram message from `messaging[]`, or undefined for our own sends (echoes), deletions, reactions, read receipts and edits. */
function instagramMessage(event: any, accountIgId: string): InboundMessage | undefined {
  const message = event?.message;
  if (!message || typeof message.mid !== "string" || !message.mid || message.mid.length > 512) return undefined;
  if (message.is_echo === true || message.is_self === true || message.is_deleted === true) return undefined;
  const sender = String(event?.sender?.id ?? "");
  if (!/^\d{1,40}$/.test(sender) || sender === accountIgId) return undefined;
  const parts = [typeof message.text === "string" ? message.text : "", ...list(message.attachments).map((attachment) => INSTAGRAM_ATTACHMENT[String(attachment?.type ?? "")] ?? "[attachment]")].filter(Boolean);
  const body = parts.join(" ") || (message.is_unsupported ? "[a message Instagram couldn't show]" : "[message]");
  const stamp = Number(event?.timestamp);
  // Instagram's timestamps are in milliseconds (older payloads used seconds).
  const at = Number.isFinite(stamp) && stamp > 0 ? new Date(stamp < 1e12 ? stamp * 1000 : stamp) : new Date();
  return { kind: "instagram", externalId: message.mid, from: sender, body, at };
}

// ---- Delivery statuses ------------------------------------------------------------------------------------------------------

/** How far a message got: a status only moves it forward; `failed` wins over everything and stays. */
const RANK: Record<string, number> = { sending: 0, uncertain: 0, sent: 1, delivered: 2, read: 3, failed: 9 };
const STATES = Object.keys(RANK);

/** Applies one WhatsApp status to our outbound activity with that message id (this account's) and to its draft. Unknown ids are ignored. */
async function applyStatus(database: Database, account: AppDocument, status: any): Promise<boolean> {
  if (!status || typeof status.id !== "string" || !status.id) return false;
  const state = status.status === "played" ? "read" : String(status.status ?? "");
  if (!["sent", "delivered", "read", "failed"].includes(state)) return false;
  const lower = state === "failed" ? STATES.filter((name) => name !== "failed") : STATES.filter((name) => RANK[name]! < RANK[state]!);
  const seconds = Number(status.timestamp);
  const delivery = { state, at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(), accountId: String(account._id), ...(state === "failed" ? { error: deliveryErrorMessage(list(status.errors)[0]) } : {}) };
  const db = database.db;
  const activity = await db.collection("sales_activities").findOneAndUpdate(
    { workspaceId: account.workspaceId, "message.accountId": String(account._id), "message.externalId": status.id, direction: "out", $or: [{ "message.delivery": null }, { "message.delivery.state": { $in: lower } }] },
    { $set: { "message.delivery": delivery } }, { projection: { draftId: 1 } },
  );
  if (!activity) return false;
  if (typeof activity.draftId === "string") {
    await db.collection("sales_drafts").updateOne({ _id: activity.draftId, workspaceId: account.workspaceId, $or: [{ delivery: null }, { "delivery.state": { $in: lower } }] }, { $set: { delivery } });
  }
  return true;
}

// ---- One delivery -----------------------------------------------------------------------------------------------------------

/** Logs and audits a failed step for an account: what failed and an error code, never the message, a number or a secret. */
async function recordFailure(database: Database, account: AppDocument, step: string, error: unknown): Promise<void> {
  const code = error instanceof AppError ? error.code : typeof (error as { code?: unknown } | null)?.code === "number" ? `mongo_${String((error as { code: number }).code)}` : "error";
  console.warn(JSON.stringify({ level: "warn", event: "meta_webhook_failed", accountId: String(account._id), kind: String(account.kind), step, code }));
  await audit(database.db, { workspaceId: String(account.workspaceId), actorId: null, channel: "api", action: "sales.webhook.failed", objectType: "sales_channel_account", objectId: String(account._id), result: "failure", metadata: { kind: String(account.kind), step, code } }).catch(() => undefined);
}

/**
 * Checks and processes one webhook delivery: 401 when it is unsigned, or signed by none of the accounts it names (nothing is stored);
 * 400 when the body isn't JSON; otherwise 200 after processing what belongs to the verified accounts.
 */
export async function handleMetaDelivery(database: Database, env: Pick<ChannelEnv, "BETTER_AUTH_SECRET">, rawBody: Buffer, signature: string | undefined): Promise<WebhookAnswer> {
  const header = String(signature ?? "").trim();
  if (!SIGNATURE.test(header)) return { status: 401, message: "The delivery is not signed" };
  let payload: any;
  try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return { status: 400, message: "The delivery is not JSON" }; }
  const ids = namedIds(payload);
  const or: Record<string, unknown>[] = [];
  if (ids.phones.length) or.push({ kind: "whatsapp", "settings.phoneNumberId": { $in: ids.phones } });
  if (ids.wabas.length) or.push({ kind: "whatsapp", "settings.businessAccountId": { $in: ids.wabas } });
  if (ids.instagram.length) or.push({ kind: "instagram", "settings.instagramAccountId": { $in: ids.instagram } });
  const named = or.length ? await database.db.collection(ACCOUNTS).find({ $or: or }).limit(MAX_IDS * 3).toArray() : [];
  const verified = named.filter((account) => { const secret = openSecrets(env, account).appSecret; return Boolean(secret) && signatureMatches(rawBody, header, secret!); });
  if (!verified.length) return { status: 401, message: "The signature doesn't match any connected WhatsApp or Instagram account" };

  const processed = { messages: 0, statuses: 0, failed: 0 };
  const byPhone = new Map(verified.filter((account) => account.kind === "whatsapp").map((account) => [String(account.settings?.phoneNumberId ?? ""), account]));
  const byInstagram = new Map(verified.filter((account) => account.kind === "instagram").map((account) => [String(account.settings?.instagramAccountId ?? ""), account]));
  for (const entry of list(payload.entry)) {
    if (payload.object === "whatsapp_business_account") {
      for (const change of list(entry?.changes)) {
        // Only message changes of a verified number: template, quality and account updates are acknowledged and ignored.
        const account = change?.field === "messages" ? byPhone.get(String(change?.value?.metadata?.phone_number_id ?? "")) : undefined;
        if (!account) continue;
        const value = change.value;
        const contacts = list(value.contacts);
        const messages = list(value.messages).map((raw) => whatsappMessage(raw, contacts)).filter((message): message is InboundMessage => Boolean(message)).sort((a, b) => a.at.getTime() - b.at.getTime());
        for (const message of messages) {
          try { await receiveMessage(database, account, message); processed.messages += 1; } catch (error) { processed.failed += 1; await recordFailure(database, account, "message", error); }
        }
        for (const status of list(value.statuses)) {
          try { if (await applyStatus(database, account, status)) processed.statuses += 1; } catch (error) { await recordFailure(database, account, "status", error); }
        }
      }
    } else if (payload.object === "instagram") {
      const account = byInstagram.get(String(entry?.id ?? ""));
      if (!account) continue;
      const accountIgId = String(account.settings?.instagramAccountId ?? "");
      const lookup = (igsid: string) => instagramProfile(openSecrets(env, account), igsid);
      const messages = list(entry?.messaging).map((event) => instagramMessage(event, accountIgId)).filter((message): message is InboundMessage => Boolean(message)).sort((a, b) => a.at.getTime() - b.at.getTime());
      for (const message of messages) {
        try { await receiveMessage(database, account, message, lookup); processed.messages += 1; } catch (error) { processed.failed += 1; await recordFailure(database, account, "message", error); }
      }
    }
  }
  // A message that couldn't be stored (a database hiccup) must not be lost, a STOP least of all: Meta retries a delivery that isn't answered 200.
  if (processed.failed) return { status: 500, message: "Some messages couldn't be stored: Meta will send them again", processed };
  return { status: 200, message: "Received", processed };
}
