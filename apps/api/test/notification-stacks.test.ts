import assert from "node:assert/strict";
import test from "node:test";
import { notificationHistorySchema, notificationSchema, successEnvelope } from "@venture-studio/contracts";
import { stackReminderNotifications } from "../src/notification-stacks.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Stacked reminders in the inbox (routes/notifications.ts, notification-stacks.ts, the snooze in routes/work.ts): one row per
// reminder with its count, its ring times on request, removing a row without stopping the reminder, the Start button's flag, and
// snoozing from the next ring.

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 12, 0) + minutes * 60_000);

test("the inbox: one row per reminder with its count, ring times on request, rows removed without stopping the reminder, and Start for waiting tasks", { skip }, async () => {
  await withSalesApp(async ({ db, api }) => {
    const now = new Date();
    for (const [id, status, title] of [["task-todo", "todo", "Ship it"], ["task-review", "review", "Check it"]] as const) {
      await db.collection("tasks").insertOne({ _id: id, workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", title, assigneeId: "user-member", status, createdAt: now, updatedAt: now } as never);
      await db.collection("reminders").insertOne({ _id: `reminder-${id}`, workspaceId: "workspace-a", userId: "user-member", taskId: id, kind: "task_start", message: `Start: ${title}`, scheduledAt: new Date(now.getTime() + 600_000), repeatMinutes: 10, state: "scheduled", sequence: 3, createdAt: now, updatedAt: now } as never);
    }
    // Assigned to them, waiting in to do, but in a venture they're no longer part of: no Start.
    await db.collection("tasks").insertOne({ _id: "task-elsewhere", workspaceId: "workspace-a", ventureId: "venture-b", groupId: "group-b", title: "Elsewhere", assigneeId: "user-member", status: "todo", createdAt: now, updatedAt: now } as never);
    await db.collection("reminders").insertOne({ _id: "reminder-task-elsewhere", workspaceId: "workspace-a", userId: "user-member", taskId: "task-elsewhere", kind: "task_start", message: "Start: Elsewhere", scheduledAt: now, repeatMinutes: 10, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now } as never);
    await db.collection("reminders").insertOne({ _id: "reminder-note", workspaceId: "workspace-a", userId: "user-member", taskId: "task-todo", kind: "personal", message: "Call the bank", scheduledAt: now, repeatMinutes: null, state: "completed", completionReason: "delivered", sequence: 0, createdAt: now, updatedAt: now } as never);
    const row = (id: string, extra: Record<string, unknown>) => ({ _id: id, outboxId: id, workspaceId: "workspace-a", userId: "user-member", type: "reminder", title: "Reminder", body: "Start", resourceType: "task", createdAt: now, ...extra });
    await db.collection("notifications").insertMany([
      row("stack-todo", { resourceId: "task-todo", reminderId: "reminder-task-todo", repeats: 3, firstAt: at(0), rungAt: [at(20), at(10), at(0)] }),
      row("stack-review", { resourceId: "task-review", reminderId: "reminder-task-review" }),
      row("note", { resourceId: "task-todo", reminderId: "reminder-note", body: "Call the bank" }),
      row("someone-else", { userId: "user-member2", resourceId: "task-todo", reminderId: "reminder-x" }),
      row("elsewhere", { resourceId: "task-elsewhere", reminderId: "reminder-task-elsewhere" }),
    ] as never[]);

    const list = await read(await api("GET", "/notifications", "member"));
    assert.equal(list.status, 200, list.text);
    const items = successEnvelope(notificationSchema.array()).parse(list.body).data;
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.deepEqual([...byId.keys()].sort(), ["elsewhere", "note", "stack-review", "stack-todo"]);
    assert.equal(byId.get("stack-todo")?.repeats, 3);
    assert.equal(byId.get("stack-todo")?.firstAt, at(0).toISOString());
    // The ring times stay out of the often-polled list.
    assert.equal(list.body.data.find((item: any) => item.id === "stack-todo").rungAt, undefined);
    // Start shows for the task waiting in to do, not for one in review, one in a venture they've left, nor a personal note on the task.
    assert.deepEqual(items.filter((item) => item.startable).map((item) => item.id), ["stack-todo"]);

    const history = await read(await api("GET", "/notifications/stack-todo/history", "member"));
    assert.equal(history.status, 200, history.text);
    assert.deepEqual(successEnvelope(notificationHistorySchema).parse(history.body).data, { id: "stack-todo", repeats: 3, firstAt: at(0).toISOString(), rungAt: [at(20), at(10), at(0)].map((time) => time.toISOString()) });
    // A row from before stacking is one ring, when it arrived.
    assert.deepEqual((await read(await api("GET", "/notifications/note/history", "member"))).body.data.rungAt, [now.toISOString()]);
    assert.equal((await api("GET", "/notifications/someone-else/history", "member")).status, 404);

    // Removing a row hides it from the inbox and its history; the reminder rings on, and nobody else's row can be removed.
    const removed = await read(await api("POST", "/notifications/stack-todo/dismiss", "member"));
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual((await read(await api("GET", "/notifications", "member"))).body.data.map((item: any) => item.id).sort(), ["elsewhere", "note", "stack-review"]);
    assert.equal((await api("GET", "/notifications/stack-todo/history", "member")).status, 404);
    assert.equal((await db.collection("reminders").findOne({ _id: "reminder-task-todo" as never }))?.state, "scheduled");
    assert.equal((await api("POST", "/notifications/someone-else/dismiss", "member")).status, 404);
    assert.equal((await db.collection("notifications").findOne({ _id: "someone-else" as never }))?.dismissedAt, undefined);
  }, "stack-inbox");
});

test("snooze counts from the next ring: just after a ring, 10 minutes means twenty of quiet; a reminder weeks away moves later, never earlier", { skip }, async () => {
  await withSalesApp(async ({ db, api }) => {
    const now = new Date();
    await db.collection("tasks").insertOne({ _id: "task-s", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", title: "Ship it", assigneeId: "user-member", status: "todo", createdAt: now, updatedAt: now } as never);
    // It has just rung: the worker set its next ring one repeat (ten minutes) ahead.
    const next = new Date(now.getTime() + 600_000);
    await db.collection("reminders").insertOne({ _id: "reminder-s", workspaceId: "workspace-a", userId: "user-member", taskId: "task-s", kind: "task_start", message: "Start: Ship it", scheduledAt: next, repeatMinutes: 10, state: "scheduled", sequence: 4, createdAt: now, updatedAt: now } as never);
    const snooze = async (id: string, minutes: number) => { const result = await read(await api("POST", `/reminders/${id}/snooze`, "member", { minutes })); assert.equal(result.status, 200, result.text); return new Date(result.body.data.scheduledAt).getTime(); };
    assert.equal(await snooze("reminder-s", 10), next.getTime() + 600_000);
    assert.equal(await snooze("reminder-s", 30), next.getTime() + 600_000 + 1_800_000);
    const later = new Date(now.getTime() + 20 * 86_400_000);
    await db.collection("reminders").insertOne({ _id: "reminder-later", workspaceId: "workspace-a", userId: "user-member", taskId: "task-s", kind: "personal", message: "Renew the domain", scheduledAt: later, repeatMinutes: null, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now } as never);
    assert.equal(await snooze("reminder-later", 10), later.getTime() + 600_000);
    // A one-time reminder that already rang counts from now.
    await db.collection("reminders").insertOne({ _id: "reminder-rang", workspaceId: "workspace-a", userId: "user-member", taskId: "task-s", kind: "personal", message: "Call back", scheduledAt: new Date(now.getTime() - 3_600_000), repeatMinutes: null, state: "completed", completionReason: "delivered", sequence: 0, createdAt: now, updatedAt: now } as never);
    const rang = await snooze("reminder-rang", 20);
    assert.ok(Math.abs(rang - (Date.now() + 1_200_000)) < 5_000, `about twenty minutes from now: ${new Date(rang).toISOString()}`);
  }, "stack-snooze");
});

test("rows from before stacking fold into one per reminder and person, the newest kept with its read state; a second run changes nothing", { skip }, async () => {
  await withSalesApp(async ({ db, database }) => {
    const row = (id: string, userId: string, reminderId: string | undefined, createdAt: Date, extra: Record<string, unknown> = {}) => ({ _id: id, outboxId: id, workspaceId: "workspace-a", userId, type: "reminder", title: "Reminder", body: "Start", resourceType: "task", resourceId: "task-a", ...(reminderId ? { reminderId } : {}), createdAt, ...extra });
    await db.collection("notifications").insertMany([
      row("a1", "user-member", "reminder-a", at(0)), row("a2", "user-member", "reminder-a", at(10), { readAt: at(11) }), row("a3", "user-member", "reminder-a", at(20), { readAt: at(21) }),
      row("b1", "user-member2", "reminder-a", at(5)), row("b2", "user-member2", "reminder-a", at(15)),
      row("solo", "user-member", "reminder-b", at(0)), row("plain-1", "user-member", undefined, at(0)), row("plain-2", "user-member", undefined, at(1)),
    ] as never[]);
    assert.equal(await stackReminderNotifications(database), 3);
    const rows = await db.collection("notifications").find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(rows.map((item) => item._id), ["a3", "b2", "plain-1", "plain-2", "solo"]);
    const a3 = rows.find((item) => item._id === "a3")!;
    assert.deepEqual([a3.repeats, a3.firstAt.toISOString(), a3.rungAt.map((time: Date) => time.toISOString()), a3.readAt.toISOString()], [3, at(0).toISOString(), [at(20), at(10), at(0)].map((time) => time.toISOString()), at(21).toISOString()]);
    assert.equal(rows.find((item) => item._id === "b2")!.repeats, 2);
    assert.equal(await stackReminderNotifications(database), 0);
    assert.equal((await db.collection("notifications").findOne({ _id: "a3" as never }))?.repeats, 3);
  }, "stack-backfill");
});
