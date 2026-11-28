import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { simpleParser, type AddressObject } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";
import { ourMessageIds } from "../src/sales/channels/email/sync.js";
import { cleanHtml, closeAllMailboxes, useMailboxForTests, useMailSenderForTests, type MailboxClient, type MailboxConnect, type MailboxFetched, type MailboxStructure } from "../src/sales/channels/email/mailbox.js";
import { useProviderForTests, type SendRequest } from "../src/sales/channels/provider.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Mail (docs/sales-channels.md section 3a; routes/sales-mail.ts, sales/channels/email/mailbox.ts): a person's own mailbox as a webmail,
// against a stand-in IMAP server kept in memory and a stand-in mail sender. No real mail server is ever contacted.

const skip = !process.env.TEST_MONGODB_URI;
const PASSWORD = "imap-app-pass-77zz-hidden";

// ---- Cleaning a message's HTML --------------------------------------------------------------------------------------------------------

test("a message's HTML loses scripts, frames, forms, meta and base tags, event attributes and script links, and says when it loads pictures", () => {
  const { html, remoteImages } = cleanHtml([
    "<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\"><base href=\"https://evil.example/\"><title>T</title>",
    "<style>p{color:red}</style><link rel=stylesheet href=https://evil.example/x.css></head><body onload=\"steal()\">",
    "<p class=\"a\" onclick='x()'>Hello <b>there</b></p><script>alert(1)</script><SCRIPT src=//evil.example/x.js></SCRIPT>",
    "<a href=\"javascript:alert(1)\">bad</a><a href=\"jav&#x09;ascript:alert(2)\">bad2</a><a href=\"https://ok.example/\" target=_top>ok</a>",
    "<iframe src=\"https://evil.example\"></iframe><object data=x></object><embed src=x><svg onload=alert(1)><script>1</script></svg>",
    "<form action=\"https://evil.example\"><input name=p value=x><button>Go</button></form>",
    "<img src=\"cid:pic\" alt=\"a>b\" onerror=\"alert(3)\"><img src=\"data:image/png;base64,AAAA\"><a href=\"data:text/html,<script>alert(4)</script>\">d</a>",
    "<!-- <script>alert(5)</script> --><div style=\"width:expression(alert(6))\">x</div> 1 < 2",
    "</body></html>",
  ].join(""));
  for (const bad of [/<script/i, /alert\(1\)/, /onload|onclick|onerror/i, /<iframe|<object|<embed|<svg|<form|<input|<button|<meta|<base|<link|<title/i, /javascript:|jav&#x09;ascript/i, /expression\(/, /data:text\/html/, /target=/i, /evil\.example\/x/]) {
    assert.doesNotMatch(html, bad, `still has ${bad}: ${html}`);
  }
  assert.match(html, /<p class="a">Hello <b>there<\/b><\/p>/);
  assert.match(html, /<style>p\{color:red\}<\/style>/);
  assert.match(html, /<a href="https:\/\/ok\.example\/" rel="noopener noreferrer">ok<\/a>/);
  assert.match(html, /<img src="cid:pic" alt="a>b">/, "a quoted > stays inside its attribute");
  assert.match(html, /<img src="data:image\/png;base64,AAAA">/);
  assert.match(html, /Go/, "a form's text stays");
  assert.match(html, /1 &lt; 2/);
  assert.equal(remoteImages, false);
  assert.equal(cleanHtml("<p>x</p><img src='https://t.example/pixel.gif'>").remoteImages, true);
  assert.equal(cleanHtml("<td background=\"//cdn.example/bg.png\">x</td>").remoteImages, true);
  assert.equal(cleanHtml("<style>.x{background:url( 'https://cdn.example/a.png')}</style>").remoteImages, true);
  assert.equal(cleanHtml("<div style=\"background-image:url(http://cdn.example/a.png)\">x</div>").remoteImages, true);
  // Unclosed tags and comments end the message; a stray "<" is text.
  assert.equal(cleanHtml("<p>ok</p><script>never closed").html, "<p>ok</p>");
  assert.equal(cleanHtml("<p>ok</p><!-- never closed").html, "<p>ok</p>");
  // A big inline picture keeps its source; the message's own rel never comes before ours.
  const big = `data:image/png;base64,${"A".repeat(40_000)}`;
  assert.ok(cleanHtml(`<img alt="logo" src="${big}">`).html.includes(`src="${big}"`));
  assert.equal(cleanHtml("<a href=\"https://ok.example/\" rel=\"opener\" referrerpolicy=unsafe-url>x</a>").html, "<a href=\"https://ok.example/\" rel=\"noopener noreferrer\">x</a>");
  assert.equal(cleanHtml("<p x\"y=1 class=a>t</p>").html, "<p class=\"a\">t</p>", "a name with a quote in it is dropped");
  // One pass, whatever it is given.
  for (const hostile of [
    "<a ".repeat(200_000), `<p title="${"\"".repeat(300_000)}`, "<!--".repeat(300_000), `<img ${"x=\"".repeat(100_000)}>`, "<script>".repeat(150_000), "< ".repeat(500_000),
    "</ >".repeat(300_000), "</1".repeat(300_000), "<svg>".repeat(250_000), "<object><math>".repeat(100_000), `<p${" ".repeat(1_400_000)}x>`, `<p style="${"url(".repeat(300_000)}">`,
    `<style>${"url(".repeat(100_000)}${" ".repeat(1_000_000)}</style>`, `<div ${"a=b ".repeat(300_000)}>`, `<a href="${"&#x6a;".repeat(250_000)}">x</a>`,
  ]) {
    const started = performance.now();
    cleanHtml(hostile);
    assert.ok(performance.now() - started < 1_500, `took ${Math.round(performance.now() - started)} ms`);
  }
});

test("a Mail message's id is ours: its bounce is found like a draft's", () => {
  assert.deepEqual(ourMessageIds("Original-Message-ID: <mail-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed@acme.example>\n<draft-abc-2@acme.example>"), [{ id: "<draft-abc-2@acme.example>", draftId: "abc" }, { id: "<mail-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed@acme.example>", draftId: "" }]);
});

// ---- A stand-in IMAP server -----------------------------------------------------------------------------------------------------------

type Message = { uid: number; raw: Buffer; flags: Set<string>; date: Date; structure?: MailboxStructure; files?: Map<string, { filename: string; contentType: string; content: Buffer }> };
type Folder = { path: string; name: string; parent: string[]; specialUse?: string; noselect?: boolean; messages: Message[]; uidNext: number };

async function build(options: { from: string; to: string; subject: string; text?: string; html?: string; messageId?: string; inReplyTo?: string; date?: Date; attachments?: { filename: string; content: Buffer; contentType: string }[] }): Promise<Buffer> {
  return new MailComposer({ from: options.from, to: options.to, subject: options.subject, ...(options.text ? { text: options.text } : {}), ...(options.html ? { html: options.html } : {}), messageId: options.messageId ?? `<${randomUUID()}@example.test>`, date: options.date ?? new Date(), ...(options.inReplyTo ? { inReplyTo: options.inReplyTo, references: [options.inReplyTo] } : {}), attachments: options.attachments ?? [] }).compile().build();
}

function standInMailbox(folders: Folder[]) {
  const state = { connects: 0, dropNext: false, refuse: false, calls: [] as string[] };
  const find = (path: string) => folders.find((folder) => folder.path === path);
  const put = async (path: string, raw: Buffer, extra: Partial<Message> = {}) => {
    const folder = find(path)!;
    const parsed = await simpleParser(raw);
    const message: Message = { uid: folder.uidNext++, raw, flags: new Set(), date: parsed.date ?? new Date(), ...extra };
    folder.messages.push(message);
    return message;
  };
  const connect: MailboxConnect = async (_settings, password) => {
    state.connects++;
    if (state.refuse || password !== PASSWORD) throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    let open: Folder | undefined;
    let usable = true;
    const fetched = async (message: Message, query: Record<string, unknown>): Promise<MailboxFetched> => {
      const parsed = await simpleParser(message.raw);
      const people = (value: AddressObject | AddressObject[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []).flatMap((entry) => entry.value);
      return {
        uid: message.uid, flags: new Set(message.flags), internalDate: message.date, size: message.raw.length,
        envelope: { date: parsed.date, subject: parsed.subject, messageId: parsed.messageId, from: people(parsed.from), to: people(parsed.to), cc: people(parsed.cc) },
        bodyStructure: message.structure ?? { type: "text/plain" },
        ...(query.source ? { source: message.raw } : {}),
      };
    };
    const alive = () => { if (!usable) throw Object.assign(new Error("Connection not available"), { code: "NoConnection" }); if (state.dropNext) { state.dropNext = false; usable = false; throw Object.assign(new Error("Connection closed"), { code: "EConnectionClosed" }); } };
    const byUid = (uid: string) => open!.messages.find((message) => message.uid === Number(uid));
    const client: MailboxClient = {
      get usable() { return usable; },
      get mailbox() { return open ? { exists: open.messages.length } : false; },
      async list() { alive(); return folders.map((folder) => ({ path: folder.path, name: folder.name, parent: folder.parent, flags: new Set(folder.noselect ? ["\\Noselect"] : []), ...(folder.specialUse ? { specialUse: folder.specialUse } : {}), status: { messages: folder.messages.length, unseen: folder.messages.filter((message) => !message.flags.has("\\Seen")).length } })); },
      async getMailboxLock(path, options) {
        alive();
        const folder = find(path);
        if (!folder || folder.noselect) throw Object.assign(new Error("Mailbox doesn't exist"), { serverResponseCode: "NONEXISTENT" });
        open = folder;
        state.calls.push(`lock ${path} ${options?.readOnly ? "read-only" : "read-write"}`);
        return { release() { state.calls.push(`release ${path}`); } };
      },
      async search(query) {
        alive();
        const [low, high] = String(query.uid ?? "1:*").split(":");
        let list = open!.messages.filter((message) => message.uid >= Number(low) && (high === "*" || message.uid <= Number(high)));
        const or = query.or as { from: string }[] | undefined;
        if (or) { const needle = or[0]!.from.toLowerCase(); list = list.filter((message) => message.raw.toString("utf8").toLowerCase().includes(needle)); }
        return list.map((message) => message.uid);
      },
      async fetchAll(range, query) { alive(); return Promise.all(range.map((uid) => byUid(String(uid))).filter((message): message is Message => Boolean(message)).map((message) => fetched(message, query))); },
      async fetchOne(uid, query) { alive(); const message = byUid(uid); return message ? fetched(message, query) : false; },
      async download(uid, part) { alive(); const file = byUid(uid)?.files?.get(part); return file ? { meta: { filename: file.filename, contentType: file.contentType, expectedSize: file.content.length }, content: Readable.from([file.content]) } : {}; },
      async messageFlagsAdd(uid, flags) { alive(); state.calls.push(`+${flags.join(",")} ${uid}`); const message = byUid(uid); flags.forEach((flag) => message?.flags.add(flag)); return Boolean(message); },
      async messageFlagsRemove(uid, flags) { alive(); state.calls.push(`-${flags.join(",")} ${uid}`); const message = byUid(uid); flags.forEach((flag) => message?.flags.delete(flag)); return Boolean(message); },
      async messageMove(uid, destination) {
        alive();
        const message = byUid(uid);
        if (!message) return false;
        open!.messages = open!.messages.filter((entry) => entry !== message);
        const target = find(destination)!;
        target.messages.push({ ...message, uid: target.uidNext++ });
        return { path: destination };
      },
      async logout() { usable = false; },
      close() { usable = false; },
    };
    return client;
  };
  return { connect, state, put, find };
}

const folderSet = (): Folder[] => [
  { path: "INBOX", name: "INBOX", parent: [], messages: [], uidNext: 1 },
  { path: "INBOX.Sent", name: "Sent", parent: ["INBOX"], specialUse: "\\Sent", messages: [], uidNext: 1 },
  { path: "INBOX.Trash", name: "Trash", parent: ["INBOX"], specialUse: "\\Trash", messages: [], uidNext: 1 },
  { path: "INBOX.Projects", name: "Projects", parent: ["INBOX"], messages: [], uidNext: 1 },
  { path: "Spam", name: "Spam", parent: [], specialUse: "\\Junk", messages: [], uidNext: 1 },
  { path: "[Gmail]", name: "[Gmail]", parent: [], noselect: true, messages: [], uidNext: 1 },
];

test("Mail reads the owner's own mailbox live: folders, pages, search, a message (marked read), an attachment, flags and moves; nobody else can open it", { skip }, async () => {
  const box = standInMailbox(folderSet());
  const restore = useMailboxForTests(box.connect);
  try {
    await withSalesApp(async ({ api }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => { const response = await api(method, path, handle, body); const text = await response.text(); return { status: response.status, body: JSON.parse(text || "null"), text, headers: response.headers }; };
      const ok = async (status: number, method: string, path: string, handle: string, body?: unknown) => { const reply = await call(method, path, handle, body); assert.equal(reply.status, status, `${method} ${path}: ${reply.text}`); return reply.body.data; };
      const settings = { address: "member@acme.example", senderName: "Mem Ber", username: "member@acme.example", smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" }, imap: { host: "imap.gmail.com", port: 993, security: "ssl" } };
      const account = await ok(201, "POST", "/sales/channels", "member", { kind: "email", label: "Work mail", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings, secrets: { password: PASSWORD } });
      const sharma = await ok(201, "POST", "/sales/leads", "member", { pipelineId: "pipeline-a", companyName: "Sharma Pumps", ownerId: "user-member", contactRoutes: [{ kind: "email", value: "asha@sharmapumps.example" }] });

      // Only the owner sees and opens the mailbox: a head and an admin get nothing, like a mailbox that doesn't exist.
      assert.deepEqual((await ok(200, "GET", "/sales/mail/accounts", "member")).map((entry: { id: string; address: string }) => [entry.id, entry.address]), [[account.id, "member@acme.example"]]);
      assert.deepEqual(await ok(200, "GET", "/sales/mail/accounts", "lead"), []);
      assert.deepEqual(await ok(200, "GET", "/sales/mail/accounts", "boss"), []);
      for (const handle of ["lead", "boss", "member2"]) assert.equal((await call("GET", `/sales/mail/${account.id}/folders`, handle)).status, 404);
      assert.equal(box.state.connects, 0, "nobody but the owner reached the mail server");

      await box.put("INBOX", await build({ from: "Asha <asha@sharmapumps.example>", to: "member@acme.example", subject: "Price list please", text: "Can you send the price list?", date: new Date(Date.now() - 3 * 3_600_000) }));
      await box.put("INBOX", await build({ from: "news@shop.example", to: "member@acme.example", subject: "Weekly deals", html: "<p onclick=\"x()\">Deals</p><img src=\"https://t.example/open.gif\"><script>alert(1)</script>", date: new Date(Date.now() - 2 * 3_600_000) }));
      const pdf = Buffer.from("%PDF-1.4 quote");
      const withFile = await box.put("INBOX", await build({ from: "Ravi <ravi@other.example>", to: "member@acme.example", subject: "Quote attached", text: "See the quote.", attachments: [{ filename: "quote.pdf", content: pdf, contentType: "application/pdf" }], date: new Date(Date.now() - 3_600_000) }), {
        structure: { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "quote.pdf" }, encoding: "base64", size: 20 }] },
        files: new Map([["2", { filename: "quote.pdf", contentType: "application/pdf", content: pdf }]]),
      });

      // Folders: Inbox, Sent, Spam, Trash, then the others; a folder that holds no messages ([Gmail]) is left out.
      const folders = await ok(200, "GET", `/sales/mail/${account.id}/folders`, "member");
      assert.deepEqual(folders.map((folder: { path: string; name: string; role: string; depth: number; total: number; unread: number }) => [folder.path, folder.name, folder.role, folder.depth, folder.total, folder.unread]), [
        ["INBOX", "Inbox", "inbox", 0, 3, 3], ["INBOX.Sent", "Sent", "sent", 0, 0, 0], ["Spam", "Spam", "junk", 0, 0, 0], ["INBOX.Trash", "Trash", "trash", 0, 0, 0], ["INBOX.Projects", "Projects", "other", 0, 0, 0],
      ]);

      // Pages, newest first; the lead's message names the lead; the list opens the folder read-only.
      const first = await ok(200, "GET", `/sales/mail/${account.id}/messages?folder=INBOX&limit=2`, "member");
      assert.deepEqual(first.items.map((row: { subject: string; hasAttachments: boolean; seen: boolean }) => [row.subject, row.hasAttachments, row.seen]), [["Quote attached", true, false], ["Weekly deals", false, false]]);
      assert.equal(first.total, 3);
      assert.ok(first.nextBefore);
      const second = await ok(200, "GET", `/sales/mail/${account.id}/messages?folder=INBOX&limit=2&before=${first.nextBefore}`, "member");
      assert.deepEqual(second.items.map((row: { subject: string }) => row.subject), ["Price list please"]);
      assert.deepEqual(second.items[0].lead, { leadId: sharma.id, companyName: "Sharma Pumps", ventureId: "venture-a" });
      assert.equal(second.nextBefore, undefined);
      const found = await ok(200, "GET", `/sales/mail/${account.id}/messages?folder=INBOX&q=deals`, "member");
      assert.deepEqual(found.items.map((row: { subject: string }) => row.subject), ["Weekly deals"]);
      assert.ok(box.state.calls.filter((line) => line.startsWith("lock INBOX")).every((line) => line.endsWith("read-only")));
      assert.equal(box.state.connects, 1, "one kept connection for every request so far");

      // One message: its HTML cleaned, pictures from the internet flagged, marked read on the server.
      const news = first.items[1];
      const read = await ok(200, "GET", `/sales/mail/${account.id}/messages/${news.uid}?folder=INBOX`, "member");
      assert.equal(read.subject, "Weekly deals");
      assert.doesNotMatch(read.html, /script|onclick|alert/);
      assert.equal(read.remoteImages, true);
      assert.equal(read.seen, true);
      assert.ok(box.find("INBOX")!.messages.find((message) => message.uid === news.uid)!.flags.has("\\Seen"));
      const quote = await ok(200, "GET", `/sales/mail/${account.id}/messages/${withFile.uid}?folder=INBOX`, "member");
      assert.equal(quote.text, "See the quote.");
      assert.deepEqual(quote.attachments, [{ part: "2", filename: "quote.pdf", contentType: "application/pdf", size: 15, inline: false }]);
      assert.equal((await call("GET", `/sales/mail/${account.id}/messages/999?folder=INBOX`, "member")).status, 404);
      assert.equal((await call("GET", `/sales/mail/${account.id}/messages/1?folder=Nowhere`, "member")).status, 404);

      // An attachment is always a download, straight from the server.
      const download = await api("GET", `/sales/mail/${account.id}/messages/${withFile.uid}/parts/2?folder=INBOX`, "member");
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-type"), "application/octet-stream");
      assert.match(download.headers.get("content-disposition") ?? "", /^attachment; filename="quote\.pdf"/);
      assert.equal(download.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
      assert.equal((await call("GET", `/sales/mail/${account.id}/messages/${withFile.uid}/parts/..%2F1?folder=INBOX`, "member")).status, 400);

      // Unread again, starred, then to Trash.
      await ok(200, "PATCH", `/sales/mail/${account.id}/messages/${news.uid}?folder=INBOX`, "member", { seen: false, flagged: true });
      const flags = box.find("INBOX")!.messages.find((message) => message.uid === news.uid)!.flags;
      assert.deepEqual([flags.has("\\Seen"), flags.has("\\Flagged")], [false, true]);
      assert.deepEqual(await ok(200, "POST", `/sales/mail/${account.id}/messages/${news.uid}/move?folder=INBOX`, "member", { to: "trash" }), { folder: "INBOX.Trash" });
      assert.deepEqual([box.find("INBOX")!.messages.length, box.find("INBOX.Trash")!.messages.length], [2, 1]);
      assert.equal((await call("POST", `/sales/mail/${account.id}/messages/1/move?folder=INBOX.Trash`, "member", { to: "trash" })).status, 409);

      // A kept connection the server dropped is replaced once; a refused password reads as one.
      box.state.dropNext = true;
      await ok(200, "GET", `/sales/mail/${account.id}/folders`, "member");
      assert.equal(box.state.connects, 2);
      closeAllMailboxes();
      box.state.refuse = true;
      const refused = await call("GET", `/sales/mail/${account.id}/folders`, "member");
      assert.equal(refused.status, 502);
      assert.match(refused.body.error.message, /^Gmail refused the password/);
      assert.ok(!refused.text.includes(PASSWORD));
    }, "mail-read");
  } finally {
    restore();
  }
});

test("Mail sends new mail, replies and forwards from the owner's mailbox, once per request; it refuses do-not-contact addresses, notes messages on leads and tracks what Sales sent", { skip }, async () => {
  const box = standInMailbox(folderSet());
  const restoreBox = useMailboxForTests(box.connect);
  const sent: { from: string; to: string[]; raw: Buffer }[] = [];
  let fail: Error | undefined;
  let refuse: string[] = [];
  const restoreSender = useMailSenderForTests(async (_settings, password, _signal, message) => {
    assert.equal(password, PASSWORD);
    if (fail) throw fail;
    sent.push(message);
    return refuse.length ? { rejected: refuse } : {};
  });
  const restoreProvider = useProviderForTests({ kind: "email", test: async () => ({ ok: true, message: "Connected", checks: [] }), send: async (request: SendRequest) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to }) });
  try {
    await withSalesApp(async ({ api, db }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => { const response = await api(method, path, handle, body); const text = await response.text(); return { status: response.status, body: JSON.parse(text || "null"), text }; };
      const ok = async (status: number, method: string, path: string, handle: string, body?: unknown) => { const reply = await call(method, path, handle, body); assert.equal(reply.status, status, `${method} ${path}: ${reply.text}`); return reply.body.data; };
      const settings = { address: "member@acme.example", senderName: "Mem Ber", username: "member@acme.example", smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" }, imap: { host: "imap.gmail.com", port: 993, security: "ssl" } };
      const account = await ok(201, "POST", "/sales/channels", "member", { kind: "email", label: "Work mail", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings, secrets: { password: PASSWORD } });
      const newLead = async (name: string, email: string) => ok(201, "POST", "/sales/leads", "member", { pipelineId: "pipeline-a", companyName: name, ownerId: "user-member", contactRoutes: [{ kind: "email", value: email }] });
      const sharma = await newLead("Sharma Pumps", "asha@sharmapumps.example");
      const verma = await newLead("Verma Tiles", "sales@vermatiles.example");
      const parse = async (index: number) => simpleParser(sent[index]!.raw);

      // A new message to someone who isn't a lead: sent from the person's own address, plain text, noted nowhere.
      const fresh = await ok(201, "POST", `/sales/mail/${account.id}/send`, "member", { to: ["Friend@Example.com"], subject: "Lunch", body: "Lunch on Friday?", requestId: "req-mail-0001" });
      assert.deepEqual([fresh.state, fresh.notedOn, fresh.warnings], ["sent", [], []]);
      assert.deepEqual([sent.length, sent[0]!.from, sent[0]!.to], [1, "member@acme.example", ["friend@example.com"]]);
      const lunch = await parse(0);
      assert.deepEqual([lunch.from?.value[0]?.address, lunch.from?.value[0]?.name, lunch.subject, lunch.text?.trim(), lunch.messageId], ["member@acme.example", "Mem Ber", "Lunch", "Lunch on Friday?", fresh.messageId]);
      // The same request again (a double click, a retry): the first answer, nothing sent twice.
      assert.deepEqual(await ok(200, "POST", `/sales/mail/${account.id}/send`, "member", { to: ["friend@example.com"], subject: "Lunch", body: "Lunch on Friday?", requestId: "req-mail-0001" }), fresh);
      assert.equal(sent.length, 1);
      // Nobody but the owner sends from it; Claude never reaches Mail.
      assert.equal((await call("POST", `/sales/mail/${account.id}/send`, "lead", { to: ["x@example.com"], body: "x", requestId: "req-mail-0002" })).status, 404);

      // A reply to a lead's message that Sales filed: threaded, quoted, noted on the lead, and the reply leaves the Inbox.
      const theirs = await box.put("INBOX", await build({ from: "Asha <asha@sharmapumps.example>", to: "member@acme.example", subject: "Price list please", text: "Can you send the price list?", messageId: "<asha-1@sharmapumps.example>" }));
      await db.collection("sales_activities").insertOne({ _id: "activity-in-1", workspaceId: "workspace-a", ventureId: "venture-a", leadId: sharma.id, actorId: "user-member", via: "system", kind: "email", direction: "in", body: "Can you send the price list?", at: new Date(Date.now() - 60_000), createdAt: new Date(), message: { accountId: account.id, externalId: "<asha-1@sharmapumps.example>", subject: "Price list please", from: "asha@sharmapumps.example" } });
      assert.equal((await ok(200, "GET", "/sales/inbox?ventureId=venture-a&handled=false", "member")).length, 1);
      const files = [{ filename: "prices.csv", contentType: "text/csv", data: Buffer.from("item,price\npump,100\n").toString("base64") }];
      const reply = await ok(201, "POST", `/sales/mail/${account.id}/send`, "member", { mode: "reply", source: { folder: "INBOX", uid: theirs.uid }, to: ["asha@sharmapumps.example"], subject: "Re: Price list please", body: "Here it is.", attachments: files, timezone: "Asia/Kolkata", requestId: "req-mail-0003" });
      assert.deepEqual(reply.notedOn, [{ leadId: sharma.id, companyName: "Sharma Pumps" }]);
      const answer = await parse(1);
      assert.equal(answer.inReplyTo, "<asha-1@sharmapumps.example>");
      assert.match(answer.text ?? "", /^Here it is\.\n\nOn .+, Asha <asha@sharmapumps\.example> wrote:\n> Can you send the price list\?/);
      assert.deepEqual(answer.attachments.map((file) => [file.filename, file.content.toString()]), [["prices.csv", "item,price\npump,100\n"]]);
      const noted = await db.collection("sales_activities").findOne({ leadId: sharma.id, direction: "out" });
      assert.deepEqual([noted?.kind, noted?.via, noted?.body, noted?.message?.externalId, noted?.message?.to], ["email", "app", "Here it is.", reply.messageId, "asha@sharmapumps.example"]);
      assert.ok((await db.collection("sales_activities").findOne({ _id: "activity-in-1" }))?.handledAt, "the reply it answers is handled");
      assert.equal((await ok(200, "GET", "/sales/inbox?ventureId=venture-a&handled=false", "member")).length, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(box.find("INBOX")!.messages.find((message) => message.uid === theirs.uid)!.flags.has("\\Answered"));

      // A forward carries the message and its attachments; a new message to a lead moves it on like a first message.
      const quoted = await box.put("INBOX", await build({ from: "ravi@other.example", to: "member@acme.example", subject: "Quote", text: "The quote.", attachments: [{ filename: "quote.pdf", content: Buffer.from("%PDF quote"), contentType: "application/pdf" }] }), { structure: { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "quote.pdf" } }] } });
      const forward = await ok(201, "POST", `/sales/mail/${account.id}/send`, "member", { mode: "forward", source: { folder: "INBOX", uid: quoted.uid }, to: ["sales@vermatiles.example"], subject: "Fwd: Quote", body: "FYI", requestId: "req-mail-0004" });
      assert.deepEqual(forward.notedOn, [{ leadId: verma.id, companyName: "Verma Tiles" }]);
      const forwarded = await parse(2);
      assert.match(forwarded.text ?? "", /^FYI\n\n---------- Forwarded message ---------\nFrom: ravi@other\.example\n/);
      assert.deepEqual(forwarded.attachments.map((file) => file.filename), ["quote.pdf"]);
      assert.equal((await ok(200, "GET", `/sales/leads/${verma.id}`, "member")).lead.stage, "contacted");

      // The do-not-contact list holds for new mail and forwards, but the person who wrote can always be answered.
      await db.collection("sales_suppression").insertOne({ _id: "suppress-1", workspaceId: "workspace-a", key: "domain:blocked.example", kind: "domain", value: "blocked.example", reason: "Asked not to be contacted", createdAt: new Date() });
      const refused = await call("POST", `/sales/mail/${account.id}/send`, "member", { to: ["ceo@blocked.example"], body: "Hi", requestId: "req-mail-0005" });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error.message, /ceo@blocked\.example is on the do-not-contact list/);
      const fromBlocked = await box.put("INBOX", await build({ from: "ceo@blocked.example", to: "member@acme.example", subject: "Stop", text: "Please remove me." }));
      await ok(201, "POST", `/sales/mail/${account.id}/send`, "member", { mode: "reply", source: { folder: "INBOX", uid: fromBlocked.uid }, to: ["ceo@blocked.example"], subject: "Re: Stop", body: "Done, removed.", requestId: "req-mail-0006" });
      assert.equal(sent.length, 4);

      // A refused send says why, sends nothing, and the same request can be tried again.
      const { SmtpStepError } = await import("../src/sales/channels/email/provider.js");
      fail = new SmtpStepError("send", Object.assign(new Error("550"), { code: "EENVELOPE", responseCode: 550, command: "RCPT TO", response: "550 5.1.1 User unknown" }));
      const bounced = await call("POST", `/sales/mail/${account.id}/send`, "member", { to: ["nobody@example.com"], body: "Hi", requestId: "req-mail-0007" });
      assert.equal(bounced.status, 502);
      assert.match(bounced.body.error.message, /refused an address|User unknown/);
      fail = undefined;
      await ok(201, "POST", `/sales/mail/${account.id}/send`, "member", { to: ["nobody@example.com"], body: "Hi", requestId: "req-mail-0007" });

      // A new message to a lead is counted like one sent from Review (the person's daily email limit for the venture and the mailbox's
      // day); an answer isn't. An address that bounced before isn't mailed again, and refused addresses aren't noted.
      const day = (await db.collection("sales_mailbox_days").find({ accountId: account.id }).toArray()).reduce((sum, row) => sum + Number(row.count ?? 0), 0);
      assert.equal(day, 1, "the forward to Verma counted; the replies and the mail to people who aren't leads didn't");
      const counters = await db.collection("sales_send_counters").find({ _id: { $regex: ":user-member:email:" } as never }).toArray();
      // The venture's counter starts from the day's emails to leads already sent (the answer to Asha), then the forward claimed one more.
      assert.equal(counters.reduce((sum, row) => sum + Number(row.count ?? 0), 0), 2);
      const patel = await newLead("Patel Agro", "orders@patelagro.example");
      await db.collection("sales_bad_addresses").insertOne({ _id: "workspace-a:orders@patelagro.example" as never, workspaceId: "workspace-a", email: "orders@patelagro.example", kind: "bounced", reason: "550 no such user", at: new Date(), createdAt: new Date() });
      const bad = await call("POST", `/sales/mail/${account.id}/send`, "member", { to: ["orders@patelagro.example"], body: "Hello", requestId: "req-mail-0008" });
      assert.equal(bad.status, 409);
      assert.match(bad.body.error.message, /^orders@patelagro\.example bounced before, so the app won't email it again: check the address on Patel Agro/);
      assert.equal((await ok(200, "GET", `/sales/leads/${patel.id}`, "member")).lead.stage !== "contacted", true);
      const amar = await newLead("Amar Plastics", "hello@amarplastics.example");
      refuse = ["hello@amarplastics.example"];
      const partly = await ok(201, "POST", `/sales/mail/${account.id}/send`, "member", { to: ["friend@example.com", "hello@amarplastics.example"], body: "Hello both", requestId: "req-mail-0009" });
      refuse = [];
      assert.deepEqual([partly.state, partly.notedOn], ["sent", []]);
      assert.match(partly.warnings[0], /^The mail server refused hello@amarplastics\.example: that address didn't get it/);
      assert.equal((await db.collection("sales_activities").countDocuments({ leadId: amar.id, direction: "out" })), 0);

      // What Sales sent shows in Sent with what became of it: sent, then replied, or bounced.
      const gupta = await newLead("Gupta Steel", "ravi@guptasteel.example");
      const draft = await ok(201, "POST", `/sales/leads/${gupta.id}/drafts`, "member", { channel: "email", subject: "Orders", body: "A short note about dealer orders." });
      await ok(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" });
      await ok(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-draft-0001" });
      const fromSales = await db.collection("sales_activities").findOne({ draftId: draft.id, direction: "out" });
      assert.ok(fromSales?.message?.externalId);
      await box.put("INBOX.Sent", await build({ from: "member@acme.example", to: String(fromSales.message.to ?? "sales@vermatiles.example"), subject: "Orders", text: "A short note about dealer orders.", messageId: fromSales.message.externalId }));
      const track = async () => (await ok(200, "GET", `/sales/mail/${account.id}/messages?folder=INBOX.Sent`, "member")).items[0].track;
      const tracked = await track();
      assert.deepEqual([tracked.state, tracked.draftId, tracked.leadId], ["sent", draft.id, String(fromSales.leadId)]);
      await db.collection("sales_activities").insertOne({ _id: "activity-in-2", workspaceId: "workspace-a", ventureId: "venture-a", leadId: fromSales.leadId, actorId: "user-member", via: "system", kind: "email", direction: "in", body: "Thanks", at: new Date(Date.now() + 60_000), createdAt: new Date() });
      assert.equal((await track()).state, "replied");
      await db.collection("sales_activities").updateOne({ _id: fromSales._id }, { $set: { "message.delivery": { state: "bounced", at: new Date() } } });
      assert.equal((await track()).state, "bounced");
    }, "mail-send");
  } finally {
    restoreProvider();
    restoreSender();
    restoreBox();
  }
});
