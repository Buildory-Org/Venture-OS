import { z } from "zod";
import {
  addMonths, currencyDigits, EXPENSE_CURRENCIES, expenseConverter, expenseHasTag, expenseTagKey, expenseTagsIn, expenseTagsSchema, expenseCurrencySchema, formatMoneyIn, indiaDay, monthOf, monthsBetween, nextOccurrence, occurrenceIn,
  type Expense, type ExpenseCategory, type ExpenseCompany, type ExpenseGroup, type ExpenseRates, type ExpenseScope,
} from "@venture-studio/contracts";
import { clip, compact, ToolError, UNTRUSTED_NOTE } from "./format.js";
import { id, type Look, once, READ_ONLY, type Register, requestIdField, type ToolContext, writes } from "./kit.js";

// The expense tracker through Claude (docs/expenses.md#claude): reports, lists, subscriptions, and adding, changing, repricing and
// deleting expenses, for keys with Expenses ticked. Every call goes through the tracker's own routes as the key's owner, so their
// access list applies (view reads, edit changes), and the routes never show salaries or EMIs (restricted categories) to Claude.
// The access list, categories, companies and receipt files stay in the app.

type Settings = { me: { level: string }; categories: ExpenseCategory[]; groups: ExpenseGroup[]; companies: ExpenseCompany[]; hiddenRestricted: boolean };
type Row = { expense: Expense; day: string };
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DAY = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const monthField = z.string().regex(MONTH, "A month is YYYY-MM");
const currencyField = expenseCurrencySchema.default("INR").describe("Show amounts in this currency (each payment at the European Central Bank rate of its day); INR by default");
const whereField = z.string().trim().min(1).max(120).describe('"Office", "Personal", or a venture (its name, or its id when two share a name)');
const tagField = z.string().trim().min(1).max(60).describe("A tag (who or what an expense was for, e.g. a person's name); any case");
const tagsField = z.array(z.string().trim().min(1).max(60)).max(10).describe("Tags: who or what it was for (a person's name, an event, a project), up to 10, of up to 30 characters, no commas");
const nameOrId = (what: string) => z.string().trim().min(1).max(120).describe(`A ${what}: its name or id`);
const RESTRICTED_NOTE = "Salaries and EMIs (restricted categories) are never shown or counted through Claude: see them in the app.";
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

/** An amount typed in a currency's units (12.5 dollars) in its smallest unit (1250 cents); refused with more decimals than it has. */
function minorOf(amount: number, currency: string): number {
  const digits = currencyDigits(currency);
  const minor = Math.round(amount * 10 ** digits);
  if (minor <= 0 || Number(amount.toFixed(digits)) !== amount) throw new ToolError(`${currency} amounts have ${digits ? `at most ${digits} decimals` : "no decimals"}: ${amount} won't do.`);
  return minor;
}

export function registerExpenseTools(tool: Register, ctx: ToolContext, look: Look): void {
  const link = (expenseId: string) => `${ctx.origin}/expenses/live?expense=${encodeURIComponent(expenseId)}`;
  const settingsOf = () => ctx.api<Settings>("GET", "/expenses/settings");
  const expensesOf = () => ctx.api<{ items: Expense[]; hiddenRestricted: boolean; truncated: boolean }>("GET", "/expenses");
  /** The rates a set of expenses needs to be shown in `currency` (none when everything is in rupees and shown in rupees). */
  async function ratesFor(items: Expense[], currency: string): Promise<{ rates: ExpenseRates | null; failed: boolean }> {
    const currencies = new Set(items.filter((item) => item.foreign && item.repeat !== "none" && !item.chargedPaise).map((item) => item.foreign!.currency));
    if (currency !== "INR") currencies.add(currency);
    if (!currencies.size) return { rates: null, failed: false };
    const today = indiaDay(new Date());
    const floor = new Date(Date.parse(`${today}T00:00:00Z`) - 1_090 * 86_400_000).toISOString().slice(0, 10);
    const earliest = items.reduce((first, item) => (item.date < first ? item.date : first), today);
    const params = new URLSearchParams({ from: earliest < floor ? floor : earliest, to: today, currencies: [...currencies].sort().join(",") });
    return ctx.api<ExpenseRates>("GET", `/expenses/rates?${params}`).then((rates) => ({ rates, failed: false }), () => ({ rates: null, failed: true }));
  }
  async function ventureNames() {
    const { ventures } = await look.ventures();
    return ventures as Map<string, { name: string }>;
  }
  // A scope's key (two ventures never merge, even with one name) and its label (with the id when a name is shared or not listed).
  const whereKey = (scope: ExpenseScope) => (scope.kind === "venture" ? `venture:${scope.ventureId}` : scope.kind);
  function whereOf(scope: ExpenseScope, ventures: Map<string, { name: string }>) {
    if (scope.kind !== "venture") return scope.kind === "office" ? "Office" : "Personal";
    const name = ventures.get(scope.ventureId)?.name;
    if (!name) return `A venture no longer listed (${scope.ventureId})`;
    const shared = [...ventures.values()].filter((venture) => venture.name.trim().toLowerCase() === name.trim().toLowerCase()).length > 1;
    return shared ? `${name} (${scope.ventureId})` : name;
  }
  /** "Office", "Personal" or a venture's id or name (refused when two share it), as the scope an expense is charged to. */
  async function scopeOf(text: string): Promise<ExpenseScope> {
    const value = text.trim().toLowerCase();
    const ventures = await ventureNames();
    if (ventures.has(text.trim())) return { kind: "venture", ventureId: text.trim() };
    if (value === "office") return { kind: "office" };
    if (value === "personal") return { kind: "personal" };
    const named = [...ventures].filter(([, venture]) => venture.name.trim().toLowerCase() === value);
    if (named.length > 1) throw new ToolError(`More than one venture is called "${clip(text, 60)}": give its id instead (${named.map(([ventureId]) => ventureId).join(", ")}).`);
    if (named.length) return { kind: "venture", ventureId: named[0]![0] };
    throw new ToolError(`"${clip(text, 60)}" isn't Office, Personal or one of your ventures (list_ventures shows them).`);
  }
  const scopeMatches = async (text: string | undefined) => { if (!text) return () => true; const scope = await scopeOf(text); return (item: Expense) => item.scope.kind === scope.kind && (scope.kind !== "venture" || (item.scope.kind === "venture" && item.scope.ventureId === scope.ventureId)); };
  function pick<T extends { id: string; name: string }>(list: T[], text: string, what: string): T {
    const value = text.trim().toLowerCase();
    const found = list.find((item) => item.id === text.trim()) ?? list.find((item) => item.name.trim().toLowerCase() === value);
    if (!found) throw new ToolError(`No ${what} "${clip(text, 60)}"${what === "category" ? " (salaries and EMIs are never available through Claude)" : ""}: expense_options lists them.`);
    return found;
  }
  /** Expenses narrowed by the filters every read tool shares. */
  async function filtered(items: Expense[], settings: Settings, input: { where?: string; category?: string; group?: string; company?: string; kind?: "one-time" | "repeating"; tag?: string }) {
    const inWhere = await scopeMatches(input.where);
    const tag = input.tag === undefined ? undefined : expenseTagKey(input.tag);
    if (tag === "") throw new ToolError("Give a tag, like Rahul.");
    if (tag && !items.some((item) => expenseHasTag(item, tag))) throw new ToolError(`No expense has the tag "${clip(input.tag, 40)}": expense_options lists the tags in use.`);
    const category = input.category ? pick(settings.categories, input.category, "category").id : undefined;
    const group = input.group ? pick(settings.groups, input.group, "group").id : undefined;
    const company = input.company ? pick(settings.companies, input.company, "company").id : undefined;
    return items.filter((item) => inWhere(item) && (!category || item.categoryId === category) && (!group || item.groupId === group) && (!company || item.companyId === company)
      && (!tag || expenseHasTag(item, tag)) && (!input.kind || (input.kind === "one-time" ? item.repeat === "none" : item.repeat !== "none")));
  }
  const paidIn = (items: Expense[], month: string): Row[] => items.flatMap((expense) => { const day = occurrenceIn(expense, month); return day ? [{ expense, day }] : []; }).sort((a, b) => b.day.localeCompare(a.day));
  const notes = (settings: Settings, truncated: boolean, asked: string, shown: string, ratesFailed: boolean) => ({
    restricted: settings.hiddenRestricted ? RESTRICTED_NOTE : undefined,
    truncated: truncated ? "There are more expenses than can be read at once: the oldest are left out, so totals may be short." : undefined,
    rates: ratesFailed || shown !== asked ? `The exchange rates couldn't be fetched just now: amounts are in ${shown === asked ? shown : `rupees, not ${asked}`}, and repeating payments in other currencies count at their first payment's rupees. Say so, or try again shortly.`
      : shown !== "INR" ? "Converted at the European Central Bank reference rate of each payment's day; a payment made in that currency is exactly what was paid." : undefined,
  });
  /** What a foreign amount counts as in rupees, and how. */
  const countsAs = (expense: Expense) => !expense.foreign ? undefined : expense.chargedPaise ? `${formatMoneyIn(expense.amountPaise, "INR")} (what the bank charged)` : `${formatMoneyIn(expense.amountPaise, "INR")}${expense.rateDate ? ` at the ${dayLabel(expense.rateDate)} rate` : ""}${expense.repeat !== "none" ? "; later payments at their own day's rate" : ""}`;
  const paidAs = (expense: Expense) => formatMoneyIn(expense.foreign ? expense.foreign.amountMinor : expense.amountPaise, expense.foreign?.currency ?? "INR");

  // ---- Reading -------------------------------------------------------------------------------------------------------------------

  tool("expense_options", "expenses:read", {
    title: "Expense options", annotations: READ_ONLY,
    description: "What adding or filtering expenses can use: my access (view, edit or manage), the categories, groups, companies and tags in use, where an expense can be charged (Office, Personal, my ventures), and the currencies. Call it before add_expenses so names match.",
    inputSchema: z.object({}),
  }, async () => {
    const [settings, ventures, list] = await Promise.all([settingsOf(), ventureNames(), expensesOf()]);
    return compact({
      access: settings.me.level, canChange: settings.me.level === "edit" || settings.me.level === "manage",
      categories: settings.categories.filter((category) => !category.archived).map((category) => compact({ id: category.id, name: clip(category.name, 80) })),
      groups: settings.groups.filter((group) => !group.archived).map((group) => compact({ id: group.id, name: clip(group.name, 80), note: clip(group.note, 160) || undefined })),
      companies: [...settings.companies].sort((a, b) => (b.expenses ?? 0) - (a.expenses ?? 0)).slice(0, 150).map((company) => compact({ id: company.id, name: clip(company.name, 120), website: clip(company.website, 200), expenses: company.expenses })),
      moreCompanies: settings.companies.length > 150 ? `${settings.companies.length - 150} more, with fewer expenses: name them in a filter all the same` : undefined,
      tags: expenseTagsIn(list.items).sort((a, b) => b.expenses - a.expenses).slice(0, 100).map((tag) => ({ tag: clip(tag.tag, 30), expenses: tag.expenses })),
      moreTags: expenseTagsIn(list.items).length > 100 ? `${expenseTagsIn(list.items).length - 100} more, on fewer expenses: filter by them all the same` : undefined,
      chargeTo: ["Office", "Personal", ...[...ventures].map(([ventureId]) => whereOf({ kind: "venture", ventureId }, ventures))],
      currencies: [...EXPENSE_CURRENCIES], restricted: settings.hiddenRestricted ? RESTRICTED_NOTE : undefined, link: `${ctx.origin}/expenses/live`,
    });
  });

  tool("expense_report", "expenses:read", {
    title: "Expense report", annotations: READ_ONLY,
    description: "Spending for a month (the default, this month) or month by month over several: the total, repeating vs one-time, by where it was charged (Office, Personal, each venture), by category, by tag, the top companies, and the change from the month before. Narrow by where, category, group, company, tag or one-time/repeating; any currency. For what was spent on a person, filter by their tag.",
    inputSchema: z.object({
      month: monthField.optional().describe("YYYY-MM; this month (India time) by default"), months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).default(1).describe("1 for that month alone, or 3, 6 or 12 months up to it"),
      currency: currencyField, where: whereField.optional(), category: nameOrId("category").optional(), group: nameOrId("group").optional(), company: nameOrId("company").optional(), kind: z.enum(["one-time", "repeating"]).optional(), tag: tagField.optional(),
    }),
  }, async (input) => {
    const [settings, list, ventures] = await Promise.all([settingsOf(), expensesOf(), ventureNames()]);
    const items = await filtered(list.items, settings, input);
    const rates = await ratesFor(items, input.currency);
    const money = expenseConverter(input.currency, rates.rates, indiaDay(new Date()));
    const show = (minor: number) => formatMoneyIn(minor, money.currency);
    const last = input.month ?? indiaDay(new Date()).slice(0, 7);
    const span = monthsBetween(addMonths(last, 1 - input.months), last);
    const sum = (rows: Row[]) => rows.reduce((total, row) => total + money.value(row.expense, row.day), 0);
    const rowsBySpan = span.flatMap((month) => paidIn(items, month));
    const total = sum(rowsBySpan);
    // Totals per key, labelled afterwards: two ventures, categories or companies that share a name stay apart.
    const group = (rows: Row[], keyOf: (row: Row) => string, labelOf: (row: Row) => string) => {
      const totals = new Map<string, { label: string; value: number }>();
      for (const row of rows) { const key = keyOf(row); const entry = totals.get(key) ?? { label: labelOf(row), value: 0 }; entry.value += money.value(row.expense, row.day); totals.set(key, entry); }
      return [...totals.values()].sort((a, b) => b.value - a.value).map(({ label, value }) => [label, value] as const);
    };
    const byWhere = (rows: Row[]) => group(rows, (row) => whereKey(row.expense.scope), (row) => whereOf(row.expense.scope, ventures));
    const categoryName = (row: Row) => settings.categories.find((category) => category.id === row.expense.categoryId)?.name ?? "Other";
    const companyName = (row: Row) => settings.companies.find((company) => company.id === row.expense.companyId)?.name ?? row.expense.paidTo;
    // Per tag (an expense with two counts under both), spelled as most expenses spell it.
    const tagNames = new Map(expenseTagsIn(list.items).map((tag) => [tag.key, tag.tag]));
    const byTag = new Map<string, number>();
    for (const row of rowsBySpan) for (const key of new Set((row.expense.tags ?? []).map(expenseTagKey))) byTag.set(key, (byTag.get(key) ?? 0) + money.value(row.expense, row.day));
    const before = input.months === 1 ? sum(paidIn(items, addMonths(last, -1))) : null;
    return compact({
      period: input.months === 1 ? monthLabel(last) : `${monthLabel(span[0]!)} to ${monthLabel(last)}`, currency: money.currency,
      total: show(total), payments: rowsBySpan.length,
      repeating: show(sum(rowsBySpan.filter((row) => row.expense.repeat !== "none"))), oneTime: show(sum(rowsBySpan.filter((row) => row.expense.repeat === "none"))),
      vsMonthBefore: before ? `${total >= before ? "+" : ""}${Math.round(((total - before) / before) * 100)}% (${show(before)} in ${monthLabel(addMonths(last, -1))})` : undefined,
      perMonth: input.months > 1 ? span.map((month) => { const rows = paidIn(items, month); return { month: monthLabel(month), total: show(sum(rows)), byWhere: Object.fromEntries(byWhere(rows).map(([where, value]) => [where, show(value)])) }; }) : undefined,
      averagePerMonth: input.months > 1 ? show(Math.round(total / span.length)) : undefined,
      byWhere: byWhere(rowsBySpan).map(([where, value]) => ({ where, amount: show(value), share: percent(value, total) })),
      byCategory: group(rowsBySpan, (row) => row.expense.categoryId, categoryName).map(([category, value]) => ({ category, amount: show(value), share: percent(value, total) })),
      byTag: byTag.size ? [...byTag].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key, value]) => ({ tag: clip(tagNames.get(key) ?? key, 30), amount: show(value), share: percent(value, total) })) : undefined,
      tagNote: byTag.size > 1 ? "An expense with two tags counts under both, so tags can add up to more than the total." : undefined,
      topCompanies: group(rowsBySpan, (row) => row.expense.companyId ?? `paid:${row.expense.paidTo.trim().toLowerCase()}`, companyName).slice(0, 8).map(([company, value]) => ({ company: clip(company, 80), amount: show(value) })),
      ...notes(settings, list.truncated, input.currency, money.currency, rates.failed), note: rowsBySpan.length ? UNTRUSTED_NOTE : undefined,
      hint: rowsBySpan.length ? undefined : "Nothing was paid in this period with these filters.", link: `${ctx.origin}/expenses/live`,
    });
  });

  tool("list_expenses", "expenses:read", {
    title: "List expenses", annotations: READ_ONLY,
    description: "The expenses paid in a month (this month by default) or a span of months, newest first, each with its amount as paid and in the chosen currency; narrow by where, category, group, company, tag, one-time/repeating, or words in who it was paid to, its note or tags. With expenseId: that one expense in full, with what was read off its receipt.",
    inputSchema: z.object({
      expenseId: id.optional(), month: monthField.optional().describe("YYYY-MM (default this month); the last month of a span with fromMonth"), fromMonth: monthField.optional().describe("First month of a span (at most 24 months)"),
      where: whereField.optional(), category: nameOrId("category").optional(), group: nameOrId("group").optional(), company: nameOrId("company").optional(), kind: z.enum(["one-time", "repeating"]).optional(),
      tag: tagField.optional(), search: z.string().trim().min(2).max(80).optional().describe("Words in who it was paid to, its note or its tags"), currency: currencyField, limit: z.number().int().min(1).max(200).default(50),
    }),
  }, async (input) => {
    const [settings, ventures] = await Promise.all([settingsOf(), ventureNames()]);
    const categoryName = (categoryId: string) => settings.categories.find((category) => category.id === categoryId)?.name;
    const groupName = (groupId: string | null) => (groupId ? settings.groups.find((group) => group.id === groupId)?.name : undefined);
    const companyName = (companyId: string | undefined) => (companyId ? settings.companies.find((company) => company.id === companyId)?.name : undefined);
    if (input.expenseId) {
      const expense = await ctx.api<Expense>("GET", `/expenses/${encodeURIComponent(input.expenseId)}`);
      const receipt = expense.receiptId ? await ctx.api<{ data: Record<string, any> | null }>("GET", `/expenses/receipts/${encodeURIComponent(expense.receiptId)}`).catch(() => null) : null;
      const data = receipt?.data;
      // The expense a price change continued, only while it is one Claude may see (never a salary or EMI it was moved into since).
      const continues = expense.continuesId ? await ctx.api<Expense>("GET", `/expenses/${encodeURIComponent(expense.continuesId)}`).then((before) => before.id, () => undefined) : undefined;
      const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
      // Read off a photo or PDF by a model: text from outside, so cleaned and clipped like any other.
      const receiptOf = (read: Record<string, any>) => compact({
        merchant: clip(read.merchant, 120), number: clip(read.number, 60), date: clip(read.date, 20), currency: clip(read.currency, 3),
        items: Array.isArray(read.items) ? read.items.slice(0, 30).map((line: Record<string, unknown>) => compact({ name: clip(line?.name, 120), quantity: number(line?.quantity), unitPrice: number(line?.unitPrice), amount: number(line?.amount) })) : undefined,
        subtotal: number(read.subtotal), discount: number(read.discount), taxes: Array.isArray(read.taxes) ? read.taxes.slice(0, 10).map((tax: Record<string, unknown>) => compact({ label: clip(tax?.label, 60), ratePercent: number(tax?.ratePercent), amount: number(tax?.amount) })) : undefined,
        tip: number(read.tip), roundOff: number(read.roundOff), total: number(read.total), paidBy: clip(read.paymentMethod, 30), cardLast4: clip(read.cardLast4, 4),
      });
      return compact({
        id: expense.id, paidTo: clip(expense.paidTo, 120), company: companyName(expense.companyId), amount: paidAs(expense), countsAs: countsAs(expense),
        date: expense.date, repeats: expense.repeat === "none" ? "one-time" : expense.repeat, nextPayment: expense.repeat !== "none" ? nextOccurrence(expense, indiaDay(new Date())) ?? "stopped" : undefined, lastMonth: expense.endMonth ?? undefined,
        category: categoryName(expense.categoryId), group: groupName(expense.groupId), chargedTo: whereOf(expense.scope, ventures), note: clip(expense.note, 1000) || undefined, tags: expense.tags?.length ? expense.tags.map((tag) => clip(tag, 30)) : undefined,
        priceChangeOf: continues, updatedAt: expense.updatedAt,
        receipt: data ? receiptOf(data) : expense.receiptId ? "kept (couldn't be read)" : undefined,
        caution: UNTRUSTED_NOTE, link: link(expense.id),
      });
    }
    const list = await expensesOf();
    let items = await filtered(list.items, settings, input);
    if (input.search) { const words = input.search.toLowerCase(); items = items.filter((item) => item.paidTo.toLowerCase().includes(words) || item.note.toLowerCase().includes(words) || (item.tags ?? []).some((tag) => tag.toLowerCase().includes(words))); }
    const last = input.month ?? indiaDay(new Date()).slice(0, 7);
    const first = input.fromMonth ?? last;
    if (first > last) throw new ToolError("fromMonth comes before month.");
    const span = monthsBetween(first, last);
    if (span.length > 24) throw new ToolError("At most 24 months at a time.");
    const rates = await ratesFor(items, input.currency);
    const money = expenseConverter(input.currency, rates.rates, indiaDay(new Date()));
    const rows = span.flatMap((month) => paidIn(items, month)).sort((a, b) => b.day.localeCompare(a.day));
    const shown = rows.slice(0, input.limit);
    const total = rows.reduce((sum, row) => sum + money.value(row.expense, row.day), 0);
    return compact({
      period: span.length === 1 ? monthLabel(last) : `${monthLabel(first)} to ${monthLabel(last)}`, currency: money.currency, total: formatMoneyIn(total, money.currency), payments: rows.length,
      expenses: shown.map(({ expense, day }) => compact({
        expenseId: expense.id, day, paidTo: clip(expense.paidTo, 120), company: companyName(expense.companyId), amount: formatMoneyIn(money.value(expense, day), money.currency),
        paid: expense.foreign && expense.foreign.currency !== money.currency ? paidAs(expense) : undefined, category: categoryName(expense.categoryId), group: groupName(expense.groupId),
        chargedTo: whereOf(expense.scope, ventures), repeats: expense.repeat === "none" ? undefined : expense.repeat, tags: expense.tags?.length ? expense.tags.map((tag) => clip(tag, 30)) : undefined, receipt: expense.receiptId ? true : undefined, link: link(expense.id),
      })),
      more: rows.length > shown.length ? rows.length - shown.length : undefined, ...notes(settings, list.truncated, input.currency, money.currency, rates.failed), note: rows.length ? UNTRUSTED_NOTE : undefined,
      hint: rows.length ? undefined : "No expenses in this period with these filters.",
    });
  });

  tool("list_subscriptions", "expenses:read", {
    title: "List subscriptions", annotations: READ_ONLY,
    description: "Everything that repeats (monthly or yearly): what each costs a month and a year in the chosen currency, its next payment, and what's due in the next days; also ones starting later, and (on request) stopped ones.",
    inputSchema: z.object({ currency: currencyField, where: whereField.optional(), dueWithinDays: z.number().int().min(1).max(90).default(30), includeStopped: z.boolean().default(false) }),
  }, async (input) => {
    const [settings, list, ventures] = await Promise.all([settingsOf(), expensesOf(), ventureNames()]);
    const today = indiaDay(new Date());
    const thisMonth = today.slice(0, 7);
    const repeating = (await filtered(list.items, settings, { where: input.where })).filter((item) => item.repeat !== "none");
    const rates = await ratesFor(repeating, input.currency);
    const money = expenseConverter(input.currency, rates.rates, today);
    const show = (minor: number) => formatMoneyIn(minor, money.currency);
    // Priced at its next payment, or a stopped one at its last.
    const pricedOn = (expense: Expense) => nextOccurrence(expense, today) ?? (expense.endMonth ? occurrenceIn(expense, expense.endMonth) : null) ?? today;
    const perMonth = (expense: Expense) => { const value = money.value(expense, pricedOn(expense)); return expense.repeat === "yearly" ? Math.round(value / 12) : value; };
    const notEnded = repeating.filter((item) => !item.endMonth || item.endMonth >= thisMonth);
    const running = notEnded.filter((item) => monthOf(item.date) <= thisMonth);
    const row = (expense: Expense) => compact({
      expenseId: expense.id, paidTo: clip(expense.paidTo, 120), paid: paidAs(expense), repeats: expense.repeat, perMonth: show(perMonth(expense)),
      next: nextOccurrence(expense, today) ?? undefined, lastMonth: expense.endMonth ?? undefined, category: settings.categories.find((category) => category.id === expense.categoryId)?.name,
      group: expense.groupId ? settings.groups.find((group) => group.id === expense.groupId)?.name : undefined, chargedTo: whereOf(expense.scope, ventures), tags: expense.tags?.length ? expense.tags.map((tag) => clip(tag, 30)) : undefined, link: link(expense.id),
    });
    const monthly = running.reduce((sum, expense) => sum + perMonth(expense), 0);
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + input.dueWithinDays * 86_400_000).toISOString().slice(0, 10);
    const due = notEnded.map((expense) => ({ expense, next: nextOccurrence(expense, today) })).filter((item): item is { expense: Expense; next: string } => Boolean(item.next) && item.next! <= horizon).sort((a, b) => a.next.localeCompare(b.next));
    return compact({
      currency: money.currency, running: running.length, perMonth: show(monthly), perYear: show(monthly * 12),
      dueSoon: due.map(({ expense, next }) => ({ paidTo: clip(expense.paidTo, 120), day: next, amount: show(money.value(expense, next)), expenseId: expense.id })),
      subscriptions: running.sort((a, b) => perMonth(b) - perMonth(a)).map(row),
      startingLater: notEnded.filter((item) => monthOf(item.date) > thisMonth).map(row),
      stopped: input.includeStopped ? repeating.filter((item) => item.endMonth && item.endMonth < thisMonth).map(row) : undefined,
      ...notes(settings, list.truncated, input.currency, money.currency, rates.failed), note: repeating.length ? UNTRUSTED_NOTE : undefined, hint: repeating.length ? undefined : "Nothing repeats yet.",
    });
  });

  // ---- Changing --------------------------------------------------------------------------------------------------------------------

  const itemSchema = z.object({
    paidTo: z.string().trim().min(1).max(120).describe("Who it was paid to"), amount: z.number().positive().max(1e12).describe("In the currency's units, e.g. 1700 or 6.49"),
    currency: expenseCurrencySchema.default("INR"), chargedInr: z.number().positive().max(1e12).optional().describe("A one-time payment in another currency: what the bank charged in rupees, if known (counted exactly)"),
    date: z.string().regex(DAY, "A date is YYYY-MM-DD").optional().describe("The day paid (the first payment for a repeating one); today (India time) by default"),
    category: nameOrId("category"), group: nameOrId("group").optional(), newGroup: z.boolean().default(false).describe("Start the group named in group when there's none by that name"),
    chargedTo: whereField, repeat: z.enum(["none", "monthly", "yearly"]).default("none"), lastMonth: monthField.optional().describe("A repeating one's last month (YYYY-MM), if it stops"),
    note: z.string().trim().max(1000).optional(), tags: tagsField.optional(), website: z.string().trim().max(300).optional().describe("A company seen for the first time: its website, for its logo"),
  });
  const versionField = z.iso.datetime({ offset: true }).describe("The updatedAt that list_expenses (with expenseId) showed, so nothing changed since is overwritten");
  /** Refused when the expense changed after the person saw it: what they agreed to is no longer what's there. */
  function unchangedSince(current: Expense, expected: string | undefined) {
    if (expected && Date.parse(expected) !== Date.parse(current.updatedAt)) throw new ToolError(`This expense was changed since you read it (now ${paidAs(current)} to ${clip(current.paidTo, 80)}): read it again with list_expenses (expenseId) and check with the person before trying again.`, 409);
  }
  /** Tags as given, each spelled like a tag already in use when it matches one ("rahul" joins "Rahul"). */
  const spelled = (tags: string[], known: { key: string; tag: string }[]) => tags.map((tag) => known.find((one) => one.key === expenseTagKey(tag))?.tag ?? tag);
  const readExpense = (expenseId: string) => ctx.api<Expense>("GET", `/expenses/${encodeURIComponent(expenseId)}`);
  /** The rupee or foreign amount of an expense (in its currency's smallest unit), as the tracker takes it. */
  function amountFields(minor: number, currency: string, chargedPaise: number | null, repeat: string) {
    if (currency === "INR") { if (chargedPaise) throw new ToolError("chargedInr is for a payment in another currency."); return { amountPaise: minor, foreign: null, chargedPaise: null }; }
    if (chargedPaise && repeat !== "none") throw new ToolError("chargedInr goes with a one-time payment: a repeating one converts at each payment's rate.");
    return { foreign: { currency, amountMinor: minor }, chargedPaise };
  }
  const saved = (expense: Expense, ventures: Map<string, { name: string }>) => compact({ expenseId: expense.id, paidTo: clip(expense.paidTo, 120), amount: paidAs(expense), countsAs: countsAs(expense), date: expense.date, repeats: expense.repeat === "none" ? undefined : expense.repeat, lastMonth: expense.endMonth ?? undefined, chargedTo: whereOf(expense.scope, ventures), tags: expense.tags?.length ? expense.tags.map((tag) => clip(tag, 30)) : undefined, link: link(expense.id), updatedAt: expense.updatedAt });

  tool("add_expenses", "expenses:write", {
    title: "Add expenses", annotations: writes(false),
    description: "Record 1 to 25 expenses (one bill, a month's subscriptions, lines from a statement): who was paid, the amount in its currency (rupees by default), the day, category, where it's charged, and optionally a group, a repeat (monthly or yearly, with a last month), a note, tags (who or what it was for, e.g. the person something was bought for: reuse the spelling of tags in use), and for a one-time payment in another currency what the bank charged in rupees. Each comes back with what it counts as in rupees. Say what you're about to add, and read the result back. Names come from expense_options.",
    inputSchema: z.object({ expenses: z.array(itemSchema).min(1).max(25), requestId: requestIdField }),
  }, async (input) => {
    const anyTags = input.expenses.some((item: { tags?: string[] }) => item.tags?.length);
    const [settings, ventures, knownTags] = await Promise.all([settingsOf(), ventureNames(), anyTags ? expensesOf().then((list) => expenseTagsIn(list.items)) : [] as ReturnType<typeof expenseTagsIn>]);
    const today = indiaDay(new Date());
    return once(ctx, "add_expenses", input.requestId, input.expenses, async () => {
      const added: unknown[] = []; const failed: { item: number; paidTo?: string; error: string }[] = [];
      let unknown: { item: number; paidTo?: string } | undefined;
      const groups = [...settings.groups];
      for (const [index, item] of input.expenses.entries()) {
        try {
          const category = pick(settings.categories.filter((one) => !one.archived), item.category, "category");
          let groupId: string | null = null;
          if (item.group) {
            const named = (one: ExpenseGroup) => one.id === item.group!.trim() || one.name.trim().toLowerCase() === item.group!.trim().toLowerCase();
            const existing = groups.find((one) => !one.archived && named(one));
            if (existing) groupId = existing.id;
            else if (groups.some(named)) throw new ToolError(`The group "${clip(item.group, 60)}" is archived: someone who manages expenses can bring it back in Settings, or use another group.`);
            else if (item.newGroup) { const made = await ctx.api<ExpenseGroup>("POST", "/expenses/settings/groups", { name: item.group, color: "neutral", note: "" }); groups.push(made); groupId = made.id; }
            else throw new ToolError(`No group "${clip(item.group, 60)}": set newGroup to start it.`);
          }
          const amount = amountFields(minorOf(item.amount, item.currency), item.currency, item.chargedInr ? minorOf(item.chargedInr, "INR") : null, item.repeat);
          const body = {
            date: item.date ?? today, categoryId: category.id, groupId, paidTo: item.paidTo, scope: await scopeOf(item.chargedTo), repeat: item.repeat, endMonth: item.repeat === "none" ? null : item.lastMonth ?? null,
            note: item.note ?? "", tags: spelled(item.tags ?? [], knownTags), receiptId: null, ...amount, ...(item.website ? { companyWebsite: item.website } : {}),
          };
          const made = await ctx.api<Expense>("POST", "/expenses", body);
          // A tag new to the tracker keeps this spelling for the rest of the batch too.
          for (const tag of made.tags ?? []) if (!knownTags.some((one) => one.key === expenseTagKey(tag))) knownTags.push({ key: expenseTagKey(tag), tag, expenses: 1 });
          added.push(saved(made, ventures));
        } catch (error) {
          // The app refusing one: nothing saved for it, so the rest carry on.
          if (error instanceof ToolError && error.status < 500 && error.status !== 408) { failed.push({ item: index + 1, paidTo: clip(item.paidTo, 80), error: error.message }); continue; }
          // No answer (a timeout, the app down): this one may or may not be saved, and the rest would likely fare no better.
          unknown = { item: index + 1, paidTo: clip(item.paidTo, 80) };
          break;
        }
      }
      const notTried = unknown ? input.expenses.slice(unknown.item).map((item: { paidTo: string }, offset: number) => ({ item: unknown!.item + 1 + offset, paidTo: clip(item.paidTo, 80) })) : [];
      const list = (rows: { item: number; paidTo?: string; error?: string }[]) => rows.map((row) => `${row.item}. ${row.paidTo}${row.error ? `: ${row.error}` : ""}`).join(" ");
      // Nothing saved for sure. Refused outright: the same requestId stays usable once fixed. One without an answer: kept as unknown.
      if (!added.length && !unknown) throw new ToolError(`Nothing was added: ${list(failed)}`);
      if (!added.length) throw new ToolError(`The app didn't answer in time for ${list([unknown!])}: it may or may not have been saved, so check list_expenses before sending it again with a new requestId.${notTried.length ? ` Not tried yet: ${list(notTried)}.` : ""}${failed.length ? ` Refused: ${list(failed)}` : ""}`, 503);
      return compact({
        added, failed: failed.length ? failed : undefined,
        unknown: unknown ? { ...unknown, note: "The app didn't answer in time: it may or may not have been saved. Check list_expenses before sending it again." } : undefined,
        notTried: notTried.length ? notTried : undefined,
        resend: failed.length || unknown ? "Send only the ones not added (fixed where refused) in a new call with a new requestId." : undefined,
        restricted: settings.hiddenRestricted ? RESTRICTED_NOTE : undefined, hint: "Attach a receipt (photo or PDF) from the expense's link.",
      });
    });
  });

  tool("update_expense", "expenses:write", {
    title: "Update expense", annotations: writes(true),
    description: "Change an expense: only the fields given. To stop a subscription, set lastMonth (the last month it's paid); clear it with null to let it carry on. A new amount here changes every month: for a price that changed from a month on, use change_expense_price. Read it first (list_expenses with expenseId) and pass its updatedAt.",
    inputSchema: z.object({
      expenseId: id, expectedUpdatedAt: versionField.optional(), paidTo: z.string().trim().min(1).max(120).optional(), amount: z.number().positive().max(1e12).optional(), currency: expenseCurrencySchema.optional().describe("With amount: the currency it's in"),
      chargedInr: z.number().positive().max(1e12).nullable().optional().describe("A one-time payment in another currency: what the bank charged in rupees; null to count it at the day's rate. A new amount drops the old figure unless given again"),
      date: z.string().regex(DAY, "A date is YYYY-MM-DD").optional(), category: nameOrId("category").optional(), group: nameOrId("group").nullable().optional(),
      chargedTo: whereField.optional(), repeat: z.enum(["none", "monthly", "yearly"]).optional(), lastMonth: monthField.nullable().optional(), note: z.string().trim().max(1000).optional(), tags: tagsField.optional().describe("Replaces all its tags ([] clears them): send the ones to keep too"), requestId: requestIdField,
    }),
  }, async (input) => {
    const { requestId, ...asked } = input;
    const [settings, ventures, knownTags] = await Promise.all([settingsOf(), ventureNames(), input.tags?.length ? expensesOf().then((list) => expenseTagsIn(list.items)) : [] as ReturnType<typeof expenseTagsIn>]);
    // Read inside the claim, so a retry of a change that went through replays it instead of meeting the newer version.
    return once(ctx, "update_expense", requestId, asked, async () => {
      const current = await readExpense(input.expenseId);
      unchangedSince(current, input.expectedUpdatedAt);
      const change: Record<string, unknown> = {};
      if (input.paidTo !== undefined) change.paidTo = input.paidTo;
      if (input.date !== undefined) change.date = input.date;
      if (input.note !== undefined) change.note = input.note;
      if (input.tags !== undefined) {
        const tidy = expenseTagsSchema.safeParse(spelled(input.tags, knownTags));
        if (!tidy.success) throw new ToolError(tidy.error.issues.map((issue) => issue.message).join("; "));
        change.tags = tidy.data;
      }
      if (input.category !== undefined) change.categoryId = pick(settings.categories.filter((one) => !one.archived || one.id === current.categoryId), input.category, "category").id;
      if (input.group !== undefined) change.groupId = input.group === null ? null : pick(settings.groups.filter((one) => !one.archived || one.id === current.groupId), input.group, "group").id;
      if (input.chargedTo !== undefined) change.scope = await scopeOf(input.chargedTo);
      const repeat = input.repeat ?? current.repeat;
      if (input.repeat !== undefined) change.repeat = input.repeat;
      if (input.lastMonth && repeat === "none") throw new ToolError("Only a repeating expense has a last month: this one is paid once.");
      if (input.lastMonth !== undefined) change.endMonth = input.lastMonth;
      if (repeat === "none" && input.repeat !== undefined) change.endMonth = null;
      // The amount: in the currency given, else the expense's own; a bank figure only for a one-time one in another currency.
      const own = current.foreign?.currency ?? "INR";
      const currency = input.currency ?? own;
      if (input.amount !== undefined || input.currency !== undefined || input.chargedInr !== undefined || (input.repeat && input.repeat !== "none" && current.chargedPaise)) {
        if (input.amount === undefined && currency !== own) throw new ToolError(`Give the amount in ${currency} too.`);
        const minor = input.amount !== undefined ? minorOf(input.amount, currency) : current.foreign ? current.foreign.amountMinor : current.amountPaise;
        // The bank's figure was for the old amount: kept only while the amount stays and it is still paid once.
        const kept = input.amount === undefined && repeat === "none" && current.chargedPaise ? current.chargedPaise : null;
        Object.assign(change, amountFields(minor, currency, input.chargedInr === null ? null : input.chargedInr !== undefined ? minorOf(input.chargedInr, "INR") : kept, repeat));
      }
      const canonical = (value: unknown) => JSON.stringify(value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value ?? null);
      const labels: Record<string, string> = { categoryId: "category", groupId: "group", scope: "chargedTo", endMonth: "lastMonth", amountPaise: "amount", foreign: "amount", chargedPaise: "chargedInr" };
      const changed = [...new Set(Object.keys(change).filter((key) => canonical(change[key]) !== canonical(key === "tags" ? current.tags ?? [] : (current as unknown as Record<string, unknown>)[key])).map((key) => labels[key] ?? key))];
      if (!changed.length) throw new ToolError("Nothing to change: it already has these values.");
      const updated = await ctx.api<Expense>("PATCH", `/expenses/${encodeURIComponent(input.expenseId)}`, { ...change, expectedUpdatedAt: current.updatedAt });
      return compact({ updated: saved(updated, ventures), changed });
    });
  });

  tool("change_expense_price", "expenses:write", {
    title: "Change expense price", annotations: writes(false),
    description: "A repeating expense's new amount from a month on (\"Anthropic went to $25 from December\"): it stops the month before and carries on at the new amount, so earlier months keep what was paid. The amount is in the expense's own currency.",
    inputSchema: z.object({ expenseId: id, expectedUpdatedAt: versionField.optional(), fromMonth: monthField.describe("The first month at the new amount (YYYY-MM): one it is paid in"), amount: z.number().positive().max(1e12), paidTo: z.string().trim().min(1).max(120).optional(), note: z.string().trim().max(1000).optional(), requestId: requestIdField }),
  }, async (input) => {
    const { requestId, ...asked } = input;
    const ventures = await ventureNames();
    return once(ctx, "change_expense_price", requestId, asked, async () => {
      const current = await readExpense(input.expenseId);
      unchangedSince(current, input.expectedUpdatedAt);
      if (current.repeat === "none") throw new ToolError("Only a repeating expense changes price from a month on: use update_expense for this one.");
      const own = current.foreign?.currency ?? "INR";
      const body = { fromMonth: input.fromMonth, ...(current.foreign ? { amountMinor: minorOf(input.amount, own) } : { amountPaise: minorOf(input.amount, "INR") }), ...(input.paidTo ? { paidTo: input.paidTo } : {}), ...(input.note !== undefined ? { note: input.note } : {}), expectedUpdatedAt: current.updatedAt };
      const result = await ctx.api<{ stopped: Expense; continued: Expense }>("POST", `/expenses/${encodeURIComponent(input.expenseId)}/change`, body);
      return { before: compact({ amount: paidAs(result.stopped), lastMonth: result.stopped.endMonth ?? undefined }), from: saved(result.continued, ventures) };
    });
  });

  tool("delete_expense", "expenses:write", {
    title: "Delete expense", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Delete an expense for good (deleting the copy a price change made undoes that change). Only after the person has said yes to deleting this one in this conversation: read it (list_expenses with expenseId), name it and its amount, ask, and pass the updatedAt you showed them. To stop a subscription instead, use update_expense with lastMonth.",
    inputSchema: z.object({ expenseId: id, expectedUpdatedAt: versionField, confirm: z.literal(true).describe("true only once the person has said yes to deleting it, in this conversation"), requestId: requestIdField }),
  }, async (input) => once(ctx, "delete_expense", input.requestId, { id: input.expenseId, expectedUpdatedAt: input.expectedUpdatedAt }, async () => {
    const current = await readExpense(input.expenseId);
    unchangedSince(current, input.expectedUpdatedAt);
    const result = await ctx.api<{ deleted: boolean; reopened?: string }>("DELETE", `/expenses/${encodeURIComponent(input.expenseId)}?expectedUpdatedAt=${encodeURIComponent(current.updatedAt)}`);
    return compact({ deleted: clip(current.paidTo, 120), amount: paidAs(current), date: current.date, priceChangeUndone: result.reopened ? true : undefined });
  }));
}
