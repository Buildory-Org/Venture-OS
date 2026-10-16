import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import { draftSchema } from "@venture-studio/contracts";
import { buildMessage, emailMessageId, emailProvider, imapFailure, imapOptions, passwordAdvice, resolveMailServer, smtpFailure, smtpOptions, useMailLookupForTests } from "../src/sales/channels/email/provider.js";
import { createMailSync, htmlToText, mailSyncEnabled, mailText, messageIds, ourMessageIds, parseMail, stripQuoted, type MailClient, type MailConnect } from "../src/sales/channels/email/sync.js";
import { useProviderForTests, type SendOutcome, type SendRequest } from "../src/sales/channels/provider.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Email through a person's mailbox (docs/sales-channels.md section 3; sales/channels/email/*): how SMTP failures read and whether a message
// may have gone out, the message as built (no network: nodemailer's composer only), quote stripping, and the inbox sync against a stand-in
// IMAP client that serves raw RFC 822 messages and has no way to change a mailbox. No real mail server is ever contacted.

const skip = !process.env.TEST_MONGODB_URI;
const PASSWORD = "imap-app-pass-31xx-hidden";
const smtp = { smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" as const } };
const err = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? "failed")), fields);

test("SMTP failures in plain words: refused before the message is nothing sent, a connection lost while it is on its way is unclear", () => {
  assert.deepEqual(smtpFailure(err({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }), "login", smtp), { state: "failed", error: "Gmail refused the password: use an app password (Google Account > Security > App passwords), not your normal Gmail password" });
  assert.match(smtpFailure(err({ code: "EAUTH" }), "login", { smtp: { host: "smtp.zoho.in", port: 465, security: "ssl" } }).error, /^Zoho refused the password: use an app-specific password/);
  assert.match(smtpFailure(err({ code: "EAUTH" }), "login", { smtp: { host: "smtp.office365.com", port: 587, security: "starttls" } }).error, /^Outlook refused the password/);
  assert.match(passwordAdvice("mail.hostinger.com"), /^The mailbox refused the username or password/);
  // Before the message: never uncertain.
  assert.deepEqual(smtpFailure(err({ code: "EDNS", originalCode: "ENOTFOUND" }), "connect", smtp), { state: "failed", error: "The SMTP server smtp.gmail.com could not be found on the internet: check the server name" });
  // Refused, filtered, reset or silent: one sentence, so a mail setting can't be used to tell open ports from closed ones.
  const unreachable = { state: "failed", error: "Couldn't reach the SMTP server smtp.gmail.com on port 465: check the server name, the port and the security setting" };
  assert.deepEqual(smtpFailure(err({ code: "ESOCKET", originalCode: "ECONNREFUSED" }), "connect", smtp), unreachable);
  assert.deepEqual(smtpFailure(err({ code: "ETIMEDOUT", timeoutType: "CONNECT_TIMEOUT" }), "connect", smtp), unreachable);
  assert.deepEqual(smtpFailure(err({ code: "ETIMEDOUT", timeoutType: "GREETING_TIMEOUT" }), "connect", smtp), unreachable);
  assert.deepEqual(smtpFailure(err({ code: "ECONNECTION", originalCode: "ECONNRESET" }), "connect", smtp), unreachable);
  // A server's greeting or any answer outside MAIL FROM / RCPT TO / DATA is never shown back.
  const banner = "554 db-7.internal.corp ESMTP Postfix (Ubuntu) secret-banner";
  for (const [fields, phase] of [[{ code: "EPROTOCOL", command: "CONN", response: banner, message: `Invalid greeting. response=${banner}` }, "connect"], [{ code: "EPROTOCOL", responseCode: 554, command: "EHLO", response: banner }, "login"], [{ code: "EPROTOCOL", responseCode: 530, command: "AUTH PLAIN", response: banner }, "login"], [{ code: "EPROTOCOL", responseCode: 554, command: "RSET", response: banner }, "send"]] as const) {
    const outcome = smtpFailure(err(fields), phase, smtp);
    assert.ok(!/secret-banner|internal\.corp|Postfix/.test(outcome.error), outcome.error);
  }
  assert.ok(!/\[object Object\]|internal\.corp/.test(imapFailure(err({ code: "EConnectionClosed", response: { tag: "*", command: "BYE", attributes: [{ type: "TEXT", value: "imap.internal.corp" }] }, responseText: "imap.internal.corp says bye" }), { imap: { host: "imap.example.com", port: 993, security: "ssl" } }).message));
  assert.match(smtpFailure(err({ code: "ETLS", message: "wrong version number" }), "connect", smtp).error, /secure connection .* failed: check the security setting \(SSL for port 465, STARTTLS for 587\)/);
  assert.equal(smtpFailure(err({ code: "ETIMEDOUT" }), "login", smtp).state, "failed");
  // The server refused the message (5xx or 4xx on MAIL FROM, RCPT TO or DATA): it didn't go out.
  assert.deepEqual(smtpFailure(err({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO", response: "550 5.1.1 User unknown" }), "send", smtp), { state: "failed", error: "The mail server refused the lead's address (550 5.1.1 User unknown): check that it is right" });
  assert.match(smtpFailure(err({ code: "EMESSAGE", responseCode: 554, command: "DATA", response: "554 5.7.1 Message rejected as spam" }), "send", smtp).error, /^The mail server refused the message \(554 5\.7\.1 Message rejected as spam\)$/);
  assert.match(smtpFailure(err({ code: "EENVELOPE", responseCode: 553, command: "MAIL FROM", response: "553 not owned" }), "send", smtp).error, /refused to send from your address/);
  assert.match(smtpFailure(err({ code: "EMESSAGE", responseCode: 451, command: "DATA", response: "451 try later" }), "send", smtp).error, /asked to try again later/);
  assert.equal(smtpFailure(err({ code: "EENVELOPE", message: "No recipients defined" }), "send", smtp).state, "failed");
  // The connection broke or timed out while the message was on its way: it may have gone out.
  for (const code of ["ETIMEDOUT", "ECONNECTION", "ESOCKET"]) {
    const outcome = smtpFailure(err({ code, command: "CONN" }), "send", smtp);
    assert.equal(outcome.state, "uncertain", code);
    assert.match(outcome.error, /check your Sent folder, then say whether it went/);
  }
  // IMAP: a refused password is the account's problem (it needs a person); the rest is the connection.
  assert.deepEqual(imapFailure(err({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }), { imap: { host: "imap.gmail.com", port: 993, security: "ssl" } }), { message: "Gmail refused the password: use an app password (Google Account > Security > App passwords), not your normal Gmail password", auth: true });
  assert.deepEqual(imapFailure(err({ code: "ENOTFOUND" }), { imap: { host: "imap.nowhere.example", port: 993, security: "ssl" } }), { message: "The IMAP server imap.nowhere.example could not be found on the internet: check the server name", auth: false });
});

test("the message as it goes out: the person's name and address, plain text, our Message-ID per draft and attempt, the reply's thread", async () => {
  const settings = { address: "member@Acme.Example", senderName: "Mem Ber" };
  const { raw, messageId, threadKey } = await buildMessage(settings, { to: "asha@sharmapumps.example", toName: "Asha", subject: "Re: Orders on the phone", body: "Here are the details.\nThanks, Mem", idempotencyKey: "draft-abc-2", inReplyTo: { externalId: "<r1@sharmapumps.example>", threadKey: "<draft-abc-1@acme.example>" } });
  assert.equal(messageId, "<draft-abc-2@acme.example>");
  assert.equal(emailMessageId("member@acme.example", "draft-abc-2"), messageId);
  assert.equal(threadKey, "<draft-abc-1@acme.example>");
  const parsed = await simpleParser(raw);
  assert.deepEqual([parsed.messageId, parsed.inReplyTo, parsed.references, parsed.subject], ["<draft-abc-2@acme.example>", "<r1@sharmapumps.example>", ["<draft-abc-1@acme.example>", "<r1@sharmapumps.example>"], "Re: Orders on the phone"]);
  assert.deepEqual([parsed.from?.value[0]?.name, parsed.from?.value[0]?.address, (parsed.to as any).value[0].address], ["Mem Ber", "member@acme.example", "asha@sharmapumps.example"]);
  assert.equal(parsed.text?.trim(), "Here are the details.\nThanks, Mem");
  assert.equal(parsed.html, false, "plain text only: no HTML part, no tracking pixel");
  assert.ok(!/text\/html|<img/i.test(raw.toString("utf8")));
  // A first message starts its own thread.
  const first = await buildMessage(settings, { to: "asha@sharmapumps.example", subject: "Orders", body: "Hello", idempotencyKey: "draft-abc-1" });
  assert.equal(first.threadKey, "<draft-abc-1@acme.example>");
  assert.ok(!/In-Reply-To|References/i.test(first.raw.toString("utf8")));
  // Without a readable password nothing is attempted (and nothing reaches the network).
  const account = { _id: "acc-1", kind: "email", settings: { ...settings, username: "member", smtp: smtp.smtp, imap: { host: "imap.gmail.com", port: 993, security: "ssl" } } };
  assert.deepEqual(await emailProvider.send!({ account, secrets: {}, to: "asha@sharmapumps.example", body: "Hi", idempotencyKey: "draft-abc-3" }, AbortSignal.timeout(1_000)), { state: "failed", error: "No password is saved for this mailbox: enter it again in Sales > Channels" });
  assert.equal((await emailProvider.test(account, {}, AbortSignal.timeout(1_000))).ok, false);
});

test("quoted text, Message-IDs, and when the sync runs", () => {
  assert.equal(stripQuoted("Yes, interested.\nCall me tomorrow.\n\nOn Mon, 12 Oct 2026 at 10:02, Mem Ber <member@acme.example> wrote:\n> Hello Asha,\n> a short note"), "Yes, interested.\nCall me tomorrow.");
  assert.equal(stripQuoted("Sure.\r\n\r\nOn Mon, Oct 12, 2026 at 10:02 AM Mem Ber <\r\nmember@acme.example> wrote:\r\n> Hello"), "Sure.");
  assert.equal(stripQuoted("Thanks!\n\n-----Original Message-----\nFrom: Mem Ber\nSent: Monday\nHello"), "Thanks!");
  assert.equal(stripQuoted("Noted.\n\nFrom: Mem Ber <member@acme.example>\nSent: 12 October 2026 10:02\nTo: Asha\nSubject: Orders\n\nHello"), "Noted.");
  assert.equal(stripQuoted("Top line\n> quoted\nBottom line"), "Top line\nBottom line");
  assert.equal(stripQuoted("On second thought, call me.\nThanks"), "On second thought, call me.\nThanks");
  assert.deepEqual(messageIds("<a@b> <c@d>"), ["<a@b>", "<c@d>"]);
  assert.deepEqual(messageIds(["<a@b>", "junk"]), ["<a@b>"]);
  assert.deepEqual(ourMessageIds("x <draft-1f2e-aa-3@acme.example> y <draft-1f2e-aa-3@acme.example> <other@x>"), [{ id: "<draft-1f2e-aa-3@acme.example>", draftId: "1f2e-aa" }]);
  assert.equal(mailSyncEnabled({ SALES_MAIL_SYNC: "on", NODE_ENV: "test" }), false);
  assert.equal(mailSyncEnabled({ SALES_MAIL_SYNC: "off", NODE_ENV: "development" }), false);
  assert.equal(mailSyncEnabled({ SALES_MAIL_SYNC: "on", NODE_ENV: "development" }), true);
});

test("mail servers: the name is resolved first, private and reserved addresses and other ports are refused, the connection goes to the checked address with the name kept for TLS", async () => {
  const lookups: string[] = [];
  const answer = (address: string) => async (host: string) => { lookups.push(host); return [{ address, family: address.includes(":") ? 6 : 4 }]; };
  const notFound = (what: string, host: string) => `The ${what} server ${host} could not be found on the internet: check the server name`;
  const server = { host: "smtp.example.com", port: 465 };
  // Loopback, the cloud metadata address, private, CGNAT, unique-local, IPv4 inside IPv6, unspecified: refused, in the same words as a name
  // that doesn't resolve (the answer says nothing about the network behind the API).
  for (const address of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "172.16.4.4", "192.168.1.5", "100.64.0.9", "::1", "fd00::5", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    await assert.rejects(resolveMailServer(server, "SMTP", undefined, answer(address)), (error: Error) => error.message === notFound("SMTP", "smtp.example.com"), address);
  }
  await assert.rejects(resolveMailServer(server, "SMTP", undefined, async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); }), (error: Error) => error.message === notFound("SMTP", "smtp.example.com"));
  // Local names never reach the resolver.
  const before = lookups.length;
  await assert.rejects(resolveMailServer({ host: "mail.internal", port: 465 }, "SMTP", undefined, answer("93.184.216.34")), (error: Error) => error.message === notFound("SMTP", "mail.internal"));
  assert.equal(lookups.length, before);
  // Only the standard mail ports (an account saved before the rule is refused when it connects).
  await assert.rejects(resolveMailServer({ host: "smtp.example.com", port: 6379 }, "SMTP", undefined, answer("93.184.216.34")), /^Error: The SMTP server uses port 6379: mail goes through port 25, 465, 587, 2525 only$/);
  await assert.rejects(resolveMailServer({ host: "imap.example.com", port: 465 }, "IMAP", undefined, answer("93.184.216.34")), /port 143, 993 only/);
  // A lookup that never answers gives up with the request.
  await assert.rejects(resolveMailServer(server, "SMTP", AbortSignal.timeout(50), () => new Promise(() => undefined)), /Couldn't reach the SMTP server smtp\.example\.com on port 465/);

  // A public server: the connection goes to the checked address, and the certificate is checked against the server's name.
  const target = await resolveMailServer({ host: "SMTP.Example.com.", port: 587 }, "SMTP", undefined, answer("93.184.216.34"));
  assert.deepEqual(target, { address: "93.184.216.34", servername: "smtp.example.com" });
  const sending = smtpOptions({ host: "smtp.example.com", port: 587, security: "starttls" }, target);
  assert.deepEqual([sending.host, sending.servername, sending.port, sending.secure, sending.requireTLS, sending.ignoreTLS], ["93.184.216.34", "smtp.example.com", 587, false, true, false]);
  assert.deepEqual([smtpOptions({ host: "smtp.example.com", port: 465, security: "ssl" }, target).secure, smtpOptions({ host: "smtp.example.com", port: 25, security: "plain" }, target).requireTLS], [true, true], "an old clear-text setting still gets STARTTLS, required");
  const settings = { address: "member@example.com", senderName: "Mem", username: "member@example.com", smtp: { host: "smtp.example.com", port: 465, security: "ssl" as const }, imap: { host: "imap.example.com", port: 993, security: "ssl" as const } };
  const reading = imapOptions(settings, PASSWORD, { address: "93.184.216.35", servername: "imap.example.com" });
  assert.deepEqual([reading.host, reading.servername, reading.port, reading.secure, "doSTARTTLS" in reading], ["93.184.216.35", "imap.example.com", 993, true, false]);
  assert.equal((imapOptions({ ...settings, imap: { host: "imap.example.com", port: 143, security: "starttls" } }, PASSWORD, target) as { doSTARTTLS?: boolean }).doSTARTTLS, true);

  // Through the provider: every name answers the metadata address, so a test and a send stop before any connection is made.
  const restore = useMailLookupForTests(answer("169.254.169.254"));
  try {
    const account = { _id: "acc-ssrf", kind: "email", settings };
    const tested = await emailProvider.test(account, { password: PASSWORD }, AbortSignal.timeout(5_000));
    assert.equal(tested.ok, false);
    assert.deepEqual(tested.checks.map((check) => check.detail), [notFound("SMTP", "smtp.example.com"), notFound("IMAP", "imap.example.com")]);
    const sent = await emailProvider.send!({ account, secrets: { password: PASSWORD }, to: "asha@sharmapumps.example", body: "Hi", idempotencyKey: "draft-ssrf-1" }, AbortSignal.timeout(5_000));
    assert.deepEqual(sent, { state: "failed", error: notFound("SMTP", "smtp.example.com") });
    assert.ok(lookups.includes("smtp.example.com") && lookups.includes("imap.example.com"));
  } finally { restore(); }
});

test("HTML-only mail is read with a bounded tag strip: a 1 MB nested body takes milliseconds, not the event loop", async () => {
  const nested = `<p>Thanks, interested.&nbsp;Call me &amp; my partner.</p><blockquote>On Monday you wrote: <div>old text</div></blockquote>${"<div>".repeat(100_000)}deep${"</div>".repeat(100_000)}`;
  assert.ok(nested.length > 1_000_000);
  const raw = Buffer.from(["From: Asha <asha@sharmapumps.example>", "To: member@acme.example", "Subject: Re: Orders", "Message-ID: <html-1@sharmapumps.example>", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", nested, ""].join("\r\n"));
  const started = performance.now();
  const mail = await parseMail(raw);
  const text = mailText(mail);
  const took = performance.now() - started;
  assert.ok(took < 1_000, `took ${Math.round(took)} ms`);
  assert.match(text, /^Thanks, interested\. Call me & my partner\./);
  assert.ok(!text.includes("old text"), "a quoted block is not the reply");
  // The strip itself: block elements break lines, scripts and styles go, entities decode, an unclosed tag ends the text.
  assert.equal(htmlToText("<html><head><title>x</title><style>p{}</style></head><body><script>if (a<b) alert(1)</script>Hello<br>there &#8212; &#x41;&lt;3<p>Bye</p><img src=x"), "Hello\nthere — A<3\nBye");
  assert.equal(htmlToText("<<<<".repeat(30_000)), "");
  assert.equal(htmlToText(`${"<blockquote>".repeat(3)}quoted${"</blockquote>".repeat(3)}after`), "after");
});

// ---- The inbox sync ------------------------------------------------------------------------------------------------------------------

type Box = { uidValidity: string; uidNext: number; messages: Map<number, Buffer> };
/** A stand-in IMAP server per account: only connect, a read-only open, fetch and logout exist, so the sync can't change anything. */
function standInImap(boxes: Map<string, Box>) {
  const calls: string[] = [];
  const refuse = new Set<string>();
  /** Mailboxes whose server never answers a fetch (a slow or hostile server). */
  const hang = new Set<string>();
  const connect: MailConnect = (account, password) => {
    const id = String(account._id);
    calls.push(`connect ${id} ${password === PASSWORD ? "right-password" : "wrong-password"}`);
    const client: MailClient = {
      async connect() { if (refuse.has(id)) throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }); },
      async mailboxOpen(path, options) { calls.push(`open ${id} ${path} ${JSON.stringify(options)}`); const box = boxes.get(id)!; return { uidValidity: BigInt(box.uidValidity), uidNext: box.uidNext }; },
      async *fetch(range, query, options) {
        calls.push(`fetch ${id} ${range} ${JSON.stringify(query)} ${JSON.stringify(options)}`);
        if (hang.has(id)) await new Promise(() => undefined);
        const [from, to] = range.split(":").map(Number) as [number, number];
        for (const [uid, source] of [...boxes.get(id)!.messages].sort((a, b) => a[0] - b[0])) if (uid >= from && uid <= to) yield { uid, source };
      },
      async logout() { calls.push(`logout ${id}`); },
      close() { calls.push(`close ${id}`); },
    };
    return client;
  };
  return { connect, calls, refuse, hang };
}
const deliver = (box: Box, raw: string) => { box.messages.set(box.uidNext, Buffer.from(raw.replace(/\r?\n/g, "\r\n"))); box.uidNext++; };
const mail = (headers: Record<string, string>, body: string) => `${Object.entries({ Date: new Date(Date.now() - 60_000).toUTCString(), "MIME-Version": "1.0", "Content-Type": "text/plain; charset=utf-8", ...headers }).map(([name, value]) => `${name}: ${value}`).join("\n")}\n\n${body}\n`;

test("the inbox sync files replies from leads (by thread or exact address), skips the rest, marks bounces, never repeats and starts over on a new UIDVALIDITY", { skip }, async () => {
  const sends: SendRequest[] = [];
  const restore = useProviderForTests({ kind: "email", test: async () => ({ ok: true, message: "Connected", checks: [] }), send: async (request) => { sends.push(request); return { state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to }; } });
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => { const response = await api(method, path, handle, body); const text = await response.text(); return { status: response.status, body: JSON.parse(text || "null"), text }; };
      const ok = async (status: number, method: string, path: string, handle: string, body?: unknown) => { const reply = await call(method, path, handle, body); assert.equal(reply.status, status, `${method} ${path}: ${reply.text}`); return reply.body.data; };
      const settings = (address: string) => ({ address, senderName: "Mem Ber", username: address, smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" }, imap: { host: "imap.gmail.com", port: 993, security: "ssl" } });
      const box = await ok(201, "POST", "/sales/channels", "member", { kind: "email", label: "Work mail", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: settings("member@acme.example"), secrets: { password: PASSWORD } });
      const other = await ok(201, "POST", "/sales/channels", "member2", { kind: "email", label: "Member2 mail", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: settings("member2@acme.example"), secrets: { password: PASSWORD } });
      const quiet = await ok(201, "POST", "/sales/channels", "lead", { kind: "email", label: "No sync", ventureIds: ["venture-a"], settings: { ...settings("lead@acme.example"), syncInbox: false }, secrets: { password: PASSWORD } });
      const newLead = async (name: string, email: string) => ok(201, "POST", "/sales/leads", "member", { pipelineId: "pipeline-a", companyName: name, ownerId: "user-member", contactRoutes: [{ kind: "email", value: email }] });
      const sendDraft = async (leadId: string, requestId: string) => {
        const draft = await ok(201, "POST", `/sales/leads/${leadId}/drafts`, "member", { channel: "email", subject: "Orders on the phone", body: "Hello, a short note about dealer orders." });
        await ok(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" });
        return (await ok(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId })).draft;
      };
      const sharma = await newLead("Sharma Pumps", "asha@sharmapumps.example");
      const verma = await newLead("Verma Tiles", "sales@vermatiles.example");
      const gupta = await newLead("Gupta Steel", "Ravi@GuptaSteel.example");
      await newLead("Shared One", "info@shared.example");
      await newLead("Shared Two", "info@shared.example");
      const sharmaDraft = await sendDraft(sharma.id, "req-sync-0001");
      const vermaDraft = await sendDraft(verma.id, "req-sync-0002");
      const ourId = `<draft-${sharmaDraft.id}-1@acme.example>`;
      const vermaId = `<draft-${vermaDraft.id}-1@acme.example>`;
      assert.ok((await db.collection("opportunities").findOne({ _id: sharma.id }))!.followUpDueAt, "the first touch set a follow-up date");
      // A follow-up already drafted for Sharma: a reply stops it.
      const followUp = await ok(201, "POST", `/sales/leads/${sharma.id}/drafts`, "member", { channel: "email", purpose: "follow_up", subject: "Following up", body: "Just checking in." });

      const boxes = new Map<string, Box>([[box.id, { uidValidity: "7", uidNext: 101, messages: new Map() }], [other.id, { uidValidity: "3", uidNext: 50, messages: new Map() }], [quiet.id, { uidValidity: "1", uidNext: 1, messages: new Map() }]]);
      const imap = standInImap(boxes);
      const logs: Record<string, unknown>[] = [];
      const sync = createMailSync({ database, env: config, connect: imap.connect, workerId: "test-worker", log: (line) => logs.push(line) });

      // First round: only mail from now on (the cursor starts at UIDNEXT); the mailbox that doesn't read its inbox is never opened.
      const first = await sync.syncOnce();
      assert.deepEqual(first.map((round) => [round.accountId, round.status]).sort(), [[box.id, "started"], [other.id, "started"]].sort());
      const started = (await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!;
      assert.deepEqual([started.mailSync.uidValidity, started.mailSync.lastUid, started.mailSync.leaseUntil, started.mailSync.leaseBy], ["7", 100, undefined, undefined]);
      assert.ok(started.lastSyncAt);
      assert.ok(imap.calls.includes(`open ${box.id} INBOX {"readOnly":true}`));
      assert.ok(!imap.calls.some((line) => line.includes(quiet.id)));
      assert.ok(imap.calls.every((line) => !line.startsWith("fetch")));

      const mine = boxes.get(box.id)!;
      deliver(mine, mail({ From: "Asha <asha@sharmapumps.example>", To: "Mem Ber <member@acme.example>", Subject: "Re: Orders on the phone", "Message-ID": "<r1@sharmapumps.example>", "In-Reply-To": ourId, References: ourId },
        `Yes, interested. Call me tomorrow.\n\nOn Mon, 12 Oct 2026 at 10:02, Mem Ber <member@acme.example> wrote:\n> Hello, a short note about dealer orders.`));
      deliver(mine, mail({ From: "Someone <someone@else.example>", To: "member@acme.example", Subject: "Lunch?", "Message-ID": "<private-1@else.example>" }, "Personal mail that is nobody's business."));
      deliver(mine, mail({ From: "Asha <asha@sharmapumps.example>", To: "member@acme.example", Subject: "Out of office", "Message-ID": "<ooo-1@sharmapumps.example>", "Auto-Submitted": "auto-replied", "In-Reply-To": ourId }, "I am away until Monday."));
      deliver(mine, [
        "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "To: member@acme.example", "Subject: Delivery Status Notification (Failure)", "Message-ID: <bounce-1@mx.google.com>", `Date: ${new Date().toUTCString()}`, "Auto-Submitted: auto-replied",
        "MIME-Version: 1.0", 'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "", "Address not found: your message wasn't delivered.", "",
        "--b1", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; googlemail.com", "", "Final-Recipient: rfc822; sales@vermatiles.example", "Action: failed", "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.", "", "--b1", "Content-Type: text/rfc822-headers", "", "From: Mem Ber <member@acme.example>", "To: sales@vermatiles.example",
        "Subject: Orders on the phone", `Message-ID: ${vermaId}`, "", "--b1--", "",
      ].join("\n"));
      deliver(mine, mail({ From: "Ravi <RAVI@guptasteel.EXAMPLE>", To: "member@acme.example", Subject: "Your products", "Message-ID": "<g1@guptasteel.example>" }, "Saw your site. Do you do dealer apps?\n\n-- \nRavi"));
      deliver(mine, mail({ From: "info@shared.example", To: "member@acme.example", Subject: "Hello", "Message-ID": "<s1@shared.example>" }, "Which of us is this for?"));
      deliver(mine, mail({ From: "Mem Ber <member@acme.example>", To: "member@acme.example", Subject: "Note to self", "Message-ID": "<self-1@acme.example>" }, "Remember the samples."));
      deliver(mine, mail({ From: "News <news@sharmapumps.example>", To: "member@acme.example", Subject: "Our newsletter", "Message-ID": "<n1@sharmapumps.example>", "List-Id": "<news.sharmapumps.example>", Precedence: "bulk" }, "Offers this week."));

      const second = (await sync.syncOnce()).find((round) => round.accountId === box.id)!;
      assert.deepEqual({ ...second, error: undefined }, { accountId: box.id, status: "read", read: 8, filed: 2, bounced: 1, skipped: 5, error: undefined });
      assert.ok(imap.calls.includes(`fetch ${box.id} 101:108 {"uid":true,"source":{"maxLength":524288}} {"uid":true}`));
      assert.equal((await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!.mailSync.lastUid, 108);

      // The reply: filed on Sharma as the mailbox owner, via system, without the quoted thread, with the message details; the rules ran.
      const inbound = await db.collection("sales_activities").find({ direction: "in" }).sort({ at: 1 }).toArray();
      assert.deepEqual(inbound.map((row) => row.leadId).sort(), [sharma.id, gupta.id].sort());
      const reply = inbound.find((row) => row.leadId === sharma.id)!;
      assert.deepEqual([reply.kind, reply.via, reply.actorId, reply.body, reply.handledAt], ["email", "system", "user-member", "Yes, interested. Call me tomorrow.", undefined]);
      assert.deepEqual(reply.message, { accountId: box.id, externalId: "<r1@sharmapumps.example>", threadKey: ourId, subject: "Re: Orders on the phone", from: "asha@sharmapumps.example", to: "member@acme.example" });
      const sharmaNow = (await db.collection("opportunities").findOne({ _id: sharma.id }))!;
      assert.deepEqual([sharmaNow.stage, sharmaNow.followUpDueAt], ["replied", undefined]);
      assert.equal((await db.collection("sales_drafts").findOne({ _id: followUp.id }))!.status, "discarded", "the follow-up stops");
      // The lead's owner is told, although the reply was filed as them (it arrived in the background).
      assert.equal(await db.collection("notification_outbox").countDocuments({ userId: "user-member", type: "sales_reply", resourceId: sharma.id }), 1);
      const inbox = (await ok(200, "GET", "/sales/inbox?handled=false", "member")) as any[];
      assert.deepEqual(inbox.map((item) => item.lead.companyName).sort(), ["Gupta Steel", "Sharma Pumps"]);
      // Matched by the sender's exact address, any case.
      assert.equal(inbound.find((row) => row.leadId === gupta.id)!.message.externalId, "<g1@guptasteel.example>");
      // Not from one lead (a stranger, two leads, our own address), automatic, or a list: nothing stored anywhere.
      assert.equal(await db.collection("sales_activities").countDocuments({ "message.externalId": { $in: ["<private-1@else.example>", "<s1@shared.example>", "<self-1@acme.example>", "<ooo-1@sharmapumps.example>", "<n1@sharmapumps.example>"] } }), 0);
      assert.ok(!JSON.stringify(await db.collection("sales_activities").find({}).toArray()).includes("nobody's business"));
      // The bounce: Verma's message and draft read bounced, with the server's reason; nothing else about Verma changed.
      const bounced = (await db.collection("sales_activities").findOne({ "message.externalId": vermaId }))!;
      assert.equal(bounced.message.delivery.state, "bounced");
      assert.match(bounced.message.delivery.error, /^The email bounced: 550 5\.1\.1 The email account that you tried to reach does not exist\./);
      assert.equal((await db.collection("sales_drafts").findOne({ _id: vermaDraft.id }))!.delivery.state, "bounced");
      assert.equal((await db.collection("opportunities").findOne({ _id: verma.id }))!.stage, "contacted");
      // The audit names the channel only; no address or body in any audit row.
      const filed = await db.collection("audit_events").find({ action: "sales.email.reply_filed" }).toArray();
      assert.deepEqual(filed.map((event) => [event.actorId, event.channel, event.metadata]), [["user-member", "worker", { channel: "email" }], ["user-member", "worker", { channel: "email" }]]);
      const audits = JSON.stringify(await db.collection("audit_events").find({}).toArray());
      for (const text of ["asha@sharmapumps.example", "guptasteel", "Call me tomorrow", PASSWORD.slice(0, -4)]) assert.ok(!audits.toLowerCase().includes(text.toLowerCase()), text);
      assert.ok(!JSON.stringify(logs).includes("sharmapumps") && !JSON.stringify(logs).includes(PASSWORD.slice(0, -4)));

      // Again: nothing new is read. A cursor set back (a crash before it moved) reads them again, and the duplicate guard files nothing twice.
      assert.equal((await sync.syncOnce()).find((round) => round.accountId === box.id)!.read, 0);
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "mailSync.lastUid": 100 } });
      const reread = (await sync.syncOnce()).find((round) => round.accountId === box.id)!;
      assert.deepEqual([reread.read, reread.filed], [8, 0]);
      assert.equal(await db.collection("sales_activities").countDocuments({ direction: "in" }), 2);

      // A lease held by another worker is respected; an expired one is taken over.
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "mailSync.leaseUntil": new Date(Date.now() + 60_000), "mailSync.leaseBy": "another-worker" } });
      assert.equal(await sync.syncAccount(box.id), null);
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "mailSync.leaseUntil": new Date(Date.now() - 1_000) } });
      assert.equal((await sync.syncAccount(box.id))?.status, "read");

      // The server renumbered the inbox (a new UIDVALIDITY): start over at its UIDNEXT, nothing old is filed again.
      boxes.set(box.id, { uidValidity: "8", uidNext: 20, messages: new Map([[5, Buffer.from(mail({ From: "asha@sharmapumps.example", To: "member@acme.example", Subject: "Old", "Message-ID": "<old-1@sharmapumps.example>" }, "An old message"))]]) });
      const renumbered = (await sync.syncOnce()).find((round) => round.accountId === box.id)!;
      assert.equal(renumbered.status, "started");
      const cursor = (await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!.mailSync;
      assert.deepEqual([cursor.uidValidity, cursor.lastUid], ["8", 19]);
      assert.equal(await db.collection("sales_activities").countDocuments({ "message.externalId": "<old-1@sharmapumps.example>" }), 0);

      // A refused password: the account needs attention and isn't read again (no repeated wrong logins) until a test passes; the other
      // mailbox goes on.
      imap.refuse.add(other.id);
      deliver(boxes.get(box.id)!, mail({ From: "asha@sharmapumps.example", To: "member@acme.example", Subject: "Re: Orders", "Message-ID": "<r2@sharmapumps.example>", "In-Reply-To": "<r1@sharmapumps.example>", References: `${ourId} <r1@sharmapumps.example>` }, "And one more thing."));
      const rounds = await sync.syncOnce();
      assert.deepEqual(rounds.map((round) => [round.accountId, round.status, round.filed]).sort(), [[box.id, "read", 1], [other.id, "failed", 0]].sort());
      const refused = (await db.collection("sales_channel_accounts").findOne({ _id: other.id }))!;
      assert.deepEqual([refused.status, refused.lastError, refused.statusNote, Boolean(refused.mailSync.authFailedAt)], ["needs_attention", "Gmail refused the password: use an app password (Google Account > Security > App passwords), not your normal Gmail password", refused.lastError, true]);
      assert.equal((await db.collection("sales_activities").findOne({ "message.externalId": "<r2@sharmapumps.example>" }))!.message.threadKey, ourId, "the thread's first message is its key");
      const connects = imap.calls.filter((line) => line.startsWith(`connect ${other.id}`)).length;
      await sync.syncOnce();
      assert.equal(imap.calls.filter((line) => line.startsWith(`connect ${other.id}`)).length, connects, "not tried again with the refused password");
      imap.refuse.delete(other.id);
      assert.equal((await ok(200, "POST", `/sales/channels/${other.id}/test`, "member2")).ok, true);
      await sync.syncOnce();
      assert.equal(imap.calls.filter((line) => line.startsWith(`connect ${other.id}`)).length, connects + 1, "a passing test lets it be read again");
      // The sync only ever opened INBOX read-only.
      assert.ok(imap.calls.filter((line) => line.startsWith("open ")).every((line) => line.endsWith(' INBOX {"readOnly":true}')));
      assert.equal(sends.length, 2);
    }, "email_sync");
  } finally { restore(); }
});

test("the sync files thread replies only from the lead's own side, ignores delay notices, settles an unclear send a bounce proves, and stops a hanging mailbox at its deadline", { skip }, async () => {
  let answer: (request: SendRequest) => SendOutcome = (request) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to });
  const restore = useProviderForTests({ kind: "email", test: async () => ({ ok: true, message: "Connected", checks: [] }), send: async (request) => answer(request) });
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const ok = async (status: number, method: string, path: string, handle: string, body?: unknown) => { const response = await api(method, path, handle, body); const text = await response.text(); assert.equal(response.status, status, `${method} ${path}: ${text}`); return JSON.parse(text).data; };
      const settings = (address: string) => ({ address, senderName: "Mem Ber", username: address, smtp: { host: "smtp.example.com", port: 465, security: "ssl" }, imap: { host: "imap.example.com", port: 993, security: "ssl" } });
      const box = await ok(201, "POST", "/sales/channels", "member", { kind: "email", label: "Work mail", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: settings("member@acme.example"), secrets: { password: PASSWORD } });
      const other = await ok(201, "POST", "/sales/channels", "member2", { kind: "email", label: "Member2 mail", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: settings("member2@acme.example"), secrets: { password: PASSWORD } });
      const newLead = async (name: string, email: string) => ok(201, "POST", "/sales/leads", "member", { pipelineId: "pipeline-a", companyName: name, ownerId: "user-member", contactRoutes: [{ kind: "email", value: email }] });
      const send = async (leadId: string, requestId: string, status = 201) => {
        const draft = await ok(201, "POST", `/sales/leads/${leadId}/drafts`, "member", { channel: "email", subject: "Orders on the phone", body: "Hello, a short note about dealer orders." });
        await ok(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" });
        return (await ok(status, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId })).draft;
      };
      const sharma = await newLead("Sharma Pumps", "asha@sharmapumps.example");
      const verma = await newLead("Verma Tiles", "sales@vermatiles.example");
      const patel = await newLead("Patel Agro", "orders@patelagro.example");
      const gupta = await newLead("Gupta Steel", "ravi@guptasteel.example");
      const sharmaId = `<draft-${(await send(sharma.id, "req-side-0001")).id}-1@acme.example>`;
      const vermaDraft = await send(verma.id, "req-side-0002");
      const vermaId = `<draft-${vermaDraft.id}-1@acme.example>`;
      const patelDraft = await send(patel.id, "req-side-0003");
      const patelId = `<draft-${patelDraft.id}-1@acme.example>`;
      // Gupta's send is unclear: the draft stays locked, waiting for a person (or, below, a bounce that proves it went out).
      answer = () => ({ state: "uncertain", error: "The mail server stopped answering while the message was being sent" });
      const guptaDraft = await send(gupta.id, "req-side-0004", 202);
      const guptaId = `<draft-${guptaDraft.id}-1@acme.example>`;
      assert.deepEqual([guptaDraft.delivery.state, guptaDraft.sendLock.externalId], ["uncertain", guptaId]);
      const counted = Number((await db.collection("sales_send_counters").findOne({ userId: "user-member", channel: "email" }))!.count);
      assert.equal(counted, 4);

      const boxes = new Map<string, Box>([[box.id, { uidValidity: "7", uidNext: 101, messages: new Map() }], [other.id, { uidValidity: "3", uidNext: 50, messages: new Map() }]]);
      const imap = standInImap(boxes);
      const sync = createMailSync({ database, env: config, connect: imap.connect, workerId: "test-worker", log: () => undefined });
      assert.deepEqual((await sync.syncOnce()).map((round) => round.status), ["started", "started"]);

      const mine = boxes.get(box.id)!;
      const thread = { "In-Reply-To": sharmaId, References: sharmaId };
      // Our thread, but not the lead's side: a colleague's forward (their login address), another connected mailbox, someone at our own
      // company domain, a stranger. None is filed.
      deliver(mine, mail({ From: "Mem Two <member2@example.invalid>", To: "member@acme.example", Subject: "Fwd: Orders on the phone", "Message-ID": "<fwd-1@example.invalid>", References: sharmaId }, "FYI, see below."));
      deliver(mine, mail({ From: "member2@acme.example", To: "member@acme.example", Subject: "Re: Orders on the phone", "Message-ID": "<team-1@acme.example>", ...thread }, "Shall I call them?"));
      deliver(mine, mail({ From: "Office <office@acme.example>", To: "member@acme.example", Subject: "Re: Orders on the phone", "Message-ID": "<office-1@acme.example>", ...thread }, "Filed."));
      deliver(mine, mail({ From: "stranger@else.example", To: "member@acme.example", Subject: "Re: Orders on the phone", "Message-ID": "<stranger-1@else.example>", ...thread }, "Who is this?"));
      // The lead's side: a colleague of Asha's at the lead's own domain answers in the thread.
      deliver(mine, mail({ From: "Ravi <ravi@sharmapumps.example>", To: "member@acme.example", Subject: "Re: Orders on the phone", "Message-ID": "<ravi-1@sharmapumps.example>", ...thread }, "I handle orders here: call me."));
      // A delay notice (a delivery status that says delayed) and a classic "will retry" notice: nothing is bounced.
      const dsn = (id: string, action: string, status: string) => [
        "From: Mail Delivery Subsystem <mailer-daemon@mx.example.net>", "To: member@acme.example", `Subject: Delivery Status Notification (${action})`, `Message-ID: <dsn-${action}-${id.slice(7, 15)}@mx.example.net>`, `Date: ${new Date().toUTCString()}`, "Auto-Submitted: auto-replied",
        "MIME-Version: 1.0", "Content-Type: multipart/report; report-type=delivery-status; boundary=\"b1\"", "", "--b1", "Content-Type: text/plain; charset=utf-8", "", `Your message: ${action}.`, "",
        "--b1", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; mx.example.net", "", "Final-Recipient: rfc822; someone@example.org", `Action: ${action}`, `Status: ${status}`, "",
        "--b1", "Content-Type: text/rfc822-headers", "", "From: Mem Ber <member@acme.example>", "Subject: Orders on the phone", `Message-ID: ${id}`, "", "--b1--", "",
      ].join("\n");
      deliver(mine, dsn(vermaId, "delayed", "4.4.7"));
      deliver(mine, mail({ From: "MAILER-DAEMON@mx.example.net", To: "member@acme.example", Subject: "Warning: message delayed", "Message-ID": "<delay-2@mx.example.net>" }, `Delivery to sales@vermatiles.example has been delayed (4.4.1 connection timed out). The server will retry for 4 more days.\n\nMessage-ID: ${vermaId}`));
      // A classic bounce with permanent wording (no status part): bounced.
      deliver(mine, mail({ From: "MAILER-DAEMON@mx.example.net", To: "member@acme.example", Subject: "Undelivered Mail Returned to Sender", "Message-ID": "<bounce-2@mx.example.net>" }, `This is a permanent error. I could not deliver to orders@patelagro.example.\n\nMessage-ID: ${patelId}`));
      // A failed delivery status for the unclear send: it went out after all, and bounced.
      deliver(mine, dsn(guptaId, "failed", "5.1.1"));
      // An HTML-only reply from the lead's exact address, with a 1 MB nested body.
      deliver(mine, ["From: Asha <asha@sharmapumps.example>", "To: member@acme.example", "Subject: Re: Orders", "Message-ID: <html-1@sharmapumps.example>", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "",
        `<p>Thanks, interested.&nbsp;Call me &amp; my partner.</p><blockquote>quoted</blockquote>${"<div>".repeat(110_000)}x${"</div>".repeat(110_000)}`, ""].join("\n"));

      const started = performance.now();
      const round = (await sync.syncOnce()).find((row) => row.accountId === box.id)!;
      assert.ok(performance.now() - started < 10_000);
      assert.deepEqual({ ...round, error: undefined }, { accountId: box.id, status: "read", read: 10, filed: 2, bounced: 2, skipped: 6, error: undefined });
      const inbound = await db.collection("sales_activities").find({ direction: "in" }).sort({ at: 1 }).toArray();
      assert.deepEqual(inbound.map((row) => [row.leadId, row.message.externalId]).sort(), [[sharma.id, "<html-1@sharmapumps.example>"], [sharma.id, "<ravi-1@sharmapumps.example>"]]);
      assert.equal(inbound.find((row) => row.message.externalId === "<html-1@sharmapumps.example>")!.body, "Thanks, interested. Call me & my partner.");
      assert.equal(inbound.find((row) => row.message.externalId === "<ravi-1@sharmapumps.example>")!.message.from, "ravi@sharmapumps.example");
      // Delay notices change nothing.
      assert.equal((await db.collection("sales_activities").findOne({ "message.externalId": vermaId }))!.message.delivery.state, "sent");
      assert.equal((await db.collection("sales_drafts").findOne({ _id: vermaDraft.id }))!.delivery.state, "sent");
      // The classic permanent bounce marks Patel's message.
      assert.equal((await db.collection("sales_activities").findOne({ "message.externalId": patelId }))!.message.delivery.state, "bounced");
      assert.equal((await db.collection("sales_drafts").findOne({ _id: patelDraft.id }))!.delivery.state, "bounced");
      // The unclear send is recorded once as sent (as the sender's, with our Message-ID), then bounced; the lock is gone; the day's count holds.
      const settled = (await db.collection("sales_drafts").findOne({ _id: guptaDraft.id }))!;
      assert.deepEqual([settled.status, settled.sentVia, settled.sentAccountId, settled.sendLock, settled.delivery.state], ["sent", "smtp", box.id, undefined, "bounced"]);
      const outbound = await db.collection("sales_activities").find({ leadId: gupta.id, direction: "out" }).toArray();
      assert.deepEqual(outbound.map((row) => [row.actorId, row.message.externalId, row.message.delivery.state]), [["user-member", guptaId, "bounced"]]);
      assert.equal(Number((await db.collection("sales_send_counters").findOne({ userId: "user-member", channel: "email" }))!.count), counted);
      assert.ok(await db.collection("audit_events").findOne({ action: "sales.draft.delivery", objectId: guptaDraft.id, "metadata.bounced": true }));
      // The same bounce again files nothing twice.
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "mailSync.lastUid": 100 } });
      await sync.syncOnce();
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: gupta.id, direction: "out" }), 1);
      assert.equal(await db.collection("sales_activities").countDocuments({ direction: "in" }), 2);

      // A mailbox whose server stops answering is closed at its deadline; the others are read meanwhile, and its lease is let go.
      imap.hang.add(other.id);
      deliver(boxes.get(other.id)!, mail({ From: "asha@sharmapumps.example", To: "member2@acme.example", Subject: "Hello", "Message-ID": "<hang-1@sharmapumps.example>" }, "Hi"));
      deliver(mine, mail({ From: "asha@sharmapumps.example", To: "member@acme.example", Subject: "One more", "Message-ID": "<more-1@sharmapumps.example>" }, "One more thing."));
      const quick = createMailSync({ database, env: config, connect: imap.connect, workerId: "test-worker-2", accountDeadlineMs: 300, log: () => undefined });
      const t0 = performance.now();
      const rounds = await quick.syncOnce();
      assert.ok(performance.now() - t0 < 5_000);
      assert.deepEqual(rounds.map((row) => [row.accountId, row.status, row.error ?? null, row.filed]).sort(), [[box.id, "read", null, 1], [other.id, "failed", "deadline", 0]].sort());
      const stalled = (await db.collection("sales_channel_accounts").findOne({ _id: other.id }))!;
      assert.deepEqual([stalled.lastError, stalled.mailSync.leaseBy, stalled.mailSync.leaseUntil, stalled.mailSync.lastUid, stalled.status], ["Reading the inbox took too long, so it was stopped: the next round goes on from where it stopped", undefined, undefined, 49, "not_tested"]);
      assert.ok(imap.calls.includes(`close ${other.id}`));
    }, "email_sync_side");
  } finally { restore(); }
});

test("a bounce opens again what its message closed: the WhatsApp version of a first message and the other replies to a message come back as they were and can be sent; nothing reopens on a do-not-contact lead", { skip }, async () => {
  const restore = useProviderForTests({ kind: "email", test: async () => ({ ok: true, message: "Connected", checks: [] }), send: async (request) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to }) });
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const ok = async (status: number, method: string, path: string, handle: string, body?: unknown) => { const response = await api(method, path, handle, body); const text = await response.text(); assert.equal(response.status, status, `${method} ${path}: ${text}`); return JSON.parse(text).data; };
      const box = await ok(201, "POST", "/sales/channels", "member", { kind: "email", label: "Work mail", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: { address: "member@acme.example", senderName: "Mem Ber", username: "member@acme.example", smtp: { host: "smtp.example.com", port: 465, security: "ssl" }, imap: { host: "imap.example.com", port: 993, security: "ssl" } }, secrets: { password: PASSWORD } });
      const optIn = { at: new Date(), by: "user-member", how: "yes_on_call" };
      const newLead = async (name: string, email: string) => {
        const lead = await ok(201, "POST", "/sales/leads", "member", { pipelineId: "pipeline-a", companyName: name, ownerId: "user-member", contactRoutes: [{ kind: "email", value: email }, { kind: "phone", value: "98765 43210" }] });
        await db.collection("opportunities").updateOne({ _id: lead.id }, { $set: { whatsappOptIn: optIn } });
        return lead;
      };
      const ready = async (leadId: string, body: Record<string, unknown>) => {
        const draft = await ok(201, "POST", `/sales/leads/${leadId}/drafts`, "member", { channel: "email", subject: "Orders on the phone", body: "Hello, a short note about dealer orders.", ...body });
        if (draft.status === "in_review" && !body.checkByClaude) await ok(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" });
        return draft;
      };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const ourId = (draftId: string) => `<draft-${draftId}-1@acme.example>`;

      // A first message in two versions: the email goes through the mailbox, and the WhatsApp version (ready) closes.
      const twin = await newLead("Bounce Pumps", "asha@bouncepumps.example");
      const mail = await ready(twin.id, {});
      const chat = await ready(twin.id, { channel: "whatsapp", subject: undefined, body: "Hello on WhatsApp" });
      await ok(201, "POST", `/sales/drafts/${mail.id}/send`, "member", { requestId: "req-bounce-0001" });
      assert.deepEqual([(await stored(chat.id)).status, (await stored(chat.id)).statusBeforeClose], ["discarded", "ready"]);
      // Two replies to one message (one open reply per message now, so the one sent to Claude's check is left from before that rule): the
      // person's own goes through the mailbox, and the one in review closes.
      const legacyReply = async (leadId: string, inReplyTo: string, id: string) => { await db.collection("sales_drafts").insertOne({ _id: id, workspaceId: "workspace-a", ventureId: "venture-a", leadId, inReplyTo, channel: "email", purpose: "reply", subject: "Re: more", body: "Checked first.", status: "in_review", authorId: "user-member", authorVia: "app", createdAt: new Date(), updatedAt: new Date() } as never); return { id }; };
      const asked = await newLead("Bounce Tiles", "ravi@bouncetiles.example");
      const inbound = (await ok(201, "POST", `/sales/leads/${asked.id}/activities`, "member", { kind: "email", direction: "in", body: "Tell me more" })).activity;
      const own = await ready(asked.id, { purpose: "reply", inReplyTo: inbound.id, subject: "Re: more", body: "Here is more." });
      assert.equal(own.status, "ready");
      const checked = await legacyReply(asked.id, inbound.id, "legacy-bounce-checked");
      await ok(201, "POST", `/sales/drafts/${own.id}/send`, "member", { requestId: "req-bounce-0002" });
      assert.deepEqual([(await stored(checked.id)).closedReason, (await stored(checked.id)).statusBeforeClose], ["other_reply_sent", "in_review"]);
      // The same, but a person wrote a new reply to that message after it went: when it bounces, the closed one stays closed (one open
      // reply per message), and the new one is the answer.
      const rewritten = await newLead("Bounce Bricks", "neha@bouncebricks.example");
      const question = (await ok(201, "POST", `/sales/leads/${rewritten.id}/activities`, "member", { kind: "email", direction: "in", body: "And the price?" })).activity;
      const firstAnswer = await ready(rewritten.id, { purpose: "reply", inReplyTo: question.id, subject: "Re: price", body: "On a call, gladly." });
      const leftOver = await legacyReply(rewritten.id, question.id, "legacy-bounce-left-over");
      await ok(201, "POST", `/sales/drafts/${firstAnswer.id}/send`, "member", { requestId: "req-bounce-0005" });
      assert.equal((await stored(leftOver.id)).closedReason, "other_reply_sent");
      const secondAnswer = await ready(rewritten.id, { purpose: "reply", inReplyTo: question.id, subject: "Re: price", body: "Here is the range." });
      // A lead put on the do-not-contact list after its email went: nothing opens again there.
      const blocked = await newLead("Bounce Steel", "x@bouncesteel.example");
      const blockedMail = await ready(blocked.id, {});
      const blockedChat = await ready(blocked.id, { channel: "whatsapp", subject: undefined, body: "Hello on WhatsApp" });
      await ok(201, "POST", `/sales/drafts/${blockedMail.id}/send`, "member", { requestId: "req-bounce-0003" });
      await db.collection("opportunities").updateOne({ _id: blocked.id }, { $set: { doNotContact: true } });
      // A lead a call moved on after its email went (a meeting booked): its first message is no longer due, so nothing opens there either.
      const booked = await newLead("Bounce Gears", "y@bouncegears.example");
      const bookedMail = await ready(booked.id, {});
      const bookedChat = await ready(booked.id, { channel: "whatsapp", subject: undefined, body: "Hello on WhatsApp" });
      await ok(201, "POST", `/sales/drafts/${bookedMail.id}/send`, "member", { requestId: "req-bounce-0004" });
      await ok(201, "POST", `/sales/leads/${booked.id}/activities`, "member", { kind: "call", direction: "out", callOutcome: "interested_book", body: "Booked a demo" });

      // All three emails bounce.
      const boxes = new Map<string, Box>([[box.id, { uidValidity: "9", uidNext: 10, messages: new Map() }]]);
      const sync = createMailSync({ database, env: config, connect: standInImap(boxes).connect, workerId: "test-worker", log: () => undefined });
      await sync.syncOnce();
      const failed = (id: string, n: number) => [
        "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "To: member@acme.example", "Subject: Delivery Status Notification (Failure)", `Message-ID: <bounce-${n}@mx.google.com>`, `Date: ${new Date().toUTCString()}`, "Auto-Submitted: auto-replied",
        "MIME-Version: 1.0", 'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "", "Address not found.", "",
        "--b1", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; googlemail.com", "", "Final-Recipient: rfc822; someone@example.org", "Action: failed", "Status: 5.1.1", "",
        "--b1", "Content-Type: text/rfc822-headers", "", "From: Mem Ber <member@acme.example>", "Subject: Orders on the phone", `Message-ID: ${id}`, "", "--b1--", "",
      ].join("\n");
      const mine = boxes.get(box.id)!;
      for (const [index, draftId] of [mail.id, own.id, blockedMail.id, bookedMail.id, firstAnswer.id].entries()) deliver(mine, failed(ourId(draftId), index));
      const round = (await sync.syncOnce())[0]!;
      assert.equal(round.bounced, 5);

      // The WhatsApp version is back as it was (ready), without the closing fields, saying why; audited.
      const reopened = await stored(chat.id);
      assert.deepEqual([reopened.status, reopened.reopenedBecause, reopened.reopenedAt instanceof Date, reopened.closedReason, reopened.sentVersion, reopened.discardedAt, reopened.discardedReason, reopened.statusBeforeClose], ["ready", "bounced", true, undefined, undefined, undefined, undefined, undefined]);
      assert.deepEqual((await db.collection("audit_events").findOne({ action: "sales.draft.reopen", objectId: chat.id }))?.metadata, { reason: "bounced", bouncedDraftId: mail.id, status: "ready" });
      const shown = draftSchema.parse(await ok(200, "GET", `/sales/drafts/${chat.id}`, "member"));
      assert.deepEqual([shown.status, shown.reopenedBecause, typeof shown.reopenedAt, shown.closedReason], ["ready", "bounced", "string", undefined]);
      // The other reply to the message is back in review.
      assert.deepEqual([(await stored(checked.id)).status, (await stored(checked.id)).reopenedBecause], ["in_review", "bounced"]);
      // ...but not where a person wrote a new reply to that message since: that one stays the only open answer.
      assert.deepEqual([(await stored(leftOver.id)).status, (await stored(leftOver.id)).closedReason, (await stored(secondAnswer.id)).status], ["discarded", "other_reply_sent", "ready"]);
      // Nothing opened on the do-not-contact lead.
      assert.deepEqual([(await stored(blockedChat.id)).status, (await stored(blockedChat.id)).reopenedBecause], ["discarded", undefined]);
      assert.deepEqual([(await stored(bookedChat.id)).status, (await stored(bookedChat.id)).reopenedBecause, (await db.collection("opportunities").findOne({ _id: booked.id }))?.stage], ["discarded", undefined, "discovery_booked"]);
      // The bounced email never reached them, so it doesn't stand in the way: the WhatsApp version can go now (marked sent by hand).
      await ok(201, "POST", `/sales/drafts/${chat.id}/sent`, "member", {});
      assert.equal((await stored(chat.id)).status, "sent");
    }, "email_bounce_reopen");
  } finally { restore(); }
});
