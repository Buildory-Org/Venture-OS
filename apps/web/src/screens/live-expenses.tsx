"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { addMonths, expenseAccessAtLeast } from "@venture-studio/contracts";
import { ChevronLeft, ChevronRight, LockKeyhole } from "@/components/ui/icons";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { Empty, HeaderActions, PageFrame, PageTitle, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { useStudio } from "@/lib/studio-store";
import type { Expense } from "@/lib/expenses-api";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { ExpenseList } from "@/components/expenses/expense-list";
import { ExpenseMonthly } from "@/components/expenses/expense-monthly";
import { ExpenseSettingsPanel } from "@/components/expenses/expense-settings";
import { ExpenseSubscriptions } from "@/components/expenses/expense-subscriptions";
import { monthLabel, thisMonth, useExpenseData } from "@/components/expenses/expense-shared";

// The expense tracker (docs/expenses.md): every expense by month, the Office on its own, month by month totals, what repeats, and
// (for managers) categories, groups and access. Inside a venture (the sidebar scope) it shows that venture only.

type Tab = "expenses" | "office" | "monthly" | "repeating" | "settings";

export function LiveExpensesScreen() {
  const { data: studio, activeVentureId } = useStudio();
  const { data, error, noAccess, busy, reload } = useExpenseData();
  const [tab, setTab] = useState<Tab>("expenses");
  const [month, setMonth] = useState(thisMonth());
  const [open, setOpen] = useState<{ expense?: Expense; where?: string } | null>(null);
  const ventures = useMemo(() => studio.ventures.map((venture) => ({ id: venture.id, name: venture.name })), [studio.ventures]);
  const ventureName = (id: string) => ventures.find((venture) => venture.id === id)?.name ?? "A venture no longer listed";
  const scoped = activeVentureId ? ventures.find((venture) => venture.id === activeVentureId) : undefined;
  const level = data?.settings.me.level ?? "none";
  const canEdit = expenseAccessAtLeast(level, "edit");
  const manage = level === "manage";
  const tabs = [
    { key: "expenses", label: "Expenses" }, ...(scoped ? [] : [{ key: "office", label: "Office" }]),
    { key: "monthly", label: "Monthly" }, { key: "repeating", label: "Subscriptions" }, ...(manage ? [{ key: "settings", label: "Settings" }] : []),
  ];
  const active: Tab = tabs.some((item) => item.key === tab) ? tab : "expenses";
  const motion = useTabMotion(active, tabs.map((item) => item.key));
  const onlyWhere = scoped ? `venture:${scoped.id}` : undefined;

  if (noAccess) return <PageFrame><PageTitle title="Expenses" description="What the studio spends, by month." /><Empty icon={LockKeyhole} tone="neutral" title="You don't have access to expenses" body="Someone who manages expenses can give you access in the tracker's settings." /></PageFrame>;

  // The month every list and chart shows; Subscriptions and Settings don't depend on one.
  const usesMonth = active === "expenses" || active === "office" || active === "monthly";
  return <PageFrame>
    <PageTitle title="Expenses" description={scoped ? `What ${scoped.name} spends, by month. Pick All ventures in the sidebar for everything.` : "What the studio spends: ventures, the Office and personal, by month."}
      action={<HeaderActions>{usesMonth && <MonthPicker month={month} onMonth={setMonth} />}<RefreshButton busy={busy} onClick={reload} /></HeaderActions>} />
    {error && !data && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text"><span className="min-w-0 flex-1">Could not load expenses: {error}</span><button type="button" onClick={reload} className={secondaryClass}>Try again</button></div>}
    {!data && !error && <SkeletonRows rows={6} label="Loading expenses" />}
    {data && <>
      <SlidingTabs tabs={tabs} active={active} onChange={(key) => setTab(key as Tab)} label="Expense views" className="mb-4" />
      <div key={active} {...motion}>
        {active === "expenses" && <ExpenseList data={data} ventures={ventures} ventureName={ventureName} month={month} onMonth={setMonth} fixedWhere={onlyWhere} title={scoped?.name ?? "All"} canEdit={canEdit} onOpen={(expense) => setOpen({ expense })} onAdd={() => setOpen({})} onTab={setTab} />}
        {active === "office" && <ExpenseList data={data} ventures={ventures} ventureName={ventureName} month={month} onMonth={setMonth} fixedWhere="office" title="Office" canEdit={canEdit} onOpen={(expense) => setOpen({ expense })} onAdd={() => setOpen({ where: "office" })} onTab={setTab} />}
        {active === "monthly" && <ExpenseMonthly data={data} ventureName={ventureName} month={month} onlyWhere={onlyWhere} />}
        {active === "repeating" && <ExpenseSubscriptions data={data} ventureName={ventureName} onlyWhere={onlyWhere} onOpen={(expense) => setOpen({ expense })} />}
        {active === "settings" && manage && <ExpenseSettingsPanel settings={data.settings} onChanged={reload} />}
      </div>
    </>}
    {open && data && <ExpenseForm settings={data.settings} ventures={ventures} expense={open.expense} fixedVentureId={scoped?.id} defaultWhere={open.where} canEdit={canEdit} level={level} onClose={() => setOpen(null)} onSaved={reload} onSettingsChanged={reload} />}
  </PageFrame>;
}

/** Previous month, the month, next month, and back to this month: beside Refresh in the page header. */
function MonthPicker({ month, onMonth }: { month: string; onMonth: (month: string) => void }) {
  return <div role="group" aria-label="Month" className="flex items-center gap-1 rounded-xl border border-neutral-200 bg-white p-1">
    <button type="button" aria-label="Previous month" onClick={() => onMonth(addMonths(month, -1))} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-600 transition-colors duration-150 hover:bg-neutral-100 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><ChevronLeft size={16} /></button>
    <span className="min-w-[4.75rem] text-center text-sm font-bold text-neutral-900" aria-live="polite">{monthLabel(month)}</span>
    <button type="button" aria-label="Next month" onClick={() => onMonth(addMonths(month, 1))} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-600 transition-colors duration-150 hover:bg-neutral-100 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><ChevronRight size={16} /></button>
    {month !== thisMonth() && <button type="button" onClick={() => onMonth(thisMonth())} className={clsx("h-8 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50")}>Today</button>}
  </div>;
}
