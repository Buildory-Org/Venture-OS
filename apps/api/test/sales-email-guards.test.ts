import assert from "node:assert/strict";
import test from "node:test";
import { Collection, type Document, type Filter } from "mongodb";
import { AppError } from "../src/errors.js";
import { actorFor } from "../src/middleware.js";
import { settleDelivery, UNCONFIRMED } from "../src/sales/channels/dispatch.js";
import { useProviderForTests, type ChannelProvider, type SendOutcome, type SendRequest } from "../src/sales/channels/provider.js";
import type { SalesCtx } from "../src/sales/ctx.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// The guards around sending a draft through an account (sales/channels/dispatch.ts, routes/sales-drafts.ts): a send nobody finished (its
// lock still "sending" after two minutes) reads as uncertain and is settled like one; a stale "It went out" after "It didn't go" records
// nothing; the rules are checked again right before the provider call and the message is built from the claimed draft; a WhatsApp number
// for a lead abroad needs its country code; a provider that throws leaves the send uncertain (never a bare error). Stand-in providers only.

const skip = !process.env.TEST_MONGODB_URI;
const PASSWORD = "guards-app-pass-41xx-hidden";
const TOKEN = "EAAGfake-guards-token-8x2k";
const APP_SECRET = "guards-app-secret-31zz";

type Api = (method: string, path: string, handle: string, body?: unknown) => Promise<Response>;
function caller(api: Api) {
  const call = async (method: string, path: string, handle: string, body?: unknown) => { const response = await api(method, path, handle, body); const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null"), data: JSON.parse(text || "null")?.data }; };
  const expect = async (status: number, method: string, path: string, handle: string, body?: unknown) => { const reply = await call(method, path, handle, body); assert.equal(reply.status, status, `${method} ${path} as ${handle}: ${reply.text}`); return reply; };
  return { call, expect };
}
const mailbox = (address: string) => ({
  kind: "email", label: `Mail ${address}`, ventureIds: ["venture-a"], defaultFor: ["venture-a"],
  settings: { address, senderName: "Mem Ber", username: address, smtp: { host: "smtp.example.com", port: 465, security: "ssl" }, imap: { host: "imap.example.com", port: 993, security: "ssl" } }, secrets: { password: PASSWORD },
});
function standIn(kind: "email" | "whatsapp") {
  const sends: SendRequest[] = [];
  const state = { answer: async (request: SendRequest): Promise<SendOutcome> => ({ state: "sent", externalId: kind === "email" ? `<${request.idempotencyKey}@acme.example>` : `wamid.${request.idempotencyKey}`, to: request.to }) };
  const provider: ChannelProvider = { kind, test: async () => ({ ok: true, message: "Connected", checks: [] }), send: async (request) => { sends.push(request); return state.answer(request); } };
  return { sends, state, restore: useProviderForTests(provider) };
}
async function newLead(expect: ReturnType<typeof caller>["expect"], name: string, extra: Record<string, unknown> = {}) {
  return (await expect(201, "POST", "/sales/leads", "member", { pipelineId: "pipeline-a", companyName: name, ownerId: "user-member", contactName: "Asha", contactRoutes: [{ kind: "email", value: `asha@${name.toLowerCase().replace(/\W+/g, "")}.example` }], ...extra })).data;
}
async function readyDraft(expect: ReturnType<typeof caller>["expect"], leadId: string, body: Record<string, unknown> = {}) {
  const draft = (await expect(201, "POST", `/sales/leads/${leadId}/drafts`, "member", { channel: "email", subject: "Orders on the phone", body: "Hello Asha, a short note about dealer orders.", ...body })).data;
  await expect(200, "POST", `/sales/drafts/${draft.id}/review`, "member2", { result: "pass" });
  return draft;
}
const counter = async (db: any, channel = "email") => Number((await db.collection("sales_send_counters").findOne({ userId: "user-member", channel }))?.count ?? 0);
const UNCONFIRMED_TEXT = /We couldn't confirm the last send: say whether it went out/;

test("a send nobody finished: after two minutes it reads as uncertain, every action asks for an answer, and it is settled like any unclear send", { skip }, async () => {
  const email = standIn("email");
  try {
    await withSalesApp(async ({ api, db }) => {
      const { expect } = caller(api);
      const box = (await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"))).data;
      const lead = await newLead(expect, "Sharma Pumps");
      // A follow-up whose send died mid-way: a real send left unclear, then turned back into the "sending" lock a dead process leaves behind.
      const draft = await readyDraft(expect, lead.id, { purpose: "follow_up" });
      email.state.answer = async () => ({ state: "uncertain", error: "The mail server stopped answering" });
      await expect(202, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-dead-00001" });
      const dying = async (minutesAgo: number) => db.collection("sales_drafts").updateOne({ _id: draft.id }, { $set: { "delivery.state": "sending", "sendLock.at": new Date(Date.now() - minutesAgo * 60_000) }, $unset: { "delivery.error": "", sendLog: "" } });
      await dying(0);
      assert.equal(await counter(db), 1);

      // Still within two minutes: it is being sent (nothing to settle yet).
      assert.equal((await expect(200, "GET", `/sales/drafts/${draft.id}`, "member")).data.delivery.state, "sending");
      assert.match((await expect(409, "POST", `/sales/drafts/${draft.id}/delivery`, "member", { outcome: "not_sent" })).body.error.message, /still being sent/);
      assert.match((await expect(409, "PATCH", `/sales/drafts/${draft.id}`, "member", { body: "Changed" })).body.error.message, /being sent through a connected account/);

      // Three minutes on: every view reads uncertain, with what to do.
      await dying(3);
      const viewed = (await expect(200, "GET", `/sales/drafts/${draft.id}`, "member")).data;
      assert.deepEqual([viewed.delivery.state, viewed.delivery.error], ["uncertain", UNCONFIRMED]);
      assert.equal(((await expect(200, "GET", "/sales/drafts?status=ready", "member")).data as any[]).find((row) => row.id === draft.id).delivery.state, "uncertain");
      // A reply arriving now stops the lead's follow-ups, but not the one whose send is unclear (it may have gone out).
      await expect(201, "POST", `/sales/leads/${lead.id}/activities`, "member", { kind: "email", direction: "in", body: "Yes, call me" });
      const kept = (await db.collection("sales_drafts").findOne({ _id: draft.id }))!;
      assert.deepEqual([kept.status, kept.sendLock.requestId], ["ready", "req-dead-00001"]);

      // Every action on it asks whether it went out; the first one turns the lock into an uncertain send.
      for (const [method, path, body] of [["PATCH", `/sales/drafts/${draft.id}`, { body: "Changed" }], ["POST", `/sales/drafts/${draft.id}/send`, { requestId: "req-dead-00002" }], ["POST", `/sales/drafts/${draft.id}/sent`, {}], ["POST", `/sales/drafts/${draft.id}/veto`, { reason: "Not now" }], ["POST", `/sales/drafts/${draft.id}/discard`, {}]] as const) {
        assert.match((await expect(409, method, path, "member", body)).body.error.message, UNCONFIRMED_TEXT, `${method} ${path}`);
      }
      const flipped = (await db.collection("sales_drafts").findOne({ _id: draft.id }))!;
      assert.deepEqual([flipped.delivery.state, flipped.delivery.error, flipped.sendLog.map((entry: any) => [entry.requestId, entry.outcome])], ["uncertain", UNCONFIRMED, [["req-dead-00001", "uncertain"]]]);
      // The dead request's own requestId repeats "uncertain".
      assert.equal((await expect(202, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-dead-00001" })).data.draft.delivery.state, "uncertain");
      assert.equal(email.sends.length, 1);

      // "It went out": recorded once, with our Message-ID, as the sender's send (already counted).
      const went = await expect(201, "POST", `/sales/drafts/${draft.id}/delivery`, "member", { outcome: "sent" });
      assert.deepEqual([went.data.draft.status, went.data.draft.sendLock, went.data.activity.message.externalId], ["sent", undefined, `<draft-${draft.id}-1@acme.example>`]);
      assert.equal(await counter(db), 1);

      // A second one that died: "It didn't go" frees it and gives the day's send back.
      const draft2 = await readyDraft(expect, (await newLead(expect, "Verma Tiles")).id);
      await expect(202, "POST", `/sales/drafts/${draft2.id}/send`, "member", { requestId: "req-dead-00003" });
      await db.collection("sales_drafts").updateOne({ _id: draft2.id }, { $set: { "delivery.state": "sending", "sendLock.at": new Date(Date.now() - 5 * 60_000) }, $unset: { sendLog: "" } });
      assert.equal(await counter(db), 2);
      const freed = await expect(200, "POST", `/sales/drafts/${draft2.id}/delivery`, "member", { outcome: "not_sent" });
      assert.deepEqual([freed.data.draft.status, freed.data.draft.sendLock, freed.data.draft.delivery.state], ["ready", undefined, "failed"]);
      assert.equal(await counter(db), 1);
      assert.equal(String(box.id).length > 0, true);
    }, "guards_stale");
  } finally { email.restore(); }
});

test("a stale 'It went out' after 'It didn't go' records nothing, and the draft can be sent again cleanly", { skip }, async () => {
  const email = standIn("email");
  try {
    await withSalesApp(async ({ api, db, database }) => {
      const { expect } = caller(api);
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      const lead = await newLead(expect, "Gupta Steel");
      const draft = await readyDraft(expect, lead.id);
      email.state.answer = async () => ({ state: "uncertain", error: "The mail server stopped answering" });
      await expect(202, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-race-00001" });
      // Two people answer at once: both read the unclear draft, "It didn't go" lands first.
      const seen = (await db.collection("sales_drafts").findOne({ _id: draft.id }))!;
      const leadDoc = (await db.collection("opportunities").findOne({ _id: lead.id }))!;
      await expect(200, "POST", `/sales/drafts/${draft.id}/delivery`, "member", { outcome: "not_sent" });
      const actor = (await actorFor(db, { id: "user-member", email: "member@example.invalid", name: "Person member" }))!;
      const ctx: SalesCtx = { database, db, actor, via: "app", channel: "api", workspaceId: "workspace-a", settings: new Map() };
      await assert.rejects(settleDelivery(ctx, seen, leadDoc, "sent"), (error: unknown) => error instanceof AppError && error.status === 409);
      assert.equal(await db.collection("sales_activities").countDocuments({ draftId: draft.id, direction: "out" }), 0);
      const after = (await db.collection("sales_drafts").findOne({ _id: draft.id }))!;
      assert.deepEqual([after.status, after.sendLock, after.delivery.state], ["ready", undefined, "failed"]);
      assert.equal((await db.collection("opportunities").findOne({ _id: lead.id }))!.stage, "identified");
      // Sent again: one message, one activity.
      email.state.answer = async (request) => ({ state: "sent", externalId: `<${request.idempotencyKey}@acme.example>`, to: request.to });
      const sent = await expect(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-race-00002" });
      assert.equal(sent.data.to, `asha@guptasteel.example`);
      assert.equal(sent.data.draft.delivery.to, "asha@guptasteel.example");
      assert.equal(await db.collection("sales_activities").countDocuments({ draftId: draft.id, direction: "out" }), 1);
      assert.equal(await counter(db), 1);
    }, "guards_race");
  } finally { email.restore(); }
});

test("right before the provider call the rules are checked again against what is stored, and the claimed draft is what goes out; a provider that throws leaves it uncertain", { skip }, async () => {
  const email = standIn("email");
  const original = Collection.prototype.findOneAndUpdate;
  let beforeClaim: (() => Promise<void>) | undefined;
  // Runs `beforeClaim` once, just before the send claims the draft: what changes there happens after the first checks passed.
  (Collection.prototype as any).findOneAndUpdate = async function (this: Collection<Document>, filter: Filter<Document>, ...rest: unknown[]) {
    if (this.collectionName === "sales_drafts" && (filter as any)?.sendLock === null && (filter as any)?.status === "ready" && beforeClaim) { const run = beforeClaim; beforeClaim = undefined; await run(); }
    return (original as any).call(this, filter, ...rest);
  };
  try {
    await withSalesApp(async ({ api, db }) => {
      const { expect } = caller(api);
      await expect(201, "POST", "/sales/channels", "member", mailbox("member@acme.example"));
      // Put on the do-not-contact list after the first checks: refused, nothing sent, both claims given back.
      const blocked = await newLead(expect, "Blocked Co");
      const draft = await readyDraft(expect, blocked.id);
      beforeClaim = async () => { await db.collection("opportunities").updateOne({ _id: blocked.id }, { $set: { doNotContact: true } }); };
      const refused = await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-claim-0001" });
      assert.match(refused.body.error.message, /do-not-contact/);
      assert.equal(email.sends.length, 0);
      const untouched = (await db.collection("sales_drafts").findOne({ _id: draft.id }))!;
      assert.deepEqual([untouched.status, untouched.sendLock, untouched.delivery], ["ready", undefined, undefined]);
      assert.equal(await counter(db), 0);

      // The text changed in the store after the first read: the claimed draft's text is what goes out and what is logged.
      const lead = await newLead(expect, "Claimed Co");
      const draft2 = await readyDraft(expect, lead.id);
      beforeClaim = async () => { await db.collection("sales_drafts").updateOne({ _id: draft2.id }, { $set: { body: "The text as stored at the moment of sending.", subject: "Stored subject" } }); };
      const sent = await expect(201, "POST", `/sales/drafts/${draft2.id}/send`, "member", { requestId: "req-claim-0002" });
      assert.deepEqual([email.sends[0]!.body, email.sends[0]!.subject], ["The text as stored at the moment of sending.", "Stored subject"]);
      assert.equal(sent.data.activity.body, "Subject: Stored subject\n\nThe text as stored at the moment of sending.");

      // A provider that throws: the send is unclear (202), never a bare error, and stays counted until a person answers.
      const draft3 = await readyDraft(expect, (await newLead(expect, "Thrown Co")).id);
      email.state.answer = async () => { throw new Error("socket hang up"); };
      const unclear = await expect(202, "POST", `/sales/drafts/${draft3.id}/send`, "member", { requestId: "req-claim-0003" });
      assert.deepEqual([unclear.data.draft.delivery.state, unclear.data.to], ["uncertain", "asha@thrownco.example"]);
      assert.match(unclear.data.draft.delivery.error, /check whether it went out/);
      assert.equal(unclear.data.draft.sendLock.externalId, `<draft-${draft3.id}-1@acme.example>`);
      assert.equal(await counter(db), 2);
    }, "guards_recheck");
  } finally { (Collection.prototype as any).findOneAndUpdate = original; email.restore(); }
});

test("WhatsApp: a lead abroad needs its number written with the country code; the number as normalised is shown on the draft and in the answer", { skip }, async () => {
  const whatsapp = standIn("whatsapp");
  try {
    await withSalesApp(async ({ api, db }) => {
      const { expect } = caller(api);
      await expect(201, "POST", "/sales/channels", "lead", { kind: "whatsapp", label: "Alpha WhatsApp", ventureIds: ["venture-a"], defaultFor: ["venture-a"], settings: { phoneNumberId: "1234567890", businessAccountId: "9876543210" }, secrets: { accessToken: TOKEN, appSecret: APP_SECRET } });
      await expect(200, "PUT", "/sales/settings?ventureId=venture-a", "lead", { allowedChannels: ["call", "email", "whatsapp", "linkedin"] });
      const template = { name: "intro", language: "en", variables: ["Asha"] };
      const abroad = await newLead(expect, "London Co", { country: "United Kingdom", contactRoutes: [{ kind: "whatsapp", value: "07700 900123" }] });
      await db.collection("opportunities").updateOne({ _id: abroad.id }, { $set: { whatsappOptIn: { at: new Date(), by: "user-member", how: "yes_on_call" } } });
      const draft = await readyDraft(expect, abroad.id, { channel: "whatsapp", subject: undefined, body: "Hello from Alpha" });
      const refused = await expect(409, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-intl-00001", template });
      assert.match(refused.body.error.message, /^Write this lead's WhatsApp number with its country code, like \+44 … \(the lead is in United Kingdom\)$/);
      assert.equal(whatsapp.sends.length, 0);
      assert.equal((await db.collection("sales_drafts").findOne({ _id: draft.id }))!.sendLock, undefined);
      // Written with its country code (0044 works too): sent to that number, shown on the draft and in the answer.
      await db.collection("opportunities").updateOne({ _id: abroad.id }, { $set: { contactRoutes: [{ kind: "whatsapp", value: "+44 7700 900123" }] } });
      const sent = await expect(201, "POST", `/sales/drafts/${draft.id}/send`, "member", { requestId: "req-intl-00002", template });
      assert.deepEqual([whatsapp.sends[0]!.to, sent.data.to, sent.data.draft.delivery.to, sent.data.activity.message.to], ["+447700900123", "+447700900123", "+447700900123", "+447700900123"]);
      // A lead in India (or with no country written) keeps the +91 reading of a 10-digit number.
      const home = await newLead(expect, "Indore Co", { country: "India", contactRoutes: [{ kind: "phone", value: "98765 43210" }] });
      await db.collection("opportunities").updateOne({ _id: home.id }, { $set: { whatsappOptIn: { at: new Date(), by: "user-member", how: "yes_on_call" } } });
      const homeDraft = await readyDraft(expect, home.id, { channel: "whatsapp", subject: undefined, body: "Namaste" });
      assert.equal((await expect(201, "POST", `/sales/drafts/${homeDraft.id}/send`, "member", { requestId: "req-intl-00003", template })).data.to, "+919876543210");
    }, "guards_whatsapp");
  } finally { whatsapp.restore(); }
});
