"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { addMonths, monthsBetween } from "@venture-studio/contracts";
import { Download } from "@/components/ui/icons";
import { AutoHeight } from "@/components/ui/auto-height";
import { Select } from "@/components/ui/select";
import { Badge, filterControl, Panel, PanelHead, secondaryClass } from "@/components/studio/primitives";
import { downloadCsv, lookups, monthLabel, paidIn, rupees, scopeKey, scopeLabel, type ExpenseData } from "./expense-shared";

type Props = { data: ExpenseData; ventureName: (id: string) => string; month: string; onlyWhere?: string };

/** Month by month: Office, Personal, each venture and the overall total; and the chosen month by category. */
export function ExpenseMonthly({ data, ventureName, month, onlyWhere }: Props) {
  const [span, setSpan] = useState(6);
  const find = useMemo(() => lookups(data.settings), [data.settings]);
  const months = monthsBetween(addMonths(month, 1 - span), month);
  const expenses = onlyWhere ? data.expenses.filter((expense) => scopeKey(expense.scope) === onlyWhere) : data.expenses;
  // Rows: Office and Personal first, then every venture something was charged to in these months, by its total.
  const cells = new Map<string, Map<string, number>>();
  const labels = new Map<string, string>();
  for (const one of months) for (const { expense } of paidIn(expenses, one)) {
    const key = scopeKey(expense.scope);
    labels.set(key, scopeLabel(expense.scope, ventureName));
    const row = cells.get(key) ?? new Map<string, number>();
    row.set(one, (row.get(one) ?? 0) + expense.amountPaise);
    cells.set(key, row);
  }
  const rowTotal = (key: string) => [...(cells.get(key)?.values() ?? [])].reduce((sum, value) => sum + value, 0);
  const keys = [...cells.keys()].sort((a, b) => (a === "office" ? -1 : b === "office" ? 1 : a === "personal" ? -1 : b === "personal" ? 1 : rowTotal(b) - rowTotal(a)));
  const monthTotal = (one: string) => keys.reduce((sum, key) => sum + (cells.get(key)?.get(one) ?? 0), 0);
  const byCategory = new Map<string, number>();
  for (const { expense } of paidIn(expenses, month)) byCategory.set(expense.categoryId, (byCategory.get(expense.categoryId) ?? 0) + expense.amountPaise);
  const categoryRows = [...byCategory].sort((a, b) => b[1] - a[1]);
  const current = monthTotal(month);
  const exportCsv = () => downloadCsv(`expenses-monthly-${months[0]}-to-${month}.csv`, ["Charged to", ...months.map(monthLabel), "Total"],
    [...keys.map((key) => [labels.get(key) ?? key, ...months.map((one) => ((cells.get(key)?.get(one) ?? 0) / 100).toFixed(2)), (rowTotal(key) / 100).toFixed(2)]), ["Overall", ...months.map((one) => (monthTotal(one) / 100).toFixed(2)), (months.reduce((sum, one) => sum + monthTotal(one), 0) / 100).toFixed(2)]]);

  return <div className="grid grid-cols-1 gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Select aria-label="Months shown" className={filterControl(false)} value={String(span)} onChange={(event) => setSpan(Number(event.target.value))}><option value="3">3 months up to {monthLabel(month)}</option><option value="6">6 months up to {monthLabel(month)}</option><option value="12">12 months up to {monthLabel(month)}</option></Select>
      <button type="button" onClick={exportCsv} disabled={!keys.length} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}><Download size={14} />Export CSV</button>
    </div>

    <Panel className="overflow-hidden">
      <PanelHead title="Month by month" aside={<span className="tnum text-xs font-semibold text-neutral-500">{monthLabel(month)}: {rupees(current)}</span>} />
      <AutoHeight>
      {keys.length === 0 ? <p className="p-5 text-sm text-neutral-500">Nothing was paid in these months.</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead><tr className="border-b border-neutral-100 text-left text-xs font-semibold text-neutral-500"><th scope="col" className="px-4 py-2.5 sm:px-5">Charged to</th>{months.map((one) => <th key={one} scope="col" className={clsx("px-3 py-2.5 text-right", one === month && "text-neutral-900")}>{monthLabel(one)}</th>)}<th scope="col" className="px-4 py-2.5 text-right sm:px-5">Total</th></tr></thead>
          <tbody className="divide-y divide-neutral-100">
            {keys.map((key) => <tr key={key}><th scope="row" className="px-4 py-2.5 text-left font-semibold text-neutral-800 sm:px-5">{labels.get(key)}</th>{months.map((one) => <td key={one} className={clsx("tnum px-3 py-2.5 text-right", one === month ? "font-bold text-neutral-900" : "text-neutral-600")}>{cells.get(key)?.get(one) ? rupees(cells.get(key)!.get(one)!) : "–"}</td>)}<td className="tnum px-4 py-2.5 text-right font-bold text-neutral-900 sm:px-5">{rupees(rowTotal(key))}</td></tr>)}
          </tbody>
          <tfoot><tr className="border-t-2 border-neutral-200"><th scope="row" className="px-4 py-3 text-left font-extrabold text-neutral-900 sm:px-5">Overall</th>{months.map((one) => <td key={one} className="tnum px-3 py-3 text-right font-extrabold text-neutral-900">{rupees(monthTotal(one))}</td>)}<td className="tnum px-4 py-3 text-right font-extrabold text-neutral-900 sm:px-5">{rupees(months.reduce((sum, one) => sum + monthTotal(one), 0))}</td></tr></tfoot>
        </table>
      </div>}
      </AutoHeight>
    </Panel>

    <Panel>
      <PanelHead title={`${monthLabel(month)} by category`} />
      <AutoHeight>
      {categoryRows.length === 0 ? <p className="p-5 text-sm text-neutral-500">Nothing was paid in {monthLabel(month)}.</p> : <ul className="grid grid-cols-1 gap-2 p-4 sm:p-5">{categoryRows.map(([id, paise]) => {
        const category = find.category(id);
        const share = current ? Math.round((paise / current) * 100) : 0;
        return <li key={id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5">
          <span className="flex min-w-0 items-center gap-2"><Badge tone={category?.color ?? "neutral"}>{category?.name ?? "Unknown"}</Badge><span className="text-xs text-neutral-500">{share}%</span></span>
          <span className="tnum text-sm font-bold text-neutral-900">{rupees(paise)}</span>
          <span aria-hidden="true" className="col-span-2 h-1.5 overflow-hidden rounded-full bg-neutral-100"><span className="block h-full rounded-full bg-primary-500" style={{ width: `${Math.max(share, 2)}%` }} /></span>
        </li>;
      })}</ul>}
      </AutoHeight>
      {data.hiddenRestricted && <p className="px-5 pb-4 text-xs leading-5 text-neutral-500">Restricted categories you don&apos;t have access to are left out.</p>}
    </Panel>
  </div>;
}
