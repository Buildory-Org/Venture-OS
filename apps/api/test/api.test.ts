import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { io as socketClient } from "socket.io-client";
import { loadConfig } from "../src/config.js";
import { connectDatabase } from "../src/db.js";
import { ensureIndexes } from "../src/indexes.js";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { LocalObjectStore } from "../src/storage.js";
import { attachRealtime } from "../src/collaboration.js";
import { authenticatePat, McpReadService } from "../src/mcp-service.js";
import { dashboardResponseSchema, eventEnvelopeSchema } from "@venture-studio/contracts";

test("production configuration fails closed without delivery and storage credentials", () => {
  assert.throws(() => loadConfig({ APP_MODE: "production", BETTER_AUTH_SECRET: "a".repeat(32) }), /RESEND_API_KEY/);
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
  await database.db.collection("users").insertMany([
    { _id: "user-test", workspaceId: "workspace-a", email: "test@example.invalid", name: "Test User", handle: "test", status: "active", createdAt: now, updatedAt: now },
    { _id: "user-hidden", workspaceId: "workspace-a", email: "hidden@example.invalid", name: "Hidden User", handle: "hidden", status: "active", createdAt: now, updatedAt: now },
  ]);
  await database.db.collection("memberships").insertMany([
    { _id: "membership-test", workspaceId: "workspace-a", userId: "user-test", role: "venture_head", ventureIds: ["venture-a"], groupIds: ["group-a"], status: "active", createdAt: now, updatedAt: now },
    { _id: "membership-hidden", workspaceId: "workspace-a", userId: "user-hidden", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-hidden"], status: "active", createdAt: now, updatedAt: now },
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
  const ioServer = attachRealtime(server, database, resolveActor, config.APP_ORIGIN);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  config.API_ORIGIN = origin;
  try {
    const unauthenticated = await fetch(`${origin}/v1/session/bootstrap`);
    assert.equal(unauthenticated.status, 401);
    const headers = { "content-type": "application/json", "x-dev-user-id": "user-test" };
    const bootstrap = await fetch(`${origin}/v1/session/bootstrap`, { headers });
    assert.equal(bootstrap.status, 200);
    const bootstrapBody = await bootstrap.json() as any;
    assert.deepEqual(bootstrapBody.data.hierarchy.ventures[0].groups.map((group: any) => group.id), ["group-a"]);
    const hidden = await fetch(`${origin}/v1/tasks/task-hidden`, { headers });
    assert.equal(hidden.status, 404);
    assert.equal((await fetch(`${origin}/v1/tasks/task-group-hidden`, { headers })).status, 404);
    const hiddenSearch = await fetch(`${origin}/v1/search?q=GroupSecretNeedle&types=task`, { headers });
    assert.equal(((await hiddenSearch.json()) as any).data.items.length, 0);
    const created = await fetch(`${origin}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", title: "Ship the slice", outcome: "A verified slice", assigneeId: "user-test", priority: "high", dueAt: new Date(Date.now() + 3_600_000).toISOString(), timezone: "UTC", estimatedMinutes: 30, definitionOfDone: "Smoke passes", evidenceRequirement: "Attach smoke output", dependencies: [], evidenceLinks: [], tags: ["smoke"] }) });
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await created.json() as any;
    assert.equal(await database.db.collection("reminders").countDocuments(), 1);
    assert.equal(await database.db.collection("notification_outbox").countDocuments(), 1);
    assert.equal(await database.db.collection("audit_events").countDocuments({ action: "task.create" }), 1);
    const dashboardResponse = await fetch(`${origin}/v1/dashboard`, { headers });
    dashboardResponseSchema.parse(await dashboardResponse.json());
    const invalidReassignment = await fetch(`${origin}/v1/tasks/${createdBody.data.id}`, { method: "PATCH", headers, body: JSON.stringify({ assigneeId: "user-hidden" }) });
    assert.equal(invalidReassignment.status, 400);
    const taskReminder = await database.db.collection("reminders").findOne({ taskId: createdBody.data.id });
    for (const minutes of [10, 20, 30]) {
      const snoozed = await fetch(`${origin}/v1/reminders/${taskReminder?._id}/snooze`, { method: "POST", headers, body: JSON.stringify({ minutes }) });
      assert.equal(snoozed.status, 200, await snoozed.text());
    }
    const silenced = await fetch(`${origin}/v1/reminders/${taskReminder?._id}/snooze`, { method: "POST", headers, body: JSON.stringify({ minutes: "never" }) });
    assert.equal(silenced.status, 200, await silenced.text());
    const terminalSnooze = await fetch(`${origin}/v1/reminders/${taskReminder?._id}/snooze`, { method: "POST", headers, body: JSON.stringify({ minutes: 10 }) });
    assert.equal(terminalSnooze.status, 409);

    const previewResponse = await fetch(`${origin}/v1/commands/preview`, { method: "POST", headers, body: JSON.stringify({ channelId: "channel-a", input: `/notify @test "Check evidence" at=${new Date(Date.now() + 60_000).toISOString()} timezone=UTC` }) });
    assert.equal(previewResponse.status, 201);
    const previewBody = await previewResponse.json() as any;
    const executeBody = { previewId: previewBody.data.previewId, idempotencyKey: "smoke-notify-0001" };
    const executed = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify(executeBody) });
    assert.equal(executed.status, 201, await executed.text());
    const replayed = await fetch(`${origin}/v1/commands/execute`, { method: "POST", headers, body: JSON.stringify(executeBody) });
    assert.equal(replayed.status, 200);
    assert.equal(await database.db.collection("command_executions").countDocuments({ idempotencyKey: "smoke-notify-0001" }), 1);
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
    assert.equal((await fetch(intent.data.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "yes" })).status, 204);
    const complete = await fetch(`${origin}/v1/uploads/${intent.data.file.id}/complete`, { method: "POST", headers, body: JSON.stringify({ etag: "local" }) });
    assert.equal(complete.status, 200, await complete.text());
    assert.equal((await fetch(intent.data.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "bad" })).status, 403);
    const download = await fetch(`${origin}/v1/files/${intent.data.file.id}/download`, { headers });
    const downloadBody = (await download.json()) as any;
    assert.equal(await (await fetch(downloadBody.data.downloadUrl)).text(), "yes");
    const taskWithAttachment = await (await fetch(`${origin}/v1/tasks/${createdBody.data.id}`, { headers })).json() as any;
    assert.equal(taskWithAttachment.data.attachments.some((file: any) => file.id === intent.data.file.id), true);

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
    assert.equal((await database.db.collection("pats").findOne({ _id: patBody.data.pat.id }))?.lastUsedAt instanceof Date, true);
    await fetch(`${origin}/v1/pats/${patBody.data.pat.id}/revoke`, { method: "POST", headers });
    await assert.rejects(() => authenticatePat(database.db, patBody.data.token));
    await assert.rejects(() => mcpService.listVentures());
    assert.equal(await database.db.collection("audit_events").countDocuments({ action: "mcp.list_ventures", result: "denied" }), 1);

    const sameTime = new Date();
    await database.db.collection("events").insertMany([
      { _id: "event-cursor-a", eventId: "event-cursor-a", version: 1, occurredAt: sameTime, actorId: "user-test", workspaceId: "workspace-a", groupId: "group-a", type: "test.first", payload: {} },
      { _id: "event-cursor-b", eventId: "event-cursor-b", version: 1, occurredAt: sameTime, actorId: "user-test", workspaceId: "workspace-a", groupId: "group-a", type: "test.second", payload: {} },
      { _id: "event-private", eventId: "event-private", version: 1, occurredAt: sameTime, actorId: "user-hidden", workspaceId: "workspace-a", audienceUserIds: ["user-hidden"], type: "direct_message.created", payload: {} },
      { _id: "event-hidden-group", eventId: "event-hidden-group", version: 1, occurredAt: sameTime, actorId: "user-hidden", workspaceId: "workspace-a", groupId: "group-hidden", type: "message.created", payload: {} },
    ]);
    const afterCursor = await fetch(`${origin}/v1/events?after=event-cursor-a`, { headers });
    const afterEvents = (await afterCursor.json()) as any;
    assert.equal(afterEvents.data.some((value: any) => value.eventId === "event-cursor-b"), true);
    assert.equal(afterEvents.data.some((value: any) => value.eventId === "event-private" || value.eventId === "event-hidden-group"), false);
    for (const value of afterEvents.data) eventEnvelopeSchema.parse(value);

    const invalidMention = await fetch(`${origin}/v1/channels/channel-a/messages`, { method: "POST", headers, body: JSON.stringify({ body: "Cross-boundary mention", mentionUserIds: ["user-hidden"], clientId: "invalid-mention-0001" }) });
    assert.equal(invalidMention.status, 400);

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

    const invitationToken = "invitation-token-valid-00000001";
    const wrongRecipientToken = "invitation-token-wrong-0000001";
    const expiredInvitationToken = "invitation-token-expired-00001";
    await database.db.collection("invitations").insertMany([
      { _id: "invite-valid", workspaceId: "workspace-a", email: "invited@example.invalid", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], tokenHash: createHash("sha256").update(invitationToken).digest("hex"), status: "pending", invitedBy: "user-test", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() },
      { _id: "invite-wrong", workspaceId: "workspace-a", email: "someone-else@example.invalid", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], tokenHash: createHash("sha256").update(wrongRecipientToken).digest("hex"), status: "pending", invitedBy: "user-test", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() },
      { _id: "invite-expired", workspaceId: "workspace-a", email: "invited@example.invalid", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], tokenHash: createHash("sha256").update(expiredInvitationToken).digest("hex"), status: "pending", invitedBy: "user-test", expiresAt: new Date(Date.now() - 1), createdAt: new Date() },
    ]);
    const sessionHeaders = { "content-type": "application/json", cookie: sessionCookie };
    const acceptedInvite = await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: invitationToken }) });
    assert.equal(acceptedInvite.status, 200, await acceptedInvite.text());
    assert.equal((await database.db.collection("memberships").findOne({ userId: verifiedUser.id }))?.status, "active");
    assert.equal((await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: invitationToken }) })).status, 404);
    assert.equal((await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: wrongRecipientToken }) })).status, 404);
    assert.equal((await fetch(`${origin}/v1/invitations/accept`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ token: expiredInvitationToken }) })).status, 404);
    assert.equal(await database.db.collection("audit_events").countDocuments({ actorId: verifiedUser.id, result: "failure" }), 3);

    const socket = socketClient(origin, { extraHeaders: { "x-dev-user-id": "user-test" }, transports: ["websocket"] });
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
    await database.db.collection("memberships").updateOne({ _id: "membership-test" }, { $set: { groupIds: ["group-a"], updatedAt: new Date() } });
    const sent = await new Promise<any>((resolve) => socket.emit("message:create", { channelId: "channel-a", body: { body: "Hello @test", mentionUserIds: ["user-test"], clientId: "smoke-message-0001" } }, resolve));
    assert.equal(sent.ok, true);
    const replayedMessage = await new Promise<any>((resolve) => socket.emit("message:create", { channelId: "channel-a", body: { body: "Hello @test", mentionUserIds: ["user-test"], clientId: "smoke-message-0001" } }, resolve));
    assert.equal(replayedMessage.ok, true);
    assert.equal(replayedMessage.data.id, sent.data.id);
    assert.equal(await database.db.collection("messages").countDocuments({ clientId: "smoke-message-0001" }), 1);
    assert.equal(await database.db.collection("events").countDocuments({ _id: sent.data.id, type: "message.created" }), 1);
    const orderedAt = new Date();
    await database.db.collection("messages").insertMany([
      { _id: "message-order-a", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-test", body: "Order A", mentionUserIds: [], clientId: "message-order-client-a", createdAt: orderedAt },
      { _id: "message-order-b", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-test", body: "Order B", mentionUserIds: [], clientId: "message-order-client-b", createdAt: orderedAt },
      { _id: "message-order-c", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", channelId: "channel-a", authorId: "user-test", body: "Order C", mentionUserIds: [], clientId: "message-order-client-c", createdAt: orderedAt },
    ]);
    const firstPage = (await (await fetch(`${origin}/v1/channels/channel-a/messages?limit=2`, { headers })).json()) as any;
    const secondPage = (await (await fetch(`${origin}/v1/channels/channel-a/messages?limit=2&cursor=${firstPage.data.nextCursor}`, { headers })).json()) as any;
    const orderedIds = [...firstPage.data.items, ...secondPage.data.items].map((item: any) => item.id);
    assert.equal(orderedIds.indexOf("message-order-a") < orderedIds.indexOf("message-order-b"), true);
    assert.equal(orderedIds.indexOf("message-order-b") < orderedIds.indexOf("message-order-c"), true);
    socket.close();
  } finally {
    await ioServer.close();
    server.close();
    await once(server, "close");
    await database.native.dropDatabase();
    await database.client.close();
  }
});
