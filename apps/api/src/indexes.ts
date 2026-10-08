import type { AppDb } from "./db.js";
import type { AppDocument } from "./db.js";
import type { Collection } from "mongodb";
import { isTrustedPushEndpoint } from "@venture-studio/core";

export async function deduplicatePushEndpoints(collection: Collection<AppDocument>): Promise<number> {
  let retired = 0;
  const byEndpoint = new Map<string, AppDocument[]>();
  const cursor = collection.find({ endpoint: { $type: "string" } }, { projection: { _id: 1, endpoint: 1 } });
  for await (const row of cursor) {
    const raw = String(row.endpoint);
    const canonical = isTrustedPushEndpoint(raw) ? new URL(raw).href : raw;
    const group = byEndpoint.get(canonical) ?? [];
    group.push(row);
    byEndpoint.set(canonical, group);
  }
  const retire = async (row: AppDocument) => {
    const result = await collection.updateOne({ _id: row._id, endpoint: row.endpoint }, { $set: { active: false, retiredAt: new Date() }, $unset: { endpoint: "", keys: "" } });
    retired += result.modifiedCount;
  };
  // Retire every ambiguous or untrusted legacy row before normalizing single owners.
  for (const [canonical, rows] of byEndpoint) {
    if (rows.length === 1 && isTrustedPushEndpoint(canonical)) continue;
    for (const row of rows) await retire(row);
  }
  for (const [canonical, rows] of byEndpoint) {
    if (rows.length !== 1 || !isTrustedPushEndpoint(canonical)) continue;
    const row = rows[0]!;
    if (row.endpoint !== canonical) await collection.updateOne({ _id: row._id, endpoint: row.endpoint }, { $set: { endpoint: canonical } });
  }
  return retired;
}

export async function ensurePushEndpointIndex(collection: Collection<AppDocument>): Promise<void> {
  let indexes: Awaited<ReturnType<typeof collection.indexes>>;
  try { indexes = await collection.indexes(); }
  catch (error) {
    if ((error as { code?: number }).code !== 26) throw error; // Collection does not exist yet.
    indexes = [];
  }
  const endpointIndex = indexes.find((index) => index.name === "endpoint_1");
  if (endpointIndex && (!endpointIndex.unique || endpointIndex.key?.endpoint !== 1)) throw new Error("Unexpected push endpoint index; manual migration review required");
  // The earlier non-partial unique index cannot hold more than one retired row without an endpoint.
  if (endpointIndex && !endpointIndex.partialFilterExpression) await collection.dropIndex("endpoint_1");
  await deduplicatePushEndpoints(collection);
  await collection.createIndex({ endpoint: 1 }, { unique: true, partialFilterExpression: { endpoint: { $type: "string" } } });
}

export async function ensureIndexes(db: AppDb): Promise<void> {
  await ensurePushEndpointIndex(db.collection("push_subscriptions"));
  await Promise.all([
    db.collection("workspaces").createIndex({ slug: 1 }, { unique: true }),
    // Recovery copies from permanent venture deletes expire on their own after 30 days.
    db.collection("deleted_records").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("deleted_records").createIndex({ deletionId: 1 }),
    db.collection("memberships").createIndex({ workspaceId: 1, userId: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ userId: 1 }, { unique: true, partialFilterExpression: { status: "active" } }),
    db.collection("ventures").createIndex({ workspaceId: 1, name: 1 }, { unique: true }),
    db.collection("groups").createIndex({ ventureId: 1, name: 1 }, { unique: true }),
    db.collection("channels").createIndex({ groupId: 1, name: 1 }, { unique: true }),
    db.collection("messages").createIndex({ channelId: 1, createdAt: -1 }),
    db.collection("messages").createIndex({ dmKey: 1, createdAt: -1 }),
    db.collection("messages").createIndex({ body: "text" }),
    db.collection("messages").createIndex({ workspaceId: 1, authorId: 1, clientId: 1 }, { unique: true }),
    db.collection("message_reactions").createIndex({ messageId: 1, userId: 1, emoji: 1 }, { unique: true }),
    db.collection("message_saves").createIndex({ userId: 1, messageId: 1 }, { unique: true }),
    db.collection("message_saves").createIndex({ userId: 1, createdAt: -1, _id: -1 }),
    db.collection("tasks").createIndex({ workspaceId: 1, assigneeId: 1, status: 1, dueAt: 1 }),
    db.collection("tasks").createIndex({ ventureId: 1, groupId: 1, status: 1 }),
    db.collection("tasks").createIndex({ title: "text", outcome: "text", definitionOfDone: "text", tags: "text" }),
    db.collection("command_executions").createIndex({ workspaceId: 1, actorId: 1, idempotencyKey: 1 }, { unique: true }),
    db.collection("reminders").createIndex({ state: 1, scheduledAt: 1, leaseUntil: 1 }),
    db.collection("notification_outbox").createIndex({ idempotencyKey: 1 }, { unique: true }),
    db.collection("notification_outbox").createIndex({ state: 1, nextAttemptAt: 1, leaseUntil: 1 }),
    db.collection("notifications").createIndex({ outboxId: 1 }, { unique: true }),
    db.collection("notifications").createIndex({ workspaceId: 1, userId: 1, createdAt: -1, _id: -1 }),
    db.collection("notifications").createIndex({ workspaceId: 1, userId: 1, chatKind: 1, chatId: 1, createdAt: -1, _id: -1 }),
    db.collection("documents").createIndex({ workspaceId: 1, ventureId: 1, sensitivity: 1 }),
    db.collection("document_versions").createIndex({ documentId: 1, version: 1 }, { unique: true }),
    db.collection("document_chunks").createIndex({ plainText: "text", headingPath: "text" }),
    db.collection("files").createIndex({ workspaceId: 1, ventureId: 1, status: 1 }),
    db.collection("files").createIndex({ workspaceId: 1, groupId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.collection("files").createIndex({ name: "text" }),
    db.collection("pats").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("pats").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("mcp_executions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("events").createIndex({ workspaceId: 1, occurredAt: 1, _id: 1 }),
    db.collection("audit_events").createIndex({ workspaceId: 1, occurredAt: -1 }),
    db.collection("api_rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}
