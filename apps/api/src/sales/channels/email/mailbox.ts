// Mail (docs/sales-channels.md section 3a): a person's own connected mailbox, read live over IMAP the way a webmail reads it. Folders, the
// message list, one message, its attachments, read/unread and starred, moving to Trash, Spam or Archive, and sending (new, reply, reply to
// all, forward). Only the mailbox's owner reaches any of it (routes/sales-mail.ts); nothing read here is stored.
//
// Connections: one IMAP connection per mailbox is kept for a short while (it closes after 90 seconds unused) and the requests for a mailbox
// take turns on it, so opening messages one after another doesn't sign in each time. A connection that dropped while unused is replaced once.
// Every call has a time limit: past it the connection is closed and the person is told the server was slow.
//
// A message's HTML is cleaned here (scripts, frames, forms, meta and base tags, event attributes and script links taken out) and the web app
// shows it only inside a sandboxed frame that runs no script and loads no picture from the internet until the reader asks.
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type { MailAddress, MailFolder, MailFolderRole, MailRow } from "@venture-studio/contracts";
import { AppError } from "../../../errors.js";
import type { AppDocument } from "../../../db.js";
import { openSecrets, type ChannelEnv } from "../accounts.js";
import { connectImap, domainOf, imapFailure, MailServerRefused, settingsOf, smtpSession, type EmailSettings } from "./provider.js";
import { htmlToText } from "./sync.js";

// ---- The IMAP client ------------------------------------------------------------------------------------------------------------------

export type MailboxEnvelope = { date?: Date | string | undefined; subject?: string | undefined; messageId?: string | undefined; inReplyTo?: string | undefined; from?: { name?: string | undefined; address?: string | undefined }[] | undefined; to?: { name?: string | undefined; address?: string | undefined }[] | undefined; cc?: { name?: string | undefined; address?: string | undefined }[] | undefined };
export type MailboxStructure = { part?: string | undefined; type: string; parameters?: Record<string, string> | undefined; id?: string | undefined; encoding?: string | undefined; size?: number | undefined; disposition?: string | undefined; dispositionParameters?: Record<string, string> | undefined; childNodes?: MailboxStructure[] | undefined };
export type MailboxFetched = { uid: number; flags?: Set<string> | undefined; envelope?: MailboxEnvelope | undefined; internalDate?: Date | string | undefined; size?: number | undefined; bodyStructure?: MailboxStructure | undefined; source?: Buffer | undefined };
export type MailboxListed = { path: string; name: string; delimiter?: string | undefined; parent?: string[] | undefined; flags: Set<string>; specialUse?: string | undefined; status?: { messages?: number | undefined; unseen?: number | undefined } | undefined };

/** The part of ImapFlow the mailbox uses (tests hand in a stand-in with the same shape). */
export type MailboxClient = {
  readonly usable: boolean;
  readonly mailbox: { exists: number } | false | undefined;
  list(options?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<MailboxListed[]>;
  getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<{ release(): void }>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: number[], query: Record<string, unknown>, options: { uid: true }): Promise<MailboxFetched[]>;
  fetchOne(uid: string, query: Record<string, unknown>, options: { uid: true }): Promise<MailboxFetched | false | undefined>;
  download(uid: string, part: string, options: { uid: true; maxBytes?: number }): Promise<{ meta?: { contentType?: string | undefined; filename?: string | undefined; expectedSize?: number | undefined } | undefined; content?: Readable | undefined }>;
  messageFlagsAdd(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
  messageFlagsRemove(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
  messageMove(range: string, destination: string, options: { uid: true }): Promise<unknown>;
  logout(): Promise<void>;
  close(): void;
};
export type MailboxConnect = (settings: EmailSettings, password: string, signal: AbortSignal) => Promise<MailboxClient>;

const realConnect: MailboxConnect = async (settings, password, signal) => (await connectImap(settings, password, signal)) as unknown as MailboxClient;
let connector: MailboxConnect = realConnect;
/** Tests only: answers every mailbox connection with a stand-in; returns the function that puts the real one back (and drops every connection). */
export function useMailboxForTests(connect: MailboxConnect): () => void {
  if (process.env.NODE_ENV === "production") throw new Error("useMailboxForTests is for tests only");
  closeAllMailboxes();
  connector = connect;
  return () => { closeAllMailboxes(); connector = realConnect; };
}

// ---- Kept connections ------------------------------------------------------------------------------------------------------------------

/** How long an unused connection stays open (under the connection's own 60-second quiet limit, after which the socket closes anyway). */
export const MAILBOX_IDLE_MS = 50_000;
/** One request's limit, counted from when it was asked (waiting for the mailbox's earlier requests included), inside the web app's one-minute proxy limit. */
export const MAILBOX_CALL_MS = 45_000;
export const MAILBOX_DOWNLOAD_MS = 55_000;
/** Mailboxes with a kept connection at once: past it the longest unused one closes. */
const MAX_KEPT = 40;
/** Requests that may wait for one mailbox at once: past it the person is asked to try again. */
const MAX_WAITING = 8;

type Slot = { key: string; client?: MailboxClient | undefined; queue: Promise<void>; idle?: NodeJS.Timeout | undefined; lastUsed: number; waiting: number };
const slots = new Map<string, Slot>();

/** A connection is kept per mailbox and version of its settings: a changed password or server opens a new one. */
const slotKey = (account: AppDocument) => `${String(account._id)}:${account.updatedAt instanceof Date ? account.updatedAt.getTime() : String(account.updatedAt ?? "")}`;

function drop(id: string, slot: Slot) {
  clearTimeout(slot.idle);
  if (slots.get(id) === slot) slots.delete(id);
  const client = slot.client;
  slot.client = undefined;
  if (client) void client.logout().catch(() => client.close());
}

export function closeAllMailboxes() {
  for (const [id, slot] of [...slots]) drop(id, slot);
}

function keepRoom() {
  if (slots.size <= MAX_KEPT) return;
  const oldest = [...slots].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (oldest) drop(oldest[0], oldest[1]);
}

/** Connection failures (a dropped socket, a closed connection): the request is tried once more on a new connection. Never a server's NO answer. */
const DROPPED = /^(NoConnection|EConnectionClosed|ETIMEDOUT|ECONNRESET|EPIPE|ECONNABORTED|ClosedAfterConnectTLS|ClosedAfterConnectText)$/;

const tooSlow = () => new AppError(502, "INTEGRATION_UNAVAILABLE", "Your mail server took too long to answer: try again in a moment");

/** Why the mailbox couldn't be read, in words; never what the server said. */
function mailboxError(error: unknown, settings: EmailSettings, timedOut: boolean): AppError {
  if (error instanceof AppError) return error;
  if (timedOut) return tooSlow();
  if (error instanceof MailServerRefused) return new AppError(502, "INTEGRATION_UNAVAILABLE", error.message);
  return new AppError(502, "INTEGRATION_UNAVAILABLE", imapFailure(error, settings).message);
}

/**
 * Runs `work` on the mailbox's connection: after the mailbox's earlier requests, on its kept connection (a new one when there is none or
 * it dropped), within the time limit counted from now. A request whose browser went away (`gone`) is skipped when its turn comes. Errors
 * come back as AppError with words a person understands.
 */
export async function withMailbox<T>(env: Pick<ChannelEnv, "BETTER_AUTH_SECRET">, account: AppDocument, work: (client: MailboxClient) => Promise<T>, limitMs = MAILBOX_CALL_MS, gone?: AbortSignal): Promise<T> {
  const password = openSecrets(env, account).password;
  if (!password) throw new AppError(409, "CONFLICT", "No password is saved for this mailbox: enter it again in Sales > Channels");
  const id = String(account._id);
  const key = slotKey(account);
  let slot = slots.get(id);
  if (slot && slot.key !== key) { drop(id, slot); slot = undefined; }
  if (!slot) { slot = { key, queue: Promise.resolve(), lastUsed: Date.now(), waiting: 0 }; slots.set(id, slot); keepRoom(); }
  const mine = slot;
  if (mine.waiting >= MAX_WAITING) throw new AppError(429, "RATE_LIMITED", "Your mailbox is still busy with earlier requests: try again in a moment");
  const deadline = Date.now() + limitMs;
  mine.waiting++;
  const run = mine.queue.then(() => attempt(id, mine, settingsOf(account), password, work, deadline, gone)).finally(() => { mine.waiting--; });
  mine.queue = run.then(() => undefined, () => undefined);
  return run;
}

async function attempt<T>(id: string, slot: Slot, settings: EmailSettings, password: string, work: (client: MailboxClient) => Promise<T>, deadline: number, gone?: AbortSignal): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) throw tooSlow();
  if (gone?.aborted) throw new AppError(400, "BAD_REQUEST", "The request was left before its turn");
  clearTimeout(slot.idle);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), left);
  try {
    for (let tries = 0; ; tries++) {
      const reused = Boolean(slot.client?.usable);
      if (!reused) {
        slot.client?.close();
        slot.client = undefined;
        const fresh = await connector(settings, password, controller.signal);
        // The time ran out just as it connected: closed, not used without a limit.
        if (controller.signal.aborted) { fresh.close(); throw tooSlow(); }
        slot.client = fresh;
      }
      const client = slot.client!;
      const onAbort = () => client.close();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await work(client);
      } catch (error) {
        if (error instanceof AppError) throw error;
        const dropped = !client.usable || DROPPED.test(String((error as { code?: unknown })?.code ?? ""));
        if (dropped) { slot.client = undefined; client.close(); }
        // A kept connection that the server closed while it sat unused: once more on a new one.
        if (dropped && reused && tries === 0 && !controller.signal.aborted) continue;
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    }
  } catch (error) {
    if (!(error instanceof AppError)) { const client = slot.client; slot.client = undefined; client?.close(); }
    throw mailboxError(error, settings, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
    slot.lastUsed = Date.now();
    if (slots.get(id) === slot) { slot.idle = setTimeout(() => drop(id, slot), MAILBOX_IDLE_MS); slot.idle.unref?.(); }
  }
}

/** A folder opened for one request (read-only unless the request changes something), always let go of. */
async function inFolder<T>(client: MailboxClient, path: string, readOnly: boolean, work: () => Promise<T>): Promise<T> {
  let lock: { release(): void };
  try { lock = await client.getMailboxLock(path, { readOnly }); }
  catch (error) {
    if (client.usable && !DROPPED.test(String((error as { code?: unknown })?.code ?? ""))) throw new AppError(404, "NOT_FOUND", "That folder isn't in this mailbox any more: reload the folders");
    throw error;
  }
  try { return await work(); }
  finally { lock.release(); }
}

// ---- Folders -------------------------------------------------------------------------------------------------------------------------

const ROLE_OF_USE: Record<string, MailFolderRole> = { "\\Sent": "sent", "\\Drafts": "drafts", "\\Junk": "junk", "\\Trash": "trash", "\\Archive": "archive" };
const ROLE_NAME: Partial<Record<MailFolderRole, string>> = { inbox: "Inbox", sent: "Sent", drafts: "Drafts", junk: "Spam", trash: "Trash", archive: "Archive" };
const ROLE_ORDER: MailFolderRole[] = ["inbox", "sent", "drafts", "archive", "junk", "trash", "other"];
const MAX_FOLDERS = 200;
const isInboxPath = (path: string) => path.toUpperCase() === "INBOX";

/** The mailbox's folders that hold messages, with counts: Inbox, Sent, Drafts, Archive, Spam, Trash first (one each), then the rest by path. */
export async function listFolders(client: MailboxClient): Promise<MailFolder[]> {
  const listed = (await client.list({ statusQuery: { messages: true, unseen: true } })).filter((folder) => !folder.flags.has("\\Noselect") && !folder.flags.has("\\NonExistent")).slice(0, MAX_FOLDERS);
  const taken = new Set<MailFolderRole>();
  const folders = listed.map((folder) => {
    let role: MailFolderRole = isInboxPath(folder.path) ? "inbox" : ROLE_OF_USE[folder.specialUse ?? ""] ?? "other";
    if (role !== "other" && taken.has(role)) role = "other";
    if (role !== "other") taken.add(role);
    const parents = (folder.parent ?? []).filter((name) => !isInboxPath(name));
    return { path: folder.path, name: (role === "other" ? folder.name : ROLE_NAME[role]) || folder.path, role, depth: role === "other" ? Math.min(parents.length, 6) : 0, total: Math.max(0, Number(folder.status?.messages ?? 0)), unread: Math.max(0, Number(folder.status?.unseen ?? 0)) };
  });
  return folders.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.role === "other" ? a.path.localeCompare(b.path) : 0));
}

/** The folder with this role, or undefined. */
export async function folderFor(client: MailboxClient, role: MailFolderRole): Promise<string | undefined> {
  return (await listFolders(client)).find((folder) => folder.role === role)?.path;
}

// ---- Messages ------------------------------------------------------------------------------------------------------------------------

const ROW_QUERY = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true } as const;
/** How much of one message is read to show it (its text, HTML and inline pictures); attachments are downloaded on their own. */
export const READ_MAX_BYTES = 8 * 1024 * 1024;
export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const isoOf = (value: unknown): string | undefined => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const addressesOf = (list: MailboxEnvelope["from"]): MailAddress[] => (list ?? []).filter((entry) => typeof entry.address === "string" && entry.address.includes("@")).slice(0, 50)
  .map((entry) => ({ ...(entry.name ? { name: clip(entry.name, 200) } : {}), address: clip(entry.address!.trim().toLowerCase(), 254) }));

export type MailPart = { part: string; filename: string; contentType: string; size: number; inline: boolean };
/** The attachments in a message's structure (a forwarded message counts as one), and the pictures shown inside its HTML (inline). */
export function attachmentsOf(node: MailboxStructure | undefined, found: MailPart[] = []): MailPart[] {
  if (!node || found.length >= 100) return found;
  const type = String(node.type ?? "").toLowerCase();
  if (node.childNodes?.length && type !== "message/rfc822") { for (const child of node.childNodes) attachmentsOf(child, found); return found; }
  const disposition = String(node.disposition ?? "").toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (!filename && disposition !== "attachment" && (type === "text/plain" || type === "text/html")) return found;
  const inline = disposition !== "attachment" && Boolean(node.id) && type.startsWith("image/");
  if (!filename && !inline && disposition !== "attachment" && type !== "message/rfc822") return found;
  const encoded = Number(node.size ?? 0);
  const size = Math.max(0, Math.round(String(node.encoding ?? "").toLowerCase() === "base64" ? encoded * 0.74 : encoded));
  found.push({ part: node.part ?? "1", filename: clip(String(filename ?? (type === "message/rfc822" ? "message.eml" : type.startsWith("image/") ? `picture.${type.slice(6).replace(/[^a-z0-9]/g, "") || "img"}` : "attachment")), 200), contentType: clip(type || "application/octet-stream", 150), size, inline });
  return found;
}

/** One row of the list, as the API shows it (without its lead and tracking, added by the route). */
export function rowOf(message: MailboxFetched, folder: string): MailRow & { messageId?: string } {
  const envelope = message.envelope ?? {};
  const flags = message.flags ?? new Set<string>();
  const date = isoOf(envelope.date) ?? isoOf(message.internalDate);
  return {
    uid: message.uid, folder, subject: clip(String(envelope.subject ?? ""), 500), ...(date ? { date } : {}),
    from: addressesOf(envelope.from), to: addressesOf(envelope.to),
    seen: flags.has("\\Seen"), flagged: flags.has("\\Flagged"), answered: flags.has("\\Answered"),
    hasAttachments: attachmentsOf(message.bodyStructure).some((part) => !part.inline), size: Math.max(0, Number(message.size ?? 0)),
    ...(envelope.messageId ? { messageId: envelope.messageId.trim() } : {}),
  };
}

/**
 * A page of the folder, newest first: the `limit` messages under `before` (a UID), or matching `q` in the sender, the recipients, the
 * subject or the text. `nextBefore` is there when there are more.
 */
export async function listMessages(client: MailboxClient, query: { folder: string; before?: number | undefined; q?: string | undefined; limit: number }): Promise<{ total: number; rows: (MailRow & { messageId?: string })[]; nextBefore?: number }> {
  return inFolder(client, query.folder, true, async () => {
    const exists = client.mailbox ? Number(client.mailbox.exists ?? 0) : 0;
    if (!exists || query.before === 1) return { total: query.q ? 0 : exists, rows: [] };
    const range = query.before ? `1:${query.before - 1}` : "1:*";
    const q = query.q?.trim();
    const found = await client.search(q ? { uid: range, or: [{ from: q }, { to: q }, { subject: q }, { body: q }] } : { uid: range }, { uid: true });
    const uids = (Array.isArray(found) ? found : []).filter((uid) => Number.isInteger(uid) && uid > 0 && (!query.before || uid < query.before)).sort((a, b) => a - b);
    const page = uids.slice(-query.limit);
    const fetched = page.length ? await client.fetchAll(page, ROW_QUERY, { uid: true }) : [];
    const rows = fetched.filter((message) => message.uid > 0).map((message) => rowOf(message, query.folder)).sort((a, b) => b.uid - a.uid);
    return { total: q ? uids.length : exists, rows, ...(uids.length > page.length && page[0] ? { nextBefore: page[0] } : {}) };
  });
}

export type ReadMessage = { row: MailRow & { messageId?: string }; mail: ParsedMail; parts: MailPart[]; truncated: boolean };

/** One message: read (its first 8 MB), parsed, and marked read when `markSeen` (opening a message in a mailbox does that). */
export async function readMessage(client: MailboxClient, folder: string, uid: number, markSeen: boolean): Promise<ReadMessage> {
  return inFolder(client, folder, !markSeen, async () => {
    const message = await client.fetchOne(String(uid), { ...ROW_QUERY, source: { maxLength: READ_MAX_BYTES } }, { uid: true });
    if (!message || message.uid !== uid) throw new AppError(404, "NOT_FOUND", "That message isn't in this folder any more");
    if (markSeen && !message.flags?.has("\\Seen")) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => false);
      message.flags = new Set([...(message.flags ?? []), "\\Seen"]);
    }
    const source = message.source ?? Buffer.alloc(0);
    const mail = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, maxHtmlLengthToParse: 2_000_000 });
    return { row: rowOf(message, folder), mail, parts: attachmentsOf(message.bodyStructure), truncated: Number(message.size ?? source.length) > READ_MAX_BYTES };
  });
}

/** Read/unread and starred. */
export async function setFlags(client: MailboxClient, folder: string, uid: number, change: { seen?: boolean | undefined; flagged?: boolean | undefined }): Promise<void> {
  await inFolder(client, folder, false, async () => {
    const add: string[] = [];
    const remove: string[] = [];
    if (change.seen !== undefined) (change.seen ? add : remove).push("\\Seen");
    if (change.flagged !== undefined) (change.flagged ? add : remove).push("\\Flagged");
    if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
  });
}

/** Moves a message to the mailbox's Inbox, Trash, Spam or Archive folder. */
export async function moveMessage(client: MailboxClient, folder: string, uid: number, to: "inbox" | "trash" | "junk" | "archive"): Promise<{ folder: string }> {
  const destination = await folderFor(client, to);
  const names = { inbox: "an Inbox", trash: "a Trash folder", junk: "a Spam folder", archive: "an Archive folder" } as const;
  if (!destination) throw new AppError(409, "CONFLICT", `This mailbox has no ${names[to].replace(/^an? /, "")} folder`);
  if (destination === folder) throw new AppError(409, "CONFLICT", `It is already in ${ROLE_NAME[to]}`);
  await inFolder(client, folder, false, async () => {
    const moved = await client.messageMove(String(uid), destination, { uid: true });
    if (moved === false) throw new AppError(404, "NOT_FOUND", "That message isn't in this folder any more");
  });
  return { folder: destination };
}

/** One attachment, straight from the mail server (decoded), at most 25 MB. `deliver` gets it while the folder is open. */
export async function downloadPart<T>(client: MailboxClient, folder: string, uid: number, part: string, deliver: (file: { filename: string; contentType: string; size?: number | undefined; content: Readable }) => Promise<T>): Promise<T> {
  return inFolder(client, folder, true, async () => {
    const file = await client.download(String(uid), part, { uid: true, maxBytes: DOWNLOAD_MAX_BYTES + 1 });
    if (!file?.content) throw new AppError(404, "NOT_FOUND", "That attachment isn't in the message any more");
    // Never a file cut short: one over the limit is refused before a byte goes out.
    const expected = Number(file.meta?.expectedSize ?? 0) * (/base64/i.test(String((file.meta as { encoding?: unknown } | undefined)?.encoding ?? "")) ? 0.74 : 1);
    if (expected > DOWNLOAD_MAX_BYTES) { file.content.destroy(); throw new AppError(413, "BAD_REQUEST", "This attachment is over 25 MB: open it in your mail provider's own webmail"); }
    return deliver({ filename: clip(file.meta?.filename || "attachment", 200), contentType: clip(file.meta?.contentType || "application/octet-stream", 150), size: file.meta?.expectedSize, content: file.content });
  });
}

/** Adds a flag (\Answered after a reply), best effort. */
export async function addFlag(client: MailboxClient, folder: string, uid: number, flag: string): Promise<void> {
  await inFolder(client, folder, false, async () => { await client.messageFlagsAdd(String(uid), [flag], { uid: true }); });
}

// ---- Showing a message ---------------------------------------------------------------------------------------------------------------

const HTML_MAX = 1_500_000;
const TEXT_MAX = 200_000;
/** Taken out with everything inside them. */
const DROP_WITH_CONTENT = new Set(["script", "iframe", "frameset", "object", "applet", "noscript", "noembed", "template", "title", "xmp", "plaintext", "svg", "math"]);
/** Of those, the ones a browser reads as raw text to the end when they are never closed: the rest of the message goes with them. */
const RAW_TEXT = new Set(["script", "iframe", "noscript", "noembed", "title", "xmp", "plaintext"]);
/** Taken out (their text stays); the void ones among them have no content anyway. */
const DROP_TAG = new Set(["meta", "base", "link", "embed", "frame", "form", "input", "button", "textarea", "select", "option", "optgroup", "isindex", "keygen", "portal", "dialog"]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "background", "poster", "cite", "longdesc", "usemap", "xlink:href", "lowsrc", "dynsrc", "formaction", "ping"]);
const DROP_ATTRIBUTES = new Set(["srcdoc", "srcset", "formaction", "ping", "http-equiv", "target", "autofocus", "contenteditable", "popover", "popovertarget", "rel", "referrerpolicy", "is"]);
const ENTITY = /&(#x[0-9a-f]+|#\d+|colon|tab|newline);?/gi;
/** Attribute names kept: plain ones only (a name with a quote or a bracket in it is dropped). */
const ATTRIBUTE_NAME = /^[a-z_:][-a-z0-9_:.]{0,59}$/;

/** An attribute's URL as a browser would read it: entities decoded, spaces and control characters dropped, lower case (its first 4,096 characters). */
function urlScheme(value: string): string {
  const head = value.length > 4_096 ? value.slice(0, 4_096) : value;
  const decoded = head.replace(ENTITY, (_match, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "colon") return ":";
    if (lower === "tab" || lower === "newline") return "";
    const point = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : "";
  });
  return decoded.replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
}

/** Tags whose src, background or poster loads a picture or a video frame from the internet. */
const PICTURE_TAGS = new Set(["img", "image", "video", "audio", "source", "track", "picture", "table", "td", "th", "tr", "tbody", "body", "div"]);
const REMOTE = /^(?:https?:)?\/\//;
const CSS_REMOTE = /url\s*\(['"\s]*(?:https?:)?\/\//i;
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

/** A tag's attributes as written (name, and the value without its quotes), read in one pass; 200 at most. */
export function readAttributes(source: string): { name: string; value?: string }[] {
  const found: { name: string; value?: string }[] = [];
  const length = source.length;
  let index = 0;
  while (index < length && found.length < 200) {
    while (index < length && (isSpace(source.charCodeAt(index)) || source[index] === "/")) index++;
    if (index >= length) break;
    const start = index;
    while (index < length && !isSpace(source.charCodeAt(index)) && source[index] !== "=" && source[index] !== "/") index++;
    const name = source.slice(start, index);
    if (!name) { index++; continue; }
    let probe = index;
    while (probe < length && isSpace(source.charCodeAt(probe))) probe++;
    if (source[probe] !== "=") { found.push({ name }); index = probe; continue; }
    probe++;
    while (probe < length && isSpace(source.charCodeAt(probe))) probe++;
    const quote = source[probe];
    if (quote === "\"" || quote === "'") {
      const close = source.indexOf(quote, probe + 1);
      const stop = close < 0 ? length : close;
      found.push({ name, value: source.slice(probe + 1, stop) });
      index = stop + 1;
    } else {
      let stop = probe;
      while (stop < length && !isSpace(source.charCodeAt(stop))) stop++;
      found.push({ name, value: source.slice(probe, stop) });
      index = stop;
    }
  }
  return found;
}

/** The tag's attributes kept (60 at most), rewritten with double quotes. */
function cleanAttributes(tag: string, source: string, seen: { remote: boolean }): string {
  const kept: string[] = [];
  for (const attribute of readAttributes(source)) {
    if (kept.length >= 60) break;
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (!ATTRIBUTE_NAME.test(name) || name.startsWith("on") || DROP_ATTRIBUTES.has(name)) continue;
    if (value !== undefined && URL_ATTRIBUTES.has(name)) {
      const scheme = urlScheme(value);
      const picture = tag === "img" && name === "src" && scheme.startsWith("data:image/");
      if (/^(javascript|vbscript|livescript|mocha|file|filesystem|blob|about|data):/.test(scheme) && !picture) continue;
      if ((name === "src" || name === "background" || name === "poster") && PICTURE_TAGS.has(tag) && REMOTE.test(scheme)) seen.remote = true;
    }
    if (name === "style" && value !== undefined) {
      if (/expression\(|javascript:|behaviou?r:|-moz-binding/i.test(urlScheme(value))) continue;
      if (CSS_REMOTE.test(value)) seen.remote = true;
    }
    kept.push(value === undefined ? name : `${name}="${value.replace(/"/g, "&quot;")}"`);
  }
  if (tag === "a") kept.push("rel=\"noopener noreferrer\"");
  return kept.length ? ` ${kept.join(" ")}` : "";
}

/** Where a tag that starts at `start` ends (its closing ">"), quotes respected; -1 when it never closes. */
function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < html.length; index++) {
    const char = html[index]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "\"" || char === "'") { const before = html.charCodeAt(index - 1); if (html[index - 1] === "=" || isSpace(before)) quote = char; continue; }
    if (char === ">") return index;
  }
  return -1;
}

/**
 * A message's HTML made safe to show in a sandboxed frame (one pass, no parser, linear on any input): comments, scripts, frames, objects,
 * embedded SVG and MathML, forms and their fields, meta, base and link tags go; event attributes, script and data links, `rel`, `target`
 * and CSS expressions go; links get rel="noopener noreferrer". `remoteImages` says whether it would load pictures from the internet.
 */
export function cleanHtml(source: string): { html: string; remoteImages: boolean } {
  const html = source.length > HTML_MAX ? source.slice(0, HTML_MAX) : source;
  const lower = html.toLowerCase();
  const out: string[] = [];
  const seen = { remote: false };
  // Where the next closing tag of each dropped element is (-1: none left): every search goes on from the last one, so it stays one pass.
  const nextClose = new Map<string, number>();
  const closeFrom = (name: string, from: number) => {
    const known = nextClose.get(name);
    if (known !== undefined && (known === -1 || known >= from)) return known;
    const found = lower.indexOf(`</${name}`, from);
    nextClose.set(name, found);
    return found;
  };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) { out.push(html.slice(index)); break; }
    out.push(html.slice(index, open));
    const next = html[open + 1] ?? "";
    if (html.startsWith("<!--", open)) { const end = html.indexOf("-->", open + 4); index = end < 0 ? html.length : end + 3; continue; }
    if (next === "!" || next === "?") { const end = html.indexOf(">", open + 1); index = end < 0 ? html.length : end + 1; continue; }
    if (!/[a-zA-Z/]/.test(next)) { out.push("&lt;"); index = open + 1; continue; }
    const end = tagEnd(html, open);
    if (end < 0) break;
    const raw = html.slice(open, end + 1);
    index = end + 1;
    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw);
    // "</" with no name after it: a browser reads it as a comment.
    if (!match) continue;
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    const inner = raw.slice(match[0].length, -1).trimEnd();
    const selfClosing = inner.endsWith("/");
    if (DROP_WITH_CONTENT.has(name)) {
      if (closing || selfClosing) continue;
      const close = closeFrom(name, index);
      if (close < 0) { if (RAW_TEXT.has(name)) break; continue; }
      const after = tagEnd(html, close);
      index = after < 0 ? html.length : after + 1;
      continue;
    }
    if (DROP_TAG.has(name)) continue;
    if (closing) { out.push(`</${name}>`); continue; }
    out.push(`<${name}${cleanAttributes(name, selfClosing ? inner.slice(0, -1) : inner, seen)}${selfClosing ? " /" : ""}>`);
  }
  const cleaned = out.join("");
  // Style blocks (and anything else) that load a background picture from the internet.
  return { html: cleaned, remoteImages: seen.remote || CSS_REMOTE.test(cleaned) };
}

/** The message's text: its plain-text part, else its HTML as text. */
export function textOf(mail: ParsedMail): string {
  const text = (mail.text ?? "").replace(/\r\n?/g, "\n").trim();
  if (text) return clip(text, TEXT_MAX);
  return typeof mail.html === "string" && mail.html ? clip(htmlToText(mail.html), TEXT_MAX) : "";
}

export const addressList = (value: AddressObject | AddressObject[] | undefined): MailAddress[] => (Array.isArray(value) ? value : value ? [value] : [])
  .flatMap((entry) => entry.value ?? []).flatMap((entry) => (entry.group?.length ? entry.group : [entry]))
  .filter((entry) => typeof entry.address === "string" && entry.address.includes("@")).slice(0, 50)
  .map((entry) => ({ ...(entry.name ? { name: clip(entry.name, 200) } : {}), address: clip(entry.address!.trim().toLowerCase(), 254) }));

// ---- Writing ------------------------------------------------------------------------------------------------------------------------

/** "Sat, 28 Nov 2026, 17:05" in the person's time zone (UTC when it isn't a real zone). */
export function mailDate(date: Date | undefined, timezone?: string): string {
  if (!date || !Number.isFinite(date.getTime())) return "";
  const format = (zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  try { return format(timezone || "UTC"); } catch { return format("UTC"); }
}

const named = (entry: MailAddress | undefined) => (entry ? (entry.name ? `${entry.name} <${entry.address}>` : entry.address) : "");

/** The quoted message under a reply ("On …, … wrote:" and the text with "> "). */
export function replyQuote(mail: ParsedMail, timezone?: string): string {
  const from = addressList(mail.from)[0];
  const lines = clip(textOf(mail), 20_000).split("\n").map((line) => (line ? `> ${line}` : ">"));
  return `On ${mailDate(mail.date, timezone)}, ${named(from)} wrote:\n${lines.join("\n")}`;
}

/** The forwarded message under a forward. */
export function forwardBlock(mail: ParsedMail, timezone?: string): string {
  const to = addressList(mail.to).map(named).join(", ");
  return ["---------- Forwarded message ---------", `From: ${named(addressList(mail.from)[0])}`, `Date: ${mailDate(mail.date, timezone)}`, `Subject: ${mail.subject ?? ""}`, ...(to ? [`To: ${to}`] : []), "", clip(textOf(mail), 50_000)].join("\n");
}

/** Message-IDs written in a header (In-Reply-To, References), each in angle brackets. */
export const idsIn = (value: string | string[] | undefined): string[] => (Array.isArray(value) ? value : value ? [value] : []).flatMap((entry) => entry.match(/<[^<>\s]{1,250}>/g) ?? []);

export type OutgoingFile = { filename: string; contentType: string; content: Buffer };
/** The message as it goes out: plain text from the person's name and address, threaded under the message it answers. */
export async function composeMail(settings: Pick<EmailSettings, "address" | "senderName">, input: { to: string[]; cc: string[]; subject: string; text: string; answering?: ParsedMail | undefined; files: OutgoingFile[] }, now = new Date()): Promise<{ raw: Buffer; messageId: string; threadKey: string }> {
  const messageId = `<mail-${randomUUID()}@${domainOf(settings.address) || "localhost"}>`;
  const answered = input.answering?.messageId ? idsIn(input.answering.messageId)[0] : undefined;
  const references = answered ? [...new Set([...idsIn(input.answering?.references), answered])].slice(-20) : [];
  const composer = new MailComposer({
    from: { name: settings.senderName, address: settings.address }, to: input.to, ...(input.cc.length ? { cc: input.cc } : {}), subject: input.subject, text: input.text,
    messageId, date: now, ...(answered ? { inReplyTo: answered, references } : {}),
    attachments: input.files.map((file) => ({ filename: file.filename, contentType: file.contentType, content: file.content })),
    disableFileAccess: true, disableUrlAccess: true,
  });
  const raw = await composer.compile().build();
  return { raw, messageId, threadKey: references[0] ?? messageId };
}

/** The attachments of a forwarded message that go with it (not the pictures inside its HTML), as long as the message was read whole. */
export function forwardedFiles(mail: ParsedMail): OutgoingFile[] {
  return mail.attachments.filter((file) => file.contentDisposition === "attachment" || !file.related).slice(0, 20)
    .map((file) => ({ filename: clip(file.filename || "attachment", 200), contentType: file.contentType || "application/octet-stream", content: file.content }));
}

/** Hands a built message to the mail server (an SMTP session; it throws SmtpStepError naming the step that broke). */
export type RawSender = (settings: EmailSettings, password: string, signal: AbortSignal, message: { from: string; to: string[]; raw: Buffer }) => Promise<{ rejected?: string[] } | void | unknown>;
let rawSender: RawSender = smtpSession;
export const sendRaw: RawSender = (settings, password, signal, message) => rawSender(settings, password, signal, message);
/** Tests only: takes every message the Mail page sends instead of a mail server; returns the function that puts the real one back. */
export function useMailSenderForTests(send: RawSender): () => void {
  if (process.env.NODE_ENV === "production") throw new Error("useMailSenderForTests is for tests only");
  rawSender = send;
  return () => { rawSender = smtpSession; };
}

/** The key a send is remembered under, so the same request twice sends one message. */
export const sendKey = (accountId: string, requestId: string) => createHash("sha256").update(`${accountId}\n${requestId}`).digest("hex");
