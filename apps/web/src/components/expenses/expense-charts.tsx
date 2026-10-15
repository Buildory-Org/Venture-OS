"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { addMonths, expenseTagKey, monthsBetween, nextOccurrence } from "@venture-studio/contracts";
import { AutoHeight } from "@/components/ui/auto-height";
import { ArrowUpRight, Hash, Home, Layers3, Wallet } from "@/components/ui/icons";
import { prefersReducedMotion } from "@/lib/motion";
import type { ExpenseCompany } from "@venture-studio/contracts";
import type { Expense, ExpenseCategory } from "@/lib/expenses-api";
import { CompanyAvatar } from "./expense-company";
import { dayLabel, monthLabel, paidIn, REPEAT_LABEL, scopeKey, scopeLabel, thisMonth, todayLocal } from "./expense-shared";
import { useMoney } from "./expense-money";

// The expense dashboard above the list (after the reference designs): a dark "spent this month" card, a blue "repeating costs" card, the
// month by category on a dial, a dark "recent expenses" card, the month by tag (when tags are used), and month-by-month columns. No hover effects on the cards: picking a month
// or a category is a click (or Enter); only the month columns show a tooltip when pointed at or focused. Everything animates in once
// when the page opens (bars rise, rings sweep, numbers count up) and stays still for people who ask for reduced motion. Every value is
// also in the list below or on the Monthly tab.

type Lookup = (id: string) => ExpenseCategory | undefined;
type Tab = "monthly" | "repeating";
const fillOf = (color: ExpenseCategory["color"] | undefined) => `var(--expense-${color ?? "neutral"})`;

/** Counts up to `target` once (about a second, easing out); straight to it with reduced motion. */
function useCountUp(target: number, durationMs = 950) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) { queueMicrotask(() => setShown(target)); return; }
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / durationMs);
      setShown(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return shown;
}

/** ₹94,500.00 (or $1,234.50) with the decimals dimmed, counting up. */
function BigMoney({ minor, className, dim = "text-[rgb(var(--ink)/0.45)]" }: { minor: number; className?: string; dim?: string }) {
  const money = useMoney();
  const [whole, fraction] = money.split(useCountUp(minor));
  return <span className={clsx("font-extrabold tracking-[-0.02em]", className)} aria-label={money.format(minor)}><span aria-hidden="true">{whole}<span className={dim}>{fraction}</span></span></span>;
}

/** The round arrow in a card's corner: white on the blue card, the card's ink (white on dark, near-black on white) elsewhere. */
function CornerButton({ label, onClick, onBlue }: { label: string; onClick: () => void; onBlue?: boolean }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-transform duration-150 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2", onBlue ? "border-white/25 text-white focus-visible:ring-white" : "border-[rgb(var(--ink)/0.25)] text-[rgb(var(--ink))] focus-visible:ring-[rgb(var(--ink))]")}><ArrowUpRight size={17} aria-hidden="true" /></button>;
}

/** A ring of thick segments drawn as strokes, each sweeping in after the one before. */
function Ring({ slices, size, radius, width, cap = "butt", gap = 0.02, track }: { slices: { key: string; value: number; stroke: string }[]; size: number; radius: number; width: number; cap?: "butt" | "round"; gap?: number; track?: string }) {
  const circumference = 2 * Math.PI * radius;
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const capShare = cap === "round" ? width / circumference : 0;
  const offsets = slices.map((_, index) => slices.slice(0, index).reduce((sum, slice) => sum + slice.value, 0) / (total || 1));
  return <g>
    {track && <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={track} strokeWidth={width + 10} />}
    {slices.map((slice, index) => {
      const share = slice.value / (total || 1);
      const length = Math.max(0.001, (share - (slices.length > 1 ? gap + capShare : 0)) * circumference);
      return <circle key={slice.key} cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={slice.stroke} strokeWidth={width} strokeLinecap={cap}
        strokeDasharray={`${length} ${circumference}`} transform={`rotate(${-90 + (offsets[index]! + (slices.length > 1 ? (gap + capShare) / 2 : 0)) * 360} ${size / 2} ${size / 2})`}
        className="vso-sweep" style={{ "--circ": circumference, "--delay": `${120 + index * 140}ms` } as React.CSSProperties} />;
    })}
  </g>;
}

export type DashboardProps = {
  /** Expenses after every filter but the category (the dial shows them all), and with it. */
  scoped: Expense[]; matching: Expense[];
  month: string; onMonth: (month: string) => void; category: string; onCategory: (id: string) => void;
  /** Expenses after every filter but the tag (the tag totals show them all), the tag picked (its key), picking one, and a tag's name. */
  tagged: Expense[]; tag: string; onTag: (key: string) => void; tagName: (key: string) => string;
  findCategory: Lookup; findCompany: (id: string | null | undefined) => ExpenseCompany | undefined; ventureName: (id: string) => string;
  /** The Office tab (or one venture): the dark card splits by category instead of by where. */
  fixedWhere?: string; onOpen: (expense: Expense) => void; onTab: (tab: Tab) => void; onSeeAll: () => void;
};

export function ExpenseDashboard(props: DashboardProps) {
  return <div className="grid grid-cols-1 gap-4">
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <SpentCard {...props} />
      <div className="grid grid-cols-1 content-start gap-4">
        <RepeatingCard {...props} />
        <CategoryDial {...props} />
      </div>
      <RecentCard {...props} />
    </div>
    <TagTotals {...props} />
    <MonthColumns {...props} />
  </div>;
}

// ---- Ink (white in the light theme, near-black in the dark): spent this month -----------------------------------------------------

function SpentCard({ matching, month, findCategory, ventureName, fixedWhere, onTab }: DashboardProps) {
  const money = useMoney();
  const rows = paidIn(matching, month);
  const total = money.sum(rows);
  const repeating = money.sum(rows.filter((row) => row.expense.repeat !== "none"));
  const before = money.sum(paidIn(matching, addMonths(month, -1)));
  const change = before ? Math.round(((total - before) / before) * 100) : null;
  // Where it went (or, on the Office tab, by category): the three biggest, the rest together.
  const buckets = new Map<string, { label: string; paise: number }>();
  for (const { expense, day } of rows) {
    const key = fixedWhere ? expense.categoryId : expense.scope.kind === "venture" ? "ventures" : expense.scope.kind;
    const label = fixedWhere ? findCategory(expense.categoryId)?.name ?? "Other" : expense.scope.kind === "venture" ? "Ventures" : expense.scope.kind === "office" ? "Office" : "Personal";
    const bucket = buckets.get(key) ?? { label, paise: 0 };
    bucket.paise += money.value(expense, day);
    buckets.set(key, bucket);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.paise - a.paise);
  const parts = sorted.length > 3 ? [...sorted.slice(0, 2), { label: "Other", paise: sorted.slice(2).reduce((sum, item) => sum + item.paise, 0) }] : sorted;
  const strokes = ["url(#spent-blue)", "var(--card-slice)", "url(#spent-stripes)"];
  const ventureCount = new Set(rows.filter((row) => row.expense.scope.kind === "venture").map((row) => scopeLabel(row.expense.scope, ventureName))).size;
  const repeatingShare = total ? repeating / total : 0;
  const gradientId = useId().replace(/:/g, "");

  return <section aria-label={`Spent in ${monthLabel(month)}`} className="vso-card-ink vso-fade-up flex min-h-[25rem] flex-col rounded-[1.75rem] p-5 sm:p-6">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-lg font-semibold">Spent in {monthLabel(month)}</h3>{change !== null && <p className="mt-0.5 text-xs text-[rgb(var(--ink)/0.55)]">{change >= 0 ? "+" : ""}{change}% vs {monthLabel(addMonths(month, -1))}</p>}</div>
      <CornerButton label="Open the month by month view" onClick={() => onTab("monthly")} />
    </div>
    <BigMoney minor={total} className="mt-5 block text-4xl" />
    <div className="mt-5">
      <div className="flex justify-end text-[11px] text-[rgb(var(--ink)/0.6)]"><span className="tabular-nums">{money.format(total)}</span></div>
      <div className="vso-stripes-ink mt-1 h-3 overflow-hidden rounded-full bg-[rgb(var(--ink)/0.05)]" role="img" aria-label={`${money.format(repeating)} repeating, ${money.format(total - repeating)} one-time`}>
        <div className="vso-grow-x h-full rounded-full bg-gradient-to-r from-[#1d4ed8] to-[#3b82f6]" style={{ width: `${Math.max(repeatingShare * 100, repeating ? 4 : 0)}%`, "--delay": "250ms" } as React.CSSProperties} />
      </div>
      <p className="mt-2 text-xs text-[rgb(var(--ink)/0.6)]"><span className="font-semibold tabular-nums text-[rgb(var(--ink))]">{money.format(repeating)}</span> repeating · <span className="tabular-nums">{money.format(total - repeating)}</span> one-time</p>
    </div>
    <div className="mt-auto flex flex-wrap items-center gap-5 pt-6">
      <svg viewBox="0 0 140 140" className="h-44 w-44 shrink-0" role="img" aria-label={parts.map((part) => `${part.label} ${money.format(part.paise)}`).join(", ") || "Nothing spent"}>
        <defs>
          <linearGradient id={`${gradientId}-blue`} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#60a5fa" /><stop offset="100%" stopColor="#1d4ed8" /></linearGradient>
          <pattern id={`${gradientId}-stripes`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--card-stripe-bg)" /><rect width="2" height="6" fill="var(--card-stripe-line)" /></pattern>
        </defs>
        {parts.length ? <Ring size={140} radius={52} width={26} gap={0.025} slices={parts.map((part, index) => ({ key: part.label, value: part.paise, stroke: strokes[index]!.replace("spent", gradientId) }))} /> : <circle cx={70} cy={70} r={52} fill="none" stroke="var(--card-track)" strokeWidth={26} />}
      </svg>
      <ul className="grid gap-2 text-sm">
        {parts.map((part, index) => <li key={part.label} className="flex items-center gap-2"><span aria-hidden="true" className={clsx("h-2.5 w-2.5 rounded-full", index === 0 ? "bg-[#3b82f6]" : index === 1 ? "bg-[var(--card-slice)]" : "vso-stripes-ink bg-[rgb(var(--ink)/0.2)]")} /><span className="text-[rgb(var(--ink)/0.85)]">{part.label}</span><span className="tabular-nums text-[rgb(var(--ink)/0.5)]">{money.compact(part.paise)}</span></li>)}
        {!parts.length && <li className="text-[rgb(var(--ink)/0.5)]">Nothing spent yet</li>}
        {!fixedWhere && ventureCount > 1 && <li className="text-[11px] text-[rgb(var(--ink)/0.4)]">{ventureCount} ventures</li>}
      </ul>
    </div>
  </section>;
}

// ---- Blue: repeating costs --------------------------------------------------------------------------------------------------------

function RepeatingCard({ scoped, onTab }: DashboardProps) {
  const money = useMoney();
  const today = todayLocal();
  const running = scoped.filter((expense) => expense.repeat !== "none" && expense.date.slice(0, 7) <= thisMonth() && (!expense.endMonth || expense.endMonth >= thisMonth()));
  const monthly = running.reduce((sum, expense) => sum + money.monthly(expense, today), 0);
  const dueSoon = running.filter((expense) => { const next = nextOccurrence(expense, today); return next && Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) <= 7 * 86_400_000; }).length;
  return <section aria-label="Repeating costs" className="vso-card-blue vso-fade-up rounded-[1.75rem] p-5 shadow-e3 sm:p-6" style={{ "--delay": "80ms" } as React.CSSProperties}>
    <div className="flex items-start justify-between gap-3"><h3 className="text-lg font-semibold">Repeating costs</h3><CornerButton label="Open subscriptions" onClick={() => onTab("repeating")} onBlue /></div>
    <p className="mt-3"><BigMoney minor={monthly} className="text-4xl" dim="text-white/60" /> <span className="text-lg font-semibold text-white/85">a month</span></p>
    <p className="mt-2 text-sm text-white/85"><strong className="font-bold">{running.length}</strong> running · <strong className="font-bold">{dueSoon}</strong> due this week · <strong className="font-bold">{money.compact(monthly * 12)}</strong> a year</p>
  </section>;
}

// ---- White: the month by category, on a dial --------------------------------------------------------------------------------------

function CategoryDial({ scoped, month, category, onCategory, findCategory }: DashboardProps) {
  const money = useMoney();
  const rows = paidIn(scoped, month);
  const byCategory = new Map<string, number>();
  for (const { expense, day } of rows) byCategory.set(expense.categoryId, (byCategory.get(expense.categoryId) ?? 0) + money.value(expense, day));
  const sorted = [...byCategory].sort((a, b) => b[1] - a[1]);
  const slices = sorted.length > 5 ? [...sorted.slice(0, 4), ["__other", sorted.slice(4).reduce((sum, [, paise]) => sum + paise, 0)] as [string, number]] : sorted;
  const total = slices.reduce((sum, [, paise]) => sum + paise, 0);
  const nameOf = (id: string) => (id === "__other" ? "Other" : findCategory(id)?.name ?? "Unknown");
  const colorOf = (id: string) => (id === "__other" ? "var(--expense-neutral)" : fillOf(findCategory(id)?.color));
  const size = 220; const center = size / 2;
  const ticks = Array.from({ length: 60 }, (_, index) => index);
  const shown = category && byCategory.has(category) ? category : null;
  return <section aria-label={`${monthLabel(month)} by category`} className="vso-fade-up rounded-[1.75rem] border border-neutral-200 bg-white p-5 shadow-card sm:p-6" style={{ "--delay": "160ms" } as React.CSSProperties}>
    <AutoHeight>
    <h3 className="text-base font-bold text-neutral-900">{monthLabel(month)} by category</h3>
    {!total ? <p className="mt-4 text-sm text-neutral-500">Nothing paid in {monthLabel(month)}.</p> : <>
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto mt-2 block h-auto w-full max-w-[15rem]" role="img" aria-label={slices.map(([id, paise]) => `${nameOf(id)} ${money.format(paise)}`).join(", ")}>
        <Ring size={size} radius={88} width={20} cap="round" gap={0.03} track="var(--color-neutral-100)" slices={slices.map(([id, paise]) => ({ key: id, value: paise, stroke: colorOf(id) }))} />
        {ticks.map((tick) => {
          const angle = (tick / 60) * Math.PI * 2 - Math.PI / 2;
          const long = tick % 5 === 0;
          const [outer, inner] = [64, long ? 57 : 60];
          return <line key={tick} x1={center + outer * Math.cos(angle)} y1={center + outer * Math.sin(angle)} x2={center + inner * Math.cos(angle)} y2={center + inner * Math.sin(angle)} strokeWidth={long ? 2 : 1} strokeLinecap="round" className={long ? "stroke-neutral-700" : "stroke-neutral-300"} />;
        })}
        <text x={center} y={center - 8} textAnchor="middle" className="fill-neutral-500 text-[12px]">{shown ? nameOf(shown) : "Total spend"}</text>
        <text x={center} y={center + 18} textAnchor="middle" className="fill-neutral-900 text-[24px] font-extrabold">{money.compact(shown ? byCategory.get(shown)! : total)}</text>
      </svg>
      <ul className="mt-3 flex flex-wrap justify-center gap-1.5" aria-label="Pick a category">{slices.map(([id, paise]) => <li key={id}>
        <button type="button" disabled={id === "__other"} aria-pressed={category === id} onClick={() => onCategory(category === id ? "" : id)}
          className={clsx("inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-default", category === id ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-700")}>
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: colorOf(id) }} />{nameOf(id)}<span className={clsx("tabular-nums", category === id ? "text-white/70" : "text-neutral-400")}>{money.compact(paise)}</span>
        </button>
      </li>)}</ul>
    </>}
    </AutoHeight>
  </section>;
}

// ---- White: the month by tag ------------------------------------------------------------------------------------------------------

/**
 * What each tag came to in the month (who or what it was for), biggest first, as bars on one scale; picking one filters by it. An
 * expense with two tags counts under both, so the rows can add up to more than the month. Shown once an expense here has a tag.
 */
function TagTotals({ tagged, month, tag, onTag, tagName }: DashboardProps) {
  const money = useMoney();
  if (!tagged.some((expense) => expense.tags?.length)) return null;
  const byTag = new Map<string, number>();
  let untagged = 0;
  for (const { expense, day } of paidIn(tagged, month)) {
    const value = money.value(expense, day);
    const keys = [...new Set((expense.tags ?? []).map(expenseTagKey))];
    if (!keys.length) untagged += value;
    for (const key of keys) byTag.set(key, (byTag.get(key) ?? 0) + value);
  }
  const sorted = [...byTag].sort((a, b) => b[1] - a[1] || tagName(a[0]).localeCompare(tagName(b[0])));
  const shown = sorted.slice(0, 10);
  const max = Math.max(1, ...shown.map(([, paise]) => paise));
  const more = sorted.length - shown.length;
  return <section aria-label={`${monthLabel(month)} by tag`} className="vso-fade-up rounded-[1.75rem] border border-neutral-200 bg-white p-5 shadow-card sm:p-6" style={{ "--delay": "180ms" } as React.CSSProperties}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="text-base font-bold text-neutral-900">{monthLabel(month)} by tag</h3>
      <p className="text-xs text-neutral-500">Pick a tag to see only its expenses. One with two tags counts under both.</p>
    </div>
    {!shown.length ? <p className="mt-4 text-sm text-neutral-500">No tagged expenses in {monthLabel(month)}.</p>
      : <ul className="mt-3 grid grid-cols-1 gap-x-8 md:grid-cols-2" aria-label="Pick a tag">{shown.map(([key, paise], index) => <li key={key}>
        <button type="button" aria-pressed={tag === key} onClick={() => onTag(tag === key ? "" : key)}
          className={clsx("grid min-h-11 w-full grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(4.5rem,auto)] items-center gap-3 rounded-xl px-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", tag === key ? "bg-primary-50" : "hover:bg-neutral-50")}>
          <span className="flex min-w-0 items-center gap-1 text-sm font-semibold text-neutral-800"><Hash size={12} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="truncate">{tagName(key)}</span></span>
          <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-neutral-100"><span className="vso-grow-x block h-full rounded-full bg-primary-600" style={{ width: `${Math.max(2, (paise / max) * 100)}%`, "--delay": `${200 + index * 40}ms` } as React.CSSProperties} /></span>
          <span className="text-right tabular-nums text-sm font-bold text-neutral-900">{money.format(paise)}</span>
        </button>
      </li>)}</ul>}
    {(more > 0 || untagged > 0) && <p className="mt-3 text-xs text-neutral-500">
      {more > 0 && <>{more} more {more === 1 ? "tag" : "tags"} in the Tag filter. </>}
      {untagged > 0 && <>Not tagged: <span className="font-semibold tabular-nums text-neutral-700">{money.format(untagged)}</span>.</>}
    </p>}
  </section>;
}

// ---- Ink: recent expenses -------------------------------------------------------------------------------------------------------

const PILL: Record<Expense["repeat"], string> = { none: "bg-neutral-300 text-neutral-900", monthly: "bg-[#2563eb] text-white", yearly: "bg-[#16a34a] text-white" };
function RecentCard({ scoped, matching, month, findCategory, findCompany, ventureName, onOpen, onSeeAll }: DashboardProps) {
  const money = useMoney();
  const today = todayLocal();
  // This month: what has been paid so far (what is still to come is under Repeating costs). Other months: all of it.
  const rows = paidIn(matching, month).filter((row) => month !== today.slice(0, 7) || row.day <= today);
  const latest = rows.slice(0, 6);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const dayName = (day: string) => (day === today ? `Today, ${dayLabel(day)}` : day === yesterday ? `Yesterday, ${dayLabel(day)}` : dayLabel(day));
  const groups = latest.reduce<{ day: string; items: typeof latest }[]>((list, row) => { const last = list.at(-1); if (last && last.day === row.day) last.items.push(row); else list.push({ day: row.day, items: [row] }); return list; }, []);
  // The month's split by category as one segmented bar, the biggest named above it.
  const byCategory = new Map<string, number>();
  for (const { expense, day } of paidIn(scoped, month)) byCategory.set(expense.categoryId, (byCategory.get(expense.categoryId) ?? 0) + money.value(expense, day));
  const segments = [...byCategory].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const segmentTotal = segments.reduce((sum, [, paise]) => sum + paise, 0);
  const top = segments[0];
  return <section aria-label="Recent expenses" className="vso-card-ink vso-fade-up flex min-h-[25rem] flex-col rounded-[1.75rem] p-5 sm:p-6" style={{ "--delay": "120ms" } as React.CSSProperties}>
    <div className="flex items-start justify-between gap-3"><h3 className="text-lg font-semibold">Recent expenses</h3><CornerButton label="See every expense this month" onClick={onSeeAll} /></div>
    {top && <div className="mt-4">
      <p className="mb-2 inline-flex rounded-full bg-[rgb(var(--ink)/0.12)] px-3 py-1 text-xs font-semibold backdrop-blur">{findCategory(top[0])?.name ?? "Other"} · {Math.round((top[1] / (segmentTotal || 1)) * 100)}%</p>
      <div className="flex h-5 gap-1.5" role="img" aria-label={segments.map(([id, paise]) => `${findCategory(id)?.name ?? "Other"} ${money.format(paise)}`).join(", ")}>
        {segments.map(([id, paise], position) => <span key={id} className="vso-grow-x h-full min-w-5 rounded-full" style={{ flexGrow: paise, flexBasis: 0, background: fillOf(findCategory(id)?.color), "--delay": `${200 + position * 120}ms`, ...(position === 0 ? { boxShadow: "0 0 0 2px rgb(var(--ink) / 0.35)" } : {}) } as React.CSSProperties} />)}
      </div>
    </div>}
    {!latest.length ? <p className="mt-6 text-sm text-[rgb(var(--ink)/0.55)]">Nothing paid in {monthLabel(month)} yet.</p> : <div className="mt-4 grid gap-3">{groups.map((group) => <div key={group.day}>
      <p className="mb-1.5 text-xs text-[rgb(var(--ink)/0.5)]">{dayName(group.day)}</p>
      <ul className="grid gap-1">{group.items.map(({ expense }) => {
        const category = findCategory(expense.categoryId);
        const amount = money.split(money.value(expense, group.day));
        const paidAs = money.original(expense);
        const delay = 260 + latest.findIndex((row) => row.expense.id === expense.id && row.day === group.day) * 70;
        return <li key={`${expense.id}-${group.day}`} className="vso-fade-up" style={{ "--delay": `${delay}ms` } as React.CSSProperties}>
          <button type="button" onClick={() => onOpen(expense)} className="grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl py-1.5 text-left sm:grid-cols-[2.25rem_minmax(0,1fr)_auto_auto] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--ink)/0.7)]">
            <CompanyAvatar company={findCompany(expense.companyId)} name={expense.paidTo} size={36} background={fillOf(category?.color)} />
            <span className="min-w-0"><span className="block truncate text-sm font-semibold">{expense.paidTo}</span><span className="block truncate text-xs text-[rgb(var(--ink)/0.5)]">{category?.name ?? "Other"} · {scopeLabel(expense.scope, ventureName)}</span></span>
            <span className={clsx("hidden rounded-full px-2.5 py-0.5 text-[11px] font-semibold sm:inline", PILL[expense.repeat])}>{REPEAT_LABEL[expense.repeat]}</span>
            <span className="text-right text-sm font-bold tabular-nums">−{amount[0]}<span className="text-[rgb(var(--ink)/0.45)]">{amount[1]}</span>{paidAs && <span className="block text-[11px] font-semibold text-[rgb(var(--ink)/0.5)]">{paidAs}</span>}</span>
          </button>
        </li>;
      })}</ul>
    </div>)}</div>}
    {rows.length > latest.length && <button type="button" onClick={onSeeAll} className="mt-auto pt-3 text-left text-xs font-semibold text-[rgb(var(--ink)/0.7)] underline-offset-2 hover:underline">{rows.length - latest.length} more in {monthLabel(month)}</button>}
  </section>;
}

// ---- White: month by month, as columns --------------------------------------------------------------------------------------------

function windowFor(month: string): string[] {
  let end = month > thisMonth() ? month : addMonths(thisMonth(), 1);
  if (month < addMonths(end, -5)) end = addMonths(month, 3);
  return monthsBetween(addMonths(end, -6), end);
}

/** The axis top and its step, in paise: a round step (1, 2, 2.5 or 5 × a power of ten) about a third of the biggest month. */
function axisFor(maxPaise: number): { top: number; step: number } {
  const target = Math.max(maxPaise, 100) / 3;
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 5, 10].map((times) => times * power).find((value) => value >= target)!;
  return { top: step * Math.ceil(Math.max(maxPaise, 1) / step), step };
}

function MonthColumns({ matching, month, onMonth, findCategory, fixedWhere }: DashboardProps) {
  const money = useMoney();
  const months = windowFor(month);
  const totals = months.map((one) => ({ month: one, rows: paidIn(matching, one) })).map((item) => ({ ...item, total: money.sum(item.rows) }));
  const maxTotal = Math.max(0, ...totals.map((item) => item.total));
  const { top, step } = axisFor(maxTotal);
  const ticks = maxTotal ? Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step) : [0];
  const rows = paidIn(matching, month);
  const part = (kind: string) => money.sum(rows.filter((row) => (kind === "venture" ? row.expense.scope.kind === "venture" : scopeKey(row.expense.scope) === kind)));
  const tiles = [
    { label: "Office", paise: part("office"), icon: Home, tone: "bg-[#fdba74]" },
    { label: "Ventures", paise: part("venture"), icon: Layers3, tone: "bg-[#4ade80]" },
    { label: "Personal", paise: part("personal"), icon: Wallet, tone: "bg-[#60a5fa]" },
  ];
  // The column under the pointer (or keyboard focus) shows its month in a tooltip; a click or Enter picks that month for the page.
  const [hovered, setHovered] = useState<string | null>(null);
  const heightOf = (paise: number) => (maxTotal ? (paise / top) * 100 : 0);
  const tip = totals.find((item) => item.month === hovered);
  const tipIndex = tip ? months.indexOf(tip.month) : -1;
  const tipHeight = tip ? heightOf(tip.total) : 0;
  const plotRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // Above the column, measured so it never leaves the chart: centred on the bar where it fits, held at the edges, and lowered over the
  // tallest bars rather than covering the cards above. Set before paint, so it never shows in the wrong place.
  useLayoutEffect(() => {
    const plot = plotRef.current;
    const node = tipRef.current;
    if (!plot || !node || tipIndex < 0) return;
    const center = ((tipIndex + 0.5) / months.length) * plot.clientWidth;
    node.style.left = `${Math.min(Math.max(center - node.offsetWidth / 2, 0), Math.max(0, plot.clientWidth - node.offsetWidth))}px`;
    node.style.bottom = `${Math.min((tipHeight / 100) * plot.clientHeight + 8, plot.clientHeight - node.offsetHeight + 12)}px`;
  }, [tipIndex, tipHeight, months.length]);
  // What the tooltip splits by: where it was charged, or (on the Office tab or one venture) the category.
  const splitOf = (items: typeof rows) => {
    const buckets = new Map<string, { label: string; paise: number }>();
    for (const { expense, day } of items) {
      const key = fixedWhere ? expense.categoryId : expense.scope.kind;
      const label = fixedWhere ? findCategory(expense.categoryId)?.name ?? "Other" : expense.scope.kind === "venture" ? "Ventures" : expense.scope.kind === "office" ? "Office" : "Personal";
      const bucket = buckets.get(key) ?? { label, paise: 0 };
      bucket.paise += money.value(expense, day);
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.paise - a.paise).slice(0, 3);
  };

  return <section aria-label="Month by month" className="vso-card-soft vso-fade-up overflow-hidden rounded-[1.75rem] border border-neutral-200 p-5 shadow-card sm:p-6" style={{ "--delay": "200ms" } as React.CSSProperties}>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{tiles.map((tile) => <div key={tile.label} className="rounded-2xl bg-neutral-50 p-4 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.04)]">
      <span aria-hidden="true" className={clsx("grid h-9 w-9 place-items-center rounded-xl text-white shadow-sm", tile.tone)}><tile.icon size={17} /></span>
      <p className="mt-3 text-sm text-neutral-500">{tile.label} · {monthLabel(month)}</p>
      <p className="text-xl font-extrabold text-neutral-900">{money.format(tile.paise)}</p>
    </div>)}</div>

    <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="text-sm font-bold text-neutral-900">Month by month</h3>
      <p className="text-xs text-neutral-500">Point at a month for its details; click to show it</p>
    </div>
    <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <div aria-hidden="true" className="relative h-44 min-w-8">
        {ticks.map((tick) => <span key={tick} className="absolute right-0 translate-y-1/2 text-[11px] font-semibold tabular-nums text-neutral-400" style={{ bottom: `${heightOf(tick)}%` }}>{money.compact(tick)}</span>)}
      </div>
      <div ref={plotRef} className="relative h-44">
        {ticks.map((tick) => <span key={tick} aria-hidden="true" className={clsx("absolute inset-x-0 border-t", tick ? "border-neutral-100" : "border-neutral-200")} style={{ bottom: `${heightOf(tick)}%` }} />)}
        <div role="group" aria-label="Spending by month: pick a month" className="absolute inset-0 flex items-end">
          {totals.map((item, position) => {
            const isChosen = item.month === month;
            const height = heightOf(item.total);
            return <button key={item.month} type="button" aria-pressed={isChosen} aria-label={`${monthLabel(item.month)}: ${money.format(item.total)}`}
              onClick={() => onMonth(item.month)} onPointerEnter={() => setHovered(item.month)} onPointerLeave={(event) => { if (event.pointerType === "mouse") setHovered(null); }}
              onFocus={() => setHovered(item.month)} onBlur={() => setHovered(null)}
              className="relative flex h-full flex-1 items-end justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
              {isChosen && item.total > 0 && <span aria-hidden="true" className="vso-fade-up absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold tabular-nums text-[var(--bar-on-label)]" style={{ bottom: `calc(${height}% + 6px)`, "--delay": "700ms" } as React.CSSProperties}>{money.compact(item.total)}</span>}
              <span aria-hidden="true" className={clsx("vso-rise block w-[58%] max-w-[34px] rounded-[9px]", isChosen ? "bg-gradient-to-b from-[#5b7cff] to-[#2343e8] shadow-[0_6px_14px_rgb(35_67_232/0.28)]" : "bg-[linear-gradient(180deg,var(--bar-off-top),var(--bar-off-bottom))]")}
                style={{ height: item.total ? `max(${height}%, 6px)` : "3px", "--delay": `${position * 70}ms` } as React.CSSProperties} />
            </button>;
          })}
        </div>
        {tip && <div ref={tipRef} role="tooltip" className="vso-bar-tip pointer-events-none absolute z-10 w-max min-w-[9rem] max-w-[min(15rem,100%)] rounded-xl bg-[#15171c] px-3 py-2 text-xs text-white shadow-e3 ring-1 ring-white/10">
          <p className="flex items-baseline justify-between gap-3"><span className="font-semibold text-white/60">{monthLabel(tip.month)}</span><span className="text-sm font-extrabold tabular-nums">{money.format(tip.total)}</span></p>
          <p className="mt-0.5 text-white/75">{tip.rows.length ? splitOf(tip.rows).map((bucket) => `${bucket.label} ${money.compact(bucket.paise)}`).join(" · ") : "Nothing paid"}</p>
          {tip.rows.length > 0 && <p className="mt-0.5 text-[11px] text-white/45">{tip.rows.length} {tip.rows.length === 1 ? "expense" : "expenses"}{tip.month !== month ? " · click to show" : ""}</p>}
        </div>}
      </div>
      <span aria-hidden="true" />
      <div aria-hidden="true" className="mt-2 flex">
        {months.map((one) => <span key={one} className={clsx("flex-1 text-center text-[11px]", one === month ? "font-bold text-neutral-900" : "font-semibold text-neutral-400")}>{monthLabel(one).replace(/ \d{4}$/, "")}</span>)}
      </div>
    </div>
  </section>;
}
