import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db.js";
import { idSchema } from "@venture-studio/contracts";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";

const preferencesSchema = z.object({ email: z.boolean(), webPush: z.boolean(), mentions: z.boolean(), messages: z.boolean().default(true), assignments: z.boolean(), reminders: z.boolean() });
const subscriptionSchema = z.object({ endpoint: z.url(), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) });

export function notificationRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/notifications", async (req, res) => {
    const actor = req.actor!;
    const items = await db.collection("notifications").find({ workspaceId: actor.membership.workspaceId, userId: actor.id }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ ok: true, data: jsonValue(items) });
  });
  router.post("/notifications/:id/read", async (req, res) => {
    const actor = req.actor!;
    const result = await db.collection("notifications").updateOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { readAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "Notification not found");
    res.json({ ok: true, data: { read: true } });
  });
  router.put("/notification-preferences", async (req, res) => {
    const actor = req.actor!; const preferences = preferencesSchema.parse(req.body);
    await db.collection("notification_preferences").updateOne({ workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { ...preferences, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ ok: true, data: preferences });
  });
  router.post("/push-subscriptions", async (req, res) => {
    const actor = req.actor!; const subscription = subscriptionSchema.parse(req.body);
    await db.collection("push_subscriptions").updateOne({ workspaceId: actor.membership.workspaceId, userId: actor.id, endpoint: subscription.endpoint }, { $set: { ...subscription, active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.status(201).json({ ok: true, data: { subscribed: true } });
  });
  return router;
}
