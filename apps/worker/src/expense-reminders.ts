import { createHash, randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { currencyDigits, DEFAULT_EXPENSE_CATEGORIES, expenseAccessFor, expenseDueNoticeAt, indiaDay, monthOf, nextOccurrence, occurrenceIn, type ExpenseCategory } from "@venture-studio/contracts";

// Upcoming payments (docs/expenses.md#upcoming-payments): a heads-up three days before each payment of a repeating expense, at 10:00
// India time, to everyone who manages expenses (restricted ones only to those who see restricted categories). One reminder per expense
// and manager (kind "expense_due"), planned by the worker from the expenses every few minutes, so edits, stops, deletions and access
// changes are followed without the API doing anything; each sends its notice and moves on to the next payment. Its id is stable, and
// the notices take it as their reminderId, so the inbox stacks every month's heads-up for one subscription into one row.

type Transaction = (work: (session?: ClientSession) => Promise<void>) => Promise<void>;
const KIND = "expense_due";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const expenseReminderId = (expenseId: string, userId: string) => sha(`expense-due|${expenseId}|${userId}`).slice(0, 40);
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

type Expense = Record<string, any>;
/**
 * The next payment to give notice of: on or after today, after the last one noticed, and not one whose notice time had passed when the
 * expense was saved (a subscription recorded on the day it was paid, or a new price starting in two days, needs no heads-up).
 */
function nextDue(expense: Expense, today: string, deliveredFor: string | undefined) {
  const repeating = { date: String(expense.date), repeat: expense.repeat, endMonth: expense.endMonth ?? null, anchorDay: expense.anchorDay };
  const created = expense.createdAt instanceof Date ? expense.createdAt : null;
  let due = nextOccurrence(repeating, deliveredFor && dayAfter(deliveredFor) > today ? dayAfter(deliveredFor) : today);
  for (let step = 0; due && created && expenseDueNoticeAt(due) <= created && step < 24; step++) due = nextOccurrence(repeating, dayAfter(due));
  return due;
}
/** When its notice goes: three days before at 10:00 IST, or now when that has passed (a subscription added two days before). */
const noticeAt = (day: string, now: Date) => { const at = expenseDueNoticeAt(day); return at < now ? now : at; };

/** Who manages a workspace's expenses (or, given `userId`, whether that one person does), with whether they see restricted categories (active members only). */
async function managersOf(db: Db, workspaceId: string, settings: Record<string, any> | null, session?: ClientSession, userId?: string) {
  const memberships = await db.collection("memberships").find({ workspaceId, status: "active", ...(userId ? { userId } : {}) }, { session }).project({ userId: 1, role: 1 }).toArray();
  const active = new Set((await db.collection("users").find({ _id: { $in: memberships.map((item) => item.userId) }, status: "active" }, { session }).project({ _id: 1 }).toArray()).map((user) => String(user._id)));
  return memberships.filter((item) => active.has(String(item.userId))).map((item) => ({ userId: String(item.userId), ...expenseAccessFor((settings?.access ?? {}) as never, String(item.userId), String(item.role)) })).filter((person) => person.level === "manage");
}
const restrictedIds = (settings: Record<string, any> | null) => ((Array.isArray(settings?.categories) ? settings!.categories : DEFAULT_EXPENSE_CATEGORIES) as ExpenseCategory[]).filter((category) => category.restricted).map((category) => category.id);

/**
 * Brings every workspace's upcoming-payment reminders in line with its expenses and managers: one for each repeating expense still
 * running and each manager allowed to see it, set for its next payment's notice; any other is cancelled. A reminder being sent is left
 * alone. Safe to repeat and to run on several workers (ids are stable; writes are conditional). Returns how many it changed.
 */
export async function planExpenseReminders(db: Db, now: Date): Promise<number> {
  const today = indiaDay(now);
  let changed = 0;
  for (const settings of await db.collection("expense_settings").find({}).project({ access: 1, categories: 1 }).toArray()) {
    const workspaceId = String(settings._id);
    // One workspace's bad data never stops the others' planning.
    try { changed += await planWorkspace(db, workspaceId, settings, today, now); }
    catch (error) { console.error(JSON.stringify({ level: "error", event: "worker.expense_plan.workspace_failed", workspaceId, error: error instanceof Error ? error.message : "unknown" })); }
  }
  return changed;
}

async function planWorkspace(db: Db, workspaceId: string, settings: Record<string, any>, today: string, now: Date): Promise<number> {
  let changed = 0;
  const managers = await managersOf(db, workspaceId, settings);
  const hidden = restrictedIds(settings);
  // `endMonth: null` matches a missing one too.
  const expenses = await db.collection("expenses").find({ workspaceId, repeat: { $in: ["monthly", "yearly"] }, $or: [{ endMonth: null }, { endMonth: { $gte: today.slice(0, 7) } }] }).project({ date: 1, repeat: 1, endMonth: 1, anchorDay: 1, categoryId: 1, createdAt: 1 }).toArray();
  const existing = new Map((await db.collection("reminders").find({ workspaceId, kind: KIND }).project({ state: 1, occurrenceDay: 1, deliveredFor: 1 }).toArray()).map((doc) => [String(doc._id), doc]));
  const wanted = new Set<string>();
  for (const expense of expenses) for (const manager of managers) {
    if (hidden.includes(String(expense.categoryId)) && !manager.restricted) continue;
    const id = expenseReminderId(String(expense._id), manager.userId);
    const current = existing.get(id);
    const due = nextDue(expense, today, current?.deliveredFor as string | undefined);
    if (!due) continue;
    wanted.add(id);
    if (current?.state === "claimed") continue;
    const scheduledAt = noticeAt(due, now);
    if (current?.state === "scheduled" && current.occurrenceDay === due) continue;
    const result = await db.collection("reminders").updateOne({ _id: id as never, state: { $ne: "claimed" } }, {
      $set: { workspaceId, userId: manager.userId, kind: KIND, expenseId: String(expense._id), occurrenceDay: due, scheduledAt, state: "scheduled", repeatMinutes: null, message: "", updatedAt: now },
      $setOnInsert: { sequence: 0, createdAt: now },
      $unset: { leaseUntil: "", claimedBy: "", cancelReason: "", completionReason: "" },
    }, { upsert: true }).catch((error: unknown) => { if ((error as { code?: number }).code === 11000) return null; throw error; });
    if (result?.modifiedCount || result?.upsertedCount) changed++;
  }
  for (const [id, doc] of existing) if (!wanted.has(id) && doc.state === "scheduled") {
    const result = await db.collection("reminders").updateOne({ _id: id as never, state: "scheduled" }, { $set: { state: "cancelled", cancelReason: "expense_stopped_or_no_access", updatedAt: now } });
    changed += result.modifiedCount;
  }
  return changed;
}

/** "₹1,700", "$20.00", "¥1,500" from an amount in a currency's smallest unit. */
function money(minor: number, currency: string) {
  const digits = currencyDigits(currency);
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, minimumFractionDigits: minor % 10 ** digits ? digits : 0, maximumFractionDigits: digits }).format(minor / 10 ** digits);
}
/** "Anthropic: $20 due on Thu 5 Nov (about ₹1,902)", "GoDaddy: ₹1,700 due tomorrow, Fri 6 Nov". */
async function noticeText(db: Db, expense: Expense, day: string, today: string, restricted: boolean) {
  const when = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const due = days <= 0 ? `due today, ${when}` : days === 1 ? `due tomorrow, ${when}` : `due on ${when}`;
  // A salary or EMI: no amount (the notice may show on a lock screen or in an e-mail); the expense shows it to those allowed.
  if (restricted) return `${expense.paidTo}: payment ${due}`;
  const foreign = expense.foreign as { currency: string; amountMinor: number } | null | undefined;
  if (!foreign) return `${expense.paidTo}: ${money(Number(expense.amountPaise), "INR")} ${due}`;
  // About how much in rupees, at the latest kept reference rate when it is recent (the payment converts at its own day's rate).
  const latest = await db.collection("exchange_rates").find({ _id: { $gte: new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10) } as never }).sort({ _id: -1 }).limit(1).next();
  const rates = (latest?.rates ?? {}) as Record<string, number>;
  const rupees = rates.INR && rates[foreign.currency] ? Math.round((foreign.amountMinor / 10 ** currencyDigits(foreign.currency)) * (rates.INR / rates[foreign.currency]!) * 100) : null;
  return `${expense.paidTo}: ${money(foreign.amountMinor, foreign.currency)} ${due}${rupees ? ` (about ${money(rupees, "INR")})` : ""}`;
}

/**
 * Sends one upcoming-payment notice, checked again first: the expense still repeats and is paid that day, the person still manages
 * expenses and may see its category, and the day hasn't passed. Then the reminder moves on to the next payment (or ends). The notice and
 * the move happen together; its idempotency key is per reminder and payment day, so a retry never sends it twice.
 */
export async function processExpenseReminder(db: Db, reminder: Record<string, any>, now: Date, workerId: string, transaction: Transaction): Promise<void> {
  await transaction(async (session) => {
    const own = { _id: reminder._id, state: "claimed", claimedBy: workerId };
    const release = { $unset: { leaseUntil: "", claimedBy: "" } };
    const end = (state: "cancelled" | "completed", reason: string) => db.collection("reminders").updateOne(own, { $set: { state, [state === "cancelled" ? "cancelReason" : "completionReason"]: reason, updatedAt: now }, ...release }, { session });
    const today = indiaDay(now);
    const expense = await db.collection("expenses").findOne({ _id: reminder.expenseId, workspaceId: reminder.workspaceId }, { session });
    if (!expense || !["monthly", "yearly"].includes(String(expense.repeat))) { await end("cancelled", "expense_gone"); return; }
    const settings = await db.collection("expense_settings").findOne({ _id: reminder.workspaceId }, { session });
    const [manager] = await managersOf(db, String(reminder.workspaceId), settings, session, String(reminder.userId));
    if (!manager || (restrictedIds(settings).includes(String(expense.categoryId)) && !manager.restricted)) { await end("cancelled", "no_access"); return; }
    const day = String(reminder.occurrenceDay);
    const repeating = { date: String(expense.date), repeat: expense.repeat, endMonth: expense.endMonth ?? null, anchorDay: expense.anchorDay };
    // Changed meanwhile (a new date, a last month), or a day already gone by (the worker was away): on to the next payment instead.
    if (day < today || occurrenceIn(repeating, monthOf(day)) !== day) {
      const next = nextDue(expense, today, reminder.deliveredFor as string | undefined);
      if (!next) { await end("completed", "stopped"); return; }
      await db.collection("reminders").updateOne(own, { $set: { state: "scheduled", occurrenceDay: next, scheduledAt: noticeAt(next, now), updatedAt: now }, ...release }, { session });
      return;
    }
    const next = nextDue(expense, today, day);
    const moved = await db.collection("reminders").updateOne(own, next
      ? { $set: { state: "scheduled", deliveredFor: day, occurrenceDay: next, scheduledAt: noticeAt(next, now), updatedAt: now }, $inc: { sequence: 1 }, ...release }
      : { $set: { state: "completed", completionReason: "delivered", deliveredFor: day, updatedAt: now }, $inc: { sequence: 1 }, ...release }, { session });
    if (!moved.matchedCount) return;
    const key = `expense-due:${reminder._id}:${day}`;
    await db.collection("notification_outbox").updateOne({ idempotencyKey: key }, { $setOnInsert: {
      _id: randomUUID(), workspaceId: reminder.workspaceId, userId: reminder.userId, type: "expense_due", title: "Payment due", body: await noticeText(db, expense, day, today, restrictedIds(settings).includes(String(expense.categoryId))),
      resourceType: "expense", resourceId: String(expense._id), reminderId: reminder._id, idempotencyKey: key, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    } }, { upsert: true, session });
  });
}
