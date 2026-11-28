import assert from "node:assert/strict";
import test from "node:test";
import { withSalesApp } from "./mcp-sales-harness.js";

// A task's plan (routes/work.ts): leads move its due date, priority and estimate; the activity log says what moved; the assignee hears
// when someone else moves their due date; a finished task keeps its due date and estimate until it is reopened.

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };

// Dates are counted from today, far enough ahead that a due date is never in the past (a start reminder for a past date rings at once).
// 11:30 UTC is 5:00 pm in Asia/Kolkata (the task's time zone, no daylight saving), on the same calendar day.
const start = new Date();
const day = (offset: number) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 60 + offset, 11, 30)).toISOString();
/** A due date as the log and the notice write it, e.g. "20 Nov 2026 at 5:00 pm". */
const shown = (iso: string) => `${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso))} at ${new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso))}`;

test("a task's plan: leads move it, the log says what moved, the assignee is told, and a finished task keeps it", { skip }, async () => {
  await withSalesApp(async ({ api, db }) => {
    const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
    const due = day(0);
    assert.match(shown(due), /^\d{1,2} [A-Z][a-z]{2,4} \d{4} at 5:00 pm$/, "the log's date format");
    const created = await call("POST", "/tasks", "boss", {
      ventureId: "venture-a", groupId: "group-a", title: "Ship the pricing page", outcome: "The page is live", assigneeId: "user-member", dueAt: due, timezone: "Asia/Kolkata",
      estimatedMinutes: 120, definitionOfDone: "Live on the site", evidenceRequirement: "A link",
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.data.id;

    // A lead moves the due date and the priority: both said in the log, in the task's time zone; the assignee is told.
    const moved = await call("PATCH", `/tasks/${id}`, "lead", { dueAt: day(5), priority: "high" });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual([moved.body.data.dueAt, moved.body.data.priority], [day(5), "high"]);
    const logged = await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next();
    assert.equal(logged?.body, `Moved the due date from ${shown(day(0))} to ${shown(day(5))} and changed the priority from medium to high`);
    const told = await db.collection("notification_outbox").findOne({ resourceId: id, userId: "user-member", title: "Due date moved: Ship the pricing page" });
    assert.equal(told?.body, `Person lead moved it to ${shown(day(5))}.`);
    // The start reminder follows the new date (it is due two hours before, the estimate).
    const reminder = await db.collection("reminders").findOne({ taskId: id, kind: "task_start", state: "scheduled" });
    assert.equal(reminder?.scheduledAt.toISOString(), new Date(new Date(day(5)).getTime() - 2 * 3_600_000).toISOString());
    // The assignee can't move their own due date; the estimate's change is logged too.
    assert.equal((await call("PATCH", `/tasks/${id}`, "member", { dueAt: day(40) })).status, 403);
    // One change alone reads plainly (the date's own commas aren't taken for a list).
    await call("PATCH", `/tasks/${id}`, "lead", { dueAt: day(6) });
    assert.equal((await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next())?.body, `Moved the due date from ${shown(day(5))} to ${shown(day(6))}`);
    await call("PATCH", `/tasks/${id}`, "boss", { estimatedMinutes: 90 });
    assert.equal((await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next())?.body, "Changed the estimate from 120 to 90 minutes");
    assert.equal(await db.collection("notification_outbox").countDocuments({ resourceId: id, userId: "user-member", title: /^Due date moved/ }), 2, "each move is told; an estimate alone tells nobody");

    // Once work is handed in (evidence waiting for review, accepted or an exception), the due date and estimate stay: the on-time record
    // measures the hand-in against them. Sending the date it already has is no change; a rejected hand-in doesn't count.
    await db.collection("evidence_items").insertOne({ _id: "evidence-plan", workspaceId: "workspace-a", taskId: id, type: "note", title: "Draft", description: "First cut", submittedBy: "user-member", reviewStatus: "pending", submittedAt: new Date(), createdAt: new Date() } as never);
    const handedIn = await call("PATCH", `/tasks/${id}`, "lead", { dueAt: day(15) });
    assert.deepEqual([handedIn.status, handedIn.body.error.message], [409, "Work was already handed in for this task, so its due date and estimate stay as they were: its on-time record is measured against them"]);
    assert.equal((await call("PATCH", `/tasks/${id}`, "lead", { dueAt: day(6), priority: "urgent" })).status, 200, "the date it has, with a new priority");
    await db.collection("evidence_items").updateOne({ _id: "evidence-plan" }, { $set: { reviewStatus: "rejected" } });
    assert.equal((await call("PATCH", `/tasks/${id}`, "lead", { estimatedMinutes: 100 })).status, 200, "a rejected hand-in leaves the plan open");
    await db.collection("evidence_items").deleteOne({ _id: "evidence-plan" });
    // A blocker and a plan change together: both in the log.
    await call("PATCH", `/tasks/${id}`, "lead", { blocker: "Waiting on copy", dueAt: day(7) });
    assert.equal((await db.collection("task_updates").find({ taskId: id }).sort({ createdAt: -1 }).limit(1).next())?.body, `Waiting on copy. Moved the due date from ${shown(day(6))} to ${shown(day(7))}`);

    // Finished: the due date and estimate stay (its on-time record is measured against them); the priority may still change, and
    // reopening it in the same change moves the date.
    await db.collection("tasks").updateOne({ _id: id }, { $set: { status: "done", completedAt: new Date() } });
    const refused = await call("PATCH", `/tasks/${id}`, "boss", { dueAt: day(11) });
    assert.deepEqual([refused.status, refused.body.error.message], [409, "This task is finished, so its due date and estimate can't change; reopen it first"]);
    assert.equal((await call("PATCH", `/tasks/${id}`, "boss", { estimatedMinutes: 30 })).status, 409);
    assert.equal((await call("PATCH", `/tasks/${id}`, "boss", { priority: "low" })).status, 200);
    assert.equal((await call("PATCH", `/tasks/${id}`, "boss", { dueAt: day(7) })).status, 200, "the date it has is never refused");
    const reopened = await call("PATCH", `/tasks/${id}`, "boss", { status: "in_progress", dueAt: day(11) });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(reopened.body.data.dueAt, day(11));
  }, "task_plan");
});
