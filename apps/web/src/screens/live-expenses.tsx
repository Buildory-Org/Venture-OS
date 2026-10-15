"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "@/components/ui/toast";
import clsx from "clsx";
import { addMonths, EXPENSE_CURRENCIES, expenseAccessAtLeast, expenseTagsIn, type ExpenseCurrency } from "@venture-studio/contracts";
import { ChevronLeft, ChevronRight, LockKeyhole } from "@/components/ui/icons";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { Select } from "@/components/ui/select";
import { Empty, HeaderActions, PageFrame, PageTitle, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { useStudio } from "@/lib/studio-store";
import type { Expense } from "@/lib/expenses-api";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { ExpenseList } from "@/components/expenses/expense-list";
import { ExpenseMonthly } from "@/components/expenses/expense-monthly";
import { ExpenseSettingsPanel } from "@/components/expenses/expense-settings";
import { ExpenseSubscriptions } from "@/components/expenses/expense-subscriptions";
import { monthLabel, thisMonth, useExpenseData } from "@/components/expenses/expense-shared";
import { currencySign, MoneyProvider, useExpenseMoney, useShownCurrency } from "@/components/expenses/expense-money";

// The expense tracker (docs/expenses.md): every expense by month, the Office on its own, month by month totals, what repeats, and
// (for managers) categories, groups and access. Inside a venture (the sidebar scope) it shows that venture only.

type Tab = "expenses" | "office" | "monthly" | "repeating" | "settings";

export function LiveExpensesScreen() {
  const { data: studio, activeVentureId } = useStudio();
  const { data, error, noAccess, busy, reload } = useExpenseData();
  // The currency every total is shown in (rupees unless picked; remembered on this device), and the rates it needs.
  const [shown, setShown] = useShownCurrency();
  const { money, failed, estimated } = useExpenseMoney(data?.expenses, shown);
  const [tab, setTab] = useState<Tab>("expenses");
  const [month, setMonth] = useState(thisMonth());
  const [open, setOpen] = useState<{ expense?: Expense; where?: string; stop?: boolean } | null>(null);
  const ventures = useMemo(() => studio.ventures.map((venture) => ({ id: venture.id, name: venture.name })), [studio.ventures]);
  const ventureName = (id: string) => ventures.find((venture) => venture.id === id)?.name ?? "A venture no longer listed";
  const scoped = activeVentureId ? ventures.find((venture) => venture.id === activeVentureId) : undefined;
  // A notice's link (?expense=…, with &stop=1 for "stop after this payment"): that expense opens once the list is in, also when the
  // page is already open (only the address changes then), and the address goes back to the page's own so Refresh doesn't open it again.
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const linkedId = params.get("expense");
  const linkedStop = params.get("stop") === "1";
  // The address goes back first (through the router), and the popup opens once it has: the popup then adds its own step on top, so
  // Back closes it and leaves the page as it was. Each link opens once (a reload of the list never reopens it); clicked again, again.
  const handledLink = useRef("");
  const reloadedFor = useRef("");
  const pendingLink = useRef<{ expense: Expense | undefined; stop: boolean } | null>(null);
  useEffect(() => {
    if (linkedId) {
      const key = `${linkedId}|${linkedStop}`;
      if (!data || handledLink.current === key) return;
      const expense = data.expenses.find((item) => item.id === linkedId);
      // One added since the page loaded (its notice arrived meanwhile): the list is read again before it counts as gone.
      if (!expense && reloadedFor.current !== key) { reloadedFor.current = key; reload(); return; }
      handledLink.current = key;
      pendingLink.current = { expense, stop: linkedStop };
      router.replace(pathname, { scroll: false });
      return;
    }
    handledLink.current = "";
    reloadedFor.current = "";
    const pending = pendingLink.current;
    if (!pending) return;
    pendingLink.current = null;
    queueMicrotask(() => {
      if (pending.expense) setOpen({ expense: pending.expense, stop: pending.stop });
      else toast({ tone: "info", title: "That expense isn't here any more", body: "It may have been deleted, or you no longer have access to it." });
    });
  }, [data, linkedId, linkedStop, router, pathname, reload]);
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
      action={<HeaderActions>{usesMonth && <MonthPicker month={month} onMonth={setMonth} />}{active !== "settings" && <CurrencyPicker value={shown} onChange={setShown} />}<RefreshButton busy={busy} onClick={reload} /></HeaderActions>} />
    {error && !data && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text"><span className="min-w-0 flex-1">Could not load expenses: {error}</span><button type="button" onClick={reload} className={secondaryClass}>Try again</button></div>}
    {!data && !error && <SkeletonRows rows={6} label="Loading expenses" />}
    {data && <>
      <SlidingTabs tabs={tabs} active={active} onChange={(key) => setTab(key as Tab)} label="Expense views" className="mb-4" />
      {!failed && estimated && active !== "settings" && <p role="status" className="mb-3 rounded-xl bg-warning-surface px-3 py-2 text-xs font-semibold text-warning-text">Couldn&apos;t load exchange rates just now, so repeating payments in other currencies count at their first payment&apos;s rupees. Try Refresh in a moment.</p>}
      {failed && active !== "settings" && <p role="status" className="mb-3 rounded-xl bg-warning-surface px-3 py-2 text-xs font-semibold text-warning-text">Couldn&apos;t load exchange rates just now, so amounts are in rupees. Try Refresh in a moment.</p>}
      {money.currency !== "INR" && active !== "settings" && <p className="mb-3 text-xs text-neutral-500">Amounts in {money.currency}: each payment at the European Central Bank&apos;s reference rate of its day, and exactly as paid when it was paid in {money.currency}.</p>}
      <MoneyProvider value={money}>
      <div key={active} {...motion}>
        {active === "expenses" && <ExpenseList data={data} ventures={ventures} ventureName={ventureName} month={month} onMonth={setMonth} fixedWhere={onlyWhere} title={scoped?.name ?? "All"} canEdit={canEdit} onOpen={(expense) => setOpen({ expense })} onAdd={() => setOpen({})} onTab={setTab} />}
        {active === "office" && <ExpenseList data={data} ventures={ventures} ventureName={ventureName} month={month} onMonth={setMonth} fixedWhere="office" title="Office" canEdit={canEdit} onOpen={(expense) => setOpen({ expense })} onAdd={() => setOpen({ where: "office" })} onTab={setTab} />}
        {active === "monthly" && <ExpenseMonthly data={data} ventureName={ventureName} month={month} onlyWhere={onlyWhere} />}
        {active === "repeating" && <ExpenseSubscriptions data={data} ventureName={ventureName} onlyWhere={onlyWhere} onOpen={(expense) => setOpen({ expense })} />}
        {active === "settings" && manage && <ExpenseSettingsPanel settings={data.settings} onChanged={reload} />}
      </div>
      </MoneyProvider>
    </>}
    {open && data && <ExpenseForm settings={data.settings} ventures={ventures} expense={open.expense} stopAfterNext={open.stop} fixedVentureId={scoped?.id} defaultWhere={open.where} canEdit={canEdit} level={level} knownTags={expenseTagsIn(data.expenses)} onClose={() => setOpen(null)} onSaved={reload} onSettingsChanged={reload} />}
  </PageFrame>;
}

/** The currency amounts are shown in: the rupee first, then the rest, with their signs. */
function CurrencyPicker({ value, onChange }: { value: ExpenseCurrency; onChange: (currency: ExpenseCurrency) => void }) {
  const label = (code: string) => { const sign = currencySign(code); return sign === code ? code : `${sign} ${code}`; };
  return <Select aria-label="Show amounts in" value={value} onChange={(event) => onChange(event.target.value as ExpenseCurrency)} className="!min-h-10 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-bold text-neutral-900">
    {EXPENSE_CURRENCIES.map((code) => <option key={code} value={code}>{label(code)}</option>)}
  </Select>;
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
