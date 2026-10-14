"use client";
import { useId, useState } from "react";
import clsx from "clsx";
import { addMonths, monthsBetween } from "@venture-studio/contracts";
import { PopCard } from "@/components/sales/pop-card";
import type { Expense, ExpenseCategory } from "@/lib/expenses-api";
import { monthLabel, paidIn, rupees, scopeLabel, sumPaise, thisMonth } from "./expense-shared";

// The charts on the expense tracker's lists: what was spent month by month (pick a month by its column), and the chosen month by
// category (pick a category by its slice or its legend row). Marks are flat so lengths and angles read true; the cards lift and tilt
// toward the cursor for depth. Every value is also in the legend, the list below or the Monthly tab, so nothing hides behind a hover.

type Lookup = (id: string) => ExpenseCategory | undefined;
const fillOf = (color: ExpenseCategory["color"] | undefined) => `var(--expense-${color ?? "neutral"})`;

/** ₹950 · ₹12.4K · ₹1.2L · ₹3.4Cr, for axis ticks and tight labels (paise in). */
export function compactRupees(paise: number): string {
  const rupeesValue = paise / 100;
  const trim = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, ""));
  if (rupeesValue >= 1e7) return `₹${trim(rupeesValue / 1e7)}Cr`;
  if (rupeesValue >= 1e5) return `₹${trim(rupeesValue / 1e5)}L`;
  if (rupeesValue >= 1e3) return `₹${trim(rupeesValue / 1e3)}K`;
  return `₹${Math.round(rupeesValue)}`;
}
/** A round axis top above `max` (1, 2, 2.5 or 5 times a power of ten), in paise. */
function niceCeiling(max: number): number {
  if (max <= 0) return 100_000;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((factor) => factor * power >= max)!;
  return step * power;
}

/** The six months shown: they end at this month (or the chosen month, when it is later), and always include the chosen month. */
function windowFor(month: string): string[] {
  let end = month > thisMonth() ? month : thisMonth();
  if (month < addMonths(end, -5)) end = addMonths(month, 5);
  return monthsBetween(addMonths(end, -5), end);
}

export function SpendTrend({ expenses, month, onMonth, ventureName }: { expenses: Expense[]; month: string; onMonth: (month: string) => void; ventureName: (id: string) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const titleId = useId();
  const months = windowFor(month);
  const totals = months.map((one) => ({ month: one, rows: paidIn(expenses, one) })).map((item) => ({ ...item, total: sumPaise(item.rows) }));
  const top = niceCeiling(Math.max(...totals.map((item) => item.total)));
  const [width, height, left, bottom, topPad] = [560, 220, 52, 28, 14];
  const plot = { w: width - left - 8, h: height - bottom - topPad };
  const band = plot.w / months.length;
  const barWidth = Math.min(24, band * 0.42);
  const y = (paise: number) => topPad + plot.h - (paise / top) * plot.h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * top);
  const focused = totals.find((item) => item.month === (hover ?? month))!;
  // The tooltip: where the money went that month, the biggest three places.
  const places = new Map<string, number>();
  for (const { expense } of focused.rows) { const label = scopeLabel(expense.scope, ventureName); places.set(label, (places.get(label) ?? 0) + expense.amountPaise); }
  const topPlaces = [...places].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const index = months.indexOf(focused.month);

  return <PopCard tilt={4} className="h-full rounded-2xl border border-neutral-200 bg-white p-4 shadow-card sm:p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div><h3 id={titleId} className="text-sm font-bold text-neutral-900">Spending, month by month</h3><p className="text-xs text-neutral-500">Pick a month to see its expenses</p></div>
      <p className="text-right"><span className="block text-2xl font-extrabold text-neutral-900">{rupees(focused.total)}</span><span className="text-xs font-semibold text-neutral-500">{monthLabel(focused.month)} · {focused.rows.length} {focused.rows.length === 1 ? "expense" : "expenses"}</span></p>
    </div>
    <div className="relative mt-3">
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-labelledby={titleId} className="block h-auto w-full overflow-visible">
        {ticks.map((tick) => <g key={tick}>
          <line x1={left} x2={width - 8} y1={y(tick)} y2={y(tick)} className="stroke-neutral-200" strokeWidth={1} />
          <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-neutral-500 text-[11px] tabular-nums">{compactRupees(tick)}</text>
        </g>)}
        {totals.map((item, position) => {
          const x = left + position * band + band / 2;
          const chosen = item.month === month;
          const lit = item.month === hover;
          const barTop = y(item.total);
          const barHeight = Math.max(item.total ? 2 : 0, topPad + plot.h - barTop);
          // A 4px rounded top, square at the baseline.
          const radius = Math.min(4, barHeight / 2, barWidth / 2);
          const path = barHeight ? `M${x - barWidth / 2},${topPad + plot.h} V${barTop + radius} q0,-${radius} ${radius},-${radius} H${x + barWidth / 2 - radius} q${radius},0 ${radius},${radius} V${topPad + plot.h} Z` : "";
          return <g key={item.month} role="button" tabIndex={0} aria-pressed={chosen} aria-label={`${monthLabel(item.month)}: ${rupees(item.total)}${chosen ? ", shown" : ""}`}
            onClick={() => onMonth(item.month)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onMonth(item.month); } }}
            onPointerEnter={() => setHover(item.month)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(item.month)} onBlur={() => setHover(null)}
            className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-primary-600">
            <rect x={left + position * band + 2} y={topPad} width={band - 4} height={plot.h + bottom - 4} rx={10} className={clsx("transition-[fill] duration-150", lit ? "fill-neutral-100" : "fill-transparent")} strokeWidth={2} />
            {path && <path d={path} style={{ fill: chosen ? "var(--color-primary-600)" : lit ? "var(--color-primary-400)" : "var(--color-primary-200)" }} className="transition-[fill] duration-150" />}
            {chosen && item.total > 0 && <text x={x} y={barTop - 6} textAnchor="middle" className="fill-neutral-800 text-[11px] font-bold">{compactRupees(item.total)}</text>}
            <text x={x} y={height - 8} textAnchor="middle" className={clsx("text-[11px]", chosen ? "fill-neutral-900 font-bold" : "fill-neutral-500")}>{monthLabel(item.month).replace(/ \d{4}$/, "")}</text>
          </g>;
        })}
      </svg>
      {hover && <div role="status" className="pointer-events-none absolute top-1 z-10 w-52 rounded-xl border border-neutral-200 bg-white p-3 text-xs shadow-e3" style={{ left: `clamp(0px, calc(${((left + index * band + band / 2) / width) * 100}% - 6.5rem), calc(100% - 13rem))` }}>
        <p className="font-bold text-neutral-900">{monthLabel(focused.month)} · {rupees(focused.total)}</p>
        {topPlaces.length ? <ul className="mt-1.5 space-y-1">{topPlaces.map(([label, paise]) => <li key={label} className="flex justify-between gap-3 text-neutral-600"><span className="truncate">{label}</span><span className="tabular-nums font-semibold text-neutral-800">{rupees(paise)}</span></li>)}</ul> : <p className="mt-1 text-neutral-500">Nothing paid</p>}
      </div>}
    </div>
  </PopCard>;
}

export function CategoryRing({ expenses, month, category, onCategory, findCategory }: { expenses: Expense[]; month: string; category: string; onCategory: (id: string) => void; findCategory: Lookup }) {
  const [hover, setHover] = useState<string | null>(null);
  const titleId = useId();
  const rows = paidIn(expenses, month);
  const byCategory = new Map<string, number>();
  for (const { expense } of rows) byCategory.set(expense.categoryId, (byCategory.get(expense.categoryId) ?? 0) + expense.amountPaise);
  const sorted = [...byCategory].sort((a, b) => b[1] - a[1]);
  // At most six slices: the rest fold into "Other" (never a generated seventh colour).
  const slices = sorted.length > 6 ? [...sorted.slice(0, 5), ["__other", sorted.slice(5).reduce((sum, [, paise]) => sum + paise, 0)] as [string, number]] : sorted;
  const total = slices.reduce((sum, [, paise]) => sum + paise, 0);
  const [size, radius, thickness] = [200, 84, 26];
  const center = size / 2;
  const gap = slices.length > 1 ? 0.035 : 0;
  // Each slice starts where the ones before it end (from 12 o'clock, clockwise).
  const sweeps = slices.map(([, paise]) => (total ? (paise / total) * Math.PI * 2 : 0));
  const arcs = slices.map(([id, paise], position) => {
    const from = -Math.PI / 2 + sweeps.slice(0, position).reduce((sum, sweep) => sum + sweep, 0);
    const start = from + gap / 2; const end = from + sweeps[position]! - gap / 2;
    return { id, paise, start, end: Math.max(start + 0.001, end) };
  });
  const point = (theta: number, r: number) => [center + r * Math.cos(theta), center + r * Math.sin(theta)];
  const arcPath = (start: number, end: number, outer: number) => {
    const inner = outer - thickness;
    if (end - start >= Math.PI * 2 - 0.01) return `M${center},${center - outer} a${outer},${outer} 0 1,1 0,${outer * 2} a${outer},${outer} 0 1,1 0,-${outer * 2} M${center},${center - inner} a${inner},${inner} 0 1,0 0,${inner * 2} a${inner},${inner} 0 1,0 0,-${inner * 2}`;
    const large = end - start > Math.PI ? 1 : 0;
    const [x1, y1] = point(start, outer); const [x2, y2] = point(end, outer); const [x3, y3] = point(end, inner); const [x4, y4] = point(start, inner);
    return `M${x1},${y1} A${outer},${outer} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${inner},${inner} 0 ${large} 0 ${x4},${y4} Z`;
  };
  const nameOf = (id: string) => (id === "__other" ? "Other" : findCategory(id)?.name ?? "Unknown");
  const colorOf = (id: string) => (id === "__other" ? "var(--expense-neutral)" : fillOf(findCategory(id)?.color));
  const lit = hover ?? (category && byCategory.has(category) ? category : null);
  const litPaise = lit ? (slices.find(([id]) => id === lit)?.[1] ?? 0) : total;
  const pick = (id: string) => { if (id !== "__other") onCategory(category === id ? "" : id); };

  return <PopCard tilt={4} className="h-full rounded-2xl border border-neutral-200 bg-white p-4 shadow-card sm:p-5">
    <h3 id={titleId} className="text-sm font-bold text-neutral-900">{monthLabel(month)} by category</h3>
    <p className="text-xs text-neutral-500">Pick a category to list only it</p>
    {!total ? <p className="mt-6 text-sm text-neutral-500">Nothing paid in {monthLabel(month)}.</p> : <div className="mt-3 grid grid-cols-1 items-center gap-4 sm:grid-cols-[minmax(0,11rem)_1fr]">
      <svg viewBox={`0 0 ${size} ${size}`} role="group" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[11rem] overflow-visible">
        {arcs.map((arc) => {
          const active = lit === arc.id;
          return <path key={arc.id} d={arcPath(arc.start, arc.end, active ? radius + 6 : radius)} style={{ fill: colorOf(arc.id) }} opacity={lit && !active ? 0.45 : 1}
            role="button" tabIndex={arc.id === "__other" ? -1 : 0} aria-label={`${nameOf(arc.id)}: ${rupees(arc.paise)}, ${Math.round((arc.paise / total) * 100)}%`} aria-pressed={category === arc.id}
            onPointerEnter={() => setHover(arc.id)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(arc.id)} onBlur={() => setHover(null)}
            onClick={() => pick(arc.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(arc.id); } }}
            className={clsx("outline-none transition-[opacity] duration-150", arc.id !== "__other" && "cursor-pointer")} />;
        })}
        <text x={center} y={center - 4} textAnchor="middle" className="fill-neutral-900 text-[19px] font-extrabold">{compactRupees(litPaise)}</text>
        <text x={center} y={center + 16} textAnchor="middle" className="fill-neutral-500 text-[11px]">{lit ? nameOf(lit) : "in total"}</text>
      </svg>
      <ul className="grid grid-cols-1 gap-0.5">{slices.map(([id, paise]) => <li key={id}>
        <button type="button" disabled={id === "__other"} onClick={() => pick(id)} onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(null)} aria-pressed={category === id}
          className={clsx("grid w-full grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors duration-150 disabled:cursor-default", category === id ? "bg-primary-50" : "hover:bg-neutral-50")}>
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: colorOf(id) }} />
          <span className="truncate font-semibold text-neutral-800">{nameOf(id)}</span>
          <span className="tabular-nums text-neutral-600">{rupees(paise)} <span className="text-neutral-400">· {Math.round((paise / total) * 100)}%</span></span>
        </button>
      </li>)}</ul>
    </div>}
  </PopCard>;
}
