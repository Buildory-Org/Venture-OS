"use client";
import { useId, useState } from "react";
import clsx from "clsx";
import { addMonths, expenseAccessAtLeast, LONG_NUMBER, monthOf, nextPaidMonthAfter, type ExpenseAccessLevel, type ExpenseInput, type ExpenseReceipt, type ExpenseScope } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { changeExpenseFrom, createCategory, createExpense, createGroup, deleteExpense, updateExpense, type Expense, type ExpenseCategory, type ExpenseGroup, type ExpenseSettings } from "@/lib/expenses-api";
import { ReceiptSection } from "./expense-receipt";
import { amountText, monthLabel, paiseOf, rupees, scopeKey, thisMonth, todayLocal } from "./expense-shared";

type Venture = { id: string; name: string };
type Props = {
  settings: ExpenseSettings; ventures: Venture[]; expense?: Expense;
  /** Opened inside a venture (the sidebar scope): new expenses are charged to it, shown read-only. */
  fixedVentureId?: string; defaultWhere?: string; canEdit: boolean;
  /** The person's access: Edit may add a group from here, Manage a category too. */
  level: ExpenseAccessLevel;
  onClose: () => void; onSaved: () => void;
  /** A category or group was added from the form: the page reads the settings again. */
  onSettingsChanged: () => void;
};
const NEW = "__new__";

const whereOf = (key: string): ExpenseScope => key === "office" ? { kind: "office" } : key === "personal" ? { kind: "personal" } : { kind: "venture", ventureId: key.slice("venture:".length) };

/**
 * Add or edit one expense, in a popup (full screen on phones): the receipt on the left on wide screens, the details on the right, Save
 * pinned at the bottom. People who can only view see it read-only.
 */
export function ExpenseForm({ settings, ventures, expense, fixedVentureId, defaultWhere, canEdit, level, onClose, onSaved, onSettingsChanged }: Props) {
  // Ones added from this form show at once, before the page has read the settings again.
  const [added, setAdded] = useState<{ categories: ExpenseCategory[]; groups: ExpenseGroup[] }>({ categories: [], groups: [] });
  const withAdded = <T extends { id: string }>(list: T[], extra: T[]) => [...list, ...extra.filter((item) => !list.some((one) => one.id === item.id))];
  const usableCategories = withAdded(settings.categories, added.categories).filter((category) => !category.archived || category.id === expense?.categoryId);
  const usableGroups = withAdded(settings.groups, added.groups).filter((group) => !group.archived || group.id === expense?.groupId);
  const canAddGroup = expenseAccessAtLeast(level, "edit");
  const canAddCategory = level === "manage";
  const [creating, setCreating] = useState<{ kind: "category" | "group"; name: string } | null>(null);
  const [paidTo, setPaidTo] = useState(expense?.paidTo ?? "");
  const [amount, setAmount] = useState(expense ? amountText(expense.amountPaise) : "");
  const [date, setDate] = useState(expense?.date ?? todayLocal());
  const [categoryId, setCategoryId] = useState(expense?.categoryId ?? usableCategories[0]?.id ?? "");
  // A receipt fills in only what is still empty (and the category, until one is picked).
  const [categoryPicked, setCategoryPicked] = useState(Boolean(expense));
  const [receiptId, setReceiptId] = useState(expense?.receiptId ?? null);
  const [receiptNote, setReceiptNote] = useState("");
  const [groupId, setGroupId] = useState(expense?.groupId ?? "");
  const [where, setWhere] = useState(expense ? scopeKey(expense.scope) : fixedVentureId ? `venture:${fixedVentureId}` : defaultWhere ?? "office");
  const [repeat, setRepeat] = useState<ExpenseInput["repeat"]>(expense?.repeat ?? "none");
  const [endMonth, setEndMonth] = useState(expense?.endMonth ?? "");
  const [note, setNote] = useState(expense?.note ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | "change" | "create" | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A price change starts in a month the expense is paid in: the next one after this month (for a yearly one, its next renewal).
  const [changeMonth, setChangeMonth] = useState(() => (expense && expense.repeat !== "none" ? nextPaidMonthAfter(expense, monthOf(expense.date) > thisMonth() ? monthOf(expense.date) : thisMonth()) : null) ?? addMonths(thisMonth(), 1));
  const [changeAmount, setChangeAmount] = useState("");
  const dirty = Boolean(paidTo !== (expense?.paidTo ?? "") || amount !== (expense ? amountText(expense.amountPaise) : "") || note !== (expense?.note ?? "") || receiptId !== (expense?.receiptId ?? null));
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
    // The amount is filled in only for a receipt in rupees: one in another currency, or with none known, asks for the rupee amount.
    const inRupees = data.currency === "INR";
    if (!amount.trim() && data.total && inRupees) { setAmount(amountText(Math.round(data.total * 100))); filled.push("amount"); }
    if (!expense && data.date && date === todayLocal()) { setDate(data.date); filled.push("date"); }
    if (!categoryPicked && data.categoryId && usableCategories.some((category) => category.id === data.categoryId)) { setCategoryId(data.categoryId); filled.push("category"); }
    const foreign = data.total && !inRupees ? (data.currency ? ` It's in ${data.currency} (${data.total.toFixed(2)}): enter what was charged in rupees.` : ` It doesn't say which currency its total of ${data.total.toFixed(2)} is in: enter the amount in rupees.`) : "";
    setReceiptNote(filled.length ? `Filled in ${filled.join(", ").replace(/, ([^,]*)$/, " and $1")} from the receipt: check them before saving.${foreign}` : foreign.trim());
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const paise = paiseOf(amount);
    if (!paise) { setError("Enter an amount in rupees, like 1700 or 1700.50."); return; }
    if (LONG_NUMBER.test(paidTo) || LONG_NUMBER.test(note)) { setError("Leave out account, card and phone numbers: only amounts and labels are kept."); return; }
    if (repeat !== "none" && endMonth && endMonth < monthOf(date)) { setError("The last month can't be before the first payment."); return; }
    const input: ExpenseInput = { date, amountPaise: paise, categoryId, groupId: groupId || null, paidTo: paidTo.trim(), scope: whereOf(where), repeat, endMonth: repeat === "none" ? null : endMonth || null, note: note.trim(), receiptId };
    setBusy("save"); setError("");
    try {
      if (expense) {
        // Only what changed is sent, with the version it was changed from.
        const before: ExpenseInput = { date: expense.date, amountPaise: expense.amountPaise, categoryId: expense.categoryId, groupId: expense.groupId, paidTo: expense.paidTo, scope: expense.scope, repeat: expense.repeat, endMonth: expense.endMonth, note: expense.note, receiptId: expense.receiptId ?? null };
        const changed = Object.fromEntries(Object.entries(input).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof ExpenseInput])));
        if (Object.keys(changed).length) await updateExpense(expense.id, { ...changed, expectedUpdatedAt: expense.updatedAt });
      } else await createExpense(input);
      toast({ title: expense ? "Expense updated" : "Expense added", body: `${input.paidTo} · ${rupees(paise)}` });
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
    const paise = paiseOf(changeAmount);
    if (!paise) { setError("Enter the new amount in rupees."); return; }
    setBusy("change"); setError("");
    try {
      await changeExpenseFrom(expense.id, { fromMonth: changeMonth, amountPaise: paise, expectedUpdatedAt: expense.updatedAt });
      toast({ title: "New amount saved", body: `${rupees(paise)} from ${monthLabel(changeMonth)}; earlier months keep ${rupees(expense.amountPaise)}.` });
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Amount (₹)"><input required inputMode="decimal" className={inputClass} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1700" /></Field>
          <Field label={repeat === "none" ? "Date paid" : "First payment"}><input required type="date" className={inputClass} value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        </div>
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
        {repeat !== "none" && <p className="-mt-2 text-xs leading-5 text-neutral-500">{endMonth ? `Paid ${repeat === "monthly" ? "every month" : "every year"} until ${monthLabel(endMonth)}, then it stops.` : `Keeps repeating until you set a last month. Earlier months always keep what was paid.`}</p>}
        <Field label="Note (optional)"><textarea maxLength={1_000} rows={3} className={clsx(inputClass, "py-2.5")} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Plan, seats, what it is for" /></Field>
      </fieldset>
      {expense?.continuesId && confirmDelete && <p className="text-xs leading-5 text-neutral-600">This amount came from a price change. Deleting it undoes the change: the earlier amount carries on as before.</p>}
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
    </form>
    {expense && expense.repeat !== "none" && !readOnly && <section aria-label="New amount from a month" className="grid grid-cols-1 gap-3 rounded-2xl border border-neutral-200 p-4">
      <div><h3 className="text-sm font-bold text-neutral-900">Price changed?</h3><p className="mt-1 text-xs leading-5 text-neutral-500">Set the new amount from a month on. Earlier months keep {rupees(expense.amountPaise)}; editing the amount above would change every month.</p></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="From"><input type="month" className={inputClass} value={changeMonth} min={addMonths(monthOf(expense.date), 1)} onChange={(event) => setChangeMonth(event.target.value)} /></Field>
        <Field label="New amount (₹)"><input inputMode="decimal" className={inputClass} value={changeAmount} onChange={(event) => setChangeAmount(event.target.value)} placeholder="1900" /></Field>
        <button type="button" onClick={changeFrom} disabled={busy !== null || !changeAmount.trim()} className={clsx(secondaryClass, "!min-h-11")}><ActionLabel busy={busy === "change"} idle="Save new amount" /></button>
      </div>
    </section>}
    </div>
    </div>
  </DetailDrawer>;
}
