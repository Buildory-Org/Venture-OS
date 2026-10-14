// Email through a person's own mailbox (docs/sales-channels.md section 3). Sending: one plain-text message from their address over SMTP
// (nodemailer's SMTP connection, so the code knows which step broke: nothing has gone out before the message itself starts, and a connection
// that breaks while it is on its way may or may not have delivered it). Testing: an SMTP sign-in and an IMAP sign-in with the inbox's status,
// nothing sent. The provider never touches the database, never logs a password, and says what went wrong in words a seller understands.
//
// Where it connects: a mail server's name is resolved first and refused when any address it resolves to is loopback, private, link-local,
// CGNAT, unique-local, multicast or reserved (the cloud metadata address included), and only on the standard mail ports. The connection then
// goes to the address that was checked (a second DNS answer can't point it elsewhere) while the TLS certificate is still checked against the
// server's name. Nothing a server says in its greeting or about the connection is ever shown back: only its answer to our MAIL FROM, RCPT TO
// or DATA (a refused address or message), so a mail setting can't be used to read banners off other machines.
import { IMAP_PORTS, SMTP_PORTS, type ChannelAccountTest } from "@venture-studio/contracts";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import type { AppDocument } from "../../../db.js";
import { safeAddress, systemLookup, type LookupImpl } from "../../finder/fetch.js";
import type { ChannelProvider, SendOutcome, SendRequest } from "../provider.js";

/** "plain" may still sit on an account saved before mail had to be encrypted: it is treated as STARTTLS (required), never as clear text. */
export type MailServer = { host: string; port: number; security: "ssl" | "starttls" | "plain" };
export type EmailSettings = { address: string; senderName: string; username: string; smtp: MailServer; imap: MailServer; syncInbox?: boolean; saveToSent?: boolean };
/** Which step of an SMTP session failed: before `send` nothing can have gone out. */
export type SmtpPhase = "connect" | "login" | "send";
/** Where a connection goes: the checked address, and the server's name for the TLS certificate check (none for an address written as one). */
export type MailTarget = { address: string; servername?: string };

/** Connect, greeting and socket timeouts of every mail connection (docs/sales-channels.md). */
export const MAIL_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 } as const;
/** How long a mail server's name may take to resolve. */
const LOOKUP_TIMEOUT_MS = 10_000;
/** The background copy to the Sent folder gives up after this long (a slow server never keeps a connection open for long). */
export const SAVE_TO_SENT_TIMEOUT_MS = 60_000;

export const settingsOf = (account: AppDocument): EmailSettings => account.settings as EmailSettings;
export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
/** Our Message-ID for one send of a draft: derived from the draft and the attempt, so a retried SMTP call is recognisable (and a bounce or a reply finds it). */
export const emailMessageId = (address: string, key: string) => `<${key}@${domainOf(address) || "localhost"}>`;

// ---- Which servers may be used ------------------------------------------------------------------------------------------------------

let mailLookup: LookupImpl = systemLookup;
/** Tests only: answers name lookups for mail servers (so no test ever reaches DNS or a mail server); returns the function that puts the real one back. */
export function useMailLookupForTests(lookup: LookupImpl): () => void {
  if (process.env.NODE_ENV === "production") throw new Error("useMailLookupForTests is for tests only");
  const real = mailLookup;
  mailLookup = lookup;
  return () => { mailLookup = real; };
}

/** Thrown before any connection when a mail server's name, address or port can't be used: `message` is ready to show. */
export class MailServerRefused extends Error {
  readonly code = "EMAILSERVER";
}

/**
 * The address to connect to for a mail server: its name resolved, every address public, the port a standard mail port. Throws
 * MailServerRefused otherwise (a name that doesn't resolve and one that resolves to a private address read the same, so the answer says
 * nothing about the network behind the API). An abort ends the wait.
 */
export async function resolveMailServer(server: Pick<MailServer, "host" | "port">, what: "SMTP" | "IMAP", signal?: AbortSignal, lookup: LookupImpl = mailLookup): Promise<MailTarget> {
  const ports: readonly number[] = what === "SMTP" ? SMTP_PORTS : IMAP_PORTS;
  if (!ports.includes(server.port)) throw new MailServerRefused(`The ${what} server uses port ${server.port}: mail goes through port ${ports.join(", ")} only`);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), LOOKUP_TIMEOUT_MS);
    onAbort = () => resolve("timeout");
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const found = await Promise.race([safeAddress(server.host, lookup), late]);
    if (typeof found === "string") throw new MailServerRefused(found === "timeout" ? `Couldn't reach the ${what} server ${server.host} on port ${server.port}: check the server name, the port and the security setting` : `The ${what} server ${server.host} could not be found on the internet: check the server name`);
    const literal = found.address === server.host.replace(/^\[|\]$/g, "");
    return { address: found.address, ...(literal ? {} : { servername: server.host.replace(/\.$/, "").toLowerCase() }) };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

// ---- Plain words for what went wrong ------------------------------------------------------------------------------------------------

type ErrorLike = { code?: unknown; originalCode?: unknown; responseCode?: unknown; command?: unknown; response?: unknown; message?: unknown; timeoutType?: unknown; authenticationFailed?: unknown; serverResponseCode?: unknown; tlsFailed?: unknown; responseText?: unknown };

/** The mail provider behind a server name, for the advice that differs between them. */
function providerOf(host: string): "gmail" | "outlook" | "zoho" | "other" {
  if (/(^|\.)(gmail|googlemail|google)\.com$/i.test(host)) return "gmail";
  if (/(^|\.)(office365|outlook|hotmail|live)\.com$/i.test(host)) return "outlook";
  if (/(^|\.)zoho\.(in|com|eu)$/i.test(host)) return "zoho";
  return "other";
}

/** The mailbox refused the username or password. */
export function passwordAdvice(host: string): string {
  switch (providerOf(host)) {
    case "gmail": return "Gmail refused the password: use an app password (Google Account > Security > App passwords), not your normal Gmail password";
    case "outlook": return "Outlook refused the password: use an app password, or ask your Microsoft 365 admin to allow SMTP and IMAP sign-in for this mailbox";
    case "zoho": return "Zoho refused the password: use an app-specific password (Zoho Mail > Settings > Security > App passwords)";
    default: return "The mailbox refused the username or password: check them (many providers need an app password instead of your normal one)";
  }
}

/**
 * A short piece of an SMTP server's answer to one of our commands (e.g. "550 5.1.1 User unknown"), never more than 200 characters. Only a
 * text answer counts (an IMAP error carries a parsed object there, which would read "[object Object]"); control characters are dropped.
 */
const serverWords = (error: ErrorLike) => (typeof error.response === "string" ? error.response : "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
const codeOf = (error: ErrorLike) => (typeof error.code === "string" ? error.code : "");
const originalOf = (error: ErrorLike) => {
  const original = error.originalCode ?? (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof original === "string" ? original : "";
};

/**
 * Why a mail server could not be reached or signed in to (nothing was sent): the server name, port and security setting are what people
 * fix. Fixed sentences only: a refused, filtered, reset or silent connection all read "couldn't reach", and nothing the server said is shown.
 */
export function connectionAdvice(error: unknown, server: MailServer, what: "SMTP" | "IMAP"): string {
  const failure = (error ?? {}) as ErrorLike;
  if (error instanceof MailServerRefused) return error.message;
  const code = codeOf(failure);
  const original = originalOf(failure);
  const text = typeof failure.message === "string" ? failure.message : "";
  if (code === "ENOAUTH") return "No password is saved for this mailbox: enter it again in Sales > Channels";
  if (code === "EDNS" || original === "ENOTFOUND" || original === "EAI_AGAIN" || code === "ENOTFOUND" || code === "EAI_AGAIN") return `The ${what} server ${server.host} could not be found on the internet: check the server name`;
  if (code === "ETLS" || failure.tlsFailed === true || /certificate|wrong version number|ssl|tls/i.test(text)) return `The secure connection to ${server.host} (port ${server.port}) failed: check the security setting (SSL for port ${what === "SMTP" ? "465" : "993"}, STARTTLS for ${what === "SMTP" ? "587" : "143"})`;
  return `Couldn't reach the ${what} server ${server.host} on port ${server.port}: check the server name, the port and the security setting`;
}

/** Our commands whose refusal the server explains in words worth showing (the lead's address, the sender, the message). */
const REPLIED_COMMAND = /^(MAIL FROM|RCPT TO|DATA)\b/i;

/**
 * What a failed SMTP step means for the message. Before `send` nothing can have gone out (failed). During `send`, a refusal from the server
 * (a 4xx or 5xx answer to MAIL FROM, RCPT TO or DATA) means it did not go out (failed); a connection that breaks or times out while the
 * message is on its way may have delivered it (uncertain: a person checks their Sent folder).
 */
export function smtpFailure(error: unknown, phase: SmtpPhase, settings: Pick<EmailSettings, "smtp">): Exclude<SendOutcome, { state: "sent" }> {
  const failure = (error ?? {}) as ErrorLike;
  const code = codeOf(failure);
  const responseCode = typeof failure.responseCode === "number" ? failure.responseCode : undefined;
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534) return { state: "failed", error: passwordAdvice(settings.smtp.host) };
  if (phase !== "send") return { state: "failed", error: connectionAdvice(failure, settings.smtp, "SMTP") };
  const command = typeof failure.command === "string" ? failure.command : "";
  const replied = responseCode !== undefined && responseCode >= 400 && responseCode < 600 && REPLIED_COMMAND.test(command);
  const words = replied ? serverWords(failure) : "";
  const quoted = words ? ` (${words})` : "";
  if (replied && responseCode! < 500) return { state: "failed", error: `The mail server asked to try again later${quoted}: send it again in a few minutes` };
  if (replied && /^RCPT/i.test(command)) return { state: "failed", error: `The mail server refused the lead's address${quoted}: check that it is right` };
  if (replied && /^MAIL FROM/i.test(command)) return { state: "failed", error: `The mail server refused to send from your address${quoted}: the address must belong to the mailbox you signed in with` };
  if (replied) return { state: "failed", error: `The mail server refused the message${quoted}` };
  if (code === "EENVELOPE") return { state: "failed", error: "The mail server refused the lead's address: check that it is right" };
  if (code === "EMESSAGE" || code === "ESTREAM") return { state: "failed", error: "The mail server refused the message" };
  return { state: "uncertain", error: "The mail server stopped answering while the message was being sent, so it may or may not have gone out: check your Sent folder, then say whether it went" };
}

/** Why an IMAP sign-in or read failed, and whether it was the password (the account then needs a person). Never the server's own words. */
export function imapFailure(error: unknown, settings: Pick<EmailSettings, "imap">): { message: string; auth: boolean } {
  const failure = (error ?? {}) as ErrorLike;
  if (failure.authenticationFailed === true || /AUTHENTICATIONFAILED/i.test(typeof failure.serverResponseCode === "string" ? failure.serverResponseCode : "")) return { message: passwordAdvice(settings.imap.host), auth: true };
  return { message: connectionAdvice(failure, settings.imap, "IMAP"), auth: false };
}

// ---- Connections ---------------------------------------------------------------------------------------------------------------------

/** Nodemailer options for one SMTP connection to a checked address: always encrypted (SSL, or STARTTLS required), the name kept for TLS. */
export const smtpOptions = (server: MailServer, target: MailTarget) => ({
  host: target.address, ...(target.servername ? { servername: target.servername } : {}), port: server.port, secure: server.security === "ssl", requireTLS: server.security !== "ssl", ignoreTLS: false,
  ...MAIL_TIMEOUTS, logger: false,
});

/** ImapFlow options for a mailbox at a checked address: always encrypted, never idles, never logs (its log lines could carry addresses). */
export const imapOptions = (settings: EmailSettings, password: string, target: MailTarget) => ({
  host: target.address, ...(target.servername ? { servername: target.servername } : {}), port: settings.imap.port, secure: settings.imap.security === "ssl", ...(settings.imap.security === "ssl" ? {} : { doSTARTTLS: true }),
  auth: { user: settings.username, pass: password }, logger: false as const, disableAutoIdle: true, connectionTimeout: MAIL_TIMEOUTS.connectionTimeout, greetingTimeout: MAIL_TIMEOUTS.greetingTimeout, socketTimeout: 60_000,
});

/** An IMAP client for the mailbox, connected to its checked address (the name resolved and refused when it isn't public). An abort closes it. */
export async function connectImap(settings: EmailSettings, password: string, signal?: AbortSignal): Promise<ImapFlow> {
  const target = await resolveMailServer(settings.imap, "IMAP", signal);
  if (signal?.aborted) throw Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" });
  const client = new ImapFlow(imapOptions(settings, password, target));
  // ImapFlow reports a dropped connection as an 'error' event too; the waiting command fails with it, which is where it is handled.
  client.on("error", () => undefined);
  const onAbort = () => client.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    return client;
  } catch (error) {
    client.close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Thrown by smtpSession: the error and the step it broke in. */
export class SmtpStepError extends Error {
  constructor(readonly phase: SmtpPhase, readonly error: unknown) { super(error instanceof Error ? error.message : "SMTP failed"); }
}

/**
 * One SMTP session: resolve and check the server, connect, sign in, and (with `message`) send it, then QUIT. An abort closes the connection.
 * Throws SmtpStepError naming the step that broke.
 */
export async function smtpSession(settings: EmailSettings, password: string, signal: AbortSignal, message?: { from: string; to: string; raw: Buffer }): Promise<{ response?: string }> {
  let target: MailTarget;
  try { target = await resolveMailServer(settings.smtp, "SMTP", signal); }
  catch (error) { throw new SmtpStepError("connect", error); }
  if (signal.aborted) throw new SmtpStepError("connect", Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }));
  const connection = new SMTPConnection(smtpOptions(settings.smtp, target));
  let phase: SmtpPhase = "connect";
  let done = false;
  let fail: ((error: unknown) => void) | undefined;
  const broken = new Promise<never>((_resolve, reject) => { fail = reject; });
  broken.catch(() => undefined);
  // The connection reports a broken socket or a timeout as an 'error' event (and an 'end'); both end whichever step is waiting.
  connection.on("error", (error) => { if (!done) fail?.(error); });
  connection.once("end", () => { if (!done) fail?.(Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" })); });
  const onAbort = () => { if (!done) fail?.(Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" })); connection.close(); };
  if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  const step = <T>(run: (callback: (error?: Error | null, value?: T) => void) => void) => Promise.race([new Promise<T>((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value as T)))), broken]);
  try {
    await step<void>((callback) => connection.connect((error) => callback(error ?? null)));
    phase = "login";
    await step<boolean>((callback) => connection.login({ user: settings.username, pass: password }, callback));
    if (!message) return {};
    phase = "send";
    const info = await step<{ response: string }>((callback) => connection.send({ from: message.from, to: [message.to] }, message.raw, callback));
    return { response: info.response };
  } catch (error) {
    throw new SmtpStepError(phase, error);
  } finally {
    done = true;
    signal.removeEventListener("abort", onAbort);
    try { connection.quit(); } catch { connection.close(); }
  }
}

/** The message as it goes out: from the person's name and address, plain text only (no tracking pixel, no rewritten links). */
export async function buildMessage(settings: Pick<EmailSettings, "address" | "senderName">, request: Pick<SendRequest, "to" | "toName" | "subject" | "body" | "inReplyTo" | "idempotencyKey">, now = new Date()): Promise<{ raw: Buffer; messageId: string; threadKey: string }> {
  const messageId = emailMessageId(settings.address, request.idempotencyKey);
  const replyTo = request.inReplyTo?.externalId;
  const references = [...new Set([request.inReplyTo?.threadKey, ...(request.inReplyTo?.references ?? []), replyTo].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const composer = new MailComposer({
    from: { name: settings.senderName, address: settings.address }, to: request.toName ? { name: request.toName, address: request.to } : request.to,
    subject: request.subject ?? "", text: request.body, messageId, date: now, ...(replyTo ? { inReplyTo: replyTo } : {}), ...(references.length ? { references } : {}),
    disableFileAccess: true, disableUrlAccess: true,
  });
  const raw = await composer.compile().build();
  return { raw, messageId, threadKey: request.inReplyTo?.threadKey ?? replyTo ?? messageId };
}

/**
 * Puts a copy of a sent message in the mailbox's Sent folder (\Seen), for providers that don't do it themselves. Best effort, in the
 * background, and never longer than a minute: past it the connection is closed.
 */
async function saveToSent(settings: EmailSettings, password: string, raw: Buffer): Promise<void> {
  const signal = AbortSignal.timeout(SAVE_TO_SENT_TIMEOUT_MS);
  const client = await connectImap(settings, password, signal);
  const onAbort = () => client.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const folders = await client.list();
    const sent = folders.find((folder) => folder.specialUse === "\\Sent") ?? folders.find((folder) => /^(sent|sent items|sent mail|inbox\.sent)$/i.test(folder.path));
    if (sent && !signal.aborted) await client.append(sent.path, raw, ["\\Seen"]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) client.close();
    else await client.logout().catch(() => client.close());
  }
}

async function imapCheck(settings: EmailSettings, password: string, signal: AbortSignal): Promise<{ ok: boolean; detail: string; auth?: boolean }> {
  let client: ImapFlow | undefined;
  const onAbort = () => client?.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    client = await connectImap(settings, password, signal);
    const status = await client.status("INBOX", { messages: true, uidNext: true });
    return { ok: true, detail: `Signed in; the inbox has ${typeof status === "object" && status ? Number(status.messages ?? 0) : 0} messages` };
  } catch (error) {
    const failure = imapFailure(signal.aborted && !(error instanceof MailServerRefused) ? Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" }) : error, settings);
    return { ok: false, detail: failure.message, auth: failure.auth };
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (client) await client.logout().catch(() => client?.close());
  }
}

async function smtpCheck(settings: EmailSettings, password: string, signal: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  try { await smtpSession(settings, password, signal); return { ok: true, detail: `Signed in to ${settings.smtp.host}` }; }
  catch (error) { return { ok: false, detail: smtpFailure(error instanceof SmtpStepError ? error.error : error, "login", settings).error }; }
}

export const emailProvider: ChannelProvider = {
  kind: "email",

  async test(account, secrets, signal): Promise<ChannelAccountTest> {
    const settings = settingsOf(account);
    if (!secrets.password) return { ok: false, message: "No password is saved for this mailbox: enter it again", checks: [{ name: "Password", ok: false, detail: "Not saved, or it can't be read any more" }] };
    // Both servers at once: the test answers within the route's time limit even when one of them is slow.
    const [smtp, imap] = await Promise.all([smtpCheck(settings, secrets.password, signal), imapCheck(settings, secrets.password, signal)]);
    // The inbox is only needed to file replies and keep a copy in Sent: a mailbox that does neither works without IMAP.
    const needsImap = settings.syncInbox !== false || settings.saveToSent === true;
    const ok = smtp.ok && (imap.ok || !needsImap);
    const message = ok ? (imap.ok ? `Connected: ${settings.address} can send, and replies in its inbox will be filed on the leads` : `Connected: ${settings.address} can send (the inbox could not be read: ${imap.detail})`) : (!smtp.ok ? smtp.detail : imap.detail);
    return { ok, message, checks: [{ name: "Sending (SMTP)", ok: smtp.ok, detail: smtp.detail }, { name: "Inbox (IMAP)", ok: imap.ok, detail: imap.detail }] };
  },

  async send(request, signal): Promise<SendOutcome> {
    const settings = settingsOf(request.account);
    const password = request.secrets.password;
    if (!password) return { state: "failed", error: "No password is saved for this mailbox: enter it again in Sales > Channels" };
    let built: Awaited<ReturnType<typeof buildMessage>>;
    try { built = await buildMessage(settings, request); }
    catch { return { state: "failed", error: "The message could not be put together: check the lead's email address" }; }
    try {
      await smtpSession(settings, password, signal, { from: settings.address, to: request.to, raw: built.raw });
    } catch (error) {
      return error instanceof SmtpStepError ? smtpFailure(error.error, error.phase, settings) : { state: "uncertain", error: "Something went wrong while the message was being sent: check your Sent folder, then say whether it went" };
    }
    // Gmail and Outlook keep a copy themselves; others need one appended to Sent. It runs after the answer, so it can't make a sent message look unclear.
    if (settings.saveToSent === true) void saveToSent(settings, password, built.raw).catch(() => console.warn(JSON.stringify({ level: "warn", event: "sales.email.save_to_sent_failed", accountId: String(request.account._id) })));
    return { state: "sent", externalId: built.messageId, threadKey: built.threadKey, from: settings.address, to: request.to };
  },
};
