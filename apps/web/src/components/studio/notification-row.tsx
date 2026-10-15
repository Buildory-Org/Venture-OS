"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowUpRight, Bell, BellRing, Check, Clock3, Play, Square, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { useSwipeRow } from "@/components/ui/use-swipe-row";
import { Badge, DetailDrawer } from "@/components/studio/primitives";
import { getLiveNotificationHistory, listLiveNotifications } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";
import { noticeReminderId, notificationHref, rangText, stopExpenseHref } from "@/lib/notification-events";

export type Notice = Awaited<ReturnType<typeof listLiveNotifications>>[number];
export type SnoozeChoice = 10 | 20 | 30 | "never";

const time = (value: string) => new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(new Date(value));
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
/** Square icon buttons for a notice's actions; the name shows as a tooltip and is read out. */
export const iconButton = "grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-neutral-200 bg-white text-neutral-600 transition-[background-color,color,border-color,transform] duration-150 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:pointer-events-none disabled:opacity-40";
export const startButton = "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--color-primary-700)] text-white transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-800)] active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40";

/** The snooze menu behind a clock icon. */
export function SnoozeMenu({ label, disabled, onChoose, className }: { label: string; disabled?: boolean; onChoose: (minutes: SnoozeChoice) => void; className?: string }) {
  // Nothing stays chosen: each pick is an action, so the menu opens fresh every time.
  return <Select aria-label={label} disabled={disabled} value="" icon={<Clock3 size={16} aria-hidden="true" />} onChange={(event) => { const value = event.target.value; if (value) onChoose(value === "never" ? "never" : Number(value) as 10 | 20 | 30); }} className={clsx(iconButton, className)}>
    <option value="10">10 more minutes</option><option value="20">20 more minutes</option><option value="30">30 more minutes</option><option value="never">Cancel reminder</option>
  </Select>;
}

/**
 * One notice in the inbox. A reminder that rang more than once is one row with its count (tap the count, or hold the row, for every
 * time it rang). Swipe it either way, or use ×, to remove it; that never stops a reminder (snooze or cancel does), and one that rings
 * again comes back on top.
 */
export function NotificationRow({ item, leaving, busy, onRead, onRemove, onSnooze, onStart, onHistory }: {
  item: Notice; leaving: boolean; busy: boolean;
  onRead: () => void; onRemove: () => void; onSnooze: (minutes: SnoozeChoice) => void; onStart: () => void; onHistory: () => void;
}) {
  const reminderId = noticeReminderId(item);
  const open = notificationHref(item);
  // Holding opens the ring history, which only reminders have.
  const { ref: rowRef, reset, handlers } = useSwipeRow<HTMLElement>({ onRemove, onHold: item.type === "reminder" ? onHistory : undefined, disabled: busy });
  useEffect(() => { if (!leaving) reset(); }, [leaving, reset]);
  const rang = rangText(item.repeats);
  return <div data-open={!leaving} className="vso-collapse border-b border-neutral-100 last:border-b-0"><div className="overflow-hidden">
    <article ref={rowRef} {...handlers} data-swipe-row className={clsx("flex flex-wrap items-start gap-3 bg-white p-4 transition-colors duration-300 sm:flex-nowrap", !item.readAt && "bg-primary-50/40")}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-700">{item.type === "reminder" ? <BellRing size={17} /> : <Bell size={17} />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-neutral-800">{item.title}</p>{rang && <button type="button" onClick={onHistory} aria-label={`${rang}: see when`} title="See every time it rang" className="inline-flex h-6 items-center rounded-full bg-primary-100 px-2 text-[11px] font-bold tabular-nums text-primary-800 transition-[background-color,transform] duration-150 hover:bg-primary-200 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">×{item.repeats}</button>}<Badge tone={item.readAt ? "neutral" : "blue"}>{item.readAt ? "Read" : "Unread"}</Badge></div>
        <p className="mt-1 break-words text-sm text-neutral-500 [overflow-wrap:anywhere]">{item.body}</p>
        <p className="mt-1 text-xs text-neutral-400">{rang ? `Last rang ${stamp(item.createdAt)}${item.firstAt ? ` · first ${stamp(item.firstAt)}` : ""}` : `${stamp(item.createdAt)} · ${item.type.replaceAll("_", " ")}`}</p>
      </div>
      {/* Beside the text on wider screens; on a phone, a row of their own under it. */}
      <div className="flex shrink-0 basis-full items-center gap-1.5 pl-12 sm:basis-auto sm:pl-0">
        {item.startable && <button type="button" disabled={busy} onClick={onStart} aria-label="Start the task" title="Start the task (stops this reminder)" className={startButton}><Play size={15} aria-hidden="true" /></button>}
        {open.href !== "/notifications/live" && <Link href={open.href} aria-label={open.label} title={open.label} className={iconButton}><ArrowUpRight size={16} aria-hidden="true" /></Link>}
        {item.type === "expense_due" && <Link href={stopExpenseHref(item.resourceId)} aria-label="Stop after this payment" title="Stop after this payment (you confirm in the expense)" className={iconButton}><Square size={14} aria-hidden="true" /></Link>}
        {!item.readAt && <button type="button" disabled={busy} onClick={onRead} aria-label="Mark read" title="Mark read" className={iconButton}><Check size={16} aria-hidden="true" /></button>}
        {reminderId && <SnoozeMenu label={`Snooze ${item.body || item.title}`} disabled={busy} onChoose={onSnooze} />}
        <button type="button" disabled={busy} onClick={onRemove} aria-label="Remove from inbox" title="Remove (or swipe it away)" className="grid h-9 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-700 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:opacity-40"><X size={15} aria-hidden="true" /></button>
      </div>
    </article>
  </div></div>;
}

/** Every time a reminder rang, by day, newest first: a popup on desktop, the whole screen on phones (Back closes it). */
export function NotificationHistory({ item, onClose }: { item: Notice; onClose: () => void }) {
  // Loaded with the day it was loaded on, for "Today" and "Yesterday".
  const [history, setHistory] = useState<(Awaited<ReturnType<typeof getLiveNotificationHistory>> & { today: string; yesterday: string }) | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    getLiveNotificationHistory(item.id).then((value) => {
      const now = new Date();
      const before = new Date(now);
      before.setDate(now.getDate() - 1);
      if (active) setHistory({ ...value, today: now.toDateString(), yesterday: before.toDateString() });
    }, (cause: unknown) => { if (active) setError(describeError(cause, "Could not load when it rang.")); });
    return () => { active = false; };
  }, [item.id]);
  const days = new Map<string, { date: Date; times: string[] }>();
  for (const at of history?.rungAt ?? []) {
    const date = new Date(at);
    const key = date.toDateString();
    const day = days.get(key) ?? { date, times: [] };
    day.times.push(at);
    days.set(key, day);
  }
  const dayName = (key: string, date: Date) => key === history?.today ? "Today" : key === history?.yesterday ? "Yesterday" : new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "short" }).format(date);
  const repeats = history?.repeats ?? item.repeats ?? 1;
  return <DetailDrawer layout="dialog" title={item.body || item.title} subtitle={history ? `Rang ${repeats} ${repeats === 1 ? "time" : "times"} since ${stamp(history.firstAt)}` : "Loading…"} onClose={onClose}>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !history ? <div role="status" aria-label="Loading" className="grid gap-2">{[0, 1, 2].map((index) => <span key={index} className="vso-skeleton h-10 rounded-xl" />)}</div> : <div className="grid gap-5">
      {[...days].map(([key, { date, times }]) => <section key={key} aria-label={dayName(key, date)}>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-[.08em] text-neutral-500">{dayName(key, date)} <span className="font-medium normal-case tracking-normal text-neutral-400">· {times.length} {times.length === 1 ? "time" : "times"}</span></h3>
        <ol className="flex flex-wrap gap-1.5">{times.map((at) => <li key={at} className="rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-neutral-700">{time(at)}</li>)}</ol>
      </section>)}
      {repeats > history.rungAt.length && <p className="text-xs text-neutral-500">The latest {history.rungAt.length} of {repeats} are listed.</p>}
    </div>}
  </DetailDrawer>;
}
