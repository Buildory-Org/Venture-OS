"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import clsx from "clsx";
import type { LeaderboardEntry, LeaderboardPeriod, LeaderboardPerson } from "@venture-studio/contracts";
import { getLeaderboardPerson } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";
import { useExitTransition } from "@/lib/motion";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/studio/primitives";
import { TrendDown, TrendUp, X } from "@/components/ui/icons";

export const METALS = ["vso-medal-gold", "vso-medal-silver", "vso-medal-bronze"] as const;
export const ROLE_LABELS: Record<LeaderboardEntry["role"], string> = { admin: "Admin", venture_head: "Venture head", contributor: "Contributor", reviewer: "Reviewer", learner: "Learner" };
export const PERIOD_LABELS: Record<LeaderboardPeriod, string> = { week: "This week", last_week: "Last week", month: "This month", "30d": "Last 30 days" };
/** A plain share, like "92%" (or a dash when there is nothing to share). */
export const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "–";
export const ordinal = (rank: number) => `${rank}${rank % 100 >= 11 && rank % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][rank % 10] ?? "th"}`;
export const dateRange = (from: string, to: string) => {
  const format = (value: Date) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(value);
  // `to` is the start of the day after the range (or now); show the last day it covers.
  const end = new Date(new Date(to).getTime() - 1);
  return `${format(new Date(from))} – ${format(end)}`;
};
const hoursLabel = (hours: number) => hours < 48 ? `${hours}h` : `${Math.round((hours / 24) * 10) / 10} days`;

/** Up, down, or level against the period before; "New" for someone ranked now and not then. */
export function TrendMark({ entry, className }: { entry: LeaderboardEntry; className?: string }) {
  if (!entry.rank) return null;
  if (entry.previousRank === undefined) return <span className={clsx("rounded-md bg-primary-50 px-1.5 py-0.5 text-[10px] font-bold text-primary-700", className)}>New</span>;
  const moved = entry.previousRank - entry.rank;
  if (!moved) return <span aria-label="Same rank as before" className={clsx("w-8 text-center text-xs font-bold text-neutral-300", className)}>–</span>;
  return <span aria-label={`${moved > 0 ? "Up" : "Down"} ${Math.abs(moved)} since the period before`} className={clsx("inline-flex w-8 items-center justify-center gap-0.5 text-xs font-bold tnum", moved > 0 ? "text-success-text" : "text-danger-text", className)}>{moved > 0 ? <TrendUp size={13} strokeWidth={2.4} /> : <TrendDown size={13} strokeWidth={2.4} />}{Math.abs(moved)}</span>;
}

/** One person's score and the tasks behind it: what each earned and why. */
export function LeaderboardPersonDialog({ entry, period, ventureId, learners, week, onClose }: { entry: LeaderboardEntry; period: LeaderboardPeriod; ventureId?: string; learners: boolean; week?: string; onClose: () => void }) {
  const [person, setPerson] = useState<LeaderboardPerson | null>(null);
  const [error, setError] = useState("");
  const exit = useExitTransition(onClose, 160);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    getLeaderboardPerson(entry.userId, { period, ventureId, learners, week }).then((data) => { if (active) setPerson(data); }, (cause: unknown) => { if (active) setError(describeError(cause, "Could not load this breakdown.")); });
    return () => { active = false; };
  }, [entry.userId, period, ventureId, learners, week]);
  // Focus starts on Close and returns where it was; Escape closes and Tab stays inside, wherever focus is.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current; if (!root) return;
      if (event.key === "Escape") { event.preventDefault(); exit.close(); return; }
      if (event.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0]!; const last = items[items.length - 1]!;
      const inside = root.contains(document.activeElement) && document.activeElement !== root;
      if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stats: [string, string][] = [
    ["On time", `${entry.onTime} of ${entry.tasksDue}`],
    ["Right first time", entry.delivered ? `${entry.firstTimeRight} of ${entry.delivered}` : "–"],
    ["Late on average", entry.averageDaysLate === undefined ? "–" : `${entry.averageDaysLate} days`],
    ["Overdue now", String(entry.overdueNow)],
  ];
  return createPortal(<div data-state={exit.state} className="vso-backdrop fixed inset-0 z-[60] grid place-items-center bg-[#272736]/45 p-0 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) exit.close(); }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="leaderboard-person-title" className="vso-enter-modal thin-scroll flex max-h-[100dvh] w-full max-w-2xl flex-col overflow-y-auto bg-white shadow-2xl outline-none sm:max-h-[min(90dvh,820px)] sm:rounded-3xl">
      <header className="flex items-start gap-4 border-b border-neutral-100 p-5 sm:p-6">
        <ChatAvatar id={entry.userId} name={entry.name} size={52} />
        <div className="min-w-0 flex-1">
          <h2 id="leaderboard-person-title" className="truncate text-lg font-extrabold tracking-[-.02em] text-neutral-900">{entry.name}</h2>
          <p className="mt-0.5 text-sm text-neutral-500">{entry.rank ? `${ordinal(entry.rank)} place` : "Not ranked yet"} · {week ? "Top performers of the week" : PERIOD_LABELS[period]}</p>
        </div>
        <div className="text-right"><p className="text-3xl font-extrabold tracking-[-.04em] text-primary-700 tnum">{entry.score}</p><p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Score</p></div>
        <button ref={closeButton} type="button" onClick={exit.close} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800"><X size={18} /></button>
      </header>
      <div className="grid grid-cols-2 gap-px bg-neutral-100 sm:grid-cols-4">{stats.map(([label, value]) => <div key={label} className="bg-white px-5 py-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p><p className="mt-0.5 text-sm font-bold text-neutral-800 tnum">{value}</p></div>)}</div>
      <div className="flex-1 p-5 sm:p-6">
        <h3 className="text-sm font-bold text-neutral-900">Tasks that counted</h3>
        <p className="mt-1 text-xs leading-5 text-neutral-500">Full credit for on time, less the later it came in, nothing if it wasn&apos;t delivered. Bigger tasks count for more.</p>
        {error ? <EmptyState variant="error" title="Could not load the breakdown" body={error} /> : !person ? <SkeletonRows rows={4} label="Loading the breakdown" /> : <>
          <ul className="mt-4 divide-y divide-neutral-100">{person.tasks.map((task) => {
            const notes = [task.blockedHours ? `${hoursLabel(task.blockedHours)} blocked, added to the due date` : "", task.allowanceHours ? `${hoursLabel(task.allowanceHours)} added: given less time than its estimate` : "", task.firstTimeRight === false ? "Evidence was sent back once" : ""].filter(Boolean);
            return <li key={task.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/tasks/live?task=${encodeURIComponent(task.id)}`} className="text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere] hover:text-primary-700 hover:underline">{task.title}</Link>
                <p className="mt-0.5 text-xs text-neutral-500">Due {new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(task.dueAt))}{task.deliveredAt ? ` · sent ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(task.deliveredAt))}` : ""}</p>
                {notes.map((note) => <p key={note} className="mt-0.5 text-xs text-neutral-400">{note}</p>)}
              </div>
              <span className={clsx("rounded-md px-2 py-1 text-[11px] font-semibold", task.outcome === "on_time" ? "bg-success-surface text-success-text" : task.outcome === "late" ? "bg-warning-surface text-warning-text" : "bg-danger-surface text-danger-text")}>
                {task.outcome === "on_time" ? "On time" : task.outcome === "late" ? `${task.daysLate !== undefined && task.daysLate < 1 ? "Under a day" : `${task.daysLate} days`} late · ${Math.round(task.credit * 100)}%` : "Not delivered"}
              </span>
            </li>;
          })}</ul>
          {person.hidden > 0 && <p className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">{person.hidden} more task{person.hidden === 1 ? "" : "s"} counted in ventures or groups you can&apos;t open.</p>}
        </>}
      </div>
    </section>
  </div>, document.body);
}
