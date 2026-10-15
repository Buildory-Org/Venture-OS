export const REMINDER_REPEAT_MINUTES = 10 as const;
export type Snooze = 10 | 20 | 30 | "never";

export function hasDeadlineRisk(dueAt: string | Date, estimatedMinutes: number, now = new Date()): boolean {
  return new Date(dueAt).getTime() - now.getTime() <= estimatedMinutes * 60_000;
}

export function nextReminder(at: string | Date, minutes = REMINDER_REPEAT_MINUTES): Date {
  return new Date(new Date(at).getTime() + minutes * 60_000);
}

/**
 * A "Start:" reminder rings again only while the task waits to be started: proposed (every new task), accepted or to do. In review,
 * blocked, parked, backlog or draft it stays quiet.
 */
export const NAGGING_TASK_STATUSES: readonly string[] = ["proposed", "accepted", "todo"];
/** The inbox's Start button moves a task straight to in progress from these (a proposed task is accepted first, in the task). */
export const STARTABLE_TASK_STATUSES: readonly string[] = ["accepted", "todo"];

/** How many ring times a stacked notification keeps (its count keeps going past them). */
export const STACK_RINGS_KEPT = 100;
export type RingRow = { createdAt: Date; rungAt?: Date[]; repeats?: number; firstAt?: Date };
/**
 * Several inbox rows of one reminder as one: their ring times (newest first, each once, at most STACK_RINGS_KEPT), how many times it
 * rang in all, and when it first rang. A row from before stacking counts as one ring, at the time it arrived.
 */
export function mergeRings(rows: RingRow[]) {
  const times = new Map<number, Date>();
  for (const row of rows) for (const at of row.rungAt?.length ? row.rungAt : [row.createdAt]) times.set(new Date(at).getTime(), new Date(at));
  const rungAt = [...times.values()].sort((a, b) => b.getTime() - a.getTime()).slice(0, STACK_RINGS_KEPT);
  const repeats = rows.reduce((sum, row) => sum + Math.max(1, Number(row.repeats ?? 1)), 0);
  const firstAt = new Date(Math.min(...rows.map((row) => new Date(row.firstAt ?? row.rungAt?.at(-1) ?? row.createdAt).getTime())));
  return { rungAt, repeats, firstAt };
}
/** One row per reminder in the inbox: a new ring takes over the rows before it, their ring times and count carried over. */
export function stackRings(firedAt: Date, earlier: RingRow[]) {
  return mergeRings([{ createdAt: firedAt }, ...earlier]);
}

/**
 * Postpone a reminder by `minutes` from the later of now and its next ring. A future reminder never moves earlier, and one that has
 * just rung (its next ring already one repeat away) is put off that much more: "10 min" right after a ring means 20 minutes of quiet.
 */
export function snoozeReminder(now: Date, minutes: Snooze, scheduledAt?: Date | string): Date | null {
  if (minutes === "never") return null;
  const current = scheduledAt ? new Date(scheduledAt).getTime() : Number.NaN;
  const base = Number.isFinite(current) && current > now.getTime() ? current : now.getTime();
  return new Date(base + minutes * 60_000);
}

export function retryAt(attempt: number, now = new Date()): Date {
  const delayMinutes = Math.min(2 ** Math.max(0, attempt - 1), 60);
  return new Date(now.getTime() + delayMinutes * 60_000);
}
