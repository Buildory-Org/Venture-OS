import { NAGGING_TASK_STATUSES } from "@venture-studio/core";

export function reminderTransition(reminder: { repeatMinutes: number | null; sequence: number }, task: { startedAt?: Date; completedAt?: Date; status?: string } | null, now: Date) {
  if (task?.startedAt || task?.completedAt || task?.status === "done" || task?.status === "cancelled") return { state: "completed" as const, reason: "task_terminal" as const, shouldDeliver: false, nextAt: null, nextSequence: reminder.sequence };
  // A repeating "Start:" reminder only rings while the task waits to be started (proposed, accepted, to do). In review, blocked,
  // parked and the like it stays quiet and looks again a repeat later, so it rings again if the task goes back to to do.
  if (reminder.repeatMinutes && task?.status && !NAGGING_TASK_STATUSES.includes(task.status)) return { state: "scheduled" as const, reason: "waiting" as const, shouldDeliver: false, nextAt: new Date(now.getTime() + reminder.repeatMinutes * 60_000), nextSequence: reminder.sequence };
  if (reminder.repeatMinutes) return { state: "scheduled" as const, reason: "repeating" as const, shouldDeliver: true, nextAt: new Date(now.getTime() + reminder.repeatMinutes * 60_000), nextSequence: reminder.sequence + 1 };
  return { state: "completed" as const, reason: "delivered" as const, shouldDeliver: true, nextAt: null, nextSequence: reminder.sequence };
}
