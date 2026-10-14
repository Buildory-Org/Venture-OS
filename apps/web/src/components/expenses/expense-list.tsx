"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { Download, Paperclip, Plus, Repeat } from "@/components/ui/icons";
import { AutoHeight } from "@/components/ui/auto-height";
import { Select } from "@/components/ui/select";
import { Badge, Empty, filterControl, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import type { Expense } from "@/lib/expenses-api";
import { ExpenseDashboard } from "./expense-charts";
import { CompanyAvatar } from "./expense-company";
import { dayLabel, downloadCsv, lookups, monthLabel, paidIn, REPEAT_LABEL, rupees, scopeKey, scopeLabel, sumPaise, type ExpenseData } from "./expense-shared";

type Props = {
  data: ExpenseData; ventures: { id: string; name: string }[]; ventureName: (id: string) => string;
  /** The month shown (picked in the page header, or by a column of the chart). */
  month: string; onMonth: (month: string) => void;
  /** Fixed "where" (the Office tab, or the venture the sidebar is scoped to): its filter is hidden. */
  fixedWhere?: string; title: string; canEdit: boolean; onOpen: (expense: Expense) => void; onAdd: () => void;
  /** The dashboard's corner buttons open these tabs. */
  onTab: (tab: "monthly" | "repeating") => void;
};

/** One month's expenses: one filter row that scopes the charts and the list, the month by month chart, the month by category, and the list. */
export function ExpenseList({ data, ventures, ventureName, month, onMonth, fixedWhere, title, canEdit, onOpen, onAdd, onTab }: Props) {
  const [category, setCategory] = useState("");
  const [group, setGroup] = useState("");
  const [where, setWhere] = useState("");
  const [kind, setKind] = useState<"" | "one" | "repeat">("");
  const [company, setCompany] = useState("");
  const find = useMemo(() => lookups(data.settings), [data.settings]);
  const scopeTo = fixedWhere ?? where;
  // Every filter but the category scopes the category ring (it shows them all, and picks one); the rest also take the category.
  const scoped = data.expenses.filter((expense) => (!group || (group === "none" ? !expense.groupId : expense.groupId === group)) && (!company || expense.companyId === company)
    && (!scopeTo || scopeKey(expense.scope) === scopeTo) && (!kind || (kind === "one" ? expense.repeat === "none" : expense.repeat !== "none")));
  const matching = category ? scoped.filter((expense) => expense.categoryId === category) : scoped;
  const rows = paidIn(matching, month);
  const total = sumPaise(rows);
  const repeating = sumPaise(rows.filter((row) => row.expense.repeat !== "none"));
  const filtered = Boolean(category || group || (!fixedWhere && where) || kind || company);
  const exportCsv = () => downloadCsv(`expenses-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${month}.csv`, ["Date", "Paid to", "Company", "Amount (INR)", "Category", "Group", "Charged to", "Repeats", "Note"],
    rows.map(({ expense, day }) => [day, expense.paidTo, find.company(expense.companyId)?.name ?? "", (expense.amountPaise / 100).toFixed(2), find.category(expense.categoryId)?.name ?? "", find.group(expense.groupId)?.name ?? "", scopeLabel(expense.scope, ventureName), REPEAT_LABEL[expense.repeat], expense.note]));

  return <div className="grid grid-cols-1 gap-4">
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <Select aria-label="Category" className={filterControl(Boolean(category))} value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{data.settings.categories.map((item) => <option key={item.id} value={item.id}>{item.name}{item.archived ? " · archived" : ""}</option>)}</Select>
      {data.settings.groups.length > 0 && <Select aria-label="Group" className={filterControl(Boolean(group))} value={group} onChange={(event) => setGroup(event.target.value)}><option value="">All groups</option><option value="none">No group</option>{data.settings.groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>}
      {data.settings.companies.length > 1 && <Select aria-label="Company" className={filterControl(Boolean(company))} value={company} onChange={(event) => setCompany(event.target.value)}><option value="">All companies</option>{data.settings.companies.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.expenses})</option>)}</Select>}
      {!fixedWhere && <Select aria-label="Charged to" className={filterControl(Boolean(where))} value={where} onChange={(event) => setWhere(event.target.value)}><option value="">Everywhere</option><option value="office">Office</option><option value="personal">Personal</option>{ventures.map((venture) => <option key={venture.id} value={`venture:${venture.id}`}>{venture.name}</option>)}</Select>}
      <Select aria-label="One-time or repeating" className={filterControl(Boolean(kind))} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="">One-time and repeating</option><option value="one">One-time only</option><option value="repeat">Repeating only</option></Select>
      {filtered && <button type="button" onClick={() => { setCategory(""); setGroup(""); setWhere(""); setKind(""); setCompany(""); }} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 hover:text-primary-800">Clear filters</button>}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" onClick={exportCsv} disabled={!rows.length} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}><Download size={14} />Export CSV</button>
        {canEdit && <button type="button" onClick={onAdd} className={clsx(primaryClass, "!min-h-9 !px-3 !text-xs")}><Plus size={14} />Add expense</button>}
      </span>
    </div>

    <ExpenseDashboard key={`${fixedWhere ?? "all"}-${data.expenses.length}`} scoped={scoped} matching={matching} month={month} onMonth={onMonth} category={category} onCategory={setCategory}
      findCategory={find.category} findCompany={find.company} ventureName={ventureName} fixedWhere={fixedWhere} onOpen={onOpen} onTab={onTab}
      onSeeAll={() => document.getElementById("expense-month-list")?.scrollIntoView({ behavior: "smooth", block: "start" })} />
    {(data.hiddenRestricted || data.truncated) && <div className="grid gap-1 text-xs leading-5">
      {data.hiddenRestricted && <p className="text-neutral-500">Totals leave out restricted categories (such as salaries) that you don&apos;t have access to.</p>}
      {data.truncated && <p className="font-semibold text-warning-text">There are more expenses than this page can load: the oldest are left out, so totals may be short.</p>}
    </div>}

    <AutoHeight>
    {rows.length === 0
      ? <Empty title={filtered ? "Nothing matches these filters" : `No expenses in ${monthLabel(month)}`} body={canEdit ? "Add one, or pick another month." : "Pick another month."} action={canEdit && !filtered ? <button type="button" onClick={onAdd} className={primaryClass}><Plus size={15} />Add expense</button> : undefined} />
      : <Panel className="scroll-mt-4 overflow-hidden">
          <div id="expense-month-list" className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-100 px-4 py-3 sm:px-5">
            <h3 className="text-sm font-bold text-neutral-900">{filtered ? "Matching expenses" : `${title} expenses`} · {monthLabel(month)}</h3>
            <span className="text-xs font-semibold text-neutral-500"><span className="tabular-nums text-neutral-800">{rupees(total)}</span> · {rows.length} {rows.length === 1 ? "expense" : "expenses"}{repeating ? <> · repeating <span className="tabular-nums">{rupees(repeating)}</span></> : null}</span>
          </div>
          <ul className="divide-y divide-neutral-100">{rows.map(({ expense, day }) => {
            const cat = find.category(expense.categoryId);
            const grp = find.group(expense.groupId);
            return <li key={expense.id}><button type="button" onClick={() => onOpen(expense)} className="grid w-full grid-cols-[3.25rem_auto_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 sm:px-5">
              <span className="tabular-nums text-xs font-semibold text-neutral-500">{dayLabel(day)}</span>
              <CompanyAvatar company={find.company(expense.companyId)} name={expense.paidTo} size={32} background={cat ? `var(--expense-${cat.color})` : undefined} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-neutral-900">{expense.paidTo}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  {cat && <Badge tone={cat.color}>{cat.name}</Badge>}
                  {grp && <Badge tone={grp.color}>{grp.name}</Badge>}
                  {!fixedWhere && <span className="text-xs text-neutral-500">{scopeLabel(expense.scope, ventureName)}</span>}
                  {expense.repeat !== "none" && <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><Repeat size={12} aria-hidden="true" />{REPEAT_LABEL[expense.repeat]}</span>}
                  {expense.receiptId && <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><Paperclip size={12} aria-hidden="true" />Receipt</span>}
                </span>
              </span>
              <span className="tabular-nums text-sm font-extrabold text-neutral-900">{rupees(expense.amountPaise)}</span>
            </button></li>;
          })}</ul>
        </Panel>}
    </AutoHeight>
  </div>;
}
