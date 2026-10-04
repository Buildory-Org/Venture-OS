import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { io as socketClient } from "socket.io-client";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import { connectDatabase, type AppDb } from "../src/db.js";
import { AppError } from "../src/errors.js";
import { rateLimit } from "../src/middleware.js";
import { ensureIndexes, ensurePushEndpointIndex } from "../src/indexes.js";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { LocalObjectStore, type ObjectStore } from "../src/storage.js";
import { attachRealtime } from "../src/collaboration.js";
import { backfillMissingHandles } from "../src/handles.js";
import { authenticatePat, McpReadService } from "../src/mcp-service.js";
import { backfillStringDates } from "../src/date-backfill.js";
import { dashboardResponseSchema, documentSchema, documentVersionSchema, eventEnvelopeSchema, evidenceItemSchema, messageSchema, opportunitySchema } from "@venture-studio/contracts";
import type { Request, Response } from "express";

test("production configuration fails closed without delivery and storage credentials", () => {
  assert.throws(() => loadConfig({ APP_MODE: "production", APP_ORIGIN: "https://app.example.com", API_ORIGIN: "https://api.example.com", BETTER_AUTH_SECRET: "a".repeat(32) }), /RESEND_API_KEY/);
  assert.equal(loadConfig({}).EMAIL_FROM, "Venture Studio <noreply@example.invalid>");
  assert.equal(loadConfig({ RESEND_API_KEY: "test-only", EMAIL_FROM: "Studio <invites@example.com>" }).EMAIL_FROM, "Studio <invites@example.com>");
  assert.equal(loadConfig({ RESEND_API_KEY: "test-only", EMAIL_FROM: "invites@example.com" }).EMAIL_FROM, "invites@example.com");
  assert.throws(() => loadConfig({ RESEND_API_KEY: "test-only" }), /EMAIL_FROM/);
  assert.throws(() => loadConfig({ EMAIL_FROM: "Studio\n<invites@example.com>" }), /EMAIL_FROM/);
  assert.throws(() => loadConfig({ APP_MODE: "production", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "https://api.example.com", BETTER_AUTH_SECRET: "a".repeat(32) }), /HTTPS/);
  assert.throws(() => loadConfig({ FILE_STORAGE: "r2" }), /FILE_STORAGE=r2 requires/);
  assert.throws(() => loadConfig({ R2_ENDPOINT: "https://example.r2.cloudflarestorage.com" }), /R2 settings require FILE_STORAGE=r2/);
});

test("read and write rate limits have separate actor buckets and a retry time", async () => {
  const counts = new Map<string, number>();
  const db = { collection: () => ({ findOneAndUpdate: async ({ _id }: { _id: string }) => {
    const count = (counts.get(_id) ?? 0) + 1;
    counts.set(_id, count);
    return { count };
  } }) } as unknown as AppDb;
  const headers = new Map<string, string>();
  const res = { setHeader: (name: string, value: string | number) => { headers.set(name, String(value)); } } as unknown as Response;
  const req = { actor: { id: "user-test" } } as unknown as Request;
  const read = rateLimit(db, 2, 60_000, "actor-read");
  const write = rateLimit(db, 1, 60_000, "actor-write");
  const invoke = async (limit: ReturnType<typeof rateLimit>) => {
    let failure: unknown;
    await limit(req, res, (error) => { failure = error; });
    return failure;
  };
  assert.equal(await invoke(read), undefined);
  assert.equal(await invoke(read), undefined);
  assert.equal(headers.get("x-ratelimit-remaining"), "0");
  assert.equal(await invoke(write), undefined);
  assert.equal(headers.get("x-ratelimit-limit"), "1");
  assert.equal((await invoke(read) as AppError).status, 429);
  assert.match(headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal((await invoke(write) as AppError).status, 429);
  assert.equal(counts.size, 2);
});

test("first admin signup requires the configured verified email and closes after one claim", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  const dbName = `venture_studio_test_signup_${process.pid}_${Date.now()}`;
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true",
    APP_ORIGIN: "http://localhost:3011/", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DB: dbName,
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    BOOTSTRAP_ADMIN_EMAIL: "owner@example.com",
  });
  const database = await connectDatabase(config);
  assert.equal(database.transactions, true);
  await ensureIndexes(database.db);
  const now = new Date();
  await database.db.collection("workspaces").insertOne({ _id: "workspace-seeded", name: "Venture Studio", slug: "venture-studio", createdAt: now });
  await database.db.collection("users").insertOne({ _id: "user-seeded", workspaceId: "workspace-seeded", email: "seed@example.invalid", name: "Seeded", handle: "seeded", status: "active" });
  await database.db.collection("memberships").insertOne({ _id: "membership-seeded", workspaceId: "workspace-seeded", userId: "user-seeded", role: "admin", ventureIds: [], groupIds: [], status: "active", createdAt: now, updatedAt: now });
  const auth = createAuth(database.native, config);
  const { app } = createApp(database, config, auth, new LocalObjectStore(config));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const claim = (cookie?: string, requestOrigin = new URL(config.APP_ORIGIN).origin) => fetch(`${origin}/v1/setup/first-admin`, { method: "POST", headers: { "content-type": "application/json", origin: requestOrigin, ...(cookie ? { cookie } : {}) }, body: "{}" });
  async function verifiedCookie(email: string): Promise<string> {
    let link = "";
    const oldInfo = console.info;
    console.info = (...args: unknown[]) => {
      try { const value = JSON.parse(String(args[0])); if (value.event === "magic_link") { link = value.url; return; } } catch { /* Ignore non-email logs. */ }
      oldInfo(...args);
    };
    try {
      const response = await fetch(`${origin}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(config.APP_ORIGIN).origin }, body: JSON.stringify({ email, name: "First Owner" }) });
      assert.equal(response.status, 200, await response.text());
    } finally { console.info = oldInfo; }
    assert.ok(link);
    const url = new URL(link);
    assert.equal(url.origin, new URL(config.APP_ORIGIN).origin);
    const response = await fetch(`${origin}${url.pathname}?token=${encodeURIComponent(url.searchParams.get("token")!)}`, { redirect: "manual" });
    assert.equal(response.status, 200, await response.text());
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  }
  try {
    const before = await fetch(`${origin}/v1/setup/first-admin`);
    assert.deepEqual((await before.json() as any).data, { available: true, complete: false, configured: true, emailDeliveryReady: false });
    assert.equal((await claim()).status, 401);
    assert.equal((await fetch(`${origin}/v1/setup/first-admin`, { method: "POST", headers: { origin: new URL(config.APP_ORIGIN).origin, "x-dev-user-id": "user-seeded" }, body: "{}" })).status, 401);
    const wrongCookie = await verifiedCookie("other@example.com");
    assert.equal((await claim(wrongCookie)).status, 403);
    const ownerCookie = await verifiedCookie("owner@example.com");
    assert.equal((await claim(ownerCookie, "https://untrusted.example")).status, 403);
    const created = await claim(ownerCookie);
    assert.equal(created.status, 201, await created.clone().text());
    assert.equal((await created.json() as any).data.workspaceId, "workspace-seeded");
    assert.equal((await database.db.collection("memberships").findOne({ role: "admin", userId: { $ne: "user-seeded" } }))?.workspaceId, "workspace-seeded");
    assert.equal((await database.db.collection("installation_setup").countDocuments({ _id: "first-admin" })), 1);
    const ownerSession = await fetch(`${origin}/v1/session/bootstrap`, { headers: { cookie: ownerCookie } });
    assert.equal(ownerSession.status, 200);
    const ownerId = (await ownerSession.json() as any).data.user.id;
    const adminHeaders = { cookie: ownerCookie, "content-type": "application/json" };
    const ventureResponse = await fetch(`${origin}/v1/admin/ventures`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "First venture", ownerId, goal30Day: "Define the first outcome" }) });
    assert.equal(ventureResponse.status, 201, await ventureResponse.clone().text());
    const ventureId = (await ventureResponse.json() as any).data.id;
    const groupResponse = await fetch(`${origin}/v1/admin/groups`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ ventureId, name: "Core" }) });
    assert.equal(groupResponse.status, 201, await groupResponse.clone().text());
    const groupId = (await groupResponse.json() as any).data.id;
    const invitationResponse = await fetch(`${origin}/v1/admin/invitations`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ email: "teammate@example.com", role: "contributor", ventureIds: [ventureId], groupIds: [groupId] }) });
    assert.equal(invitationResponse.status, 201, await invitationResponse.clone().text());
    assert.equal((await invitationResponse.json() as any).data.delivery.mode, "manual");
    assert.equal((await claim(ownerCookie)).status, 409);
    assert.equal((await fetch(`${origin}/v1/setup/first-admin`).then((response) => response.json()) as any).data.complete, true);
  } finally {
    server.close();
    await once(server, "close");
    await database.native.dropDatabase();
    await database.client.close();
  }
});

test("local object URLs are signed, operation-scoped, and expiring", async () => {
  const config = loadConfig({ BETTER_AUTH_SECRET: "a".repeat(32), API_ORIGIN: "http://localhost:4000" });
  const store = new LocalObjectStore(config);
  const url = await store.uploadUrl("workspace/file");
  const token = url.split("/").at(-1)!;
  assert.equal(store.verify(token, "put"), "workspace/file");
  assert.throws(() => store.verify(token, "get"));
});

test("real Mongo replica-set smoke: auth boundary, tenancy, and atomic task fan-out", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  const dbName = `venture_studio_test_${process.pid}_${Date.now()}`;
  assert.match(dbName, /^venture_studio_test_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000",
    APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  assert.equal(database.transactions, true);
  await ensureIndexes(database.db);
  const now = new Date();
  const legacyPush = database.db.collection("push_subscriptions_upgrade_fixture");
  const legacyObjectId = new ObjectId();
  await legacyPush.insertMany([
    { _id: legacyObjectId as any, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/old", userId: "user-test", active: true, updatedAt: new Date(now.getTime() - 1000), keys: { auth: "old" } },
    { _id: "new-device-owner", endpoint: "https://UPDATES.PUSH.SERVICES.MOZILLA.COM:443/wpush/v2/old", userId: "user-peer", active: true, updatedAt: now, keys: { auth: "new" } },
  ]);
  await legacyPush.createIndex({ endpoint: 1 }, { unique: true });
  await ensurePushEndpointIndex(legacyPush);
  assert.equal(await legacyPush.countDocuments({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/old", active: true }), 0);
  assert.equal(await legacyPush.countDocuments({ _id: legacyObjectId as any, active: false, endpoint: { $exists: false }, keys: { $exists: false } }), 1);
  assert.equal(await legacyPush.countDocuments({ _id: "new-device-owner", active: false, endpoint: { $exists: false }, keys: { $exists: false } }), 1);
  assert.deepEqual((await legacyPush.indexes()).find((index) => index.name === "endpoint_1")?.partialFilterExpression, { endpoint: { $type: "string" } });
  await database.db.collection("users").insertMany([
    { _id: "user-admin", workspaceId: "workspace-a", email: "admin@example.invalid", name: "Admin", handle: "admin", status: "active", createdAt: now, updatedAt: now },
    { _id: "user-test", workspaceId: "workspace-a", email: "test@example.invalid", name: "Test User", handle: "test", status: "active", createdAt: now, updatedAt: now },
    { _id: "user-hidden", workspaceId: "workspace-a", email: "hidden@example.invalid", name: "Hidden User", handle: "hidden", status: "active", createdAt: now, updatedAt: now },
    { _id: "user-peer", workspaceId: "workspace-a", email: "peer@example.invalid", name: "Peer User", handle: "peer", status: "active", createdAt: now, updatedAt: now },
    { _id: "user-b", workspaceId: "workspace-a", email: "b@example.invalid", name: "Venture B User", handle: "b", status: "active", createdAt: now, updatedAt: now },
  ]);
  await database.db.collection("memberships").insertMany([
    { _id: "membership-admin", workspaceId: "workspace-a", userId: "user-admin", role: "admin", ventureIds: [], groupIds: [], status: "active", createdAt: now, updatedAt: now },
    { _id: "membership-test", workspaceId: "workspace-a", userId: "user-test", role: "venture_head", ventureIds: ["venture-a"], groupIds: ["group-a"], status: "active", createdAt: now, updatedAt: now },
    { _id: "membership-hidden", workspaceId: "workspace-a", userId: "user-hidden", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-hidden"], status: "active", createdAt: now, updatedAt: now },
    { _id: "membership-peer", workspaceId: "workspace-a", userId: "user-peer", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], status: "active", createdAt: now, updatedAt: now },
    { _id: "membership-b", workspaceId: "workspace-a", userId: "user-b", role: "contributor", ventureIds: ["venture-b"], groupIds: ["group-b"], status: "active", createdAt: now, updatedAt: now },
  ]);
  await database.db.collection("workspaces").insertOne({ _id: "workspace-a", name: "Test", slug: "test", createdAt: now });
  await database.db.collection("ventures").insertMany([{ _id: "venture-a", workspaceId: "workspace-a", name: "Allowed", status: "active", goal30Day: "", createdAt: now }, { _id: "venture-b", workspaceId: "workspace-a", name: "Hidden", status: "active", goal30Day: "", createdAt: now }]);
  await database.db.collection("groups").insertMany([{ _id: "group-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Core", createdAt: now }, { _id: "group-hidden", workspaceId: "workspace-a", ventureId: "venture-a", name: "Hidden", createdAt: now }, { _id: "group-b", workspaceId: "workspace-a", ventureId: "venture-b", name: "Other venture", createdAt: now }]);
  await database.db.collection("channels").insertMany([{ _id: "channel-a", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", name: "general", createdAt: now }, { _id: "channel-hidden", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-hidden", name: "private", createdAt: now }]);
  const hiddenTask = { outcome: "Hidden", assigneeId: "user-hidden", creatorId: "user-hidden", priority: "medium", status: "accepted", dueAt: new Date(Date.now() + 86_400_000), timezone: "UTC", estimatedMinutes: 10, definitionOfDone: "Done", evidenceRequirement: "Evidence", dependencies: [], evidenceLinks: [], tags: [], deadlineRisk: false, createdAt: now, updatedAt: now };
  await database.db.collection("tasks").insertMany([
    { _id: "task-hidden", workspaceId: "workspace-a", ventureId: "venture-b", groupId: "group-b", title: "Hidden venture", ...hiddenTask },
    { _id: "task-group-hidden", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-hidden", title: "GroupSecretNeedle", ...hiddenTask },
  ]);
  await database.db.collection("documents").insertOne({ _id: "document-global", workspaceId: "workspace-a", title: "Global policy", slug: "global-policy", ownerId: "admin", status: "approved", evidenceClass: "verified_fact", sensitivity: "team", authoritativeRank: 100, currentVersionId: "version-global", lastReviewedAt: now, createdAt: now, updatedAt: now });
  await database.db.collection("document_versions").insertOne({ _id: "version-global", workspaceId: "workspace-a", documentId: "document-global", version: 1, markdown: "# Global\n\nGlobalparity canonical policy.", changeSummary: "Seed", createdBy: "admin", createdAt: now });
  await database.db.collection("document_chunks").insertOne({ _id: "chunk-global", workspaceId: "workspace-a", documentId: "document-global", documentVersionId: "version-global", headingPath: "Global", ordinal: 0, plainText: "Globalparity canonical policy.", createdAt: now });
  const auth = createAuth(database.native, config);
  const store = new LocalObjectStore(config);
  const { app, resolveActor } = createApp(database, config, auth, store);
  const server = createServer(app).listen(0);
  const ioServer = attachRealtime(server, database, resolveActor, config.APP_ORIGIN, true);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  config.API_ORIGIN = origin;
  let activeSocket: ReturnType<typeof socketClient> | undefined;
  let activePeerSocket: ReturnType<typeof socketClient> | undefined;
  let browserDevSocket: ReturnType<typeof socketClient> | undefined;
  let cookieSocket: ReturnType<typeof socketClient> | undefined;
  let restrictedSocket: ReturnType<typeof socketClient> | undefined;
  let restrictedServer: ReturnType<typeof createServer> | undefined;
  let restrictedIo: ReturnType<typeof attachRealtime> | undefined;
  try {
    const unauthenticated = await fetch(`${origin}/v1/session/bootstrap`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("x-ratelimit-limit"), "60");
    const unauthenticatedInvite = await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthenticatedInvite.status, 401);
    assert.equal(unauthenticatedInvite.headers.get("x-ratelimit-limit"), "60");
    const headers = { "content-type": "application/json", "x-dev-user-id": "user-test" };
    const bootstrap = await fetch(`${origin}/v1/session/bootstrap`, { headers });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers.get("x-ratelimit-limit"), "300");
    assert.equal(bootstrap.headers.get("x-ratelimit-remaining"), "299");
    const peerBootstrap = await fetch(`${origin}/v1/session/bootstrap`, { headers: { "x-dev-user-id": "user-peer" } });
    assert.equal(peerBootstrap.status, 200);
    assert.equal(peerBootstrap.headers.get("x-ratelimit-remaining"), "299");
    const writeProbe = await fetch(`${origin}/v1/rate-limit-probe`, { method: "POST", headers });
    assert.equal(writeProbe.status, 404);
    assert.equal(writeProbe.headers.get("x-ratelimit-limit"), "120");
    assert.equal(writeProbe.headers.get("x-ratelimit-remaining"), "119");
    const bootstrapBody = await bootstrap.json() as any;
    assert.deepEqual(bootstrapBody.data.hierarchy.ventures[0].groups.map((group: any) => group.id), ["group-a"]);
    const memberPage = (await (await fetch(`${origin}/v1/members?limit=2`, { headers })).json()) as any;
    assert.equal(memberPage.data.items.length, 2);
    assert.ok(memberPage.data.nextCursor);
    assert.equal(((await (await fetch(`${origin}/v1/members?limit=2&cursor=${memberPage.data.nextCursor}`, { headers })).json()) as any).data.items.length, 2);
    assert.deepEqual(((await (await fetch(`${origin}/v1/members?groupId=group-a&handle=peer`, { headers })).json()) as any).data.items.map((item: any) => item.name), ["Peer User"]);
    assert.equal((await fetch(`${origin}/v1/members?groupId=group-hidden`, { headers })).status, 404);
    assert.equal(((await (await fetch(`${origin}/v1/members?handle=b`, { headers })).json()) as any).data.items[0].name, "Venture B User");
    assert.deepEqual(((await (await fetch(`${origin}/v1/notification-preferences`, { headers })).json()) as any).data, { email: false, webPush: true, mentions: true, messages: true, assignments: true, reminders: true });
    const changedPreferences = { email: false, webPush: false, mentions: true, messages: true, assignments: true, reminders: true };
    assert.equal((await fetch(`${origin}/v1/notification-preferences`, { method: "PUT", headers, body: JSON.stringify(changedPreferences) })).status, 200);
    assert.deepEqual(((await (await fetch(`${origin}/v1/notification-preferences`, { headers })).json()) as any).data, changedPreferences);
    const hidden = await fetch(`${origin}/v1/tasks/task-hidden`, { headers });
    assert.equal(hidden.status, 404);
    assert.equal((await fetch(`${origin}/v1/tasks/task-group-hidden`, { headers })).status, 404);
    const hiddenSearch = await fetch(`${origin}/v1/search?q=GroupSecretNeedle&types=task`, { headers });
    assert.equal(((await hiddenSearch.json()) as any).data.items.length, 0);
    await database.db.collection("messages").insertMany([
      { _id: "search-message-allowed", clientId: "search-message-allowed", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-peer", body: "ChannelSearchNeedle allowed", createdAt: now },
      { _id: "search-message-legacy", clientId: "search-message-legacy", workspaceId: "workspace-a", ventureId: "venture-a", channelId: "channel-a", authorId: "user-peer", body: "ChannelSearchNeedle legacy", createdAt: now },
      { _id: "search-message-hidden", clientId: "search-message-hidden", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-hidden", channelId: "channel-hidden", authorId: "user-hidden", body: "ChannelSearchNeedle hidden", createdAt: now },
    ]);
    await database.db.collection("files").insertMany([
      { _id: "search-file-allowed", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-peer", name: "ChannelSearchNeedle-allowed.txt", contentType: "text/plain", size: 1, objectKey: "search/allowed", status: "ready", createdAt: now },
      { _id: "search-file-hidden", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-hidden", ownerId: "user-hidden", name: "ChannelSearchNeedle-hidden.txt", contentType: "text/plain", size: 1, objectKey: "search/hidden", status: "ready", createdAt: now },
      { _id: "search-file-venture", workspaceId: "workspace-a", ventureId: "venture-a", ownerId: "user-peer", name: "Workspace brief.pdf", contentType: "application/pdf", size: 1, objectKey: "search/venture", status: "ready", createdAt: now },
      { _id: "search-file-dm", workspaceId: "workspace-a", recipientId: "user-test", ownerId: "user-peer", name: "Private DM.pdf", contentType: "application/pdf", size: 1, objectKey: "search/dm", status: "ready", createdAt: now },
      { _id: "search-file-other-workspace", workspaceId: "workspace-other", ventureId: "venture-a", ownerId: "user-peer", name: "Other workspace.pdf", contentType: "application/pdf", size: 1, objectKey: "search/other", status: "ready", createdAt: now },
    ]);
    const firstLibraryPage = (await (await fetch(`${origin}/v1/files?limit=1`, { headers })).json()) as any;
    assert.equal(firstLibraryPage.data.items.length, 1);
    assert.ok(firstLibraryPage.data.nextCursor);
    const secondLibraryPage = (await (await fetch(`${origin}/v1/files?limit=1&cursor=${firstLibraryPage.data.nextCursor}`, { headers })).json()) as any;
    assert.equal(secondLibraryPage.data.items.length, 1);
    assert.deepEqual([firstLibraryPage.data.items[0].id, secondLibraryPage.data.items[0].id].sort(), ["search-file-allowed", "search-file-venture"]);
    assert.equal(Object.hasOwn(firstLibraryPage.data.items[0], "objectKey"), false);
    assert.equal((await fetch(`${origin}/v1/files?ventureId=venture-b`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/v1/files?cursor=search-file-hidden`, { headers })).status, 404);
    const adminLibrary = (await (await fetch(`${origin}/v1/files`, { headers: { "x-dev-user-id": "user-admin" } })).json()) as any;
    assert.deepEqual(adminLibrary.data.items.map((file: any) => file.id).sort(), ["search-file-allowed", "search-file-hidden", "search-file-venture"]);
    const groupSearch = (await (await fetch(`${origin}/v1/search?q=ChannelSearchNeedle&types=message,file&groupId=group-a`, { headers })).json()) as any;
    assert.deepEqual(groupSearch.data.items.map((item: any) => item.id).sort(), ["search-file-allowed", "search-message-allowed", "search-message-legacy"]);
    assert.equal(groupSearch.data.items.find((item: any) => item.type === "message").channelId, "channel-a");
    assert.equal(groupSearch.data.items.find((item: any) => item.id === "search-message-legacy").groupId, "group-a");
    const hiddenGroupSearch = (await (await fetch(`${origin}/v1/search?q=ChannelSearchNeedle&types=message,file&groupId=group-hidden`, { headers })).json()) as any;
    assert.deepEqual(hiddenGroupSearch.data.items, []);
    const adminGroupSearch = (await (await fetch(`${origin}/v1/search?q=ChannelSearchNeedle&types=message,file&groupId=group-hidden`, { headers: { "x-dev-user-id": "user-admin" } })).json()) as any;
    assert.deepEqual(adminGroupSearch.data.items.map((item: any) => item.id).sort(), ["search-file-hidden", "search-message-hidden"]);
    await database.db.collection("channels").insertOne({ _id: "search-channel-sentinel", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "__inaccessible_group__", name: "sentinel", createdAt: now });
    await database.db.collection("messages").insertOne({ _id: "search-message-sentinel", clientId: "search-message-sentinel", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "__inaccessible_group__", channelId: "search-channel-sentinel", authorId: "user-hidden", body: "ChannelSearchNeedle sentinel", createdAt: now });
    await database.db.collection("files").insertOne({ _id: "search-file-sentinel", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "__inaccessible_group__", ownerId: "user-hidden", name: "ChannelSearchNeedle-sentinel.txt", contentType: "text/plain", size: 1, objectKey: "search/sentinel", status: "ready", createdAt: now });
    const collisionSearch = (await (await fetch(`${origin}/v1/search?q=ChannelSearchNeedle&types=message,file&groupId=group-hidden`, { headers })).json()) as any;
    assert.deepEqual(collisionSearch.data.items, []);
    const overflowMessages = Array.from({ length: 50 }, (_, index) => ({ _id: `search-overflow-${index}`, clientId: `search-overflow-${index}`, workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-peer", body: "SearchOverflowNeedle", createdAt: now }));
    await database.db.collection("messages").insertMany(overflowMessages);
    await database.db.collection("files").insertOne({ _id: "search-overflow-file", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-peer", name: "SearchOverflowNeedle.txt", contentType: "text/plain", size: 1, objectKey: "search/overflow", status: "ready", createdAt: now });
    const overflowSearch = (await (await fetch(`${origin}/v1/search?q=SearchOverflowNeedle&types=message,file&groupId=group-a&limit=50`, { headers })).json()) as any;
    assert.equal(overflowSearch.data.items.length, 50);
    assert.equal(overflowSearch.data.items.some((item: any) => item.id === "search-overflow-file"), true);
    await database.db.collection("messages").deleteMany({ _id: { $in: ["search-message-allowed", "search-message-legacy", "search-message-hidden", "search-message-sentinel", ...overflowMessages.map((item) => item._id)] } });
    await database.db.collection("files").deleteMany({ _id: { $in: ["search-file-allowed", "search-file-hidden", "search-file-venture", "search-file-dm", "search-file-other-workspace", "search-file-sentinel", "search-overflow-file"] } });
    await database.db.collection("channels").deleteOne({ _id: "search-channel-sentinel" });
    await database.db.collection("documents").insertOne({ _id: "document-b", workspaceId: "workspace-a", ventureId: "venture-b", title: "Hidden venture note", status: "approved", sensitivity: "team", updatedAt: now });
    const documentBrowse = (await (await fetch(`${origin}/v1/documents`, { headers })).json()) as any;
    assert.deepEqual(documentBrowse.data.items.map((item: any) => item.id), ["document-global"]);
    const scopeAdminHeaders = { "content-type": "application/json", "x-dev-user-id": "user-admin" };
    const scopePeerHeaders = { "content-type": "application/json", "x-dev-user-id": "user-peer" };
    const pushEndpoint = "https://updates.push.services.mozilla.com/wpush/v2/shared-browser";
    const pushSubscription = { endpoint: pushEndpoint, expirationTime: null, keys: { p256dh: "public-key-test", auth: "auth-key-test" } };
    for (const endpoint of ["http://127.0.0.1/internal", "https://127.0.0.1/internal", "https://private.example.com/internal", "javascript:alert(1)"]) {
      assert.equal((await fetch(`${origin}/v1/push-subscriptions`, { method: "POST", headers, body: JSON.stringify({ ...pushSubscription, endpoint }) })).status, 400);
    }
    assert.deepEqual(((await (await fetch(`${origin}/v1/push-config`, { headers })).json()) as any).data, { available: false });
    assert.equal((await fetch(`${origin}/v1/push-subscriptions`, { method: "POST", headers, body: JSON.stringify(pushSubscription) })).status, 201);
    assert.equal((await fetch(`${origin}/v1/push-subscriptions`, { method: "POST", headers: scopePeerHeaders, body: JSON.stringify({ ...pushSubscription, endpoint: "https://UPDATES.PUSH.SERVICES.MOZILLA.COM:443/wpush/v2/shared-browser" }) })).status, 201);
    assert.equal(await database.db.collection("push_subscriptions").countDocuments({ endpoint: pushEndpoint, userId: "user-peer", active: true }), 1);
    assert.equal((await fetch(`${origin}/v1/push-subscriptions`, { method: "DELETE", headers, body: JSON.stringify({ endpoint: pushEndpoint }) })).status, 200);
    assert.equal(await database.db.collection("push_subscriptions").countDocuments({ endpoint: pushEndpoint, userId: "user-peer", active: true }), 1);
    assert.equal((await fetch(`${origin}/v1/push-subscriptions`, { method: "DELETE", headers: scopePeerHeaders, body: JSON.stringify({ endpoint: pushEndpoint }) })).status, 200);
    assert.equal(await database.db.collection("push_subscriptions").countDocuments({ endpoint: pushEndpoint, active: true }), 0);
    const createKnowledge = async (body: Record<string, unknown>) => {
      const response = await fetch(`${origin}/v1/documents`, { method: "POST", headers: scopeAdminHeaders, body: JSON.stringify({ markdown: "# Scope\n\nScopeparity token.", evidenceClass: "verified_fact", sensitivity: "team", ...body }) });
      assert.equal(response.status, 201, await response.clone().text());
      const data = ((await response.json()) as any).data;
      assert.equal(Object.hasOwn(data.currentVersion, "sourceUri"), body.sourceUri !== undefined);
      assert.equal(documentVersionSchema.parse(data.currentVersion).sourceUri, body.sourceUri);
      return data.id as string;
    };
    const ventureBDoc = await createKnowledge({ ventureId: "venture-b", title: "Venture B scope" });
    const workspaceDoc = await createKnowledge({ title: "Workspace scope" });
    const managerDoc = await createKnowledge({ ventureId: "venture-a", title: "Manager scope", sensitivity: "manager", sourceUri: "https://example.com/manager-source" });
    const privateDoc = await createKnowledge({ ventureId: "venture-a", title: "Founder scope", sensitivity: "founder_private" });
    const savedWorkspaceDoc = await database.db.collection("documents").findOne({ _id: workspaceDoc });
    assert.equal(Object.hasOwn(savedWorkspaceDoc!, "ventureId"), false);
    assert.equal(await database.db.collection("document_chunks").countDocuments({ documentId: workspaceDoc, ventureId: { $exists: false } }), await database.db.collection("document_chunks").countDocuments({ documentId: workspaceDoc }));
    assert.equal(await database.db.collection("document_versions").countDocuments({ documentId: workspaceDoc, sourceUri: { $exists: false } }), 1);
    const revisedWorkspace = await fetch(`${origin}/v1/documents/${workspaceDoc}`, { method: "PUT", headers: scopeAdminHeaders, body: JSON.stringify({ markdown: "# Scope\n\nScopeparity token.", changeSummary: "Revised without URL" }) });
    assert.equal(revisedWorkspace.status, 200, await revisedWorkspace.clone().text());
    const revisedData = ((await revisedWorkspace.json()) as any).data;
    assert.equal(Object.hasOwn(revisedData, "sourceUri"), false);
    const revisedVersion = documentVersionSchema.parse(revisedData);
    assert.equal(revisedVersion.sourceUri, undefined);
    assert.equal(await database.db.collection("document_versions").countDocuments({ _id: revisedVersion.id, sourceUri: { $exists: false } }), 1);
    await database.db.collection("documents").insertOne({ _id: "document-legacy-null", workspaceId: "workspace-a", ventureId: null, title: "Legacy workspace scope", slug: "legacy-workspace-scope", ownerId: "user-admin", status: "draft", evidenceClass: "verified_fact", sensitivity: "team", authoritativeRank: 50, currentVersionId: "version-legacy-null", createdAt: now, updatedAt: now });
    await database.db.collection("document_versions").insertOne({ _id: "version-legacy-null", workspaceId: "workspace-a", documentId: "document-legacy-null", version: 1, markdown: "# Scope\n\nScopeparity token.", changeSummary: "Legacy", createdBy: "user-admin", createdAt: now, sourceUri: null });
    await database.db.collection("document_chunks").insertOne({ _id: "chunk-legacy-null", workspaceId: "workspace-a", ventureId: null, documentId: "document-legacy-null", documentVersionId: "version-legacy-null", headingPath: "Scope", ordinal: 0, plainText: "Scopeparity token.", createdAt: now });
    const adminDocs = (await (await fetch(`${origin}/v1/documents`, { headers: scopeAdminHeaders })).json()) as any;
    for (const id of [ventureBDoc, workspaceDoc, "document-legacy-null", managerDoc, privateDoc]) assert.equal(adminDocs.data.items.some((item: any) => item.id === id), true, id);
    documentSchema.parse(adminDocs.data.items.find((item: any) => item.id === "document-legacy-null"));
    const filteredAdminDocs = (await (await fetch(`${origin}/v1/documents?ventureId=venture-b`, { headers: scopeAdminHeaders })).json()) as any;
    for (const id of [ventureBDoc, workspaceDoc, "document-legacy-null"]) assert.equal(filteredAdminDocs.data.items.some((item: any) => item.id === id), true, id);
    assert.equal(filteredAdminDocs.data.items.some((item: any) => item.id === managerDoc), false);
    for (const id of [ventureBDoc, workspaceDoc, "document-legacy-null", managerDoc, privateDoc]) {
      const detail = await fetch(`${origin}/v1/documents/${id}`, { headers: scopeAdminHeaders });
      assert.equal(detail.status, 200, id);
      const detailData = ((await detail.json()) as any).data;
      documentSchema.parse(detailData);
      documentVersionSchema.parse(detailData.currentVersion);
      documentVersionSchema.omit({ markdown: true }).array().parse(detailData.versions);
      if (id === "document-legacy-null") assert.equal(Object.hasOwn(detailData.currentVersion, "sourceUri"), false);
      if (id === managerDoc) assert.equal(detailData.currentVersion.sourceUri, "https://example.com/manager-source");
      const approval = await fetch(`${origin}/v1/documents/${id}/metadata`, { method: "PATCH", headers: scopeAdminHeaders, body: JSON.stringify({ status: "approved" }) });
      assert.equal(approval.status, 200, `${id}: ${await approval.clone().text()}`);
      documentSchema.parse(((await approval.json()) as any).data);
    }
    const searchedIds = async (userHeaders: Record<string, string>, ventureId = "") => {
      const response = await fetch(`${origin}/v1/knowledge/search?q=Scopeparity&limit=20${ventureId ? `&ventureId=${ventureId}` : ""}`, { headers: userHeaders });
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as any).data.items.map((item: any) => item.documentId) as string[];
    };
    assert.deepEqual(new Set(await searchedIds(scopeAdminHeaders)), new Set([ventureBDoc, workspaceDoc, "document-legacy-null", managerDoc, privateDoc]));
    assert.deepEqual(new Set(await searchedIds(scopeAdminHeaders, "venture-b")), new Set([ventureBDoc, workspaceDoc, "document-legacy-null"]));
    const headDocs = (await (await fetch(`${origin}/v1/documents`, { headers })).json()) as any;
    for (const id of [workspaceDoc, "document-legacy-null", managerDoc]) assert.equal(headDocs.data.items.some((item: any) => item.id === id), true, id);
    for (const id of [ventureBDoc, privateDoc]) assert.equal(headDocs.data.items.some((item: any) => item.id === id), false, id);
    assert.equal((await fetch(`${origin}/v1/documents/${ventureBDoc}`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/v1/documents/${privateDoc}`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/v1/documents/document-legacy-null`, { headers })).status, 200);
    assert.equal((await fetch(`${origin}/v1/documents/document-legacy-null/metadata`, { method: "PATCH", headers, body: JSON.stringify({ status: "stale" }) })).status, 403);
    assert.deepEqual(new Set(await searchedIds(headers)), new Set([workspaceDoc, "document-legacy-null", managerDoc]));
    const peerDocs = (await (await fetch(`${origin}/v1/documents`, { headers: scopePeerHeaders })).json()) as any;
    for (const id of [workspaceDoc, "document-legacy-null"]) assert.equal(peerDocs.data.items.some((item: any) => item.id === id), true, id);
    for (const id of [ventureBDoc, managerDoc, privateDoc]) assert.equal(peerDocs.data.items.some((item: any) => item.id === id), false, id);
    assert.equal((await fetch(`${origin}/v1/documents/${managerDoc}`, { headers: scopePeerHeaders })).status, 404);
    assert.equal((await fetch(`${origin}/v1/documents/${ventureBDoc}`, { headers: scopePeerHeaders })).status, 404);
    assert.deepEqual(new Set(await searchedIds(scopePeerHeaders)), new Set([workspaceDoc, "document-legacy-null"]));
    assert.equal((await fetch(`${origin}/v1/documents/${ventureBDoc}/metadata`, { method: "PATCH", headers, body: JSON.stringify({ status: "stale" }) })).status, 404);
    const created = await fetch(`${origin}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", title: "Ship the slice", outcome: "A verified slice", assigneeId: "user-test", priority: "high", dueAt: new Date(Date.now() + 3_600_000).toISOString(), timezone: "UTC", estimatedMinutes: 30, definitionOfDone: "Smoke passes", evidenceRequirement: "Attach smoke output", dependencies: [], evidenceLinks: [], tags: ["smoke"] }) });
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await created.json() as any;
    assert.equal(await database.db.collection("reminders").countDocuments(), 1);
    const myReminders = (await (await fetch(`${origin}/v1/reminders`, { headers })).json()) as any;
    assert.equal(myReminders.data.items.length, 1);
    assert.equal(myReminders.data.items[0].taskId, createdBody.data.id);
    assert.equal((await fetch(`${origin}/v1/reminders/${myReminders.data.items[0].id}`, { headers: { "x-dev-user-id": "user-peer" } })).status, 404);
    const focusStart = await fetch(`${origin}/v1/focus`, { method: "POST", headers, body: JSON.stringify({ taskId: createdBody.data.id, plannedMinutes: 25 }) });
    assert.equal(focusStart.status, 201);
    const focusId = ((await focusStart.json()) as any).data.id;
    assert.equal((await fetch(`${origin}/v1/focus/${focusId}/complete`, { method: "POST", headers })).status, 200);
    assert.equal(((await (await fetch(`${origin}/v1/focus/history`, { headers })).json()) as any).data.items[0].id, focusId);
    assert.equal(((await (await fetch(`${origin}/v1/focus/history`, { headers: { "x-dev-user-id": "user-peer" } })).json()) as any).data.items.length, 0);
    assert.equal(await database.db.collection("notification_outbox").countDocuments(), 1);
    assert.equal(await database.db.collection("audit_events").countDocuments({ action: "task.create" }), 1);
    const dashboardResponse = await fetch(`${origin}/v1/dashboard`, { headers });
    dashboardResponseSchema.parse(await dashboardResponse.json());
    const invalidReassignment = await fetch(`${origin}/v1/tasks/${createdBody.data.id}`, { method: "PATCH", headers, body: JSON.stringify({ assigneeId: "user-hidden" }) });
    assert.equal(invalidReassignment.status, 400);
    const taskReminder = await database.db.collection("reminders").findOne({ taskId: createdBody.data.id });
    await database.db.collection("notification_outbox").insertOne({ _id: "outbox-snooze-pending", workspaceId: "workspace-a", userId: "user-test", type: "reminder", title: "Start", body: "Start", resourceType: "task", resourceId: createdBody.data.id, reminderId: taskReminder?._id, idempotencyKey: "snooze-pending-0001", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    for (const minutes of [10, 20, 30]) {
      const snoozed = await fetch(`${origin}/v1/reminders/${taskReminder?._id}/snooze`, { method: "POST", headers, body: JSON.stringify({ minutes }) });
      assert.equal(snoozed.status, 200, await snoozed.text());
    }
    assert.equal((await database.db.collection("notification_outbox").findOne({ _id: "outbox-snooze-pending" }))?.state, "cancelled");
    assert.equal((await database.db.collection("reminders").findOne({ _id: taskReminder?._id }))?.sequence, 3);
    const silenced = await fetch(`${origin}/v1/reminders/${taskReminder?._id}/snooze`, { method: "POST", headers, body: JSON.stringify({ minutes: "never" }) });
    assert.equal(silenced.status, 200, await silenced.text());
    const terminalSnooze = await fetch(`${origin}/v1/reminders/${taskReminder?._id}/snooze`, { method: "POST", headers, body: JSON.stringify({ minutes: 10 }) });
    assert.equal(terminalSnooze.status, 409);

    const planned = await fetch(`${origin}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", title: "Reschedule safely", outcome: "Verified reminder", assigneeId: "user-peer", reviewerId: "user-peer", dueAt: new Date(Date.now() + 7_200_000).toISOString(), timezone: "UTC", estimatedMinutes: 30, definitionOfDone: "Checked", evidenceRequirement: "Evidence" }) });
    assert.equal(planned.status, 201, await planned.clone().text());
    const plannedId = ((await planned.json()) as any).data.id;
    const firstReminder = await database.db.collection("reminders").findOne({ taskId: plannedId });
    assert.equal(firstReminder?.userId, "user-peer");
    await database.db.collection("notification_outbox").insertOne({ _id: "outbox-old-schedule", workspaceId: "workspace-a", userId: "user-peer", type: "reminder", title: "Start", body: "Start", resourceType: "task", resourceId: plannedId, reminderId: firstReminder?._id, idempotencyKey: "old-schedule-0001", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    const riskyDueAt = new Date(Date.now() + 20 * 60_000).toISOString();
    const risky = await fetch(`${origin}/v1/tasks/${plannedId}`, { method: "PATCH", headers, body: JSON.stringify({ dueAt: riskyDueAt, estimatedMinutes: 30 }) });
    assert.equal(risky.status, 200, await risky.clone().text());
    assert.equal(((await risky.json()) as any).data.deadlineRisk, true);
    assert.ok((await database.db.collection("tasks").findOne({ _id: plannedId }))?.dueAt instanceof Date);
    assert.ok((await database.db.collection("reminders").findOne({ _id: firstReminder?._id }))?.scheduledAt <= new Date(Date.now() + 5_000));
    assert.equal((await database.db.collection("notification_outbox").findOne({ _id: "outbox-old-schedule" }))?.state, "cancelled");
    assert.equal((await database.db.collection("notification_outbox").findOne({ resourceId: plannedId, userId: "user-peer", type: "deadline_warning" }))?.state, "pending");
    const reassigned = await fetch(`${origin}/v1/tasks/${plannedId}`, { method: "PATCH", headers, body: JSON.stringify({ assigneeId: "user-test", dueAt: new Date(Date.now() + 7_200_000).toISOString() }) });
    assert.equal(reassigned.status, 200, await reassigned.clone().text());
    assert.equal(((await reassigned.json()) as any).data.deadlineRisk, false);
    assert.equal((await database.db.collection("notification_outbox").findOne({ resourceId: plannedId, userId: "user-peer", type: "deadline_warning" }))?.state, "cancelled");
    assert.equal((await database.db.collection("reminders").findOne({ _id: firstReminder?._id }))?.state, "cancelled");
    const newReminder = await database.db.collection("reminders").findOne({ taskId: plannedId, userId: "user-test", state: "scheduled" });
    assert.ok(newReminder);
    assert.ok(newReminder.scheduledAt > new Date(Date.now() + 60 * 60_000));
    assert.equal((await database.db.collection("notification_outbox").findOne({ resourceId: plannedId, userId: "user-peer", type: "assignment" }))?.state, "cancelled");
    assert.equal((await database.db.collection("notification_outbox").findOne({ resourceId: plannedId, userId: "user-test", type: "assignment" }))?.state, "pending");
    assert.equal((await fetch(`${origin}/v1/tasks/${plannedId}`, { method: "PATCH", headers: scopePeerHeaders, body: JSON.stringify({ status: "in_progress" }) })).status, 403);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "contributor", updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/tasks/${plannedId}`, { method: "PATCH", headers, body: JSON.stringify({ dueAt: new Date(Date.now() + 1_800_000).toISOString() }) })).status, 403);
    assert.equal((await fetch(`${origin}/v1/tasks/${plannedId}`, { method: "PATCH", headers, body: JSON.stringify({ status: "in_progress", blocker: "Started" }) })).status, 200);
    assert.equal((await database.db.collection("reminders").findOne({ _id: newReminder._id }))?.state, "cancelled");
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "learner", updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/tasks/${plannedId}`, { method: "PATCH", headers, body: JSON.stringify({ blocker: "Unauthorized" }) })).status, 403);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "venture_head", updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/tasks/${plannedId}`, { method: "PATCH", headers, body: JSON.stringify({ assigneeId: "user-peer" }) })).status, 200);
    assert.equal(await database.db.collection("notification_outbox").countDocuments({ resourceId: plannedId, userId: "user-peer", type: "assignment", state: "pending" }), 1);
    assert.equal(await database.db.collection("reminders").countDocuments({ taskId: plannedId, state: "scheduled" }), 0);

    await database.db.collection("users").insertMany([
      { _id: "user-ashutosh", workspaceId: "workspace-a", email: "ashutosh@example.invalid", name: "Ashutosh", status: "active" },
      { _id: "user-reserved", workspaceId: "workspace-a", email: "reserved@example.invalid", name: "Reserved", handle: "alex", status: "active" },
      { _id: "user-reserved-suffix", workspaceId: "workspace-a", email: "reserved-suffix@example.invalid", name: "Reserved Suffix", handle: `alex-${createHash("sha256").update("user-alex").digest("hex").slice(0, 8)}`, status: "active" },
      { _id: "user-alex", workspaceId: "workspace-a", email: "alex@example.invalid", name: "Alex", status: "active" },
      { _id: "user-dupe-a", workspaceId: "workspace-a", email: "dupe-a@example.invalid", name: "Duplicate A", handle: "dupe", status: "active" },
      { _id: "user-dupe-b", workspaceId: "workspace-a", email: "dupe-b@example.invalid", name: "Duplicate B", handle: "DUPE", status: "active" },
    ]);
    await database.db.collection("memberships").insertMany(["user-ashutosh", "user-alex", "user-dupe-a", "user-dupe-b"].map((userId) => ({ _id: `membership-${userId}`, workspaceId: "workspace-a", userId, role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], status: "active", createdAt: now, updatedAt: now })));
    assert.equal(await backfillMissingHandles(database), 2);
    assert.equal(await backfillMissingHandles(database), 0);
    assert.equal((await database.db.collection("users").findOne({ _id: "user-ashutosh" }))?.handle, "ashutosh");
    assert.equal((await database.db.collection("users").findOne({ _id: "user-alex" }))?.handle, `alex-${createHash("sha256").update("user-alex").digest("hex").slice(0, 12)}`);
    assert.equal((await database.db.collection("users").findOne({ _id: "user-reserved" }))?.handle, "alex");
    assert.equal(await database.db.collection("audit_events").countDocuments({ action: "user.handle.backfill" }), 2);
    const memberLookup = await fetch(`${origin}/v1/members?groupId=group-a&handle=ashutosh`, { headers });
    assert.equal(memberLookup.status, 200);
    const mentionId = ((await memberLookup.json()) as any).data.items[0].id;
    assert.equal(mentionId, "user-ashutosh");
    const mentioned = await fetch(`${origin}/v1/channels/channel-a/messages`, { method: "POST", headers, body: JSON.stringify({ body: "Please review @ashutosh", mentionUserIds: [mentionId], clientId: "mention-ashutosh-0001" }) });
    assert.equal(mentioned.status, 201, await mentioned.clone().text());
    assert.equal(await database.db.collection("notification_outbox").countDocuments({ type: "mention", userId: "user-ashutosh" }), 1);
    const mentionedId = ((await mentioned.json()) as any).data.message.id;
    assert.equal(await database.db.collection("notification_outbox").countDocuments({ resourceId: mentionedId, userId: "user-peer", chatKind: "channel", chatId: "channel-a" }), 1);
    assert.equal(await database.db.collection("notification_outbox").countDocuments({ resourceId: mentionedId, userId: "user-hidden" }), 0);
    assert.equal(await database.db.collection("notification_outbox").countDocuments({ resourceId: mentionedId, userId: "user-b" }), 0);
    await database.db.collection("notifications").insertMany([
      { _id: "visible-channel-note", outboxId: "visible-channel-note", workspaceId: "workspace-a", userId: "user-peer", type: "message", title: "Visible", body: "Generic", resourceType: "message", resourceId: mentionedId, chatKind: "channel", chatId: "channel-a", createdAt: new Date(now.getTime() - 1000) },
      { _id: "legacy-channel-note", outboxId: "legacy-channel-note", workspaceId: "workspace-a", userId: "user-peer", type: "mention", title: "Legacy", body: "Private", resourceType: "message", resourceId: mentionedId, createdAt: new Date(now.getTime() - 2000) },
    ]);
    const peerInbox = async () => ((await (await fetch(`${origin}/v1/notifications`, { headers: scopePeerHeaders })).json()) as any).data as Array<{ id: string }>;
    assert.ok((await peerInbox()).some((item) => item.id === "visible-channel-note"));
    await database.db.collection("notifications").insertMany(Array.from({ length: 101 }, (_, index) => ({ _id: `inaccessible-channel-note-${index}`, outboxId: `inaccessible-channel-note-${index}`, workspaceId: "workspace-a", userId: "user-peer", type: "message", title: "Hidden", body: "Hidden", resourceType: "message", resourceId: mentionedId, chatKind: "channel", chatId: "channel-hidden", createdAt: new Date(now.getTime() + index + 1) })));
    assert.ok((await peerInbox()).some((item) => item.id === "visible-channel-note"), "inaccessible recent notices must not crowd out older authorized notices");
    await database.db.collection("memberships").updateOne({ _id: "membership-peer" }, { $set: { groupIds: [] } });
    assert.ok(!(await peerInbox()).some((item) => item.id === "visible-channel-note" || item.id === "legacy-channel-note"));
    const peerDashboard = (await (await fetch(`${origin}/v1/dashboard`, { headers: scopePeerHeaders })).json()) as any;
    assert.ok(!peerDashboard.data.mentions.some((item: { id: string }) => item.id === "legacy-channel-note"));
    await database.db.collection("memberships").updateOne({ _id: "membership-peer" }, { $set: { groupIds: ["group-a"] } });
    assert.equal((await fetch(`${origin}/v1/members?groupId=group-a&handle=dupe`, { headers })).status, 409);
    assert.equal((await fetch(`${origin}/v1/members?groupId=group-a&handle=dupe&q=Duplicate%20A`, { headers })).status, 400);

    assert.equal((await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers: scopePeerHeaders, body: JSON.stringify({ channelId: "channel-a", input: `/assign @ashutosh "Denied" due=${new Date(Date.now() + 3_600_000).toISOString()} estimate=30 timezone=UTC` }) })).status, 403);
    assert.equal((await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers: scopePeerHeaders, body: JSON.stringify({ channelId: "channel-a", input: `/notify @ashutosh "Denied" at=${new Date(Date.now() + 3_600_000).toISOString()} timezone=UTC` }) })).status, 403);
    const assignPreview = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/assign @ashutosh "Review evidence" due=${new Date(Date.now() + 3_600_000).toISOString()} estimate=30 timezone=UTC` }) });
    assert.equal(assignPreview.status, 201, await assignPreview.clone().text());
    const assignPreviewId = ((await assignPreview.json()) as any).data.previewId;
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "contributor", updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: assignPreviewId, idempotencyKey: "assign-downgraded-0001" }) })).status, 403);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "venture_head", updatedAt: new Date() } });
    const assigned = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: assignPreviewId, idempotencyKey: "assign-ashutosh-0001" }) });
    assert.equal(assigned.status, 201, await assigned.clone().text());
    assert.equal(((await assigned.json()) as any).data.task.assigneeId, "user-ashutosh");
    const notifyPreview = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/notify @ashutosh "Review evidence" at=${new Date(Date.now() + 3_600_000).toISOString()} timezone=UTC` }) });
    assert.equal(notifyPreview.status, 201, await notifyPreview.clone().text());
    const notified = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: ((await notifyPreview.json()) as any).data.previewId, idempotencyKey: "notify-ashutosh-0001" }) });
    assert.equal(notified.status, 201, await notified.clone().text());
    assert.equal(((await notified.json()) as any).data.reminder.userId, "user-ashutosh");
    const positionalAssign = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/assign @ashutosh "Positional task" 90m ${new Date(Date.now() + 3_600_000).toISOString()}` }) });
    assert.equal(positionalAssign.status, 201, await positionalAssign.clone().text());
    const positionalAssignPreview = (await positionalAssign.json()) as any;
    assert.equal(positionalAssignPreview.data.command.estimatedMinutes, 90);
    const positionalTask = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: positionalAssignPreview.data.previewId, idempotencyKey: "assign-positional-0001" }) });
    assert.equal(positionalTask.status, 201, await positionalTask.clone().text());
    assert.equal(((await positionalTask.json()) as any).data.task.assigneeId, "user-ashutosh");
    const beforeRelative = Date.now();
    const positionalNotify = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: '/notify @ashutosh 1h "Positional reminder"' }) });
    assert.equal(positionalNotify.status, 201, await positionalNotify.clone().text());
    const positionalNotifyPreview = (await positionalNotify.json()) as any;
    assert.ok(new Date(positionalNotifyPreview.data.command.scheduledAt).getTime() >= beforeRelative + 3_600_000);
    assert.ok(new Date(positionalNotifyPreview.data.command.scheduledAt).getTime() <= Date.now() + 3_600_000);
    const positionalReminder = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: positionalNotifyPreview.data.previewId, idempotencyKey: "notify-positional-0001" }) });
    assert.equal(positionalReminder.status, 201, await positionalReminder.clone().text());
    const positionalReminderData = ((await positionalReminder.json()) as any).data.reminder;
    assert.equal(positionalReminderData.userId, "user-ashutosh");
    assert.equal(positionalReminderData.scheduledAt, positionalNotifyPreview.data.command.scheduledAt);
    const positionalReplay = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: positionalNotifyPreview.data.previewId, idempotencyKey: "notify-positional-0001" }) });
    assert.equal(positionalReplay.status, 200);
    assert.equal(((await positionalReplay.json()) as any).data.reminder.id, positionalReminderData.id);
    assert.equal((await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: positionalAssignPreview.data.previewId, idempotencyKey: "notify-positional-0001" }) })).status, 409);
    const invalidDelay = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: '/notify @ashutosh 0h "Invalid"' }) });
    assert.equal(invalidDelay.status, 400);
    assert.match(((await invalidDelay.json()) as any).error.message, /delay must/);
    const pastDeadline = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/assign @ashutosh "Late" 1h ${new Date(Date.now() - 60_000).toISOString()}` }) });
    assert.equal(pastDeadline.status, 400);
    assert.match(((await pastDeadline.json()) as any).error.message, /future/);
    await database.db.collection("command_previews").updateOne({ _id: positionalNotifyPreview.data.previewId }, { $set: { "command.scheduledAt": new Date(Date.now() - 60_000).toISOString() } });
    assert.equal((await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: positionalNotifyPreview.data.previewId, idempotencyKey: "notify-stale-0001" }) })).status, 409);
    const duplicatePreview = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/notify @dupe "Unsafe" at=${new Date(Date.now() + 3_600_000).toISOString()} timezone=UTC` }) });
    assert.equal(duplicatePreview.status, 201);
    assert.equal((await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: ((await duplicatePreview.json()) as any).data.previewId, idempotencyKey: "notify-dupe-0001" }) })).status, 409);

    const previewResponse = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/notify @test "Check evidence" at=${new Date(Date.now() + 60_000).toISOString()} timezone=UTC` }) });
    assert.equal(previewResponse.status, 201);
    const previewBody = await previewResponse.json() as any;
    const executeBody = { previewId: previewBody.data.previewId, idempotencyKey: "smoke-notify-0001" };
    const executed = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify(executeBody) });
    assert.equal(executed.status, 201, await executed.text());
    const replayed = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify(executeBody) });
    assert.equal(replayed.status, 200);
    assert.equal(await database.db.collection("command_executions").countDocuments({ idempotencyKey: "smoke-notify-0001" }), 1);
    const concurrentPreview = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/notify @test "Concurrent reminder" at=${new Date(Date.now() + 90_000).toISOString()} timezone=UTC` }) });
    assert.equal(concurrentPreview.status, 201);
    const concurrentBody = { previewId: ((await concurrentPreview.json()) as any).data.previewId, idempotencyKey: "notify-concurrent-0001" };
    const concurrentResults = await Promise.all(Array.from({ length: 2 }, () => fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify(concurrentBody) })));
    assert.deepEqual(concurrentResults.map((response) => response.status).sort(), [200, 201]);
    assert.equal(await database.db.collection("command_executions").countDocuments({ idempotencyKey: concurrentBody.idempotencyKey }), 1);
    assert.equal(await database.db.collection("reminders").countDocuments({ message: "Concurrent reminder", userId: "user-test" }), 1);
    const hiddenPreviewResponse = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/notify @hidden "Cross scope" at=${new Date(Date.now() + 60_000).toISOString()} timezone=UTC` }) });
    assert.equal(hiddenPreviewResponse.status, 201);
    const hiddenPreview = await hiddenPreviewResponse.json() as any;
    const hiddenExecute = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify({ previewId: hiddenPreview.data.previewId, idempotencyKey: "hidden-notify-0001" }) });
    assert.equal(hiddenExecute.status, 404);

    const privateDocument = await fetch(`${origin}/v1/documents`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", title: "Private", markdown: "# Secret", evidenceClass: "verified_fact", sensitivity: "founder_private", authoritativeRank: 90, changeSummary: "Test" }) });
    assert.equal(privateDocument.status, 403);
    assert.equal((await fetch(`${origin}/v1/documents/document-global`, { method: "PUT", headers, body: JSON.stringify({ markdown: "# Poison", changeSummary: "Unauthorized" }) })).status, 403);
    assert.equal((await fetch(`${origin}/v1/documents/document-global/metadata`, { method: "PATCH", headers, body: JSON.stringify({ status: "archived" }) })).status, 403);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "contributor", updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/documents/document-global`, { method: "PUT", headers, body: JSON.stringify({ markdown: "# Poison", changeSummary: "Unauthorized contributor" }) })).status, 403);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "venture_head", updatedAt: new Date() } });
    const documentResponse = await fetch(`${origin}/v1/documents`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", title: "Evidence note", markdown: "# Proof\n\nVerified launch evidence.", evidenceClass: "verified_fact", sensitivity: "venture_restricted", authoritativeRank: 90, changeSummary: "Test" }) });
    assert.equal(documentResponse.status, 201, await documentResponse.clone().text());
    const documentBody = await documentResponse.json() as any;
    const draftSearch = await fetch(`${origin}/v1/knowledge/search?q=launch+evidence&ventureId=venture-a`, { headers });
    assert.equal(((await draftSearch.json()) as any).data.items.length, 0);
    const approved = await fetch(`${origin}/v1/documents/${documentBody.data.id}/metadata`, { method: "PATCH", headers, body: JSON.stringify({ status: "approved", lastReviewedAt: new Date().toISOString() }) });
    assert.equal(approved.status, 200, await approved.text());
    const search = await fetch(`${origin}/v1/knowledge/search?q=launch+evidence&ventureId=venture-a`, { headers });
    assert.equal(((await search.json()) as any).data.items.length, 1);
    const revised = await fetch(`${origin}/v1/documents/${documentBody.data.id}`, { method: "PUT", headers, body: JSON.stringify({ markdown: "# Current\n\nCurrent atlas proof.", changeSummary: "Replace old proof" }) });
    assert.equal(revised.status, 200, await revised.text());
    await fetch(`${origin}/v1/documents/${documentBody.data.id}/metadata`, { method: "PATCH", headers, body: JSON.stringify({ status: "approved", lastReviewedAt: new Date().toISOString() }) });
    assert.equal(((await (await fetch(`${origin}/v1/knowledge/search?q=launch+evidence&ventureId=venture-a`, { headers })).json()) as any).data.items.length, 0);
    assert.equal(((await (await fetch(`${origin}/v1/knowledge/search?q=atlas+proof&ventureId=venture-a`, { headers })).json()) as any).data.items.length, 1);

    const intentResponse = await fetch(`${origin}/v1/uploads`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", taskId: createdBody.data.id, name: "proof.txt", contentType: "text/plain", size: 3 }) });
    assert.equal(intentResponse.status, 201);
    const intent = (await intentResponse.json()) as any;
    assert.equal((await fetch(`${origin}/v1/uploads/${intent.data.file.id}/complete`, { method: "POST", headers: { "content-type": "application/json", "x-dev-user-id": "user-peer" }, body: JSON.stringify({ etag: "other" }) })).status, 404);
    assert.equal((await fetch(intent.data.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "yes" })).status, 204);
    const complete = await fetch(`${origin}/v1/uploads/${intent.data.file.id}/complete`, { method: "POST", headers, body: JSON.stringify({ etag: "local" }) });
    assert.equal(complete.status, 200, await complete.text());
    assert.equal((await fetch(intent.data.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "bad" })).status, 403);
    const download = await fetch(`${origin}/v1/files/${intent.data.file.id}/download`, { headers });
    const downloadBody = (await download.json()) as any;
    assert.equal(await (await fetch(downloadBody.data.downloadUrl)).text(), "yes");
    const imageBody = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#168050" } }).png().toBuffer();
    await store.write("workspace-a/venture-a/objects/image-thumbnail-test", imageBody);
    await assert.rejects(store.read("workspace-a/venture-a/objects/image-thumbnail-test", imageBody.length - 1), /read limit/);
    await database.db.collection("files").insertOne({ _id: "image-thumbnail-test", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-test", name: "sample.png", contentType: "image/png", size: imageBody.length, objectKey: "workspace-a/venture-a/objects/image-thumbnail-test", status: "ready", storage: "local", createdAt: new Date() });
    const imageThumbnail = await fetch(`${origin}/v1/files/image-thumbnail-test/thumbnail`, { headers });
    assert.equal(imageThumbnail.status, 200);
    assert.equal(imageThumbnail.headers.get("content-type"), "image/webp");
    assert.equal(imageThumbnail.headers.get("cache-control"), "private, no-store");
    const thumbnailBody = Buffer.from(await imageThumbnail.arrayBuffer());
    assert.ok(thumbnailBody.length < imageBody.length);
    assert.equal((await sharp(thumbnailBody).metadata()).width, 512);
    assert.equal((await fetch(`${origin}/v1/files/image-thumbnail-test/thumbnail`, { headers: { "x-dev-user-id": "user-hidden" } })).status, 404);
    assert.equal((await fetch(`${origin}/v1/files/${intent.data.file.id}/thumbnail`, { headers })).status, 415);
    await store.write("workspace-a/venture-a/objects/broken-thumbnail-test", Buffer.from("not an image"));
    await database.db.collection("files").insertOne({ _id: "broken-thumbnail-test", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-test", name: "broken.png", contentType: "image/png", size: 12, objectKey: "workspace-a/venture-a/objects/broken-thumbnail-test", status: "ready", storage: "local", createdAt: new Date() });
    assert.equal((await fetch(`${origin}/v1/files/broken-thumbnail-test/thumbnail`, { headers })).status, 422);
    await database.db.collection("files").deleteOne({ _id: "image-thumbnail-test", workspaceId: "workspace-a" });
    await database.db.collection("files").deleteOne({ _id: "broken-thumbnail-test", workspaceId: "workspace-a" });
    await store.discard("workspace-a/venture-a/objects/image-thumbnail-test");
    await store.discard("workspace-a/venture-a/objects/broken-thumbnail-test");
    const unavailableR2: ObjectStore = {
      kind: "r2",
      async uploadUrl() { throw new Error("R2 unavailable in this test"); },
      async downloadUrl() { throw new Error("R2 unavailable in this test"); },
      async read() { throw new Error("R2 unavailable in this test"); },
      async head() { throw new Error("R2 unavailable in this test"); },
      async finalize() { throw new Error("R2 unavailable in this test"); },
      async discard() { throw new Error("R2 unavailable in this test"); },
    };
    const switchedConfig = { ...config, FILE_STORAGE: "r2" as const };
    const switchedServer = createServer(createApp(database, switchedConfig, auth, unavailableR2).app).listen(0);
    try {
      await once(switchedServer, "listening");
      const switchedAddress = switchedServer.address();
      switchedConfig.API_ORIGIN = `http://127.0.0.1:${typeof switchedAddress === "object" && switchedAddress ? switchedAddress.port : 0}`;
      const legacyDownload = await fetch(`${switchedConfig.API_ORIGIN}/v1/files/${intent.data.file.id}/download`, { headers });
      assert.equal(legacyDownload.status, 200, await legacyDownload.clone().text());
      assert.equal(await (await fetch(((await legacyDownload.json()) as any).data.downloadUrl)).text(), "yes");
      await database.db.collection("files").insertOne({ _id: "r2-thumbnail-unavailable", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-test", name: "r2.png", contentType: "image/png", size: 1, objectKey: "fake", status: "ready", storage: "r2", createdAt: new Date() });
      assert.equal((await fetch(`${switchedConfig.API_ORIGIN}/v1/files/r2-thumbnail-unavailable/thumbnail`, { headers })).status, 500);
      await database.db.collection("files").deleteOne({ _id: "r2-thumbnail-unavailable" });
    } finally { await new Promise<void>((resolve) => switchedServer.close(() => resolve())); }
    await database.db.collection("files").insertOne({ _id: "r2-unavailable", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-test", name: "r2.txt", contentType: "text/plain", size: 1, objectKey: "fake", status: "ready", storage: "r2", createdAt: new Date() });
    assert.equal((await fetch(`${origin}/v1/files/r2-unavailable/download`, { headers })).status, 503);
    await database.db.collection("files").deleteOne({ _id: "r2-unavailable" });
    await database.db.collection("files").insertOne({ _id: "file-malformed-cross-tenant", workspaceId: "workspace-other", ventureId: "venture-other", groupId: "group-other", taskId: createdBody.data.id, ownerId: "other", name: "leak.txt", contentType: "text/plain", size: 1, objectKey: "other", status: "ready", storage: "local", createdAt: new Date() });
    await database.db.collection("files").insertOne({ _id: "file-same-group-other-workspace", workspaceId: "workspace-other", ventureId: "venture-a", groupId: "group-a", ownerId: "other", name: "cross-workspace.txt", contentType: "text/plain", size: 1, objectKey: "other", status: "ready", storage: "local", createdAt: new Date() });
    const taskWithAttachment = await (await fetch(`${origin}/v1/tasks/${createdBody.data.id}`, { headers })).json() as any;
    assert.deepEqual(taskWithAttachment.data.attachments.map((file: any) => file.id), [intent.data.file.id]);
    assert.equal((await fetch(`${origin}/v1/groups/group-hidden/files`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/v1/groups/group-b/files`, { headers })).status, 404);
    assert.deepEqual(((await (await fetch(`${origin}/v1/groups/group-a/files`, { headers })).json()) as any).data.items.map((file: any) => file.id), [intent.data.file.id]);
    assert.equal(Object.hasOwn(((await (await fetch(`${origin}/v1/groups/group-a/files`, { headers })).json()) as any).data.items[0], "objectKey"), false);
    assert.equal((await fetch(`${origin}/v1/uploads`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", name: "bad.exe", contentType: "application/x-msdownload", size: 3 }) })).status, 400);

    const recoveryIntentResponse = await fetch(`${origin}/v1/uploads`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", name: "recover.txt", contentType: "text/plain", size: 3 }) });
    const recoveryIntent = await recoveryIntentResponse.json() as any;
    await fetch(recoveryIntent.data.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "yes" });
    const recoveryFile = await database.db.collection("files").findOne({ _id: recoveryIntent.data.file.id });
    const recoveryMetadata = await store.head(String(recoveryFile?.uploadKey));
    await database.db.collection("files").updateOne({ _id: recoveryFile?._id }, { $set: { status: "finalizing", stagingEtag: recoveryMetadata.etag, finalizationStartedAt: new Date() } });
    await store.finalize(String(recoveryFile?.uploadKey), String(recoveryFile?.objectKey));
    const recovered = await fetch(`${origin}/v1/uploads/${recoveryFile?._id}/complete`, { method: "POST", headers, body: JSON.stringify({ etag: "local" }) });
    assert.equal(recovered.status, 200, await recovered.text());
    assert.equal((await database.db.collection("files").findOne({ _id: recoveryFile?._id }))?.uploadKey, undefined);
    for (const [name, contentType] of [["clip.mp4", "video/mp4"], ["voice.webm", "audio/webm"]] as const) {
      const response = await fetch(`${origin}/v1/uploads`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", name, contentType, size: 3 }) });
      assert.equal(response.status, 201, await response.clone().text());
      const upload = (await response.json()) as any;
      assert.equal((await fetch(upload.data.uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: "yes" })).status, 204);
      assert.equal((await fetch(`${origin}/v1/uploads/${upload.data.file.id}/complete`, { method: "POST", headers, body: JSON.stringify({ etag: "local" }) })).status, 200);
    }
    const groupFileNames: string[] = [];
    let groupFileCursor: string | undefined;
    do {
      const page = (await (await fetch(`${origin}/v1/groups/group-a/files?limit=1${groupFileCursor ? `&cursor=${groupFileCursor}` : ""}`, { headers })).json()) as any;
      groupFileNames.push(...page.data.items.map((file: any) => file.name));
      groupFileCursor = page.data.nextCursor;
    } while (groupFileCursor);
    assert.deepEqual(new Set(groupFileNames), new Set(["proof.txt", "recover.txt", "clip.mp4", "voice.webm"]));
    const downgradedIntent = await fetch(`${origin}/v1/uploads`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", taskId: createdBody.data.id, name: "role-check.txt", contentType: "text/plain", size: 3 }) });
    assert.equal(downgradedIntent.status, 201, await downgradedIntent.clone().text());
    const downgradedFile = (await downgradedIntent.json()) as any;
    assert.equal((await fetch(downgradedFile.data.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "yes" })).status, 204);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "reviewer", updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/uploads/${downgradedFile.data.file.id}/complete`, { method: "POST", headers, body: JSON.stringify({ etag: "local" }) })).status, 403);
    assert.equal((await database.db.collection("files").findOne({ _id: downgradedFile.data.file.id }))?.status, "pending");
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { role: "venture_head", updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/uploads/${downgradedFile.data.file.id}/complete`, { method: "POST", headers, body: JSON.stringify({ etag: "local" }) })).status, 200);
    await database.db.collection("api_rate_limits").deleteMany({}); // Reset this isolated fixture between independent API flows.

    const patResponse = await fetch(`${origin}/v1/pats`, { method: "POST", headers, body: JSON.stringify({ name: "smoke", scopes: ["ventures:read", "tasks:read", "knowledge:read"] }) });
    assert.equal(patResponse.status, 201);
    const patBody = (await patResponse.json()) as any;
    assert.equal(patBody.data.pat.tokenHash, undefined);
    const mcpActor = await authenticatePat(database.db, patBody.data.token);
    const mcpService = new McpReadService(database.db, mcpActor);
    const ventures = await mcpService.listVentures();
    assert.equal((ventures.data as any[]).length, 1);
    const globalKnowledge = await mcpService.searchKnowledge("globalparity", "venture-a");
    assert.equal((globalKnowledge.data as any[]).some((item: any) => item.documentId === "document-global"), true);
    assert.deepEqual(new Set(((await mcpService.searchKnowledge("scopeparity", "venture-a", 20)).data as any[]).map((item: any) => item.documentId)), new Set([workspaceDoc, "document-legacy-null", managerDoc]));
    assert.equal((await database.db.collection("pats").findOne({ _id: patBody.data.pat.id }))?.lastUsedAt instanceof Date, true);
    await fetch(`${origin}/v1/pats/${patBody.data.pat.id}/revoke`, { method: "POST", headers });
    await assert.rejects(() => authenticatePat(database.db, patBody.data.token));
    await assert.rejects(() => mcpService.listVentures());
    assert.equal(await database.db.collection("audit_events").countDocuments({ action: "mcp.list_ventures", result: "denied" }), 1);

    const sameTime = new Date();
    await database.db.collection("events").insertMany([
      { _id: "event-cursor-a", eventId: "event-cursor-a", version: 1, occurredAt: sameTime, actorId: "user-test", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", type: "test.first", payload: {} },
      { _id: "event-cursor-b", eventId: "event-cursor-b", version: 1, occurredAt: sameTime, actorId: "user-test", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", type: "test.second", payload: {} },
      { _id: "event-private", eventId: "event-private", version: 1, occurredAt: sameTime, actorId: "user-hidden", workspaceId: "workspace-a", audienceUserIds: ["user-hidden"], type: "direct_message.created", payload: {} },
      { _id: "event-hidden-group", eventId: "event-hidden-group", version: 1, occurredAt: sameTime, actorId: "user-hidden", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-hidden", type: "message.created", payload: {} },
    ]);
    const afterCursor = await fetch(`${origin}/v1/events?after=event-cursor-a`, { headers });
    const afterEvents = (await afterCursor.json()) as any;
    assert.equal(afterEvents.data.some((value: any) => value.eventId === "event-cursor-b"), true);
    assert.equal(afterEvents.data.some((value: any) => value.eventId === "event-private" || value.eventId === "event-hidden-group"), false);
    for (const value of afterEvents.data) eventEnvelopeSchema.parse(value);

    const invalidMention = await fetch(`${origin}/v1/channels/channel-a/messages`, { method: "POST", headers, body: JSON.stringify({ body: "Cross-boundary mention", mentionUserIds: ["user-hidden"], clientId: "invalid-mention-0001" }) });
    assert.equal(invalidMention.status, 400);
    const adminHeaders = { "content-type": "application/json", "x-dev-user-id": "user-admin" };
    const inviteUrl = `${origin}/v1/admin/invitations`;
    const inviteBody = { email: "invited@example.invalid", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"] };
    assert.equal((await fetch(inviteUrl, { method: "POST", headers, body: JSON.stringify(inviteBody) })).status, 403);
    const manualInvite = await fetch(inviteUrl, { method: "POST", headers: adminHeaders, body: JSON.stringify(inviteBody) });
    assert.equal(manualInvite.status, 201, await manualInvite.clone().text());
    const manualInviteData = ((await manualInvite.json()) as any).data;
    assert.equal(manualInviteData.delivery.mode, "manual");
    assert.equal(manualInviteData.delivery.status, "not_sent");
    assert.equal(typeof manualInviteData.token, "string");
    assert.equal(await database.db.collection("invitations").countDocuments({ _id: manualInviteData.invitation.id, status: "pending" }), 1);
    config.RESEND_API_KEY = "re_test_mock_only";
    config.EMAIL_FROM = "Studio <invites@example.com>";
    const originalFetch = globalThis.fetch;
    let sentPayload: Record<string, unknown> | undefined;
    let sentIdempotencyKey = "";
    let providerStatus: number | "timeout" = 200;
    let ambiguousInvitationToken = "";
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]) === "https://api.resend.com/emails") {
        sentPayload = JSON.parse(String(args[1]?.body)) as Record<string, unknown>;
        sentIdempotencyKey = new Headers(args[1]?.headers).get("Idempotency-Key") ?? "";
        if (providerStatus === "timeout") throw new Error("Simulated provider timeout after possible acceptance");
        return new Response(providerStatus === 200 ? JSON.stringify({ id: "mock-resend-message-id" }) : "{}", { status: providerStatus, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const emailedInvite = await fetch(inviteUrl, { method: "POST", headers: adminHeaders, body: JSON.stringify(inviteBody) });
      assert.equal(emailedInvite.status, 201, await emailedInvite.clone().text());
      const emailedData = ((await emailedInvite.json()) as any).data;
      assert.deepEqual(emailedData.delivery, { mode: "email", status: "sent" });
      assert.equal("token" in emailedData, false);
      assert.equal("tokenHash" in emailedData.invitation, false);
      assert.equal(sentPayload?.to, inviteBody.email);
      assert.equal(sentPayload?.from, "Studio <invites@example.com>");
      const emailedLink = String(sentPayload?.text).match(/https?:\/\/\S+\/invite\/live\?token=\S+/)?.[0];
      assert.ok(emailedLink);
      const emailedToken = new URL(emailedLink).searchParams.get("token");
      assert.ok(emailedToken);
      assert.equal(sentIdempotencyKey, `invitation/${emailedData.invitation.id}`);
      assert.equal(await database.db.collection("invitations").countDocuments({ _id: emailedData.invitation.id, status: "pending", tokenHash: createHash("sha256").update(emailedToken).digest("hex"), "delivery.status": "sent" }), 1);
      assert.equal(await database.db.collection("invitations").countDocuments({ _id: manualInviteData.invitation.id, status: "pending" }), 1);
      providerStatus = 422;
      const rejectedInvite = await fetch(inviteUrl, { method: "POST", headers: adminHeaders, body: JSON.stringify(inviteBody) });
      assert.equal(rejectedInvite.status, 503);
      assert.equal(await database.db.collection("invitations").countDocuments({ workspaceId: "workspace-a", email: inviteBody.email, status: "pending", "delivery.status": "unconfirmed" }), 1);
      assert.equal(await database.db.collection("invitations").countDocuments({ _id: emailedData.invitation.id, status: "pending" }), 1);
      providerStatus = "timeout";
      const timedOutInvite = await fetch(inviteUrl, { method: "POST", headers: adminHeaders, body: JSON.stringify(inviteBody) });
      assert.equal(timedOutInvite.status, 503);
      const ambiguousLink = String(sentPayload?.text).match(/https?:\/\/\S+\/invite\/live\?token=\S+/)?.[0];
      assert.ok(ambiguousLink);
      ambiguousInvitationToken = new URL(ambiguousLink).searchParams.get("token") ?? "";
      assert.ok(ambiguousInvitationToken);
      assert.equal(await database.db.collection("invitations").countDocuments({ workspaceId: "workspace-a", email: inviteBody.email, status: "pending", tokenHash: createHash("sha256").update(ambiguousInvitationToken).digest("hex"), "delivery.status": "unconfirmed" }), 1);
    } finally {
      globalThis.fetch = originalFetch;
      config.RESEND_API_KEY = undefined;
      config.EMAIL_FROM = "Venture Studio <noreply@example.invalid>";
    }
    assert.equal((await fetch(`${origin}/v1/admin/channels`, { method: "POST", headers, body: JSON.stringify({ groupId: "group-a", name: "Launch Plan" }) })).status, 403);
    const newChannel = await fetch(`${origin}/v1/admin/channels`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ groupId: "group-a", name: "Launch Plan" }) });
    assert.equal(newChannel.status, 201, await newChannel.clone().text());
    assert.equal(((await newChannel.json()) as any).data.name, "launch-plan");
    assert.equal((await fetch(`${origin}/v1/admin/channels`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ groupId: "group-a", name: "Launch Plan" }) })).status, 409);
    const membershipBody = { role: "reviewer", ventureIds: ["venture-a"], groupIds: ["group-a"] };
    assert.equal((await fetch(`${origin}/v1/admin/memberships/membership-peer`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ ...membershipBody, groupIds: ["group-b"] }) })).status, 400);
    assert.equal((await fetch(`${origin}/v1/admin/memberships/membership-admin`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(membershipBody) })).status, 403);
    const updatedMember = await fetch(`${origin}/v1/admin/memberships/membership-peer`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(membershipBody) });
    assert.equal(updatedMember.status, 200, await updatedMember.clone().text());
    assert.equal(((await updatedMember.json()) as any).data.role, "reviewer");
    await database.db.collection("users").insertOne({ _id: "user-join", workspaceId: "workspace-a", email: "join@example.invalid", name: "Join Candidate", handle: "join", status: "active", createdAt: now, updatedAt: now });
    await database.db.collection("memberships").insertOne({ _id: "membership-join", workspaceId: "workspace-a", userId: "user-join", role: "contributor", ventureIds: [], groupIds: [], status: "active", createdAt: now, updatedAt: now });
    assert.equal((await fetch(inviteUrl, { method: "POST", headers: adminHeaders, body: JSON.stringify({ ...inviteBody, email: "join@example.invalid" }) })).status, 409);
    const groupMemberUrl = (groupId: string, userId: string) => `${origin}/v1/groups/${groupId}/members/${userId}`;
    assert.equal((await fetch(groupMemberUrl("group-hidden", "user-join"), { method: "PUT", headers })).status, 403);
    assert.equal((await fetch(groupMemberUrl("group-missing", "user-join"), { method: "PUT", headers: adminHeaders })).status, 404);
    assert.equal((await fetch(groupMemberUrl("group-a", "user-missing"), { method: "PUT", headers: adminHeaders })).status, 404);
    assert.equal((await fetch(groupMemberUrl("group-a", "user-admin"), { method: "DELETE", headers: adminHeaders })).status, 403);
    const addedToGroup = await fetch(groupMemberUrl("group-a", "user-join"), { method: "PUT", headers: adminHeaders });
    assert.equal(addedToGroup.status, 200, await addedToGroup.clone().text());
    const addedMembership = ((await addedToGroup.json()) as any).data;
    assert.deepEqual(addedMembership.ventureIds, ["venture-a"]);
    assert.deepEqual(addedMembership.groupIds, ["group-a"]);
    assert.deepEqual(addedMembership.inheritedVentureIds, ["venture-a"]);
    assert.equal((await fetch(groupMemberUrl("group-a", "user-join"), { method: "PUT", headers: adminHeaders })).status, 200);
    assert.equal(await database.db.collection("audit_events").countDocuments({ action: "group.member.add", objectId: "membership-join" }), 1);
    assert.equal(((await (await fetch(`${origin}/v1/members?groupId=group-a`, { headers: adminHeaders })).json()) as any).data.items.some((item: any) => item.id === "user-join"), true);
    const removedFromGroup = await fetch(groupMemberUrl("group-a", "user-join"), { method: "DELETE", headers: adminHeaders });
    assert.equal(removedFromGroup.status, 200, await removedFromGroup.clone().text());
    const removedMembership = ((await removedFromGroup.json()) as any).data;
    assert.deepEqual(removedMembership.groupIds, []);
    assert.deepEqual(removedMembership.ventureIds, []);
    assert.deepEqual(removedMembership.inheritedVentureIds, []);
    assert.equal((await fetch(groupMemberUrl("group-a", "user-join"), { method: "DELETE", headers: adminHeaders })).status, 200);
    assert.equal(await database.db.collection("audit_events").countDocuments({ action: "group.member.remove", objectId: "membership-join" }), 1);
    assert.equal(((await (await fetch(`${origin}/v1/members?groupId=group-a`, { headers: adminHeaders })).json()) as any).data.items.some((item: any) => item.id === "user-join"), false);
    assert.equal(((await (await fetch(`${origin}/v1/members?groupId=group-a`, { headers: adminHeaders })).json()) as any).data.items.some((item: any) => item.id === "user-admin"), true);
    assert.deepEqual(((await (await fetch(`${origin}/v1/session/bootstrap`, { headers: { "x-dev-user-id": "user-join" } })).json()) as any).data.hierarchy.ventures, []);
    await database.db.collection("users").insertOne({ _id: "user-direct", workspaceId: "workspace-a", email: "direct@example.invalid", name: "Direct Grant", handle: "direct", status: "active", createdAt: now, updatedAt: now });
    await database.db.collection("memberships").insertOne({ _id: "membership-direct", workspaceId: "workspace-a", userId: "user-direct", role: "contributor", ventureIds: ["venture-a"], groupIds: [], status: "active", createdAt: now, updatedAt: now });
    assert.equal((await fetch(groupMemberUrl("group-a", "user-direct"), { method: "PUT", headers: adminHeaders })).status, 200);
    const removedDirectGroup = await fetch(groupMemberUrl("group-a", "user-direct"), { method: "DELETE", headers: adminHeaders });
    assert.equal(removedDirectGroup.status, 200);
    assert.deepEqual(((await removedDirectGroup.json()) as any).data.ventureIds, ["venture-a"]);
    await database.db.collection("decisions").insertOne({ _id: "decision-a", workspaceId: "workspace-a", ventureId: "venture-a", title: "Initial", status: "draft", updatedAt: now });
    await database.db.collection("classes").insertOne({ _id: "class-a", workspaceId: "workspace-a", ventureId: "venture-a", title: "Initial", objective: "Learn", scheduledAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, facilitatorId: "user-test", participantIds: ["user-peer"], status: "scheduled", createdAt: now, updatedAt: now });
    assert.equal((await fetch(`${origin}/v1/classes/class-a`, { method: "PATCH", headers, body: JSON.stringify({ participantIds: ["user-b"] }) })).status, 400);
    assert.equal((await fetch(`${origin}/v1/classes`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", title: "Cross venture", objective: "No", scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30, facilitatorId: "user-test", participantIds: ["user-b"], status: "scheduled" }) })).status, 400);
    await database.db.collection("classes").insertOne({ _id: "class-legacy-leak", workspaceId: "workspace-a", ventureId: "venture-a", title: "Legacy cross-scope", objective: "Never visible", scheduledAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, facilitatorId: "user-test", participantIds: ["user-b"], status: "scheduled", createdAt: now, updatedAt: now });
    await database.db.collection("classes").insertOne({ _id: "class-global", workspaceId: "workspace-a", title: "Workspace lesson", objective: "Visible to members", scheduledAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, facilitatorId: "user-test", participantIds: ["user-b"], status: "scheduled", createdAt: now, updatedAt: now });
    const bHeaders = { "content-type": "application/json", "x-dev-user-id": "user-b" };
    assert.deepEqual(((await (await fetch(`${origin}/v1/dashboard`, { headers: bHeaders })).json()) as any).data.classes.map((item: any) => item.id), ["class-global"]);
    assert.deepEqual(((await (await fetch(`${origin}/v1/classes`, { headers: bHeaders })).json()) as any).data.map((item: any) => item.id), ["class-global"]);
    assert.equal((await fetch(`${origin}/v1/classes/class-legacy-leak/applications`, { method: "POST", headers: bHeaders, body: JSON.stringify({ exercise: "Should not submit", reviewerId: "user-test" }) })).status, 404);
    assert.equal((await fetch(`${origin}/v1/classes/class-global/applications`, { method: "POST", headers: bHeaders, body: JSON.stringify({ exercise: "Completed", reviewerId: "user-test" }) })).status, 201);
    const classApplication = (await (await fetch(`${origin}/v1/classes/class-global/applications`, { method: "POST", headers: bHeaders, body: JSON.stringify({ exercise: "Second exercise", reviewerId: "user-test" }) })).json() as any).data;
    assert.equal((await fetch(`${origin}/v1/classes/class-global/applications`, { method: "POST", headers: bHeaders, body: JSON.stringify({ exercise: "Invalid reviewer", reviewerId: "not-a-member" }) })).status, 400);
    assert.equal((await fetch(`${origin}/v1/classes/class-global/applications`, { method: "POST", headers: bHeaders, body: JSON.stringify({ exercise: "Self review", reviewerId: "user-b" }) })).status, 400);
    assert.equal((await fetch(`${origin}/v1/classes/class-legacy-leak/applications`, { headers: bHeaders })).status, 404);
    assert.equal((await fetch(`${origin}/v1/classes/class-global/applications`, { headers: { "x-dev-user-id": "user-peer" } })).status, 404);
    const applicationPage = (await (await fetch(`${origin}/v1/classes/class-global/applications?limit=1`, { headers: bHeaders })).json() as any).data;
    assert.equal(applicationPage.items.length, 1);
    assert.ok(applicationPage.nextCursor);
    assert.equal(((await (await fetch(`${origin}/v1/classes/class-global/applications?limit=1&cursor=${applicationPage.nextCursor}`, { headers: bHeaders })).json()) as any).data.items.length, 1);
    assert.equal((await fetch(`${origin}/v1/classes/class-global/applications/${classApplication.id}`, { headers: bHeaders })).status, 200);
    assert.equal((await fetch(`${origin}/v1/classes/class-global/applications/${classApplication.id}`, { headers: { "x-dev-user-id": "user-peer" } })).status, 404);
    assert.equal((await fetch(`${origin}/v1/classes/class-global/applications/${classApplication.id}/review`, { method: "PATCH", headers: bHeaders, body: JSON.stringify({ assessment: "Self approved" }) })).status, 403);
    const reviewedApplication = await fetch(`${origin}/v1/classes/class-global/applications/${classApplication.id}/review`, { method: "PATCH", headers, body: JSON.stringify({ assessment: "Good work", nextGap: "Practice more" }) });
    assert.equal(reviewedApplication.status, 200, await reviewedApplication.clone().text());
    assert.equal(((await reviewedApplication.json()) as any).data.reviewedBy, "user-test");
    const assignedApplication = (await (await fetch(`${origin}/v1/classes/class-a/applications`, { method: "POST", headers: { "content-type": "application/json", "x-dev-user-id": "user-peer" }, body: JSON.stringify({ exercise: "Peer exercise", reviewerId: "user-hidden" }) })).json() as any).data;
    const hiddenHeaders = { "content-type": "application/json", "x-dev-user-id": "user-hidden" };
    assert.equal(((await (await fetch(`${origin}/v1/classes`, { headers: hiddenHeaders })).json()) as any).data.some((item: any) => item.id === "class-a"), true);
    assert.equal((await fetch(`${origin}/v1/classes/class-a`, { headers: hiddenHeaders })).status, 200);
    assert.equal(((await (await fetch(`${origin}/v1/classes/class-a/applications`, { headers: hiddenHeaders })).json()) as any).data.items[0].id, assignedApplication.id);
    assert.equal((await fetch(`${origin}/v1/classes/class-a/applications/${assignedApplication.id}/review`, { method: "PATCH", headers: hiddenHeaders, body: JSON.stringify({ assessment: "Reviewed independently" }) })).status, 200);
    await database.db.collection("outcomes").insertOne({ _id: "outcome-a", workspaceId: "workspace-a", ventureId: "venture-a", title: "Initial", updatedAt: now });
    const pipelineInput = { name: "Scoped create test", offerName: "Test offer", status: "active" };
    const allScopePipeline = await fetch(`${origin}/v1/pipelines`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ ...pipelineInput, ventureId: "venture-b" }) });
    assert.equal(allScopePipeline.status, 201, await allScopePipeline.clone().text());
    const allScopePipelineId = ((await allScopePipeline.json()) as any).data.id;
    assert.equal((await database.db.collection("pipelines").findOne({ _id: allScopePipelineId }))?.ventureId, "venture-b");
    const fixedScopePipeline = await fetch(`${origin}/v1/pipelines`, { method: "POST", headers, body: JSON.stringify({ ...pipelineInput, ventureId: "venture-a" }) });
    assert.equal(fixedScopePipeline.status, 201, await fixedScopePipeline.clone().text());
    const fixedScopePipelineId = ((await fixedScopePipeline.json()) as any).data.id;
    assert.equal((await database.db.collection("pipelines").findOne({ _id: fixedScopePipelineId }))?.ventureId, "venture-a");
    assert.equal((await fetch(`${origin}/v1/pipelines`, { method: "POST", headers, body: JSON.stringify({ ...pipelineInput, ventureId: "venture-b" }) })).status, 403);
    assert.equal((await fetch(`${origin}/v1/pipelines`, { method: "POST", headers: bHeaders, body: JSON.stringify({ ...pipelineInput, ventureId: "venture-b" }) })).status, 403);
    const headPipelines = ((await (await fetch(`${origin}/v1/pipelines`, { headers })).json()) as any).data;
    assert.equal(headPipelines.some((pipeline: any) => pipeline.id === fixedScopePipelineId), true);
    assert.equal(headPipelines.some((pipeline: any) => pipeline.id === allScopePipelineId), false);
    await database.db.collection("pipelines").insertOne({ _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Initial", updatedAt: now });
    await database.db.collection("opportunities").insertOne({ _id: "opportunity-a", workspaceId: "workspace-a", ventureId: "venture-a", pipelineId: "pipeline-a", ownerId: "user-peer", stage: "identified", updatedAt: now });
    for (const [path, body] of [["decisions/decision-a", { status: "approved" }], ["classes/class-a", { status: "completed" }], ["outcomes/outcome-a", { status: "active" }], ["pipelines/pipeline-a", { status: "paused" }], ["opportunities/opportunity-a", { stage: "qualified" }]] as const) {
      const response = await fetch(`${origin}/v1/${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      assert.equal((await response.json() as any).data.status ?? (await database.db.collection("opportunities").findOne({ _id: "opportunity-a" }))?.stage, "status" in body ? body.status : body.stage);
    }
    assert.equal((await fetch(`${origin}/v1/decisions/decision-a`, { method: "PATCH", headers: { "content-type": "application/json", "x-dev-user-id": "user-hidden" }, body: JSON.stringify({ status: "approved" }) })).status, 403);

    let magicLinkUrl = "";
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      try { const value = JSON.parse(String(args[0])); if (value.event === "magic_link") magicLinkUrl = value.url; } catch { /* structured logging is best-effort in this test */ }
      originalInfo(...args);
    };
    try {
      const magicStart = await fetch(`${origin}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: config.APP_ORIGIN }, body: JSON.stringify({ email: "invited@example.invalid", name: "Invited User" }) });
      assert.equal(magicStart.status, 200, await magicStart.text());
    } finally { console.info = originalInfo; }
    assert.notEqual(magicLinkUrl, "");
    const magic = new URL(magicLinkUrl);
    const verify = await fetch(`${origin}${magic.pathname}?token=${encodeURIComponent(magic.searchParams.get("token")!)}`, { redirect: "manual" });
    assert.equal(verify.status, 200, await verify.clone().text());
    const sessionCookie = verify.headers.get("set-cookie")?.split(";")[0];
    assert.ok(sessionCookie);
    const verifiedUser = (await verify.json() as any).user;
    const sessionCheck = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie: sessionCookie } });
    assert.equal(sessionCheck.status, 200);
    const replayVerify = await fetch(`${origin}${magic.pathname}?token=${encodeURIComponent(magic.searchParams.get("token")!)}`, { redirect: "manual" });
    assert.equal(replayVerify.status, 302);

    const invitationToken = ambiguousInvitationToken;
    const wrongRecipientToken = "invitation-token-wrong-0000001";
    const expiredInvitationToken = "invitation-token-expired-00001";
    await database.db.collection("invitations").insertMany([
      { _id: "invite-wrong", workspaceId: "workspace-a", email: "someone-else@example.invalid", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], tokenHash: createHash("sha256").update(wrongRecipientToken).digest("hex"), status: "pending", invitedBy: "user-test", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() },
      { _id: "invite-expired", workspaceId: "workspace-a", email: "invited@example.invalid", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], tokenHash: createHash("sha256").update(expiredInvitationToken).digest("hex"), status: "pending", invitedBy: "user-test", expiresAt: new Date(Date.now() - 1), createdAt: new Date() },
    ]);
    const sessionHeaders = { "content-type": "application/json", cookie: sessionCookie };
    const acceptedInvite = await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: invitationToken }) });
    assert.equal(acceptedInvite.status, 200, await acceptedInvite.text());
    assert.equal(await database.db.collection("invitations").countDocuments({ tokenHash: createHash("sha256").update(invitationToken).digest("hex"), status: "accepted", "delivery.status": "unconfirmed" }), 1);
    assert.equal(await database.db.collection("invitations").countDocuments({ _id: manualInviteData.invitation.id, status: "superseded" }), 1);
    assert.equal((await database.db.collection("memberships").findOne({ userId: verifiedUser.id }))?.status, "active");
    assert.match(String((await database.db.collection("users").findOne({ _id: verifiedUser.id }))?.handle), /^invited-user-[a-f0-9]{8}$/);
    assert.equal((await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: invitationToken }) })).status, 404);
    assert.equal((await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: wrongRecipientToken }) })).status, 404);
    assert.equal((await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: expiredInvitationToken }) })).status, 404);
    assert.equal(await database.db.collection("audit_events").countDocuments({ actorId: verifiedUser.id, result: "failure" }), 3);

    browserDevSocket = socketClient(origin, { auth: { devUserId: "user-test" }, extraHeaders: { origin: config.APP_ORIGIN }, transports: ["websocket"], reconnection: false });
    await new Promise<void>((resolve, reject) => { browserDevSocket!.once("connect", resolve); browserDevSocket!.once("connect_error", reject); });
    assert.equal((await new Promise<any>((resolve) => browserDevSocket!.emit("channel:join", "channel-a", resolve))).ok, true);
    browserDevSocket.close();
    cookieSocket = socketClient(origin, { extraHeaders: { cookie: sessionCookie, origin: config.APP_ORIGIN }, transports: ["websocket"], reconnection: false });
    await new Promise<void>((resolve, reject) => { cookieSocket!.once("connect", resolve); cookieSocket!.once("connect_error", reject); });
    assert.equal((await new Promise<any>((resolve) => cookieSocket!.emit("channel:join", "channel-a", resolve))).ok, true);
    cookieSocket.close();

    const socket = socketClient(origin, { extraHeaders: { "x-dev-user-id": "user-test" }, transports: ["websocket"] });
    activeSocket = socket;
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    const hiddenJoin = await new Promise<any>((resolve) => socket.emit("channel:join", "channel-hidden", resolve));
    assert.equal(hiddenJoin.ok, false);
    const presence = new Promise<any>((resolve) => socket.once("presence:update", resolve));
    const allowedJoin = await new Promise<any>((resolve) => socket.emit("channel:join", "channel-a", resolve));
    assert.equal(allowedJoin.ok, true);
    assert.deepEqual(await presence, { userId: "user-test", state: "online" });
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { groupIds: [], updatedAt: new Date() } });
    const revokedSend = await new Promise<any>((resolve) => socket.emit("message:create", { channelId: "channel-a", body: { body: "Denied", mentionUserIds: [], clientId: "revoked-message-0001" } }, resolve));
    assert.equal(revokedSend.ok, false);
    let leakedPresence = false;
    socket.once("presence:update", () => { leakedPresence = true; });
    const peerSocket = socketClient(origin, { extraHeaders: { "x-dev-user-id": "user-peer" }, transports: ["websocket"] });
    activePeerSocket = peerSocket;
    await new Promise<void>((resolve, reject) => { peerSocket.once("connect", resolve); peerSocket.once("connect_error", reject); });
    assert.equal((await new Promise<any>((resolve) => peerSocket.emit("channel:join", "channel-a", resolve))).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(leakedPresence, false);
    peerSocket.close();
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { groupIds: ["group-a"], updatedAt: new Date() } });
    assert.equal((await new Promise<any>((resolve) => socket.emit("channel:join", "channel-a", resolve))).ok, true);
    const attachmentPush = new Promise<any>((resolve) => socket.once("event", resolve));
    const sent = await new Promise<any>((resolve) => socket.emit("message:create", { channelId: "channel-a", body: { body: "Hello @test", mentionUserIds: ["user-test"], attachmentFileIds: [intent.data.file.id], clientId: "smoke-message-0001" } }, resolve));
    assert.equal(sent.ok, true);
    assert.deepEqual(sent.data.attachments, [{ id: intent.data.file.id, name: "proof.txt", contentType: "text/plain", size: 3 }]);
    assert.deepEqual((await attachmentPush).payload.attachments, sent.data.attachments);
    const replayedMessage = await new Promise<any>((resolve) => socket.emit("message:create", { channelId: "channel-a", body: { body: "Hello @test", mentionUserIds: ["user-test"], attachmentFileIds: [intent.data.file.id], clientId: "smoke-message-0001" } }, resolve));
    assert.equal(replayedMessage.ok, true);
    assert.equal(replayedMessage.data.id, sent.data.id);
    const changedSocketRetry = await new Promise<any>((resolve) => socket.emit("message:create", { channelId: "channel-a", body: { body: "Hello @test", mentionUserIds: ["user-test"], clientId: "smoke-message-0001" } }, resolve));
    assert.equal(changedSocketRetry.error.code, "CONFLICT");
    assert.equal(await database.db.collection("messages").countDocuments({ clientId: "smoke-message-0001" }), 1);
    assert.equal(await database.db.collection("events").countDocuments({ _id: sent.data.id, type: "message.created" }), 1);
    const messageId = sent.data.id;
    const restPush = new Promise<any>((resolve) => socket.once("event", resolve));
    const restMessage = await fetch(`${origin}/v1/channels/channel-a/messages`, { method: "POST", headers, body: JSON.stringify({ body: "REST live", clientId: "rest-live-0001" }) });
    assert.equal(restMessage.status, 201);
    const restBody = (await restMessage.json()) as any;
    assert.equal((await restPush).eventId, restBody.data.message.id);
    const reactionPush = new Promise<any>((resolve) => socket.once("event", resolve));
    const reaction = await fetch(`${origin}/v1/messages/${messageId}/reaction`, { method: "PUT", headers, body: JSON.stringify({ emoji: "👍", active: true }) });
    assert.equal(reaction.status, 200);
    assert.equal((await reactionPush).payload.messageId, messageId);
    const reactionBody = (await reaction.json()) as any;
    assert.equal(reactionBody.data.reactions["👍"], 1);
    assert.deepEqual(reactionBody.data.myReactions, ["👍"]);
    assert.equal((await fetch(`${origin}/v1/messages/${messageId}/reaction`, { method: "PUT", headers, body: JSON.stringify({ emoji: "👍", active: true }) })).status, 200);
    assert.equal(await database.db.collection("message_reactions").countDocuments({ messageId }), 1);
    assert.equal(((await (await fetch(`${origin}/v1/messages/${messageId}/reaction`, { method: "PUT", headers, body: JSON.stringify({ emoji: "toString", active: true }) })).json()) as any).data.reactions.toString, 1);
    const saved = await fetch(`${origin}/v1/messages/${messageId}/save`, { method: "PUT", headers, body: JSON.stringify({ saved: true }) });
    assert.equal(((await saved.json()) as any).data.savedByMe, true);
    assert.equal(((await (await fetch(`${origin}/v1/messages/saved`, { headers })).json()) as any).data[0].id, messageId);
    assert.equal((await fetch(`${origin}/v1/groups/group-hidden/messages/saved`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/v1/groups/group-b/messages/saved`, { headers })).status, 404);
    assert.deepEqual(((await (await fetch(`${origin}/v1/groups/group-a/messages/saved`, { headers })).json()) as any).data.items.map((item: any) => item.id), [messageId]);
    assert.equal((await fetch(`${origin}/v1/messages/${restBody.data.message.id}/save`, { method: "PUT", headers, body: JSON.stringify({ saved: true }) })).status, 200);
    const savedPageOne = ((await (await fetch(`${origin}/v1/groups/group-a/messages/saved?limit=1`, { headers })).json()) as any).data;
    assert.equal(savedPageOne.items.length, 1);
    assert.ok(savedPageOne.nextCursor);
    const savedPageTwo = ((await (await fetch(`${origin}/v1/groups/group-a/messages/saved?limit=1&cursor=${savedPageOne.nextCursor}`, { headers })).json()) as any).data;
    assert.deepEqual(new Set([...savedPageOne.items, ...savedPageTwo.items].map((item: any) => item.id)), new Set([messageId, restBody.data.message.id]));
    assert.equal(savedPageTwo.nextCursor, undefined);
    await database.db.collection("api_rate_limits").deleteMany({});
    assert.equal((await fetch(`${origin}/v1/messages/${messageId}/pin`, { method: "PUT", headers: { "content-type": "application/json", "x-dev-user-id": "user-peer" }, body: JSON.stringify({ pinned: true }) })).status, 403);
    const pinPush = new Promise<any>((resolve) => socket.once("event", resolve));
    const pinned = await fetch(`${origin}/v1/messages/${messageId}/pin`, { method: "PUT", headers, body: JSON.stringify({ pinned: true }) });
    assert.equal(((await pinned.json()) as any).data.pinned, true);
    assert.equal((await pinPush).payload.messageId, messageId);
    const originalPinTime = (await database.db.collection("messages").findOne({ _id: messageId }))?.pinnedAt;
    assert.equal((await fetch(`${origin}/v1/messages/${messageId}/pin`, { method: "PUT", headers, body: JSON.stringify({ pinned: true }) })).status, 200);
    assert.deepEqual((await database.db.collection("messages").findOne({ _id: messageId }))?.pinnedAt, originalPinTime);
    assert.equal(((await (await fetch(`${origin}/v1/channels/channel-a/messages?pinned=true`, { headers })).json()) as any).data.items[0].id, messageId);
    assert.equal((await fetch(`${origin}/v1/channels/channel-a/messages`, { method: "POST", headers, body: JSON.stringify({ body: "Bad thread", clientId: "bad-thread-0001", threadRootId: "missing-root" }) })).status, 400);
    assert.equal((await fetch(`${origin}/v1/messages/${messageId}/save`, { method: "PUT", headers: { "content-type": "application/json", "x-dev-user-id": "user-hidden" }, body: JSON.stringify({ saved: true }) })).status, 404);
    const dmRequest = { recipientId: "user-peer", body: "Private hello", clientId: "private-hello-0001" };
    const dmPush = new Promise<any>((resolve) => socket.once("event", resolve));
    const dmResponse = await fetch(`${origin}/v1/direct-messages`, { method: "POST", headers, body: JSON.stringify(dmRequest) });
    assert.equal(dmResponse.status, 201, await dmResponse.clone().text());
    const dmId = ((await dmResponse.json()) as any).data.id;
    assert.equal((await dmPush).payload.id, dmId);
    assert.equal((await fetch(`${origin}/v1/direct-messages`, { method: "POST", headers, body: JSON.stringify(dmRequest) })).status, 200);
    assert.equal((await fetch(`${origin}/v1/messages/${dmId}/save`, { method: "PUT", headers, body: JSON.stringify({ saved: true }) })).status, 200);
    const groupSavedFirst = ((await (await fetch(`${origin}/v1/groups/group-a/messages/saved?limit=1`, { headers })).json()) as any).data;
    const groupSavedSecond = ((await (await fetch(`${origin}/v1/groups/group-a/messages/saved?limit=1&cursor=${groupSavedFirst.nextCursor}`, { headers })).json()) as any).data;
    assert.deepEqual(new Set([...groupSavedFirst.items, ...groupSavedSecond.items].map((item: any) => item.id)), new Set([messageId, restBody.data.message.id]));
    assert.equal(groupSavedSecond.nextCursor, undefined);
    await database.db.collection("api_rate_limits").deleteMany({});
    assert.equal((await fetch(`${origin}/v1/messages/${dmId}/pin`, { method: "PUT", headers, body: JSON.stringify({ pinned: true }) })).status, 403);
    assert.equal((await fetch(`${origin}/v1/messages/${dmId}/reaction`, { method: "PUT", headers: { "content-type": "application/json", "x-dev-user-id": "user-hidden" }, body: JSON.stringify({ emoji: "👍", active: true }) })).status, 404);
    const learnerBody = { role: "learner", ventureIds: ["venture-a"], groupIds: ["group-a"] };
    assert.equal((await fetch(`${origin}/v1/admin/memberships/membership-peer`, { method: "PUT", headers: adminHeaders, body: JSON.stringify(learnerBody) })).status, 200);
    const peerHeaders = { "content-type": "application/json", "x-dev-user-id": "user-peer" };
    assert.equal((await fetch(`${origin}/v1/channels/channel-a/messages`, { method: "POST", headers: peerHeaders, body: JSON.stringify({ body: "Read only", clientId: "learner-denied-0001" }) })).status, 403);
    assert.equal((await fetch(`${origin}/v1/messages/${messageId}/reaction`, { method: "PUT", headers: peerHeaders, body: JSON.stringify({ emoji: "👍", active: true }) })).status, 403);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { ventureIds: [], updatedAt: new Date() } });
    assert.equal((await fetch(`${origin}/v1/events?after=event-cursor-a`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/v1/channels/channel-a/messages`, { headers })).status, 404);
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { ventureIds: ["venture-a"], updatedAt: new Date() } });
    const orderedAt = new Date();
    await database.db.collection("messages").insertMany([
      { _id: "message-order-a", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-test", body: "Order A", mentionUserIds: [], clientId: "message-order-client-a", createdAt: orderedAt },
      { _id: "message-order-b", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-test", body: "Order B", mentionUserIds: [], clientId: "message-order-client-b", createdAt: orderedAt },
      { _id: "message-order-c", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-test", body: "Order C", mentionUserIds: [], clientId: "message-order-client-c", createdAt: orderedAt },
    ]);
    const firstPage = (await (await fetch(`${origin}/v1/channels/channel-a/messages?limit=2`, { headers })).json()) as any;
    const secondPage = (await (await fetch(`${origin}/v1/channels/channel-a/messages?limit=2&cursor=${firstPage.data.nextCursor}`, { headers })).json()) as any;
    const thirdPage = (await (await fetch(`${origin}/v1/channels/channel-a/messages?limit=2&cursor=${secondPage.data.nextCursor}`, { headers })).json()) as any;
    const orderedIds = [...firstPage.data.items, ...secondPage.data.items, ...thirdPage.data.items].map((item: any) => item.id);
    assert.equal(orderedIds.indexOf("message-order-a") < orderedIds.indexOf("message-order-b"), true);
    assert.equal(orderedIds.indexOf("message-order-b") < orderedIds.indexOf("message-order-c"), true);
    socket.emit("channel:join", "channel-a");
    socket.emit("message:create", { channelId: "channel-a", body: { body: "No ack", clientId: "no-ack-0001" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    socket.close();
    restrictedServer = createServer(app).listen(0);
    restrictedIo = attachRealtime(restrictedServer, database, resolveActor, config.APP_ORIGIN, false);
    await once(restrictedServer, "listening");
    const restrictedAddress = restrictedServer.address();
    const restrictedOrigin = `http://127.0.0.1:${typeof restrictedAddress === "object" && restrictedAddress ? restrictedAddress.port : 0}`;
    restrictedSocket = socketClient(restrictedOrigin, { auth: { devUserId: "user-test" }, extraHeaders: { origin: config.APP_ORIGIN }, transports: ["websocket"], reconnection: false });
    await new Promise<void>((resolve, reject) => { restrictedSocket!.once("connect_error", () => resolve()); restrictedSocket!.once("connect", () => reject(new Error("Production-style socket accepted local dev auth"))); });
    restrictedSocket.close();
    cookieSocket = socketClient(restrictedOrigin, { extraHeaders: { cookie: sessionCookie, origin: config.APP_ORIGIN }, transports: ["websocket"], reconnection: false });
    await new Promise<void>((resolve, reject) => { cookieSocket!.once("connect", resolve); cookieSocket!.once("connect_error", reject); });
    assert.equal((await new Promise<any>((resolve) => cookieSocket!.emit("channel:join", "channel-a", resolve))).ok, true);
    cookieSocket.close();
    const scopedGroupResponse = await fetch(`${origin}/v1/admin/groups`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ ventureId: "venture-a", name: "Scoped QA" }) });
    assert.equal(scopedGroupResponse.status, 201, await scopedGroupResponse.clone().text());
    const scopedGroup = ((await scopedGroupResponse.json()) as any).data;
    assert.equal(scopedGroup.ventureId, "venture-a");
    assert.equal(scopedGroup.channels[0].groupId, scopedGroup.id);
    const scopedChannelResponse = await fetch(`${origin}/v1/admin/channels`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ groupId: scopedGroup.id, name: "Handoff" }) });
    assert.equal(scopedChannelResponse.status, 201, await scopedChannelResponse.clone().text());
    const scopedChannel = ((await scopedChannelResponse.json()) as any).data;
    assert.equal(scopedChannel.groupId, scopedGroup.id);
    assert.equal(scopedChannel.ventureId, "venture-a");
    assert.equal(await database.db.collection("channels").countDocuments({ _id: scopedChannel.id, groupId: scopedGroup.id, ventureId: "venture-a" }), 1);
    await database.db.collection("api_rate_limits").deleteMany({});
    const channelFileId = intent.data.file.id as string;
    const channelFileSend = await fetch(origin + "/v1/channels/channel-a/messages", { method: "POST", headers, body: JSON.stringify({ body: "", attachmentFileIds: [channelFileId], clientId: "attachment-channel-0001" }) });
    assert.equal(channelFileSend.status, 201, await channelFileSend.clone().text());
    const channelFileMessage = messageSchema.parse(((await channelFileSend.json()) as any).data.message);
    assert.equal(channelFileMessage.body, "");
    assert.deepEqual(channelFileMessage.attachments, [{ id: channelFileId, name: "proof.txt", contentType: "text/plain", size: 3 }]);
    assert.equal((await fetch(origin + "/v1/channels/channel-a/messages", { method: "POST", headers, body: JSON.stringify({ body: "", attachmentFileIds: [channelFileId], clientId: "attachment-channel-0001" }) })).status, 200);
    assert.equal((await fetch(origin + "/v1/channels/channel-a/messages", { method: "POST", headers, body: JSON.stringify({ body: "Changed", attachmentFileIds: [channelFileId], clientId: "attachment-channel-0001" }) })).status, 409);
    assert.equal(Object.hasOwn(channelFileMessage.attachments[0]!, "objectKey"), false);
    const channelFileReload = ((await (await fetch(origin + "/v1/channels/channel-a/messages", { headers })).json()) as any).data.items.find((item: any) => item.id === channelFileMessage.id);
    assert.deepEqual(channelFileReload.attachments, channelFileMessage.attachments);
    const channelFileEvent = await database.db.collection("events").findOne({ _id: channelFileMessage.id, type: "message.created" });
    assert.deepEqual(channelFileEvent?.payload.attachments, channelFileMessage.attachments);
    assert.equal(Object.hasOwn(channelFileEvent?.payload ?? {}, "objectKey"), false);
    assert.equal(Object.hasOwn(channelFileEvent?.payload ?? {}, "attachmentFileIds"), false);
    const deniedFileIds = ["file-other-group", "file-other-owner", "file-not-ready", "file-other-venture"];
    await database.db.collection("files").insertMany([
      { _id: deniedFileIds[0]!, workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-hidden", ownerId: "user-test", name: "hidden.txt", contentType: "text/plain", size: 1, objectKey: "hidden", status: "ready", createdAt: now },
      { _id: deniedFileIds[1]!, workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-peer", name: "peer.txt", contentType: "text/plain", size: 1, objectKey: "peer", status: "ready", createdAt: now },
      { _id: deniedFileIds[2]!, workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", ownerId: "user-test", name: "pending.txt", contentType: "text/plain", size: 1, objectKey: "pending", status: "pending", createdAt: now },
      { _id: deniedFileIds[3]!, workspaceId: "workspace-a", ventureId: "venture-b", groupId: "group-b", ownerId: "user-test", name: "venture-b.txt", contentType: "text/plain", size: 1, objectKey: "venture-b", status: "ready", createdAt: now },
    ]);
    for (const [index, fileId] of [...deniedFileIds, "file-same-group-other-workspace"].entries()) {
      const denied = await fetch(origin + "/v1/channels/channel-a/messages", { method: "POST", headers, body: JSON.stringify({ body: "Attempt", attachmentFileIds: [fileId], clientId: "attachment-denied-" + index }) });
      assert.equal(denied.status, 400, fileId);
    }
    assert.equal((await fetch(origin + "/v1/channels/channel-a/messages", { method: "POST", headers, body: JSON.stringify({ body: "Duplicate", attachmentFileIds: [channelFileId, channelFileId], clientId: "attachment-duplicate-0001" }) })).status, 400);
    await database.db.collection("files").deleteMany({ _id: { $in: deniedFileIds } });

    const dmIntentBody = { recipientId: "user-peer", name: "private.txt", contentType: "text/plain", size: 4 };
    assert.equal((await fetch(origin + "/v1/uploads", { method: "POST", headers, body: JSON.stringify({ ...dmIntentBody, ventureId: "venture-a" }) })).status, 400);
    assert.equal((await fetch(origin + "/v1/uploads", { method: "POST", headers, body: JSON.stringify({ ...dmIntentBody, groupId: "group-a" }) })).status, 400);
    assert.equal((await fetch(origin + "/v1/uploads", { method: "POST", headers, body: JSON.stringify({ ...dmIntentBody, recipientId: "user-test" }) })).status, 400);
    const dmIntentResponse = await fetch(origin + "/v1/uploads", { method: "POST", headers, body: JSON.stringify(dmIntentBody) });
    assert.equal(dmIntentResponse.status, 201, await dmIntentResponse.clone().text());
    const dmIntent = ((await dmIntentResponse.json()) as any).data;
    const dmFileId = dmIntent.file.id as string;
    assert.equal(dmIntent.file.recipientId, "user-peer");
    assert.equal(Object.hasOwn(dmIntent.file, "ventureId"), false);
    assert.equal((await fetch(dmIntent.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "only" })).status, 204);
    assert.equal((await fetch(origin + "/v1/uploads/" + dmFileId + "/complete", { method: "POST", headers, body: JSON.stringify({ etag: "local" }) })).status, 200);
    assert.equal((await fetch(origin + "/v1/files/" + dmFileId + "/download", { headers: adminHeaders })).status, 404);
    assert.equal((await fetch(origin + "/v1/files/" + dmFileId + "/download", { headers: { "x-dev-user-id": "user-hidden" } })).status, 404);
    const peerDownload = await fetch(origin + "/v1/files/" + dmFileId + "/download", { headers: { "x-dev-user-id": "user-peer" } });
    assert.equal(peerDownload.status, 200);
    assert.equal(await (await fetch(((await peerDownload.json()) as any).data.downloadUrl)).text(), "only");
    const dmFileSend = await fetch(origin + "/v1/direct-messages", { method: "POST", headers, body: JSON.stringify({ recipientId: "user-peer", body: "", attachmentFileIds: [dmFileId], clientId: "attachment-dm-0001" }) });
    assert.equal(dmFileSend.status, 201, await dmFileSend.clone().text());
    const dmFileMessage = messageSchema.parse(((await dmFileSend.json()) as any).data);
    assert.deepEqual(dmFileMessage.attachments, [{ id: dmFileId, name: "private.txt", contentType: "text/plain", size: 4 }]);
    assert.equal((await fetch(origin + "/v1/direct-messages", { method: "POST", headers, body: JSON.stringify({ recipientId: "user-peer", body: "", attachmentFileIds: [dmFileId], clientId: "attachment-dm-0001" }) })).status, 200);
    assert.equal((await fetch(origin + "/v1/direct-messages", { method: "POST", headers, body: JSON.stringify({ recipientId: "user-peer", body: "", attachmentFileIds: [channelFileId], clientId: "attachment-dm-0001" }) })).status, 409);
    const dmReload = ((await (await fetch(origin + "/v1/direct-messages/user-peer", { headers })).json()) as any).data.find((item: any) => item.id === dmFileMessage.id);
    assert.deepEqual(dmReload.attachments, dmFileMessage.attachments);
    const peerDmReload = ((await (await fetch(origin + "/v1/direct-messages/user-test", { headers: { "x-dev-user-id": "user-peer" } })).json()) as any).data.find((item: any) => item.id === dmFileMessage.id);
    assert.deepEqual(peerDmReload.attachments, dmFileMessage.attachments);
    const dmFileEvent = await database.db.collection("events").findOne({ type: "direct_message.created", "payload._id": dmFileMessage.id });
    assert.deepEqual(dmFileEvent?.payload.attachments, dmFileMessage.attachments);
    assert.equal(Object.hasOwn(dmFileEvent?.payload ?? {}, "objectKey"), false);
    assert.equal((await database.db.collection("notification_outbox").findOne({ resourceId: dmFileMessage.id, type: "message" }))?.body, "Shared a file");
    assert.equal((await fetch(origin + "/v1/direct-messages", { method: "POST", headers, body: JSON.stringify({ recipientId: "user-hidden", body: "Wrong recipient", attachmentFileIds: [dmFileId], clientId: "attachment-dm-denied-0001" }) })).status, 400);
    assert.equal((await fetch(origin + "/v1/direct-messages", { method: "POST", headers: adminHeaders, body: JSON.stringify({ recipientId: "user-peer", body: "Wrong owner", attachmentFileIds: [dmFileId], clientId: "attachment-dm-denied-0002" }) })).status, 400);
    assert.equal((await fetch(origin + "/v1/direct-messages", { method: "POST", headers, body: JSON.stringify({ recipientId: "user-peer", body: "Wrong scope", attachmentFileIds: [channelFileId], clientId: "attachment-dm-denied-0003" }) })).status, 400);
    assert.equal((await fetch(origin + "/v1/channels/channel-a/messages", { method: "POST", headers, body: JSON.stringify({ body: "Wrong scope", attachmentFileIds: [dmFileId], clientId: "attachment-channel-denied-0002" }) })).status, 400);
  } finally {
    activeSocket?.close();
    activePeerSocket?.close();
    browserDevSocket?.close();
    cookieSocket?.close();
    restrictedSocket?.close();
    if (restrictedIo) await restrictedIo.close();
    if (restrictedServer) { restrictedServer.close(); await once(restrictedServer, "close"); }
    await ioServer.close();
    server.close();
    await once(server, "close");
    await database.native.dropDatabase();
    await database.client.close();
  }
});

test("real Mongo regressions: canonical dates, safe evidence, latest pages, and client error mapping", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  const dbName = `venture_studio_test_${process.pid}_${Date.now()}_regressions`;
  assert.match(dbName, /^venture_studio_test_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000",
    APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  const db = database.db;
  assert.equal(database.transactions, true);
  await ensureIndexes(db);
  const now = new Date();
  await db.collection("workspaces").insertOne({ _id: "workspace-a", name: "Regression", slug: "regression", createdAt: now });
  await db.collection("users").insertMany([
    { _id: "user-lead", workspaceId: "workspace-a", email: "lead@example.invalid", name: "Lead", handle: "lead", status: "active", createdAt: now, updatedAt: now },
    { _id: "user-admin", workspaceId: "workspace-a", email: "admin@example.invalid", name: "Admin", handle: "admin", status: "active", createdAt: now, updatedAt: now },
  ]);
  await db.collection("memberships").insertMany([
    { _id: "membership-lead", workspaceId: "workspace-a", userId: "user-lead", role: "venture_head", ventureIds: ["venture-a"], groupIds: ["group-a"], status: "active", createdAt: now, updatedAt: now },
    { _id: "membership-admin", workspaceId: "workspace-a", userId: "user-admin", role: "admin", ventureIds: [], groupIds: [], status: "active", createdAt: now, updatedAt: now },
  ]);
  await db.collection("ventures").insertOne({ _id: "venture-a", workspaceId: "workspace-a", name: "Allowed", status: "active", goal30Day: "", createdAt: now });
  await db.collection("groups").insertOne({ _id: "group-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Core", createdAt: now });
  await db.collection("channels").insertOne({ _id: "channel-a", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", name: "general", createdAt: now });
  const { app } = createApp(database, config, createAuth(database.native, config), new LocalObjectStore(config));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const headers = { "content-type": "application/json", "x-dev-user-id": "user-lead" };
  const adminHeaders = { "content-type": "application/json", "x-dev-user-id": "user-admin" };
  const post = (path: string, body: unknown, requestHeaders: Record<string, string> = headers) => fetch(`${origin}${path}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString().replace("Z", "+00:00");
  try {
    // Create routes store BSON dates, matching updates and seeds, so the context packet and date-range reads work.
    const task = await post("/v1/tasks", { ventureId: "venture-a", groupId: "group-a", title: "Dated task", outcome: "Stored as a date", assigneeId: "user-lead", dueAt: later(4), reviewAt: later(5), timezone: "UTC", estimatedMinutes: 30, definitionOfDone: "Done", evidenceRequirement: "Proof" });
    assert.equal(task.status, 201, await task.clone().text());
    const taskId = ((await task.json()) as any).data.id;
    const storedTask = await db.collection("tasks").findOne({ _id: taskId });
    assert.ok(storedTask?.dueAt instanceof Date && storedTask.reviewAt instanceof Date);
    const packet = await fetch(`${origin}/v1/context-packets/tasks/${taskId}`, { headers });
    assert.equal(packet.status, 200, await packet.clone().text());
    assert.match(((await packet.json()) as any).data.markdown, /Due: \d{4}-\d{2}-\d{2}T/);
    const outcome = await post("/v1/outcomes", { ventureId: "venture-a", title: "Dated outcome", description: "Dates", ownerId: "user-lead", priority: "high", startAt: later(1), reviewAt: later(48), successEvidence: "Evidence", status: "active" });
    assert.equal(outcome.status, 201, await outcome.clone().text());
    const storedOutcome = await db.collection("outcomes").findOne({ _id: ((await outcome.json()) as any).data.id });
    assert.ok(storedOutcome?.startAt instanceof Date && storedOutcome.reviewAt instanceof Date);
    const decision = await post("/v1/decisions", { ventureId: "venture-a", title: "Dated decision", text: "Decide", ownerId: "user-lead", decidedAt: later(0), evidence: [], reason: "Because", affectedWork: [], reviewTrigger: "", status: "approved" });
    assert.equal(decision.status, 201, await decision.clone().text());
    assert.ok((await db.collection("decisions").findOne({ _id: ((await decision.json()) as any).data.id }))?.decidedAt instanceof Date);
    const lesson = await post("/v1/classes", { ventureId: "venture-a", title: "Dated class", objective: "Learn", scheduledAt: later(24), durationMinutes: 30, facilitatorId: "user-lead", participantIds: ["user-lead"], status: "scheduled" });
    assert.equal(lesson.status, 201, await lesson.clone().text());
    assert.ok((await db.collection("classes").findOne({ _id: ((await lesson.json()) as any).data.id }))?.scheduledAt instanceof Date);
    const dashboard = (await (await fetch(`${origin}/v1/dashboard`, { headers })).json()) as any;
    assert.equal(dashboardResponseSchema.safeParse(dashboard).success, true);
    assert.equal(JSON.stringify(dashboard.data).includes("Dated class"), true);
    const information = await post("/v1/information-requests", { ventureId: "venture-a", respondentId: "user-admin", question: "When?", purpose: "Plan", dueAt: later(24) });
    assert.equal(information.status, 201, await information.clone().text());
    assert.ok((await db.collection("information_requests").findOne({ _id: ((await information.json()) as any).data.id }))?.dueAt instanceof Date);

    // Evidence rejects unsafe URI schemes and omits an absent URI instead of persisting null.
    assert.equal((await post(`/v1/tasks/${taskId}/evidence`, { title: "Bad link", description: "Unsafe", uri: "javascript:alert(1)" })).status, 400);
    assert.equal((await post(`/v1/tasks/${taskId}/evidence`, { description: "Missing title" })).status, 400);
    const note = await post(`/v1/tasks/${taskId}/evidence`, { type: "note", title: "Note", description: "Observed in review" });
    assert.equal(note.status, 201, await note.clone().text());
    assert.equal(Object.hasOwn((await db.collection("evidence_items").findOne({ _id: ((await note.json()) as any).data.id }))!, "uri"), false);
    const link = await post(`/v1/tasks/${taskId}/evidence`, { title: "Link", description: "Source", uri: "https://example.com/proof" });
    assert.equal(link.status, 201, await link.clone().text());
    assert.equal(((await link.json()) as any).data.uri, "https://example.com/proof");
    await db.collection("evidence_items").insertOne({ _id: "evidence-legacy-null", workspaceId: "workspace-a", taskId, type: "note", title: "Legacy", uri: null, description: "Stored before the fix", submittedBy: "user-lead", submittedAt: new Date(), reviewStatus: "pending" });
    const detail = (await (await fetch(`${origin}/v1/tasks/${taskId}`, { headers })).json()) as any;
    assert.equal(detail.data.evidence.length, 3);
    assert.equal(evidenceItemSchema.array().safeParse(detail.data.evidence).success, true);
    const reviewed = await post("/v1/evidence/evidence-legacy-null/review", { status: "accepted" });
    assert.equal(reviewed.status, 200, await reviewed.clone().text());
    assert.equal(evidenceItemSchema.safeParse(((await reviewed.json()) as any).data).success, true);

    // Channel history keeps forward paging by default; order=latest starts at the newest page and walks backward.
    const base = Date.now() - 60_000;
    await db.collection("messages").insertMany(Array.from({ length: 5 }, (_, index) => ({ _id: `message-${index}`, workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-lead", body: `Message ${index}`, mentionUserIds: [], clientId: `client-${index}`, createdAt: new Date(base + index * 1000) })));
    const page = async (query: string) => ((await (await fetch(`${origin}/v1/channels/channel-a/messages?${query}`, { headers })).json()) as any).data;
    const ids = (value: any) => value.items.map((item: any) => item.id);
    assert.deepEqual(ids(await page("limit=2")), ["message-0", "message-1"]);
    const newest = await page("limit=2&order=latest");
    assert.deepEqual(ids(newest), ["message-3", "message-4"]);
    const older = await page(`limit=2&order=latest&cursor=${newest.nextCursor}`);
    assert.deepEqual(ids(older), ["message-1", "message-2"]);
    const oldest = await page(`limit=2&order=latest&cursor=${older.nextCursor}`);
    assert.deepEqual(ids(oldest), ["message-0"]);
    assert.equal(oldest.nextCursor, undefined);
    assert.equal(messageSchema.array().safeParse(newest.items).success, true);

    // Replay without a cursor returns the newest window, so a client cursor never starts deep in history.
    const eventBase = { workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", version: 1, actorId: "user-lead", type: "message.created", payload: {} };
    await db.collection("events").insertMany(Array.from({ length: 502 }, (_, index) => { const id = `event-${String(index).padStart(3, "0")}`; return { _id: id, eventId: id, occurredAt: new Date(base + index), ...eventBase }; }));
    const recent = ((await (await fetch(`${origin}/v1/events`, { headers })).json()) as any).data;
    assert.equal(recent.length, 500);
    assert.equal(recent[0].eventId, "event-002");
    assert.equal(recent.at(-1).eventId, "event-501");
    assert.equal(eventEnvelopeSchema.array().safeParse(recent).success, true);
    const afterCursor = ((await (await fetch(`${origin}/v1/events?after=event-499`, { headers })).json()) as any).data;
    assert.deepEqual(afterCursor.map((item: any) => item.eventId), ["event-500", "event-501"]);

    // Client-caused failures raised outside route code use the safe envelope rather than a 500.
    const malformed = await fetch(`${origin}/v1/tasks`, { method: "POST", headers, body: "{\"title\":" });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as any).error.code, "BAD_REQUEST");
    const oversized = await fetch(`${origin}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ title: "x".repeat(2 * 1024 * 1024 + 1) }) });
    assert.equal(oversized.status, 413);
    assert.equal(((await oversized.json()) as any).error.code, "BAD_REQUEST");
    const duplicateVenture = await post("/v1/admin/ventures", { name: "Allowed", ownerId: "user-admin", goal30Day: "Duplicate" }, adminHeaders);
    assert.equal(duplicateVenture.status, 409, await duplicateVenture.clone().text());
    assert.equal(((await duplicateVenture.json()) as any).error.code, "CONFLICT");

    // An opportunity without a next-action date is stored without the field, and legacy nulls never break the list contract.
    const pipeline = await post("/v1/pipelines", { ventureId: "venture-a", name: "Regression pipeline", offerName: "Offer" });
    assert.equal(pipeline.status, 201, await pipeline.clone().text());
    const pipelineId = ((await pipeline.json()) as any).data.id;
    const undated = await post("/v1/opportunities", { pipelineId, companyName: "Undated", contactName: "", source: "Referral", observedSignal: "Signal", fitReason: "Fit", evidenceConfidence: "low", stage: "identified", ownerId: "user-lead", nextAction: "Call" });
    assert.equal(undated.status, 201, await undated.clone().text());
    const undatedId = ((await undated.json()) as any).data.id;
    assert.equal(Object.hasOwn((await db.collection("opportunities").findOne({ _id: undatedId }))!, "nextActionAt"), false);
    await db.collection("opportunities").insertOne({ _id: "opportunity-legacy-null", workspaceId: "workspace-a", ventureId: "venture-a", pipelineId, companyName: "Legacy", contactName: "", source: "Old", observedSignal: "Signal", fitReason: "Fit", evidenceConfidence: "low", stage: "identified", ownerId: "user-lead", nextAction: "", nextActionAt: null, createdAt: now, updatedAt: now });
    const opportunities = (await (await fetch(`${origin}/v1/opportunities`, { headers })).json()) as any;
    assert.equal(opportunities.data.length, 2);
    assert.equal(opportunitySchema.array().safeParse(opportunities.data).success, true);
    const legacyUpdate = await fetch(`${origin}/v1/opportunities/opportunity-legacy-null`, { method: "PATCH", headers, body: JSON.stringify({ stage: "qualified" }) });
    assert.equal(legacyUpdate.status, 200, await legacyUpdate.clone().text());
    assert.equal(opportunitySchema.safeParse(((await legacyUpdate.json()) as any).data).success, true);

    // MCP venture status stays inside the caller's workspace even when another workspace reuses a venture ID.
    await db.collection("outcomes").insertOne({ _id: "outcome-foreign", workspaceId: "workspace-other", ventureId: "venture-a", title: "Foreign outcome", status: "active" });
    await db.collection("decisions").insertOne({ _id: "decision-foreign", workspaceId: "workspace-other", ventureId: "venture-a", title: "Foreign decision", status: "approved", decidedAt: new Date() });
    const pat = await post("/v1/pats", { name: "regression", scopes: ["ventures:read"] });
    assert.equal(pat.status, 201, await pat.clone().text());
    const mcp = new McpReadService(db, await authenticatePat(db, ((await pat.json()) as any).data.token));
    const ventureStatus = JSON.stringify((await mcp.ventureStatus("venture-a")).data);
    assert.equal(ventureStatus.includes("Dated outcome"), true);
    assert.equal(ventureStatus.includes("Foreign"), false);

    // Migration 003 converts legacy string dates in place and leaves unparseable values for manual review.
    await db.collection("tasks").insertOne({ _id: "task-legacy-string", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", title: "Legacy", dueAt: "2026-09-28T12:00:00+05:30", reviewAt: "not a date", status: "accepted" });
    await db.collection("classes").insertOne({ _id: "class-legacy-string", workspaceId: "workspace-a", ventureId: "venture-a", title: "Legacy class", scheduledAt: "2026-10-01T10:00:00.000Z" });
    assert.equal(await backfillStringDates(db), 2);
    const legacyTask = await db.collection("tasks").findOne({ _id: "task-legacy-string" });
    assert.ok(legacyTask?.dueAt instanceof Date);
    assert.equal((legacyTask!.dueAt as Date).toISOString(), "2026-09-28T06:30:00.000Z");
    assert.equal(legacyTask?.reviewAt, "not a date");
    assert.ok((await db.collection("classes").findOne({ _id: "class-legacy-string" }))?.scheduledAt instanceof Date);
    assert.equal(await backfillStringDates(db), 0);
  } finally {
    server.close();
    await once(server, "close");
    await database.native.dropDatabase();
    await database.client.close();
  }
});
