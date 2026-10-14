"use client";
import { useMemo, useState } from "react";
import { monthOf, monthlyEquivalentPaise, nextOccurrence } from "@venture-studio/contracts";
import { Repeat } from "@/components/ui/icons";
import { Badge, Empty, Panel, PanelHead } from "@/components/studio/primitives";
import type { Expense } from "@/lib/expenses-api";
import { dayLabel, lookups, monthLabel, REPEAT_LABEL, rupees, scopeKey, scopeLabel, thisMonth, todayLocal, type ExpenseData } from "./expense-shared";

type Props = { data: ExpenseData; ventureName: (id: string) => string; onlyWhere?: string; onOpen: (expense: Expense) => void };
const DAY = 86_400_000;
const daysUntil = (day: string, today: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);

/** Everything that repeats, by group: what it costs a month and a year, and when each is paid next. Stopped ones sit at the end. */
export function ExpenseSubscriptions({ data, ventureName, onlyWhere, onOpen }: Props) {
  const [showStopped, setShowStopped] = useState(false);
  const find = useMemo(() => lookups(data.settings), [data.settings]);
  const today = todayLocal();
  const repeating = data.expenses.filter((expense) => expense.repeat !== "none" && (!onlyWhere || scopeKey(expense.scope) === onlyWhere));
  const notEnded = repeating.filter((expense) => !expense.endMonth || expense.endMonth >= thisMonth());
  // Running: started by this month and not stopped. One that starts later (a new price from next month) isn't counted yet.
  const active = notEnded.filter((expense) => monthOf(expense.date) <= thisMonth());
  const later = notEnded.filter((expense) => monthOf(expense.date) > thisMonth());
  const stopped = repeating.filter((expense) => expense.endMonth && expense.endMonth < thisMonth());
  const monthly = active.reduce((sum, expense) => sum + monthlyEquivalentPaise(expense), 0);
  const upcoming = notEnded.map((expense) => ({ expense, next: nextOccurrence(expense, today) })).filter((row): row is { expense: Expense; next: string } => Boolean(row.next) && daysUntil(row.next!, today) <= 30).sort((a, b) => a.next.localeCompare(b.next));
  const groups = new Map<string, Expense[]>();
  for (const expense of active) { const key = expense.groupId ?? ""; groups.set(key, [...(groups.get(key) ?? []), expense]); }
  const ordered = [...groups].sort(([a], [b]) => (!a ? 1 : !b ? -1 : (find.group(a)?.name ?? "").localeCompare(find.group(b)?.name ?? "")));

  if (!repeating.length) return <Empty icon={Repeat} title="Nothing repeats yet" body="Add an expense that repeats every month or year (a subscription, hosting, a domain) and it shows here with its next payment." />;
  const row = (expense: Expense) => {
    const next = nextOccurrence(expense, today);
    const category = find.category(expense.categoryId);
    return <li key={expense.id}><button type="button" onClick={() => onOpen(expense)} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 sm:px-5">
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-neutral-900">{expense.paidTo}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
          {category && <Badge tone={category.color}>{category.name}</Badge>}
          {!onlyWhere && <span>{scopeLabel(expense.scope, ventureName)}</span>}
          <span>{next ? `Next ${dayLabel(next)}` : "Stopped"}{expense.endMonth ? ` · last month ${monthLabel(expense.endMonth)}` : ""}</span>
        </span>
      </span>
      <span className="text-right"><span className="tnum block text-sm font-extrabold text-neutral-900">{rupees(expense.amountPaise)}</span><span className="block text-xs text-neutral-500">{REPEAT_LABEL[expense.repeat]}</span></span>
    </button></li>;
  };

  return <div className="grid grid-cols-1 gap-4">
    <Panel className="p-4 sm:p-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div><dt className="text-xs font-semibold text-neutral-500">Repeating, a month</dt><dd className="tnum mt-1 text-2xl font-extrabold text-neutral-900">{rupees(monthly)}</dd></div>
        <div><dt className="text-xs font-semibold text-neutral-500">A year</dt><dd className="tnum mt-1 text-lg font-bold text-neutral-800">{rupees(monthly * 12)}</dd></div>
        <div><dt className="text-xs font-semibold text-neutral-500">Running</dt><dd className="tnum mt-1 text-lg font-bold text-neutral-800">{active.length}</dd></div>
      </dl>
      <p className="mt-3 text-xs leading-5 text-neutral-500">Yearly payments count as a twelfth a month here.{data.hiddenRestricted ? " Restricted categories you don't have access to are left out." : ""}</p>
    </Panel>

    {upcoming.length > 0 && <Panel>
      <PanelHead title="Due in the next 30 days" />
      <ul className="divide-y divide-neutral-100">{upcoming.map(({ expense, next }) => {
        const days = daysUntil(next, today);
        return <li key={expense.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5"><button type="button" onClick={() => onOpen(expense)} className="min-w-0 truncate text-left text-sm font-semibold text-neutral-800 hover:text-primary-700">{expense.paidTo}</button><span className="tnum shrink-0 text-xs font-semibold text-neutral-600">{days === 0 ? "Today" : days === 1 ? "Tomorrow" : `In ${days} days`} · {rupees(expense.amountPaise)}</span></li>;
      })}</ul>
    </Panel>}

    {ordered.map(([key, list]) => {
      const group = find.group(key || null);
      const perMonth = list.reduce((sum, expense) => sum + monthlyEquivalentPaise(expense), 0);
      return <Panel key={key || "none"} className="overflow-hidden">
        <PanelHead title={group?.name ?? "Not in a group"} aside={<span className="tnum text-xs font-semibold text-neutral-600">{rupees(perMonth)} a month · {rupees(perMonth * 12)} a year</span>} />
        {group?.note && <p className="px-5 pt-3 text-xs leading-5 text-neutral-500">{group.note}</p>}
        <ul className="divide-y divide-neutral-100">{list.sort((a, b) => b.amountPaise - a.amountPaise).map(row)}</ul>
      </Panel>;
    })}

    {later.length > 0 && <Panel className="overflow-hidden">
      <PanelHead title="Starting later" aside={<span className="text-xs font-semibold text-neutral-500">Not in the totals yet</span>} />
      <ul className="divide-y divide-neutral-100">{later.map(row)}</ul>
    </Panel>}

    {stopped.length > 0 && <div>
      <button type="button" aria-expanded={showStopped} onClick={() => setShowStopped(!showStopped)} className="min-h-9 rounded-lg px-1 text-xs font-semibold text-primary-700 hover:text-primary-800">{showStopped ? "Hide" : "Show"} {stopped.length} stopped</button>
      {showStopped && <Panel className="mt-2 overflow-hidden"><ul className="divide-y divide-neutral-100">{stopped.map(row)}</ul></Panel>}
    </div>}
  </div>;
}
