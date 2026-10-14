"use client";
import { useState } from "react";
import clsx from "clsx";
import { addMonths, LONG_NUMBER, monthOf, nextPaidMonthAfter, type ExpenseInput, type ExpenseScope } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { changeExpenseFrom, createExpense, deleteExpense, updateExpense, type Expense, type ExpenseSettings } from "@/lib/expenses-api";
import { amountText, monthLabel, paiseOf, rupees, scopeKey, thisMonth, todayLocal } from "./expense-shared";

type Venture = { id: string; name: string };
type Props = {
  settings: ExpenseSettings; ventures: Venture[]; expense?: Expense;
  /** Opened inside a venture (the sidebar scope): new expenses are charged to it, shown read-only. */
  fixedVentureId?: string; defaultWhere?: string; canEdit: boolean;
  onClose: () => void; onSaved: () => void;
};

const whereOf = (key: string): ExpenseScope => key === "office" ? { kind: "office" } : key === "personal" ? { kind: "personal" } : { kind: "venture", ventureId: key.slice("venture:".length) };

/** Add or edit one expense. People who can only view see it read-only. */
export function ExpenseForm({ settings, ventures, expense, fixedVentureId, defaultWhere, canEdit, onClose, onSaved }: Props) {
  const usableCategories = settings.categories.filter((category) => !category.archived || category.id === expense?.categoryId);
  const usableGroups = settings.groups.filter((group) => !group.archived || group.id === expense?.groupId);
  const [paidTo, setPaidTo] = useState(expense?.paidTo ?? "");
  const [amount, setAmount] = useState(expense ? amountText(expense.amountPaise) : "");
  const [date, setDate] = useState(expense?.date ?? todayLocal());
  const [categoryId, setCategoryId] = useState(expense?.categoryId ?? usableCategories[0]?.id ?? "");
  const [groupId, setGroupId] = useState(expense?.groupId ?? "");
  const [where, setWhere] = useState(expense ? scopeKey(expense.scope) : fixedVentureId ? `venture:${fixedVentureId}` : defaultWhere ?? "office");
  const [repeat, setRepeat] = useState<ExpenseInput["repeat"]>(expense?.repeat ?? "none");
  const [endMonth, setEndMonth] = useState(expense?.endMonth ?? "");
  const [note, setNote] = useState(expense?.note ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | "change" | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A price change starts in a month the expense is paid in: the next one after this month (for a yearly one, its next renewal).
  const [changeMonth, setChangeMonth] = useState(() => (expense && expense.repeat !== "none" ? nextPaidMonthAfter(expense, monthOf(expense.date) > thisMonth() ? monthOf(expense.date) : thisMonth()) : null) ?? addMonths(thisMonth(), 1));
  const [changeAmount, setChangeAmount] = useState("");
  const dirty = Boolean(paidTo !== (expense?.paidTo ?? "") || amount !== (expense ? amountText(expense.amountPaise) : "") || note !== (expense?.note ?? ""));
  const fixedVenture = fixedVentureId ? ventures.find((venture) => venture.id === fixedVentureId) : undefined;
  const readOnly = !canEdit;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const paise = paiseOf(amount);
    if (!paise) { setError("Enter an amount in rupees, like 1700 or 1700.50."); return; }
    if (LONG_NUMBER.test(paidTo) || LONG_NUMBER.test(note)) { setError("Leave out account, card and phone numbers: only amounts and labels are kept."); return; }
    if (repeat !== "none" && endMonth && endMonth < monthOf(date)) { setError("The last month can't be before the first payment."); return; }
    const input: ExpenseInput = { date, amountPaise: paise, categoryId, groupId: groupId || null, paidTo: paidTo.trim(), scope: whereOf(where), repeat, endMonth: repeat === "none" ? null : endMonth || null, note: note.trim() };
    setBusy("save"); setError("");
    try {
      if (expense) {
        // Only what changed is sent, with the version it was changed from.
        const before: ExpenseInput = { date: expense.date, amountPaise: expense.amountPaise, categoryId: expense.categoryId, groupId: expense.groupId, paidTo: expense.paidTo, scope: expense.scope, repeat: expense.repeat, endMonth: expense.endMonth, note: expense.note };
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
  return <DetailDrawer title={title} subtitle={readOnly ? "You can view expenses but not change them." : "Amounts and labels only: never bank, card or account numbers."} onClose={onClose} dirty={!readOnly && dirty}>
    <form onSubmit={save} className="grid grid-cols-1 gap-4">
      <fieldset disabled={readOnly || busy !== null} className="grid grid-cols-1 gap-4">
        <Field label="Paid to"><input required maxLength={120} className={inputClass} value={paidTo} onChange={(event) => setPaidTo(event.target.value)} placeholder="Anthropic, GoDaddy, Contabo…" autoFocus={!expense} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Amount (₹)"><input required inputMode="decimal" className={inputClass} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1700" /></Field>
          <Field label={repeat === "none" ? "Date paid" : "First payment"}><input required type="date" className={inputClass} value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Category"><Select aria-label="Category" className={inputClass} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{usableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.restricted ? " (restricted)" : ""}{category.archived ? " · archived" : ""}</option>)}</Select></Field>
          <Field label="Group (optional)"><Select aria-label="Group" className={inputClass} value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">No group</option>{usableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}{group.archived ? " · archived" : ""}</option>)}</Select></Field>
        </div>
        {fixedVenture && !expense
          ? <div role="group" aria-label="Charged to" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Charged to · the venture you are in</span><span className="mt-1 block text-sm font-bold text-neutral-900">{fixedVenture.name}</span></div>
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
      {!readOnly && <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy !== null} className={primaryClass}><ActionLabel busy={busy === "save"} idle={expense ? "Save changes" : "Add expense"} /></button>
        {expense && <button type="button" onClick={remove} disabled={busy !== null} className={clsx(secondaryClass, confirmDelete && "!border-danger-text !text-danger-text")}><ActionLabel busy={busy === "delete"} busyText="Deleting…" idle={confirmDelete ? (expense.continuesId ? "Yes, undo the price change" : "Yes, delete it for good") : "Delete"} /></button>}
        {confirmDelete && busy === null && <button type="button" onClick={() => setConfirmDelete(false)} className={secondaryClass}>Keep it</button>}
      </div>}
    </form>
    {expense && expense.repeat !== "none" && !readOnly && <section aria-label="New amount from a month" className="mt-6 grid grid-cols-1 gap-3 rounded-2xl border border-neutral-200 p-4">
      <div><h3 className="text-sm font-bold text-neutral-900">Price changed?</h3><p className="mt-1 text-xs leading-5 text-neutral-500">Set the new amount from a month on. Earlier months keep {rupees(expense.amountPaise)}; editing the amount above would change every month.</p></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="From"><input type="month" className={inputClass} value={changeMonth} min={addMonths(monthOf(expense.date), 1)} onChange={(event) => setChangeMonth(event.target.value)} /></Field>
        <Field label="New amount (₹)"><input inputMode="decimal" className={inputClass} value={changeAmount} onChange={(event) => setChangeAmount(event.target.value)} placeholder="1900" /></Field>
        <button type="button" onClick={changeFrom} disabled={busy !== null || !changeAmount.trim()} className={clsx(secondaryClass, "!min-h-11")}><ActionLabel busy={busy === "change"} idle="Save new amount" /></button>
      </div>
    </section>}
  </DetailDrawer>;
}
