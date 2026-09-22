export const REMINDER_REPEAT_MINUTES = 10 as const;
export type Snooze = 10 | 20 | 30 | "never";

export function hasDeadlineRisk(dueAt: string | Date, estimatedMinutes: number, now = new Date()): boolean {
  return new Date(dueAt).getTime() - now.getTime() <= estimatedMinutes * 60_000;
}

export function nextReminder(at: string | Date, minutes = REMINDER_REPEAT_MINUTES): Date {
  return new Date(new Date(at).getTime() + minutes * 60_000);
}

export function snoozeReminder(now: Date, minutes: Snooze): Date | null {
  return minutes === "never" ? null : new Date(now.getTime() + minutes * 60_000);
}

export function retryAt(attempt: number, now = new Date()): Date {
  const delayMinutes = Math.min(2 ** Math.max(0, attempt - 1), 60);
  return new Date(now.getTime() + delayMinutes * 60_000);
}
