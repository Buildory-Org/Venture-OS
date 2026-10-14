"use client";
import { useMemo, useState } from "react";
import { expenseAccessAtLeast } from "@venture-studio/contracts";
import { LockKeyhole } from "@/components/ui/icons";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { Empty, PageFrame, PageTitle, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { useStudio } from "@/lib/studio-store";
import type { Expense } from "@/lib/expenses-api";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { ExpenseList } from "@/components/expenses/expense-list";
import { ExpenseMonthly } from "@/components/expenses/expense-monthly";
import { ExpenseSettingsPanel } from "@/components/expenses/expense-settings";
import { ExpenseSubscriptions } from "@/components/expenses/expense-subscriptions";
import { thisMonth, useExpenseData } from "@/components/expenses/expense-shared";

// The expense tracker (docs/expenses.md): every expense by month, the Office on its own, month by month totals, what repeats, and
// (for managers) categories, groups and access. Inside a venture (the sidebar scope) it shows that venture only.

type Tab = "expenses" | "office" | "monthly" | "repeating" | "settings";

export function LiveExpensesScreen() {
  const { data: studio, activeVentureId, setActiveVentureId } = useStudio();
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

  return <PageFrame>
    <PageTitle title="Expenses" description={scoped ? `What ${scoped.name} spends, by month.` : "What the studio spends: ventures, the Office and personal, by month."} action={<RefreshButton busy={busy} onClick={reload} />} />
    {scoped && <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary-100 bg-primary-50 px-4 py-3 text-sm text-primary-900">
      <span>Showing <strong>{scoped.name}</strong> only. New expenses here are charged to it.</span>
      <button type="button" onClick={() => setActiveVentureId("")} className={`${secondaryClass} !min-h-9 !px-3 !text-xs`}>Show everything</button>
    </div>}
    {error && !data && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text"><span className="min-w-0 flex-1">Could not load expenses: {error}</span><button type="button" onClick={reload} className={secondaryClass}>Try again</button></div>}
    {!data && !error && <SkeletonRows rows={6} label="Loading expenses" />}
    {data && <>
      <SlidingTabs tabs={tabs} active={active} onChange={(key) => setTab(key as Tab)} label="Expense views" className="mb-4" />
      <div key={active} {...motion}>
        {active === "expenses" && <ExpenseList data={data} ventures={ventures} ventureName={ventureName} month={month} onMonth={setMonth} fixedWhere={onlyWhere} title={scoped?.name ?? "All"} canEdit={canEdit} onOpen={(expense) => setOpen({ expense })} onAdd={() => setOpen({})} />}
        {active === "office" && <ExpenseList data={data} ventures={ventures} ventureName={ventureName} month={month} onMonth={setMonth} fixedWhere="office" title="Office" canEdit={canEdit} onOpen={(expense) => setOpen({ expense })} onAdd={() => setOpen({ where: "office" })} />}
        {active === "monthly" && <ExpenseMonthly data={data} ventureName={ventureName} month={month} onMonth={setMonth} onlyWhere={onlyWhere} />}
        {active === "repeating" && <ExpenseSubscriptions data={data} ventureName={ventureName} onlyWhere={onlyWhere} onOpen={(expense) => setOpen({ expense })} />}
        {active === "settings" && manage && <ExpenseSettingsPanel settings={data.settings} onChanged={reload} />}
      </div>
    </>}
    {open && data && <ExpenseForm settings={data.settings} ventures={ventures} expense={open.expense} fixedVentureId={scoped?.id} defaultWhere={open.where} canEdit={canEdit} onClose={() => setOpen(null)} onSaved={reload} />}
  </PageFrame>;
}
