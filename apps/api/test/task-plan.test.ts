import assert from "node:assert/strict";
import test from "node:test";
import { withSalesApp } from "./mcp-sales-harness.js";

// A task's plan (routes/work.ts): leads move its due date, priority and estimate; the activity log says what moved; the assignee hears
// when someone else moves their due date; a finished task keeps its due date and estimate until it is reopened.

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };

test("a task's plan: leads move it, the log says what moved, the assignee is told, and a finished task keeps it", { skip }, async () => {
  await withSalesApp(async ({ api, db }) => {
    const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
    const due = "2026-11-20T11:30:00.000Z";
    const created = await call("POST", "/tasks", "boss", {
      ventureId: "venture-a", groupId: "group-a", title: "Ship the pricing page", outcome: "The page is live", assigneeId: "user-member", dueAt: due, timezone: "Asia/Kolkata",
      estimatedMinutes: 120, definitionOfDone: "Live on the site", evidenceRequirement: "A link",
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.data.id;

    // A lead moves the due date and the priority: both said in the log, in the task's time zone; the assignee is told.
    const moved = await call("PATCH", `/tasks/${id}`, "lead", { dueAt: "2026-11-25T11:30:00.000Z", priority: "high" });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual([moved.body.data.dueAt, moved.body.data.priority], ["2026-11-25T11:30:00.000Z", "high"]);
    const logged = await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next();
    assert.equal(logged?.body, "Moved the due date from 20 Nov 2026 at 5:00 pm to 25 Nov 2026 at 5:00 pm and changed the priority from medium to high");
    const told = await db.collection("notification_outbox").findOne({ resourceId: id, userId: "user-member", title: "Due date moved: Ship the pricing page" });
    assert.equal(told?.body, "Person lead moved it to 25 Nov 2026 at 5:00 pm.");
    // The start reminder follows the new date (it is due two hours before, the estimate).
    const reminder = await db.collection("reminders").findOne({ taskId: id, kind: "task_start", state: "scheduled" });
    assert.equal(reminder?.scheduledAt.toISOString(), "2026-11-25T09:30:00.000Z");
    // The assignee can't move their own due date; the estimate's change is logged too.
    assert.equal((await call("PATCH", `/tasks/${id}`, "member", { dueAt: "2026-12-30T11:30:00.000Z" })).status, 403);
    // One change alone reads plainly (the date's own commas aren't taken for a list).
    await call("PATCH", `/tasks/${id}`, "lead", { dueAt: "2026-11-26T11:30:00.000Z" });
    assert.equal((await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next())?.body, "Moved the due date from 25 Nov 2026 at 5:00 pm to 26 Nov 2026 at 5:00 pm");
    await call("PATCH", `/tasks/${id}`, "boss", { estimatedMinutes: 90 });
    assert.equal((await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next())?.body, "Changed the estimate from 120 to 90 minutes");
    assert.equal(await db.collection("notification_outbox").countDocuments({ resourceId: id, userId: "user-member", title: /^Due date moved/ }), 2, "each move is told; an estimate alone tells nobody");

    // Once work is handed in (evidence waiting for review, accepted or an exception), the due date and estimate stay: the on-time record
    // measures the hand-in against them. Sending the date it already has is no change; a rejected hand-in doesn't count.
    await db.collection("evidence_items").insertOne({ _id: "evidence-plan", workspaceId: "workspace-a", taskId: id, type: "note", title: "Draft", description: "First cut", submittedBy: "user-member", reviewStatus: "pending", submittedAt: new Date(), createdAt: new Date() } as never);
    const handedIn = await call("PATCH", `/tasks/${id}`, "lead", { dueAt: "2026-12-05T11:30:00.000Z" });
    assert.deepEqual([handedIn.status, handedIn.body.error.message], [409, "Work was already handed in for this task, so its due date and estimate stay as they were: its on-time record is measured against them"]);
    assert.equal((await call("PATCH", `/tasks/${id}`, "lead", { dueAt: "2026-11-26T11:30:00.000Z", priority: "urgent" })).status, 200, "the date it has, with a new priority");
    await db.collection("evidence_items").updateOne({ _id: "evidence-plan" }, { $set: { reviewStatus: "rejected" } });
    assert.equal((await call("PATCH", `/tasks/${id}`, "lead", { estimatedMinutes: 100 })).status, 200, "a rejected hand-in leaves the plan open");
    await db.collection("evidence_items").deleteOne({ _id: "evidence-plan" });
    // A blocker and a plan change together: both in the log.
    await call("PATCH", `/tasks/${id}`, "lead", { blocker: "Waiting on copy", dueAt: "2026-11-27T11:30:00.000Z" });
    assert.equal((await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next())?.body, "Waiting on copy. Moved the due date from 26 Nov 2026 at 5:00 pm to 27 Nov 2026 at 5:00 pm");

    // Finished: the due date and estimate stay (its on-time record is measured against them); the priority may still change, and
    // reopening it in the same change moves the date.
    await db.collection("tasks").updateOne({ _id: id }, { $set: { status: "done", completedAt: new Date() } });
    const refused = await call("PATCH", `/tasks/${id}`, "boss", { dueAt: "2026-12-01T11:30:00.000Z" });
    assert.deepEqual([refused.status, refused.body.error.message], [409, "This task is finished, so its due date and estimate can't change; reopen it first"]);
    assert.equal((await call("PATCH", `/tasks/${id}`, "boss", { estimatedMinutes: 30 })).status, 409);
    assert.equal((await call("PATCH", `/tasks/${id}`, "boss", { priority: "low" })).status, 200);
    assert.equal((await call("PATCH", `/tasks/${id}`, "boss", { dueAt: "2026-11-27T11:30:00.000Z" })).status, 200, "the date it has is never refused");
    const reopened = await call("PATCH", `/tasks/${id}`, "boss", { status: "in_progress", dueAt: "2026-12-01T11:30:00.000Z" });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(reopened.body.data.dueAt, "2026-12-01T11:30:00.000Z");
  }, "task_plan");
});
