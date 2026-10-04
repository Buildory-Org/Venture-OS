import webpush from "web-push";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { WorkerConfig } from "./config.js";
import { isTrustedPushEndpoint } from "@venture-studio/core";

export class Delivery {
  readonly mode: "local" | "live";
  constructor(private readonly db: Db, private readonly config: WorkerConfig) {
    this.mode = config.RESEND_API_KEY || (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) ? "live" : "local";
    if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  }
  async send(item: Record<string, any>): Promise<void> {
    const user = await this.db.collection("users").findOne({ _id: item.userId, workspaceId: item.workspaceId, status: "active" });
    if (!user) throw new Error("Notification user is inactive");
    const legacyMessage = !item.chatKind && item.resourceType === "message" ? await this.db.collection("messages").findOne({ _id: item.resourceId, workspaceId: item.workspaceId }) : null;
    if (!item.chatKind && item.resourceType === "message" && !legacyMessage) {
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.scopeSkippedAt": new Date() } });
      return;
    }
    const channelId = item.chatKind === "channel" ? item.chatId : legacyMessage?.channelId;
    if (channelId) {
      const channel = await this.db.collection("channels").findOne({ _id: channelId, workspaceId: item.workspaceId });
      const membership = await this.db.collection("memberships").findOne({ workspaceId: item.workspaceId, userId: item.userId, status: "active" });
      if (!channel || !membership || (membership.role !== "admin" && (!membership.ventureIds?.includes(String(channel.ventureId)) || !membership.groupIds?.includes(String(channel.groupId))))) {
        await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.scopeSkippedAt": new Date() } });
        return;
      }
    }
    const storedPreferences = await this.db.collection("notification_preferences").findOne({ workspaceId: item.workspaceId, userId: item.userId });
    const preferences = { email: false, webPush: true, mentions: true, messages: true, assignments: true, reminders: true, ...storedPreferences };
    const category = item.type === "mention" ? "mentions" : item.type === "message" ? "messages" : item.type === "assignment" || item.type === "deadline_warning" ? "assignments" : "reminders";
    if (preferences[category] === false) {
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.categorySkippedAt": new Date() } });
      return;
    }
    if (!item.delivery?.inAppAt) {
      await this.db.collection("notifications").updateOne({ outboxId: item._id }, { $setOnInsert: { _id: item._id, outboxId: item._id, workspaceId: item.workspaceId, userId: item.userId, type: item.type, title: item.title, body: item.body, resourceType: item.resourceType, resourceId: item.resourceId, ...(item.chatKind && item.chatId ? { chatKind: item.chatKind, chatId: item.chatId } : {}), ...(item.reminderId ? { reminderId: item.reminderId } : {}), createdAt: new Date() } }, { upsert: true });
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.inAppAt": new Date() } });
    }
    if (this.mode === "local") { console.info(JSON.stringify({ level: "info", adapter: "local", event: "notification", outboxId: item._id, userId: item.userId, type: item.type })); return; }
    if (this.config.RESEND_API_KEY && preferences.email && user.email && !item.delivery?.emailAt) {
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${this.config.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `vso-${item._id}` }, body: JSON.stringify({ from: this.config.EMAIL_FROM, to: user.email, subject: item.title, text: item.body }) });
      if (!response.ok) throw new Error(`Resend delivery failed: ${response.status}`);
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.emailAt": new Date() } });
    }
    if (this.config.VAPID_PUBLIC_KEY && this.config.VAPID_PRIVATE_KEY && preferences.webPush) {
      const subscriptions = await this.db.collection("push_subscriptions").find({ workspaceId: item.workspaceId, userId: item.userId, active: true }).toArray();
      for (const subscription of subscriptions) {
        if (!isTrustedPushEndpoint(String(subscription.endpoint))) {
          await this.db.collection("push_subscriptions").updateOne({ _id: subscription._id, workspaceId: item.workspaceId, userId: item.userId }, { $set: { active: false, invalidEndpointAt: new Date() } });
          continue;
        }
        // Best-effort ownership fence before the external send; an in-flight send cannot be recalled.
        const current = await this.db.collection("push_subscriptions").findOne({ _id: subscription._id, workspaceId: item.workspaceId, userId: item.userId, endpoint: subscription.endpoint, active: true });
        if (!current) continue;
        const endpointKey = createHash("sha256").update(String(subscription.endpoint)).digest("hex");
        if (item.delivery?.push?.[endpointKey]) continue;
        try {
          // Push can race a shared-browser account switch. Keep private details in the authenticated inbox.
          await webpush.sendNotification({ endpoint: current.endpoint, expirationTime: current.expirationTime, keys: current.keys }, JSON.stringify({ notificationId: item._id, ...(item.chatKind && item.chatId ? { chat: { kind: item.chatKind, id: item.chatId } } : {}) }), { topic: createHash("sha256").update(String(item._id)).digest("base64url").slice(0, 32) });
        } catch (error) {
          if (![404, 410].includes(Number((error as { statusCode?: number }).statusCode))) throw error;
          await this.db.collection("push_subscriptions").updateOne({ _id: subscription._id, workspaceId: item.workspaceId, userId: item.userId, endpoint: current.endpoint, keys: current.keys, active: true }, { $set: { active: false, expiredAt: new Date() } });
          continue;
        }
        await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { [`delivery.push.${endpointKey}`]: new Date() } });
      }
    }
  }
}
