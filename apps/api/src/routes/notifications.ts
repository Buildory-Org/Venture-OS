import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db.js";
import { DEFAULT_EXPENSE_CATEGORIES, idSchema, markNotificationsReadSchema, notificationPreferencesSchema, type ExpenseCategory } from "@venture-studio/contracts";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { can, isTrustedPushEndpoint, STARTABLE_TASK_STATUSES } from "@venture-studio/core";
import { listVisibleNotifications } from "../notification-visibility.js";

const defaultPreferences = { email: false, webPush: true, mentions: true, messages: true, assignments: true, reminders: true, payments: true };
// Expense notices (upcoming payments) reach a Claude connection only when its key has expenses ticked, and never those about salaries
// or EMIs (the inbox's own check, told it's Claude); without the tick they are neither shown to Claude nor marked read by it.
const channelFilter = (req: Express.Request): Record<string, unknown> => (req.interfaceChannel === "api" || req.mcpScopes?.has("expenses:read") ? {} : { resourceType: { $ne: "expense" } });
const viaClaude = (req: Express.Request) => req.interfaceChannel !== "api";
/** What Claude may mark read: never an expense notice it can't see (all without the tick; salaries' and EMIs' with it). */
async function readableByChannel(db: AppDb, req: Express.Request, workspaceId: string): Promise<Record<string, unknown>> {
  if (!viaClaude(req)) return {};
  if (!req.mcpScopes?.has("expenses:read")) return { resourceType: { $ne: "expense" } };
  const settings = await db.collection("expense_settings").findOne({ _id: workspaceId as never });
  const restricted = ((Array.isArray(settings?.categories) ? settings.categories : DEFAULT_EXPENSE_CATEGORIES) as ExpenseCategory[]).filter((category) => category.restricted).map((category) => category.id);
  const hidden = restricted.length ? (await db.collection("expenses").find({ workspaceId, categoryId: { $in: restricted } }).project({ _id: 1 }).toArray()).map((expense) => String(expense._id)) : [];
  return hidden.length ? { $nor: [{ resourceType: "expense", resourceId: { $in: hidden } }] } : {};
}
const subscriptionSchema = z.object({ endpoint: z.url().refine(isTrustedPushEndpoint, "Unsupported push service endpoint").transform((value) => new URL(value).href), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) });
const subscriptionEndpointSchema = subscriptionSchema.pick({ endpoint: true });

type Actor = NonNullable<Express.Request["actor"]>;

/**
 * Marks the task "Start:" reminders this person can act on from the inbox: the task is theirs, not started, waiting in accepted or to
 * do, and theirs to change now (role, venture and group, not archived). Starting it is what stops the reminder. Two small reads.
 */
async function withStartable(db: AppDb, actor: Actor, items: Record<string, any>[]) {
  const rows = items.filter((item) => item.type === "reminder" && item.resourceType === "task" && item.reminderId);
  if (!rows.length) return items;
  const workspaceId = actor.membership.workspaceId;
  const [reminders, tasks] = await Promise.all([
    db.collection("reminders").find({ _id: { $in: [...new Set(rows.map((item) => String(item.reminderId)))] }, workspaceId, userId: actor.id, $or: [{ kind: "task_start" }, { kind: { $exists: false }, repeatMinutes: 10 }] }).project({ _id: 1 }).toArray(),
    db.collection("tasks").find({ _id: { $in: [...new Set(rows.map((item) => String(item.resourceId)))] }, workspaceId, assigneeId: actor.id, status: { $in: STARTABLE_TASK_STATUSES }, startedAt: null, completedAt: null }).project({ _id: 1, ventureId: 1, groupId: 1 }).toArray(),
  ]);
  const startReminders = new Set(reminders.map((reminder) => String(reminder._id)));
  const waitingTasks = new Set(tasks.filter((task) => can(actor.membership as Parameters<typeof can>[0], "task:update", { ventureId: String(task.ventureId), groupId: String(task.groupId) })).map((task) => String(task._id)));
  return items.map((item) => rows.includes(item) && startReminders.has(String(item.reminderId)) && waitingTasks.has(String(item.resourceId)) ? { ...item, startable: true } : item);
}

export function notificationRoutes(db: AppDb, vapidPublicKey?: string): Router {
  const router = Router();
  router.get("/push-config", (_req, res) => {
    res.json({ ok: true, data: vapidPublicKey ? { available: true, publicKey: vapidPublicKey } : { available: false } });
  });
  router.get("/notifications", async (req, res) => {
    const actor = req.actor!;
    res.json({ ok: true, data: jsonValue(await withStartable(db, actor, await listVisibleNotifications(db, actor, channelFilter(req), 100, false, viaClaude(req)))) });
  });
  // One notice, under the inbox's visibility rules: the browser's notification worker reads it to show who wrote what,
  // so a push never carries message text and a browser signed in as someone else only gets a generic alert.
  router.get("/notifications/:id", async (req, res) => {
    const actor = req.actor!;
    const [item] = await listVisibleNotifications(db, actor, { _id: idSchema.parse(req.params.id), ...channelFilter(req) }, 1, false, viaClaude(req));
    if (!item) throw new AppError(404, "NOT_FOUND", "Notification not found");
    res.json({ ok: true, data: jsonValue(item) });
  });
  // Every time a stacked reminder rang (the inbox shows only how many times).
  router.get("/notifications/:id/history", async (req, res) => {
    const actor = req.actor!;
    const [item] = await listVisibleNotifications(db, actor, { _id: idSchema.parse(req.params.id) }, 1, true);
    if (!item) throw new AppError(404, "NOT_FOUND", "Notification not found");
    const rungAt: Date[] = Array.isArray(item.rungAt) && item.rungAt.length ? item.rungAt : [item.createdAt];
    res.json({ ok: true, data: jsonValue({ _id: item._id, repeats: Number(item.repeats ?? 1), firstAt: item.firstAt ?? rungAt.at(-1), rungAt }) });
  });
  // Removes a notice from this person's inbox (swiped away). It is kept, not deleted: a reminder that rings again comes back on top
  // with its whole history, and removing never stops a reminder (snooze or cancel does that).
  router.post("/notifications/:id/dismiss", async (req, res) => {
    const actor = req.actor!;
    const result = await db.collection("notifications").updateOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { dismissedAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "Notification not found");
    res.json({ ok: true, data: { dismissed: true } });
  });
  router.post("/notifications/read", async (req, res) => {
    const actor = req.actor!;
    const { chatKind, chatId } = markNotificationsReadSchema.parse(req.body ?? {});
    const result = await db.collection("notifications").updateMany({ workspaceId: actor.membership.workspaceId, userId: actor.id, readAt: { $exists: false }, ...(chatKind ? { chatKind, chatId } : {}), ...await readableByChannel(db, req, actor.membership.workspaceId) }, { $set: { readAt: new Date() } });
    res.json({ ok: true, data: { read: result.modifiedCount } });
  });
  router.post("/notifications/:id/read", async (req, res) => {
    const actor = req.actor!;
    const result = await db.collection("notifications").updateOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId, userId: actor.id, ...await readableByChannel(db, req, actor.membership.workspaceId) }, { $set: { readAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "Notification not found");
    res.json({ ok: true, data: { read: true } });
  });
  router.get("/notification-preferences", async (req, res) => {
    const actor = req.actor!;
    const stored = await db.collection("notification_preferences").findOne({ workspaceId: actor.membership.workspaceId, userId: actor.id });
    res.json({ ok: true, data: notificationPreferencesSchema.parse({ ...defaultPreferences, ...stored }) });
  });
  router.put("/notification-preferences", async (req, res) => {
    const actor = req.actor!; const preferences = notificationPreferencesSchema.parse(req.body);
    await db.collection("notification_preferences").updateOne({ workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { ...preferences, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ ok: true, data: preferences });
  });
  router.post("/push-subscriptions", async (req, res) => {
    const actor = req.actor!; const subscription = subscriptionSchema.parse(req.body);
    // A browser endpoint is one device, not one account; re-registration transfers ownership.
    const collection = db.collection("push_subscriptions");
    const update = { $set: { ...subscription, workspaceId: actor.membership.workspaceId, userId: actor.id, active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } };
    try { await collection.updateOne({ endpoint: subscription.endpoint }, update, { upsert: true }); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const retry = await collection.updateOne({ endpoint: subscription.endpoint }, { $set: update.$set });
      if (!retry.matchedCount) throw error;
    }
    res.status(201).json({ ok: true, data: { subscribed: true } });
  });
  router.delete("/push-subscriptions", async (req, res) => {
    const actor = req.actor!; const { endpoint } = subscriptionEndpointSchema.parse(req.body);
    await db.collection("push_subscriptions").updateOne({ workspaceId: actor.membership.workspaceId, userId: actor.id, endpoint }, { $set: { active: false, updatedAt: new Date() } });
    res.json({ ok: true, data: { unsubscribed: true } });
  });
  return router;
}
