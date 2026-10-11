import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { internalHeaders } from "../src/internal-auth.js";
import { sealSecret } from "../src/sales/channels/accounts.js";
import { appsecretProof, configureMeta, metaErrorMessage, signatureMatches } from "../src/sales/channels/meta/graph.js";
import { isOptOut } from "../src/sales/channels/meta/inbound.js";
import { instagramProvider } from "../src/sales/channels/meta/instagram.js";
import { forgetTemplates, parseTemplates } from "../src/sales/channels/meta/templates.js";
import { whatsappBody } from "../src/sales/channels/meta/webhook.js";
import { whatsappProvider } from "../src/sales/channels/meta/whatsapp.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// WhatsApp Business (Meta Cloud API) and Instagram messaging (docs/sales-channels.md sections 4 to 6): the providers' test and send, the
// signed webhook (handshake, signatures, inbound messages, delivery statuses), new conversations (list, link to a lead, dismiss) and the
// WhatsApp templates. Fake tokens and secrets only, and no real network: graph.facebook.com and graph.instagram.com are answered by a
// stand-in fetch that refuses every other host. Accounts are seeded straight into the database (sealed like the accounts API seals them).

const skip = !process.env.TEST_MONGODB_URI;
const SERVER_SECRET = "test-secret-that-is-at-least-32-characters";
const WA_TOKEN = "EAAG-test-whatsapp-token-000111";
const WA_APP_SECRET = "test-app-secret";
const OTHER_TOKEN = "EAAG-test-other-token-000222";
const OTHER_APP_SECRET = "test-app-secret-other-app";
const IG_TOKEN = "IGAA-test-instagram-token-000333";
const IG_APP_SECRET = "test-app-secret-instagram";
const SECRETS = [WA_TOKEN, WA_APP_SECRET, OTHER_TOKEN, OTHER_APP_SECRET, IG_TOKEN, IG_APP_SECRET];
const PHONE_ID = "1065403522429";
const PHONE_ID_2 = "1065403522430";
const WABA_ID = "2049876543210";
const IG_ID = "17841400000000001";

// ---- Stand-ins and helpers -------------------------------------------------------------------------------------------------

type Call = { method: string; url: URL; headers: Record<string, string>; body?: any };
type Answer = Response | "network" | undefined;
/** Answers Meta's hosts with `answer(call)` (unknown calls get Meta's "no such object" error), passes local calls through, refuses the rest. */
function standInMeta() {
  const calls: Call[] = [];
  let answer: (call: Call) => Answer | Promise<Answer> = () => undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "graph.facebook.com" || url.hostname === "graph.instagram.com") {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
      const call: Call = { method: init?.method ?? "GET", url, headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
      calls.push(call);
      const given = await answer(call);
      if (given === "network") throw new TypeError("fetch failed");
      return given ?? Response.json({ error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100, error_subcode: 33, fbtrace_id: "trace" } }, { status: 400 });
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`no real network in tests (${url.hostname})`);
    return realFetch(input, init);
  }) as typeof fetch;
  return { calls, answer: (next: typeof answer) => { answer = next; }, restore: () => { globalThis.fetch = realFetch; } };
}

const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

async function seedAccount(db: any, input: { id: string; kind: "whatsapp" | "instagram"; settings: Record<string, unknown>; token?: string; appSecret?: string; ventureIds?: string[]; createdBy?: string; enabled?: boolean }) {
  const now = new Date();
  const env = { BETTER_AUTH_SECRET: SERVER_SECRET };
  const secrets: Record<string, unknown> = {};
  if (input.token) secrets.accessToken = sealSecret(env, "workspace-a", input.id, "accessToken", input.token, "user-lead", now);
  if (input.appSecret) secrets.appSecret = sealSecret(env, "workspace-a", input.id, "appSecret", input.appSecret, "user-lead", now);
  await db.collection("sales_channel_accounts").insertOne({
    _id: input.id, workspaceId: "workspace-a", kind: input.kind, label: `${input.kind} ${input.id}`, ventureIds: input.ventureIds ?? ["venture-a"], defaultFor: [], enabled: input.enabled ?? true,
    status: "connected", settings: input.settings, secrets, verifyToken: `verify-${input.id}-token`, createdBy: input.createdBy ?? "user-lead", createdAt: now, updatedAt: now,
  });
}
const waAccount = (db: any, id = "wa-1", extra: Partial<Parameters<typeof seedAccount>[1]> = {}) => seedAccount(db, { id, kind: "whatsapp", settings: { phoneNumberId: PHONE_ID, businessAccountId: WABA_ID, displayNumber: "+91 99999 00000" }, token: WA_TOKEN, appSecret: WA_APP_SECRET, ...extra });
const igAccount = (db: any, id = "ig-1") => seedAccount(db, { id, kind: "instagram", settings: { instagramAccountId: IG_ID, username: "alpha.studio" }, token: IG_TOKEN, appSecret: IG_APP_SECRET });

async function deliver(origin: string, payload: unknown, secret?: string, header?: string) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = header ?? (secret ? sign(body, secret) : undefined);
  if (signature) headers["x-hub-signature-256"] = signature;
  const response = await fetch(`${origin}/v1/webhooks/meta`, { method: "POST", headers, body });
  return { status: response.status, text: await response.text() };
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}${Date.now()}${++counter}`;
const nowSeconds = (offset = 0) => String(Math.floor(Date.now() / 1000) + offset);
const waText = (from: string, body: string, id = nextId("wamid.IN"), extra: Record<string, unknown> = {}) => ({ from, id, timestamp: nowSeconds(), type: "text", text: { body }, ...extra });
const waPayload = (phoneId: string, value: Record<string, unknown>) => ({ object: "whatsapp_business_account", entry: [{ id: WABA_ID, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919999900000", phone_number_id: phoneId }, ...value } }] }] });
const waMessages = (phoneId: string, messages: unknown[], contacts: unknown[] = []) => waPayload(phoneId, { contacts, messages });
const waStatus = (phoneId: string, id: string, status: string, extra: Record<string, unknown> = {}) => waPayload(phoneId, { statuses: [{ id, status, timestamp: nowSeconds(), recipient_id: "919876543210", ...extra }] });
const igText = (sender: string, text: string, mid = nextId("aWdfMID"), extra: Record<string, unknown> = {}) => ({ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid, text, ...extra } });
const igPayload = (events: unknown[], igId = IG_ID) => ({ object: "instagram", entry: [{ id: igId, time: Date.now(), messaging: events }] });

async function read(response: Response) { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; }

async function newLead(api: any, handle: string, companyName: string, contactRoutes: unknown[], extra: Record<string, unknown> = {}) {
  const created = await read(await api("POST", "/sales/leads", handle, { pipelineId: "pipeline-a", companyName, ownerId: `user-${handle}`, contactRoutes, ...extra }));
  assert.equal(created.status, 201, created.text);
  return created.body.data as { id: string; [key: string]: any };
}

/** No token or app secret anywhere we store or audit, and Sales audit rows for conversations and webhooks carry only kinds, counts and codes. */
async function assertNothingSecret(db: any) {
  for (const name of ["audit_events", "sales_inbound", "sales_activities", "sales_channel_contacts", "sales_drafts", "notification_outbox", "opportunities", "sales_suppression"]) {
    const dump = JSON.stringify(await db.collection(name).find({}).toArray());
    for (const secret of SECRETS) assert.ok(!dump.includes(secret), `${name} holds no secret`);
  }
  for (const row of await db.collection("audit_events").find({ action: /^sales\.(inbound|webhook)\./ }).toArray()) {
    assert.ok(Object.keys(row.metadata ?? {}).every((key) => ["kind", "messages", "step", "code"].includes(key)), `${row.action} audits only kinds, counts and codes`);
  }
}

// ---- Pieces without a database ---------------------------------------------------------------------------------------------

test("webhook signatures: HMAC-SHA256 of the exact bytes under the app secret, nothing else", () => {
  const body = Buffer.from(JSON.stringify({ object: "instagram", entry: [] }));
  const good = sign(body.toString(), WA_APP_SECRET);
  assert.equal(signatureMatches(body, good, WA_APP_SECRET), true);
  assert.equal(signatureMatches(body, good.toUpperCase().replace("SHA256=", "sha256="), WA_APP_SECRET), true, "hex in any case");
  assert.equal(signatureMatches(body, good, OTHER_APP_SECRET), false, "another app's secret");
  assert.equal(signatureMatches(Buffer.from(`${body.toString()} `), good, WA_APP_SECRET), false, "other bytes");
  for (const header of [undefined, "", "sha1=abc", good.slice(0, -2), `sha256=${"z".repeat(64)}`]) assert.equal(signatureMatches(body, header, WA_APP_SECRET), false, String(header));
  assert.equal(appsecretProof(WA_TOKEN, WA_APP_SECRET), createHmac("sha256", WA_APP_SECRET).update(WA_TOKEN).digest("hex"));
});

test("opt-out words: the whole message, any case, punctuation ignored", () => {
  for (const body of ["STOP", " stop. ", "Stop!!", "Unsubscribe", "stop messages", "STOP MESSAGES.", "Band karo", "बंद करो"]) assert.equal(isOptOut(body), true, body);
  for (const body of ["please stop", "stopping", "don't stop", "stop by tomorrow", "", "unsubscribe me"]) assert.equal(isOptOut(body), false, body);
});

test("WhatsApp messages read as text, the button they tapped, or a short label for media (never downloaded)", () => {
  assert.equal(whatsappBody({ type: "text", text: { body: "Hello" } }), "Hello");
  assert.equal(whatsappBody({ type: "image", image: { id: "m1", caption: "our shop" } }), "[image] our shop");
  assert.equal(whatsappBody({ type: "image", image: { id: "m1" } }), "[image]");
  assert.equal(whatsappBody({ type: "document", document: { filename: "rates.pdf" } }), "[document: rates.pdf]");
  assert.equal(whatsappBody({ type: "audio", audio: { voice: true } }), "[voice note]");
  assert.equal(whatsappBody({ type: "video", video: {} }), "[video]");
  assert.equal(whatsappBody({ type: "location", location: { latitude: 1, longitude: 2 } }), "[location]");
  assert.equal(whatsappBody({ type: "sticker", sticker: {} }), "[sticker]");
  assert.equal(whatsappBody({ type: "contacts", contacts: [] }), "[contacts]");
  assert.equal(whatsappBody({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Yes, call me" } } }), "Yes, call me");
  assert.equal(whatsappBody({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "l1", title: "Next week" } } }), "Next week");
  assert.equal(whatsappBody({ type: "button", button: { text: "Stop promotions", payload: "STOP" } }), "Stop promotions");
  assert.equal(whatsappBody({ type: "unsupported" }), "[a message WhatsApp couldn't show]");
});

test("Meta errors become one plain sentence", () => {
  assert.equal(metaErrorMessage("whatsapp", 401, { code: 190, message: "Error validating access token" }), "Meta refused the access token: make a new permanent token for the system user");
  assert.match(metaErrorMessage("whatsapp", 400, { code: 131047, message: "(#131047) Re-engagement message" }), /24 hours.*template/);
  assert.match(metaErrorMessage("whatsapp", 400, { code: 100, message: "Invalid appsecret_proof provided in the API argument" }), /app secret/);
  assert.match(metaErrorMessage("instagram", 400, { code: 10, error_subcode: 2534022, message: "outside of allowed window" }), /24 hours.*Instagram app/);
  assert.match(metaErrorMessage("whatsapp", 400, { code: 131009, message: "(#131009) Parameter value is not valid", error_data: { details: "to is not a valid number" } }), /^Meta refused it: to is not a valid number \(code 131009\)$/);
  assert.match(metaErrorMessage("whatsapp", 503, undefined), /problem on its side \(HTTP 503\)/);
});

test("templates: only approved ones whose values are all in the body; named values keep their names", () => {
  const parsed = parseTemplates([
    { name: "follow_up_1", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, any update on {{2}}? {{1}}" }, { type: "FOOTER", text: "Alpha" }] },
    { name: "intro_named", language: "hi", status: "APPROVED", category: "MARKETING", parameter_format: "NAMED", components: [{ type: "HEADER", format: "TEXT", text: "Namaste" }, { type: "BODY", text: "Namaste {{first_name}}, {{city}} mein?" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Haan" }] }] },
    { name: "promo_img", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Sale" }] },
    { name: "otp_code", language: "en", status: "APPROVED", category: "AUTHENTICATION", components: [{ type: "BODY", text: "{{1}} is your code" }] },
    { name: "track_order", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Track it" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://example.com/{{1}}" }] }] },
    { name: "pending_one", language: "en", status: "PENDING", category: "UTILITY", components: [{ type: "BODY", text: "Hi" }] },
    { name: "header_var", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "Body" }] },
  ]);
  assert.deepEqual(parsed, [
    { name: "follow_up_1", language: "en", status: "APPROVED", category: "UTILITY", body: "Hi {{1}}, any update on {{2}}? {{1}}", variableCount: 2 },
    { name: "intro_named", language: "hi", status: "APPROVED", category: "MARKETING", body: "Namaste {{first_name}}, {{city}} mein?", variableCount: 2, parameterNames: ["first_name", "city"] },
  ]);
});

// ---- The providers ---------------------------------------------------------------------------------------------------------

const WA_DOC = { _id: "wa-x", workspaceId: "workspace-a", kind: "whatsapp", settings: { phoneNumberId: PHONE_ID, businessAccountId: WABA_ID, displayNumber: "+91 99999 00000" } };
const WA_SECRETS = { accessToken: WA_TOKEN, appSecret: WA_APP_SECRET };
const IG_DOC = { _id: "ig-x", workspaceId: "workspace-a", kind: "instagram", settings: { instagramAccountId: IG_ID, username: "alpha.studio" } };
const IG_SECRETS = { accessToken: IG_TOKEN, appSecret: IG_APP_SECRET };
const send = (provider: typeof whatsappProvider, request: Record<string, unknown>) => provider.send!({ idempotencyKey: "draft-1-1", body: "", ...request } as any, new AbortController().signal);

test("WhatsApp send: the request Meta documents, token in the header, appsecret_proof, and failed vs uncertain", async () => {
  configureMeta({ graphVersion: "v25.0" });
  forgetTemplates();
  const meta = standInMeta();
  try {
    meta.answer(() => Response.json({ messaging_product: "whatsapp", contacts: [{ input: "919876543210", wa_id: "919876543210" }], messages: [{ id: "wamid.SENT1" }] }));
    const sent = await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", body: "Namaste, the details you asked for." });
    assert.deepEqual(sent, { state: "sent", externalId: "wamid.SENT1", threadKey: "wa-x:+919876543210", to: "+919876543210", from: "+91 99999 00000" });
    const call = meta.calls.at(-1)!;
    assert.equal(call.method, "POST");
    assert.equal(`${call.url.origin}${call.url.pathname}`, `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`);
    assert.equal(call.headers.authorization, `Bearer ${WA_TOKEN}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.url.searchParams.get("appsecret_proof"), appsecretProof(WA_TOKEN, WA_APP_SECRET));
    assert.ok(!call.url.href.includes(WA_TOKEN) && !call.url.searchParams.has("access_token"), "the token never goes in the address");
    assert.deepEqual(call.body, { messaging_product: "whatsapp", recipient_type: "individual", to: "919876543210", type: "text", text: { preview_url: false, body: "Namaste, the details you asked for." } });

    // A template (numbered values, so they go in order) answering their message.
    meta.answer((request) => request.method === "GET"
      ? Response.json({ data: [{ name: "follow_up_1", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, any update on {{2}}?" }] }, { name: "intro_named", language: "hi", status: "APPROVED", parameter_format: "NAMED", components: [{ type: "BODY", text: "Namaste {{first_name}}" }] }] })
      : Response.json({ messages: [{ id: "wamid.SENT2" }] }));
    const templated = await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", template: { name: "follow_up_1", language: "en", variables: ["Ravi", "the app"] }, inReplyTo: { externalId: "wamid.IN1" } });
    assert.equal(templated.state, "sent");
    assert.deepEqual(meta.calls.at(-1)!.body, {
      messaging_product: "whatsapp", recipient_type: "individual", to: "919876543210", type: "template",
      template: { name: "follow_up_1", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ravi" }, { type: "text", text: "the app" }] }] }, context: { message_id: "wamid.IN1" },
    });
    // A template with named values sends each value's name (read from the cached template list: no second listing).
    const listings = meta.calls.filter((request) => request.method === "GET").length;
    await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", template: { name: "intro_named", language: "hi", variables: ["Ravi"] } });
    assert.deepEqual(meta.calls.at(-1)!.body.template, { name: "intro_named", language: { code: "hi" }, components: [{ type: "body", parameters: [{ type: "text", parameter_name: "first_name", text: "Ravi" }] }] });
    assert.equal(meta.calls.filter((request) => request.method === "GET").length, listings);

    // Meta saying no is `failed` with its reason in plain words; no clear answer is `uncertain`.
    const metaError = (status: number, error: Record<string, unknown>) => () => Response.json({ error: { type: "OAuthException", fbtrace_id: "trace", ...error } }, { status });
    const outcomes: [Answer | (() => Answer), { state: string; error: RegExp }][] = [
      [metaError(400, { code: 131047, message: "(#131047) Re-engagement message", error_data: { messaging_product: "whatsapp", details: "Message failed to send because more than 24 hours have passed since the customer last replied to this number." } }), { state: "failed", error: /^More than 24 hours have passed since the customer last replied: send an approved template instead$/ }],
      [metaError(401, { code: 190, message: "Error validating access token: Session has expired" }), { state: "failed", error: /^Meta refused the access token: make a new permanent token for the system user$/ }],
      [metaError(400, { code: 100, message: "Invalid appsecret_proof provided in the API argument" }), { state: "failed", error: /app secret/ }],
      [metaError(400, { code: 131026, message: "Message undeliverable" }), { state: "failed", error: /could not deliver it to this number/ }],
      [metaError(400, { code: 999001, message: `Something about ${WA_TOKEN}` }), { state: "failed", error: /^Meta refused it: Something about … \(code 999001\)$/ }],
      [metaError(500, { code: 1, message: "An unknown error occurred" }), { state: "uncertain", error: /^Meta \(WhatsApp\) had a problem on its side: An unknown error occurred \(code 1\)$/ }],
      [() => new Response("<html>Bad gateway</html>", { status: 502 }), { state: "uncertain", error: /problem on its side \(HTTP 502\)/ }],
      [() => "network", { state: "uncertain", error: /could not be reached/ }],
      [() => new Response("not json", { status: 200 }), { state: "uncertain", error: /not JSON/ }],
    ];
    for (const [answer, expected] of outcomes) {
      meta.answer(answer as never);
      const outcome = await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", body: "Hello" }) as { state: string; error: string };
      assert.equal(outcome.state, expected.state, outcome.error);
      assert.match(outcome.error, expected.error);
      assert.ok(!outcome.error.includes(WA_TOKEN) && !outcome.error.includes(WA_APP_SECRET), "no secret in the reason");
    }

    // Checked before anything is sent: a number that isn't international, an over-long text, an aborted send.
    const before = meta.calls.length;
    assert.deepEqual(await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "12345", body: "Hello" }), { state: "failed", error: "The lead's WhatsApp number isn't a full international number" });
    assert.match((await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", body: "x".repeat(4_097) }) as any).error, /at most 4,096 characters/);
    assert.equal(meta.calls.length, before, "nothing went to Meta");
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await whatsappProvider.send!({ account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", body: "Hello", idempotencyKey: "k" } as any, aborted.signal)).state, "uncertain");

    // The Graph version comes from the config.
    configureMeta({ graphVersion: "v26.0" });
    meta.answer(() => Response.json({ messages: [{ id: "wamid.SENT3" }] }));
    await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", body: "Hello" });
    assert.ok(meta.calls.at(-1)!.url.pathname.startsWith("/v26.0/"));
    configureMeta({ graphVersion: "latest" });
    await send(whatsappProvider, { account: WA_DOC, secrets: WA_SECRETS, to: "+919876543210", body: "Hello" });
    assert.ok(meta.calls.at(-1)!.url.pathname.startsWith("/v26.0/"), "a version that doesn't look like v26.0 is ignored");
  } finally {
    configureMeta({ graphVersion: "v25.0" });
    forgetTemplates();
    meta.restore();
  }
});

test("WhatsApp test: reads the number and the business account, never sends; failures are plain checks", async () => {
  configureMeta({ graphVersion: "v25.0" });
  const meta = standInMeta();
  try {
    meta.answer((call) => call.url.pathname === `/v25.0/${PHONE_ID}` ? Response.json({ display_phone_number: "+91 99999 00000", verified_name: "Alpha Studio", quality_rating: "GREEN", id: PHONE_ID })
      : call.url.pathname === `/v25.0/${WABA_ID}/message_templates` ? Response.json({ data: [] }) : undefined);
    const passed = await whatsappProvider.test(WA_DOC as any, WA_SECRETS, new AbortController().signal) as any;
    assert.equal(passed.ok, true, passed.message);
    assert.deepEqual(passed.learned, { displayNumber: "+91 99999 00000" });
    assert.deepEqual(passed.checks.map((check: any) => [check.name, check.ok]), [["Phone number", true], ["WhatsApp Business account", true]]);
    assert.match(passed.checks[0].detail, /Alpha Studio.*quality green/);
    assert.equal(meta.calls[0]!.url.searchParams.get("fields"), "display_phone_number,verified_name,quality_rating");
    assert.equal(meta.calls[1]!.url.searchParams.get("limit"), "1");
    assert.ok(meta.calls.every((call) => call.method === "GET" && call.headers.authorization === `Bearer ${WA_TOKEN}` && call.url.searchParams.get("appsecret_proof") === appsecretProof(WA_TOKEN, WA_APP_SECRET)));

    meta.answer(() => Response.json({ error: { code: 190, message: "Invalid OAuth access token" } }, { status: 401 }));
    const refused = await whatsappProvider.test(WA_DOC as any, WA_SECRETS, new AbortController().signal);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /^Phone number: Meta refused the access token/);
    const before = meta.calls.length;
    const missing = await whatsappProvider.test(WA_DOC as any, { accessToken: WA_TOKEN }, new AbortController().signal);
    assert.equal(missing.ok, false);
    assert.match(missing.message, /app secret/);
    assert.equal(meta.calls.length, before, "nothing is called without both secrets");
    assert.ok(meta.calls.every((call) => call.method === "GET"), "a test never sends");
  } finally { meta.restore(); }
});

test("Instagram: send replies to the Instagram-scoped id on graph.instagram.com; the test checks the token's account", async () => {
  configureMeta({ graphVersion: "v25.0" });
  const meta = standInMeta();
  try {
    meta.answer(() => Response.json({ recipient_id: "5550001", message_id: "aWdfSENT1" }));
    const sent = await send(instagramProvider, { account: IG_DOC, secrets: IG_SECRETS, to: "5550001", body: "Thanks for writing! When can we call?" });
    assert.deepEqual(sent, { state: "sent", externalId: "aWdfSENT1", threadKey: "ig-x:5550001", to: "5550001", from: "@alpha.studio" });
    const call = meta.calls.at(-1)!;
    assert.equal(`${call.method} ${call.url.origin}${call.url.pathname}`, `POST https://graph.instagram.com/v25.0/${IG_ID}/messages`);
    assert.equal(call.headers.authorization, `Bearer ${IG_TOKEN}`);
    assert.ok(!call.url.searchParams.has("appsecret_proof") && !call.url.href.includes(IG_TOKEN));
    assert.deepEqual(call.body, { recipient: { id: "5550001" }, message: { text: "Thanks for writing! When can we call?" } });

    meta.answer(() => Response.json({ error: { message: "This message is sent outside of allowed window.", type: "IGApiException", code: 10, error_subcode: 2534022 } }, { status: 400 }));
    assert.deepEqual(await send(instagramProvider, { account: IG_DOC, secrets: IG_SECRETS, to: "5550001", body: "Hello" }), { state: "failed", error: "More than 24 hours have passed since they last wrote: answer from the Instagram app and mark it sent" });
    const before = meta.calls.length;
    assert.match((await send(instagramProvider, { account: IG_DOC, secrets: IG_SECRETS, to: "@someone", body: "Hello" }) as any).error, /write to the venture's account first/);
    assert.match((await send(instagramProvider, { account: IG_DOC, secrets: IG_SECRETS, to: "5550001", body: "é".repeat(501) }) as any).error, /1,000 bytes/);
    assert.equal(meta.calls.length, before);

    meta.answer((request) => request.url.pathname === "/v25.0/me" ? Response.json({ user_id: IG_ID, username: "alpha.studio", id: "app-scoped-1" }) : undefined);
    const passed = await instagramProvider.test(IG_DOC as any, IG_SECRETS, new AbortController().signal) as any;
    assert.equal(passed.ok, true, passed.message);
    assert.deepEqual(passed.learned, { username: "alpha.studio" });
    assert.equal(meta.calls.at(-1)!.url.searchParams.get("fields"), "user_id,username");
    meta.answer(() => Response.json({ user_id: "17841499999999999", username: "someone.else" }));
    const wrong = await instagramProvider.test(IG_DOC as any, IG_SECRETS, new AbortController().signal);
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /@someone\.else.*17841499999999999/);
    assert.ok(meta.calls.filter((request) => request.url.pathname.endsWith("/me")).every((request) => request.method === "GET"));
  } finally { meta.restore(); }
});

// ---- The webhook -----------------------------------------------------------------------------------------------------------

test("webhook: the handshake answers our verify tokens only; deliveries count only when signed by an account they name", { skip }, async () => {
  const meta = standInMeta();
  try {
    await withSalesApp(async ({ origin, db }) => {
      await waAccount(db);
      await seedAccount(db, { id: "wa-2", kind: "whatsapp", settings: { phoneNumberId: PHONE_ID_2, businessAccountId: "2049876543299" }, token: OTHER_TOKEN, appSecret: OTHER_APP_SECRET });
      const handshake = (token: string, mode = "subscribe") => fetch(`${origin}/v1/webhooks/meta?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`);
      const okShake = await handshake("verify-wa-1-token");
      assert.equal(okShake.status, 200);
      assert.equal(await okShake.text(), "1158201444");
      assert.match(okShake.headers.get("content-type") ?? "", /text\/plain/);
      assert.equal((await handshake("not-our-token")).status, 403);
      assert.equal((await handshake("verify-wa-1-token", "unsubscribe")).status, 403);
      assert.equal((await fetch(`${origin}/v1/webhooks/meta`)).status, 403);

      const payload = waMessages(PHONE_ID, [waText("919000000001", "Hello")]);
      const body = JSON.stringify(payload);
      assert.equal((await deliver(origin, body)).status, 401, "unsigned");
      assert.equal((await deliver(origin, body, undefined, "sha1=0123")).status, 401, "malformed");
      assert.equal((await deliver(origin, body, "not-the-app-secret")).status, 401, "wrong secret");
      assert.equal((await deliver(origin, body, OTHER_APP_SECRET)).status, 401, "signed with another account's secret");
      const stranger = { object: "whatsapp_business_account", entry: [{ id: "2049870000000", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1065403599999" }, messages: [waText("919000000001", "Hello")] } }] }] };
      assert.equal((await deliver(origin, stranger, WA_APP_SECRET)).status, 401, "names no account we have");
      assert.equal((await deliver(origin, "{not json", undefined, sign("{not json", WA_APP_SECRET))).status, 400);
      assert.equal(await db.collection("sales_inbound").countDocuments({}), 0, "nothing stored");

      // A delivery naming both numbers, signed with the second account's secret: only the second number's message is processed.
      const both = { object: "whatsapp_business_account", entry: [{ id: WABA_ID, changes: [waPayload(PHONE_ID, { messages: [waText("919000000005", "for one")] }).entry[0]!.changes[0], waPayload(PHONE_ID_2, { messages: [waText("919000000006", "for two")] }).entry[0]!.changes[0]] }] };
      const mixed = await deliver(origin, both, OTHER_APP_SECRET);
      assert.equal(mixed.status, 200, mixed.text);
      assert.deepEqual((await db.collection("sales_inbound").find({}).toArray()).map((row) => [row.accountId, row.from]), [["wa-2", "+919000000006"]]);

      // A WhatsApp Business account update (no number in it) is acknowledged and ignored.
      const update = { object: "whatsapp_business_account", entry: [{ id: WABA_ID, changes: [{ field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "follow_up_1" } }] }] };
      assert.equal((await deliver(origin, update, WA_APP_SECRET)).status, 200);
      assert.equal(await db.collection("sales_inbound").countDocuments({}), 1);

      // A processing problem is logged and audited (no body, number or secret), and answered 500 so Meta sends the delivery again;
      // the retry then stores it once.
      await db.native.command({ collMod: "sales_inbound", validator: { neverPresent: { $exists: true } } });
      const brokenPayload = waMessages(PHONE_ID, [waText("919000000007", "This breaks")]);
      const broken = await deliver(origin, brokenPayload, WA_APP_SECRET);
      assert.equal(broken.status, 500, broken.text);
      await db.native.command({ collMod: "sales_inbound", validator: {} });
      assert.equal((await deliver(origin, brokenPayload, WA_APP_SECRET)).status, 200, "Meta's retry is stored");
      assert.equal((await deliver(origin, brokenPayload, WA_APP_SECRET)).status, 200, "and a second retry is a no-op");
      assert.equal(await db.collection("sales_inbound").countDocuments({ from: "+919000000007" }), 1);
      const failure = await db.collection("audit_events").findOne({ action: "sales.webhook.failed" });
      assert.ok(failure, "the failure is audited");
      assert.deepEqual([failure.result, failure.objectId, failure.metadata], ["failure", "wa-1", { kind: "whatsapp", step: "message", code: "mongo_121" }]);
      assert.ok(!JSON.stringify(failure).includes("This breaks") && !JSON.stringify(failure).includes("919000000007"));
      assert.equal(meta.calls.length, 0, "the webhook called nothing at Meta");
      await assertNothingSecret(db);
    }, "meta_signatures");
  } finally { meta.restore(); }
});

test("WhatsApp inbound: a lead's message is filed with every reply rule, STOP opts out, strangers and ambiguous numbers start conversations, statuses tick forward", { skip }, async () => {
  const meta = standInMeta();
  try {
    await withSalesApp(async ({ origin, db, api }) => {
      await waAccount(db);
      await seedAccount(db, { id: "wa-2", kind: "whatsapp", settings: { phoneNumberId: PHONE_ID_2, businessAccountId: WABA_ID }, token: OTHER_TOKEN, appSecret: WA_APP_SECRET });
      const ravi = await newLead(api, "member", "Ravi Hardware", [{ kind: "whatsapp", value: "98765 43210" }]);
      const past = new Date(Date.now() - 3 * 86_400_000);
      await db.collection("opportunities").updateOne({ _id: ravi.id }, { $set: { stage: "contacted", lastTouchAt: past, followUpDueAt: new Date(Date.now() + 86_400_000) } });
      await db.collection("sales_drafts").insertOne({ _id: "draft-follow-up", workspaceId: "workspace-a", ventureId: "venture-a", leadId: ravi.id, channel: "whatsapp", purpose: "follow_up", status: "ready", body: "Following up", createdAt: past, updatedAt: past });

      const first = waText("919876543210", "Haan, details bhejiye");
      const payload = waMessages(PHONE_ID, [first], [{ profile: { name: "Ravi" }, wa_id: "919876543210" }]);
      const delivered = await deliver(origin, payload, WA_APP_SECRET);
      assert.equal(delivered.status, 200, delivered.text);
      const activity = await db.collection("sales_activities").findOne({ leadId: ravi.id, direction: "in" });
      assert.ok(activity, "filed on the lead");
      assert.deepEqual([activity.kind, activity.via, activity.actorId, activity.body], ["whatsapp", "system", "user-member", "Haan, details bhejiye"]);
      assert.deepEqual(activity.message, { accountId: "wa-1", externalId: first.id, threadKey: "wa-1:+919876543210", from: "+919876543210", to: "+91 99999 00000" });
      const lead = await db.collection("opportunities").findOne({ _id: ravi.id });
      assert.equal(lead!.stage, "replied");
      assert.equal(lead!.followUpDueAt, undefined, "the follow-up stopped");
      assert.equal(lead!.whatsappOptIn?.how, "they_messaged", "they messaged us: the opt-in is recorded");
      assert.equal((await db.collection("sales_drafts").findOne({ _id: "draft-follow-up" }))!.status, "discarded");
      const inbox = await read(await api("GET", "/sales/inbox", "member"));
      assert.ok(inbox.body.data.some((row: any) => row.activity.id === activity._id && !row.activity.handledAt), "an Inbox item waits for a person");
      // Meta retries the same delivery: nothing new.
      assert.equal((await deliver(origin, payload, WA_APP_SECRET)).status, 200);
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: ravi.id, direction: "in" }), 1);

      // A message carrying the sender's business-scoped id keeps it, so a later message without the number still finds the lead.
      await deliver(origin, waMessages(PHONE_ID, [waText("919876543210", "Also, Sunday?", undefined, { from_user_id: "IN.13491208655302741918" })]), WA_APP_SECRET);
      assert.equal((await db.collection("sales_channel_contacts").findOne({ externalUserId: "IN.13491208655302741918" }))?.leadId, ravi.id);
      const hidden = { id: nextId("wamid.IN"), from_user_id: "IN.13491208655302741918", timestamp: nowSeconds(), type: "text", text: { body: "Number hidden now" } };
      await deliver(origin, waMessages(PHONE_ID, [hidden]), WA_APP_SECRET);
      assert.equal((await db.collection("sales_activities").findOne({ "message.externalId": hidden.id }))?.leadId, ravi.id);

      // STOP alone: an opt-out (do not contact, disqualified, the number suppressed).
      const sunita = await newLead(api, "member2", "Sunita Traders", [{ kind: "phone", value: "+91 98111 22233" }]);
      await deliver(origin, waMessages(PHONE_ID, [waText("919811122233", "Stop.")]), WA_APP_SECRET);
      const stop = await db.collection("sales_activities").findOne({ leadId: sunita.id, direction: "in" });
      assert.deepEqual([stop?.replyType, stop?.actorId], ["opt_out", "user-member2"]);
      const stopped = await db.collection("opportunities").findOne({ _id: sunita.id });
      assert.deepEqual([stopped!.doNotContact, stopped!.stage], [true, "disqualified"]);
      assert.ok(await db.collection("sales_suppression").findOne({ key: "phone:+919811122233" }));

      // A stranger: a new conversation, one per sender, newest text on top, media as a label, retries ignored.
      const hello = waText("919000000001", "Hello, saw your ad");
      await deliver(origin, waMessages(PHONE_ID, [hello], [{ profile: { name: "Unknown Person" }, wa_id: "919000000001" }]), WA_APP_SECRET);
      const image = { from: "919000000001", id: nextId("wamid.IN"), timestamp: nowSeconds(5), type: "image", image: { id: "media-1", mime_type: "image/jpeg", caption: "this one" } };
      await deliver(origin, waMessages(PHONE_ID, [image]), WA_APP_SECRET);
      await deliver(origin, waMessages(PHONE_ID, [image]), WA_APP_SECRET);
      await deliver(origin, waMessages(PHONE_ID, [{ from: "919000000001", id: nextId("wamid.IN"), timestamp: nowSeconds(), type: "reaction", reaction: { message_id: hello.id, emoji: "👍" } }]), WA_APP_SECRET);
      const conversations = await db.collection("sales_inbound").find({ from: "+919000000001" }).toArray();
      assert.equal(conversations.length, 1);
      const conversation = conversations[0]!;
      assert.deepEqual([conversation.open, conversation.kind, conversation.accountId, conversation.name, conversation.messages, conversation.body, conversation.ventureIds], [true, "whatsapp", "wa-1", "Unknown Person", 2, "[image] this one", ["venture-a"]]);
      assert.deepEqual(conversation.items.map((item: any) => item.externalId), [hello.id, image.id]);
      assert.equal(await db.collection("sales_activities").countDocuments({ "message.from": "+919000000001" }), 0);

      // Two leads with the same number: nobody guesses, a person links it.
      await newLead(api, "member", "Twin One", [{ kind: "whatsapp", value: "9822200000" }]);
      await newLead(api, "member2", "Twin Two", [{ kind: "phone", value: "09822200000" }]);
      await deliver(origin, waMessages(PHONE_ID, [waText("919822200000", "Which of you?")]), WA_APP_SECRET);
      assert.ok(await db.collection("sales_inbound").findOne({ from: "+919822200000", open: true }));
      assert.equal(await db.collection("sales_activities").countDocuments({ "message.from": "+919822200000" }), 0);

      // Delivery statuses: forward only, failed wins and says why, the draft follows, nothing else moves.
      const at = new Date();
      await db.collection("sales_drafts").insertOne({ _id: "draft-sent", workspaceId: "workspace-a", ventureId: "venture-a", leadId: ravi.id, channel: "whatsapp", purpose: "reply", status: "sent", body: "Details", sentVia: "whatsapp_api", sentAccountId: "wa-1", delivery: { state: "sent", at, accountId: "wa-1" }, createdAt: at, updatedAt: at });
      await db.collection("sales_activities").insertOne({ _id: "activity-out", workspaceId: "workspace-a", ventureId: "venture-a", leadId: ravi.id, actorId: "user-member", via: "app", kind: "whatsapp", direction: "out", body: "Details", at, createdAt: at, draftId: "draft-sent", message: { accountId: "wa-1", externalId: "wamid.OUT1", threadKey: "wa-1:+919876543210", delivery: { state: "sent", at, accountId: "wa-1" } } });
      const state = async () => [(await db.collection("sales_activities").findOne({ _id: "activity-out" }))!.message.delivery.state, (await db.collection("sales_drafts").findOne({ _id: "draft-sent" }))!.delivery.state];
      const stageBefore = (await db.collection("opportunities").findOne({ _id: ravi.id }))!.stage;
      for (const [status, expected] of [["delivered", "delivered"], ["sent", "delivered"], ["read", "read"], ["delivered", "read"]] as const) {
        assert.equal((await deliver(origin, waStatus(PHONE_ID, "wamid.OUT1", status), WA_APP_SECRET)).status, 200);
        assert.deepEqual(await state(), [expected, expected], `${status} → ${expected}`);
      }
      // The same message id on another number of ours changes nothing.
      await deliver(origin, waStatus(PHONE_ID_2, "wamid.OUT1", "failed", { errors: [{ code: 131026, title: "Message undeliverable" }] }), WA_APP_SECRET);
      assert.deepEqual(await state(), ["read", "read"]);
      await deliver(origin, waStatus(PHONE_ID, "wamid.OUT1", "failed", { errors: [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable", error_data: { details: "Message Undeliverable." } }] }), WA_APP_SECRET);
      assert.deepEqual(await state(), ["failed", "failed"]);
      const failed = (await db.collection("sales_activities").findOne({ _id: "activity-out" }))!.message.delivery;
      assert.match(failed.error, /could not deliver it to this number/);
      assert.equal(failed.accountId, "wa-1");
      assert.deepEqual((await db.collection("sales_drafts").findOne({ _id: "draft-sent" }))!.delivery.error, failed.error);
      await deliver(origin, waStatus(PHONE_ID, "wamid.OUT1", "read"), WA_APP_SECRET);
      assert.deepEqual(await state(), ["failed", "failed"], "failed stays");
      assert.equal((await db.collection("opportunities").findOne({ _id: ravi.id }))!.stage, stageBefore, "a status never moves a stage");
      // An unknown code carries Meta's own title; an unknown message id is ignored.
      await db.collection("sales_activities").insertOne({ _id: "activity-out-2", workspaceId: "workspace-a", ventureId: "venture-a", leadId: ravi.id, actorId: "user-member", via: "app", kind: "whatsapp", direction: "out", body: "More", at, createdAt: at, message: { accountId: "wa-1", externalId: "wamid.OUT2" } });
      await deliver(origin, waStatus(PHONE_ID, "wamid.OUT2", "failed", { errors: [{ code: 999123, title: "Brand new problem", error_data: { details: "Something new happened." } }] }), WA_APP_SECRET);
      assert.equal((await db.collection("sales_activities").findOne({ _id: "activity-out-2" }))!.message.delivery.error, "WhatsApp could not deliver it: Brand new problem (Something new happened.) (code 999123)");
      assert.equal((await deliver(origin, waStatus(PHONE_ID, "wamid.NOPE", "delivered"), WA_APP_SECRET)).status, 200);
      assert.equal(meta.calls.length, 0);
      await assertNothingSecret(db);
    }, "meta_whatsapp");
  } finally { meta.restore(); }
});

test("Instagram inbound: matched by a link or by the sender's username (looked up once), echoes skipped, strangers start conversations", { skip }, async () => {
  const meta = standInMeta();
  try {
    await withSalesApp(async ({ origin, db, api }) => {
      await igAccount(db);
      const profiles: Record<string, Record<string, string>> = { "5550001": { username: "sharma.sweets", name: "Sharma Sweets" }, "5550002": { username: "gupta.namkeen" }, "5550004": { username: "random.person", name: "Random" } };
      meta.answer((call) => {
        const id = call.url.pathname.split("/").at(-1)!;
        if (call.method === "GET" && profiles[id]) return Response.json({ ...profiles[id], id });
        if (call.method === "GET" && id === "5550003") return Response.json({ error: { message: "User consent is required to access user profile", code: 230 } }, { status: 400 });
        return undefined;
      });
      const profileCalls = () => meta.calls.filter((call) => call.url.hostname === "graph.instagram.com").length;
      const sharma = await newLead(api, "member", "Sharma Sweets", [{ kind: "instagram", value: "@sharma.sweets" }]);
      const gupta = await newLead(api, "member2", "Gupta Namkeen", [{ kind: "instagram", value: "https://www.instagram.com/gupta.namkeen/" }]);

      const first = igText("5550001", "Do you make apps?");
      assert.equal((await deliver(origin, igPayload([first]), IG_APP_SECRET)).status, 200);
      const filed = await db.collection("sales_activities").findOne({ leadId: sharma.id, direction: "in" });
      assert.ok(filed, "matched by username");
      assert.deepEqual([filed.kind, filed.via, filed.actorId, filed.body], ["instagram", "system", "user-member", "Do you make apps?"]);
      assert.deepEqual(filed.message, { accountId: "ig-1", externalId: first.message.mid, threadKey: "ig-1:5550001", from: "5550001", to: "@alpha.studio" });
      const lookup = meta.calls[0]!;
      assert.equal(`${lookup.url.origin}${lookup.url.pathname}`, "https://graph.instagram.com/v25.0/5550001");
      assert.equal(lookup.url.searchParams.get("fields"), "username,name");
      assert.equal(lookup.headers.authorization, `Bearer ${IG_TOKEN}`);
      const link = await db.collection("sales_channel_contacts").findOne({ accountId: "ig-1", externalUserId: "5550001" });
      assert.deepEqual([link?.leadId, link?.how, link?.username], [sharma.id, "username", "sharma.sweets"], "the sender is linked so a reply can reach them");
      assert.equal((await db.collection("opportunities").findOne({ _id: sharma.id }))!.stage, "replied");

      // The next message goes through the link: no second lookup. Echoes of our own sends and messages from the account itself are skipped.
      await deliver(origin, igPayload([igText("5550001", "Hello again"), igText(IG_ID, "Our reply", undefined, { is_echo: true }), igText(IG_ID, "From us"), { sender: { id: "5550001" }, recipient: { id: IG_ID }, timestamp: Date.now(), read: { mid: first.message.mid } }]), IG_APP_SECRET);
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: sharma.id, direction: "in" }), 2);
      assert.equal(profileCalls(), 1);
      assert.equal(await db.collection("sales_inbound").countDocuments({}), 0);

      // A profile link route matches too.
      await deliver(origin, igPayload([igText("5550002", "Rates?")]), IG_APP_SECRET);
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: gupta.id, direction: "in" }), 1);

      // A link a person made wins without asking Instagram.
      await db.collection("sales_channel_contacts").insertOne({ _id: "contact-9", workspaceId: "workspace-a", accountId: "ig-1", kind: "instagram", externalUserId: "5550009", leadId: gupta.id, how: "attached", createdAt: new Date(), updatedAt: new Date() });
      const calls = profileCalls();
      await deliver(origin, igPayload([igText("5550009", "It's me, from my other account")]), IG_APP_SECRET);
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: gupta.id, direction: "in" }), 2);
      assert.equal(profileCalls(), calls);

      // Strangers: a conversation named by their username, looked up once; a failed lookup still keeps the message.
      await deliver(origin, igPayload([igText("5550004", "Hi there")]), IG_APP_SECRET);
      await deliver(origin, igPayload([igText("5550004", "", undefined, { text: undefined, attachments: [{ type: "image", payload: { url: "https://example.invalid/x.jpg" } }] })]), IG_APP_SECRET);
      const stranger = await db.collection("sales_inbound").findOne({ from: "5550004", open: true });
      assert.deepEqual([stranger?.kind, stranger?.name, stranger?.username, stranger?.messages, stranger?.body], ["instagram", "@random.person", "random.person", 2, "[image]"]);
      assert.equal(meta.calls.filter((call) => call.url.pathname.endsWith("/5550004")).length, 1, "the username is looked up once");
      await deliver(origin, igPayload([igText("5550003", "No profile for me")]), IG_APP_SECRET);
      const unnamed = await db.collection("sales_inbound").findOne({ from: "5550003" });
      assert.deepEqual([unnamed?.name, unnamed?.messages], [undefined, 1]);

      // Instagram deliveries are signed with the Instagram app's secret.
      assert.equal((await deliver(origin, igPayload([igText("5550001", "forged")]), WA_APP_SECRET)).status, 401);
      assert.equal(await db.collection("sales_activities").countDocuments({ body: "forged" }), 0);
      assert.ok(meta.calls.every((call) => call.method === "GET"), "receiving never sends anything");
      await assertNothingSecret(db);
    }, "meta_instagram");
  } finally { meta.restore(); }
});

// ---- Conversations ---------------------------------------------------------------------------------------------------------

test("conversations: writers list them, link one to a lead they can edit (its messages are filed) or dismiss it; others and Claude are refused", { skip }, async () => {
  const meta = standInMeta();
  try {
    await withSalesApp(async ({ origin, db, api }) => {
      await waAccount(db);
      await db.collection("pipelines").insertOne({ _id: "pipeline-b", workspaceId: "workspace-a", ventureId: "venture-b", name: "Beta", offerName: "", status: "active", createdAt: new Date(), updatedAt: new Date() });
      const hi = waText("919000000002", "Hi");
      const price = { ...waText("919000000002", "Price kya hai?"), timestamp: nowSeconds(2) };
      await deliver(origin, waMessages(PHONE_ID, [hi], [{ profile: { name: "Mehta Ji" }, wa_id: "919000000002" }]), WA_APP_SECRET);
      await deliver(origin, waMessages(PHONE_ID, [price]), WA_APP_SECRET);

      const listed = await read(await api("GET", "/sales/inbound", "member"));
      assert.equal(listed.status, 200, listed.text);
      assert.equal(listed.body.data.length, 1);
      const conversation = listed.body.data[0];
      assert.deepEqual([conversation.kind, conversation.from, conversation.name, conversation.body, conversation.messages, conversation.accountId, conversation.ventureIds], ["whatsapp", "+919000000002", "Mehta Ji", "Price kya hai?", 2, "wa-1", ["venture-a"]]);
      assert.deepEqual(conversation.items.map((item: any) => item.body), ["Hi", "Price kya hai?"]);
      assert.equal(conversation.open, undefined, "internal flags stay inside");
      assert.equal((await read(await api("GET", "/sales/inbound?ventureId=venture-a", "lead"))).body.data.length, 1);
      assert.equal((await read(await api("GET", "/sales/inbound", "boss"))).body.data.length, 1, "an admin sees them");
      assert.deepEqual((await read(await api("GET", "/sales/inbound", "outsider"))).body.data, [], "another venture's conversations stay out");
      assert.equal((await api("GET", "/sales/inbound?ventureId=venture-a", "outsider")).status, 404);
      assert.equal((await api("GET", "/sales/inbound", "learner")).status, 403);

      const mine = await newLead(api, "member", "Mehta Electricals", []);
      const theirs = await newLead(api, "member2", "Other Owner Co", []);
      const beta = await read(await api("POST", "/sales/leads", "boss", { pipelineId: "pipeline-b", companyName: "Beta Lead", ownerId: "user-outsider" }));
      assert.equal(beta.status, 201, beta.text);
      const attach = (handle: string, leadId: string, id = conversation.id) => api("POST", `/sales/inbound/${id}/attach`, handle, { leadId });
      assert.equal((await attach("learner", mine.id)).status, 403);
      assert.equal((await attach("outsider", mine.id)).status, 404);
      assert.equal((await attach("member", theirs.id)).status, 403, "only the lead's owner or a head links to it");
      assert.equal((await attach("boss", beta.body.data.id)).status, 409, "the account doesn't serve that lead's venture");
      assert.equal((await api("POST", `/sales/inbound/${conversation.id}/attach`, "member", {})).status, 400);
      const claude = await fetch(`${origin}/v1/sales/inbound/${conversation.id}/attach`, { method: "POST", headers: { "content-type": "application/json", ...internalHeaders("user-member") }, body: JSON.stringify({ leadId: mine.id }) });
      assert.equal(claude.status, 403, "Claude never links conversations");
      assert.equal((await fetch(`${origin}/v1/sales/channels/wa-1/templates`, { headers: internalHeaders("user-member") })).status, 403, "nor reads templates");
      assert.equal((await db.collection("sales_inbound").findOne({ _id: conversation.id }))!.open, true, "nothing changed");

      const linked = await read(await attach("member", mine.id));
      assert.equal(linked.status, 200, linked.text);
      assert.deepEqual([linked.body.data.conversation.leadId, linked.body.data.conversation.handledBy, linked.body.data.lead.id, linked.body.data.lead.stage, linked.body.data.lead.whatsappOptIn?.how], [mine.id, "user-member", mine.id, "replied", "they_messaged"]);
      assert.ok(linked.body.data.conversation.handledAt);
      const filed = await db.collection("sales_activities").find({ leadId: mine.id, direction: "in" }).sort({ at: 1 }).toArray();
      assert.deepEqual(filed.map((row) => [row.body, row.kind, row.via, row.actorId, row.message.externalId, row.message.threadKey, row.message.from]), [
        ["Hi", "whatsapp", "system", "user-member", hi.id, "wa-1:+919000000002", "+919000000002"],
        ["Price kya hai?", "whatsapp", "system", "user-member", price.id, "wa-1:+919000000002", "+919000000002"],
      ]);
      const contact = await db.collection("sales_channel_contacts").findOne({ accountId: "wa-1", externalUserId: "+919000000002" });
      assert.deepEqual([contact?.leadId, contact?.how, contact?.linkedBy], [mine.id, "attached", "user-member"]);
      const audited = await db.collection("audit_events").findOne({ action: "sales.inbound.attach" });
      assert.deepEqual([audited?.actorId, audited?.objectId, audited?.ventureId, audited?.metadata], ["user-member", conversation.id, "venture-a", { kind: "whatsapp", messages: 2 }]);
      assert.equal((await attach("member", mine.id)).status, 409, "handled once");
      // The next message from that number goes straight to the lead.
      await deliver(origin, waMessages(PHONE_ID, [waText("919000000002", "Kal baat karte hain")]), WA_APP_SECRET);
      assert.equal(await db.collection("sales_activities").countDocuments({ leadId: mine.id, direction: "in" }), 3);
      assert.equal(await db.collection("sales_inbound").countDocuments({ from: "+919000000002", open: true }), 0);
      assert.deepEqual((await read(await api("GET", "/sales/inbound", "member"))).body.data, []);

      // Dismissing: writers only, once; a retried old message stays dismissed, a new one opens a new conversation.
      const spam = waText("919000000003", "Win a prize!!!");
      await deliver(origin, waMessages(PHONE_ID, [spam]), WA_APP_SECRET);
      const spamId = String((await db.collection("sales_inbound").findOne({ from: "+919000000003" }))!._id);
      assert.equal((await api("POST", `/sales/inbound/${spamId}/dismiss`, "learner")).status, 403);
      assert.equal((await api("POST", `/sales/inbound/${spamId}/dismiss`, "outsider")).status, 404);
      assert.equal((await fetch(`${origin}/v1/sales/inbound/${spamId}/dismiss`, { method: "POST", headers: internalHeaders("user-member") })).status, 403);
      const dismissed = await read(await api("POST", `/sales/inbound/${spamId}/dismiss`, "member2"));
      assert.equal(dismissed.status, 200, dismissed.text);
      assert.deepEqual([dismissed.body.data.handledBy, dismissed.body.data.leadId], ["user-member2", undefined]);
      assert.deepEqual((await db.collection("audit_events").findOne({ action: "sales.inbound.dismiss" }))?.metadata, { kind: "whatsapp", messages: 1 });
      assert.equal((await api("POST", `/sales/inbound/${spamId}/dismiss`, "member2")).status, 409);
      await deliver(origin, waMessages(PHONE_ID, [spam]), WA_APP_SECRET);
      assert.equal(await db.collection("sales_inbound").countDocuments({ from: "+919000000003" }), 1, "a retried message stays dismissed");
      await deliver(origin, waMessages(PHONE_ID, [waText("919000000003", "Another prize")]), WA_APP_SECRET);
      assert.equal(await db.collection("sales_inbound").countDocuments({ from: "+919000000003", open: true }), 1);
      assert.equal((await api("POST", "/sales/inbound/no-such-conversation/attach", "member", { leadId: mine.id })).status, 404);
      await assertNothingSecret(db);
    }, "meta_conversations");
  } finally { meta.restore(); }
});

// ---- Templates -------------------------------------------------------------------------------------------------------------

test("templates: people who send through the number get its approved, sendable templates, read once per 10 minutes", { skip }, async () => {
  forgetTemplates();
  const meta = standInMeta();
  try {
    await withSalesApp(async ({ db, api }) => {
      await waAccount(db);
      await seedAccount(db, { id: "wa-bad", kind: "whatsapp", settings: { phoneNumberId: PHONE_ID_2, businessAccountId: "2049876543299" }, token: OTHER_TOKEN, appSecret: OTHER_APP_SECRET });
      await seedAccount(db, { id: "wa-off", kind: "whatsapp", settings: { phoneNumberId: "1065403522431", businessAccountId: WABA_ID }, token: WA_TOKEN, appSecret: WA_APP_SECRET, enabled: false });
      await seedAccount(db, { id: "wa-nosecret", kind: "whatsapp", settings: { phoneNumberId: "1065403522432", businessAccountId: WABA_ID } });
      await igAccount(db);
      meta.answer((call) => {
        if (call.url.pathname === "/v25.0/2049876543299/message_templates") return Response.json({ error: { code: 190, message: `Invalid OAuth access token ${OTHER_TOKEN}` } }, { status: 401 });
        if (call.url.pathname !== `/v25.0/${WABA_ID}/message_templates`) return undefined;
        if (call.url.searchParams.get("after") === "CURSOR1") return Response.json({ data: [{ name: "plain_hello", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hello from Alpha" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Tell me more" }] }] }, { name: "track_order", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Track" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://example.com/{{1}}" }] }] }], paging: { cursors: { before: "CURSOR1", after: "CURSOR2" } } });
        return Response.json({
          data: [
            { name: "intro_named", language: "hi", status: "APPROVED", category: "MARKETING", parameter_format: "NAMED", components: [{ type: "BODY", text: "Namaste {{first_name}}" }] },
            { name: "follow_up_1", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}, any update on {{2}}?" }] },
            { name: "promo_img", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Sale" }] },
            { name: "otp_code", language: "en", status: "APPROVED", category: "AUTHENTICATION", components: [{ type: "BODY", text: "{{1}} is your code" }] },
          ],
          paging: { cursors: { before: "CURSOR0", after: "CURSOR1" }, next: "https://graph.facebook.com/v25.0/next-page" },
        });
      });
      const listed = await read(await api("GET", "/sales/channels/wa-1/templates", "member"));
      assert.equal(listed.status, 200, listed.text);
      assert.deepEqual(listed.body.data, [
        { name: "follow_up_1", language: "en", status: "APPROVED", category: "UTILITY", body: "Hi {{1}}, any update on {{2}}?", variableCount: 2 },
        { name: "intro_named", language: "hi", status: "APPROVED", category: "MARKETING", body: "Namaste {{first_name}}", variableCount: 1 },
        { name: "plain_hello", language: "en", status: "APPROVED", category: "MARKETING", body: "Hello from Alpha", variableCount: 0 },
      ]);
      assert.equal(meta.calls.length, 2, "two pages");
      const [page1, page2] = meta.calls;
      assert.equal(page1!.headers.authorization, `Bearer ${WA_TOKEN}`);
      assert.equal(page1!.url.searchParams.get("appsecret_proof"), appsecretProof(WA_TOKEN, WA_APP_SECRET));
      assert.equal(page1!.url.searchParams.get("status"), "APPROVED");
      assert.equal(page1!.url.searchParams.get("fields"), "name,language,status,category,components,parameter_format");
      assert.equal(page2!.url.searchParams.get("after"), "CURSOR1");
      assert.equal((await read(await api("GET", "/sales/channels/wa-1/templates", "lead"))).body.data.length, 3);
      assert.equal(meta.calls.length, 2, "cached for 10 minutes");

      assert.equal((await api("GET", "/sales/channels/wa-1/templates", "learner")).status, 403, "a learner doesn't send");
      assert.equal((await api("GET", "/sales/channels/wa-1/templates", "outsider")).status, 404);
      assert.equal((await api("GET", "/sales/channels/ig-1/templates", "member")).status, 409, "Instagram has no templates");
      assert.equal((await api("GET", "/sales/channels/wa-off/templates", "member")).status, 409, "switched off");
      assert.equal((await api("GET", "/sales/channels/wa-nosecret/templates", "member")).status, 409, "the token can't be read");
      const refused = await read(await api("GET", "/sales/channels/wa-bad/templates", "member"));
      assert.equal(refused.status, 502);
      assert.equal(refused.body.error.message, "Meta refused the access token: make a new permanent token for the system user");
      assert.ok(!refused.text.includes(OTHER_TOKEN));
      await assertNothingSecret(db);
    }, "meta_templates");
  } finally {
    forgetTemplates();
    meta.restore();
  }
});
