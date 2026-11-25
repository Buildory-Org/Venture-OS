import assert from "node:assert/strict";
import test from "node:test";
import { autopilotSettingsSchema, channelAccountSchema } from "@venture-studio/contracts";
import { actorFor } from "../src/middleware.js";
import { autopilotBlockers } from "../src/sales/autopilot/status.js";
import { smtpFailure } from "../src/sales/channels/email/provider.js";
import {
  BAD_ADDRESSES, BOUNCE_PAUSE_MS, DNS_RECHECK_MS, MAILBOX_DAYS, PASSWORD_PAUSE_MS, SLOW_DOWN_PAUSE_MS, WARMUP_START, canReceiveMail, checkBounces, clearPause, guardOf, lookUpSenderRecords,
  mailboxDayLimit, noteBounce, pausedNow, recordsProblem, useGuardDnsForTests, warmupLimit, type GuardDns,
} from "../src/sales/channels/mailbox-guard.js";
import { useProviderForTests, type SendOutcome, type SendRequest } from "../src/sales/channels/provider.js";
import { createSendQueue, defaultGapMs, enqueueDraft } from "../src/sales/channels/send-queue.js";
import type { SalesCtx } from "../src/sales/ctx.js";
import { DEFAULT_CALENDAR, inWorkingWindow, localDay, shiftDate } from "../src/sales/workdays.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Sender protection (docs/sales-autopilot.md section 5a; sales/channels/mailbox-guard.ts): the warm-up limit, addresses that don't take
// mail, the pauses (bounces, the mail server's push-back, a refused password) and the domain's records. No real network: the mail provider
// and DNS are stand-ins, and the queue worker gets an injected clock and gap.

const skip = !process.env.TEST_MONGODB_URI;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Monday 2026-11-23, 10:30 in India (the default venture calendar): inside a working window. */
const T0 = new Date("2026-11-23T05:00:00Z");
const ist = (iso: string) => new Date(`${iso}+05:30`);
/** The day a send is counted on: sendDraftThrough reads the real clock. */
const today = () => localDay(new Date(), DEFAULT_CALENDAR);

type Reply = { status: number; text: string; data: any; body: any };
function caller(api: (method: string, path: string, handle: string, body?: unknown) => Promise<Response>) {
  const call = async (method: string, path: string, handle: string, body?: unknown): Promise<Reply> => {
    const response = await api(method, path, handle, body);
    const text = await response.text();
    const parsed = JSON.parse(text || "null");
    return { status: response.status, text, body: parsed, data: parsed?.data };
  };
  const expect = async (status: number, method: string, path: string, handle: string, body?: unknown) => {
    const reply = await call(method, path, handle, body);
    assert.equal(reply.status, status, `${method} ${path} as ${handle}: ${reply.text}`);
    return reply;
  };
  return { call, expect };
}
type Expect = ReturnType<typeof caller>["expect"];

const mailbox = (address: string) => ({
  kind: "email", label: `Mail ${address}`, ventureIds: ["venture-a"], defaultFor: ["venture-a"],
  settings: { address, senderName: "Mem Ber", username: address, smtp: { host: "smtp.hostinger.com", port: 465, security: "ssl" }, imap: { host: "imap.hostinger.com", port: 993, security: "ssl" } },
  secrets: { password: "guard-app-pass-4410-hidden" },
});

function standIn() {
  const sends: SendRequest[] = [];
  const state = { answer: async (request: SendRequest): Promise<SendOutcome> => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to }) };
  const restore = useProviderForTests({ kind: "email", test: async () => ({ ok: true, message: "Connected", checks: [] }), send: async (request) => { sends.push(request); return state.answer(request); } });
  return { sends, state, restore };
}

/** A DNS stand-in: `txt` and `mx` by name; a name that isn't listed doesn't exist; a name listed in `broken` times out. */
function fakeDns(records: { txt?: Record<string, string[]>; mx?: Record<string, string[]>; a?: Record<string, string[]>; aaaa?: Record<string, string[]>; broken?: string[] }): GuardDns & { asked: string[] } {
  const asked: string[] = [];
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const read = <T>(table: Record<string, T> | undefined, name: string, kind: string): T => {
    asked.push(`${kind} ${name}`);
    if (records.broken?.includes(name)) throw fail("ETIMEOUT");
    const found = table?.[name];
    // A name that has some other kind of record exists but has none of this kind; any other name doesn't exist at all.
    if (found === undefined) throw fail([records.txt, records.mx, records.a, records.aaaa].some((other) => other && name in other) ? "ENODATA" : "ENOTFOUND");
    return found;
  };
  return {
    asked,
    resolveTxt: async (name) => read(records.txt, name, "TXT").map((value) => [value]),
    resolveMx: async (name) => read(records.mx, name, "MX").map((exchange) => ({ exchange })),
    resolve4: async (name) => read(records.a, name, "A"),
    resolve6: async (name) => read(records.aaaa, name, "AAAA"),
  };
}

let leadCount = 0;
async function newLead(expect: Expect, extra: Record<string, unknown> = {}) {
  const name = `Guard Lead ${++leadCount}`;
  return (await expect(201, "POST", "/sales/leads", "member", { pipelineId: "pipeline-a", companyName: name, ownerId: "user-member", contactName: "Asha", contactRoutes: [{ kind: "email", value: `asha${leadCount}@guardlead${leadCount}.example` }], ...extra })).data;
}
async function readyDraft(expect: Expect, leadId: string, extra: Record<string, unknown> = {}) {
  const draft = (await expect(201, "POST", `/sales/leads/${leadId}/drafts`, "member", { channel: "email", subject: "Orders on the phone", body: "Hello Asha, a short note about dealer orders.", submit: true, ...extra })).data;
  return (await expect(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" })).data;
}

test("the rules themselves: the warm-up steps, what a mail server's answer means, the domain's records and the lead's mail server", async () => {
  // 5 a day at first, 5 more after every 5 sending days, never above the venture's cap.
  assert.deepEqual([0, 4, 5, 9, 10, 14, 15, 40].map((days) => warmupLimit(days, 20)), [5, 5, 10, 10, 15, 15, 20, 20]);
  assert.deepEqual([warmupLimit(0, 3), warmupLimit(30, 8), warmupLimit(0, 0), warmupLimit(-2, 20)], [3, 8, 0, WARMUP_START]);
  const gaps = Array.from({ length: 200 }, defaultGapMs);
  assert.ok(Math.min(...gaps) >= 4 * MIN && Math.max(...gaps) <= 10 * MIN && new Set(gaps).size > 20, "4 to 10 minutes apart, never like clockwork");

  // What the mail server said, and what the queue does with it.
  const settings = { smtp: { host: "smtp.hostinger.com", port: 465, security: "ssl" as const } };
  const said = (responseCode: number, command: string, response: string) => smtpFailure({ responseCode, command, response }, "send", settings);
  const kindOf = (outcome: ReturnType<typeof smtpFailure>) => (outcome.state === "failed" ? outcome.kind : outcome.state);
  assert.equal(kindOf(smtpFailure({ code: "EAUTH", responseCode: 535 }, "login", settings)), "password");
  assert.equal(kindOf(said(451, "DATA", "451 4.7.1 Please try again later")), "slow_down");
  assert.equal(kindOf(said(421, "MAIL FROM", "421 Too many connections")), "slow_down");
  assert.equal(kindOf(said(450, "RCPT TO", "450 4.7.1 Rate limit exceeded, try again later")), "slow_down");
  // A 4xx about the lead's side is that message's own delay: it is tried again, and no mailbox is paused for it.
  assert.equal(kindOf(said(450, "RCPT TO", "450 4.2.0 Greylisted, please try again")), undefined);
  assert.equal(kindOf(said(452, "RCPT TO", "452 4.2.2 The recipient's inbox is out of storage space")), undefined);
  assert.equal(kindOf(said(451, "DATA", "451 4.7.1 Greylisting in action, please come back later")), undefined);
  // The address itself is wrong: remembered, never mailed again.
  assert.equal(kindOf(said(550, "RCPT TO", "550 5.1.1 The email account that you tried to reach does not exist")), "address");
  assert.equal(kindOf(said(550, "RCPT TO", "550 User unknown")), "address");
  assert.equal(kindOf(said(550, "RCPT TO", "550 5.2.1 The email account that you tried to reach is disabled")), "address");
  assert.equal(kindOf(said(550, "RCPT TO", "550 5.4.1 Recipient address rejected: Access denied")), "address");
  // Neither a bad address nor our fault: the lead's full mailbox, a lead's server that only takes mail from certain senders, a message problem.
  assert.equal(kindOf(said(552, "RCPT TO", "552 5.2.2 The recipient's mailbox is full and over quota")), undefined);
  assert.equal(kindOf(said(550, "RCPT TO", "550 5.7.1 RESOLVER.RST.NotAuthorized; not authorized")), undefined);
  assert.equal(kindOf(said(552, "DATA", "552 5.3.4 Message size exceeds fixed limit")), undefined);
  // About the sender: a limit, spam, a block list, reputation, or relaying refused (the mailbox's own set-up: every message would be refused,
  // so no lead's address is blamed for it).
  assert.equal(kindOf(said(550, "MAIL FROM", "550 5.7.0 Daily sending limit exceeded for this account")), "blocked");
  assert.equal(kindOf(said(554, "DATA", "554 Message rejected as spam by policy")), "blocked");
  assert.equal(kindOf(said(550, "RCPT TO", "550 Sender blocked: poor reputation")), "blocked");
  assert.equal(kindOf(said(550, "RCPT TO", "550 5.7.1 Service unavailable; client host listed on a block list (Spamhaus)")), "blocked");
  assert.equal(kindOf(said(554, "RCPT TO", "554 5.7.1 <asha@lead.example>: Relay access denied")), "blocked");
  assert.equal(kindOf(said(550, "RCPT TO", "550 5.7.64 TenantAttribution; Relay Access Denied")), "blocked");
  assert.equal(kindOf(said(550, "DATA", "550 5.7.1 Message refused")), "blocked");
  assert.equal(kindOf(smtpFailure({ code: "ESOCKET" }, "send", settings)), "uncertain");

  // The sending domain's records: SPF on the domain, DMARC on it or a parent; a failed lookup is "unknown", never "missing".
  const dns = fakeDns({ txt: {
    "good.example": ["google-site-verification=abc", "v=spf1 include:_spf.mail.example ~all"], "_dmarc.good.example": ["v=DMARC1; p=none"],
    "nodmarc.example": ["v=spf1 -all"], "nospf.example": ["some-other-record"], "_dmarc.nospf.example": ["v=DMARC1; p=quarantine"],
    "mail.parent.example": ["v=spf1 -all"], "_dmarc.parent.example": ["V=DMARC1; p=reject"],
  }, mx: { "takes.example": ["mx1.takes.example"], "null.example": ["."] }, a: { "onlya.example": ["203.0.113.9"], "nomail.example": [] }, aaaa: { "onlyv6.example": ["2001:db8::9"] }, broken: ["slow.example", "_dmarc.slow.example", "flaky.example"] });
  const restore = useGuardDnsForTests(dns);
  try {
    assert.deepEqual(await lookUpSenderRecords("good.example"), { spf: "ok", dmarc: "ok" });
    assert.deepEqual(await lookUpSenderRecords("nodmarc.example"), { spf: "ok", dmarc: "missing" });
    assert.deepEqual(await lookUpSenderRecords("nospf.example"), { spf: "missing", dmarc: "ok" });
    assert.deepEqual(await lookUpSenderRecords("mail.parent.example"), { spf: "ok", dmarc: "ok" }, "a parent domain's DMARC record covers it");
    assert.deepEqual(await lookUpSenderRecords("nothing.example"), { spf: "missing", dmarc: "missing" });
    assert.deepEqual(await lookUpSenderRecords("slow.example"), { spf: "unknown", dmarc: "unknown" });
    dns.asked.length = 0;
    assert.deepEqual(await lookUpSenderRecords("gmail.com"), { spf: "ok", dmarc: "ok" });
    assert.deepEqual(dns.asked, [], "a shared mail domain is its provider's business: nothing is looked up");
    const box = (address: string) => ({ _id: "box", kind: "email", settings: { address } });
    assert.match(String(recordsProblem(box("a@nodmarc.example"), { checkedAt: T0, spf: "ok", dmarc: "missing" })), /^nodmarc\.example has no DMARC record, so mail servers can't tell .* add it where the domain is managed$/);
    assert.match(String(recordsProblem(box("a@x.example"), { checkedAt: T0, spf: "missing", dmarc: "missing" })), /has no SPF or DMARC record.* add them where/);
    assert.equal(recordsProblem(box("a@x.example"), { checkedAt: T0, spf: "unknown", dmarc: "ok" }), undefined, "a lookup that failed holds nothing");
    assert.equal(recordsProblem(box("a@x.example"), undefined), undefined);

    // The lead's side: a mail server, or an address mail falls back to; only a definite "no" stops the email.
    assert.equal(await canReceiveMail("asha@takes.example"), true);
    assert.equal(await canReceiveMail("asha@onlya.example"), true, "no MX but an address: mail falls back to it");
    assert.equal(await canReceiveMail("asha@onlyv6.example"), true, "an IPv6 address counts too");
    assert.equal(await canReceiveMail("asha@gone.example"), false, "the domain doesn't exist");
    assert.equal(await canReceiveMail("asha@null.example"), false, "the domain says it takes no mail");
    assert.equal(await canReceiveMail("asha@nomail.example"), false, "no mail server and no address");
    assert.equal(await canReceiveMail("asha@flaky.example"), true, "a lookup that failed lets the email go");
    dns.asked.length = 0;
    assert.equal(await canReceiveMail("other@takes.example"), true);
    assert.deepEqual(dns.asked, [], "one lookup per domain a day");
  } finally { restore(); }
  // Under the test runner nothing is looked up unless a test hands in a resolver.
  assert.deepEqual(await lookUpSenderRecords("good.example"), { spf: "unknown", dmarc: "unknown" });
  assert.equal(await canReceiveMail("asha@gone.example"), true);
});

test("the warm-up: the queue sends 5 a day from a new mailbox and the rest wait for the next working day; a hand send is counted, never held; the limit grows with the days it sent on", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member: SalesCtx = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app", channel: "api", workspaceId: "workspace-a", settings: new Map() };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const box = (await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).data;
      const account = async () => (await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!;
      let clock = T0;
      const q = createSendQueue({ database, env: config, now: () => clock, gapMs: () => 4 * MIN, log: () => undefined });
      const drafts: string[] = [];
      for (let index = 0; index < 7; index++) {
        const lead = await newLead(expect);
        const draft = await readyDraft(expect, lead.id);
        assert.equal((await enqueueDraft(member, config, await stored(draft.id), (await db.collection("opportunities").findOne({ _id: lead.id }))!, { now: T0, gapMs: () => 4 * MIN })).queued, true);
        drafts.push(draft.id);
      }
      // Five go, 4 minutes apart; the sixth finds the day's limit used and waits, with the seventh, for Tuesday 10:00.
      let sent = 0;
      for (let tick = 0; tick < 8; tick++) { sent += await q.runOnce(); clock = new Date(clock.getTime() + 4 * MIN); }
      assert.equal(sent, WARMUP_START);
      assert.equal(email.sends.length, WARMUP_START);
      assert.deepEqual((await Promise.all(drafts.map(stored))).map((draft) => draft.status), ["sent", "sent", "sent", "sent", "sent", "ready", "ready"]);
      for (const id of drafts.slice(5)) {
        const waiting = await stored(id);
        assert.equal(waiting.sendQueue.notBefore.toISOString(), ist("2026-11-24T10:00:00").toISOString());
        assert.deepEqual([waiting.sendQueue.attempts, waiting.sendLock, waiting.queueHold], [0, undefined, undefined], "waiting is not a failure: nothing was tried, nobody is told");
      }
      assert.equal(await db.collection("notification_outbox").countDocuments({ resourceType: { $in: ["draft", "channel_account"] } }), 0);
      const row = (await db.collection(MAILBOX_DAYS).findOne({ _id: `${box.id}:${today()}` as never }))!;
      assert.deepEqual([row.count, row.accountId, row.day], [WARMUP_START, box.id, today()]);
      assert.deepEqual(guardOf(await account()).dayLimit, { day: today(), limit: 5, cap: 20 });
      // The mailbox's card says so; the stored `guard` itself is never returned.
      const shown = channelAccountSchema.parse((await expect(200, "GET", "/sales/channels?ventureId=venture-a", "member")).data.find((item: any) => item.id === box.id));
      assert.deepEqual(shown.protection, { dayLimit: 5, dayCap: 20 });
      assert.equal(JSON.stringify((await expect(200, "GET", "/sales/channels?ventureId=venture-a", "member")).body).includes("\"guard\""), false);

      // A person's own "Send now" is their decision: it goes, and it is counted.
      const lead = await newLead(expect);
      const byHand = await readyDraft(expect, lead.id);
      await expect(201, "POST", `/sales/drafts/${byHand.id}/send`, "member", { requestId: "guard-hand-send-1" });
      assert.equal((await db.collection(MAILBOX_DAYS).findOne({ _id: `${box.id}:${today()}` as never }))!.count, WARMUP_START + 1);
      // A send that fails gives its place back.
      email.state.answer = async () => ({ state: "failed", error: "The mail server refused the message" });
      const failing = await readyDraft(expect, (await newLead(expect)).id);
      await expect(502, "POST", `/sales/drafts/${failing.id}/send`, "member", { requestId: "guard-hand-send-2" });
      assert.equal((await db.collection(MAILBOX_DAYS).findOne({ _id: `${box.id}:${today()}` as never }))!.count, WARMUP_START + 1);

      // The limit for a day comes from the days before it (the last 30) on which the mailbox sent: 5 days -> 10, 15 days -> the cap.
      const seed = async (daysAgo: number[]) => db.collection(MAILBOX_DAYS).insertMany(daysAgo.map((ago) => ({ _id: `${box.id}:${shiftDate(today(), -ago)}` as never, workspaceId: "workspace-a", accountId: box.id, day: shiftDate(today(), -ago), count: 3, createdAt: new Date() })));
      const limit = async (cap = 20) => mailboxDayLimit(db, await account(), cap, today(), DEFAULT_CALENDAR);
      assert.equal(await limit(), 5, "today's own sends don't raise today's limit");
      await seed([1, 2, 3, 4]);
      assert.equal(await limit(), 5);
      await seed([5]);
      assert.equal(await limit(), 10);
      await seed([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 40, 41, 42]);
      assert.equal(await limit(), 20, "15 sending days in the last 30: the venture's cap (older days don't count)");
      assert.equal(await limit(8), 8);
      // A day with nothing sent in the end (count 0) is not a sending day.
      await db.collection(MAILBOX_DAYS).updateOne({ _id: `${box.id}:${shiftDate(today(), -15)}` as never }, { $set: { count: 0 } });
      assert.equal(await limit(), 15);
      // After a bounce pause the warm-up starts again from that moment.
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "guard.rampSince": new Date(Date.now() - 3 * 86_400_000) } });
      assert.equal(await limit(), 5);
    }, "guard_warmup");
  } finally { email.restore(); }
});

test("bounces: the address is never mailed again (queue or hand), the sender is told once, and three bounces pause the mailbox's queue for three days", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member: SalesCtx = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app", channel: "api", workspaceId: "workspace-a", settings: new Map() };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const leadOf = async (id: string) => (await db.collection("opportunities").findOne({ _id: id }))!;
      const box = (await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).data;
      const account = async () => (await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!;
      let clock = T0;
      const q = createSendQueue({ database, env: config, now: () => clock, gapMs: () => 4 * MIN, log: () => undefined });
      const send = async () => {
        const lead = await newLead(expect);
        const draft = await readyDraft(expect, lead.id);
        assert.equal((await enqueueDraft(member, config, await stored(draft.id), await leadOf(lead.id), { now: clock, gapMs: () => 4 * MIN })).queued, true);
        assert.equal(await q.runOnce(), 1);
        // The send itself reads the real clock: the message is put on the test's clock, so the two-week window is the test's too.
        await db.collection("sales_activities").updateOne({ draftId: draft.id, direction: "out" }, { $set: { at: clock } });
        clock = new Date(clock.getTime() + 5 * MIN);
        return { lead, draft };
      };
      /** What the inbox reader does when a delivery report names one of our messages (email/sync.ts markBounced). */
      const bounce = async (draftId: string, at = clock) => {
        const delivery = { state: "bounced", at, accountId: box.id, error: "The email bounced: 550 5.1.1 The email account does not exist" };
        const activity = await db.collection("sales_activities").findOneAndUpdate({ draftId, direction: "out" }, { $set: { "message.delivery": delivery } }, { returnDocument: "after" });
        const draft = await db.collection("sales_drafts").findOneAndUpdate({ _id: draftId }, { $set: { delivery } }, { returnDocument: "after" });
        await noteBounce(db, { account: await account(), activity, draft, reason: delivery.error, now: at });
      };

      const first = await send();
      const address = first.lead.contactRoutes[0].value as string;
      await bounce(first.draft.id);
      await bounce(first.draft.id);
      const bad = (await db.collection(BAD_ADDRESSES).findOne({ _id: `workspace-a:${address}` as never }))!;
      assert.deepEqual([bad.kind, bad.email, bad.leadId, bad.accountId], ["bounced", address, first.lead.id, box.id]);
      const told = await db.collection("notification_outbox").find({ idempotencyKey: `draft:${first.draft.id}:bounced` }).toArray();
      assert.equal(told.length, 1, "told once, however often the report is read");
      assert.deepEqual([told[0]!.userId, told[0]!.type, told[0]!.resourceType, told[0]!.resourceId, told[0]!.title], ["user-member", "sales_needs_you", "opportunity", first.lead.id, `Bounced: email to ${first.lead.companyName}`]);
      assert.match(String(told[0]!.body), /does not exist\. The app won't email that address again: put another address on the lead, or call\.$/);
      assert.equal(pausedNow(await account(), clock), undefined, "one bounce pauses nothing");

      // A new first message to the same address (the bounced one never reached them) is not even written: it could never be sent.
      const refusedDraft = await expect(409, "POST", `/sales/leads/${first.lead.id}/drafts`, "member", { channel: "email", subject: "Orders on the phone", body: "Hello Asha, once more.", submit: true });
      const words = new RegExp(`${address.replace(/\./g, "\\.")} bounced on \\d+ \\w+, so the app won't email it again: put another address on the lead, or send it from your own mail and mark it sent$`);
      assert.match(refusedDraft.body.error.message, new RegExp(`^Not drafted: ${words.source}`));
      // Another channel is still open, and so is an answer to them (they wrote from somewhere).
      await expect(201, "POST", `/sales/leads/${first.lead.id}/drafts`, "member", { channel: "call_opener", body: "Hello Asha, calling about dealer orders.", submit: true });
      // A draft written before its address went bad (another lead of the team has the same address): not queued, not sent by hand.
      const shared = await newLead(expect, { contactRoutes: [{ kind: "email", value: "purchase@guardlead-shared.example" }] });
      const again = await readyDraft(expect, shared.id);
      await noteBounce(db, { account: await account(), activity: { _id: "other-activity", leadId: "other-lead", message: { to: "Purchase@GuardLead-Shared.example" } }, reason: "The email bounced: 550 5.1.1 No such user", now: clock });
      const refused = await enqueueDraft(member, config, await stored(again.id), await leadOf(shared.id), { now: clock });
      assert.equal(refused.queued, false);
      assert.match((refused as { reason: string }).reason, /^purchase@guardlead-shared\.example bounced on \d+ \w+, so the app won't email it again: put another address on the lead, or send it from your own mail and mark it sent$/);
      const hand = await expect(409, "POST", `/sales/drafts/${again.id}/send`, "member", { requestId: "guard-bounced-hand-1" });
      assert.match(hand.body.error.message, /bounced on .* so the app won't email it again/);
      const before = email.sends.length;
      // Another address on the lead: it goes.
      await db.collection("opportunities").updateOne({ _id: shared.id }, { $set: { contactRoutes: [{ kind: "email", value: "owner@guardlead-new.example" }] } });
      assert.equal((await enqueueDraft(member, config, await stored(again.id), await leadOf(shared.id), { now: clock, gapMs: () => 4 * MIN })).queued, true);
      assert.equal(await q.runOnce(), 1);
      assert.equal(email.sends.length, before + 1);
      await db.collection("sales_activities").updateOne({ draftId: again.id, direction: "out" }, { $set: { at: clock } });
      clock = new Date(clock.getTime() + 5 * MIN);

      // The second and third bounce: at three the mailbox's queue is paused for three days and its warm-up starts again.
      const second = await send();
      const third = await send();
      await bounce(second.draft.id);
      assert.equal(pausedNow(await account(), clock), undefined);
      const at = clock;
      await bounce(third.draft.id, at);
      const pause = pausedNow(await account(), at)!;
      assert.deepEqual([pause.kind, pause.until.getTime(), pause.reason], ["bounces", at.getTime() + BOUNCE_PAUSE_MS, "3 of its last 4 emails bounced"]);
      assert.equal(guardOf(await account()).rampSince?.getTime(), at.getTime());
      const notice = await db.collection("notification_outbox").find({ title: "Sending paused: too many bounces" }).toArray();
      assert.equal(notice.length, 1);
      assert.deepEqual([notice[0]!.userId, notice[0]!.resourceType, notice[0]!.resourceId], ["user-member", "channel_account", box.id]);
      assert.match(String(notice[0]!.body), /^member@acme\.example: 3 of its last 4 emails bounced, which hurts how mail servers rate your domain\. The send queue is paused until .* and then starts again at 5 a day\. Check the addresses of the emails that wait\.$/);
      assert.ok(await db.collection("audit_events").findOne({ action: "sales.channel.pause", objectId: box.id, "metadata.kind": "bounces" }));
      // Counting again changes nothing (the bounces before the pause are behind it).
      assert.equal(await checkBounces(db, box.id, new Date(at.getTime() + MIN)), false);
      assert.equal(await db.collection("notification_outbox").countDocuments({ title: "Sending paused: too many bounces" }), 1);

      // While it is paused the queue sends nothing from it; the email stays queued (untried) and waits for the pause to end.
      const lead = await newLead(expect);
      const waiting = await readyDraft(expect, lead.id);
      clock = new Date(at.getTime() + HOUR);
      assert.equal((await enqueueDraft(member, config, await stored(waiting.id), await leadOf(lead.id), { now: clock, gapMs: () => 4 * MIN })).queued, true);
      const sends = email.sends.length;
      assert.equal(await q.runOnce(), 0);
      assert.equal(email.sends.length, sends, "nothing goes while the mailbox is paused");
      const held = await stored(waiting.id);
      assert.deepEqual([held.status, held.sendQueue.attempts, held.queueHold, held.sendQueue.notBefore.toISOString()], ["ready", 0, undefined, inWorkingWindow(pause.until).toISOString()]);
      // The mailbox's card and the Autopilot card say so (they read the real clock: the pause is moved onto it for the look).
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "guard.pausedUntil": new Date(Date.now() + 2 * HOUR) } });
      const shown = channelAccountSchema.parse((await expect(200, "GET", "/sales/channels?ventureId=venture-a", "member")).data.find((item: any) => item.id === box.id));
      assert.equal(shown.protection?.pauseKind, "bounces");
      assert.match(String(shown.protection?.pauseNote), /^The send queue is paused for member@acme\.example until .*: 3 of its last 4 emails bounced\.$/);
      const status = await autopilotBlockers(db, { ...config, SALES_AUTOPILOT: "on" }, "workspace-a", "venture-a", autopilotSettingsSchema.parse({ enabled: true, send: "after_approval", runAsUserId: "user-member" }));
      assert.ok(status.partial.some((blocker) => blocker.step === "send" && /^The send queue is paused for member@acme\.example/.test(blocker.text)));
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "guard.pausedUntil": pause.until } });

      // When the pause is over it sends again, from 5 a day.
      clock = new Date(inWorkingWindow(pause.until).getTime() + MIN);
      assert.equal(pausedNow(await account(), clock), undefined);
      assert.equal(await q.runOnce(), 1);
      assert.equal((await stored(waiting.id)).status, "sent");
      assert.equal(await mailboxDayLimit(db, await account(), 20, today(), DEFAULT_CALENDAR), WARMUP_START);
    }, "guard_bounces");
  } finally { email.restore(); }
});

test("the mail server's push-back: a refused password, \"slow down\" and a block pause the mailbox and keep the emails queued; a refused address leaves the queue at once and is remembered", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member: SalesCtx = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app", channel: "api", workspaceId: "workspace-a", settings: new Map() };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const box = (await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).data;
      const account = async () => (await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!;
      let clock = T0;
      const q = createSendQueue({ database, env: config, now: () => clock, gapMs: () => 4 * MIN, log: () => undefined });
      const queue = async () => {
        const lead = await newLead(expect);
        const draft = await readyDraft(expect, lead.id);
        assert.equal((await enqueueDraft(member, config, await stored(draft.id), (await db.collection("opportunities").findOne({ _id: lead.id }))!, { now: clock, gapMs: () => 4 * MIN })).queued, true);
        return { lead, draft };
      };
      const unpause = async () => db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $unset: { "guard.pausedUntil": "", "guard.pauseKind": "", "guard.pauseReason": "", "guard.pausedAt": "" } });

      // A refused password: one try, then the whole queue of this mailbox waits (no three tries per email, no notice per email).
      email.state.answer = async () => ({ state: "failed", kind: "password", error: "The mailbox refused the username or password: check them" });
      const a = await queue();
      const b = await queue();
      assert.equal(await q.runOnce(), 0);
      assert.equal(email.sends.length, 1);
      let pause = pausedNow(await account(), clock)!;
      assert.deepEqual([pause.kind, pause.until.getTime(), pause.reason], ["password", clock.getTime() + PASSWORD_PAUSE_MS, "The mailbox refused its password: enter it again in Sales > Channels"]);
      for (const id of [a.draft.id, b.draft.id]) {
        const waiting = await stored(id);
        assert.deepEqual([waiting.status, waiting.sendQueue.attempts, waiting.sendQueue.notBefore.getTime(), waiting.queueHold, waiting.sendLock], ["ready", 0, clock.getTime() + PASSWORD_PAUSE_MS, undefined, undefined]);
      }
      const notices = await db.collection("notification_outbox").find({ resourceType: { $in: ["draft", "channel_account"] } }).toArray();
      assert.equal(notices.length, 1);
      assert.deepEqual([notices[0]!.title, notices[0]!.userId, notices[0]!.resourceType], ["Your mailbox needs its password again", "user-member", "channel_account"]);
      assert.match(String(notices[0]!.body), /^member@acme\.example: The mailbox refused its password: enter it again in Sales > Channels\. The emails wait in the send queue\.$/);
      clock = new Date(clock.getTime() + 10 * MIN);
      assert.equal(await q.runOnce(), 0);
      assert.equal(email.sends.length, 1, "nothing is tried while it waits for its password");
      // The mailbox's card says so (it reads the real clock: the pause is moved onto it for the look).
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "guard.pausedUntil": new Date(Date.now() + HOUR) } });
      const shown = channelAccountSchema.parse((await expect(200, "GET", "/sales/channels?ventureId=venture-a", "member")).data.find((item: any) => item.id === box.id));
      assert.equal(shown.protection?.pauseNote, "The send queue is paused for member@acme.example: The mailbox refused its password: enter it again in Sales > Channels.");
      // The password is entered again: the pause is lifted at once, and the emails that waited for it are due.
      email.state.answer = async (request) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to });
      await expect(200, "PATCH", `/sales/channels/${box.id}`, "member", { secrets: { password: "a-new-app-password-9921" } });
      assert.equal(pausedNow(await account(), clock), undefined);
      assert.equal(guardOf(await account()).pauseKind, undefined);
      // (The route reads the real clock; with the test's clock the same call pulls the waiting emails forward.)
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "guard.pauseKind": "password", "guard.pausedUntil": new Date(clock.getTime() + HOUR) } });
      assert.equal(await clearPause(db, await account(), "password", clock), true);
      assert.equal(await clearPause(db, await account(), "password", clock), false);
      assert.deepEqual([(await stored(a.draft.id)).sendQueue.notBefore.getTime(), (await stored(b.draft.id)).sendQueue.notBefore.getTime()], [clock.getTime(), clock.getTime()]);
      assert.equal(await q.runOnce(), 1);
      clock = new Date(clock.getTime() + 5 * MIN);
      assert.equal(await q.runOnce(), 1);
      assert.deepEqual([(await stored(a.draft.id)).status, (await stored(b.draft.id)).status], ["sent", "sent"]);
      // A passing test lifts a password pause too; a pause for bounces stays.
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "guard.pauseKind": "password", "guard.pausedUntil": new Date(Date.now() + HOUR) } });
      await expect(200, "POST", `/sales/channels/${box.id}/test`, "member");
      assert.equal(guardOf(await account()).pausedUntil, undefined);
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "guard.pauseKind": "bounces", "guard.pausedUntil": new Date(Date.now() + HOUR) } });
      await expect(200, "POST", `/sales/channels/${box.id}/test`, "member");
      assert.equal(guardOf(await account()).pauseKind, "bounces");
      await unpause();

      // "Slow down" (a 4xx answer): an hour's pause. A block: until the next working day at 10:00. The email is still queued, untried.
      clock = new Date(clock.getTime() + 10 * MIN);
      email.state.answer = async () => ({ state: "failed", kind: "slow_down", error: "The mail server asked to try again later (451 4.7.1 try later)" });
      const slow = await queue();
      assert.equal(await q.runOnce(), 0);
      pause = pausedNow(await account(), clock)!;
      assert.deepEqual([pause.kind, pause.until.getTime()], ["slow_down", clock.getTime() + SLOW_DOWN_PAUSE_MS]);
      // (One second behind the pause's end: the email that got the answer goes to the back of its sender's line.)
      assert.deepEqual([(await stored(slow.draft.id)).sendQueue.attempts, (await stored(slow.draft.id)).sendQueue.waits, (await stored(slow.draft.id)).sendQueue.notBefore.getTime()], [0, 1, clock.getTime() + SLOW_DOWN_PAUSE_MS + 1_000]);
      assert.equal(await db.collection("notification_outbox").countDocuments({ title: "Sending slowed down" }), 1);
      clock = new Date(clock.getTime() + SLOW_DOWN_PAUSE_MS + MIN);
      email.state.answer = async () => ({ state: "failed", kind: "blocked", error: "The mail server refused to send it (550 5.7.0 daily sending limit exceeded)" });
      assert.equal(await q.runOnce(), 0);
      pause = pausedNow(await account(), clock)!;
      assert.deepEqual([pause.kind, pause.until.toISOString(), pause.reason], ["blocked", ist("2026-11-24T10:00:00").toISOString(), "The mail server limited or blocked sending from this mailbox"]);
      assert.deepEqual([(await stored(slow.draft.id)).sendQueue.attempts, (await stored(slow.draft.id)).sendQueue.waits, (await stored(slow.draft.id)).sendQueue.notBefore.toISOString(), (await stored(slow.draft.id)).status], [0, 2, ist("2026-11-24T10:00:01").toISOString(), "ready"]);
      assert.equal(await db.collection("notification_outbox").countDocuments({ title: "Sending paused by the mail server" }), 1);
      // The next working day it goes.
      email.state.answer = async (request) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to });
      clock = ist("2026-11-24T10:01:00");
      assert.equal(await q.runOnce(), 1);
      assert.equal((await stored(slow.draft.id)).status, "sent");

      // A refused address: out of the queue after one try, with the server's words, and remembered so nothing goes to it again.
      clock = new Date(clock.getTime() + 10 * MIN);
      const sendsBefore = email.sends.length;
      email.state.answer = async () => ({ state: "failed", kind: "address", error: "The mail server refused the lead's address (550 5.1.1 User unknown): check that it is right" });
      const wrong = await queue();
      assert.equal(await q.runOnce(), 0);
      assert.equal(email.sends.length, sendsBefore + 1);
      const out = await stored(wrong.draft.id);
      assert.deepEqual([out.status, out.sendQueue, out.delivery.state], ["ready", undefined, "failed"]);
      assert.match(String(out.queueHold.reason), /refused the lead's address \(550 5\.1\.1 User unknown\)/);
      assert.equal(pausedNow(await account(), clock), undefined, "one wrong address pauses nothing");
      const bad = (await db.collection(BAD_ADDRESSES).findOne({ _id: `workspace-a:${wrong.lead.contactRoutes[0].value}` as never }))!;
      assert.equal(bad.kind, "refused");
      const retry = await enqueueDraft(member, config, await stored(wrong.draft.id), (await db.collection("opportunities").findOne({ _id: wrong.lead.id }))!, { now: clock });
      assert.match((retry as { reason: string }).reason, /was refused by the mail server on .* so the app won't email it again/);

      // An email that alone keeps being told "slow down" while the others go: after each pause it goes to the back of the line, and from
      // its third such answer on it is that email's own failed try (15 minutes, three tries), not another pause for the whole mailbox.
      clock = new Date(clock.getTime() + 10 * MIN);
      const stubborn = await queue();
      const fine = await queue();
      const stubbornTo = stubborn.lead.contactRoutes[0].value as string;
      email.state.answer = async (request) => (request.to === stubbornTo ? { state: "failed", kind: "slow_down", error: "The mail server asked to try again later (451 4.7.1 try later)" } : { state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to });
      assert.equal(await q.runOnce(), 0);
      const firstPause = pausedNow(await account(), clock)!;
      assert.equal(firstPause.kind, "slow_down");
      assert.deepEqual([(await stored(stubborn.draft.id)).sendQueue.waits, (await stored(stubborn.draft.id)).sendQueue.notBefore.getTime(), (await stored(fine.draft.id)).sendQueue.notBefore.getTime()], [1, firstPause.until.getTime() + 1_000, firstPause.until.getTime()]);
      clock = new Date(firstPause.until.getTime());
      assert.equal(await q.runOnce(), 1, "the other email goes first after the pause");
      assert.equal((await stored(fine.draft.id)).status, "sent");
      clock = new Date(clock.getTime() + 5 * MIN);
      assert.equal(await q.runOnce(), 0);
      const secondPause = pausedNow(await account(), clock)!;
      assert.deepEqual([secondPause.kind, (await stored(stubborn.draft.id)).sendQueue.waits, (await stored(stubborn.draft.id)).sendQueue.attempts], ["slow_down", 2, 0]);
      clock = new Date(secondPause.until.getTime() + 2_000);
      assert.equal(await q.runOnce(), 0);
      assert.equal(pausedNow(await account(), clock), undefined, "no third pause for the whole mailbox");
      const own = (await stored(stubborn.draft.id)).sendQueue;
      assert.deepEqual([own.attempts, own.waits, own.notBefore.getTime()], [1, 2, clock.getTime() + 15 * MIN]);
      assert.match(String(own.lastError), /asked to try again later/);
    }, "guard_pushback");
  } finally { email.restore(); }
});

test("the domain's records and the lead's mail server: automatic sending waits for SPF and DMARC, approved emails still go, and an address whose domain takes no mail never leaves", { skip }, async () => {
  const email = standIn();
  const dns = fakeDns({
    txt: { "acme.example": ["v=spf1 include:_spf.hostinger.example ~all"] },
    mx: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`guardlead${index}.example`, ["mx.guard.example"]])),
  });
  const restoreDns = useGuardDnsForTests(dns);
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member: SalesCtx = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app", channel: "api", workspaceId: "workspace-a", settings: new Map() };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const box = (await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).data;
      const account = async () => (await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!;
      await db.collection("sales_settings").updateOne({ _id: "venture-a" as never, workspaceId: "workspace-a" }, { $set: { autopilot: { enabled: true, send: "automatic", runAsUserId: "user-member" } } }, { upsert: true });
      let clock = T0;
      const q = createSendQueue({ database, env: config, now: () => clock, gapMs: () => 4 * MIN, log: () => undefined });
      const queue = async (auto: boolean, extra: Record<string, unknown> = {}) => {
        const lead = await newLead(expect, extra);
        const draft = await readyDraft(expect, lead.id);
        const result = await enqueueDraft(member, config, await stored(draft.id), (await db.collection("opportunities").findOne({ _id: lead.id }))!, { now: clock, gapMs: () => 4 * MIN, ...(auto ? { auto: true } : {}) });
        assert.equal(result.queued, true, JSON.stringify(result));
        return { lead, draft };
      };

      // No DMARC record on acme.example: the automatic email waits (still queued, untried) and its sender is told once.
      const auto = await queue(true);
      assert.equal(await q.runOnce(), 0);
      assert.equal(email.sends.length, 0);
      const waiting = await stored(auto.draft.id);
      assert.deepEqual([waiting.status, waiting.sendQueue.attempts, waiting.sendQueue.notBefore.getTime(), waiting.queueHold], ["ready", 0, clock.getTime() + DNS_RECHECK_MS, undefined]);
      assert.deepEqual([guardOf(await account()).dns?.spf, guardOf(await account()).dns?.dmarc], ["ok", "missing"]);
      const notice = await db.collection("notification_outbox").find({ title: "Automatic sending is waiting" }).toArray();
      assert.equal(notice.length, 1);
      assert.deepEqual([notice[0]!.userId, notice[0]!.resourceType, notice[0]!.resourceId], ["user-member", "channel_account", box.id]);
      assert.match(String(notice[0]!.body), /^acme\.example has no DMARC record, so mail servers can't tell its mail is really yours and may treat it as spam: add it where the domain is managed\. Until then nothing is sent without a person's approval; approved emails still go\.$/);
      // The mailbox's card, its Test button and the Autopilot card say what is missing.
      const shown = channelAccountSchema.parse((await expect(200, "GET", "/sales/channels?ventureId=venture-a", "member")).data.find((item: any) => item.id === box.id));
      assert.match(String(shown.protection?.domainNote), /^acme\.example has no DMARC record.*managed\.$/);
      const tested = (await expect(200, "POST", `/sales/channels/${box.id}/test`, "member")).data;
      assert.equal(tested.ok, true, "the mailbox itself works: the test passes");
      assert.deepEqual(tested.checks.at(-1).name, "Domain records (SPF, DMARC)");
      assert.equal(tested.checks.at(-1).ok, false);
      const status = await autopilotBlockers(db, { ...config, SALES_AUTOPILOT: "on" }, "workspace-a", "venture-a", autopilotSettingsSchema.parse({ enabled: true, send: "automatic", runAsUserId: "user-member" }));
      assert.ok(status.partial.some((blocker) => blocker.step === "send" && /^Automatic sending waits: acme\.example has no DMARC record/.test(blocker.text)));

      // An email a person approved goes all the same.
      const approved = await queue(false);
      await db.collection("sales_drafts").updateOne({ _id: approved.draft.id }, { $set: { "sendQueue.notBefore": clock } });
      assert.equal(await q.runOnce(), 1);
      assert.equal((await stored(approved.draft.id)).status, "sent");

      // The record is added and the person presses Test (it looks the records up again): the automatic email goes on its next turn.
      dns.resolveTxt = async (name) => { if (name === "acme.example") return [["v=spf1 ~all"]]; if (name === "_dmarc.acme.example") return [["v=DMARC1; p=none; rua=mailto:dmarc@acme.example"]]; throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); };
      const fine = (await expect(200, "POST", `/sales/channels/${box.id}/test`, "member")).data;
      assert.deepEqual([fine.checks.at(-1).name, fine.checks.at(-1).ok, fine.checks.at(-1).detail], ["Domain records (SPF, DMARC)", true, "Found: mail servers can tell this domain's mail is really yours"]);
      assert.deepEqual([guardOf(await account()).dns?.spf, guardOf(await account()).dns?.dmarc], ["ok", "ok"]);
      clock = new Date(clock.getTime() + DNS_RECHECK_MS + MIN);
      assert.equal(await q.runOnce(), 1);
      assert.equal((await stored(auto.draft.id)).status, "sent");
      assert.equal(channelAccountSchema.parse((await expect(200, "GET", "/sales/channels?ventureId=venture-a", "member")).data.find((item: any) => item.id === box.id)).protection?.domainNote, undefined);

      // The lead's domain doesn't exist: nothing is sent, the email leaves the queue with the reason and the address is remembered.
      clock = new Date(clock.getTime() + 10 * MIN);
      const sends = email.sends.length;
      const dead = await queue(false, { contactRoutes: [{ kind: "email", value: "owner@no-such-company-anywhere.example" }] });
      assert.equal(await q.runOnce(), 0);
      assert.equal(email.sends.length, sends);
      const out = await stored(dead.draft.id);
      assert.deepEqual([out.status, out.sendQueue], ["ready", undefined]);
      assert.equal(out.queueHold.reason, "owner@no-such-company-anywhere.example can't receive mail (its domain has no mail server): put another address on the lead");
      assert.equal((await db.collection(BAD_ADDRESSES).findOne({ _id: "workspace-a:owner@no-such-company-anywhere.example" as never }))!.kind, "no_mail_server");
      const told = (await db.collection("notification_outbox").findOne({ resourceType: "draft", resourceId: dead.draft.id }))!;
      assert.match(String(told.body), /can't receive mail \(its domain has no mail server\)/);
      const again = await enqueueDraft(member, config, await stored(dead.draft.id), (await db.collection("opportunities").findOne({ _id: dead.lead.id }))!, { now: clock });
      assert.match((again as { reason: string }).reason, /^owner@no-such-company-anywhere\.example can't receive mail \(its domain has no mail server\), so the app won't email it again/);
    }, "guard_records");
  } finally { restoreDns(); email.restore(); }
});
