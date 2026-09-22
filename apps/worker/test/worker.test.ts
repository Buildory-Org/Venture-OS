import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { reminderTransition } from "../src/rules.js";
import { Worker } from "../src/worker.js";

test("an unstarted task repeats on the reminder cadence, independent of delivery retry", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const transition = reminderTransition({ repeatMinutes: 10, sequence: 2 }, { status: "accepted" }, now);
  assert.equal(transition.state, "scheduled");
  assert.equal(transition.nextAt?.toISOString(), "2026-09-23T10:10:00.000Z");
  assert.equal(transition.nextSequence, 3);
});

test("starting or completing a task ends its reminder recurrence", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  assert.equal(reminderTransition({ repeatMinutes: 10, sequence: 0 }, { startedAt: now }, now).state, "completed");
  assert.equal(reminderTransition({ repeatMinutes: null, sequence: 0 }, null, now).state, "completed");
});

test("real Mongo replica-set smoke: reminder claim, recurrence, outbox idempotency, and delivery retry", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  const client = new MongoClient(process.env.TEST_MONGODB_URI!);
  await client.connect();
  const dbName = `venture_studio_worker_test_${process.pid}_${Date.now()}`;
  assert.match(dbName, /^venture_studio_worker_test_/);
  const db = client.db(dbName);
  const collection = (name: string) => db.collection<Record<string, any> & { _id: string }>(name);
  const now = new Date("2026-09-23T10:00:00.000Z");
  const config = { APP_MODE: "local" as const, MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DB: dbName, WORKER_ID: "worker-test", POLL_MS: 100, EMAIL_FROM: "Venture Studio <noreply@example.invalid>", VAPID_SUBJECT: "mailto:admin@example.invalid" };
  try {
    await collection("notification_outbox").createIndex({ idempotencyKey: 1 }, { unique: true });
    await collection("notifications").createIndex({ outboxId: 1 }, { unique: true });
    await collection("users").insertOne({ _id: "user-a", workspaceId: "workspace-a", status: "active", email: "a@example.invalid" });
    await collection("tasks").insertOne({ _id: "task-a", status: "accepted" });
    await collection("reminders").insertOne({ _id: "reminder-a", workspaceId: "workspace-a", userId: "user-a", taskId: "task-a", message: "Start work", scheduledAt: now, repeatMinutes: 10, sequence: 0, state: "scheduled", createdAt: now, updatedAt: now });
    const worker = new Worker(client, db, config, true);
    assert.equal(await worker.tick(now), true);
    const reminder = await collection("reminders").findOne({ _id: "reminder-a" });
    assert.equal(reminder?.state, "scheduled");
    assert.equal(reminder?.scheduledAt.toISOString(), "2026-09-23T10:10:00.000Z");
    assert.equal(await collection("notification_outbox").countDocuments({ idempotencyKey: "reminder:reminder-a:0" }), 1);
    assert.equal((await collection("notification_outbox").findOne({ idempotencyKey: "reminder:reminder-a:0" }))?.reminderId, "reminder-a");
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ idempotencyKey: "reminder:reminder-a:0" }))?.state, "delivered");
    assert.equal(await collection("notifications").countDocuments({ outboxId: { $exists: true } }), 1);
    assert.equal((await collection("notifications").findOne({ outboxId: { $exists: true } }))?.reminderId, "reminder-a");
    await collection("notification_outbox").insertOne({ _id: "outbox-fail", workspaceId: "workspace-a", userId: "missing-user", type: "reminder", title: "Fail", body: "Fail", resourceType: "task", resourceId: "task-a", idempotencyKey: "failure-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    const failed = await collection("notification_outbox").findOne({ _id: "outbox-fail" });
    assert.equal(failed?.state, "pending");
    assert.equal(failed?.attempts, 1);
    assert.equal(failed?.nextAttemptAt.toISOString(), "2026-09-23T10:01:00.000Z");

    await collection("tasks").insertOne({ _id: "task-terminal", workspaceId: "workspace-a", status: "done", completedAt: now });
    await collection("reminders").insertOne({ _id: "reminder-terminal", workspaceId: "workspace-a", userId: "user-a", taskId: "task-terminal", message: "Do not send", scheduledAt: now, repeatMinutes: 10, sequence: 0, state: "scheduled", createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("reminders").findOne({ _id: "reminder-terminal" }))?.completionReason, "task_terminal");
    assert.equal(await collection("notification_outbox").countDocuments({ idempotencyKey: "reminder:reminder-terminal:0" }), 0);

    await collection("reminders").insertOne({ _id: "reminder-expired", workspaceId: "workspace-a", userId: "user-a", taskId: "task-a", message: "Recovered", scheduledAt: now, repeatMinutes: null, sequence: 0, state: "claimed", claimedBy: "dead-worker", leaseUntil: new Date(now.getTime() - 1), createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("reminders").findOne({ _id: "reminder-expired" }))?.state, "completed");
    assert.equal(await collection("notification_outbox").countDocuments({ idempotencyKey: "reminder:reminder-expired:0" }), 1);
    assert.equal(await worker.tick(now), true);

    await collection("notification_preferences").insertOne({ _id: "preferences-a", workspaceId: "workspace-a", userId: "user-a", reminders: false, messages: false, email: true, webPush: true });
    await collection("notification_outbox").insertOne({ _id: "outbox-muted", workspaceId: "workspace-a", userId: "user-a", type: "reminder", title: "Muted", body: "Muted", resourceType: "task", resourceId: "task-a", idempotencyKey: "muted-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ _id: "outbox-muted" }))?.state, "delivered");
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-muted" }), 0);
    await collection("notification_outbox").insertOne({ _id: "outbox-message-muted", workspaceId: "workspace-a", userId: "user-a", type: "message", title: "DM", body: "Muted DM", resourceType: "message", resourceId: "message-a", idempotencyKey: "muted-message-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-message-muted" }), 0);

    await collection("notification_outbox").insertOne({ _id: "outbox-dead", workspaceId: "workspace-a", userId: "missing-user", type: "reminder", title: "Dead", body: "Dead", resourceType: "task", resourceId: "task-a", idempotencyKey: "dead-test", state: "pending", attempts: 7, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ _id: "outbox-dead" }))?.state, "dead");

    await collection("notification_preferences").updateOne({ _id: "preferences-a" }, { $set: { reminders: true, messages: true } });
    await collection("notification_outbox").insertOne({ _id: "outbox-race", workspaceId: "workspace-a", userId: "user-a", type: "reminder", title: "Race", body: "Race", resourceType: "task", resourceId: "task-a", idempotencyKey: "race-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    const competitor = new Worker(client, db, { ...config, WORKER_ID: "worker-competitor" }, true);
    const claims = await Promise.all([worker.tick(now), competitor.tick(now)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-race" }), 1);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
