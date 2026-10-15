import assert from "node:assert/strict";
import test from "node:test";
import { channelAccountSchema, channelAccountTestSchema, draftSchema, successEnvelope } from "@venture-studio/contracts";
import { internalHeaders } from "../src/internal-auth.js";
import { useProviderForTests, type ChannelProvider, type SendOutcome, type SendRequest } from "../src/sales/channels/provider.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Connected accounts and sending drafts through them (docs/sales-channels.md sections 1, 2 and 7; routes/sales-channels.ts,
// routes/sales-drafts.ts, sales/channels/dispatch.ts). No real network: every provider is a stand-in (useProviderForTests), and the
// passwords and tokens are fake. Every answer and every audit row is searched for them at the end of each test.

const skip = !process.env.TEST_MONGODB_URI;
const PASSWORD = "gmail-app-pass-zq81-hidden";
const PASSWORD_2 = "second-app-pass-55-other";
const TOKEN = "EAAGfake-meta-token-9f3k2x";
const APP_SECRET = "meta-app-secret-77qq";
const SECRETS = [PASSWORD, PASSWORD_2, TOKEN, APP_SECRET];

type Reply = { status: number; text: string; body: any; data: any };
/** The test's API calls, keeping every answer to search for secrets afterwards. */
function caller(api: (method: string, path: string, handle: string, body?: unknown) => Promise<Response>) {
  const texts: string[] = [];
  const call = async (method: string, path: string, handle: string, body?: unknown): Promise<Reply> => {
    const response = await api(method, path, handle, body);
    const text = await response.text();
    texts.push(text);
    const parsed = JSON.parse(text || "null");
    return { status: response.status, text, body: parsed, data: parsed?.data };
  };
  const expect = async (status: number, method: string, path: string, handle: string, body?: unknown) => {
    const reply = await call(method, path, handle, body);
    assert.equal(reply.status, status, `${method} ${path} as ${handle}: ${reply.text}`);
    return reply;
  };
  return { call, expect, texts };
}

/** No secret, and no part of one beyond its last four characters, anywhere in this text. */
function assertNoSecrets(text: string, where: string) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret.slice(0, -4)), `${where} carries a secret`);
}

const mailbox = (address: string, extra: Record<string, unknown> = {}) => ({
  kind: "email", label: `Mail ${address}`, ventureIds: ["venture-a"], defaultFor: ["venture-a"],
  settings: { address, senderName: "Mem Ber", username: address, smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" }, imap: { host: "imap.gmail.com", port: 993, security: "ssl" } },
  secrets: { password: PASSWORD }, ...extra,
});
const whatsappNumber = (phoneNumberId = "1234567890") => ({ kind: "whatsapp", label: "Alpha WhatsApp", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: { phoneNumberId, businessAccountId: "9876543210" }, secrets: { accessToken: TOKEN, appSecret: APP_SECRET } });
const account = (body: unknown) => successEnvelope(channelAccountSchema).parse(body).data;

/** A stand-in provider for one kind: records each call, answers with `answer` (sent by default). */
function standIn(kind: "email" | "whatsapp" | "instagram") {
  const sends: SendRequest[] = [];
  let tests = 0;
  const state = {
    answer: async (request: SendRequest): Promise<SendOutcome> => ({ state: "sent", externalId: kind === "email" ? `<${request.idempotencyKey}@acme.example>` : `wamid.${request.idempotencyKey}`, threadKey: kind === "email" ? request.inReplyTo?.threadKey ?? `<${request.idempotencyKey}@acme.example>` : undefined, to: request.to }),
    test: async (): Promise<any> => ({ ok: true, message: "Connected", checks: [{ name: "Sending (SMTP)", ok: true }] }),
  };
  const provider: ChannelProvider = { kind, test: async () => { tests++; return state.test(); }, send: async (request) => { sends.push(request); return state.answer(request); } };
  const restore = useProviderForTests(provider);
  return { sends, state, restore, get tests() { return tests; } };
}

async function newLead(expect: ReturnType<typeof caller>["expect"], name: string, owner = "member", extra: Record<string, unknown> = {}) {
  return (await expect(201, "POST", "/sales/leads", owner, { pipelineId: "pipeline-a", companyName: name, ownerId: `user-${owner}`, contactName: "Asha", contactRoutes: [{ kind: "email", value: `asha@${name.toLowerCase().replace(/\W+/g, "")}.example` }, { kind: "phone", value: "98765 43210" }], ...extra })).data;
}
async function readyDraft(expect: ReturnType<typeof caller>["expect"], leadId: string, body: Record<string, unknown> = {}, author = "member") {
  const draft = (await expect(201, "POST", `/sales/leads/${leadId}/drafts`, author, { channel: "email", subject: "Orders on the phone", body: "Hello Asha, a short note about dealer orders.", ...body })).data;
  // A reply a person writes to a message from the lead is ready at once (their own approval); everything else passes a review first.
  if (body.purpose === "reply" && body.inReplyTo) assert.equal(draft.status, "ready", "a person's own reply is ready at once");
  else { assert.equal(draft.status, "in_review"); await expect(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" }); }
  return draft;
}
const counter = async (db: any, channel: string, user = "user-member") => Number((await db.collection("sales_send_counters").findOne({ userId: user, channel }))?.count ?? 0);

test("connecting accounts: secrets never come back, who may connect, see and change what, one default per venture, duplicates refused, Claude refused", { skip }, async () => {
  await withSalesApp(async ({ api, db, origin }) => {
    const { call, expect, texts } = caller(api);
    const presets = await expect(200, "GET", "/sales/channels/presets", "member");
    assert.equal(presets.data.gmail.smtp.host, "smtp.gmail.com");

    // Who may connect: a writer for a personal mailbox (not a learner, not someone outside the venture), a head for a venture number.
    await expect(403, "POST", "/sales/channels", "learner", mailbox("learner@acme.example"));
    await expect(404, "POST", "/sales/channels", "outsider", mailbox("outsider@acme.example"));
    await expect(400, "POST", "/sales/channels", "member", mailbox("member@acme.example", { defaultFor: ["venture-b"] }));
    await expect(400, "POST", "/sales/channels", "member", { ...mailbox("member@acme.example"), settings: { phoneNumberId: "1234567890", businessAccountId: "9876543210" } });

    const created = await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
    const first = account(created.body);
    assert.deepEqual([first.kind, first.status, first.ownerUserId, first.canManage, first.ventureIds, first.defaultFor, first.enabled], ["email", "not_tested", "user-member", true, ["venture-a"], ["venture-a"], true]);
    // A mail password never keeps any of its characters: people see that it is saved, and when.
    assert.deepEqual(Object.keys(first.secrets.password!).sort(), ["set", "setAt"]);
    assert.deepEqual([first.secrets.password!.set, typeof first.secrets.password!.setAt], [true, "string"]);
    assert.equal(first.webhook, undefined);
    assert.equal((created.data as any).verifyToken, undefined);
    // At rest: a sealed value (ciphertext, IV, tag), never the password.
    const stored = (await db.collection("sales_channel_accounts").findOne({ _id: first.id }))!;
    assert.deepEqual(Object.keys(stored.secrets.password).sort(), ["data", "iv", "setAt", "setBy", "tag", "v"]);
    assertNoSecrets(JSON.stringify(stored), "the stored account");

    // One mailbox per person and address (any case): 409 in plain words.
    const duplicate = await expect(409, "POST", "/sales/channels", "member", mailbox("MEMBER@acme.example"));
    assert.match(duplicate.body.error.message, /already connected this mailbox/);
    // Someone else may connect the same address as their own mailbox (a shared inbox).
    await expect(201, "POST", "/sales/channels", "member2", { ...mailbox("member@acme.example"), secrets: { password: PASSWORD_2 } });

    // A second mailbox as the default for the venture takes the default from the first (per person and kind).
    const second = account((await expect(201, "POST", "/sales/channels", "member", mailbox("sales@acme.example"))).body);
    const mine = (await expect(200, "GET", "/sales/channels?kind=email", "member")).data as any[];
    assert.deepEqual(mine.map((row) => [row.id, row.defaultFor]).sort(), [[first.id, []], [second.id, ["venture-a"]]].sort());
    // member2's own default stays: the defaults are per person.
    const others = (await expect(200, "GET", "/sales/channels?kind=email", "member2")).data as any[];
    assert.deepEqual(others.map((row) => [row.ownerUserId, row.defaultFor]), [["user-member2", ["venture-a"]]]);

    // Who sees what: a teammate doesn't see member's mailbox; the head sees it (never a secret) but can't change it; an admin may only
    // switch it off or remove it.
    await expect(404, "PATCH", `/sales/channels/${first.id}`, "member2", { label: "Mine now" });
    const headView = (await expect(200, "GET", "/sales/channels?ventureId=venture-a", "lead")).data as any[];
    const seenByHead = headView.find((row) => row.id === first.id);
    assert.deepEqual([seenByHead.canManage, seenByHead.settings.address, seenByHead.secrets.password.set, seenByHead.secrets.password.last4], [false, "member@acme.example", true, undefined]);
    await expect(403, "PATCH", `/sales/channels/${first.id}`, "lead", { label: "Head's label" });
    await expect(403, "POST", `/sales/channels/${first.id}/test`, "lead");
    const adminView = (await expect(200, "GET", "/sales/channels", "boss")).data as any[];
    assert.equal(adminView.find((row) => row.id === first.id).canManage, true);
    const adminRename = await expect(403, "PATCH", `/sales/channels/${first.id}`, "boss", { label: "Admin's label" });
    assert.match(adminRename.body.error.message, /switch someone's mailbox off or remove it/);
    assert.equal(account((await expect(200, "PATCH", `/sales/channels/${first.id}`, "boss", { enabled: false })).body).enabled, false);
    await expect(200, "PATCH", `/sales/channels/${first.id}`, "member", { enabled: true });
    assert.deepEqual((await expect(200, "GET", "/sales/channels?ventureId=venture-b", "member")).data, []);

    // Changes: settings must fit the kind; a new password or server resets the status; a label doesn't; secrets are replaced one by one.
    await db.collection("sales_channel_accounts").updateOne({ _id: first.id }, { $set: { status: "connected", statusNote: "Connected" } });
    await expect(400, "PATCH", `/sales/channels/${first.id}`, "member", { settings: { phoneNumberId: "1234567890", businessAccountId: "9876543210" } });
    await expect(400, "PATCH", `/sales/channels/${first.id}`, "member", { secrets: { accessToken: TOKEN } });
    await expect(400, "PATCH", `/sales/channels/${first.id}`, "member", { defaultFor: ["venture-b"] });
    assert.equal(account((await expect(200, "PATCH", `/sales/channels/${first.id}`, "member", { label: "Work mail", settings: { ...mailbox("member@acme.example").settings, senderName: "Member Person" } })).body).status, "connected");
    const repassworded = account((await expect(200, "PATCH", `/sales/channels/${first.id}`, "member", { secrets: { password: PASSWORD_2 } })).body);
    assert.deepEqual([repassworded.status, repassworded.statusNote, repassworded.secrets.password?.set, repassworded.secrets.password?.last4], ["not_tested", undefined, true, undefined]);
    assert.ok(Date.parse(repassworded.secrets.password!.setAt!) >= Date.parse(first.secrets.password!.setAt!), "a new password has a new date");
    await db.collection("sales_channel_accounts").updateOne({ _id: first.id }, { $set: { status: "connected" } });
    const moved = account((await expect(200, "PATCH", `/sales/channels/${first.id}`, "member", { settings: { ...mailbox("member@acme.example").settings, imap: { host: "imap.zoho.in", port: 993, security: "ssl" } } })).body);
    assert.equal(moved.status, "not_tested");
    // Making the first the default again takes it back from the second.
    await expect(200, "PATCH", `/sales/channels/${first.id}`, "member", { defaultFor: ["venture-a"] });
    assert.deepEqual(account((await expect(200, "PATCH", `/sales/channels/${second.id}`, "member", { label: "Sales inbox" })).body).defaultFor, []);

    // Venture numbers: heads only; every member of the venture sees it; only its managers see the webhook details.
    await expect(403, "POST", "/sales/channels", "member", whatsappNumber());
    const number = account((await expect(201, "POST", "/sales/channels", "lead", whatsappNumber())).body);
    assert.deepEqual([number.ownerUserId, number.canManage, number.webhook?.url], [undefined, true, "http://localhost:3000/v1/webhooks/meta"]);
    assert.ok(number.webhook!.verifyToken.length >= 20);
    // Meta tokens of 16 characters or more keep their last four, shown only to the account's managers.
    assert.deepEqual([number.secrets.accessToken?.set, number.secrets.accessToken?.last4, number.secrets.appSecret?.set, number.secrets.appSecret?.last4], [true, "3k2x", true, "77qq"]);
    assert.equal(typeof number.secrets.accessToken?.setAt, "string");
    const memberSees = ((await expect(200, "GET", "/sales/channels?kind=whatsapp", "member")).data as any[])[0];
    assert.deepEqual([memberSees.id, memberSees.canManage, memberSees.webhook, memberSees.secrets.accessToken.set, memberSees.secrets.accessToken.last4, memberSees.secrets.appSecret.last4], [number.id, false, undefined, true, undefined, undefined]);
    await expect(403, "PATCH", `/sales/channels/${number.id}`, "member", { label: "Mine" });
    await expect(404, "PATCH", `/sales/channels/${number.id}`, "outsider", { label: "Mine" });
    const taken = await expect(409, "POST", "/sales/channels", "lead", { ...whatsappNumber(), label: "Again" });
    assert.match(taken.body.error.message, /already connected/);
    // A head of only one of two ventures can't add the other (and isn't head of venture-b).
    await expect(404, "POST", "/sales/channels", "lead", { ...whatsappNumber("2234567890"), ventureIds: ["venture-a", "venture-b"] });
    await expect(201, "POST", "/sales/channels", "boss", { ...whatsappNumber("2234567890"), ventureIds: ["venture-a", "venture-b"], defaultFor: [] });

    // Claude never reaches these routes (the hosted connector's calls come in with the internal headers).
    for (const [method, path] of [["GET", "/v1/sales/channels"], ["POST", "/v1/sales/channels"], ["POST", `/v1/sales/channels/${first.id}/test`], ["DELETE", `/v1/sales/channels/${first.id}`]] as const) {
      const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", ...internalHeaders("user-member") }, ...(method === "POST" && path.endsWith("channels") ? { body: JSON.stringify(mailbox("claude@acme.example")) } : {}) });
      assert.equal(response.status, 403, `${method} ${path} via Claude`);
    }
    assert.equal(await db.collection("sales_channel_accounts").countDocuments({ "settings.address": "claude@acme.example" }), 0);

    // Removing: a teammate can't; the admin can remove a person's mailbox; past activities would keep their account id.
    await expect(404, "DELETE", `/sales/channels/${second.id}`, "member2");
    assert.deepEqual((await expect(200, "DELETE", `/sales/channels/${second.id}`, "boss")).data, { deleted: true });
    assert.equal(await db.collection("sales_channel_accounts").countDocuments({ _id: second.id }), 0);

    // At most five mailboxes per person (each is read every few minutes): the sixth is refused in plain words; others still may connect.
    for (const name of ["two", "three", "four", "five"]) await expect(201, "POST", "/sales/channels", "member", { ...mailbox(`${name}@acme.example`), defaultFor: [] });
    const sixth = await expect(409, "POST", "/sales/channels", "member", { ...mailbox("six@acme.example"), defaultFor: [] });
    assert.match(sixth.body.error.message, /^You can connect at most 5 mailboxes: remove one you no longer use first$/);
    assert.equal(await db.collection("sales_channel_accounts").countDocuments({ kind: "email", ownerUserId: "user-member" }), 5);

    // The audit log: the kind and which fields changed, never a value; nothing anywhere carries a secret.
    const audits = await db.collection("audit_events").find({ action: /^sales\.channel\./ }).toArray();
    assert.ok(audits.length >= 10);
    for (const event of audits) assert.ok(Object.keys(event.metadata ?? {}).every((key) => ["kind", "fields", "ok"].includes(key)), JSON.stringify(event.metadata));
    assert.ok(audits.some((event) => event.action === "sales.channel.update" && event.metadata.fields === "secrets"));
    assertNoSecrets(JSON.stringify(await db.collection("audit_events").find({}).toArray()), "the audit log");
    for (const text of texts) assertNoSecrets(text, "an answer");
    assert.equal((await call("GET", "/sales/channels", "boss")).status, 200);
  }, "channels_accounts");
});

test("testing a connection: the result is stored, nothing is called without a readable secret, a test may teach the settings, 5 a minute", { skip }, async () => {
  const email = standIn("email");
  const whatsapp = standIn("whatsapp");
  try {
    await withSalesApp(async ({ api, db }) => {
      const { expect, texts } = caller(api);
      const box = account((await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).body);
      const passed = channelAccountTestSchema.parse((await expect(200, "POST", `/sales/channels/${box.id}/test`, "member")).data);
      assert.equal(passed.ok, true);
      const after = ((await expect(200, "GET", "/sales/channels", "member")).data as any[]).find((row) => row.id === box.id);
      assert.deepEqual([after.status, after.statusNote, typeof after.lastCheckedAt], ["connected", "Connected", "string"]);

      email.state.test = async () => ({ ok: false, message: "Gmail refused the password: use an app password (Google Account > Security > App passwords)", checks: [{ name: "Sending (SMTP)", ok: false }] });
      const refused = (await expect(200, "POST", `/sales/channels/${box.id}/test`, "member")).data;
      assert.equal(refused.ok, false);
      const failed = (await db.collection("sales_channel_accounts").findOne({ _id: box.id }))!;
      assert.deepEqual([failed.status, failed.lastError], ["needs_attention", refused.message]);
      assert.equal(email.tests, 2);

      // A password that no longer opens (sealed under another secret, damaged): a failed check, the provider isn't asked.
      const data = Buffer.from(failed.secrets.password.data, "base64"); data[0] = data[0]! ^ 0xff;
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "secrets.password.data": data.toString("base64") } });
      const unreadable = (await expect(200, "POST", `/sales/channels/${box.id}/test`, "member")).data;
      assert.deepEqual([unreadable.ok, unreadable.message, email.tests], [false, "The saved password can't be read any more: enter it again", 2]);
      assert.deepEqual(((await expect(200, "GET", "/sales/channels", "member")).data as any[]).find((row) => row.id === box.id).secrets.password, { set: false });
      await expect(404, "POST", `/sales/channels/${box.id}/test`, "member2");

      // A WhatsApp test may hand back what it learned (the number Meta shows): the fields its kind may learn are kept in the settings.
      const number = account((await expect(201, "POST", "/sales/channels", "lead", whatsappNumber())).body);
      whatsapp.state.test = async () => ({ ok: true, message: "Connected: +91 98765 43210", checks: [], learned: { displayNumber: "+91 98765 43210", other: "ignored" } });
      const learnt = await expect(200, "POST", `/sales/channels/${number.id}/test`, "lead");
      assert.deepEqual(learnt.data.learned, { displayNumber: "+91 98765 43210" });
      const kept = (await db.collection("sales_channel_accounts").findOne({ _id: number.id }))!;
      assert.deepEqual([kept.status, kept.settings.displayNumber, kept.settings.other], ["connected", "+91 98765 43210", undefined]);

      // Five tests a minute per person (eleven tries always span a full window).
      let limited: Reply | undefined;
      for (let index = 0; index < 11 && !limited; index++) {
        const reply = await caller(api).call("POST", `/sales/channels/${number.id}/test`, "boss");
        if (reply.status === 429) limited = reply; else assert.equal(reply.status, 200, reply.text);
      }
      assert.ok(limited, "the limit is reached");
      assert.match(limited.body.error.message, /Too many connection tests in a minute; try again in \d+ s/);
      const audits = await db.collection("audit_events").find({ action: "sales.channel.test" }).toArray();
      assert.ok(audits.every((event) => Object.keys(event.metadata).sort().join() === "kind,ok"));
      for (const text of texts) assertNoSecrets(text, "an answer");
    }, "channels_test_route");
  } finally { email.restore(); whatsapp.restore(); }
});

test("sending a draft through a mailbox: sent and logged, replayed, failed and given back, unclear and settled both ways", { skip }, async () => {
  const email = standIn("email");
  try {
    await withSalesApp(async ({ api, db }) => {
      const { call, expect, texts } = caller(api);
      const lead = await newLead(expect, "Sharma Pumps");
      const draft = await readyDraft(expect, lead.id);
      await expect(400, "POST", `/sales/drafts/${draft.id}/send`, "member", {});
      const none = await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-none-0001" });
      assert.match(none.body.error.message, /No email account is connected for you in this venture/);
      const box = account((await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).body);
      // Only the lead's owner (or a head) sends it; a teammate can't send through someone else's mailbox anyway.
      await expect(403, "POST", `/sales/drafts/${draft.id}/send`, "member2", { requestId: "req-other-0001" });
      await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "lead", { requestId: "req-head-00001", accountId: box.id });
      assert.equal(email.sends.length, 0);

      // Sent: the provider gets the lead's address, the subject, the plain text and a key per draft and attempt; the activity carries the message.
      const sent = await expect(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-sent-0001" });
      assert.equal(email.sends.length, 1);
      const request = email.sends[0]!;
      assert.deepEqual([request.to, request.toName, request.subject, request.body, request.idempotencyKey, String(request.account._id)], ["asha@sharmapumps.example", "Asha", "Orders on the phone", "Hello Asha, a short note about dealer orders.", `draft-${draft.id}-1`, box.id]);
      assert.equal(request.secrets.password, PASSWORD);
      const sentDraft = draftSchema.parse(sent.data.draft);
      assert.deepEqual([sentDraft.status, sentDraft.sentVia, sentDraft.sentAccountId, sentDraft.delivery?.state, sentDraft.sentBy], ["sent", "smtp", box.id, "sent", "user-member"]);
      assert.equal((sent.data.draft as any).sendLock, undefined);
      assert.deepEqual([sent.data.activity.kind, sent.data.activity.direction, sent.data.activity.draftId, sent.data.activity.stageTo, sent.data.activity.via], ["email", "out", draft.id, "contacted", "app"]);
      assert.deepEqual(sent.data.activity.message, { accountId: box.id, externalId: `<draft-${draft.id}-1@acme.example>`, threadKey: `<draft-${draft.id}-1@acme.example>`, subject: "Orders on the phone", from: "member@acme.example", to: "asha@sharmapumps.example", delivery: { state: "sent", at: sent.data.activity.message.delivery.at, accountId: box.id } });
      assert.match(sent.data.activity.body, /^Subject: Orders on the phone\n\nHello Asha/);
      assert.equal(sent.data.lead.stage, "contacted");
      assert.ok(sent.data.lead.followUpDueAt);
      assert.equal(await counter(db, "email"), 1);
      // The same requestId gets the first answer, without sending again; another request for a sent draft is refused.
      const again = await expect(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-sent-0001" });
      assert.equal(again.data.activity.id, sent.data.activity.id);
      assert.equal(email.sends.length, 1);
      await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-sent-0002" });
      assert.equal(await db.collection("sales_activities").countDocuments({ draftId: draft.id, direction: "out" }), 1);
      const audit = await db.collection("audit_events").findOne({ action: "sales.draft.sent", objectId: draft.id });
      assert.deepEqual(audit?.metadata, { channel: "email", sentVia: "smtp", stageTo: "contacted" });

      // Failed: 502 SEND_FAILED with the reason; the day's send is given back; the draft stays ready, unlocked, with the failure on it.
      const lead2 = await newLead(expect, "Verma Tiles");
      const draft2 = await readyDraft(expect, lead2.id);
      email.state.answer = async () => ({ state: "failed", error: "Gmail refused the password: use an app password (Google Account > Security > App passwords)" });
      const failed = await expect(502, "POST", `/sales/drafts/${draft2.id}/send`, "member", { requestId: "req-fail-0001" });
      assert.deepEqual([failed.body.error.code, failed.body.error.message], ["SEND_FAILED", "Gmail refused the password: use an app password (Google Account > Security > App passwords)"]);
      assert.equal(await counter(db, "email"), 1);
      const afterFail = (await db.collection("sales_drafts").findOne({ _id: draft2.id }))!;
      assert.deepEqual([afterFail.status, afterFail.sendLock, afterFail.delivery.state, afterFail.delivery.error, afterFail.sendAttempts], ["ready", undefined, "failed", failed.body.error.message, 1]);
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: lead2.id, direction: "out" }), 0);
      assert.equal((await db.collection("opportunities").findOne({ _id: lead2.id }))!.stage, "identified");
      // Its requestId repeats the failure without calling the provider; a new requestId tries again as attempt 2.
      await expect(502, "POST", `/sales/drafts/${draft2.id}/send`, "member", { requestId: "req-fail-0001" });
      assert.equal(email.sends.length, 2);
      email.state.answer = async (sending) => ({ state: "sent", externalId: `<${sending.idempotencyKey}@acme.example>`, to: sending.to });
      const retried = await expect(201, "POST", `/sales/drafts/${draft2.id}/send`, "member", { requestId: "req-fail-0002" });
      assert.equal(email.sends.at(-1)!.idempotencyKey, `draft-${draft2.id}-2`);
      assert.equal(retried.data.activity.message.externalId, `<draft-${draft2.id}-2@acme.example>`);
      assert.equal(await counter(db, "email"), 2);

      // Unclear: 202 with the draft; the send stays counted and the draft locked until a person says whether it went.
      const lead3 = await newLead(expect, "Gupta Steel");
      const draft3 = await readyDraft(expect, lead3.id);
      email.state.answer = async () => ({ state: "uncertain", error: "The mail server stopped answering while the message was being sent" });
      const unclear = await expect(202, "POST", `/sales/drafts/${draft3.id}/send`, "member", { requestId: "req-unclear-01" });
      assert.deepEqual([unclear.data.draft.status, unclear.data.draft.delivery.state, unclear.data.draft.delivery.error], ["ready", "uncertain", "The mail server stopped answering while the message was being sent"]);
      assert.equal(await counter(db, "email"), 3);
      assert.equal((await expect(202, "POST", `/sales/drafts/${draft3.id}/send`, "member", { requestId: "req-unclear-01" })).data.draft.delivery.state, "uncertain");
      const locked = await expect(409, "POST", `/sales/drafts/${draft3.id}/send`, "member", { requestId: "req-unclear-02" });
      assert.match(locked.body.error.message, /already being sent/);
      await expect(409, "POST", `/sales/drafts/${draft3.id}/sent`, "member", {});
      await expect(409, "PATCH", `/sales/drafts/${draft3.id}`, "member", { body: "Changed meanwhile" });
      await expect(409, "POST", `/sales/drafts/${draft3.id}/discard`, "member", {});
      assert.equal(email.sends.length, 4);
      // Settling: the lead's editor only, and only an unclear send.
      await expect(403, "POST", `/sales/drafts/${draft3.id}/delivery`, "member2", { outcome: "not_sent" });
      await expect(409, "POST", `/sales/drafts/${draft.id}/delivery`, "member", { outcome: "sent" });
      await expect(400, "POST", `/sales/drafts/${draft3.id}/delivery`, "member", { outcome: "maybe" });
      const notSent = await expect(200, "POST", `/sales/drafts/${draft3.id}/delivery`, "member", { outcome: "not_sent" });
      assert.deepEqual([notSent.data.draft.status, notSent.data.draft.sendLock, notSent.data.draft.delivery.state, notSent.data.draft.delivery.error], ["ready", undefined, "failed", "Not sent (confirmed by Person member)"]);
      assert.equal(await counter(db, "email"), 2, "today's counted send is given back");
      // Sent again, unclear again; this time the head says it went out: recorded as the sender's send, with our Message-ID, counted once.
      const unclearAgain = await expect(202, "POST", `/sales/drafts/${draft3.id}/send`, "member", { requestId: "req-unclear-03" });
      assert.equal(unclearAgain.data.draft.sendAttempts, 2);
      assert.equal(await counter(db, "email"), 3);
      const went = await expect(201, "POST", `/sales/drafts/${draft3.id}/delivery`, "lead", { outcome: "sent" });
      assert.deepEqual([went.data.draft.status, went.data.draft.sentVia, went.data.draft.sentAccountId, went.data.draft.delivery.state, went.data.draft.sendLock], ["sent", "smtp", box.id, "sent", undefined]);
      assert.deepEqual([went.data.activity.actorId, went.data.activity.kind, went.data.activity.direction, went.data.activity.message.accountId, went.data.activity.message.externalId, went.data.lead.stage], ["user-member", "email", "out", box.id, `<draft-${draft3.id}-2@acme.example>`, "contacted"]);
      assert.equal(await counter(db, "email"), 3, "the send was already counted");
      await expect(409, "POST", `/sales/drafts/${draft3.id}/delivery`, "member", { outcome: "not_sent" });
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: lead3.id, direction: "out" }), 1);
      assert.ok(await db.collection("audit_events").findOne({ action: "sales.draft.delivery", objectId: draft3.id, "metadata.outcome": "sent", actorId: "user-lead" }));

      // A reply drafted for an inbound email goes out in its thread, and answering it clears the Inbox item.
      const inbound = (await expect(201, "POST", `/sales/leads/${lead.id}/activities`, "member", { kind: "email", direction: "in", body: "Sounds good, send details" })).data.activity;
      await db.collection("sales_activities").updateOne({ _id: inbound.id }, { $set: { message: { accountId: box.id, externalId: "<reply-1@sharmapumps.example>", threadKey: `<draft-${draft.id}-1@acme.example>`, subject: "Re: Orders on the phone" } } });
      const answer = await readyDraft(expect, lead.id, { purpose: "reply", inReplyTo: inbound.id, subject: undefined, body: "Here are the details." });
      email.state.answer = async (sending) => ({ state: "sent", externalId: `<${sending.idempotencyKey}@acme.example>`, threadKey: sending.inReplyTo?.threadKey, to: sending.to });
      await expect(201, "POST", `/sales/drafts/${answer.id}/send`, "member", { requestId: "req-reply-0001" });
      assert.deepEqual([email.sends.at(-1)!.subject, email.sends.at(-1)!.inReplyTo], ["Re: Orders on the phone", { externalId: "<reply-1@sharmapumps.example>", threadKey: `<draft-${draft.id}-1@acme.example>` }]);
      assert.ok((await db.collection("sales_activities").findOne({ _id: inbound.id }))!.handledAt);

      for (const text of texts) assertNoSecrets(text, "an answer");
      assertNoSecrets(JSON.stringify(await db.collection("audit_events").find({}).toArray()), "the audit log");
      assertNoSecrets(JSON.stringify(await db.collection("sales_drafts").find({}).toArray()), "the drafts");
      assert.equal((await call("GET", "/sales/drafts", "member")).status, 200);
    }, "channels_send");
  } finally { email.restore(); }
});

test("one send at a time, the daily caps, mark sent by hand (with the account it went from), LinkedIn counted, WhatsApp and Instagram windows", { skip }, async () => {
  const email = standIn("email");
  const whatsapp = standIn("whatsapp");
  const instagram = standIn("instagram");
  try {
    await withSalesApp(async ({ api, db }) => {
      const { expect, texts } = caller(api);
      const box = account((await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).body);

      // A second click while the first send is on its way: refused, and only one message goes out.
      const lead = await newLead(expect, "Parallel Traders");
      const draft = await readyDraft(expect, lead.id);
      let open!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      email.state.answer = async (request) => { entered(); await gate; return { state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to }; };
      const firstSend = caller(api).call("POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-parallel-1" });
      await inside;
      const second = await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-parallel-2" });
      assert.match(second.body.error.message, /already being sent/);
      await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-parallel-1" });
      open();
      assert.equal((await firstSend).status, 201);
      assert.equal(email.sends.length, 1);
      email.state.answer = async (request) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to });

      // The daily cap: refused before anything is sent, and the draft is given back untouched.
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { dailyCaps: { email: 1, whatsapp: 20, linkedin: 1, instagram: 20 }, allowedChannels: ["call", "email", "whatsapp", "linkedin", "instagram"] });
      const capped = await readyDraft(expect, (await newLead(expect, "Capped Co")).id);
      const refused = await expect(409, "POST", `/sales/drafts/${capped.id}/send`, "member", { requestId: "req-capped-01" });
      assert.match(refused.body.error.message, /daily email limit of 1 is reached/);
      const untouched = (await db.collection("sales_drafts").findOne({ _id: capped.id }))!;
      assert.deepEqual([untouched.status, untouched.sendLock, untouched.delivery], ["ready", undefined, undefined]);
      assert.equal(email.sends.length, 1);
      assert.equal(await counter(db, "email"), 1);

      // Mark sent is for hand-sent messages only (smtp: 400 pointing at Send), and may name the account it went from.
      const wrongVia = await expect(400, "POST", `/sales/drafts/${capped.id}/sent`, "member", { sentVia: "smtp" });
      assert.match(wrongVia.body.error.message, /POST \/v1\/sales\/drafts\/:id\/send/);
      await expect(400, "POST", `/sales/drafts/${capped.id}/sent`, "member", { sentVia: "whatsapp_api" });
      const profile = account((await expect(201, "POST", "/sales/channels", "member", { kind: "linkedin", label: "My LinkedIn", ventureIds: ["venture-a"], settings: { profileUrl: "https://www.linkedin.com/in/member-person" } })).body);
      assert.deepEqual(profile.secrets, {});
      const theirs = account((await expect(201, "POST", "/sales/channels", "member2", { ...mailbox("member2@acme.example"), secrets: { password: PASSWORD_2 } })).body);
      await expect(400, "POST", `/sales/drafts/${capped.id}/sent`, "lead", { accountId: profile.id });
      await expect(404, "POST", `/sales/drafts/${capped.id}/sent`, "member", { accountId: theirs.id });
      await expect(400, "POST", `/sales/drafts/${capped.id}/sent`, "member", { accountId: profile.id });
      // The hand-sent email still counts against the day's email cap.
      const overCap = await expect(409, "POST", `/sales/drafts/${capped.id}/sent`, "member", { accountId: box.id });
      assert.match(overCap.body.error.message, /daily email limit/);
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { dailyCaps: { email: 5, whatsapp: 20, linkedin: 1, instagram: 20 }, allowedChannels: ["call", "email", "whatsapp", "linkedin", "instagram"] });
      const byHand = await expect(201, "POST", `/sales/drafts/${capped.id}/sent`, "member", { accountId: box.id, requestId: "req-hand-00001" });
      assert.deepEqual([byHand.data.draft.sentVia, byHand.data.draft.sentAccountId, byHand.data.activity.message], ["manual", box.id, { accountId: box.id }]);

      // LinkedIn: never sent from the app; marked sent by hand from the person's profile, counted against the LinkedIn cap (1 here).
      const linkedLead = await newLead(expect, "Linked Co", "member", { contactRoutes: [{ kind: "linkedin", value: "https://www.linkedin.com/in/asha" }] });
      const note = await readyDraft(expect, linkedLead.id, { channel: "linkedin", subject: undefined, body: "Hi Asha, saw your dealer network post." });
      const notFromApp = await expect(409, "POST", `/sales/drafts/${note.id}/send`, "member", { requestId: "req-linked-01" });
      assert.match(notFromApp.body.error.message, /send it yourself and mark it sent/);
      await expect(400, "POST", `/sales/drafts/${note.id}/sent`, "member", { accountId: box.id });
      const noted = await expect(201, "POST", `/sales/drafts/${note.id}/sent`, "member", { accountId: profile.id });
      assert.deepEqual([noted.data.activity.kind, noted.data.activity.message, noted.data.draft.sentAccountId, noted.data.lead.stage], ["linkedin", { accountId: profile.id }, profile.id, "contacted"]);
      assert.equal(await counter(db, "linkedin"), 1);
      const note2 = await readyDraft(expect, (await newLead(expect, "Linked Two")).id, { channel: "linkedin", subject: undefined, body: "Hi again." });
      const linkedCap = await expect(409, "POST", `/sales/drafts/${note2.id}/sent`, "member", {});
      assert.match(linkedCap.body.error.message, /daily linkedin limit of 1 is reached/);

      // WhatsApp: the venture's number; free text only within 24 hours of the lead's last WhatsApp on this number, else a template.
      const number = account((await expect(201, "POST", "/sales/channels", "lead", whatsappNumber())).body);
      const waLead = await newLead(expect, "Whats Co", "member", { contactRoutes: [{ kind: "phone", value: "098765 43210" }] });
      await db.collection("opportunities").updateOne({ _id: waLead.id }, { $set: { whatsappOptIn: { at: new Date(), by: "user-member", how: "yes_on_call" } } });
      const waDraft = await readyDraft(expect, waLead.id, { channel: "whatsapp", subject: undefined, body: "Hello from Alpha" });
      const template = await expect(409, "POST", `/sales/drafts/${waDraft.id}/send`, "member", { requestId: "req-wa-000001" });
      assert.equal(template.body.error.code, "TEMPLATE_REQUIRED");
      await expect(400, "POST", `/sales/drafts/${capped.id}/send`, "member", { requestId: "req-tpl-email1", template: { name: "intro", language: "en" } });
      const viaTemplate = await expect(201, "POST", `/sales/drafts/${waDraft.id}/send`, "member", { requestId: "req-wa-000002", template: { name: "intro", language: "en", variables: ["Asha"] } });
      assert.deepEqual([whatsapp.sends[0]!.to, whatsapp.sends[0]!.template, String(whatsapp.sends[0]!.account._id)], ["+919876543210", { name: "intro", language: "en", variables: ["Asha"] }, number.id]);
      assert.deepEqual([viaTemplate.data.draft.sentVia, viaTemplate.data.activity.kind, viaTemplate.data.activity.body, viaTemplate.data.activity.message.externalId], ["whatsapp_api", "whatsapp", "Template intro (en): Asha", `wamid.draft-${waDraft.id}-1`]);
      // Within the window (they wrote on this number an hour ago, from the number linked to this lead): free text, to that number.
      await db.collection("sales_activities").insertOne({ _id: "wa-inbound-1", workspaceId: "workspace-a", ventureId: "venture-a", leadId: waLead.id, actorId: "user-member", via: "system", kind: "whatsapp", direction: "in", body: "Yes please", at: new Date(Date.now() - 60 * 60_000), createdAt: new Date(), message: { accountId: number.id, externalId: "wamid.inbound-1" } });
      await db.collection("sales_channel_contacts").insertOne({ _id: "contact-1", workspaceId: "workspace-a", accountId: number.id, externalUserId: "+919812345678", leadId: waLead.id, createdAt: new Date() });
      const waFree = await readyDraft(expect, waLead.id, { channel: "whatsapp", subject: undefined, body: "Thanks, sending the catalogue", purpose: "reply", inReplyTo: "wa-inbound-1" });
      await expect(201, "POST", `/sales/drafts/${waFree.id}/send`, "member", { requestId: "req-wa-000003" });
      assert.deepEqual([whatsapp.sends[1]!.to, whatsapp.sends[1]!.template, whatsapp.sends[1]!.inReplyTo], ["+919812345678", undefined, { externalId: "wamid.inbound-1" }]);
      assert.equal(await counter(db, "whatsapp"), 2);

      // Instagram: only an answer to someone who wrote first, on this account, within 24 hours.
      const insta = account((await expect(201, "POST", "/sales/channels", "lead", { kind: "instagram", label: "Alpha Instagram", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: { instagramAccountId: "17841400000000" }, secrets: { accessToken: TOKEN, appSecret: APP_SECRET } })).body);
      const igLead = await newLead(expect, "Insta Co", "member", { contactRoutes: [{ kind: "instagram", value: "@instaco" }] });
      const igDraft = await readyDraft(expect, igLead.id, { channel: "instagram", subject: undefined, body: "Thanks for writing!" });
      const noThread = await expect(409, "POST", `/sales/drafts/${igDraft.id}/send`, "member", { requestId: "req-ig-000001" });
      assert.match(noThread.body.error.message, /No Instagram conversation with this lead is linked to this account/);
      await db.collection("sales_channel_contacts").insertOne({ _id: "contact-2", workspaceId: "workspace-a", accountId: insta.id, externalUserId: "998877665544", leadId: igLead.id, createdAt: new Date() });
      const outside = await expect(409, "POST", `/sales/drafts/${igDraft.id}/send`, "member", { requestId: "req-ig-000002" });
      assert.match(outside.body.error.message, /within 24 hours/);
      await db.collection("sales_activities").insertOne({ _id: "ig-inbound-1", workspaceId: "workspace-a", ventureId: "venture-a", leadId: igLead.id, actorId: "user-member", via: "system", kind: "instagram", direction: "in", body: "Price?", at: new Date(Date.now() - 5 * 60_000), createdAt: new Date(), message: { accountId: insta.id, externalId: "mid.1" } });
      const igSent = await expect(201, "POST", `/sales/drafts/${igDraft.id}/send`, "member", { requestId: "req-ig-000003" });
      assert.deepEqual([instagram.sends[0]!.to, igSent.data.draft.sentVia, igSent.data.activity.kind, await counter(db, "instagram")], ["998877665544", "instagram_api", "instagram", 1]);

      // Daybreak shows today's sends against all four caps (calls have none).
      const daybreak = (await expect(200, "GET", "/sales/daybreak?ventureId=venture-a", "member")).data;
      const caps = Object.fromEntries((daybreak.caps.find((row: any) => row.ventureId === "venture-a").channels as any[]).map((row) => [row.channel, [row.used, row.cap, row.left]]));
      assert.deepEqual(caps, { call: [0, null, null], email: [2, 5, 3], whatsapp: [2, 20, 18], linkedin: [1, 1, 0], instagram: [1, 20, 19] });

      // A switched-off account isn't used, and a password that no longer opens asks for a reconnect; neither sends anything.
      const draftOff = await readyDraft(expect, (await newLead(expect, "Off Co")).id);
      await expect(200, "PATCH", `/sales/channels/${box.id}`, "member", { enabled: false });
      const off = await expect(409, "POST", `/sales/drafts/${draftOff.id}/send`, "member", { requestId: "req-off-00001", accountId: box.id });
      assert.match(off.body.error.message, /switched off/);
      await expect(200, "PATCH", `/sales/channels/${box.id}`, "member", { enabled: true });
      await db.collection("sales_channel_accounts").updateOne({ _id: box.id }, { $set: { "secrets.password.tag": Buffer.alloc(16).toString("base64") } });
      const reconnect = await expect(409, "POST", `/sales/drafts/${draftOff.id}/send`, "member", { requestId: "req-off-00002" });
      assert.match(reconnect.body.error.message, /needs to be reconnected/);
      assert.equal(email.sends.length, 1);
      assert.equal((await db.collection("sales_drafts").findOne({ _id: draftOff.id }))!.sendLock, undefined);

      for (const text of texts) assertNoSecrets(text, "an answer");
      assertNoSecrets(JSON.stringify(await db.collection("audit_events").find({}).toArray()), "the audit log");
    }, "channels_rules");
  } finally { email.restore(); whatsapp.restore(); instagram.restore(); }
});

test("versions through an account: sending one closes the lead's other versions, an unclear send stops them until it is settled, and settling it as sent closes them", { skip }, async () => {
  const email = standIn("email");
  const whatsapp = standIn("whatsapp");
  try {
    await withSalesApp(async ({ api, db }) => {
      const { expect, texts } = caller(api);
      account((await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).body);
      const optIn = { at: new Date(), by: "user-member", how: "yes_on_call" };

      // The email version goes out through the mailbox: the WhatsApp version of the same first message closes with it.
      const lead = await newLead(expect, "Twin Pumps");
      await db.collection("opportunities").updateOne({ _id: lead.id }, { $set: { whatsappOptIn: optIn } });
      const mail = await readyDraft(expect, lead.id);
      const chat = await readyDraft(expect, lead.id, { channel: "whatsapp", subject: undefined, body: "Hello on WhatsApp" });
      const listed = (await expect(200, "GET", "/sales/drafts?status=ready", "member")).data as any[];
      assert.deepEqual(listed.find((row) => row.id === mail.id).otherVersions, [{ id: chat.id, channel: "whatsapp", status: "ready" }]);
      const sent = await expect(201, "POST", `/sales/drafts/${mail.id}/send`, "member", { requestId: "req-twin-0001" });
      assert.equal(sent.data.draft.status, "sent");
      const closed = (await db.collection("sales_drafts").findOne({ _id: chat.id }))!;
      assert.deepEqual([closed.status, closed.closedReason, closed.sentVersion.draftId, closed.sentVersion.channel, closed.discardedReason], ["discarded", "sent_on_other_channel", mail.id, "email", "The email version of this first message was sent"]);
      assert.deepEqual((await db.collection("audit_events").findOne({ action: "sales.draft.sent", objectId: mail.id }))?.metadata, { channel: "email", sentVia: "smtp", stageTo: "contacted", closedVersions: 1 });
      await expect(409, "POST", `/sales/drafts/${chat.id}/sent`, "member", {});
      const replayed = await expect(201, "POST", `/sales/drafts/${mail.id}/send`, "member", { requestId: "req-twin-0001" });
      assert.equal(replayed.data.activity.id, sent.data.activity.id);
      assert.equal(email.sends.length, 1);
      assert.equal(await db.collection("audit_events").countDocuments({ action: "sales.draft.discard", objectId: chat.id }), 1);
      assert.equal(whatsapp.sends.length, 0);

      // An unclear send holds the other version back (by hand or through an account) until a person says whether it went.
      const lead2 = await newLead(expect, "Twin Tiles");
      await db.collection("opportunities").updateOne({ _id: lead2.id }, { $set: { whatsappOptIn: optIn } });
      const mail2 = await readyDraft(expect, lead2.id);
      const chat2 = await readyDraft(expect, lead2.id, { channel: "whatsapp", subject: undefined, body: "Hello on WhatsApp" });
      email.state.answer = async () => ({ state: "uncertain", error: "The mail server stopped answering while the message was being sent" });
      await expect(202, "POST", `/sales/drafts/${mail2.id}/send`, "member", { requestId: "req-twin-0002" });
      assert.match((await expect(409, "POST", `/sales/drafts/${chat2.id}/sent`, "member", {})).body.error.message, /The email version of this first message is being sent \(or its send is unclear\): only one version goes out/);
      assert.match((await expect(409, "POST", `/sales/drafts/${chat2.id}/send`, "member", { requestId: "req-twin-0003" })).body.error.message, /is being sent \(or its send is unclear\)/);
      assert.equal((await db.collection("sales_drafts").findOne({ _id: chat2.id }))!.status, "ready");
      // "It went out": recorded as sent, and the WhatsApp version closes.
      await expect(201, "POST", `/sales/drafts/${mail2.id}/delivery`, "member", { outcome: "sent" });
      const closed2 = (await db.collection("sales_drafts").findOne({ _id: chat2.id }))!;
      assert.deepEqual([closed2.status, closed2.closedReason, closed2.sentVersion.draftId], ["discarded", "sent_on_other_channel", mail2.id]);

      // "It didn't go": the other version is free again, and sending it by hand closes the email version.
      const lead3 = await newLead(expect, "Twin Steel");
      await db.collection("opportunities").updateOne({ _id: lead3.id }, { $set: { whatsappOptIn: optIn } });
      const mail3 = await readyDraft(expect, lead3.id);
      const chat3 = await readyDraft(expect, lead3.id, { channel: "whatsapp", subject: undefined, body: "Hello on WhatsApp" });
      await expect(202, "POST", `/sales/drafts/${mail3.id}/send`, "member", { requestId: "req-twin-0004" });
      await expect(200, "POST", `/sales/drafts/${mail3.id}/delivery`, "member", { outcome: "not_sent" });
      await expect(201, "POST", `/sales/drafts/${chat3.id}/sent`, "member", {});
      const closed3 = (await db.collection("sales_drafts").findOne({ _id: mail3.id }))!;
      assert.deepEqual([closed3.status, closed3.closedReason, closed3.sentVersion.channel], ["discarded", "sent_on_other_channel", "whatsapp"]);
      assert.equal(whatsapp.sends.length, 0);
      for (const text of texts) assertNoSecrets(text, "an answer");
    }, "channels_versions");
  } finally { email.restore(); whatsapp.restore(); }
});

test("the version the person read, replies as versions and where a send goes: expectedUpdatedAt refuses a changed draft before anything is claimed, a refused claim gives the draft back with its updatedAt, sending one reply closes the others to that message, and sendTarget names the number the lead wrote from", { skip }, async () => {
  const email = standIn("email");
  const whatsapp = standIn("whatsapp");
  try {
    await withSalesApp(async ({ api, db }) => {
      const { expect, texts } = caller(api);
      account((await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).body);
      const lead = await newLead(expect, "Version Pumps");
      const inbound = (await expect(201, "POST", `/sales/leads/${lead.id}/activities`, "member", { kind: "email", direction: "in", body: "Send details" })).data.activity;
      // A person's own reply (ready at once), opened, then edited by them (it stays ready): the version they read is gone.
      const draft = await readyDraft(expect, lead.id, { purpose: "reply", inReplyTo: inbound.id, subject: "Re: details", body: "Details below." });
      // A second reply to the same message, sent to Claude's check: a version of the same answer.
      const checked = (await expect(201, "POST", `/sales/leads/${lead.id}/drafts`, "member", { channel: "email", purpose: "reply", inReplyTo: inbound.id, subject: "Re: details", body: "Details, checked first.", checkByClaude: true })).data;
      assert.equal(checked.status, "in_review");
      const seen = (await expect(200, "GET", `/sales/drafts/${draft.id}`, "member")).data;
      assert.deepEqual(seen.sendTarget, { channel: "email", to: "asha@versionpumps.example" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(200, "PATCH", `/sales/drafts/${draft.id}`, "member", { body: "Details below, and a price range." });
      const changed = await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-seen-0001", expectedUpdatedAt: seen.updatedAt });
      assert.deepEqual([changed.body.error.code, changed.body.error.message], ["DRAFT_CHANGED", "This draft changed since you opened it: read it again before sending"]);
      assert.deepEqual([email.sends.length, await counter(db, "email")], [0, 0]);
      const untouched = (await db.collection("sales_drafts").findOne({ _id: draft.id }))!;
      assert.deepEqual([untouched.status, untouched.sendLock, untouched.delivery, untouched.sendAttempts], ["ready", undefined, undefined, undefined]);
      // A claim refused after it was taken (here the day's cap) gives the draft back as it was, its updatedAt too: the version read can still go.
      const read = (await expect(200, "GET", `/sales/drafts/${draft.id}`, "member")).data.updatedAt as string;
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { dailyCaps: { email: 0 } });
      assert.match((await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-seen-0002", expectedUpdatedAt: read })).body.error.message, /daily email limit/);
      const givenBack = (await db.collection("sales_drafts").findOne({ _id: draft.id }))!;
      assert.deepEqual([givenBack.status, givenBack.sendLock, givenBack.delivery, givenBack.updatedAt.toISOString()], ["ready", undefined, undefined, read]);
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", {});
      // The version read goes, with its text; the other reply to the same message closes with it.
      const sent = await expect(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-seen-0003", expectedUpdatedAt: read });
      assert.equal(sent.data.draft.status, "sent");
      assert.equal(email.sends.at(-1)!.body, "Details below, and a price range.");
      const closed = (await db.collection("sales_drafts").findOne({ _id: checked.id }))!;
      assert.deepEqual([closed.status, closed.closedReason, closed.statusBeforeClose, closed.sentVersion.draftId, closed.sentVersion.channel], ["discarded", "other_reply_sent", "in_review", draft.id, "email"]);
      assert.deepEqual((await db.collection("audit_events").findOne({ action: "sales.draft.sent", objectId: draft.id }))?.metadata?.closedVersions, 1);
      // The same requestId repeats the first answer, although the draft's updatedAt moved on when it was sent.
      assert.equal((await expect(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-seen-0003", expectedUpdatedAt: read })).data.activity.id, sent.data.activity.id);
      assert.equal(email.sends.length, 1);
      // Without expectedUpdatedAt a send works as before.
      const plain = await readyDraft(expect, (await newLead(expect, "Plain Pumps")).id);
      await expect(201, "POST", `/sales/drafts/${plain.id}/send`, "member", { requestId: "req-plain-0001" });

      // Where a WhatsApp send would go: the lead's phone route, until a conversation links the number it wrote from on the venture's number.
      const number = account((await expect(201, "POST", "/sales/channels", "lead", whatsappNumber())).body);
      const linked = await newLead(expect, "Linked Tiles");
      await db.collection("opportunities").updateOne({ _id: linked.id }, { $set: { whatsappOptIn: { at: new Date(), by: "user-member", how: "they_messaged" } } });
      const chat = await readyDraft(expect, linked.id, { channel: "whatsapp", subject: undefined, body: "Hello on WhatsApp" });
      const targetOf = async (id: string) => (await expect(200, "GET", `/sales/drafts/${id}`, "member")).data.sendTarget;
      assert.deepEqual(await targetOf(chat.id), { channel: "whatsapp", to: "+919876543210" });
      await db.collection("sales_channel_contacts").insertOne({ _id: "link-version-1", workspaceId: "workspace-a", accountId: number.id, externalUserId: "+447700900123", leadId: linked.id, ventureId: "venture-a", kind: "whatsapp", how: "linked", linkedBy: "user-member", createdAt: new Date(), updatedAt: new Date() } as never);
      assert.deepEqual(await targetOf(chat.id), { channel: "whatsapp", to: "+447700900123" });
      const listed = (await expect(200, "GET", "/sales/drafts?status=ready", "member")).data as any[];
      assert.deepEqual(listed.find((row) => row.id === chat.id).sendTarget, { channel: "whatsapp", to: "+447700900123" });
      assert.deepEqual((await expect(200, "GET", `/sales/leads/${linked.id}`, "member")).data.drafts.find((row: any) => row.id === chat.id).sendTarget, { channel: "whatsapp", to: "+447700900123" });
      // ...and the send goes exactly there (with a template: they haven't written in the last 24 hours).
      await expect(201, "POST", `/sales/drafts/${chat.id}/send`, "member", { requestId: "req-link-0001", template: { name: "hello", language: "en" } });
      assert.equal(whatsapp.sends.at(-1)!.to, "+447700900123");
      for (const text of texts) assertNoSecrets(text, "an answer");
    }, "channels_expected");
  } finally { email.restore(); whatsapp.restore(); }
});
