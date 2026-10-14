import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// The expense tracker (docs/expenses.md): what the studio spends, in rupees, charged to a venture, the Office or Personal, each in a
// category and optionally a group (e.g. "AI subscriptions"). An expense is one-time, or repeats monthly or yearly from its first date
// until the month it stops. Who may see, add or manage expenses is the tracker's own access list; restricted categories (salary, EMI)
// are seen only by the people allowed to. Only amounts and labels are kept: no bank, card or account numbers. An expense may keep its
// receipt: a small copy of the photo or the PDF, and what was read off it (card numbers cut to their last four digits).

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

/** A calendar day, YYYY-MM-DD, in 2000–2099. */
export const expenseDaySchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "A date is YYYY-MM-DD, from 2000 to 2099").refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Not a real date");
/** A calendar month, YYYY-MM, in 2000–2099. */
export const expenseMonthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, "A month is YYYY-MM, from 2000 to 2099");
/** At most ₹1,000 crore, in paise. */
export const MAX_EXPENSE_PAISE = 10_000_000_000_00;

/**
 * What reads like an account, card or phone number, never kept: 9 or more digits in a row; a card's groups of four (4111 1111 1111 1111,
 * with spaces, dashes, dots, slashes or underscores between); a phone number in two groups of five (98270 12345) or three groups
 * (982-701-2345). Dates, times and invoice numbers such as 2026-10-14 20:02 or INV-2026-10-00123 are fine.
 */
export const LONG_NUMBER = /\d{9,}|\d{4}[\s./_-]+\d{4}[\s./_-]+\d{4}|\d{5}[\s./_-]+\d{5}|\d{3,5}[\s.-]\d{3,4}[\s.-]\d{3,4}/;
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
  /** The receipt kept with it (uploaded first, attached when the expense is saved), or none. */
  receiptId: idSchema.nullable(),
};
/** A brand-new company's website, given when its first expense is saved (for its logo); not kept on the expense. */
const companyWebsite = z.string().trim().max(300).optional();
export const expenseInputSchema = z.object({ ...expenseFields, groupId: expenseFields.groupId.default(null), repeat: expenseFields.repeat.default("none"), endMonth: expenseFields.endMonth.default(null), note: expenseFields.note.default(""), receiptId: expenseFields.receiptId.default(null), companyWebsite });
export type ExpenseInput = z.infer<typeof expenseInputSchema>;
/** An edit: only the fields sent change (no defaults, so leaving a field out never resets it). */
/** The version an edit was made from (the expense's updatedAt as loaded): a change saved meanwhile refuses the edit instead of being undone. */
const expectedUpdatedAt = isoDateSchema.optional();
export const expenseUpdateSchema = z.object({ ...expenseFields, expectedUpdatedAt, companyWebsite }).partial().refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"), "Nothing to change");
/** A new amount (or other details) from a month on: the expense stops the month before and a copy starts that month, so past months keep what was paid. */
export const expenseChangeSchema = z.object({ fromMonth: expenseMonthSchema, amountPaise: expenseFields.amountPaise, paidTo: expenseFields.paidTo.optional(), note: expenseFields.note.optional(), expectedUpdatedAt });

export const expenseSchema = z.object({
  id: idSchema, workspaceId: idSchema, date: expenseDaySchema, amountPaise: z.number().int(), categoryId: idSchema, groupId: idSchema.nullable(),
  paidTo: z.string(), scope: expenseScopeSchema, repeat: expenseRepeatSchema, endMonth: expenseMonthSchema.nullable(), note: z.string(),
  /** Set on the copy that "a new amount from a month" made: the expense it continues. */
  continuesId: idSchema.optional(),
  /** The day of the month it repeats on, when that differs from `date`'s day (a copy that starts in a shorter month): the 31st stays the 31st. */
  anchorDay: z.number().int().min(1).max(31).optional(),
  receiptId: idSchema.nullable().optional(),
  /** The company it was paid to (grouped by name, GSTIN or website; see companyKey). */
  companyId: idSchema.optional(),
  createdBy: idSchema, updatedBy: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export type Expense = z.infer<typeof expenseSchema>;

export const expenseCategorySchema = z.object({ id: idSchema, name: z.string(), color: expenseColorSchema, restricted: z.boolean(), archived: z.boolean() });
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;
const categoryFields = { name: label(60, "A name").pipe(z.string().min(1, "Give it a name")), color: expenseColorSchema, restricted: z.boolean() };
export const expenseCategoryInputSchema = z.object({ ...categoryFields, color: categoryFields.color.default("neutral"), restricted: categoryFields.restricted.default(false) });
export const expenseCategoryUpdateSchema = z.object({ ...categoryFields, archived: z.boolean() }).partial().refine((value) => Object.keys(value).length > 0, "Nothing to change");
export const expenseGroupSchema = z.object({ id: idSchema, name: z.string(), color: expenseColorSchema, note: z.string(), archived: z.boolean() });
export type ExpenseGroup = z.infer<typeof expenseGroupSchema>;
const groupFields = { name: label(60, "A name").pipe(z.string().min(1, "Give it a name")), color: expenseColorSchema, note: label(300, "A note") };
export const expenseGroupInputSchema = z.object({ ...groupFields, color: groupFields.color.default("neutral"), note: groupFields.note.default("") });
export const expenseGroupUpdateSchema = z.object({ ...groupFields, archived: z.boolean() }).partial().refine((value) => Object.keys(value).length > 0, "Nothing to change");

// ---- Receipts ---------------------------------------------------------------------------------------------------------------

export const RECEIPT_KINDS = ["receipt", "tax_invoice", "invoice", "bill", "other"] as const;
export const RECEIPT_PAYMENT_METHODS = ["cash", "card", "upi", "bank_transfer", "wallet", "other", "unknown"] as const;
/** What was read off a receipt, as printed: amounts in the receipt's own currency (not paise), null where it doesn't say. */
export const receiptDataSchema = z.object({
  kind: z.enum(RECEIPT_KINDS),
  merchant: z.string().nullable(), merchantAddress: z.string().nullable(), merchantPhone: z.string().nullable(),
  /** GSTIN, VAT or other tax registration number. */
  merchantTaxId: z.string().nullable(),
  /** The receipt, bill or invoice number. */
  number: z.string().nullable(),
  /** The merchant's website or e-mail domain, as printed (godaddy.com); none on receipts read before it was added. */
  website: z.string().nullable().default(null),
  date: expenseDaySchema.nullable(), time: z.string().nullable(), billedTo: z.string().nullable(),
  /** ISO 4217, such as INR or USD. */
  currency: z.string().nullable(),
  items: z.array(z.object({ name: z.string(), quantity: z.number().nullable(), unitPrice: z.number().nullable(), amount: z.number().nullable() })),
  subtotal: z.number().nullable(), discount: z.number().nullable(),
  taxes: z.array(z.object({ label: z.string(), ratePercent: z.number().nullable(), amount: z.number() })),
  /** Tip or service charge. */
  tip: z.number().nullable(),
  /** A rounding line ("Round off -0.50"), with its sign; none on receipts read before it was added. */
  roundOff: z.number().nullable().default(null),
  total: z.number().nullable(),
  paymentMethod: z.enum(RECEIPT_PAYMENT_METHODS), cardLast4: z.string().nullable(), footer: z.string().nullable(),
  /** The category it most likely belongs to, among those the uploader may use. */
  categoryId: idSchema.nullable(),
});
export type ReceiptData = z.infer<typeof receiptDataSchema>;
/** A receipt: its kept copy (a WebP of the photo, or the PDF), what was read off it, or why it couldn't be read. */
export const expenseReceiptSchema = z.object({
  id: idSchema, contentType: z.enum(["image/webp", "application/pdf"]), size: z.number().int(),
  data: receiptDataSchema.nullable(), error: z.string().optional(), expenseId: idSchema.optional(), createdAt: isoDateSchema,
});
export type ExpenseReceipt = z.infer<typeof expenseReceiptSchema>;
/** The largest receipt file accepted: a photo or a PDF. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

// ---- Companies ---------------------------------------------------------------------------------------------------------------

/** Legal words at the end of a name, left out when comparing ("GoDaddy.com, LLC" and "GODADDY INDIA" are one company). */
const LEGAL_WORDS = new Set(["private", "pvt", "limited", "ltd", "llp", "llc", "inc", "incorporated", "corp", "corporation", "co", "company", "plc", "gmbh", "pbc", "pte", "india"]);
/** The company part of a "Paid to": notes in brackets left out ("GoDaddy (buildory.dev)" → "GoDaddy"). */
export function companyName(paidTo: string): string {
  return paidTo.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() || paidTo.trim();
}
/**
 * The key two spellings of one company share: notes in brackets, accents on Latin letters, web endings (.com, .in…), punctuation and
 * spaces dropped, and legal words at the end left out ("Go Daddy", "GoDaddy.com, LLC", "GODADDY INDIA" and "GoDaddy (buildory.dev)" are
 * all "godaddy"). Names in any script keep their letters (Hindi, Tamil…), so they never fall together.
 */
export function companyKey(name: string): string {
  const words = companyName(name).normalize("NFKD").toLowerCase().replace(/(?<=[a-z])\p{M}+/gu, "").replace(/&/g, " and ")
    .replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\.(com|co\.in|in|io|co|net|org|ai|app|dev)(?=[^\p{L}\p{N}]|$)/gu, " ")
    .split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  while (words.length > 1 && LEGAL_WORDS.has(words.at(-1)!)) words.pop();
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join("").slice(0, 120) || name.trim().toLowerCase().slice(0, 120) || "unnamed";
}
/** Mail and payment services many companies share (an e-mail at gmail.com or "Powered by Razorpay" says nothing about who was paid). */
const SHARED_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "zohomail.com", "zohomail.in", "rediffmail.com", "mail.com", "gmx.com", "yandex.com",
  "razorpay.com", "rzp.io", "paytm.com", "phonepe.com", "instamojo.com", "stripe.com", "paypal.com", "cashfree.com", "payu.in", "ccavenue.com", "billdesk.com", "chargebee.com", "paddle.com", "fastspring.com"]);
/** True for a mail or payment service's domain, which never identifies a company on its own. */
export const isSharedDomain = (host: string) => SHARED_DOMAINS.has(host);
/** A website or e-mail address as a plain host name (https://www.GoDaddy.com/in → godaddy.com; billing@godaddy.com → godaddy.com), or null. */
export function websiteHost(raw: string | null | undefined): string | null {
  const text = raw?.trim().toLowerCase();
  if (!text) return null;
  let host = "";
  if (/^[^\s/@]+@[^\s/@]+$/.test(text)) host = text.split("@")[1]!;
  else { try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname; } catch { return null; } }
  const bare = host.replace(/^www\./, "").replace(/\.$/, "");
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(bare) ? bare : null;
}
/** A company expenses were paid to: what a person sees of it (only companies with an expense they can see). */
export const expenseCompanySchema = z.object({
  id: idSchema, name: z.string(), website: z.string().nullable(), gstin: z.string().nullable(),
  /** The logo's version (so a changed logo is fetched afresh), or null: the company shows its initial. */
  logo: z.string().nullable(),
  /** The spellings seen for it (as companyKey), so a typed name can be matched to it. */
  keys: z.array(z.string()),
  /** How many of its expenses the person can see. */
  expenses: z.number().int(),
});
export type ExpenseCompany = z.infer<typeof expenseCompanySchema>;
export const expenseCompanyUpdateSchema = z.object({ name: label(120, "A name").pipe(z.string().min(1, "Give it a name")), website: z.string().trim().max(300).nullable() }).partial().refine((value) => Object.keys(value).length > 0, "Nothing to change");
export const expenseCompanyMergeSchema = z.object({ into: idSchema });
/** The largest logo image accepted (it is kept as a 128 px WebP). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

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
  /** The companies with an expense I can see, by name. */
  companies: z.array(expenseCompanySchema).default([]),
});
export type ExpenseSettings = z.infer<typeof expenseSettingsSchema>;
/** `truncated` when there were more than the list returns (the oldest left out): totals would be short. */
export const expenseListSchema = z.object({ items: z.array(expenseSchema), hiddenRestricted: z.boolean(), truncated: z.boolean().default(false) });

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

type Repeating = Pick<Expense, "date" | "repeat" | "endMonth"> & { anchorDay?: number | undefined };
/** The day an expense is paid in `month`, or null when it isn't paid that month (a repeat lands on the month's last day when it is shorter). */
export function occurrenceIn(expense: Repeating, month: string): string | null {
  const start = monthOf(expense.date);
  if (month < start) return null;
  if (expense.repeat === "none") return month === start ? expense.date : null;
  if (expense.endMonth && month > expense.endMonth) return null;
  if (expense.repeat === "yearly" && month.slice(5, 7) !== start.slice(5, 7)) return null;
  const day = Math.min(expense.anchorDay ?? Number(expense.date.slice(8, 10)), daysIn(month));
  return `${month}-${String(day).padStart(2, "0")}`;
}
/** What an expense costs a month on average: a yearly one is spread over 12. One-time expenses have none. */
export const monthlyEquivalentPaise = (expense: Pick<Expense, "amountPaise" | "repeat">) => expense.repeat === "monthly" ? expense.amountPaise : expense.repeat === "yearly" ? Math.round(expense.amountPaise / 12) : 0;
/** The next day a repeating expense is paid on or after `today` (YYYY-MM-DD), or null once it has stopped. */
export function nextOccurrence(expense: Repeating, today: string): string | null {
  if (expense.repeat === "none") return expense.date >= today ? expense.date : null;
  let month = monthOf(today) < monthOf(expense.date) ? monthOf(expense.date) : monthOf(today);
  for (let step = 0; step < 24; step++, month = addMonths(month, 1)) {
    const day = occurrenceIn(expense, month);
    if (day && day >= today) return day;
    if (expense.endMonth && month >= expense.endMonth) return null;
  }
  return null;
}
/** The first month after `month` that a repeating expense is paid in (for "a new amount from"), or null when it has stopped by then. */
export function nextPaidMonthAfter(expense: Repeating, month: string): string | null {
  for (let next = addMonths(month, 1), step = 0; step < 24; step++, next = addMonths(next, 1)) {
    if (expense.endMonth && next > expense.endMonth) return null;
    if (occurrenceIn(expense, next)) return next;
  }
  return null;
}
/** "₹1,23,456.50" (Indian grouping; paise only when there are any). */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
