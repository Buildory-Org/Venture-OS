import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { retryAt } from "@venture-studio/core";
import type { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { reminderTransition } from "./rules.js";

export class Worker {
  private readonly delivery: Delivery;
  constructor(private readonly client: MongoClient, private readonly db: Db, private readonly config: WorkerConfig, private readonly transactions: boolean) { this.delivery = new Delivery(db, config); }
  async tick(now = new Date()): Promise<boolean> {
    const reminder = await this.claim("reminders", { $or: [{ state: "scheduled", scheduledAt: { $lte: now }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] }, { state: "claimed", leaseUntil: { $lte: now } }] }, now);
    if (reminder) { await this.processReminder(reminder, now); return true; }
    const outbox = await this.claim("notification_outbox", { $or: [{ state: "pending", nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] }, { state: "claimed", leaseUntil: { $lte: now } }] }, now);
    if (outbox) { await this.processOutbox(outbox, now); return true; }
    return false;
  }
  private async claim(collection: string, filter: Record<string, unknown>, now: Date) {
    return this.db.collection(collection).findOneAndUpdate(filter, { $set: { state: "claimed", claimedBy: this.config.WORKER_ID, leaseUntil: new Date(now.getTime() + 60_000), updatedAt: now } }, { sort: collection === "reminders" ? { scheduledAt: 1 } : { nextAttemptAt: 1 }, returnDocument: "after" });
  }
  private async transaction(work: (session?: import("mongodb").ClientSession) => Promise<void>): Promise<void> {
    if (!this.transactions) return work();
    await this.client.withSession((session) => session.withTransaction(() => work(session)));
  }
  private async processReminder(reminder: Record<string, any>, now: Date): Promise<void> {
    await this.transaction(async (session) => {
      const task = reminder.taskId ? await this.db.collection("tasks").findOne({ _id: reminder.taskId, workspaceId: reminder.workspaceId }, { session }) : null;
      const taskState = task ? { startedAt: task.startedAt as Date | undefined, completedAt: task.completedAt as Date | undefined, status: task.status as string | undefined } : null;
      const transition = reminderTransition({ repeatMinutes: reminder.repeatMinutes as number | null, sequence: Number(reminder.sequence) }, taskState, now);
      const updated = await this.db.collection("reminders").updateOne({ _id: reminder._id, state: "claimed", claimedBy: this.config.WORKER_ID }, { $set: { state: transition.state, completionReason: transition.state === "completed" ? transition.reason : undefined, sequence: transition.nextSequence, ...(transition.nextAt ? { scheduledAt: transition.nextAt } : {}), updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
      if (!updated.matchedCount || !transition.shouldDeliver) return;
      const key = `reminder:${reminder._id}:${reminder.sequence}`;
      await this.db.collection("notification_outbox").updateOne({ idempotencyKey: key }, { $setOnInsert: { _id: randomUUID(), workspaceId: reminder.workspaceId, userId: reminder.userId, type: "reminder", title: "Reminder", body: reminder.message, resourceType: reminder.taskId ? "task" : "reminder", resourceId: reminder.taskId ?? reminder._id, reminderId: reminder._id, idempotencyKey: key, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now } }, { upsert: true, session });
    });
  }
  private async processOutbox(item: Record<string, any>, now: Date): Promise<void> {
    try {
      await this.delivery.send(item);
      await this.db.collection("notification_outbox").updateOne({ _id: item._id, claimedBy: this.config.WORKER_ID }, { $set: { state: "delivered", deliveredAt: new Date(), adapter: this.delivery.mode, updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "", lastError: "" } });
    } catch (error) {
      const attempts = Number(item.attempts ?? 0) + 1;
      await this.db.collection("notification_outbox").updateOne({ _id: item._id, claimedBy: this.config.WORKER_ID }, { $set: { state: attempts >= 8 ? "dead" : "pending", attempts, nextAttemptAt: retryAt(attempts, now), lastError: error instanceof Error ? error.message.slice(0, 500) : "Unknown delivery error", updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "" } });
    }
  }
}
