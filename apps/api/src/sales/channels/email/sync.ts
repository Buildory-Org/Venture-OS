// Reading connected mailboxes and filing replies from leads (docs/sales-channels.md section 3, "Inbox sync"). Runs in the API process every
// three minutes (SALES_MAIL_SYNC=on, never under tests), like the lead finder. For each switched-on mailbox that reads its inbox: take a lease
// on the account (so two API processes never read the same mailbox at once; renewed while it works), open INBOX read-only (never a flag,
// never a delete or move: fetches use BODY.PEEK), read the messages after the cursor (at most 200 a round, oldest first) and advance the
// cursor after each one. The first round of a mailbox, and a mailbox whose UIDVALIDITY changed, start at the current UIDNEXT: only new mail
// is read. Three mailboxes are read at once, and each gets at most two and a half minutes a round: a slow or hostile mail server is closed
// at its deadline and holds nobody else up (the next round goes on from its cursor).
//
// For each message (at most 512 KB of it; HTML is never run through a full HTML parser, only a bounded tag strip): a delivery report naming
// one of our Message-IDs marks that message bounced when it says the delivery failed (a delay or success notice changes nothing); an
// auto-reply or list mail is skipped; a message answering one of our messages (In-Reply-To/References) from one of that lead's addresses or
// its own company domain, else from the exact address of exactly one lead in the mailbox's ventures, is filed as an inbound email activity
// acting as the mailbox's owner (applyActivity: stop follow-ups, the Inbox item, the owner's notice). Mail from the team's own side (a
// workspace member, any connected mailbox, the mailbox's own company domain) is never filed on a lead, even when it carries our thread (a
// colleague's forward). Everything else is not stored: mail that isn't from a lead stays private. Errors are kept on the account in plain
// words (never what the server said; a refused password also marks it as needing attention and stops reading it until the password is fixed
// or a test passes) and never stop the other mailboxes.
import { hostname } from "node:os";
import type { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { ChannelEnv } from "../accounts.js";
import { ACCOUNTS, openSecrets } from "../accounts.js";
import { atomic, type AppDocument, type Database } from "../../../db.js";
import { actorFor } from "../../../middleware.js";
import { canSeeVenture } from "../../access.js";
import { auditSales, type SalesCtx } from "../../ctx.js";
import { applyActivity, loadLead, reopenClosedBy } from "../../leads.js";
import { isSharedDomain, leadContacts, normalizeEmail, suppressionKey } from "../../suppression.js";
import { settleSentByBounce } from "../dispatch.js";
import { connectImap, domainOf, imapFailure, settingsOf } from "./provider.js";

export const MAIL_SYNC_POLL_MS = 3 * 60_000;
/** Messages read per mailbox and round; the rest wait for the next round. */
export const MAIL_BATCH = 200;
/** Bytes of a message read at most (headers and text come first; attachments are ignored anyway). */
export const MAIL_MAX_BYTES = 512 * 1024;
/** Characters of HTML looked at when a message has no plain text part (the reply is at the top; the rest is the quoted thread). */
export const HTML_SCAN_MAX = 100_000;
/** Characters of a message's text looked at for the reply (it is cut to 10,000 after the quoted thread is removed). */
const TEXT_SCAN_MAX = 100_000;
/** How long one mailbox may take in one round before its connection is closed. */
export const ACCOUNT_DEADLINE_MS = 150_000;
/** Mailboxes read at the same time. */
export const MAIL_CONCURRENCY = 3;
const LEASE_MS = 5 * 60_000;
const LEASE_RENEW_MS = 60_000;
const LOGOUT_WAIT_MS = 5_000;
const BODY_MAX = 10_000;

/** The inbox sync runs in the API process when SALES_MAIL_SYNC is on, never under the test runner. */
export const mailSyncEnabled = (config: { SALES_MAIL_SYNC: "on" | "off"; NODE_ENV: string }) => config.SALES_MAIL_SYNC === "on" && config.NODE_ENV !== "test";

/**
 * The part of an IMAP client the sync uses (ImapFlow has it), so tests hand in a client that serves raw messages. Nothing here can change a
 * mailbox. `close` drops the connection at once (the deadline uses it).
 */
export type MailClient = {
  connect(): Promise<void>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<{ uidValidity: bigint | number | string; uidNext: number }>;
  fetch(range: string, query: { uid: true; source: { maxLength: number } }, options: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer | undefined }>;
  logout(): Promise<void>;
  close?(): void;
};
export type MailConnect = (account: AppDocument, password: string) => MailClient;

/** A real IMAP connection to the account's mailbox: its server name resolved and checked (never a private address) when it connects. */
export const imapConnect: MailConnect = (account, password) => {
  let client: ImapFlow | undefined;
  // Closing while the name is resolved or the connection is opened stops that too (connectImap closes what it opened).
  const closing = new AbortController();
  const open = () => { if (!client) throw Object.assign(new Error("Not connected"), { code: "NoConnection" }); return client; };
  return {
    async connect() {
      const connected = await connectImap(settingsOf(account), password, closing.signal);
      if (closing.signal.aborted) { connected.close(); throw Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }); }
      client = connected;
    },
    mailboxOpen: (path, options) => open().mailboxOpen(path, options),
    fetch: (range, query, options) => open().fetch(range, query, options),
    async logout() { await client?.logout(); },
    close() { closing.abort(); client?.close(); },
  };
};

export type MailSyncOptions = {
  database: Database;
  env: ChannelEnv;
  connect?: MailConnect;
  workerId?: string;
  pollMs?: number;
  /** Tests only: a shorter deadline per mailbox. */
  accountDeadlineMs?: number;
  log?: (line: Record<string, unknown>) => void;
};
export type MailRound = { accountId: string; status: "read" | "started" | "skipped" | "failed"; read: number; filed: number; bounced: number; skipped: number; error?: string };
export type MailSync = { syncOnce(): Promise<MailRound[]>; syncAccount(accountId: string): Promise<MailRound | null>; start(): void; stop(): Promise<void>; workerId: string };

// ---- Reading one message --------------------------------------------------------------------------------------------------------------

/** Every Message-ID written in a header value ("<a@b> <c@d>"). */
export const messageIds = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).flatMap((item) => (typeof item === "string" ? item.match(/<[^<>\s]+>/g) ?? [] : []));
/** Our own Message-IDs (`<draft-<id>-<attempt>@domain>`) written anywhere in a text, with the draft each belongs to. */
export function ourMessageIds(text: string): { id: string; draftId: string }[] {
  const found = new Map<string, string>();
  for (const match of text.matchAll(/<(draft-([A-Za-z0-9_-]{1,128})-(\d{1,6}))@([A-Za-z0-9.-]{1,255})>/g)) found.set(match[0], match[2]!);
  return [...found].map(([id, draftId]) => ({ id, draftId }));
}

const firstAddress = (value: AddressObject | AddressObject[] | undefined): string | undefined => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  for (const entry of list) for (const item of entry.value ?? []) if (item.address) return item.address.trim().toLowerCase();
  return undefined;
};
/** The plain addresses of a header ("a@x.in, b@y.in"), lower case, without the names. */
const addressText = (value: AddressObject | AddressObject[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []).flatMap((entry) => (entry.value ?? []).map((item) => item.address?.trim().toLowerCase()).filter(Boolean)).join(", ").slice(0, 500);
const header = (mail: ParsedMail, name: string): string => {
  const value = mail.headers.get(name);
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "value" in (value as object)) return String((value as { value: unknown }).value ?? "");
  return String(value);
};

/** Elements whose content is not the reply: the head, and quoted threads (nested ones counted). */
const SKIPPED_ELEMENTS = new Set(["head", "blockquote"]);
/** Elements whose content is never text and may hold "<" of its own: skipped to their end tag in one jump. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea"]);
const BREAKING_ELEMENTS = new Set(["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "hr", "section", "article", "header", "footer"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** Where `</tag` next starts at or after `from` (any case), or -1: every character is looked at once. */
function endTag(source: string, tag: string, from: number): number {
  for (let at = source.indexOf("</", from); at !== -1; at = source.indexOf("</", at + 2)) if (source.slice(at + 2, at + 2 + tag.length).toLowerCase() === tag) return at;
  return -1;
}

/**
 * The text of an HTML-only message, cheaply: at most the first 100,000 characters looked at, one pass over the tags (each character read a
 * bounded number of times, so a deeply nested or broken body costs no more than a plain one), line breaks for block elements, scripts,
 * styles and quoted blocks left out, and a few entities decoded.
 */
export function htmlToText(html: string): string {
  const source = html.length > HTML_SCAN_MAX ? html.slice(0, HTML_SCAN_MAX) : html;
  const parts: string[] = [];
  let skipping: string | undefined;
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) { if (!skipping) parts.push(source.slice(index)); break; }
    if (!skipping && open > index) parts.push(source.slice(index, open));
    const close = source.indexOf(">", open + 1);
    if (close === -1) break; // a tag that never ends: the rest is not text
    const name = /^(\/?)([a-zA-Z][a-zA-Z0-9]{0,15})/.exec(source.slice(open + 1, Math.min(close, open + 18)));
    const tag = name?.[2]?.toLowerCase() ?? "";
    const ending = name?.[1] === "/";
    const selfClosing = source[close - 1] === "/";
    index = close + 1;
    if (!ending && !selfClosing && RAW_TEXT_ELEMENTS.has(tag)) {
      const end = endTag(source, tag, index);
      const after = end === -1 ? -1 : source.indexOf(">", end);
      if (after === -1) break;
      index = after + 1;
      continue;
    }
    if (skipping) {
      if (tag === skipping && !selfClosing) depth += ending ? -1 : 1;
      if (depth <= 0) { skipping = undefined; depth = 0; }
    } else if (!ending && !selfClosing && SKIPPED_ELEMENTS.has(tag)) {
      skipping = tag;
      depth = 1;
    } else if (BREAKING_ELEMENTS.has(tag)) {
      parts.push("\n");
    }
  }
  return parts.join("")
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (whole, entity: string) => {
      if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? whole;
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/[ \t\f\v\r\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * One message as the sync reads it: at most 512 KB of it, parsed without mailparser's own HTML-to-text (it takes quadratic time on nested
 * markup: a 1 MB body could block the server for most of a minute) and without links or HTML made from the text.
 */
export function parseMail(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw.length > MAIL_MAX_BYTES ? raw.subarray(0, MAIL_MAX_BYTES) : raw, { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, maxHtmlLengthToParse: 50_000 });
}

/** A message's text: its plain-text part, else the cheap reading of its HTML. */
export function mailText(mail: ParsedMail): string {
  const text = (mail.text ?? "").trim();
  if (text) return text.length > TEXT_SCAN_MAX ? text.slice(0, TEXT_SCAN_MAX) : text;
  return typeof mail.html === "string" && mail.html ? htmlToText(mail.html) : "";
}

/**
 * The new text of a reply without the quoted thread: lines starting with ">", and everything from "On … wrote:" (also wrapped over two
 * lines), "-----Original Message-----" or an Outlook "From: … Sent: …" block onwards.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (/^On\s.{0,300}\swrote:$/i.test(trimmed)) break;
    if (/^On\s/i.test(trimmed) && !/wrote:$/i.test(trimmed) && /^.{0,300}\swrote:$/i.test(`${trimmed} ${lines[index + 1]?.trim() ?? ""}`)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)) break;
    if (/^From:\s.+/i.test(trimmed) && lines.slice(index + 1, index + 5).some((next) => /^(Sent|Date):\s/i.test(next.trim()))) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** An automatic message nobody wrote (an out-of-office, a list mail): never filed as a reply. */
export function isAutomatic(mail: ParsedMail): boolean {
  const auto = header(mail, "auto-submitted").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (mail.headers.has("x-autoreply") || mail.headers.has("x-autorespond") || mail.headers.has("list-id")) return true;
  return /^(bulk|auto_reply|list|junk)$/i.test(header(mail, "precedence").trim());
}

/**
 * A delivery report (multipart/report with a delivery status, or a message from a mailer daemon or postmaster), and whether it says the
 * delivery failed: `Action: failed` or a `Status: 5.x.x` in its delivery status; a report without a status part counts as failed only with
 * "permanent" wording or a 5xx answer in its text. A delay or success notice is a report that did not fail. Null: not a report.
 */
export function deliveryReport(mail: ParsedMail, readTexts: string | (() => string)): { failed: boolean } | null {
  const type = mail.headers.get("content-type") as { value?: string; params?: Record<string, string> } | undefined;
  const report = Boolean(type && typeof type === "object" && String(type.value ?? "").toLowerCase() === "multipart/report" && /delivery-status/i.test(String(type.params?.["report-type"] ?? "")));
  const from = firstAddress(mail.from) ?? "";
  const daemon = /^(mailer-daemon|postmaster)@/i.test(from) || /mailer-daemon/i.test(mail.from?.text ?? "");
  if (!report && !daemon) return null;
  const texts = typeof readTexts === "string" ? readTexts : readTexts();
  if (/^Action:[ \t]*failed\b/im.test(texts) || /^Status:[ \t]*5\.\d{1,3}\.\d{1,3}/im.test(texts)) return { failed: true };
  // A delivery status that names any other action or a 2.x.x/4.x.x status: delivered, relayed, delayed. Not a bounce.
  if (report || /^Action:[ \t]*[a-z]+/im.test(texts) || /^Status:[ \t]*[24]\.\d{1,3}\.\d{1,3}/im.test(texts)) return { failed: false };
  const words = mailText(mail);
  return { failed: /\bpermanent(ly)?\b/i.test(words) || /\b5\.\d{1,3}\.\d{1,3}\b/.test(words) || /(^|\s)5[0-5]\d[ \t-]/m.test(words) };
}

/** The receiving server's reason for a bounce, in a line ("550 5.1.1 The email account does not exist"). */
function bounceReason(text: string): string {
  const diagnostic = /Diagnostic-Code:[ \t]*(?:smtp;[ \t]*)?([^\r\n]{1,500}(?:\r?\n[ \t]+[^\r\n]{1,500}){0,5})/i.exec(text)?.[1];
  const status = /^Status:[ \t]*([245]\.\d{1,3}\.\d{1,3})/im.exec(text)?.[1];
  const reason = (diagnostic ?? (status ? `status ${status}` : "")).replace(/\s+/g, " ").trim().slice(0, 240);
  return reason ? `The email bounced: ${reason}` : "The email bounced: the receiving mail server sent it back";
}

// ---- The sync ---------------------------------------------------------------------------------------------------------------------------

/** The team's own side: addresses of workspace members and connected mailboxes, and the mailbox's own company domain (never a shared one). */
type OurSide = { addresses: Set<string>; domains: Set<string> };

class MailDeadline extends Error {
  readonly code = "MAIL_DEADLINE";
}

export function createMailSync(options: MailSyncOptions): MailSync {
  const database = options.database;
  const db = database.db;
  const accounts = db.collection(ACCOUNTS);
  const connect = options.connect ?? imapConnect;
  const workerId = (options.workerId ?? `${hostname()}-${process.pid}-mail`).slice(0, 100);
  const log = options.log ?? ((line: Record<string, unknown>) => console.info(JSON.stringify(line)));
  const deadlineMs = options.accountDeadlineMs ?? ACCOUNT_DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<MailRound[]> | undefined;

  /** The mailbox's owner as the actor its replies are filed as (their membership and ventures), or why not. */
  async function ownerCtx(account: AppDocument): Promise<SalesCtx | string> {
    const user = typeof account.ownerUserId === "string" ? await db.collection("users").findOne({ _id: account.ownerUserId, status: "active" }, { projection: { email: 1, name: 1 } }) : null;
    const actor = user ? await actorFor(db, { id: String(user._id), email: String(user.email ?? ""), name: String(user.name ?? "") }) : undefined;
    if (!actor || actor.membership.workspaceId !== account.workspaceId) return "The person who connected this mailbox is no longer an active member: its inbox is not read";
    return { database, db, actor, via: "app", channel: "worker", workspaceId: String(account.workspaceId), settings: new Map() };
  }

  /** Who is on the team's side in this workspace (read once per mailbox and round, and only when there is mail to file). */
  async function ourSide(account: AppDocument): Promise<OurSide> {
    const workspaceId = String(account.workspaceId);
    const memberIds = (await db.collection("memberships").find({ workspaceId }, { projection: { userId: 1 } }).limit(5_000).toArray()).map((row) => String(row.userId));
    const users = memberIds.length ? await db.collection("users").find({ _id: { $in: memberIds } }, { projection: { email: 1 } }).toArray() : [];
    const mailboxes = await db.collection(ACCOUNTS).find({ workspaceId, kind: "email" }, { projection: { "settings.address": 1 } }).limit(5_000).toArray();
    const addresses = new Set([...users.map((user) => user.email), ...mailboxes.map((row) => row.settings?.address), settingsOf(account).address]
      .flatMap((value) => (typeof value === "string" ? [normalizeEmail(value)] : [])).filter((value): value is string => value !== null));
    const own = domainOf(String(settingsOf(account).address ?? ""));
    return { addresses, domains: new Set(own && !isSharedDomain(own) ? [own] : []) };
  }

  /**
   * A bounce naming our messages: the delivery on that message's activity and its draft reads bounced. A send whose result was still unclear
   * is first recorded as sent (the bounce proves it went out). The message never reached the lead, so the drafts its sending closed (the
   * lead's other versions of that first message or follow-up, or its other replies to the same message) open again (reopenClosedBy). Nothing
   * else is stored.
   */
  async function markBounced(ctx: SalesCtx, account: AppDocument, ids: { id: string; draftId: string }[], reason: string, now: Date): Promise<number> {
    const accountId = String(account._id);
    const delivery = { state: "bounced", at: now, accountId, error: reason };
    const activities = db.collection("sales_activities");
    const bounce = (id: string) => activities.findOneAndUpdate({ workspaceId: ctx.workspaceId, direction: "out", "message.accountId": accountId, "message.externalId": id }, { $set: { "message.delivery": delivery } });
    let marked = 0;
    for (const entry of ids) {
      let activity = await bounce(entry.id);
      if (!activity && await settleSentByBounce(ctx, entry.draftId, accountId, entry.id)) activity = await bounce(entry.id);
      // A draft whose send is still unclear keeps waiting for a person (its lock and "uncertain" stay): only sent drafts take the bounce.
      const draftId = typeof activity?.draftId === "string" ? activity.draftId : entry.draftId;
      const draft = await db.collection("sales_drafts").findOneAndUpdate({ _id: draftId, workspaceId: ctx.workspaceId, sentAccountId: accountId, sendLock: null }, { $set: { delivery, updatedAt: now } }, { returnDocument: "after" });
      // The bounce is recorded either way; a reopen that fails is logged and the next message of the bounce goes on.
      if (draft?.status === "sent") {
        await atomic(database, (session) => reopenClosedBy(ctx, draft, now, session)).catch((error: unknown) => {
          log({ level: "warn", event: "sales.mail_sync.reopen_failed", draftId: String(draft._id), message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        });
      }
      if (activity || draft) marked++;
    }
    return marked;
  }

  /** The sender belongs to this lead: one of its email addresses, or an address on its own company domain (never a shared mail domain). */
  function fromLead(lead: AppDocument, sender: string): boolean {
    try {
      const { emails, domains } = leadContacts(lead as never);
      return emails.includes(sender) || domains.includes(domainOf(sender));
    } catch { return false; }
  }

  /**
   * The one lead a message belongs to, in the mailbox's ventures the owner can open: by thread (our Message-IDs) when the sender is that
   * lead's, else by the sender's exact address (the leads' indexed match keys, exactly one lead). Never mail from the team's own side.
   */
  async function leadFor(ctx: SalesCtx, account: AppDocument, mail: ParsedMail, sender: string, ours: OurSide): Promise<AppDocument | null> {
    if (ours.addresses.has(sender) || ours.domains.has(domainOf(sender))) return null;
    const ventureIds = (Array.isArray(account.ventureIds) ? account.ventureIds.map(String) : []).filter((ventureId) => canSeeVenture(ctx.actor, ventureId));
    if (!ventureIds.length) return null;
    const thread = [...new Set([...messageIds(mail.inReplyTo), ...messageIds(mail.references)])].slice(0, 50);
    if (thread.length) {
      const leadIds = (await db.collection("sales_activities").distinct("leadId", { workspaceId: ctx.workspaceId, direction: "out", ventureId: { $in: ventureIds }, "message.externalId": { $in: thread } })).map(String);
      if (leadIds.length === 1) {
        const lead = await loadLead(ctx, leadIds[0]!).catch(() => null);
        if (lead && fromLead(lead, sender)) return lead;
      }
    }
    const rows = await db.collection("opportunities").find({ workspaceId: ctx.workspaceId, suppressKeys: suppressionKey("email", sender), ventureId: { $in: ventureIds }, deletedAt: null }, { projection: { _id: 1 }, limit: 2 }).toArray();
    if (rows.length !== 1) return null;
    return loadLead(ctx, String(rows[0]!._id)).catch(() => null);
  }

  /** Files one message; says what happened to it. */
  async function fileMessage(ctx: SalesCtx, account: AppDocument, raw: Buffer, fallbackId: string, side: () => Promise<OurSide>): Promise<"filed" | "bounced" | "skipped"> {
    const mail = await parseMail(raw);
    const now = new Date();
    const head = raw.length > MAIL_MAX_BYTES ? raw.subarray(0, MAIL_MAX_BYTES) : raw;
    // The whole report as text (its status part, the returned headers), read only when the message is a delivery report.
    let texts: string | undefined;
    const readTexts = () => (texts ??= [head.toString("latin1"), mail.text ?? "", ...mail.attachments.filter((part) => /^(message|text)\//i.test(part.contentType) && part.size <= MAIL_MAX_BYTES).map((part) => part.content.toString("utf8"))].join("\n"));
    const report = deliveryReport(mail, readTexts);
    if (report) {
      // A delay or a success notice changes nothing; only a failed delivery is a bounce.
      if (!report.failed) return "skipped";
      const all = readTexts();
      const ours = ourMessageIds(all);
      if (!ours.length) return "skipped";
      return (await markBounced(ctx, account, ours, bounceReason(all), now)) ? "bounced" : "skipped";
    }
    if (isAutomatic(mail)) return "skipped";
    const from = firstAddress(mail.from);
    const sender = from ? normalizeEmail(from) : null;
    if (!from || !sender) return "skipped";
    const lead = await leadFor(ctx, account, mail, sender, await side());
    if (!lead) return "skipped";
    const externalId = messageIds(mail.messageId)[0] ?? fallbackId;
    // The same reply reaching two of our mailboxes is filed once on the lead.
    if (await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, leadId: String(lead._id), direction: "in", "message.externalId": externalId }, { projection: { _id: 1 } })) return "skipped";
    const thread = [...messageIds(mail.references), ...messageIds(mail.inReplyTo)];
    const text = mailText(mail);
    const body = (stripQuoted(text) || text).slice(0, BODY_MAX);
    const at = mail.date && !Number.isNaN(mail.date.getTime()) && mail.date.getTime() <= now.getTime() ? mail.date : now;
    const mailbox = String(settingsOf(account).address ?? "").trim().toLowerCase();
    const message = { accountId: String(account._id), externalId, threadKey: thread[0] ?? externalId, ...(mail.subject ? { subject: mail.subject.slice(0, 500) } : {}), from, to: addressText(mail.to) || mailbox };
    try {
      await atomic(database, async (session) => {
        const fresh = await loadLead(ctx, String(lead._id), session);
        const { activity } = await applyActivity(ctx, fresh, { kind: "email", direction: "in", body, at: at.toISOString() }, now, session, "system", { message });
        await auditSales(ctx, "sales.email.reply_filed", "activity", String(activity._id), String(lead.ventureId), { channel: "email" }, session);
      });
    } catch (error) {
      // Already filed (a re-read mailbox): the unique (account, Message-ID) index says so.
      if ((error as { code?: number }).code === 11000) return "skipped";
      throw error;
    }
    return "filed";
  }

  /**
   * One round on one mailbox, under its lease and its deadline. Null when the mailbox isn't due (switched off, not reading, leased elsewhere,
   * its password refused).
   */
  async function syncAccount(accountId: string): Promise<MailRound | null> {
    const now = new Date();
    const account = await accounts.findOneAndUpdate(
      { _id: accountId, kind: "email", enabled: { $ne: false }, "settings.syncInbox": { $ne: false }, "mailSync.authFailedAt": null, $or: [{ "mailSync.leaseUntil": null }, { "mailSync.leaseUntil": { $lt: now } }] },
      { $set: { "mailSync.leaseUntil": new Date(now.getTime() + LEASE_MS), "mailSync.leaseBy": workerId } },
      { returnDocument: "after" },
    );
    if (!account) return null;
    const round: MailRound = { accountId, status: "read", read: 0, filed: 0, bounced: 0, skipped: 0 };
    const settings = settingsOf(account);
    let client: MailClient | undefined;
    // The deadline: past it the connection is closed and whatever the round waits on stops waiting.
    const expiry = new AbortController();
    const expired = new Promise<never>((_resolve, reject) => expiry.signal.addEventListener("abort", () => reject(new MailDeadline("deadline")), { once: true }));
    expired.catch(() => undefined);
    const deadline = setTimeout(() => { expiry.abort(); client?.close?.(); }, deadlineMs);
    deadline.unref?.();
    const bounded = <T>(work: Promise<T>) => Promise.race([work, expired]);
    // The lease is renewed while the round works; a lease someone else took over stops the round.
    let leaseLost = false;
    const renew = setInterval(() => {
      void accounts.updateOne({ _id: account._id, "mailSync.leaseBy": workerId }, { $set: { "mailSync.leaseUntil": new Date(Date.now() + LEASE_MS) } })
        .then((renewed) => { if (!renewed.matchedCount) { leaseLost = true; expiry.abort(); client?.close?.(); } }, () => undefined);
    }, LEASE_RENEW_MS);
    renew.unref?.();
    let side: Promise<OurSide> | undefined;
    const ours = () => (side ??= ourSide(account));
    try {
      const password = openSecrets(options.env, account).password;
      if (!password) {
        await accounts.updateOne({ _id: account._id }, { $set: { status: "needs_attention", statusNote: "The saved password can't be read any more: enter it again", lastError: "The saved password can't be read any more: enter it again", "mailSync.authFailedAt": now } });
        return { ...round, status: "failed", error: "password" };
      }
      const ctx = await ownerCtx(account);
      if (typeof ctx === "string") {
        await accounts.updateOne({ _id: account._id }, { $set: { lastError: ctx } });
        return { ...round, status: "skipped", error: "owner" };
      }
      client = connect(account, password);
      await bounded(client.connect());
      const box = await bounded(client.mailboxOpen("INBOX", { readOnly: true }));
      const uidValidity = String(box.uidValidity);
      const uidNext = Number(box.uidNext);
      const cursor = account.mailSync as { uidValidity?: string; lastUid?: number } | undefined;
      // First round, or the server renumbered the mailbox: start at what arrives from now on.
      if (cursor?.uidValidity !== uidValidity || typeof cursor.lastUid !== "number") {
        await accounts.updateOne({ _id: account._id }, { $set: { "mailSync.uidValidity": uidValidity, "mailSync.lastUid": Math.max(0, uidNext - 1), "mailSync.startedAt": now, lastSyncAt: now }, $unset: { lastError: "" } });
        return { ...round, status: "started" };
      }
      const from = cursor.lastUid + 1;
      const to = Math.min(uidNext - 1, cursor.lastUid + MAIL_BATCH);
      let cut = false;
      if (from <= to) {
        // Explicit numbers on both ends (never "N:*", which answers with the newest message even when it is older than N). The server answers
        // in mailbox order, which is UID order: oldest first, newest last. Each message is filed as it arrives (no batch held in memory).
        const messages = client.fetch(`${from}:${to}`, { uid: true, source: { maxLength: MAIL_MAX_BYTES } }, { uid: true })[Symbol.asyncIterator]();
        for (;;) {
          if (stopped || leaseLost || expiry.signal.aborted) { cut = true; break; }
          const next = await bounded(messages.next());
          if (next.done) break;
          const item = next.value;
          if (item.uid < from || item.uid > to) continue;
          round.read++;
          try {
            const outcome = item.source ? await fileMessage(ctx, account, item.source, `<imap-${uidValidity}-${item.uid}@${String(account._id)}>`, ours) : "skipped";
            if (outcome === "filed") round.filed++; else if (outcome === "bounced") round.bounced++; else round.skipped++;
          } catch (error) {
            // One message that can't be read or filed doesn't hold the mailbox up: it is skipped, and said so in the log (no content).
            round.skipped++;
            log({ level: "warn", event: "sales.mail_sync.message_failed", accountId, uid: item.uid, message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
          }
          await accounts.updateOne({ _id: account._id, "mailSync.uidValidity": uidValidity }, { $max: { "mailSync.lastUid": item.uid } });
        }
        if (cut) void messages.return?.(undefined)?.catch?.(() => undefined);
        // Every UID up to `to` has been seen (UIDs only grow): the cursor moves past the gaps too, unless the round was cut short.
        if (!cut) await accounts.updateOne({ _id: account._id, "mailSync.uidValidity": uidValidity }, { $max: { "mailSync.lastUid": to } });
      }
      if (leaseLost) return { ...round, status: "skipped", error: "lease" };
      if (cut && expiry.signal.aborted) throw new MailDeadline("deadline");
      await accounts.updateOne({ _id: account._id }, { $set: { lastSyncAt: new Date() }, $unset: { lastError: "" } });
      return round;
    } catch (error) {
      if (leaseLost) return { ...round, status: "skipped", error: "lease" };
      if (error instanceof MailDeadline || expiry.signal.aborted) {
        await accounts.updateOne({ _id: account._id }, { $set: { lastError: "Reading the inbox took too long, so it was stopped: the next round goes on from where it stopped" } });
        log({ level: "warn", event: "sales.mail_sync.deadline", accountId, read: round.read });
        return { ...round, status: "failed", error: "deadline" };
      }
      // In plain words only: what the server said (its greeting, its error text) is never kept.
      const failure = imapFailure(error, settings);
      await accounts.updateOne({ _id: account._id }, { $set: { lastError: failure.message, ...(failure.auth ? { status: "needs_attention", statusNote: failure.message, "mailSync.authFailedAt": new Date() } : {}) } });
      log({ level: "warn", event: "sales.mail_sync.failed", accountId, auth: failure.auth });
      return { ...round, status: "failed", error: failure.auth ? "auth" : "connection" };
    } finally {
      clearTimeout(deadline);
      clearInterval(renew);
      if (client) {
        // A polite LOGOUT, but never a long wait for it; past the deadline the connection is simply closed.
        if (!expiry.signal.aborted) await Promise.race([client.logout().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, LOGOUT_WAIT_MS).unref())]);
        client.close?.();
      }
      await accounts.updateOne({ _id: account._id, "mailSync.leaseBy": workerId }, { $unset: { "mailSync.leaseUntil": "", "mailSync.leaseBy": "" } }).catch(() => undefined);
    }
  }

  /** One round over every mailbox that is due, three at a time; one mailbox's trouble never stops the others. */
  async function syncOnce(): Promise<MailRound[]> {
    if (running) return running;
    running = (async () => {
      const rounds: MailRound[] = [];
      const due = (await accounts.find({ kind: "email", enabled: { $ne: false }, "settings.syncInbox": { $ne: false }, "mailSync.authFailedAt": null }, { projection: { _id: 1 } }).toArray()).map((row) => String(row._id));
      const work = async () => {
        for (let id = due.shift(); id !== undefined && !stopped; id = due.shift()) {
          try { const round = await syncAccount(id); if (round) rounds.push(round); }
          catch (error) { log({ level: "warn", event: "sales.mail_sync.account_failed", accountId: id, message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAIL_CONCURRENCY, due.length) }, work));
      return rounds;
    })();
    try { return await running; } finally { running = undefined; }
  }

  function start(): void {
    if (timer || stopped) return;
    const tick = () => void syncOnce().then((rounds) => {
      const filed = rounds.reduce((sum, round) => sum + round.filed, 0);
      const bounced = rounds.reduce((sum, round) => sum + round.bounced, 0);
      if (filed || bounced) log({ level: "info", event: "sales.mail_sync.round", mailboxes: rounds.length, filed, bounced });
    }, (error: unknown) => log({ level: "warn", event: "sales.mail_sync.loop_failed", message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    timer = setInterval(tick, options.pollMs ?? MAIL_SYNC_POLL_MS);
    timer.unref();
    log({ level: "info", event: "sales.mail_sync.started", workerId });
    tick();
  }

  /** Stops the loop; a round in progress finishes its current message (waiting up to 10 seconds). */
  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearInterval(timer);
    const current = running;
    if (current) await Promise.race([current.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
  }

  return { syncOnce, syncAccount, start, stop, workerId };
}
