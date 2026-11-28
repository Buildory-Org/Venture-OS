import { Router, type Response } from "express";
import { pipeline } from "node:stream/promises";
import type { z } from "zod";
import {
  MAIL_ATTACHMENT_LIMIT_BYTES, MAIL_PART_PATTERN, activityInputSchema, idSchema, mailFlagInputSchema, mailFolderQuerySchema, mailListQuerySchema, mailMoveInputSchema, mailSendInputSchema,
  type MailAccount, type MailMessage, type MailRow, type MailSendResult,
} from "@venture-studio/contracts";
import type { ParsedMail } from "mailparser";
import type { AppConfig } from "../config.js";
import { atomic, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { overLimit } from "../middleware.js";
import { canSeeVenture, forbidClaude, notFound } from "../sales/access.js";
import { ACCOUNTS, openSecrets } from "../sales/channels/accounts.js";
import {
  MAILBOX_DOWNLOAD_MS, addFlag, addressList, cleanHtml, composeMail, downloadPart, forwardBlock, forwardedFiles, idsIn, listFolders, listMessages, moveMessage, readMessage,
  replyQuote, sendKey, sendRaw, setFlags, textOf, withMailbox, type OutgoingFile,
} from "../sales/channels/email/mailbox.js";
import { saveToSent, settingsOf, smtpFailure, SmtpStepError } from "../sales/channels/email/provider.js";
import { BAD_ADDRESSES, claimMailboxSlot } from "../sales/channels/mailbox-guard.js";
import { auditSales, salesCtx, settingsFor, type SalesCtx } from "../sales/ctx.js";
import { applyActivity, claimSendSlot, loadLead, markHandled, requireLeadEditor, suppressedBy } from "../sales/leads.js";
import { calendarOf } from "../sales/settings.js";
import { isSharedDomain, normalizeEmail, suppressionKey } from "../sales/suppression.js";

const ok = (data: unknown) => ({ ok: true, data });
const SENDS = "sales_mail_sends";
/** Messages one person may send from the Mail page in a minute. */
const SENDS_PER_MINUTE = 20;
/** How long the mail server may take to accept one message. */
const SEND_TIMEOUT_MS = 45_000;
/** Everything that goes with one message (the attachments added and the forwarded ones). */
const FILES_MAX_BYTES = 20 * 1024 * 1024;
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const uidOf = (value: unknown) => {
  const uid = Number(value);
  if (!Number.isInteger(uid) || uid < 1 || uid > 4_294_967_295) throw new AppError(400, "BAD_REQUEST", "That is not a message in this mailbox");
  return uid;
};
const emailKey = (address: string) => { const normal = normalizeEmail(address); return normal ? suppressionKey("email", normal) : undefined; };
const domainOfAddress = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
/** Aborted when the browser leaves before the answer is sent: its request is skipped when its turn on the mailbox comes. */
function goneOf(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}
/** A send still marked "sending" after this long was cut off (the server stopped): it may or may not have gone. */
const STALE_SEND_MS = 2 * 60_000;

/**
 * Mail (docs/sales-channels.md section 3a): a person's own connected mailbox as a webmail. Every route is the mailbox owner's only (an admin
 * or a head gets "not found", like a mailbox that doesn't exist) and session only (Claude is refused). Nothing read is stored; a message
 * sent here is noted on the leads it went to (their history, and the reply it answers leaves the Inbox), like a message sent from Review.
 */
export function salesMailRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();

  async function ownMailbox(ctx: SalesCtx, id: unknown): Promise<AppDocument> {
    forbidClaude(ctx.via, "Reading or sending mail");
    const account = await db.collection(ACCOUNTS).findOne({ _id: idSchema.parse(id), workspaceId: ctx.workspaceId, kind: "email" });
    if (!account || account.ownerUserId !== ctx.actor.id) throw notFound("Mailbox");
    return account;
  }
  const venturesOf = (ctx: SalesCtx, account: AppDocument) => (Array.isArray(account.ventureIds) ? account.ventureIds.map(String) : []).filter((ventureId) => canSeeVenture(ctx.actor, ventureId));
  const ownAddress = (account: AppDocument) => String(settingsOf(account).address ?? "").toLowerCase();

  /** The leads these addresses belong to (exactly one lead per address, in the mailbox's ventures). */
  async function leadsByAddress(ctx: SalesCtx, account: AppDocument, addresses: Iterable<string>): Promise<Map<string, AppDocument>> {
    const ventureIds = venturesOf(ctx, account);
    const keys = new Map<string, string>();
    for (const address of addresses) { const key = emailKey(address); if (key) keys.set(address, key); }
    if (!ventureIds.length || !keys.size) return new Map();
    const rows = await db.collection("opportunities").find({ workspaceId: ctx.workspaceId, ventureId: { $in: ventureIds }, deletedAt: null, suppressKeys: { $in: [...new Set(keys.values())] } }, { projection: { _id: 1, companyName: 1, ventureId: 1, suppressKeys: 1 }, limit: 500 }).toArray();
    const found = new Map<string, AppDocument>();
    for (const [address, key] of keys) {
      const matches = rows.filter((row) => Array.isArray(row.suppressKeys) && row.suppressKeys.includes(key));
      if (matches.length === 1) found.set(address, matches[0]!);
    }
    return found;
  }

  /** Each row with the lead it is with, and what became of the messages the sales app sent (sent, bounced, unclear, replied). */
  async function linkRows(ctx: SalesCtx, account: AppDocument, rows: (MailRow & { messageId?: string })[]): Promise<MailRow[]> {
    const own = ownAddress(account);
    const other = (row: MailRow) => (row.from.some((entry) => entry.address === own) ? row.to : row.from).find((entry) => entry.address !== own)?.address;
    const leads = await leadsByAddress(ctx, account, rows.map(other).filter((address): address is string => Boolean(address)));
    const ventureIds = venturesOf(ctx, account);
    const ids = rows.map((row) => row.messageId).filter((id): id is string => Boolean(id));
    const sent = ids.length && ventureIds.length ? await db.collection("sales_activities").find({ workspaceId: ctx.workspaceId, direction: "out", ventureId: { $in: ventureIds }, "message.accountId": String(account._id), "message.externalId": { $in: ids } }, { projection: { leadId: 1, draftId: 1, at: 1, "message.externalId": 1, "message.delivery": 1 }, limit: 200 }).toArray() : [];
    const sentLeadIds = [...new Set(sent.map((activity) => String(activity.leadId)))];
    const [sentLeads, replies] = sentLeadIds.length ? await Promise.all([
      db.collection("opportunities").find({ workspaceId: ctx.workspaceId, _id: { $in: sentLeadIds } }, { projection: { companyName: 1, ventureId: 1 } }).toArray(),
      db.collection("sales_activities").find({ workspaceId: ctx.workspaceId, direction: "in", leadId: { $in: sentLeadIds } }, { projection: { leadId: 1, at: 1 }, sort: { at: 1 }, limit: 2_000 }).toArray(),
    ]) : [[], []];
    return rows.map(({ messageId, ...row }) => {
      const address = other(row);
      const lead = address ? leads.get(address) : undefined;
      const activity = messageId ? sent.find((entry) => entry.message?.externalId === messageId) : undefined;
      const sentLead = activity ? sentLeads.find((entry) => String(entry._id) === String(activity.leadId)) : undefined;
      let track: MailRow["track"];
      if (activity && sentLead) {
        const state = activity.message?.delivery?.state;
        const reply = replies.find((entry) => String(entry.leadId) === String(activity.leadId) && new Date(entry.at).getTime() > new Date(activity.at).getTime());
        track = {
          ...(activity.draftId ? { draftId: String(activity.draftId) } : {}), leadId: String(activity.leadId), companyName: String(sentLead.companyName ?? ""),
          state: state === "bounced" ? "bounced" : state === "uncertain" ? "uncertain" : reply ? "replied" : "sent",
          ...(reply && state !== "bounced" ? { repliedAt: new Date(reply.at).toISOString() } : {}),
        };
      }
      return { ...row, ...(lead ? { lead: { leadId: String(lead._id), companyName: String(lead.companyName ?? ""), ventureId: String(lead.ventureId) } } : {}), ...(track ? { track } : {}) };
    });
  }

  // The person's own mailboxes (the email accounts they connected in Channels).
  router.get("/mail/accounts", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Reading mail");
    const rows = await db.collection(ACCOUNTS).find({ workspaceId: ctx.workspaceId, kind: "email", ownerUserId: ctx.actor.id }).sort({ createdAt: 1 }).limit(20).toArray();
    const accounts: MailAccount[] = rows.map((account) => ({ id: String(account._id), label: String(account.label ?? ""), address: ownAddress(account), status: String(account.status ?? "not_tested"), ventureIds: Array.isArray(account.ventureIds) ? account.ventureIds.map(String) : [], defaultFor: Array.isArray(account.defaultFor) ? account.defaultFor.map(String) : [] }));
    res.json(ok(accounts));
  });

  router.get("/mail/:accountId/folders", async (req, res) => {
    const ctx = salesCtx(database, req);
    const account = await ownMailbox(ctx, req.params.accountId);
    res.json(ok(await withMailbox(config, account, (client) => listFolders(client), undefined, goneOf(res))));
  });

  router.get("/mail/:accountId/messages", async (req, res) => {
    const ctx = salesCtx(database, req);
    const account = await ownMailbox(ctx, req.params.accountId);
    const query = mailListQuerySchema.parse(req.query);
    const page = await withMailbox(config, account, (client) => listMessages(client, { folder: query.folder, before: query.before, q: query.q || undefined, limit: query.limit }), undefined, goneOf(res));
    res.json(ok({ folder: query.folder, total: page.total, items: await linkRows(ctx, account, page.rows), ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}) }));
  });

  // One message, marked read (opening it in a mailbox does that).
  router.get("/mail/:accountId/messages/:uid", async (req, res) => {
    const ctx = salesCtx(database, req);
    const account = await ownMailbox(ctx, req.params.accountId);
    const { folder } = mailFolderQuerySchema.parse(req.query);
    const uid = uidOf(req.params.uid);
    const read = await withMailbox(config, account, (client) => readMessage(client, folder, uid, true), undefined, goneOf(res));
    const [row] = await linkRows(ctx, account, [read.row]);
    const html = typeof read.mail.html === "string" && read.mail.html.trim() ? cleanHtml(read.mail.html) : undefined;
    const message: MailMessage = {
      ...row!, cc: addressList(read.mail.cc), replyTo: addressList(read.mail.replyTo), ...(read.row.messageId ? { messageId: read.row.messageId } : {}),
      text: textOf(read.mail), ...(html ? { html: html.html } : {}), remoteImages: html?.remoteImages ?? false,
      attachments: read.parts, truncated: read.truncated,
    };
    res.json(ok(message));
  });

  router.patch("/mail/:accountId/messages/:uid", async (req, res) => {
    const ctx = salesCtx(database, req);
    const account = await ownMailbox(ctx, req.params.accountId);
    const { folder } = mailFolderQuerySchema.parse(req.query);
    const change = mailFlagInputSchema.parse(req.body);
    await withMailbox(config, account, (client) => setFlags(client, folder, uidOf(req.params.uid), change));
    res.json(ok({ uid: uidOf(req.params.uid), ...change }));
  });

  router.post("/mail/:accountId/messages/:uid/move", async (req, res) => {
    const ctx = salesCtx(database, req);
    const account = await ownMailbox(ctx, req.params.accountId);
    const { folder } = mailFolderQuerySchema.parse(req.query);
    const { to } = mailMoveInputSchema.parse(req.body);
    res.json(ok(await withMailbox(config, account, (client) => moveMessage(client, folder, uidOf(req.params.uid), to))));
  });

  // One attachment, always as a download (never shown by the browser), straight from the mail server.
  router.get("/mail/:accountId/messages/:uid/parts/:part", async (req, res) => {
    const ctx = salesCtx(database, req);
    const account = await ownMailbox(ctx, req.params.accountId);
    const { folder } = mailFolderQuerySchema.parse(req.query);
    const uid = uidOf(req.params.uid);
    const part = String(req.params.part);
    if (!MAIL_PART_PATTERN.test(part)) throw new AppError(400, "BAD_REQUEST", "That is not an attachment of this message");
    try {
      await withMailbox(config, account, (client) => downloadPart(client, folder, uid, part, async (file) => {
        deliverFile(res, file.filename);
        await pipeline(file.content, res);
      }), MAILBOX_DOWNLOAD_MS, goneOf(res));
    } catch (error) {
      // Once the file has started, a failure can only end the download.
      if (res.headersSent) { res.destroy(); return; }
      throw error;
    }
  });

  // Sends a message from the mailbox: new, a reply, a reply to all, or a forward. The same requestId twice sends it once.
  router.post("/mail/:accountId/send", async (req, res) => {
    const ctx = salesCtx(database, req);
    const account = await ownMailbox(ctx, req.params.accountId);
    if (account.enabled === false) throw new AppError(409, "CONFLICT", "This mailbox is switched off in Sales > Channels: switch it on to send from it");
    const input = mailSendInputSchema.parse(req.body);
    const settings = settingsOf(account);
    const own = ownAddress(account);
    const to = [...new Set(input.to)];
    const cc = [...new Set(input.cc)].filter((address) => !to.includes(address));
    if (to.length + cc.length > 30) throw new AppError(400, "BAD_REQUEST", "Send to 30 addresses at most");
    const uploads: OutgoingFile[] = input.attachments.map((file) => ({ filename: clip(file.filename.replace(/[\u0000-\u001f\u007f/\\]+/g, " ").trim() || "attachment", 200), contentType: /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType : "application/octet-stream", content: Buffer.from(file.data, "base64") }));
    if (uploads.reduce((sum, file) => sum + file.content.length, 0) > MAIL_ATTACHMENT_LIMIT_BYTES) throw new AppError(400, "BAD_REQUEST", "Attachments can be 10 MB at most in all");
    const password = openSecrets(config, account).password;
    if (!password) throw new AppError(409, "CONFLICT", "No password is saved for this mailbox: enter it again in Sales > Channels");

    const sends = db.collection(SENDS);
    const key = sendKey(String(account._id), input.requestId);
    const earlier = await sends.findOne({ _id: key });
    if (earlier?.result) { res.status(200).json(ok(earlier.result)); return; }
    if (earlier && Date.now() - new Date(earlier.createdAt).getTime() > STALE_SEND_MS) throw new AppError(409, "CONFLICT", "This message may already have gone: look in Sent. To send it anyway, close this window and write it again");
    if (earlier) throw new AppError(409, "CONFLICT", "This message is being sent: wait a moment, then look in Sent");
    const wait = await overLimit(db, `sales-mail-send:${ctx.actor.id}`, SENDS_PER_MINUTE);
    if (wait) { res.setHeader("retry-after", String(wait)); throw new AppError(429, "RATE_LIMITED", `That is a lot of mail in a minute: try again in ${wait} s`); }
    try { await sends.insertOne({ _id: key, workspaceId: ctx.workspaceId, accountId: String(account._id), userId: ctx.actor.id, state: "sending", createdAt: new Date() }); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new AppError(409, "CONFLICT", "This message is being sent: wait a moment, then look in Sent"); throw error; }

    let went = false;
    const releases: (() => Promise<void>)[] = [];
    try {
      const warnings: string[] = [];
      let source: { mail: ParsedMail; truncated: boolean; hadFiles: boolean } | undefined;
      if (input.source) {
        const { folder, uid } = input.source;
        const read = await withMailbox(config, account, (client) => readMessage(client, folder, uid, false));
        source = { mail: read.mail, truncated: read.truncated, hadFiles: read.parts.some((part) => !part.inline) };
      }
      const replying = input.mode === "reply" || input.mode === "reply_all";
      // Nothing goes to an address or domain on the do-not-contact list, except an answer to the person who wrote.
      const wrote = new Set(source && replying ? [...addressList(source.mail.from), ...addressList(source.mail.replyTo)].map((entry) => entry.address) : []);
      for (const address of [...to, ...cc]) {
        if (address === own || wrote.has(address)) continue;
        const domain = domainOfAddress(address);
        const keys = [emailKey(address), isSharedDomain(domain) ? undefined : suppressionKey("domain", domain)].filter((value): value is string => Boolean(value));
        if (await suppressedBy(ctx, keys)) throw new AppError(409, "CONFLICT", `${address} is on the do-not-contact list: nothing is sent to it`);
      }
      // A new message or a forward to a lead is outreach: the sender protection counts it like a message sent from Review (the venture's
      // daily limit per person and the mailbox's day), and an address that bounced before is not mailed again. An answer is never held.
      const toLeads = replying ? new Map<string, AppDocument>() : await leadsByAddress(ctx, account, [...to, ...cc]);
      const now = new Date();
      for (const address of toLeads.keys()) {
        const bad = await db.collection(BAD_ADDRESSES).findOne({ _id: `${ctx.workspaceId}:${normalizeEmail(address) ?? address}` as never });
        if (bad) throw new AppError(409, "CONFLICT", `${address} ${bad.kind === "no_mail_server" ? "can't receive mail" : bad.kind === "refused" ? "was refused by its mail server before" : "bounced before"}, so the app won't email it again: check the address on ${String(toLeads.get(address)?.companyName ?? "the lead")}`);
      }
      const counted = new Set<string>();
      for (const lead of toLeads.values()) {
        if (counted.has(String(lead._id))) continue;
        counted.add(String(lead._id));
        releases.push(await claimSendSlot(ctx, String(lead.ventureId), "email", now));
      }
      const firstLead = [...toLeads.values()][0];
      if (firstLead) {
        const ventureSettings = await settingsFor(ctx, String(firstLead.ventureId));
        releases.push(await claimMailboxSlot(db, account, { cap: ventureSettings.dailyCaps.email, cal: calendarOf(ventureSettings), now, enforce: false }));
      }
      let text = input.body.replace(/\r\n?/g, "\n");
      if (source && replying) text = `${text}\n\n${replyQuote(source.mail, input.timezone)}`;
      if (source && input.mode === "forward") text = `${text}\n\n${forwardBlock(source.mail, input.timezone)}`;
      let files = uploads;
      if (source && input.mode === "forward" && source.hadFiles) {
        const forwarded = source.truncated ? [] : forwardedFiles(source.mail);
        if (source.truncated || forwarded.reduce((sum, file) => sum + file.content.length, 0) + uploads.reduce((sum, file) => sum + file.content.length, 0) > FILES_MAX_BYTES) warnings.push("The forwarded message's attachments were too big to send with it: they were left out");
        else files = [...uploads, ...forwarded];
      }
      const composed = await composeMail(settings, { to, cc, subject: input.subject, text, answering: source && replying ? source.mail : undefined, files });

      let state: "sent" | "uncertain" = "sent";
      let refused: string[] = [];
      try {
        const answer = await sendRaw(settings, password, AbortSignal.timeout(SEND_TIMEOUT_MS), { from: settings.address, to: [...to, ...cc], raw: composed.raw }) as { rejected?: string[] } | undefined;
        refused = (answer?.rejected ?? []).map((address) => address.toLowerCase());
        if (refused.length) warnings.push(`The mail server refused ${refused.slice(0, 5).join(", ")}${refused.length > 5 ? ` and ${refused.length - 5} more` : ""}: ${refused.length === 1 ? "that address" : "those addresses"} didn't get it`);
      } catch (error) {
        const outcome = error instanceof SmtpStepError ? smtpFailure(error.error, error.phase, settings) : { state: "uncertain" as const, error: "" };
        if (outcome.state === "failed") throw new AppError(502, "SEND_FAILED", outcome.error.replace(/the lead's address/g, "an address"));
        state = "uncertain";
        warnings.push("The mail server stopped answering while it was being sent, so it may or may not have gone: look in Sent before sending it again");
      }
      went = true;
      if (settings.saveToSent === true) void saveToSent(settings, password, composed.raw).catch(() => console.warn(JSON.stringify({ level: "warn", event: "sales.mail.save_to_sent_failed", accountId: String(account._id) })));
      if (input.source && replying) void withMailbox(config, account, (client) => addFlag(client, input.source!.folder, input.source!.uid, "\\Answered")).catch(() => undefined);
      const delivered = (list: string[]) => list.filter((address) => !refused.includes(address));
      const noted = state === "sent" ? await noteOnLeads(ctx, account, { mode: input.mode, to: delivered(to), cc: delivered(cc), subject: input.subject, body: input.body }, source?.mail, composed) : { notedOn: [], warnings: [] };
      const result: MailSendResult = { state, messageId: composed.messageId, notedOn: noted.notedOn, warnings: [...warnings, ...noted.warnings] };
      await sends.updateOne({ _id: key }, { $set: { state, result, finishedAt: new Date() } }).catch(() => undefined);
      await auditSales(ctx, "sales.mail.send", "channel_account", String(account._id), undefined, { mode: input.mode, recipients: to.length + cc.length, attachments: files.length, notedOn: noted.notedOn.length, state }).catch(() => undefined);
      res.status(201).json(ok(result));
    } catch (error) {
      // Nothing went out: the counted sends are given back, and the same request may be tried again.
      if (!went) {
        await Promise.all(releases.map((release) => release().catch(() => undefined)));
        await sends.deleteOne({ _id: key, state: "sending" }).catch(() => undefined);
      }
      throw error;
    }
  });

  /**
   * Notes a sent message on the leads it went to, like a message sent from Review: the lead's history, its stage (a first message moves it
   * to contacted), its follow-up date, and the reply it answers leaves the Inbox. Never fails the send: what can't be noted comes back in words.
   */
  async function noteOnLeads(ctx: SalesCtx, account: AppDocument, sent: { mode: string; to: string[]; cc: string[]; subject: string; body: string }, source: ParsedMail | undefined, composed: { messageId: string; threadKey: string }): Promise<{ notedOn: MailSendResult["notedOn"]; warnings: string[] }> {
    const notedOn: MailSendResult["notedOn"] = [];
    const warnings: string[] = [];
    try {
      const own = ownAddress(account);
      const ventureIds = venturesOf(ctx, account);
      if (!ventureIds.length) return { notedOn, warnings };
      const recipients = [...sent.to, ...sent.cc].filter((address) => address !== own);
      const leads = await leadsByAddress(ctx, account, recipients);
      const targets = new Map<string, string>();
      // The reply the app filed on a lead, when this answers it: that lead first, so the message's id is noted there.
      const answeredId = source?.messageId && (sent.mode === "reply" || sent.mode === "reply_all") ? idsIn(source.messageId)[0] : undefined;
      const answered = answeredId ? await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, direction: "in", ventureId: { $in: ventureIds }, "message.externalId": answeredId }) : null;
      if (answered) targets.set(String(answered.leadId), sent.to[0]!);
      for (const address of recipients) { const lead = leads.get(address); if (lead && !targets.has(String(lead._id))) targets.set(String(lead._id), address); }
      const now = new Date();
      let first = true;
      for (const [leadId, address] of [...targets].slice(0, 10)) {
        let company = "a lead";
        try {
          await atomic(database, async (session) => {
            const lead = await loadLead(ctx, leadId, session);
            company = String(lead.companyName ?? company);
            requireLeadEditor(ctx, lead, "note this message on the lead");
            const activity = { kind: "email", direction: "out", body: clip(sent.body.trim() || "(no text)", 10_000), at: now.toISOString() } as z.infer<typeof activityInputSchema>;
            // One activity per message carries its id (the id is unique per mailbox); the other leads' copies keep the thread only.
            await applyActivity(ctx, lead, activity, now, session, "app", { sendClaimed: true, message: { accountId: String(account._id), ...(first ? { externalId: composed.messageId } : {}), threadKey: composed.threadKey, subject: clip(sent.subject, 300), from: own, to: address } });
            if (answered && String(answered.leadId) === leadId && !answered.handledAt) await markHandled(ctx, lead, answered, now, session);
          });
          first = false;
          notedOn.push({ leadId, companyName: company });
        } catch (error) {
          warnings.push(`It went out, but it couldn't be noted on ${company}: ${error instanceof AppError ? error.message : "log it on the lead"}`);
        }
      }
    } catch {
      warnings.push("It went out, but the leads it went to couldn't be updated: log it on the lead");
    }
    return { notedOn, warnings };
  }

  return router;
}

/** Download headers: always a file to save, never a page the browser shows. */
function deliverFile(res: Response, filename: string) {
  const plain = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_").slice(0, 150) || "attachment";
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader("content-disposition", `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(filename).slice(0, 600)}`);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
}

