import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Filter } from "mongodb";
import { createOutcomeSchema, createTaskSchema, cursorQuerySchema, idSchema, snoozeSchema, startFocusSchema, taskListQuerySchema, updateOutcomeSchema, updateTaskSchema } from "@venture-studio/contracts";
import { can, hasDeadlineRisk, snoozeReminder } from "@venture-studio/core";
import type { AppDb, AppDocument, Database } from "../db.js";
import { atomic } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { z } from "zod";

export function workRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  router.get("/tasks", async (req, res) => {
    const query = taskListQuerySchema.parse(req.query);
    const actor = req.actor!;
    const filter: Filter<AppDocument> = { workspaceId: actor.membership.workspaceId };
    if (query.ventureId) filter.ventureId = query.ventureId;
    if (query.groupId) filter.groupId = query.groupId;
    if (query.assigneeId) filter.assigneeId = query.assigneeId;
    if (query.status) filter.status = query.status;
    if (query.priority) filter.priority = query.priority;
    if (query.tag) filter.tags = query.tag;
    if (query.cursor) filter._id = { $gt: query.cursor };
    if (actor.membership.role !== "admin") {
      filter.ventureId = query.ventureId && actor.membership.ventureIds.includes(query.ventureId) ? query.ventureId : query.ventureId ? { $in: [] } : { $in: actor.membership.ventureIds };
      filter.groupId = query.groupId && actor.membership.groupIds.includes(query.groupId) ? query.groupId : query.groupId ? { $in: [] } : { $in: actor.membership.groupIds };
    }
    const items = await db.collection("tasks").find(filter).sort({ _id: 1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(items.slice(0, query.limit)), nextCursor: items.length > query.limit ? items[query.limit - 1]?._id : undefined } });
  });

  router.get("/tasks/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const task = await accessibleTask(db, req.actor!, id);
    const [updates, evidence, attachments] = await Promise.all([
      db.collection("task_updates").find({ taskId: id }).sort({ createdAt: 1 }).toArray(),
      db.collection("evidence_items").find({ taskId: id }).sort({ submittedAt: 1 }).toArray(),
      db.collection("files").find({ taskId: id, workspaceId: task.workspaceId, ventureId: task.ventureId, groupId: task.groupId, status: "ready" }).sort({ createdAt: 1 }).toArray(),
    ]);
    res.json({ ok: true, data: jsonValue({ ...task, updates, evidence, attachments }) });
  });

  router.post("/tasks", async (req, res) => {
    const input = createTaskSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "task:create", { ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(403, "FORBIDDEN", "You cannot create tasks in this scope");
    await assertTaskScope(db, actor.membership.workspaceId, input);
    await assertAssignableMember(db, actor.membership.workspaceId, input.assigneeId, input.ventureId, input.groupId);
    if (input.reviewerId) await assertAssignableMember(db, actor.membership.workspaceId, input.reviewerId, input.ventureId, input.groupId);
    const now = new Date();
    const id = randomUUID();
    const deadlineRisk = hasDeadlineRisk(input.dueAt, input.estimatedMinutes, now);
    const task = { _id: id, workspaceId: actor.membership.workspaceId, ...input, creatorId: actor.id, status: "proposed", deadlineRisk, createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      const currentActor = await db.collection("memberships").findOneAndUpdate({ workspaceId: actor.membership.workspaceId, userId: actor.id, status: "active" }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
      if (!currentActor || !can(currentActor as unknown as Parameters<typeof can>[0], "task:create", { ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(403, "FORBIDDEN", "You cannot create tasks in this scope");
      await fenceAssignableMember(db, actor.membership.workspaceId, input.assigneeId, input.ventureId, input.groupId, session);
      if (input.reviewerId && input.reviewerId !== input.assigneeId) await fenceAssignableMember(db, actor.membership.workspaceId, input.reviewerId, input.ventureId, input.groupId, session);
      await db.collection("tasks").insertOne(task, { session });
      const latestStartAt = new Date(new Date(input.dueAt).getTime() - input.estimatedMinutes * 60_000);
      await db.collection("reminders").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.assigneeId, taskId: id, kind: "task_start", message: `Start: ${input.title}`, scheduledAt: latestStartAt > now ? latestStartAt : now, timezone: input.timezone, repeatMinutes: 10, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now }, { session });
      await db.collection("task_updates").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, authorId: actor.id, type: "status", body: "Task proposed", toStatus: "proposed", createdAt: now }, { session });
      await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.assigneeId, type: "assignment", title: input.title, body: input.outcome, resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:assigned`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      if (deadlineRisk) await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.assigneeId, type: "deadline_warning", title: `Deadline risk: ${input.title}`, body: "Estimated work exceeds the time remaining before the deadline.", resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:deadline-risk`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "task.create", objectType: "task", objectId: id, ventureId: input.ventureId, result: "success" }, session);
    });
    res.status(201).json({ ok: true, data: jsonValue(task), warnings: deadlineRisk ? ["Estimated effort exceeds the time remaining before the deadline."] : [] });
  });

  router.patch("/tasks/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = updateTaskSchema.parse(req.body);
    const actor = req.actor!;
    const existing = await accessibleTask(db, actor, id);
    const now = new Date();
    await atomic(database, async (session) => {
      const current = await db.collection("tasks").findOne({ _id: id, workspaceId: actor.membership.workspaceId }, { session });
      if (!current) throw new AppError(404, "NOT_FOUND", "Task not found");
      const membership = await db.collection("memberships").findOneAndUpdate({ workspaceId: actor.membership.workspaceId, userId: actor.id, status: "active" }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
      if (!membership || (membership.role !== "admin" && (!membership.ventureIds.includes(String(current.ventureId)) || !membership.groupIds.includes(String(current.groupId))))) throw new AppError(404, "NOT_FOUND", "Task not found");
      if (!can(membership as unknown as Parameters<typeof can>[0], "task:update", { ventureId: String(current.ventureId), groupId: String(current.groupId) })) throw new AppError(403, "FORBIDDEN", "Current role cannot update tasks");
      const elevated = membership.role === "admin" || membership.role === "venture_head";
      if (!elevated && current.assigneeId !== actor.id && current.reviewerId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the assignee, assigned reviewer, or venture lead may update this task");
      if (!elevated && (["assigneeId", "reviewerId", "priority", "dueAt", "estimatedMinutes"] as const).some((field) => input[field] !== undefined)) throw new AppError(403, "FORBIDDEN", "Only a venture lead or workspace admin may change task planning or assignment");
      if (input.status && !elevated && current.assigneeId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the assignee or venture lead may change task progress");
      if (input.assigneeId) await fenceAssignableMember(db, actor.membership.workspaceId, input.assigneeId, String(current.ventureId), String(current.groupId), session);
      if (input.reviewerId && input.reviewerId !== input.assigneeId) await fenceAssignableMember(db, actor.membership.workspaceId, input.reviewerId, String(current.ventureId), String(current.groupId), session);
      if (input.status === "done") {
        const evidence = await db.collection("evidence_items").countDocuments({ taskId: id, reviewStatus: { $in: ["accepted", "exception"] } }, { session });
        if (!evidence) throw new AppError(409, "CONFLICT", "Completion requires accepted evidence or a reviewed exception");
      }
      const nextDueAt = input.dueAt ? new Date(input.dueAt) : new Date(current.dueAt);
      const nextEstimate = input.estimatedMinutes ?? Number(current.estimatedMinutes);
      const nextAssignee = input.assigneeId ?? String(current.assigneeId);
      const assigneeChanged = nextAssignee !== current.assigneeId;
      const planningChanged = assigneeChanged || nextDueAt.getTime() !== new Date(current.dueAt).getTime() || nextEstimate !== current.estimatedMinutes;
      const deadlineRisk = hasDeadlineRisk(nextDueAt, nextEstimate, now);
      const $set: Record<string, unknown> = { ...input, ...(input.dueAt ? { dueAt: nextDueAt } : {}), deadlineRisk, updatedAt: now };
      if (input.blocker === null) delete $set.blocker;
      if (input.status === "accepted") $set.acceptedAt = now;
      if (input.status === "in_progress" && !current.startedAt) $set.startedAt = now;
      if (input.status === "done") $set.completedAt = now;
      await db.collection("tasks").updateOne({ _id: id }, input.blocker === null ? { $set, $unset: { blocker: "" } } : { $set }, { session });
      await db.collection("task_updates").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, authorId: actor.id, type: input.status ? "status" : input.blocker !== undefined ? "blocker" : "comment", body: input.blocker ?? "Task updated", fromStatus: current.status, toStatus: input.status, createdAt: now }, { session });
      if (assigneeChanged) {
        await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, userId: current.assigneeId, type: { $in: ["assignment", "deadline_warning", "reminder"] }, state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
        await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: nextAssignee, type: "assignment", title: current.title, body: current.outcome, resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:reassigned:${randomUUID()}`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      }
      const terminalOrStarted = ["done", "cancelled"].includes(input.status ?? String(current.status)) || Boolean(current.startedAt || $set.startedAt);
      if (terminalOrStarted) {
        await db.collection("reminders").updateMany({ taskId: id, state: { $in: ["scheduled", "claimed"] } }, { $set: { state: "cancelled", cancelReason: "task_started_or_terminal", updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
        await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, type: { $in: ["reminder", "deadline_warning"] }, state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
      } else if (planningChanged) {
        await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, type: "reminder", state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
        if (!deadlineRisk) await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, type: "deadline_warning", state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
        const reminder = await db.collection("reminders").findOne({ taskId: id, $or: [{ kind: "task_start" }, { kind: { $exists: false }, repeatMinutes: 10 }] }, { sort: { createdAt: -1 }, session });
        const latestStartAt = new Date(nextDueAt.getTime() - nextEstimate * 60_000);
        const scheduledAt = latestStartAt > now ? latestStartAt : now;
        if (assigneeChanged || !reminder) {
          if (reminder) await db.collection("reminders").updateMany({ taskId: id, state: { $in: ["scheduled", "claimed"] } }, { $set: { state: "cancelled", cancelReason: "reassigned", updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
          await db.collection("reminders").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: nextAssignee, taskId: id, kind: "task_start", message: `Start: ${current.title}`, scheduledAt, timezone: current.timezone, repeatMinutes: 10, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now }, { session });
        } else if (["scheduled", "claimed"].includes(String(reminder.state))) {
          await db.collection("reminders").updateOne({ _id: reminder._id }, { $set: { scheduledAt, state: "scheduled", updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" }, $inc: { sequence: 1 } }, { session });
        }
        if (deadlineRisk && (!current.deadlineRisk || assigneeChanged)) await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: nextAssignee, type: "deadline_warning", title: `Deadline risk: ${current.title}`, body: "Estimated work exceeds the time remaining before the deadline.", resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:deadline-risk:${randomUUID()}`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      }
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "task.update", objectType: "task", objectId: id, ventureId: String(existing.ventureId), result: "success" }, session);
    });
    res.json({ ok: true, data: jsonValue(await db.collection("tasks").findOne({ _id: id })) });
  });

  router.post("/tasks/:id/evidence", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const actor = req.actor!;
    const task = await accessibleTask(db, actor, id);
    const body = req.body as Record<string, unknown>;
    if (typeof body.title !== "string" || typeof body.description !== "string") throw new AppError(400, "BAD_REQUEST", "title and description are required");
    const evidence = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, type: body.type ?? "link", title: body.title, uri: body.uri, description: body.description, submittedBy: actor.id, submittedAt: new Date(), reviewStatus: "pending" };
    await atomic(database, async (session) => {
      await db.collection("evidence_items").insertOne(evidence, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "task.evidence.add", objectType: "task", objectId: id, ventureId: String(task.ventureId), result: "success" }, session);
    });
    res.status(201).json({ ok: true, data: jsonValue(evidence) });
  });

  router.post("/tasks/:id/comments", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const actor = req.actor!;
    await accessibleTask(db, actor, id);
    const { body } = z.object({ body: z.string().trim().min(1).max(5_000) }).parse(req.body);
    const comment = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, authorId: actor.id, type: "comment", body, createdAt: new Date() };
    await db.collection("task_updates").insertOne(comment);
    res.status(201).json({ ok: true, data: jsonValue(comment) });
  });

  router.post("/evidence/:id/review", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const { status } = z.object({ status: z.enum(["accepted", "rejected", "exception"]) }).parse(req.body);
    const evidence = await db.collection("evidence_items").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!evidence) throw new AppError(404, "NOT_FOUND", "Evidence not found");
    const task = await accessibleTask(db, actor, String(evidence.taskId));
    const elevated = actor.membership.role === "admin" || actor.membership.role === "venture_head" || task.reviewerId === actor.id;
    if (!elevated) throw new AppError(403, "FORBIDDEN", "Only the assigned reviewer or venture lead may review evidence");
    await db.collection("evidence_items").updateOne({ _id: id }, { $set: { reviewStatus: status, reviewedBy: actor.id, reviewedAt: new Date() } });
    res.json({ ok: true, data: jsonValue(await db.collection("evidence_items").findOne({ _id: id })) });
  });

  router.post("/outcomes", async (req, res) => {
    const input = createOutcomeSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "outcome:write", { ventureId: input.ventureId })) throw new AppError(403, "FORBIDDEN", "You cannot create outcomes in this venture");
    const now = new Date();
    const outcome = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...input, createdAt: now, updatedAt: now };
    await db.collection("outcomes").insertOne(outcome);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "outcome.create", objectType: "outcome", objectId: String(outcome._id), ventureId: input.ventureId, result: "success" });
    res.status(201).json({ ok: true, data: jsonValue(outcome) });
  });

  router.get("/outcomes", async (req, res) => {
    const actor = req.actor!;
    const ventureId = typeof req.query.ventureId === "string" ? idSchema.parse(req.query.ventureId) : undefined;
    const allowed = actor.membership.role === "admin" ? {} : { ventureId: { $in: actor.membership.ventureIds } };
    const items = await db.collection("outcomes").find({ workspaceId: actor.membership.workspaceId, ...allowed, ...(ventureId ? { ventureId } : {}) }).sort({ reviewAt: 1 }).toArray();
    res.json({ ok: true, data: jsonValue(items) });
  });
  router.patch("/outcomes/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const existing = await db.collection("outcomes").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!existing || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(String(existing.ventureId)))) throw new AppError(404, "NOT_FOUND", "Outcome not found");
    if (!can(actor.membership, "outcome:write", { ventureId: String(existing.ventureId) })) throw new AppError(403, "FORBIDDEN", "You cannot edit this outcome");
    const input = updateOutcomeSchema.parse(req.body);
    await db.collection("outcomes").updateOne({ _id: id, workspaceId: actor.membership.workspaceId }, { $set: { ...input, ...(input.startAt ? { startAt: new Date(input.startAt) } : {}), ...(input.reviewAt ? { reviewAt: new Date(input.reviewAt) } : {}), updatedAt: new Date() } });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "outcome.update", objectType: "outcome", objectId: id, ventureId: String(existing.ventureId), result: "success" });
    res.json({ ok: true, data: jsonValue(await db.collection("outcomes").findOne({ _id: id })) });
  });

  router.post("/focus", async (req, res) => {
    const input = startFocusSchema.parse(req.body);
    const actor = req.actor!;
    if (input.taskId) await accessibleTask(db, actor, input.taskId);
    const startedAt = new Date();
    const session = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: actor.id, ...input, startedAt, endsAt: new Date(startedAt.getTime() + input.plannedMinutes * 60_000) };
    await db.collection("focus_sessions").insertOne(session);
    res.status(201).json({ ok: true, data: jsonValue(session) });
  });

  router.get("/focus/current", async (req, res) => {
    const actor = req.actor!;
    const session = await db.collection("focus_sessions").findOne({ workspaceId: actor.membership.workspaceId, userId: actor.id, completedAt: { $exists: false }, cancelledAt: { $exists: false } }, { sort: { startedAt: -1 } });
    res.json({ ok: true, data: jsonValue(session) });
  });
  router.get("/focus/history", async (req, res) => {
    const actor = req.actor!; const query = cursorQuerySchema.parse(req.query);
    const scope = { workspaceId: actor.membership.workspaceId, userId: actor.id };
    const cursor = query.cursor ? await db.collection("focus_sessions").findOne({ _id: idSchema.parse(query.cursor), ...scope, completedAt: { $exists: true } }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Focus cursor not found");
    const after = cursor ? { $or: [{ startedAt: { $lt: cursor.startedAt } }, { startedAt: cursor.startedAt, _id: { $lt: cursor._id } }] } : {};
    const rows = await db.collection("focus_sessions").find({ ...scope, completedAt: { $exists: true }, ...after }).sort({ startedAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(rows.slice(0, query.limit)), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?._id) : undefined } });
  });

  router.post("/focus/:id/complete", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const result = await db.collection("focus_sessions").updateOne({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id, completedAt: { $exists: false }, cancelledAt: { $exists: false } }, { $set: { completedAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "Active focus session not found");
    res.json({ ok: true, data: jsonValue(await db.collection("focus_sessions").findOne({ _id: id })) });
  });

  router.get("/task-filters", async (req, res) => {
    const actor = req.actor!; res.json({ ok: true, data: jsonValue(await db.collection("task_filters").find({ workspaceId: actor.membership.workspaceId, userId: actor.id }).sort({ name: 1 }).toArray()) });
  });
  router.put("/task-filters/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const input = z.object({ name: z.string().trim().min(1).max(100), filters: taskListQuerySchema.omit({ cursor: true, limit: true }) }).parse(req.body);
    await db.collection("task_filters").updateOne({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { ...input, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ ok: true, data: jsonValue(await db.collection("task_filters").findOne({ _id: id })) });
  });

  router.get("/reminders", async (req, res) => {
    const actor = req.actor!; const query = cursorQuerySchema.parse(req.query);
    const scope = { workspaceId: actor.membership.workspaceId, userId: actor.id };
    const cursor = query.cursor ? await db.collection("reminders").findOne({ _id: idSchema.parse(query.cursor), ...scope }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Reminder cursor not found");
    const after = cursor ? { $or: [{ scheduledAt: { $lt: cursor.scheduledAt } }, { scheduledAt: cursor.scheduledAt, _id: { $lt: cursor._id } }] } : {};
    const rows = await db.collection("reminders").find({ ...scope, ...after }).sort({ scheduledAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(rows.slice(0, query.limit)), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?._id) : undefined } });
  });
  router.get("/reminders/:id", async (req, res) => {
    const actor = req.actor!;
    const item = await db.collection("reminders").findOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId, userId: actor.id });
    if (!item) throw new AppError(404, "NOT_FOUND", "Reminder not found");
    res.json({ ok: true, data: jsonValue(item) });
  });
  router.post("/reminders/:id/snooze", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const { minutes } = snoozeSchema.parse(req.body);
    const actor = req.actor!;
    const reminder = await db.collection("reminders").findOne({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id });
    if (!reminder) throw new AppError(404, "NOT_FOUND", "Reminder not found");
    if (reminder.state === "claimed") throw new AppError(409, "CONFLICT", "Reminder is currently being delivered; retry snooze shortly");
    if (reminder.state === "cancelled" || (reminder.state === "completed" && reminder.completionReason !== "delivered")) throw new AppError(409, "CONFLICT", "A terminal reminder cannot be snoozed");
    if (reminder.taskId) {
      const task = await db.collection("tasks").findOne({ _id: reminder.taskId, workspaceId: actor.membership.workspaceId });
      if (task?.startedAt || task?.completedAt || ["done", "cancelled"].includes(String(task?.status))) throw new AppError(409, "CONFLICT", "A reminder for started or terminal work cannot be snoozed");
    }
    const scheduledAt = snoozeReminder(new Date(), minutes);
    const allowedStates = reminder.state === "completed" ? ["completed"] : ["scheduled"];
    const update = scheduledAt
      ? { $set: { scheduledAt, state: "scheduled", updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "", completionReason: "" }, $inc: { sequence: 1 } }
      : { $set: { state: "cancelled", cancelReason: "never", updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "" } };
    await atomic(database, async (session) => {
      const changed = await db.collection("reminders").updateOne({ _id: id, state: { $in: allowedStates }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] }, update, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Reminder changed while snoozing; reload and try again");
      await db.collection("notification_outbox").updateMany({ reminderId: id, state: "pending" }, { $set: { state: "cancelled", updatedAt: new Date() } }, { session });
    });
    res.json({ ok: true, data: jsonValue(await db.collection("reminders").findOne({ _id: id })) });
  });
  return router;
}

async function accessibleTask(db: AppDb, actor: NonNullable<Express.Request["actor"]>, id: string) {
  const task = await db.collection("tasks").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
  if (!task || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(task.ventureId)) || !actor.membership.groupIds.includes(String(task.groupId))))) throw new AppError(404, "NOT_FOUND", "Task not found");
  return task;
}

async function assertAssignableMember(db: AppDb, workspaceId: string, userId: string, ventureId: string, groupId: string, session?: import("mongodb").ClientSession): Promise<void> {
  const membership = await db.collection("memberships").findOne({ workspaceId, userId, status: "active", ventureIds: ventureId, groupIds: groupId }, { session });
  if (!membership) throw new AppError(400, "BAD_REQUEST", "Assignee or reviewer is not an active member of this venture and group");
}

async function fenceAssignableMember(db: AppDb, workspaceId: string, userId: string, ventureId: string, groupId: string, session?: import("mongodb").ClientSession): Promise<void> {
  const membership = await db.collection("memberships").findOneAndUpdate({ workspaceId, userId, status: "active", ventureIds: ventureId, groupIds: groupId }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
  if (!membership) throw new AppError(400, "BAD_REQUEST", "Assignee or reviewer is not an active member of this venture and group");
}

async function assertTaskScope(db: AppDb, workspaceId: string, input: { ventureId: string; groupId: string; channelId?: string; outcomeId?: string; parentTaskId?: string; dependencies: string[] }): Promise<void> {
  const group = await db.collection("groups").findOne({ _id: input.groupId, workspaceId, ventureId: input.ventureId });
  if (!group) throw new AppError(400, "BAD_REQUEST", "Task group does not belong to the selected venture");
  if (input.channelId && !await db.collection("channels").findOne({ _id: input.channelId, workspaceId, ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(400, "BAD_REQUEST", "Task channel does not belong to the selected group");
  if (input.outcomeId && !await db.collection("outcomes").findOne({ _id: input.outcomeId, workspaceId, ventureId: input.ventureId })) throw new AppError(400, "BAD_REQUEST", "Task outcome does not belong to the selected venture");
  const relatedIds = [...new Set([...(input.parentTaskId ? [input.parentTaskId] : []), ...input.dependencies])];
  if (relatedIds.length) {
    const related = await db.collection("tasks").countDocuments({ _id: { $in: relatedIds }, workspaceId, ventureId: input.ventureId, groupId: input.groupId });
    if (related !== relatedIds.length) throw new AppError(400, "BAD_REQUEST", "Parent and dependency tasks must belong to the selected venture and group");
  }
}
