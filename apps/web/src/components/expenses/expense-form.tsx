"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { addMonths, companyKey, currencyDigits, EXPENSE_CURRENCIES, expenseAccessAtLeast, LONG_NUMBER, MAX_LOGO_BYTES, websiteHost, monthOf, nextOccurrence, nextPaidMonthAfter, type ExpenseAccessLevel, type ExpenseCurrency, type ExpenseInput, type ExpenseReceipt, type ExpenseScope } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { changeExpenseFrom, createCategory, createExpense, createGroup, deleteExpense, getExpenseRates, refreshSoon, updateExpense, uploadCompanyLogo, type Expense, type ExpenseCategory, type ExpenseGroup, type ExpenseSettings } from "@/lib/expenses-api";
import { CompanyAvatar } from "./expense-company";
import { ReceiptSection } from "./expense-receipt";
import { amountText, dayLabel, minorOf, minorText, monthLabel, paiseOf, rupees, scopeKey, thisMonth, todayLocal } from "./expense-shared";
import { currencySign, formatMoney } from "./expense-money";

type Venture = { id: string; name: string };
type Props = {
  settings: ExpenseSettings; ventures: Venture[]; expense?: Expense;
  /** Opened inside a venture (the sidebar scope): new expenses are charged to it, shown read-only. */
  fixedVentureId?: string; defaultWhere?: string; canEdit: boolean;
  /** Opened from an upcoming payment's "stop after this payment": its last month is set to that payment's month, to save. */
  stopAfterNext?: boolean;
  /** The person's access: Edit may add a group from here, Manage a category too. */
  level: ExpenseAccessLevel;
  onClose: () => void; onSaved: () => void;
  /** A category or group was added from the form: the page reads the settings again. */
  onSettingsChanged: () => void;
};
const NEW = "__new__";

const isCurrency = (code: string | null | undefined): code is ExpenseCurrency => (EXPENSE_CURRENCIES as readonly string[]).includes(code ?? "");
/** "€1 = ₹106.60"; per 100 or 1,000 units for a small currency ("Rp1,000 = ₹5.27"). */
function unitRate(currency: string, rupeesPerUnit: number) {
  const units = rupeesPerUnit < 0.1 ? 1_000 : rupeesPerUnit < 1 ? 100 : 1;
  return `${formatMoney(units * 10 ** currencyDigits(currency), currency)} = ${rupees(Math.round(units * rupeesPerUnit * 100))}`;
}
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const whereOf = (key: string): ExpenseScope => key === "office" ? { kind: "office" } : key === "personal" ? { kind: "personal" } : { kind: "venture", ventureId: key.slice("venture:".length) };

/**
 * Add or edit one expense, in a popup (full screen on phones): the receipt on the left on wide screens, the details on the right, Save
 * pinned at the bottom. People who can only view see it read-only.
 */
export function ExpenseForm({ settings, ventures, expense, fixedVentureId, defaultWhere, canEdit, stopAfterNext, level, onClose, onSaved, onSettingsChanged }: Props) {
  // Ones added from this form show at once, before the page has read the settings again.
  const [added, setAdded] = useState<{ categories: ExpenseCategory[]; groups: ExpenseGroup[] }>({ categories: [], groups: [] });
  const withAdded = <T extends { id: string }>(list: T[], extra: T[]) => [...list, ...extra.filter((item) => !list.some((one) => one.id === item.id))];
  const usableCategories = withAdded(settings.categories, added.categories).filter((category) => !category.archived || category.id === expense?.categoryId);
  const usableGroups = withAdded(settings.groups, added.groups).filter((group) => !group.archived || group.id === expense?.groupId);
  const canAddGroup = expenseAccessAtLeast(level, "edit");
  const canAddCategory = level === "manage";
  const [creating, setCreating] = useState<{ kind: "category" | "group"; name: string } | null>(null);
  const [paidTo, setPaidTo] = useState(expense?.paidTo ?? "");
  // The amount in the currency it was paid in (rupees unless picked); for another currency, optionally what the bank charged in rupees.
  const initialCurrency: ExpenseCurrency = expense?.foreign && isCurrency(expense.foreign.currency) ? expense.foreign.currency : "INR";
  const initialAmount = expense ? (expense.foreign ? minorText(expense.foreign.amountMinor, currencyDigits(expense.foreign.currency)) : amountText(expense.amountPaise)) : "";
  const initialCharged = expense?.chargedPaise ? amountText(expense.chargedPaise) : "";
  const [currency, setCurrency] = useState<ExpenseCurrency>(initialCurrency);
  const [amount, setAmount] = useState(initialAmount);
  const [charged, setCharged] = useState(initialCharged);
  const digits = currencyDigits(currency);
  const [date, setDate] = useState(expense?.date ?? todayLocal());
  const [categoryId, setCategoryId] = useState(expense?.categoryId ?? usableCategories[0]?.id ?? "");
  // A receipt fills in only what is still empty (and the category, until one is picked).
  const [categoryPicked, setCategoryPicked] = useState(Boolean(expense));
  const [receiptId, setReceiptId] = useState(expense?.receiptId ?? null);
  const [receiptNote, setReceiptNote] = useState("");
  // A company seen for the first time may get its website (for its logo) or a logo now; both optional.
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const logoPreview = useMemo(() => (logoFile ? URL.createObjectURL(logoFile) : null), [logoFile]);
  useEffect(() => () => { if (logoPreview) URL.revokeObjectURL(logoPreview); }, [logoPreview]);
  const typedKey = paidTo.trim() ? companyKey(paidTo) : "";
  const knownCompany = typedKey ? settings.companies.find((company) => company.keys.includes(typedKey)) ?? (expense && expense.paidTo === paidTo ? settings.companies.find((company) => company.id === expense.companyId) : undefined) : undefined;
  const newCompany = Boolean(typedKey) && !knownCompany && canEdit;
  const [groupId, setGroupId] = useState(expense?.groupId ?? "");
  const [where, setWhere] = useState(expense ? scopeKey(expense.scope) : fixedVentureId ? `venture:${fixedVentureId}` : defaultWhere ?? "office");
  const [repeat, setRepeat] = useState<ExpenseInput["repeat"]>(expense?.repeat ?? "none");
  // "Stop after this payment" (from its notice): the next payment's month is its last; saving confirms it.
  const stopDay = stopAfterNext && expense && expense.repeat !== "none" && canEdit ? nextOccurrence(expense, todayLocal()) : null;
  const [endMonth, setEndMonth] = useState(stopDay ? monthOf(stopDay) : expense?.endMonth ?? "");
  const [note, setNote] = useState(expense?.note ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | "change" | "create" | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A price change starts in a month the expense is paid in: the next one after this month (for a yearly one, its next renewal).
  const [changeMonth, setChangeMonth] = useState(() => (expense && expense.repeat !== "none" ? nextPaidMonthAfter(expense, monthOf(expense.date) > thisMonth() ? monthOf(expense.date) : thisMonth()) : null) ?? addMonths(thisMonth(), 1));
  const [changeAmount, setChangeAmount] = useState("");
  const dirty = Boolean(endMonth !== (expense?.endMonth ?? "") || paidTo !== (expense?.paidTo ?? "") || amount !== initialAmount || currency !== initialCurrency || charged !== initialCharged || note !== (expense?.note ?? "") || receiptId !== (expense?.receiptId ?? null));
  // The day's rate for another currency, to show what it comes to in rupees (looked up a moment after the currency or day changes).
  const [rate, setRate] = useState<{ key: string; rupees: number | null; day: string | null }>({ key: "", rupees: null, day: null });
  const rateKey = currency === "INR" ? "" : `${currency}|${date}`;
  useEffect(() => {
    if (!rateKey || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      getExpenseRates(shiftDay(date, -10), date, [currency]).then((rates) => {
        const known = rates.days.filter((day) => day.day <= date && day.rupees[currency]).at(-1) ?? rates.days.at(-1);
        if (active) setRate({ key: rateKey, rupees: known?.rupees[currency] ?? null, day: known?.day ?? null });
      }, () => { if (active) setRate({ key: rateKey, rupees: null, day: null }); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
    // The key holds the currency and the day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateKey]);
  const typedMinor = minorOf(amount, digits);
  const chargedPaise = currency !== "INR" && repeat === "none" ? paiseOf(charged) : null;
  const rateNow = rate.key === rateKey ? rate : null;
  const inRupees = currency === "INR" ? null
    : chargedPaise ? `Counts as ${rupees(chargedPaise)}, what the bank charged.`
    : !rateNow ? "Looking up the day's rate…"
    : !rateNow.rupees ? `Couldn't get the ${currency} rate just now: ${repeat === "none" ? "enter what the bank charged in rupees, or " : ""}try again in a moment.`
    : `${typedMinor ? `≈ ${rupees(Math.round((typedMinor / 10 ** digits) * rateNow.rupees * 100))} ` : ""}at the ${dayLabel(rateNow.day!)} rate (${unitRate(currency, rateNow.rupees)})${repeat !== "none" ? "; each later payment at its own day's rate" : ""}.`;
  const fixedVenture = fixedVentureId ? ventures.find((venture) => venture.id === fixedVentureId) : undefined;
  const readOnly = !canEdit;

  /** A receipt was added or removed. One just read fills in the fields still empty, and says which. */
  function receiptChanged(receipt: ExpenseReceipt | null, fresh: boolean) {
    setReceiptId(receipt?.id ?? null);
    setReceiptNote("");
    const data = receipt?.data;
    if (!fresh || !data) return;
    const filled: string[] = [];
    if (!paidTo.trim() && data.merchant) { setPaidTo(data.merchant.slice(0, 120)); filled.push("paid to"); }
    if (!companyWebsite.trim() && data.website) setCompanyWebsite(data.website);
    // The amount, in the receipt's own currency when it is one the tracker knows (with the day's rate shown); otherwise it asks.
    const known = isCurrency(data.currency) ? data.currency : null;
    if (!amount.trim() && data.total && known) { setCurrency(known); setAmount(minorText(Math.round(data.total * 10 ** currencyDigits(known)), currencyDigits(known))); filled.push("amount"); }
    if (!expense && data.date && date === todayLocal()) { setDate(data.date); filled.push("date"); }
    if (!categoryPicked && data.categoryId && usableCategories.some((category) => category.id === data.categoryId)) { setCategoryId(data.categoryId); filled.push("category"); }
    // What to know about its currency: one it can't convert, none printed, or (when its amount was filled in) the bank's figure. An
    // amount typed before it was read keeps its own currency, so the receipt's is mentioned.
    const filledAmount = filled.includes("amount");
    const foreign = data.total && !known ? (data.currency ? ` It's in ${data.currency} (${data.total.toFixed(2)}), which the tracker can't convert: enter what was charged in rupees.` : ` It doesn't say which currency its total of ${data.total.toFixed(2)} is in: enter the amount and pick its currency.`)
      : known && !filledAmount && data.total && known !== currency ? ` The receipt is in ${known} (${formatMoney(Math.round(data.total * 10 ** currencyDigits(known)), known)}).`
      : known && filledAmount && known !== "INR" && repeat === "none" ? " If you know what the bank charged in rupees, add it for the exact amount." : "";
    setReceiptNote(filled.length ? `Filled in ${filled.join(", ").replace(/, ([^,]*)$/, " and $1")} from the receipt: check them before saving.${foreign}` : foreign.trim());
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const minor = minorOf(amount, digits);
    if (!minor) { setError(currency === "INR" ? "Enter an amount in rupees, like 1700 or 1700.50." : `Enter the amount in ${currency}, like ${digits ? "12.50" : "1500"}.`); return; }
    if (currency !== "INR" && repeat === "none" && charged.trim() && !chargedPaise) { setError("Enter what the bank charged in rupees, like 1700.50, or leave it empty."); return; }
    if (LONG_NUMBER.test(paidTo) || LONG_NUMBER.test(note)) { setError("Leave out account, card and phone numbers: only amounts and labels are kept."); return; }
    if (repeat !== "none" && endMonth && endMonth < monthOf(date)) { setError("The last month can't be before the first payment."); return; }
    if (newCompany && companyWebsite.trim() && !websiteHost(companyWebsite)) { setError("Enter the company's website like godaddy.com, or leave it empty."); return; }
    const priced = currency === "INR" ? { amountPaise: minor, foreign: null, chargedPaise: null } : { foreign: { currency, amountMinor: minor }, chargedPaise };
    const input: ExpenseInput = { date, ...priced, categoryId, groupId: groupId || null, paidTo: paidTo.trim(), scope: whereOf(where), repeat, endMonth: repeat === "none" ? null : endMonth || null, note: note.trim(), receiptId, ...(newCompany && companyWebsite.trim() ? { companyWebsite: companyWebsite.trim() } : {}) };
    setBusy("save"); setError("");
    let saved: Expense;
    try {
      if (expense) {
        // Only what changed is sent, with the version it was changed from.
        const before: ExpenseInput = { date: expense.date, ...(expense.foreign ? {} : { amountPaise: expense.amountPaise }), foreign: expense.foreign ? { currency: expense.foreign.currency as Exclude<ExpenseCurrency, "INR">, amountMinor: expense.foreign.amountMinor } : null, chargedPaise: expense.chargedPaise ?? null, categoryId: expense.categoryId, groupId: expense.groupId, paidTo: expense.paidTo, scope: expense.scope, repeat: expense.repeat, endMonth: expense.endMonth, note: expense.note, receiptId: expense.receiptId ?? null };
        const changed = Object.fromEntries(Object.entries(input).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof ExpenseInput])));
        saved = Object.keys(changed).length ? await updateExpense(expense.id, { ...changed, expectedUpdatedAt: expense.updatedAt }) : expense;
      } else saved = await createExpense(input);
      toast({ title: expense ? "Expense updated" : "Expense added", body: `${input.paidTo} · ${formatMoney(minor, currency)}${currency !== "INR" ? ` (${rupees(saved.amountPaise)})` : ""}` });
      // The new company's logo goes on once the expense (and so the company) exists; the expense stays saved either way.
      if (logoFile && newCompany && saved.companyId) await uploadCompanyLogo(saved.companyId, logoFile).catch(() => toast({ title: "Logo not saved", body: "The expense is saved. Add the logo in Settings → Companies." }));
      // A new company's website: its logo is looked for now, and the page reads it in a few seconds.
      else if (newCompany && companyWebsite.trim()) refreshSoon(onSaved);
      onSaved(); onClose();
    } catch (cause) { setError(describeError(cause, "Could not save the expense. Try again.")); }
    finally { setBusy(null); }
  }
  async function remove() {
    if (!expense) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy("delete"); setError("");
    try { await deleteExpense(expense.id, expense.updatedAt); toast({ title: expense.continuesId ? "Price change undone" : "Expense deleted", body: expense.paidTo }); onSaved(); onClose(); }
    catch (cause) { setError(describeError(cause, "Could not delete the expense. Try again.")); setBusy(null); }
  }
  /** Adds the category or group typed in the form and picks it. */
  async function createInline() {
    if (!creating?.name.trim()) return;
    setBusy("create"); setError("");
    try {
      if (creating.kind === "group") {
        const group = await createGroup({ name: creating.name.trim(), color: "neutral", note: "" });
        setAdded((current) => ({ ...current, groups: [...current.groups, group] })); setGroupId(group.id);
      } else {
        const category = await createCategory({ name: creating.name.trim(), color: "neutral", restricted: false });
        setAdded((current) => ({ ...current, categories: [...current.categories, category] })); setCategoryId(category.id); setCategoryPicked(true);
      }
      toast({ title: `${creating.kind === "group" ? "Group" : "Category"} added`, body: creating.name.trim() });
      setCreating(null); onSettingsChanged();
    } catch (cause) { setError(describeError(cause, `Could not add the ${creating.kind}. Try again.`)); }
    finally { setBusy(null); }
  }
  async function changeFrom() {
    if (!expense) return;
    const own = expense.foreign?.currency ?? "INR";
    const newMinor = minorOf(changeAmount, currencyDigits(own));
    if (!newMinor) { setError(`Enter the new amount in ${own === "INR" ? "rupees" : own}.`); return; }
    setBusy("change"); setError("");
    try {
      await changeExpenseFrom(expense.id, { fromMonth: changeMonth, ...(expense.foreign ? { amountMinor: newMinor } : { amountPaise: newMinor }), expectedUpdatedAt: expense.updatedAt });
      toast({ title: "New amount saved", body: `${formatMoney(newMinor, own)} from ${monthLabel(changeMonth)}; earlier months keep ${expense.foreign ? formatMoney(expense.foreign.amountMinor, own) : rupees(expense.amountPaise)}.` });
      onSaved(); onClose();
    } catch (cause) { setError(describeError(cause, "Could not change the amount. Try again.")); }
    finally { setBusy(null); }
  }

  const title = expense ? (readOnly ? expense.paidTo : "Edit expense") : "Add an expense";
  const formId = useId();
  // Someone who only views an expense without a receipt has nothing for the receipt column.
  const receiptColumn = !readOnly || Boolean(receiptId);
  const actions = !readOnly && <div className="flex flex-wrap items-center gap-2">
    <button type="submit" form={formId} disabled={busy !== null} className={primaryClass}><ActionLabel busy={busy === "save"} idle={expense ? "Save changes" : "Add expense"} /></button>
    {expense && <button type="button" onClick={remove} disabled={busy !== null} className={clsx(secondaryClass, confirmDelete && "!border-danger-text !text-danger-text")}><ActionLabel busy={busy === "delete"} busyText="Deleting…" idle={confirmDelete ? (expense.continuesId ? "Yes, undo the price change" : "Yes, delete it for good") : "Delete"} /></button>}
    {confirmDelete && busy === null && <button type="button" onClick={() => setConfirmDelete(false)} className={secondaryClass}>Keep it</button>}
  </div>;
  return <DetailDrawer layout="dialog" wide={receiptColumn} title={title} subtitle={readOnly ? "You can view expenses but not change them." : "Amounts and labels only: never bank, card or account numbers."} onClose={onClose} dirty={!readOnly && dirty} footer={actions || undefined}>
    <div className={clsx("grid grid-cols-1 gap-5", receiptColumn && "lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start")}>
    {receiptColumn && <div className="grid min-w-0 gap-3 lg:sticky lg:top-0">
      <ReceiptSection receiptId={receiptId} canEdit={!readOnly} onReceipt={receiptChanged} />
      <p role="status" className={receiptNote ? "rounded-xl bg-primary-50 px-3 py-2 text-xs leading-5 text-primary-900" : "sr-only"}>{receiptNote}</p>
    </div>}
    <div className="grid min-w-0 gap-5">
    <form id={formId} onSubmit={save} className="grid grid-cols-1 gap-4">
      <fieldset disabled={readOnly || busy !== null} className="grid grid-cols-1 gap-4">
        <Field label="Paid to"><input required maxLength={120} className={inputClass} value={paidTo} onChange={(event) => setPaidTo(event.target.value)} placeholder="Anthropic, GoDaddy, Contabo…" autoFocus={!expense} /></Field>
        {knownCompany && <p className="-mt-2 flex items-center gap-2 text-xs text-neutral-500"><CompanyAvatar company={knownCompany} name={knownCompany.name} size={20} />Grouped with <span className="font-semibold text-neutral-700">{knownCompany.name}</span> · {knownCompany.expenses} {knownCompany.expenses === 1 ? "expense" : "expenses"}</p>}
        {newCompany && <div role="group" aria-label="New company" className="-mt-1 grid gap-2.5 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
          <p className="text-xs leading-5 text-neutral-600"><span className="font-semibold text-neutral-800">{paidTo.trim()}</span> is a new company. Add its website or a logo if you like: without either it shows its initial, and you can add them later in Settings → Companies.</p>
          <div className="flex flex-wrap items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file */}
            {logoPreview ? <img src={logoPreview} alt="" aria-hidden="true" className="h-9 w-9 shrink-0 rounded-full bg-white object-contain p-1 ring-1 ring-black/5" /> : <CompanyAvatar name={paidTo} size={36} />}
            <input aria-label="Company website (optional)" inputMode="url" maxLength={300} placeholder="Website, e.g. godaddy.com" className={clsx(inputClass, "!min-h-9 min-w-0 !w-auto flex-1 basis-40 !text-sm")} value={companyWebsite} onChange={(event) => setCompanyWebsite(event.target.value)} />
            <button type="button" onClick={() => logoInput.current?.click()} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}>{logoFile ? "Change logo" : "Upload logo"}</button>
            {logoFile && <button type="button" onClick={() => setLogoFile(null)} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}>Remove</button>}
          </div>
          <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (file.size > MAX_LOGO_BYTES) { setError("Pick a logo image under 2 MB."); return; } setLogoFile(file); }} />
        </div>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`Amount (${currencySign(currency)})`}><div className="flex min-w-0 gap-2">
            {/* Its own width (the shared input style would make it take the whole row). */}
            <Select aria-label="Currency" value={currency} onChange={(event) => setCurrency(event.target.value as ExpenseCurrency)} className="min-h-11 w-[6.5rem] shrink-0 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-semibold text-neutral-800">{EXPENSE_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</Select>
            <input required inputMode="decimal" aria-label={`Amount in ${currency}`} className={clsx(inputClass, "min-w-0 flex-1")} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={currency === "INR" ? "1700" : digits ? "12.50" : "1500"} />
          </div></Field>
          <Field label={repeat === "none" ? "Date paid" : "First payment"}><input required type="date" className={inputClass} value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        </div>
        {inRupees && <div className="-mt-2 grid gap-3">
          <p role="status" className="text-xs leading-5 text-neutral-500">{inRupees}</p>
          {repeat === "none" && <Field label="Charged in ₹ (optional)"><input inputMode="decimal" className={inputClass} value={charged} onChange={(event) => setCharged(event.target.value)} placeholder="From your bank statement, e.g. 702.40" /></Field>}
        </div>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Category"><Select aria-label="Category" className={inputClass} value={categoryId} onChange={(event) => { if (event.target.value === NEW) setCreating({ kind: "category", name: "" }); else { setCategoryId(event.target.value); setCategoryPicked(true); } }}>{usableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.restricted ? " (restricted)" : ""}{category.archived ? " · archived" : ""}</option>)}{canAddCategory && <option value={NEW}>+ New category…</option>}</Select></Field>
          <Field label="Group (optional)"><Select aria-label="Group" className={inputClass} value={groupId} onChange={(event) => { if (event.target.value === NEW) setCreating({ kind: "group", name: "" }); else setGroupId(event.target.value); }}><option value="">No group</option>{usableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}{group.archived ? " · archived" : ""}</option>)}{canAddGroup && <option value={NEW}>+ New group…</option>}</Select></Field>
        </div>
        {creating && <div role="group" aria-label={`New ${creating.kind}`} className="-mt-1 flex flex-wrap items-center gap-2 rounded-xl border border-primary-100 bg-primary-50 p-2.5">
          <input autoFocus maxLength={60} aria-label={`Name of the new ${creating.kind}`} placeholder={creating.kind === "group" ? "New group, e.g. AI subscriptions" : "New category, e.g. Travel"} className={clsx(inputClass, "!min-h-9 min-w-0 !w-auto flex-1 basis-40 !text-sm")} value={creating.name}
            onChange={(event) => setCreating({ ...creating, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createInline(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setCreating(null); } }} />
          <button type="button" onClick={() => void createInline()} disabled={busy !== null || !creating.name.trim()} className={clsx(primaryClass, "!min-h-9 !px-3 !text-xs")}><ActionLabel busy={busy === "create"} busyText="Adding…" idle={`Add ${creating.kind}`} /></button>
          <button type="button" onClick={() => setCreating(null)} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}>Cancel</button>
        </div>}
        {fixedVenture && !expense
          ? <div role="group" aria-label="Charged to" className="rounded-xl border border-primary-100 bg-primary-50 p-3"><span className="block text-xs font-semibold text-primary-800">Charged to · the venture you are in</span><span className="mt-1 block text-sm font-bold text-neutral-900">{fixedVenture.name}</span><span className="mt-1 block text-xs leading-5 text-neutral-600">You&apos;re looking at {fixedVenture.name} only, so new expenses here are charged to it. To charge the Office, Personal or another venture, pick All ventures in the sidebar.</span></div>
          : <Field label="Charged to"><Select aria-label="Charged to" className={inputClass} value={where} onChange={(event) => setWhere(event.target.value)}><option value="office">Office</option><option value="personal">Personal</option>{ventures.map((venture) => <option key={venture.id} value={`venture:${venture.id}`}>{venture.name}</option>)}{expense && expense.scope.kind === "venture" && !ventures.some((venture) => `venture:${venture.id}` === where) && <option value={where}>A venture no longer listed</option>}</Select></Field>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Repeats"><Select aria-label="Repeats" className={inputClass} value={repeat} onChange={(event) => setRepeat(event.target.value as ExpenseInput["repeat"])}><option value="none">One-time</option><option value="monthly">Every month</option><option value="yearly">Every year</option></Select></Field>
          {repeat !== "none" && <Field label="Last month (optional)"><input type="month" className={inputClass} value={endMonth} min={monthOf(date)} onChange={(event) => setEndMonth(event.target.value)} /></Field>}
        </div>
        {stopDay && endMonth === monthOf(stopDay) && <p role="status" className="-mt-2 rounded-xl bg-primary-50 px-3 py-2 text-xs font-semibold leading-5 text-primary-900">Set to stop after the {dayLabel(stopDay)} payment. Save to confirm, or change the last month.</p>}
        {repeat !== "none" && <p className="-mt-2 text-xs leading-5 text-neutral-500">{endMonth ? `Paid ${repeat === "monthly" ? "every month" : "every year"} until ${monthLabel(endMonth)}, then it stops.` : `Keeps repeating until you set a last month. Earlier months always keep what was paid.`}</p>}
        <Field label="Note (optional)"><textarea maxLength={1_000} rows={3} className={clsx(inputClass, "py-2.5")} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Plan, seats, what it is for" /></Field>
      </fieldset>
      {expense?.continuesId && confirmDelete && <p className="text-xs leading-5 text-neutral-600">This amount came from a price change. Deleting it undoes the change: the earlier amount carries on as before.</p>}
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
    </form>
    {expense && expense.repeat !== "none" && !readOnly && <section aria-label="New amount from a month" className="grid grid-cols-1 gap-3 rounded-2xl border border-neutral-200 p-4">
      <div><h3 className="text-sm font-bold text-neutral-900">Price changed?</h3><p className="mt-1 text-xs leading-5 text-neutral-500">Set the new amount from a month on. Earlier months keep {expense.foreign ? formatMoney(expense.foreign.amountMinor, expense.foreign.currency) : rupees(expense.amountPaise)}; editing the amount above would change every month.</p></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="From"><input type="month" className={inputClass} value={changeMonth} min={addMonths(monthOf(expense.date), 1)} onChange={(event) => setChangeMonth(event.target.value)} /></Field>
        <Field label={`New amount (${currencySign(expense.foreign?.currency ?? "INR")})`}><input inputMode="decimal" className={inputClass} value={changeAmount} onChange={(event) => setChangeAmount(event.target.value)} placeholder={expense.foreign ? "25" : "1900"} /></Field>
        <button type="button" onClick={changeFrom} disabled={busy !== null || !changeAmount.trim()} className={clsx(secondaryClass, "!min-h-11")}><ActionLabel busy={busy === "change"} idle="Save new amount" /></button>
      </div>
    </section>}
    </div>
    </div>
  </DetailDrawer>;
}
