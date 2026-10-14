import assert from "node:assert/strict";
import test from "node:test";
import { salesSearchKeysSchema, salesSearchKeyTestSchema, successEnvelope } from "@venture-studio/contracts";
import { forgetSearchKeys, resolveSearchKeys, sealSearchKey } from "../src/sales/search-keys.js";
import { mcpTool, withSalesApp } from "./mcp-sales-harness.js";

// The company-search keys an admin saves in Sales setup (sales/search-keys.ts, routes/sales-search-keys.ts): up to 10 per engine, encrypted
// at rest, never returned, admins only, the server's keys (several, comma separated) as the fallback, tried in turn by search_companies and
// the lead finder (search-engines.ts withSearchKeys), and the test route trying one key. Fake keys only, and no real network: TinyFish and
// Exa are answered by a stand-in fetch.

const skip = !process.env.TEST_MONGODB_URI;
const SECRET = "test-secret-that-is-at-least-32-characters";
const APP_TINYFISH = "tf_test_1234567890";
const APP_TINYFISH_2 = "tf_second_key_abcd";
const APP_EXA = "exa_test_abcdefghij";
const ENV_TINYFISH = "tf_env_key_0000000000";
const ENV_TINYFISH_2 = "tf_env_key_2222222222";
const today = () => new Date().toISOString().slice(0, 10);

type Seen = { engine: "tinyfish" | "exa"; url: URL; headers: Record<string, string>; body?: any };
/** Answers TinyFish and Exa with `answers` (given the key each call used), passes calls to this test's own servers through, and refuses any other host. */
function standInSearch() {
  const seen: Seen[] = [];
  const answers: Record<"tinyfish" | "exa", (key: string) => Response> = { tinyfish: () => Response.json({ results: [] }), exa: () => Response.json({ results: [] }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    if (url.hostname === "api.search.tinyfish.ai") { seen.push({ engine: "tinyfish", url, headers }); return answers.tinyfish(headers["x-api-key"] ?? ""); }
    if (url.hostname === "api.exa.ai") { seen.push({ engine: "exa", url, headers, body: JSON.parse(String(init?.body ?? "{}")) }); return answers.exa(headers["x-api-key"] ?? ""); }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`no real network in tests (${url.hostname})`);
    return realFetch(input, init);
  }) as typeof fetch;
  return { seen, answers, restore: () => { globalThis.fetch = realFetch; } };
}
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const status = (body: unknown) => successEnvelope(salesSearchKeysSchema).parse(body).data;
const tested = (body: unknown) => successEnvelope(salesSearchKeyTestSchema).parse(body).data;
const NOTHING = { set: false, source: null, keys: [] };

test("sealing a key: a fresh IV every time, the key nowhere in the result", () => {
  const first = sealSearchKey(SECRET, "workspace-a", "tinyfish", APP_TINYFISH);
  const second = sealSearchKey(SECRET, "workspace-a", "tinyfish", APP_TINYFISH);
  assert.equal(first.v, 1);
  assert.equal(Buffer.from(first.iv, "base64").length, 12);
  assert.equal(Buffer.from(first.tag, "base64").length, 16);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
  assert.ok(!JSON.stringify(first).includes(APP_TINYFISH) && !Buffer.from(first.data, "base64").toString("latin1").includes(APP_TINYFISH));
});

test("an admin adds and removes keys: the status lists each with an id, the last four and its use, never the key; duplicates and an 11th are refused; others are refused", { skip }, async () => {
  await withSalesApp(async ({ api, db }) => {
    const empty = await read(await api("GET", "/sales/search-keys", "boss"));
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(status(empty.body), { tinyfish: NOTHING, exa: NOTHING });

    // Admins only: a venture head, a contributor and a learner get 403 on every route, and nothing is stored or spent.
    for (const handle of ["lead", "member", "learner"]) {
      assert.equal((await api("GET", "/sales/search-keys", handle)).status, 403, `${handle} reads`);
      assert.equal((await api("POST", "/sales/search-keys/tinyfish", handle, { key: APP_TINYFISH })).status, 403, `${handle} adds`);
      assert.equal((await api("DELETE", "/sales/search-keys/tinyfish/main", handle)).status, 403, `${handle} removes`);
      assert.equal((await api("POST", "/sales/search-keys/tinyfish/main/test", handle, {})).status, 403, `${handle} tests`);
    }
    assert.equal(await db.collection("sales_search_keys").countDocuments({}), 0);
    assert.equal(await db.collection("mcp_search_usage").countDocuments({}), 0);

    const saved = await read(await api("POST", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH }));
    assert.equal(saved.status, 200, saved.text);
    const view = status(saved.body);
    const first = view.tinyfish.keys[0]!;
    assert.match(first.id, /^[0-9a-f]{12}$/);
    assert.deepEqual({ ...view.tinyfish, keys: [{ ...first, id: "x", setAt: undefined }] }, { set: true, source: "app", keys: [{ id: "x", source: "app", last4: "7890", setAt: undefined, setBy: "user-boss", setByName: "Person boss", used: 0, limit: 1_500, period: "day" }] });
    assert.ok(Date.now() - Date.parse(first.setAt!) < 60_000);
    assert.deepEqual(view.exa, NOTHING);
    assert.ok(!saved.text.includes(APP_TINYFISH.slice(0, -4)), "no part of the key beyond its last four characters comes back");

    // A second key goes after the first; the same key again is refused without repeating it.
    const second = status((await read(await api("POST", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH_2 }))).body);
    assert.deepEqual(second.tinyfish.keys.map((key) => [key.id === first.id, key.last4]), [[true, "7890"], [false, "abcd"]]);
    const twice = await read(await api("POST", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH }));
    assert.equal(twice.status, 409);
    assert.match(twice.body.error.message, /That TinyFish key is already saved/);
    assert.ok(!twice.text.includes(APP_TINYFISH.slice(0, -4)));
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", { BETTER_AUTH_SECRET: SECRET })).tinyfish.map((key) => key.key), [APP_TINYFISH, APP_TINYFISH_2], "tried in the order they were added");

    // At rest: ciphertext, its IV and tag and the version, per key; no plaintext key anywhere in the document.
    const stored = (await db.collection("sales_search_keys").findOne({ _id: "workspace-a" }))!;
    assert.equal(stored.tinyfishKeys.length, 2);
    assert.deepEqual(Object.keys(stored.tinyfishKeys[0]).sort(), ["data", "id", "iv", "last4", "setAt", "setBy", "tag", "v"]);
    assert.equal(Buffer.from(stored.tinyfishKeys[0].iv, "base64").length, 12);
    assert.notEqual(stored.tinyfishKeys[0].iv, stored.tinyfishKeys[1].iv);
    for (const key of [APP_TINYFISH, APP_TINYFISH_2]) assert.ok(!JSON.stringify(stored).includes(key.slice(0, -4)), "the stored document holds no plaintext key");

    // A key is trimmed, 10 to 300 characters, with no whitespace or comma inside; a refusal never repeats it. Only the two engines exist.
    for (const key of ["short", "has a space 1234567", `tf_${"x".repeat(300)}`, "line\nbreak_12345678", "two,keys_1234567890"]) {
      const refused = await read(await api("POST", "/sales/search-keys/exa", "boss", { key }));
      assert.equal(refused.status, 400, key);
      assert.ok(!refused.text.includes(key), "a refusal doesn't echo the key");
    }
    assert.equal((await api("POST", "/sales/search-keys/google", "boss", { key: APP_EXA })).status, 400);
    const padded = status((await read(await api("POST", "/sales/search-keys/exa", "boss", { key: `  ${APP_EXA}  ` }))).body);
    assert.deepEqual([padded.exa.source, padded.exa.keys[0]!.last4, padded.exa.keys[0]!.limit, padded.exa.keys[0]!.period], ["app", "ghij", 1_200, "month"]);
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", { BETTER_AUTH_SECRET: SECRET })).exa.map((key) => key.key), [APP_EXA], "stored trimmed");

    // Up to 10 keys per engine.
    for (let index = 1; index < 10; index++) assert.equal((await api("POST", "/sales/search-keys/exa", "boss", { key: `exa_more_key_${index}_abcdef` })).status, 200);
    const full = await read(await api("POST", "/sales/search-keys/exa", "boss", { key: "exa_eleventh_key_abcdef" }));
    assert.equal(full.status, 409);
    assert.match(full.body.error.message, /Exa already has 10 keys: remove one first/);

    // The audit log names the engine and the key's id only, never any part of a key.
    const audits = await db.collection("audit_events").find({ action: "sales.search_key.add" }).toArray();
    assert.equal(audits.length, 12);
    assert.ok(audits.every((event) => Object.keys(event.metadata).sort().join() === "engine,keyId" && /^[0-9a-f]{12}$/.test(event.metadata.keyId)));
    const everything = JSON.stringify(await db.collection("audit_events").find({}).toArray());
    assert.ok(!everything.includes(APP_TINYFISH.slice(0, -4)) && !everything.includes(APP_EXA.slice(0, -4)));

    // Removing one: the other stays; removing it again changes nothing and isn't audited; a malformed id is refused.
    const removed = await read(await api("DELETE", `/sales/search-keys/tinyfish/${first.id}`, "boss"));
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(status(removed.body).tinyfish.keys.map((key) => key.last4), ["abcd"]);
    assert.equal((await api("DELETE", `/sales/search-keys/tinyfish/${first.id}`, "boss")).status, 200);
    assert.equal(await db.collection("audit_events").countDocuments({ action: "sales.search_key.remove", "metadata.keyId": first.id }), 1);
    assert.equal((await api("DELETE", "/sales/search-keys/tinyfish/not%20an%20id", "boss")).status, 400);
    const last = status((await read(await api("DELETE", `/sales/search-keys/tinyfish/${second.tinyfish.keys[1]!.id}`, "boss"))).body);
    assert.deepEqual(last.tinyfish, NOTHING);
  }, "search_keys_admin");
});

test("the server's keys (comma separated) are the fallback, saved keys replace them, the key saved before several were allowed still works, and an unreadable key is skipped", { skip }, async () => {
  await withSalesApp(async ({ api, db, config }) => {
    const server = status((await read(await api("GET", "/sales/search-keys", "boss"))).body);
    assert.deepEqual(server.tinyfish, { set: true, source: "server", keys: [{ id: "server-1", source: "server", used: 0, limit: 1_500, period: "day" }, { id: "server-2", source: "server", used: 0, limit: 1_500, period: "day" }] }, "server keys show no last four");
    assert.deepEqual(server.exa, NOTHING);
    assert.deepEqual(await resolveSearchKeys(db, "workspace-a", config), { tinyfish: [{ id: "server-1", key: ENV_TINYFISH }, { id: "server-2", key: ENV_TINYFISH_2 }], exa: [] }, "each server key once");

    // A key saved the way the app stored one before several were allowed: it reads as "main", first, with the counter it had then.
    const now = new Date();
    await db.collection("sales_search_keys").insertOne({ _id: "workspace-a" as never, tinyfish: { ...sealSearchKey(SECRET, "workspace-a", "tinyfish", APP_TINYFISH), last4: "7890", setBy: "user-boss", setAt: now }, updatedAt: now });
    await db.collection("mcp_search_usage").insertOne({ _id: `workspace-a:tinyfish:${today()}` as never, calls: 7, workspaceId: "workspace-a", engine: "tinyfish" });
    forgetSearchKeys(db, "workspace-a");
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", config)).tinyfish, [{ id: "main", key: APP_TINYFISH }], "saved keys replace the server's");
    const legacy = status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish;
    assert.deepEqual([legacy.source, legacy.keys.map((key) => [key.id, key.source, key.last4, key.used])], ["app", [["main", "app", "7890", 7]]]);

    // A key added now goes after it; the saved keys can't be read without the secret or under another one: the server's are used.
    await api("POST", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH_2 });
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", config)).tinyfish.map((key) => key.key), [APP_TINYFISH, APP_TINYFISH_2], "adding cleared the cache");
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", { TINYFISH_API_KEY: ENV_TINYFISH })).tinyfish, [{ id: "server-1", key: ENV_TINYFISH }]);
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", { ...config, BETTER_AUTH_SECRET: "another-secret-that-is-at-least-32-chars" })).tinyfish.map((key) => key.id), ["server-1", "server-2"]);

    // The saved keys are cached for a minute in this process: a change made behind the app's back shows only once the cache is cleared.
    const stored = (await db.collection("sales_search_keys").findOne({ _id: "workspace-a" }))!;
    const data = Buffer.from(stored.tinyfish.data, "base64"); data[0] = data[0]! ^ 0xff;
    await db.collection("sales_search_keys").updateOne({ _id: "workspace-a" }, { $set: { "tinyfish.data": data.toString("base64") } });
    assert.equal((await resolveSearchKeys(db, "workspace-a", config)).tinyfish.length, 2, "still cached");
    forgetSearchKeys(db, "workspace-a");
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", config)).tinyfish.map((key) => key.key), [APP_TINYFISH_2], "a damaged key is skipped, the next saved one is used");
    const damaged = status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish;
    assert.deepEqual([damaged.source, damaged.keys.map((key) => [key.id === "main", key.unreadable ?? false])], ["app", [[true, true], [false, false]]]);

    // Every saved key unreadable: the server's are used again, listed after the unreadable ones.
    await db.collection("sales_search_keys").updateOne({ _id: "workspace-a" }, { $set: { "tinyfishKeys.0.tag": Buffer.alloc(16).toString("base64") } });
    forgetSearchKeys(db, "workspace-a");
    assert.deepEqual((await resolveSearchKeys(db, "workspace-a", config)).tinyfish.map((key) => key.id), ["server-1", "server-2"]);
    const unreadable = status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish;
    assert.deepEqual([unreadable.set, unreadable.source, unreadable.keys.map((key) => [key.source, key.unreadable ?? false])], [true, "server", [["app", true], ["app", true], ["server", false], ["server", false]]]);

    // Removing "main" clears the old field.
    await api("DELETE", "/sales/search-keys/tinyfish/main", "boss");
    assert.equal((await db.collection("sales_search_keys").findOne({ _id: "workspace-a" }))!.tinyfish, undefined);
  }, "search_keys_fallback", { TINYFISH_API_KEY: `${ENV_TINYFISH}, ${ENV_TINYFISH_2},${ENV_TINYFISH}` });
});

test("search_companies tries the keys in turn: a refused key is marked and skipped for the day, a busy one is passed over, and a test that works brings it back", { skip }, async () => {
  const search = standInSearch();
  try {
    await withSalesApp(async ({ api, ok, tokenFor, origin }) => {
      const writer = await tokenFor("member");
      const off = await ok(writer, "search_companies", { query: "pump distributors in Indore", engine: "exa" });
      assert.equal(off.searchSetUp, false);
      assert.match(off.say, /an admin can add a search key in Sales setup/i);
      assert.equal(search.seen.length, 0);

      const keys = status((await read(await api("POST", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH }))).body);
      const firstId = keys.tinyfish.keys[0]!.id;
      const secondId = status((await read(await api("POST", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH_2 }))).body).tinyfish.keys[1]!.id;
      const sharma = () => Response.json({ results: [{ url: "https://sharmapumps.in/", title: "Sharma Pumps | Pump distributors in Indore", snippet: "Industrial pumps." }] });
      search.answers.tinyfish = (key) => key === APP_TINYFISH ? new Response("{}", { status: 401 }) : sharma();
      const rotated = await ok(writer, "search_companies", { query: "pump distributors in Indore" });
      assert.deepEqual([rotated.engines, rotated.companies.map((row: any) => row.domain), rotated.warnings], [["tinyfish"], ["sharmapumps.in"], undefined]);
      assert.deepEqual(search.seen.map((call) => call.headers["x-api-key"]), [APP_TINYFISH, APP_TINYFISH_2], "the refused key, then the next");
      const marked = status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish.keys;
      assert.deepEqual(marked.map((key) => [key.used, key.usedUp ?? false]), [[1, true], [1, false]]);

      // Paused for an hour: the next search goes straight to the second key.
      search.seen.length = 0;
      await ok(writer, "search_companies", { query: "pump distributors in Raipur" });
      assert.deepEqual(search.seen.map((call) => call.headers["x-api-key"]), [APP_TINYFISH_2]);

      // A test with the first key that works clears the mark: it is tried first again.
      search.answers.tinyfish = () => sharma();
      assert.equal(tested((await read(await api("POST", `/sales/search-keys/tinyfish/${firstId}/test`, "boss", {}))).body).ok, true);
      assert.equal(status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish.keys[0]!.usedUp, undefined);
      search.seen.length = 0;
      await ok(writer, "search_companies", { query: "pump distributors in Bhopal" });
      assert.deepEqual(search.seen.map((call) => call.headers["x-api-key"]), [APP_TINYFISH]);

      // Busy (429): the next key answers, and the busy one is not marked.
      search.answers.tinyfish = (key) => key === APP_TINYFISH ? new Response("{}", { status: 429, headers: { "retry-after": "5" } }) : sharma();
      search.seen.length = 0;
      assert.deepEqual((await ok(writer, "search_companies", { query: "pump distributors in Nagpur" })).companies.map((row: any) => row.domain), ["sharmapumps.in"]);
      assert.deepEqual(search.seen.map((call) => call.headers["x-api-key"]), [APP_TINYFISH, APP_TINYFISH_2]);
      assert.equal(status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish.keys[0]!.usedUp, undefined);

      // Busy, then refused: the busy answer is reported (the engine is only slowing down), and only the refused key is paused.
      search.answers.tinyfish = (key) => key === APP_TINYFISH ? new Response("{}", { status: 429 }) : new Response("{}", { status: 401 });
      const slow = await mcpTool(origin, writer, "search_companies", { query: "pump distributors in Indore city" });
      assert.match(String(slow.text), /TinyFish Search is busy/);
      const afterSlow = status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish.keys;
      assert.deepEqual(afterSlow.map((key) => key.usedUp ?? false), [false, true]);
      search.answers.tinyfish = () => sharma();
      assert.equal(tested((await read(await api("POST", `/sales/search-keys/tinyfish/${secondId}/test`, "boss", {}))).body).ok, true, "a test that works ends the pause");

      // Every key refused: the engine's own words, and both are paused.
      search.answers.tinyfish = () => new Response("{}", { status: 402 });
      const refused = await mcpTool(origin, writer, "search_companies", { query: "pump distributors in Pune" });
      assert.equal(refused.isError, true);
      assert.match(String(refused.text), /TinyFish Search refused the request: its key was rejected or its quota is used up/);
      assert.ok(!String(refused.text).includes(APP_TINYFISH.slice(0, -4)) && !String(refused.text).includes(APP_TINYFISH_2.slice(0, -4)));
      const both = status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish.keys;
      assert.deepEqual(both.map((key) => [key.id, key.usedUp]), [[firstId, true], [secondId, true]]);
      for (const call of search.seen) assert.ok(!call.url.href.includes(APP_TINYFISH) && !call.url.href.includes(APP_TINYFISH_2), "keys never travel in an address");
    }, "search_keys_rotation");
  } finally { search.restore(); }
});

test("the test route runs one small search with one key, counts it against that key, maps the engines' refusals and is rate-limited", { skip }, async () => {
  const search = standInSearch();
  try {
    await withSalesApp(async ({ api, db }) => {
      // A second admin, so each person's five tests a minute cover the checks below.
      const now = new Date();
      await db.collection("users").insertOne({ _id: "user-boss2", workspaceId: "workspace-a", email: "boss2@example.invalid", name: "Person boss2", handle: "boss2", status: "active", createdAt: now, updatedAt: now });
      await db.collection("memberships").insertOne({ _id: "membership-boss2", workspaceId: "workspace-a", userId: "user-boss2", role: "admin", ventureIds: [], groupIds: [], status: "active", createdAt: now, updatedAt: now });
      const run = async (engine: string, keyId: string, handle = "boss") => { const reply = await read(await api("POST", `/sales/search-keys/${engine}/${keyId}/test`, handle, {})); assert.equal(reply.status, 200, reply.text); return { ...tested(reply.body), text: reply.text }; };
      const usage = async (engine: string, keyId: string) => db.collection("mcp_search_usage").findOne({ engine, keyId });

      assert.deepEqual(await run("tinyfish", "main").then(({ text: _text, ...rest }) => rest), { ok: false, message: "That TinyFish key isn't in use: it was removed, can't be read, or a key saved in the app replaces it" });
      assert.equal(search.seen.length, 0);
      assert.equal(await db.collection("mcp_search_usage").countDocuments({}), 0, "nothing is spent without a key");

      const tinyfishId = status((await read(await api("POST", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH }))).body).tinyfish.keys[0]!.id;
      const works = await run("tinyfish", tinyfishId);
      assert.deepEqual([works.ok, works.message], [true, undefined]);
      assert.equal(search.seen.length, 1);
      assert.equal(search.seen[0]!.headers["x-api-key"], APP_TINYFISH);
      assert.equal(search.seen[0]!.url.searchParams.get("query"), "software companies in Bengaluru");
      assert.equal((await usage("tinyfish", tinyfishId))?.calls, 1, "a test counts against the key's allowance");
      assert.equal(String((await usage("tinyfish", tinyfishId))?._id), `workspace-a:tinyfish:${tinyfishId}:${today()}`);

      search.answers.tinyfish = () => new Response("{}", { status: 401 });
      const refused = await run("tinyfish", tinyfishId);
      assert.deepEqual([refused.ok, refused.message], [false, "TinyFish Search refused the request: its key was rejected or its quota is used up"]);
      assert.ok(!refused.text.includes(APP_TINYFISH.slice(0, -4)));
      assert.ok((await usage("tinyfish", tinyfishId))?.refusedUntil > new Date(), "a refused key is paused");
      search.answers.tinyfish = () => Response.json({ results: [] });
      assert.equal((await run("tinyfish", tinyfishId)).ok, true, "a refused key can still be tested");
      assert.equal((await usage("tinyfish", tinyfishId))?.refusedUntil, undefined, "and a test that works clears the pause");

      // A used-up allowance is said plainly, and the engine isn't asked.
      await db.collection("mcp_search_usage").updateOne({ engine: "tinyfish", keyId: tinyfishId }, { $set: { calls: 1_500 } });
      search.seen.length = 0;
      assert.deepEqual([(await run("tinyfish", tinyfishId, "boss2")).message, search.seen.length], ["This TinyFish key has used its daily allowance", 0]);

      // Exa: one result asked for, its refusal and a failure mapped to the same short messages; nothing carries the key.
      const exaId = status((await read(await api("POST", "/sales/search-keys/exa", "boss2", { key: APP_EXA }))).body).exa.keys[0]!.id;
      search.answers.exa = () => new Response("upstream error mentioning exa_test_abcdefghij", { status: 403 });
      const exaRefused = await run("exa", exaId, "boss2");
      assert.deepEqual([exaRefused.ok, exaRefused.message], [false, "Exa refused the request: its key was rejected or its quota is used up"]);
      assert.equal(search.seen.at(-1)!.body.numResults, 1);
      assert.equal(search.seen.at(-1)!.headers["x-api-key"], APP_EXA);
      search.answers.exa = () => new Response("secret body exa_test_abcdefghij", { status: 500 });
      const failed = await run("exa", exaId, "boss2");
      assert.deepEqual([failed.ok, failed.message], [false, "Exa answered with an error (HTTP 500)"]);
      assert.ok(!failed.text.includes(APP_EXA.slice(0, -4)));

      // Audited with the engine and the key's id only.
      const audits = await db.collection("audit_events").find({ action: "sales.search_key.test" }).toArray();
      assert.equal(audits.length, 7);
      assert.ok(audits.every((event) => Object.keys(event.metadata).sort().join() === "engine,keyId" && ["tinyfish", "exa"].includes(event.metadata.engine)));

      // A few tests a minute per person: the next ones are refused with a wait (eleven tries always span a full window).
      search.answers.exa = () => Response.json({ results: [] });
      let limited: Awaited<ReturnType<typeof read>> | undefined;
      for (let index = 0; index < 11 && !limited; index++) {
        const reply = await read(await api("POST", `/sales/search-keys/exa/${exaId}/test`, "boss2", {}));
        if (reply.status === 429) limited = reply; else assert.equal(reply.status, 200, reply.text);
      }
      assert.ok(limited, "the limit is reached");
      assert.match(limited.body.error.message, /Too many key tests in a minute; try again in \d+ s/);
      assert.equal((await api("POST", `/sales/search-keys/tinyfish/${tinyfishId}/test`, "boss", {})).status, 200, "another admin's tests are counted apart");
    }, "search_keys_test_route");
  } finally { search.restore(); }
});
