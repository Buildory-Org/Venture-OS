import webpush from "web-push";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { WorkerConfig } from "./config.js";

export class Delivery {
  readonly mode: "local" | "live";
  constructor(private readonly db: Db, private readonly config: WorkerConfig) {
    this.mode = config.RESEND_API_KEY || (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) ? "live" : "local";
    if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  }
  async send(item: Record<string, any>): Promise<void> {
    const user = await this.db.collection("users").findOne({ _id: item.userId, workspaceId: item.workspaceId, status: "active" });
    if (!user) throw new Error("Notification user is inactive");
    const preferences = await this.db.collection("notification_preferences").findOne({ workspaceId: item.workspaceId, userId: item.userId }) ?? { email: true, webPush: true, mentions: true, messages: true, assignments: true, reminders: true };
    const category = item.type === "mention" ? "mentions" : item.type === "message" ? "messages" : item.type === "assignment" || item.type === "deadline_warning" ? "assignments" : "reminders";
    if (preferences[category] === false) {
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.categorySkippedAt": new Date() } });
      return;
    }
    if (!item.delivery?.inAppAt) {
      await this.db.collection("notifications").updateOne({ outboxId: item._id }, { $setOnInsert: { _id: item._id, outboxId: item._id, workspaceId: item.workspaceId, userId: item.userId, type: item.type, title: item.title, body: item.body, resourceType: item.resourceType, resourceId: item.resourceId, ...(item.reminderId ? { reminderId: item.reminderId } : {}), createdAt: new Date() } }, { upsert: true });
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
        const endpointKey = createHash("sha256").update(String(subscription.endpoint)).digest("hex");
        if (item.delivery?.push?.[endpointKey]) continue;
        await webpush.sendNotification({ endpoint: subscription.endpoint, expirationTime: subscription.expirationTime, keys: subscription.keys }, JSON.stringify({ notificationId: item._id, title: item.title, body: item.body, resourceType: item.resourceType, resourceId: item.resourceId, ...(item.reminderId ? { reminderId: item.reminderId } : {}) }), { topic: createHash("sha256").update(String(item._id)).digest("base64url").slice(0, 32) });
        await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { [`delivery.push.${endpointKey}`]: new Date() } });
      }
    }
  }
}
