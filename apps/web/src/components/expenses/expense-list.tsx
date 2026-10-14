"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { addMonths } from "@venture-studio/contracts";
import { ChevronLeft, ChevronRight, Download, Plus, Repeat } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { Badge, Empty, filterControl, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import type { Expense } from "@/lib/expenses-api";
import { dayLabel, downloadCsv, lookups, monthLabel, paidIn, REPEAT_LABEL, rupees, scopeKey, scopeLabel, sumPaise, thisMonth, type ExpenseData } from "./expense-shared";

type Props = {
  data: ExpenseData; ventures: { id: string; name: string }[]; ventureName: (id: string) => string;
  month: string; onMonth: (month: string) => void;
  /** Fixed "where" (the Office tab, or the venture the sidebar is scoped to): its filter is hidden. */
  fixedWhere?: string; title: string; canEdit: boolean; onOpen: (expense: Expense) => void; onAdd: () => void;
};

/** One month's expenses with filters, the total for what is shown, and a CSV of it. */
export function ExpenseList({ data, ventures, ventureName, month, onMonth, fixedWhere, title, canEdit, onOpen, onAdd }: Props) {
  const [category, setCategory] = useState("");
  const [group, setGroup] = useState("");
  const [where, setWhere] = useState("");
  const [kind, setKind] = useState<"" | "one" | "repeat">("");
  const find = useMemo(() => lookups(data.settings), [data.settings]);
  const scopeTo = fixedWhere ?? where;
  const rows = paidIn(data.expenses, month).filter(({ expense }) =>
    (!category || expense.categoryId === category) && (!group || (group === "none" ? !expense.groupId : expense.groupId === group))
    && (!scopeTo || scopeKey(expense.scope) === scopeTo) && (!kind || (kind === "one" ? expense.repeat === "none" : expense.repeat !== "none")));
  const total = sumPaise(rows);
  const repeating = sumPaise(rows.filter((row) => row.expense.repeat !== "none"));
  const filtered = Boolean(category || group || (!fixedWhere && where) || kind);
  const exportCsv = () => downloadCsv(`expenses-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${month}.csv`, ["Date", "Paid to", "Amount (INR)", "Category", "Group", "Charged to", "Repeats", "Note"],
    rows.map(({ expense, day }) => [day, expense.paidTo, (expense.amountPaise / 100).toFixed(2), find.category(expense.categoryId)?.name ?? "", find.group(expense.groupId)?.name ?? "", scopeLabel(expense.scope, ventureName), REPEAT_LABEL[expense.repeat], expense.note]));

  return <div className="grid grid-cols-1 gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1">
        <button type="button" aria-label="Previous month" onClick={() => onMonth(addMonths(month, -1))} className={clsx(secondaryClass, "!min-h-9 !px-2.5")}><ChevronLeft size={16} /></button>
        <span className="min-w-28 text-center text-sm font-bold text-neutral-900" aria-live="polite">{monthLabel(month)}</span>
        <button type="button" aria-label="Next month" onClick={() => onMonth(addMonths(month, 1))} className={clsx(secondaryClass, "!min-h-9 !px-2.5")}><ChevronRight size={16} /></button>
        {month !== thisMonth() && <button type="button" onClick={() => onMonth(thisMonth())} className="ml-1 min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 hover:text-primary-800">This month</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={exportCsv} disabled={!rows.length} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}><Download size={14} />Export CSV</button>
        {canEdit && <button type="button" onClick={onAdd} className={clsx(primaryClass, "!min-h-9 !px-3 !text-xs")}><Plus size={14} />Add expense</button>}
      </div>
    </div>

    <div className="flex flex-wrap gap-2" role="group" aria-label="Filters">
      <Select aria-label="Category" className={filterControl(Boolean(category))} value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{data.settings.categories.map((item) => <option key={item.id} value={item.id}>{item.name}{item.archived ? " · archived" : ""}</option>)}</Select>
      {data.settings.groups.length > 0 && <Select aria-label="Group" className={filterControl(Boolean(group))} value={group} onChange={(event) => setGroup(event.target.value)}><option value="">All groups</option><option value="none">No group</option>{data.settings.groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>}
      {!fixedWhere && <Select aria-label="Charged to" className={filterControl(Boolean(where))} value={where} onChange={(event) => setWhere(event.target.value)}><option value="">Everywhere</option><option value="office">Office</option><option value="personal">Personal</option>{ventures.map((venture) => <option key={venture.id} value={`venture:${venture.id}`}>{venture.name}</option>)}</Select>}
      <Select aria-label="One-time or repeating" className={filterControl(Boolean(kind))} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="">One-time and repeating</option><option value="one">One-time only</option><option value="repeat">Repeating only</option></Select>
      {filtered && <button type="button" onClick={() => { setCategory(""); setGroup(""); setWhere(""); setKind(""); }} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 hover:text-primary-800">Clear filters</button>}
    </div>

    <Panel className="p-4 sm:p-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div><dt className="text-xs font-semibold text-neutral-500">{filtered ? "Total for these" : `${title} total`} · {monthLabel(month)}</dt><dd className="tnum mt-1 text-2xl font-extrabold text-neutral-900">{rupees(total)}</dd></div>
        <div><dt className="text-xs font-semibold text-neutral-500">Repeating</dt><dd className="tnum mt-1 text-lg font-bold text-neutral-800">{rupees(repeating)}</dd></div>
        <div><dt className="text-xs font-semibold text-neutral-500">Expenses</dt><dd className="tnum mt-1 text-lg font-bold text-neutral-800">{rows.length}</dd></div>
      </dl>
      {data.hiddenRestricted && <p className="mt-3 text-xs leading-5 text-neutral-500">Totals leave out restricted categories (such as salaries) that you don&apos;t have access to.</p>}
      {data.truncated && <p className="mt-3 text-xs font-semibold leading-5 text-warning-text">There are more expenses than this page can load: the oldest are left out, so totals may be short.</p>}
    </Panel>

    {rows.length === 0
      ? <Empty title={filtered ? "Nothing matches these filters" : `No expenses in ${monthLabel(month)}`} body={canEdit ? "Add one, or pick another month." : "Pick another month."} action={canEdit && !filtered ? <button type="button" onClick={onAdd} className={primaryClass}><Plus size={15} />Add expense</button> : undefined} />
      : <Panel className="overflow-hidden"><ul className="divide-y divide-neutral-100">{rows.map(({ expense, day }) => {
          const cat = find.category(expense.categoryId);
          const grp = find.group(expense.groupId);
          return <li key={expense.id}><button type="button" onClick={() => onOpen(expense)} className="grid w-full grid-cols-[3.25rem_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 sm:px-5">
            <span className="tnum text-xs font-semibold text-neutral-500">{dayLabel(day)}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-neutral-900">{expense.paidTo}</span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                {cat && <Badge tone={cat.color}>{cat.name}</Badge>}
                {grp && <Badge tone={grp.color}>{grp.name}</Badge>}
                {!fixedWhere && <span className="text-xs text-neutral-500">{scopeLabel(expense.scope, ventureName)}</span>}
                {expense.repeat !== "none" && <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><Repeat size={12} aria-hidden="true" />{REPEAT_LABEL[expense.repeat]}</span>}
              </span>
            </span>
            <span className="tnum text-sm font-extrabold text-neutral-900">{rupees(expense.amountPaise)}</span>
          </button></li>;
        })}</ul></Panel>}
  </div>;
}
