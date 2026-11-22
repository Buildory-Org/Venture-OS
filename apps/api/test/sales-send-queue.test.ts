import assert from "node:assert/strict";
import test from "node:test";
import { draftBatchResultSchema, draftSchema, successEnvelope } from "@venture-studio/contracts";
import { internalHeaders } from "../src/internal-auth.js";
import { actorFor } from "../src/middleware.js";
import { useProviderForTests, type SendOutcome, type SendRequest } from "../src/sales/channels/provider.js";
import { AUTO_OFF, HELD, MAX_ATTEMPTS, NO_MAILBOX, RETRY_MS, createSendQueue, dropAutoQueued, enqueueDraft, sendQueueEnabled, unqueueDraft } from "../src/sales/channels/send-queue.js";
import type { SalesCtx } from "../src/sales/ctx.js";
import { DEFAULT_CALENDAR, inWorkingWindow, workCalendar } from "../src/sales/workdays.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// The send queue and "approve several drafts at once" (docs/sales-autopilot.md section 5; sales/channels/send-queue.ts, POST /drafts/batch).
// No real network: the mail provider is a stand-in (useProviderForTests). The worker gets an injected clock and gap, so its timing is exact.

const skip = !process.env.TEST_MONGODB_URI;
const PASSWORD = "queue-app-pass-7781-hidden";
const MIN = 60_000;
/** Monday 2026-11-23, 10:30 in India (the default venture calendar): inside a working window. */
const T0 = new Date("2026-11-23T05:00:00Z");
const ist = (iso: string) => new Date(`${iso}+05:30`);

type Reply = { status: number; text: string; body: any; data: any };
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
  settings: { address, senderName: "Mem Ber", username: address, smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" }, imap: { host: "imap.gmail.com", port: 993, security: "ssl" } },
  secrets: { password: PASSWORD },
});

/** The stand-in mail provider: records each call and answers with `answer` (sent, after a short wait so two workers can overlap). */
function standIn() {
  const sends: SendRequest[] = [];
  const state = { answer: async (request: SendRequest): Promise<SendOutcome> => { await new Promise((resolve) => setTimeout(resolve, 30)); return { state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to }; } };
  const restore = useProviderForTests({ kind: "email", test: async () => ({ ok: true, message: "Connected", checks: [] }), send: async (request) => { sends.push(request); return state.answer(request); } });
  return { sends, state, restore };
}

let leadCount = 0;
async function newLead(expect: Expect, owner = "member", extra: Record<string, unknown> = {}) {
  const name = `Queue Lead ${++leadCount}`;
  return (await expect(201, "POST", "/sales/leads", owner, { pipelineId: "pipeline-a", companyName: name, ownerId: `user-${owner}`, contactName: "Asha", contactRoutes: [{ kind: "email", value: `asha${leadCount}@lead${leadCount}.example` }, { kind: "phone", value: "98765 43210" }], ...extra })).data;
}
async function readyDraft(expect: Expect, leadId: string, extra: Record<string, unknown> = {}, author = "member") {
  const draft = (await expect(201, "POST", `/sales/leads/${leadId}/drafts`, author, { channel: "email", subject: "Orders on the phone", body: "Hello Asha, a short note about dealer orders.", submit: true, ...extra })).data;
  return (await expect(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" })).data;
}

test("the working window: inside it stays, before 10:00 waits for 10:00, after 19:00 or on a day off goes to the next working day", () => {
  assert.equal(inWorkingWindow(ist("2026-11-23T10:30:00")).toISOString(), ist("2026-11-23T10:30:00").toISOString());
  assert.equal(inWorkingWindow(ist("2026-11-23T08:15:00")).toISOString(), ist("2026-11-23T10:00:00").toISOString());
  assert.equal(inWorkingWindow(ist("2026-11-23T19:00:00")).toISOString(), ist("2026-11-24T10:00:00").toISOString());
  assert.equal(inWorkingWindow(ist("2026-11-23T18:59:59")).toISOString(), ist("2026-11-23T18:59:59").toISOString());
  // Saturday evening skips Sunday (not a working day by default); the festival blackout days are skipped too.
  assert.equal(inWorkingWindow(ist("2026-11-28T20:00:00")).toISOString(), ist("2026-11-30T10:00:00").toISOString());
  assert.equal(inWorkingWindow(ist("2026-11-05T19:30:00"), DEFAULT_CALENDAR).toISOString(), ist("2026-11-12T10:00:00").toISOString());
  // A venture's own calendar: Monday to Friday in London, a blackout on Tuesday.
  const london = workCalendar({ workingDays: [1, 2, 3, 4, 5], blackoutDates: ["2026-11-24"], timezone: "Europe/London" });
  assert.equal(inWorkingWindow(new Date("2026-11-23T19:30:00Z"), london).toISOString(), "2026-11-25T10:00:00.000Z");
  assert.equal(inWorkingWindow(new Date("2026-11-23T12:00:00Z"), london).toISOString(), "2026-11-23T12:00:00.000Z");
  assert.equal(sendQueueEnabled({ SALES_AUTOPILOT: "on", NODE_ENV: "test" }), false);
  assert.equal(sendQueueEnabled({ SALES_AUTOPILOT: "off", NODE_ENV: "production" }), false);
  assert.equal(sendQueueEnabled({ SALES_AUTOPILOT: "on", NODE_ENV: "production" }), true);
});

test("enqueue refuses what a send would refuse, in plain words; spaces one sender's messages and keeps them in working hours", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const ctxFor = async (handle: string): Promise<SalesCtx> => ({ database, db, actor: (await actorFor(db, { id: `user-${handle}`, email: `${handle}@example.invalid`, name: `Person ${handle}` }))!, via: "app", channel: "api", workspaceId: "workspace-a", settings: new Map() });
      const member = await ctxFor("member");
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const storedLead = async (id: string) => (await db.collection("opportunities").findOne({ _id: id }))!;
      const lead = await newLead(expect);
      const draft = await readyDraft(expect, lead.id);
      const refused = async (ctx: SalesCtx, draftDoc: any, leadDoc: any, pattern: RegExp) => {
        const result = await enqueueDraft(ctx, config, draftDoc, leadDoc, { now: T0, gapMs: () => 4 * MIN });
        assert.equal(result.queued, false);
        assert.match((result as { reason: string }).reason, pattern);
      };
      const d = await stored(draft.id);
      const l = await storedLead(lead.id);
      // No mailbox yet.
      await refused(member, d, l, /^Connect your mailbox to send from the app/);
      assert.equal(NO_MAILBOX, "Connect your mailbox to send from the app: Sales > Channels");
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      await refused(member, { ...d, channel: "whatsapp" }, l, /^WhatsApp is sent by hand/);
      await refused(member, { ...d, channel: "linkedin" }, l, /^LinkedIn is sent by hand/);
      await refused(member, { ...d, status: "in_review" }, l, /Only a draft that passed review \(ready\)/);
      await refused(member, { ...d, status: "sent" }, l, /already sent/);
      await refused(member, { ...d, sendLock: { requestId: "x" } }, l, /being sent already/);
      await refused(member, { ...d, sendQueue: { at: T0, by: "user-member" } }, l, /already queued/);
      await refused(member, d, { ...l, doNotContact: true }, /do-not-contact list/);
      await refused(member, d, { ...l, contactRoutes: [{ kind: "phone", value: "98765 43210" }] }, /no email address/);
      // A teammate who isn't the lead's owner can't send it; a read-only person neither.
      await refused(await ctxFor("member2"), d, l, /Only the lead's owner or a venture head can send this draft/);
      await refused(await ctxFor("learner"), d, l, /read-only/);
      // The version rule: another version of this first message is being sent.
      const whatsappVersion = (await expect(201, "POST", `/sales/leads/${lead.id}/drafts`, "member", { channel: "whatsapp", body: "Hello Asha", submit: true })).data;
      await db.collection("sales_drafts").updateOne({ _id: whatsappVersion.id }, { $set: { sendLock: { requestId: "other" } } });
      await refused(member, d, l, /WhatsApp version of this first message is being sent/);
      await db.collection("sales_drafts").updateOne({ _id: whatsappVersion.id }, { $unset: { sendLock: "" } });
      // A mailbox named that isn't usable.
      const other = (await expect(201, "POST", "/sales/channels", "member2", mailbox("member2@acme.example"))).data;
      const named = await enqueueDraft(member, config, d, l, { now: T0, accountId: other.id });
      assert.equal(named.queued, false);
      assert.equal(email.sends.length, 0);
      assert.equal((await stored(draft.id)).sendQueue, undefined, "nothing refused was queued");

      // Queued: the first goes now, the next ones 4 minutes apart (the injected gap); `version` is the updatedAt this write set.
      const queued = await enqueueDraft(member, config, d, l, { now: T0, gapMs: () => 4 * MIN });
      assert.deepEqual(queued, { queued: true, notBefore: T0 });
      const entry = (await stored(draft.id)).sendQueue;
      assert.deepEqual([entry.by, entry.version.getTime(), entry.notBefore.getTime(), entry.attempts, entry.auto], ["user-member", T0.getTime(), T0.getTime(), 0, undefined]);
      assert.equal((await stored(draft.id)).updatedAt.getTime(), T0.getTime());
      assert.ok(await db.collection("audit_events").findOne({ action: "sales.draft.queue", objectId: draft.id }));
      await refused(member, await stored(draft.id), l, /already queued/);
      const notBefores: number[] = [];
      for (let index = 0; index < 2; index++) {
        const next = await newLead(expect);
        const nextDraft = await readyDraft(expect, next.id);
        const result = await enqueueDraft(member, config, await stored(nextDraft.id), await storedLead(next.id), { now: T0, gapMs: () => 4 * MIN, auto: true });
        assert.equal(result.queued, true);
        notBefores.push((result as { notBefore: Date }).notBefore.getTime());
      }
      assert.deepEqual(notBefores, [T0.getTime() + 4 * MIN, T0.getTime() + 8 * MIN]);
      // Late in the day: now is later than the last slot plus the gap, so it goes now; the one after falls past 19:00 and waits for the next
      // working day at 10:00.
      const lateSlots: Date[] = [];
      for (let index = 0; index < 2; index++) {
        const late = await newLead(expect);
        const lateDraft = await readyDraft(expect, late.id);
        const lateResult = await enqueueDraft(member, config, await stored(lateDraft.id), await storedLead(late.id), { now: ist("2026-11-23T18:58:00"), gapMs: () => 4 * MIN });
        lateSlots.push((lateResult as { notBefore: Date }).notBefore);
      }
      assert.deepEqual(lateSlots.map((slot) => slot.toISOString()), [ist("2026-11-23T18:58:00").toISOString(), ist("2026-11-24T10:00:00").toISOString()]);
      // Another sender is spaced on their own.
      const theirs = await newLead(expect, "member2");
      const theirDraft = await readyDraft(expect, theirs.id, {}, "member2");
      assert.deepEqual(await enqueueDraft(await ctxFor("member2"), config, await stored(theirDraft.id), await storedLead(theirs.id), { now: T0, gapMs: () => 4 * MIN }), { queued: true, notBefore: T0 });

      // Out of the queue: the person who queued it, a head or an admin; nobody else.
      await assert.rejects(unqueueDraft(await ctxFor("member2"), await stored(draft.id)), /Only the person who queued it, a venture head or an admin/);
      assert.equal(await unqueueDraft(await ctxFor("lead"), await stored(draft.id)), true);
      assert.equal((await stored(draft.id)).sendQueue, undefined);
      assert.equal(await unqueueDraft(member, await stored(draft.id)), false);
      assert.ok(await db.collection("audit_events").findOne({ action: "sales.draft.unqueue", objectId: draft.id, actorId: "user-lead" }));
    }, "queue_enqueue");
  } finally { email.restore(); }
});

test("the worker: sends as the sender, spaced, once even with two workers; a changed draft, a blocker or a lost member leaves the queue unsent, with a notice", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app" as const, channel: "api" as const, workspaceId: "workspace-a", settings: new Map() };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      const queue = async (now = T0, owner = member, handle = "member") => {
        const lead = await newLead(expect, handle);
        const draft = await readyDraft(expect, lead.id, {}, handle);
        const result = await enqueueDraft(owner, config, await stored(draft.id), (await db.collection("opportunities").findOne({ _id: lead.id }))!, { now, gapMs: () => 4 * MIN });
        assert.equal(result.queued, true, JSON.stringify(result));
        return { lead, draft };
      };
      const logs: Record<string, unknown>[] = [];
      let clock = T0;
      const worker = (gap = 5 * MIN) => createSendQueue({ database, env: config, now: () => clock, gapMs: () => gap, log: (line) => logs.push(line) });
      const notices = async (draftId: string) => db.collection("notification_outbox").find({ resourceType: "draft", resourceId: draftId }).toArray();

      // Two due for the same sender: one per tick, and the other is pushed to at least the gap after this send.
      const first = await queue();
      const second = await queue();
      const q = worker();
      clock = new Date(T0.getTime() - MIN);
      assert.equal(await q.runOnce(), 0, "nothing is due before its time");
      clock = new Date(T0.getTime() + 10 * MIN);
      assert.equal(await q.runOnce(), 1);
      assert.equal(email.sends.length, 1);
      const sent = await stored(first.draft.id);
      assert.deepEqual([sent.status, sent.sendQueue, sent.sentBy, sent.sentVia, sent.queueClaim], ["sent", undefined, "user-member", "smtp", undefined]);
      assert.equal(email.sends[0]!.idempotencyKey, `draft-${first.draft.id}-1`);
      assert.equal(sent.sendLog[0].requestId, `queue-${first.draft.id}-${T0.getTime()}-0`, "the requestId is fixed per draft, queue entry and attempt");
      const activity = (await db.collection("sales_activities").findOne({ draftId: first.draft.id, direction: "out" }))!;
      assert.deepEqual([activity.via, activity.actorId], ["app", "user-member"]);
      const sentAudit = (await db.collection("audit_events").findOne({ action: "sales.draft.sent", objectId: first.draft.id }))!;
      assert.deepEqual([sentAudit.channel, sentAudit.actorId], ["engine", "user-member"]);
      assert.equal((await stored(second.draft.id)).sendQueue.notBefore.getTime(), clock.getTime() + 5 * MIN);
      assert.equal(await q.runOnce(), 0, "the next one waits for the gap");
      clock = new Date(clock.getTime() + 5 * MIN);
      assert.equal(await q.runOnce(), 1);
      assert.equal((await stored(second.draft.id)).status, "sent");
      // One log line per send, without the message or the address.
      const sendLines = logs.filter((line) => line.event === "sales.send_queue.send");
      assert.deepEqual(sendLines.map((line) => line.outcome), ["sent", "sent"]);
      assert.ok(!JSON.stringify(logs).includes("@") && !JSON.stringify(logs).includes("dealer orders"));
      const day = await db.collection("sales_autopilot_days").findOne({ _id: "venture-a:2026-11-23" as never });
      assert.equal(day?.sent, 2);

      // Two workers at the same moment: the draft goes once.
      const race = await queue(clock);
      clock = new Date(clock.getTime() + 10 * MIN);
      const before = email.sends.length;
      const counts = await Promise.all([worker().runOnce(), worker().runOnce(), q.runOnce()]);
      assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
      assert.equal(email.sends.length, before + 1);
      assert.equal(await db.collection("sales_activities").countDocuments({ draftId: race.draft.id, direction: "out" }), 1);

      // A head's approval after it was queued changes no text: it stays queued and goes.
      const approvedLater = await queue(clock);
      await expect(200, "POST", `/sales/drafts/${approvedLater.draft.id}/approve`, "lead", {});
      const approvedEntry = (await stored(approvedLater.draft.id)).sendQueue;
      assert.equal(approvedEntry.version.getTime(), (await stored(approvedLater.draft.id)).updatedAt.getTime());
      clock = new Date(clock.getTime() + 10 * MIN);
      assert.equal(await q.runOnce(), 1);
      assert.equal((await stored(approvedLater.draft.id)).status, "sent");

      // A person edits a queued draft: it leaves the queue at once (back to review).
      const edited = await queue(clock);
      const patched = (await expect(200, "PATCH", `/sales/drafts/${edited.draft.id}`, "member", { body: "Hello Asha, a new text." })).data;
      assert.deepEqual([patched.status, patched.sendQueue], ["in_review", undefined]);
      // Changed some other way (the stored version moved): the worker takes it out unsent, audits why and tells the sender.
      const changed = await queue(clock);
      await db.collection("sales_drafts").updateOne({ _id: changed.draft.id }, { $set: { updatedAt: new Date(clock.getTime() + 1) } });
      clock = new Date(clock.getTime() + 10 * MIN);
      const sendsBefore = email.sends.length;
      await q.runOnce();
      assert.equal(email.sends.length, sendsBefore, "a changed draft is never sent");
      const changedNow = await stored(changed.draft.id);
      assert.deepEqual([changedNow.status, changedNow.sendQueue], ["ready", undefined]);
      const changedAudit = (await db.collection("audit_events").findOne({ action: "sales.draft.unqueue", objectId: changed.draft.id }))!;
      assert.match(String(changedAudit.metadata.reason), /changed after it was queued/);
      assert.equal(changedAudit.channel, "engine");
      const [changedNotice] = await notices(changed.draft.id);
      assert.deepEqual([changedNotice?.userId, changedNotice?.type, changedNotice?.title], ["user-member", "sales_needs_you", `Not sent: email to ${changed.lead.companyName}`]);
      assert.match(String(changedNotice?.body), /changed after it was queued.*open the draft/i);

      // A blocker: the lead is put on the do-not-contact list after it was queued (its drafts are discarded by the rule).
      const blocked = await queue(clock);
      await expect(201, "POST", "/sales/suppression", "lead", { kind: "email", value: blocked.lead.contactRoutes[0].value, reason: "Asked us to stop" });
      clock = new Date(clock.getTime() + 10 * MIN);
      await q.runOnce();
      const blockedNow = await stored(blocked.draft.id);
      assert.deepEqual([blockedNow.status, blockedNow.sendQueue], ["discarded", undefined]);
      assert.match(String((await notices(blocked.draft.id))[0]?.body), /discarded: The lead is on the do-not-contact list/);
      // A mailbox switched off meanwhile: refused at the send, out of the queue with what fixes it.
      const noBox = await queue(clock);
      await db.collection("sales_channel_accounts").updateMany({ ownerUserId: "user-member" }, { $set: { enabled: false } });
      clock = new Date(clock.getTime() + 10 * MIN);
      await q.runOnce();
      assert.equal((await stored(noBox.draft.id)).sendQueue, undefined);
      assert.match(String((await notices(noBox.draft.id))[0]?.body), /No email account is connected for you/);
      await db.collection("sales_channel_accounts").updateMany({ ownerUserId: "user-member" }, { $set: { enabled: true } });
      // The sender is no longer an active member: out of the queue, nothing sent as them.
      const gone = await queue(clock);
      await db.collection("memberships").updateOne({ userId: "user-member" }, { $set: { status: "removed" } });
      clock = new Date(clock.getTime() + 10 * MIN);
      const sendsNow = email.sends.length;
      await q.runOnce();
      assert.equal(email.sends.length, sendsNow);
      assert.equal((await stored(gone.draft.id)).sendQueue, undefined);
      assert.match(String((await db.collection("audit_events").findOne({ action: "sales.draft.unqueue", objectId: gone.draft.id }))!.metadata.reason), /no longer an active member/);
      await db.collection("memberships").updateOne({ userId: "user-member" }, { $set: { status: "active" } });

      // Outside working hours the worker waits for the next window instead of sending.
      const evening = await queue(clock);
      clock = ist("2026-11-23T20:00:00");
      await q.runOnce();
      assert.equal((await stored(evening.draft.id)).sendQueue.notBefore.toISOString(), ist("2026-11-24T10:00:00").toISOString());
    }, "queue_worker");
  } finally { email.restore(); }
});

test("the worker: a provider failure retries in 15 minutes and stops after 3 tries; an unclear send leaves the queue; the day's cap waits for the next working day", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app" as const, channel: "api" as const, workspaceId: "workspace-a", settings: new Map() };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      const queue = async (now: Date) => {
        const lead = await newLead(expect);
        const draft = await readyDraft(expect, lead.id);
        assert.equal((await enqueueDraft(member, config, await stored(draft.id), (await db.collection("opportunities").findOne({ _id: lead.id }))!, { now, gapMs: () => 4 * MIN })).queued, true);
        return draft;
      };
      let clock = T0;
      const q = createSendQueue({ database, env: config, now: () => clock, gapMs: () => 4 * MIN, log: () => undefined });

      email.state.answer = async () => ({ state: "failed", error: "Gmail refused the password: use an app password" });
      const failing = await queue(T0);
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        await q.runOnce();
        const entry = (await stored(failing.id)).sendQueue;
        assert.deepEqual([entry.attempts, entry.lastError, entry.notBefore.getTime()], [attempt, "Gmail refused the password: use an app password", clock.getTime() + RETRY_MS]);
        clock = entry.notBefore;
      }
      await q.runOnce();
      assert.equal(email.sends.length, MAX_ATTEMPTS);
      assert.deepEqual(new Set(email.sends.map((send) => send.idempotencyKey)).size, MAX_ATTEMPTS, "each try is its own attempt");
      const failed = await stored(failing.id);
      assert.deepEqual([failed.status, failed.sendQueue, failed.sendLock], ["ready", undefined, undefined]);
      const notice = (await db.collection("notification_outbox").findOne({ resourceId: failing.id }))!;
      assert.match(String(notice.body), /^It didn't go after 3 tries: Gmail refused the password/);

      // Unclear: the person says whether it went (it stays locked, out of the queue) and is told.
      email.state.answer = async () => ({ state: "uncertain", error: "The connection broke while the message was on its way" });
      clock = new Date(clock.getTime() + 10 * MIN);
      const unclear = await queue(clock);
      await q.runOnce();
      const unclearNow = await stored(unclear.id);
      assert.deepEqual([unclearNow.status, unclearNow.delivery.state, unclearNow.sendQueue, Boolean(unclearNow.sendLock)], ["ready", "uncertain", undefined, true]);
      assert.match(String((await db.collection("notification_outbox").findOne({ resourceId: unclear.id }))!.body), /couldn't confirm it went out/);
      const sends = email.sends.length;
      await q.runOnce();
      assert.equal(email.sends.length, sends, "an unclear send is never tried again by the queue");

      // The cap: 2 emails a day, one already used by the unclear send (it stays counted). The next goes; the one after waits for the next
      // working day at 10:00, quietly.
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { dailyCaps: { email: 2 } });
      email.state.answer = async (request) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to });
      clock = new Date(clock.getTime() + 10 * MIN);
      const one = await queue(clock);
      const two = await queue(clock);
      assert.equal(await q.runOnce(), 1);
      assert.equal((await stored(one.id)).status, "sent");
      clock = (await stored(two.id)).sendQueue.notBefore;
      assert.equal(await q.runOnce(), 0);
      const waiting = await stored(two.id);
      assert.equal(waiting.status, "ready");
      assert.deepEqual([waiting.sendQueue.attempts, waiting.sendQueue.lastError, waiting.sendQueue.notBefore.toISOString()], [0, undefined, ist("2026-11-24T10:00:00").toISOString()]);
      assert.equal(await db.collection("notification_outbox").countDocuments({ resourceId: two.id }), 0, "a reached cap tells nobody");
    }, "queue_failures");
  } finally { email.restore(); }
});

test("POST /drafts/batch: a person only; each draft on its own; approve follows the approve route's rules; approve and send; unqueue; the Overview splits queued drafts out", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, origin }) => {
      const { call, expect } = caller(api);
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const batch = async (handle: string, body: unknown, status = 200) => draftBatchResultSchema.parse(successEnvelope(draftBatchResultSchema).parse((await expect(status, "POST", "/sales/drafts/batch", handle, body)).body).data);
      const lead = await newLead(expect);
      const draft = await readyDraft(expect, lead.id);

      // Claude never reaches it.
      const claude = await fetch(`${origin}/v1/sales/drafts/batch`, { method: "POST", headers: { "content-type": "application/json", ...internalHeaders("user-lead") }, body: JSON.stringify({ action: "approve", drafts: [{ id: draft.id }] }) });
      assert.equal(claude.status, 403);
      assert.equal((await stored(draft.id)).personApproval, undefined);
      await expect(400, "POST", "/sales/drafts/batch", "lead", { action: "approve", drafts: [] });

      // A play's first batch: only a head's approvals count, through the batch exactly as through the approve route.
      await db.collection("sales_plays").insertOne({ _id: "play-q", workspaceId: "workspace-a", ventureId: "venture-a", name: "Queue play", status: "running", batchSize: 2, firstBatchReviewed: false, createdAt: new Date(), updatedAt: new Date() });
      const p1 = await readyDraft(expect, (await newLead(expect, "member", { playId: "play-q" })).id);
      const p2 = await readyDraft(expect, (await newLead(expect, "member", { playId: "play-q" })).id);
      const byMember = await batch("member", { action: "approve", drafts: [{ id: p1.id }, { id: p2.id }] });
      assert.deepEqual([byMember.approved, byMember.skipped, byMember.results[0]!.reason], [0, 2, "Only a venture head or admin can approve a draft"]);
      const sendFirst = await batch("member", { action: "send", drafts: [{ id: p1.id }] });
      assert.match(String(sendFirst.results[0]!.reason), /first batch of a play needs a person's approval/);
      const byHead = await batch("lead", { action: "approve", drafts: [{ id: p1.id }, { id: p2.id }, { id: "no-such-draft" }] });
      assert.deepEqual(byHead.results.map((row) => row.outcome), ["approved", "approved", "skipped"]);
      assert.deepEqual([byHead.approved, byHead.skipped, byHead.results[2]!.reason], [2, 1, "Draft not found"]);
      assert.deepEqual([(await stored(p1.id)).personApproval.byHead, (await db.collection("sales_plays").findOne({ _id: "play-q" }))!.firstBatchReviewed], [true, true]);
      assert.equal(await db.collection("audit_events").countDocuments({ action: "sales.draft.approve", objectId: { $in: [p1.id, p2.id] } }), 2);
      // A stale version is skipped; a person's own reply is approved by its author already.
      const stale = await batch("lead", { action: "approve", drafts: [{ id: draft.id, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }] });
      assert.match(String(stale.results[0]!.reason), /changed since you opened it/);

      // Every message needs a person from here on.
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { approvalMode: "person_approves_every_message" });
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      const a = await readyDraft(expect, (await newLead(expect)).id);
      const b = await readyDraft(expect, (await newLead(expect)).id);
      const waLead = await newLead(expect);
      const wa = await readyDraft(expect, waLead.id, { channel: "whatsapp", subject: undefined, body: "Hello Asha" });
      const inReview = (await expect(201, "POST", `/sales/leads/${(await newLead(expect)).id}/drafts`, "member", { channel: "email", subject: "S", body: "Hello", submit: true })).data;
      // `send` alone doesn't approve.
      const notApproved = await batch("member", { action: "send", drafts: [{ id: b.id }] });
      assert.deepEqual([notApproved.queued, notApproved.results[0]!.reason], [0, "This venture needs a person's approval for every message before it is sent"]);
      // Someone who may not approve (not the lead's owner) gets the reason, and nothing changes.
      const notTheirs = await batch("member2", { action: "approve_and_send", drafts: [{ id: b.id }] });
      assert.deepEqual([notTheirs.approved, notTheirs.queued], [0, 0]);
      assert.match(String(notTheirs.results[0]!.reason), /Only the lead's owner or a venture head can send this draft/);
      assert.equal((await stored(b.id)).personApproval, undefined);

      const result = await batch("member", { action: "approve_and_send", drafts: [{ id: a.id }, { id: b.id }, { id: wa.id }, { id: inReview.id }, { id: a.id }] });
      assert.deepEqual(result.results.map((row) => [row.id, row.outcome]), [[a.id, "approved_and_queued"], [b.id, "approved_and_queued"], [wa.id, "approved"], [inReview.id, "skipped"]]);
      assert.deepEqual([result.approved, result.queued, result.unqueued, result.skipped], [3, 2, 0, 1]);
      assert.equal(result.results[2]!.reason, "WhatsApp is sent by hand: only emails go out from the send queue");
      assert.match(String(result.results[3]!.reason), /Only a draft that passed review/);
      const times = [result.results[0]!.notBefore!, result.results[1]!.notBefore!];
      assert.deepEqual([result.firstSendAt, result.lastSendAt], times);
      const spacing = Date.parse(times[1]!) - Date.parse(times[0]!);
      assert.ok(spacing >= 3 * MIN && spacing <= 5 * MIN, `spaced 3 to 5 minutes (${spacing} ms)`);
      const queuedA = await stored(a.id);
      assert.deepEqual([queuedA.sendQueue.by, queuedA.personApproval.by, queuedA.sendQueue.version.getTime()], ["user-member", "user-member", queuedA.updatedAt.getTime()]);
      assert.equal((await stored(wa.id)).personApproval.by, "user-member", "the WhatsApp draft stays approved");
      // No mailbox: approved, with what fixes it.
      const theirs = await readyDraft(expect, (await newLead(expect, "member2")).id, {}, "member2");
      const noBox = await batch("member2", { action: "approve_and_send", drafts: [{ id: theirs.id }] });
      assert.deepEqual([noBox.results[0]!.outcome, noBox.results[0]!.reason], ["approved", NO_MAILBOX]);

      // Lists: a queued draft is in neither "to review" nor "ready to send"; counts say how many wait for approval and how many are queued.
      const overview = (await expect(200, "GET", "/sales/overview?ventureId=venture-a", "lead")).data;
      const listed = [...overview.toReview, ...overview.readyToSend].map((row: { id: string }) => row.id);
      assert.ok(!listed.includes(a.id) && !listed.includes(b.id));
      assert.equal(overview.counts.queuedToSend, 2);
      const toApprove = await db.collection("sales_drafts").countDocuments({ status: "ready", personApproval: null, channel: { $ne: "call_opener" } });
      assert.equal(overview.counts.toApprove, toApprove);
      assert.ok(overview.counts.toApprove >= 1 && overview.counts.toReview >= overview.counts.toApprove);
      const ready = (await expect(200, "GET", "/sales/drafts?status=ready&ventureId=venture-a", "member")).data as unknown[];
      const row = draftSchema.parse(ready.find((item: any) => item.id === a.id));
      assert.equal(row.sendQueue?.by, "user-member");
      assert.equal((ready.find((item: any) => item.id === a.id) as any).queueClaim, undefined);

      // Out of the queue: not by a teammate; by the person who queued it or a head.
      const denied = await batch("member2", { action: "unqueue", drafts: [{ id: a.id }] });
      assert.match(String(denied.results[0]!.reason), /Only the person who queued it, a venture head or an admin/);
      const out = await batch("lead", { action: "unqueue", drafts: [{ id: a.id }, { id: inReview.id }] });
      assert.deepEqual([out.unqueued, out.skipped, out.results[1]!.reason], [1, 1, "This draft is not queued to send"]);
      assert.equal((await stored(a.id)).sendQueue, undefined);
      assert.equal((await expect(200, "GET", "/sales/overview?ventureId=venture-a", "lead")).data.counts.queuedToSend, 1);

      // Vetoing, discarding, marking sent by hand and sending through the mailbox each take a queued draft out of the queue.
      const requeue = async (id: string) => assert.equal((await batch("member", { action: "send", drafts: [{ id }] })).queued, 1);
      await requeue(a.id);
      await expect(200, "POST", `/sales/drafts/${a.id}/veto`, "member2", { reason: "Wrong tone" });
      assert.equal((await stored(a.id)).sendQueue, undefined);
      assert.equal((await stored(b.id)).sendQueue?.by, "user-member");
      await expect(200, "POST", `/sales/drafts/${b.id}/discard`, "member", {});
      assert.equal((await stored(b.id)).sendQueue, undefined);
      const c = await readyDraft(expect, (await newLead(expect)).id);
      assert.equal((await batch("member", { action: "approve_and_send", drafts: [{ id: c.id }] })).queued, 1);
      await expect(201, "POST", `/sales/drafts/${c.id}/sent`, "member", {});
      assert.deepEqual([(await stored(c.id)).status, (await stored(c.id)).sendQueue], ["sent", undefined]);
      const e = await readyDraft(expect, (await newLead(expect)).id);
      assert.equal((await batch("member", { action: "approve_and_send", drafts: [{ id: e.id }] })).queued, 1);
      await expect(201, "POST", `/sales/drafts/${e.id}/send`, "member", { requestId: "req-by-hand-0001" });
      assert.deepEqual([(await stored(e.id)).status, (await stored(e.id)).sendQueue], ["sent", undefined]);
      assert.equal((await call("GET", "/sales/overview?ventureId=venture-a", "lead")).data.counts.queuedToSend, 0);
    }, "queue_batch");
  } finally { email.restore(); }
});

test("holds and the venture's switch: taken out stays out for the autopilot, automatic entries stop when automatic sending stops, a person's stay", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const ctxFor = async (handle: string): Promise<SalesCtx> => ({ database, db, actor: (await actorFor(db, { id: `user-${handle}`, email: `${handle}@example.invalid`, name: `Person ${handle}` }))!, via: "app", channel: "api", workspaceId: "workspace-a", settings: new Map() });
      const member = await ctxFor("member");
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      const leadOf = async (id: string) => (await db.collection("opportunities").findOne({ _id: id }))!;
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      const fresh = async () => { const lead = await newLead(expect); return { lead, draft: await readyDraft(expect, lead.id) }; };
      const enqueue = async (id: string, leadId: string, now: Date, auto = false) => enqueueDraft(member, config, await stored(id), await leadOf(leadId), { now, gapMs: () => 4 * MIN, ...(auto ? { auto: true } : {}) });
      const autopilot = async (value: Record<string, unknown>) => db.collection("sales_settings").updateOne({ _id: "venture-a" as never, workspaceId: "workspace-a" }, { $set: { autopilot: value } }, { upsert: true });
      let clock = T0;
      const q = createSendQueue({ database, env: config, now: () => clock, gapMs: () => 5 * MIN, log: () => undefined });

      // A head takes it back: held; the autopilot can't queue it again, a person can (which lifts the hold).
      const a = await fresh();
      assert.equal((await enqueue(a.draft.id, a.lead.id, clock)).queued, true);
      assert.equal(await unqueueDraft(await ctxFor("lead"), await stored(a.draft.id), clock), true);
      assert.deepEqual([(await stored(a.draft.id)).queueHold.by, (await stored(a.draft.id)).queueHold.reason], ["user-lead", "Taken out of the send queue by Person lead"]);
      assert.deepEqual(await enqueue(a.draft.id, a.lead.id, clock, true), { queued: false, reason: HELD });
      assert.equal((await stored(a.draft.id)).sendQueue, undefined);
      assert.equal((await enqueue(a.draft.id, a.lead.id, clock)).queued, true);
      assert.equal((await stored(a.draft.id)).queueHold, undefined, "a person queueing it lifts the hold");
      await unqueueDraft(member, await stored(a.draft.id), clock);
      // The worker takes one out (it changed): held too, so the autopilot doesn't queue the same failure round after round.
      const b = await fresh();
      assert.equal((await enqueue(b.draft.id, b.lead.id, clock, true)).queued, true);
      await db.collection("sales_drafts").updateOne({ _id: b.draft.id }, { $set: { updatedAt: new Date(clock.getTime() + 1) } });
      await autopilot({ enabled: true, runAsUserId: "user-member", send: "automatic" });
      await q.runOnce();
      assert.match(String((await stored(b.draft.id)).queueHold?.reason), /changed after it was queued/);
      assert.deepEqual(await enqueue(b.draft.id, b.lead.id, clock, true), { queued: false, reason: HELD });

      // dropAutoQueued: the autopilot's entries leave (no hold), not one locked by a send in progress, not a person's.
      clock = new Date(clock.getTime() + 10 * MIN);
      const [auto1, auto2, own] = [await fresh(), await fresh(), await fresh()];
      for (const [row, auto] of [[auto1, true], [auto2, true], [own, false]] as const) assert.equal((await enqueue(row.draft.id, row.lead.id, clock, auto)).queued, true);
      await db.collection("sales_drafts").updateOne({ _id: auto2.draft.id }, { $set: { sendLock: { requestId: "in-flight" } } });
      assert.equal(await dropAutoQueued({ db, workspaceId: "workspace-a" }, "venture-a", "The autopilot was switched off", clock), 1);
      const dropped = await stored(auto1.draft.id);
      assert.deepEqual([dropped.sendQueue, dropped.queueHold], [undefined, undefined]);
      assert.ok((await stored(auto2.draft.id)).sendQueue && (await stored(own.draft.id)).sendQueue);
      assert.equal((await db.collection("audit_events").findOne({ action: "sales.draft.unqueue", objectId: auto1.draft.id }))!.metadata.reason, "The autopilot was switched off");
      assert.equal((await enqueue(auto1.draft.id, auto1.lead.id, clock, true)).queued, true, "no hold: the autopilot may queue it again once it sends automatically");
      await db.collection("sales_drafts").updateMany({ _id: { $in: [auto1.draft.id, auto2.draft.id, own.draft.id] } }, { $unset: { sendQueue: "", sendLock: "" } });

      // The worker checks the switch itself before sending an automatic entry.
      const sends = () => email.sends.length;
      clock = new Date(clock.getTime() + 10 * MIN);
      const goes = await fresh();
      assert.equal((await enqueue(goes.draft.id, goes.lead.id, clock, true)).queued, true);
      assert.equal(await q.runOnce(), 1, "on, automatic, as this person: it goes");
      for (const [setting, why] of [[{ enabled: true, runAsUserId: "user-member", send: "by_hand" }, "by hand"], [{ enabled: false, runAsUserId: "user-member", send: "automatic" }, "off"], [{ enabled: true, runAsUserId: "user-lead", send: "automatic" }, "another person"]] as const) {
        await autopilot(setting);
        clock = new Date(clock.getTime() + 10 * MIN);
        const auto = await fresh();
        assert.equal((await enqueue(auto.draft.id, auto.lead.id, clock, true)).queued, true);
        const mine = await fresh();
        assert.equal((await enqueue(mine.draft.id, mine.lead.id, clock)).queued, true);
        const before = sends();
        await q.runOnce();
        const autoNow = await stored(auto.draft.id);
        assert.deepEqual([autoNow.status, autoNow.sendQueue, autoNow.queueHold, sends()], ["ready", undefined, undefined, before], why);
        const why2 = (await db.collection("audit_events").findOne({ action: "sales.draft.unqueue", objectId: auto.draft.id }))!;
        assert.equal(why2.metadata.reason, AUTO_OFF);
        assert.equal(await db.collection("notification_outbox").countDocuments({ resourceId: auto.draft.id }), 0);
        // A person's own entry is untouched by the switch: it goes on the next tick.
        clock = new Date((await stored(mine.draft.id)).sendQueue.notBefore.getTime() + 6 * MIN);
        assert.equal(await q.runOnce(), 1, why);
        assert.equal((await stored(mine.draft.id)).status, "sent");
      }
    }, "queue_holds");
  } finally { email.restore(); }
});

test("one sender's sends across two API processes: a second worker never sends for the same sender at once, and waits for the gap", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app" as const, channel: "api" as const, workspaceId: "workspace-a", settings: new Map() };
      const stored = async (id: string) => (await db.collection("sales_drafts").findOne({ _id: id }))!;
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      const queueTwo = async (at: Date) => {
        const ids: string[] = [];
        for (let index = 0; index < 2; index++) {
          const lead = await newLead(expect);
          const draft = await readyDraft(expect, lead.id);
          assert.equal((await enqueueDraft(member, config, await stored(draft.id), (await db.collection("opportunities").findOne({ _id: lead.id }))!, { now: at, gapMs: () => 4 * MIN })).queued, true);
          ids.push(draft.id);
        }
        // Both due at the same instant (as after the cap, or the night).
        await db.collection("sales_drafts").updateMany({ _id: { $in: ids } }, { $set: { "sendQueue.notBefore": at } });
        return ids;
      };
      let clock = T0;
      const worker = () => createSendQueue({ database, env: config, now: () => clock, gapMs: () => 5 * MIN, log: () => undefined });
      const sentOf = async (ids: string[]) => (await db.collection("sales_drafts").find({ _id: { $in: ids }, status: "sent" }).toArray()).map((row) => String(row._id));

      // Worker B runs while worker A is in the middle of sending (inside the provider call): B sends nothing for this sender.
      const first = await queueTwo(clock);
      const a = worker();
      const b = worker();
      let fromB: number | undefined;
      const sendAnswer = email.state.answer;
      email.state.answer = async (request) => { if (fromB === undefined) fromB = await b.runOnce(); return sendAnswer(request); };
      assert.equal(await a.runOnce(), 1);
      email.state.answer = sendAnswer;
      assert.equal(fromB, 0);
      assert.equal((await sentOf(first)).length, 1);
      const waiting = first.find((id) => !(email.sends.map((send) => send.idempotencyKey).includes(`draft-${id}-1`)))!;
      assert.ok((await stored(waiting)).sendQueue.notBefore.getTime() >= clock.getTime() + 5 * MIN, "the other waits at least the gap");

      // Two workers at the same moment: exactly one goes.
      clock = new Date(clock.getTime() + 30 * MIN);
      await db.collection("sales_drafts").updateOne({ _id: waiting }, { $unset: { sendQueue: "" } });
      const second = await queueTwo(clock);
      const counts = await Promise.all([worker().runOnce(), worker().runOnce()]);
      assert.equal(counts[0]! + counts[1]!, 1);
      assert.equal((await sentOf(second)).length, 1);

      // The last send was less than the gap ago (another process put a draft back on that instant): it waits, never sent in the same second.
      const other = (await stored(second[0]!)).status === "sent" ? second[1]! : second[0]!;
      await db.collection("sales_drafts").updateOne({ _id: other }, { $set: { "sendQueue.notBefore": clock } });
      const before = email.sends.length;
      assert.equal(await worker().runOnce(), 0);
      assert.equal(email.sends.length, before);
      assert.ok((await stored(other)).sendQueue.notBefore.getTime() >= clock.getTime() + 5 * MIN);
    }, "queue_senders");
  } finally { email.restore(); }
});

test("replies, proposals and other messages are never queued; the batch approves them and says why they weren't queued", { skip }, async () => {
  const email = standIn();
  try {
    await withSalesApp(async ({ api, db, database, config }) => {
      const { expect } = caller(api);
      const member = { database, db, actor: (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!, via: "app" as const, channel: "api" as const, workspaceId: "workspace-a", settings: new Map() };
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { approvalMode: "person_approves_every_message" });
      const lead = await newLead(expect);
      const now = new Date();
      await db.collection("sales_activities").insertOne({ _id: "inbound-q1", workspaceId: "workspace-a", ventureId: "venture-a", leadId: lead.id, actorId: "user-member", via: "app", kind: "email", direction: "in", body: "Interested, send details", at: now, createdAt: now });
      const reply = await readyDraft(expect, lead.id, { purpose: "reply", inReplyTo: "inbound-q1", subject: "Re: Orders", checkByClaude: true });
      const storedReply = (await db.collection("sales_drafts").findOne({ _id: reply.id }))!;
      const storedLead = (await db.collection("opportunities").findOne({ _id: lead.id }))!;
      assert.equal(storedReply.status, "ready");
      assert.deepEqual(await enqueueDraft(member, config, { ...storedReply, personApproval: { by: "user-member" } }, storedLead), { queued: false, reason: "A reply is sent right away from the Inbox, not from the queue" });
      for (const purpose of ["proposal", "other"]) {
        const refused = await enqueueDraft(member, config, { ...storedReply, purpose, personApproval: { by: "user-member" } }, storedLead);
        assert.deepEqual(refused, { queued: false, reason: "Only first messages and follow-ups go out from the send queue: send this one yourself" });
      }
      const result = draftBatchResultSchema.parse((await expect(200, "POST", "/sales/drafts/batch", "member", { action: "approve_and_send", drafts: [{ id: reply.id }] })).data);
      assert.deepEqual([result.results[0]!.outcome, result.results[0]!.reason, result.approved, result.queued], ["approved", "A reply is sent right away from the Inbox, not from the queue", 1, 0]);
      assert.equal((await db.collection("sales_drafts").findOne({ _id: reply.id }))!.sendQueue, undefined);
    }, "queue_replies");
  } finally { email.restore(); }
});

test("PUT /sales/settings keeps the stored autopilot; GET returns it", { skip }, async () => {
  await withSalesApp(async ({ api, db }) => {
    const { expect } = caller(api);
    const autopilot = { enabled: true, runAsUserId: "user-lead", find: { enabled: false, request: "", places: [], perDay: 10 }, judge: true, write: true, review: true, followUps: true, replies: false, send: "automatic", dailyLeadLimit: 30 };
    await db.collection("sales_settings").updateOne({ _id: "venture-a" as never, workspaceId: "workspace-a" }, { $set: { autopilot } }, { upsert: true });
    const saved = (await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { workingDays: [1, 2, 3, 4, 5], autopilot: { enabled: false } })).data;
    assert.deepEqual([saved.workingDays, saved.autopilot.enabled, saved.autopilot.send, saved.autopilot.replies], [[1, 2, 3, 4, 5], true, "automatic", false]);
    assert.deepEqual((await db.collection("sales_settings").findOne({ _id: "venture-a" as never }))!.autopilot, autopilot);
    const read = (await expect(200, "GET", "/sales/settings?ventureId=venture-a", "member")).data;
    assert.deepEqual([read.autopilot.enabled, read.autopilot.runAsUserId, read.autopilot.dailyLeadLimit, read.workingDays], [true, "user-lead", 30, [1, 2, 3, 4, 5]]);
  }, "queue_settings");
});
