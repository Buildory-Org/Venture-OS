import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// The expense tracker (docs/expenses.md): what the studio spends, in rupees, charged to a venture, the Office or Personal, each in a
// category and optionally a group (e.g. "AI subscriptions"). An expense is one-time, or repeats monthly or yearly from its first date
// until the month it stops. Who may see, add or manage expenses is the tracker's own access list; restricted categories (salary, EMI)
// are seen only by the people allowed to. Only amounts and labels are kept: no bank, card or account numbers.

export const EXPENSE_ACCESS_LEVELS = ["none", "view", "edit", "manage"] as const;
export const expenseAccessLevelSchema = z.enum(EXPENSE_ACCESS_LEVELS);
export type ExpenseAccessLevel = z.infer<typeof expenseAccessLevelSchema>;
/** True when `level` allows at least `needed` (none < view < edit < manage). */
export const expenseAccessAtLeast = (level: ExpenseAccessLevel, needed: ExpenseAccessLevel) => EXPENSE_ACCESS_LEVELS.indexOf(level) >= EXPENSE_ACCESS_LEVELS.indexOf(needed);

export const EXPENSE_REPEATS = ["none", "monthly", "yearly"] as const;
export const expenseRepeatSchema = z.enum(EXPENSE_REPEATS);
export type ExpenseRepeat = z.infer<typeof expenseRepeatSchema>;
export const EXPENSE_SCOPES = ["venture", "office", "personal"] as const;
export const EXPENSE_COLORS = ["green", "blue", "amber", "red", "purple", "neutral"] as const;
export const expenseColorSchema = z.enum(EXPENSE_COLORS);

/** A calendar day, YYYY-MM-DD. */
export const expenseDaySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "A date is YYYY-MM-DD").refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Not a real date");
/** A calendar month, YYYY-MM. */
export const expenseMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A month is YYYY-MM");
/** At most ₹1,000 crore, in paise. */
export const MAX_EXPENSE_PAISE = 10_000_000_000_00;

/** A run of 9 or more digits (spaces, dots and dashes between them allowed) reads like an account, card or phone number: never kept. */
export const LONG_NUMBER = /\d(?:[\s.-]?\d){8,}/;
const label = (max: number, what: string) => z.string().trim().max(max).refine((value) => !LONG_NUMBER.test(value), `${what} can't hold account, card or other long numbers`);

export const expenseScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("venture"), ventureId: idSchema }),
  z.object({ kind: z.literal("office") }),
  z.object({ kind: z.literal("personal") }),
]);
export type ExpenseScope = z.infer<typeof expenseScopeSchema>;

const expenseFields = {
  /** The day it was (or first is) paid. A repeating expense recurs on this day of the month. */
  date: expenseDaySchema,
  amountPaise: z.number().int().positive("An amount is more than zero").max(MAX_EXPENSE_PAISE, "That amount is too large"),
  categoryId: idSchema,
  groupId: idSchema.nullable(),
  paidTo: label(120, "Paid to").pipe(z.string().min(1, "Say who it was paid to")),
  scope: expenseScopeSchema,
  repeat: expenseRepeatSchema,
  /** The last month a repeating expense is paid (included); none while it keeps repeating. */
  endMonth: expenseMonthSchema.nullable(),
  note: label(1_000, "A note"),
};
export const expenseInputSchema = z.object({ ...expenseFields, groupId: expenseFields.groupId.default(null), repeat: expenseFields.repeat.default("none"), endMonth: expenseFields.endMonth.default(null), note: expenseFields.note.default("") });
export type ExpenseInput = z.infer<typeof expenseInputSchema>;
/** An edit: only the fields sent change (no defaults, so leaving a field out never resets it). */
export const expenseUpdateSchema = z.object(expenseFields).partial().refine((value) => Object.keys(value).length > 0, "Nothing to change");
/** A new amount (or other details) from a month on: the expense stops the month before and a copy starts that month, so past months keep what was paid. */
export const expenseChangeSchema = z.object({ fromMonth: expenseMonthSchema, amountPaise: expenseInputSchema.shape.amountPaise, paidTo: expenseInputSchema.shape.paidTo.optional(), note: expenseInputSchema.shape.note.optional() });

export const expenseSchema = z.object({
  id: idSchema, workspaceId: idSchema, date: expenseDaySchema, amountPaise: z.number().int(), categoryId: idSchema, groupId: idSchema.nullable(),
  paidTo: z.string(), scope: expenseScopeSchema, repeat: expenseRepeatSchema, endMonth: expenseMonthSchema.nullable(), note: z.string(),
  /** Set on the copy that "a new amount from a month" made: the expense it continues. */
  continuesId: idSchema.optional(),
  createdBy: idSchema, updatedBy: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export type Expense = z.infer<typeof expenseSchema>;

export const expenseCategorySchema = z.object({ id: idSchema, name: z.string(), color: expenseColorSchema, restricted: z.boolean(), archived: z.boolean() });
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;
const categoryFields = { name: z.string().trim().min(1).max(60), color: expenseColorSchema, restricted: z.boolean() };
export const expenseCategoryInputSchema = z.object({ ...categoryFields, color: categoryFields.color.default("neutral"), restricted: categoryFields.restricted.default(false) });
export const expenseCategoryUpdateSchema = z.object({ ...categoryFields, archived: z.boolean() }).partial().refine((value) => Object.keys(value).length > 0, "Nothing to change");
export const expenseGroupSchema = z.object({ id: idSchema, name: z.string(), color: expenseColorSchema, note: z.string(), archived: z.boolean() });
export type ExpenseGroup = z.infer<typeof expenseGroupSchema>;
const groupFields = { name: z.string().trim().min(1).max(60), color: expenseColorSchema, note: label(300, "A note") };
export const expenseGroupInputSchema = z.object({ ...groupFields, color: groupFields.color.default("neutral"), note: groupFields.note.default("") });
export const expenseGroupUpdateSchema = z.object({ ...groupFields, archived: z.boolean() }).partial().refine((value) => Object.keys(value).length > 0, "Nothing to change");

/** One person's access: their level, and whether they see restricted categories. */
export const expenseAccessSchema = z.object({ level: expenseAccessLevelSchema, restricted: z.boolean() });
export type ExpenseAccess = z.infer<typeof expenseAccessSchema>;
export const expenseAccessInputSchema = expenseAccessSchema;
/** A member on the access list: `custom` when someone set their access (else it is the default for their role). */
export const expenseMemberAccessSchema = expenseAccessSchema.extend({ userId: idSchema, name: z.string(), role: z.string(), custom: z.boolean() });
export type ExpenseMemberAccess = z.infer<typeof expenseMemberAccessSchema>;

/** GET /v1/expenses/settings: my access, the categories and groups I may use, and (for managers) everyone's access. */
export const expenseSettingsSchema = z.object({
  me: expenseAccessSchema, categories: z.array(expenseCategorySchema), groups: z.array(expenseGroupSchema),
  access: z.array(expenseMemberAccessSchema).optional(),
  /** Restricted categories exist that I can't see: totals I see leave them out. */
  hiddenRestricted: z.boolean(),
});
export type ExpenseSettings = z.infer<typeof expenseSettingsSchema>;
export const expenseListSchema = z.object({ items: z.array(expenseSchema), hiddenRestricted: z.boolean() });

// ---- Months and occurrences (shared by the API's checks and the screens) -------------------------------------------------------

export const monthOf = (day: string) => day.slice(0, 7);
/** The month `count` months after `month` (before, when negative). */
export function addMonths(month: string, count: number): string {
  const [year, index] = [Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + count];
  const date = new Date(Date.UTC(year, index, 1));
  return date.toISOString().slice(0, 7);
}
/** Every month from `from` to `to`, both included (at most 120). */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from; month <= to && months.length < 120; month = addMonths(month, 1)) months.push(month);
  return months;
}
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** The day an expense is paid in `month`, or null when it isn't paid that month (a repeat lands on the month's last day when it is shorter). */
export function occurrenceIn(expense: Pick<Expense, "date" | "repeat" | "endMonth">, month: string): string | null {
  const start = monthOf(expense.date);
  if (month < start) return null;
  if (expense.repeat === "none") return month === start ? expense.date : null;
  if (expense.endMonth && month > expense.endMonth) return null;
  if (expense.repeat === "yearly" && month.slice(5, 7) !== start.slice(5, 7)) return null;
  const day = Math.min(Number(expense.date.slice(8, 10)), daysIn(month));
  return `${month}-${String(day).padStart(2, "0")}`;
}
/** What an expense costs a month on average: a yearly one is spread over 12. One-time expenses have none. */
export const monthlyEquivalentPaise = (expense: Pick<Expense, "amountPaise" | "repeat">) => expense.repeat === "monthly" ? expense.amountPaise : expense.repeat === "yearly" ? Math.round(expense.amountPaise / 12) : 0;
/** The next day a repeating expense is paid on or after `today` (YYYY-MM-DD), or null once it has stopped. */
export function nextOccurrence(expense: Pick<Expense, "date" | "repeat" | "endMonth">, today: string): string | null {
  if (expense.repeat === "none") return expense.date >= today ? expense.date : null;
  let month = monthOf(today) < monthOf(expense.date) ? monthOf(expense.date) : monthOf(today);
  for (let step = 0; step < 24; step++, month = addMonths(month, 1)) {
    const day = occurrenceIn(expense, month);
    if (day && day >= today) return day;
    if (expense.endMonth && month >= expense.endMonth) return null;
  }
  return null;
}
/** "₹1,23,456.50" (Indian grouping; paise only when there are any). */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
