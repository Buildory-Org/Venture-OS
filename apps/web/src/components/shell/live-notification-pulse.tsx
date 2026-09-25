"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, X } from "@/components/ui/icons";
import { listLiveNotifications, readLiveNotification, snoozeLiveReminder } from "@/lib/studio-api";
import { notificationRefreshEvent, notificationSnapshotEvent } from "@/lib/notification-events";

type Notification = Awaited<ReturnType<typeof listLiveNotifications>>[number];
type Toast = { item: Notification; count: number };
const pollMs = 15_000;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The action failed. Please try again.";
const reminderId = (item: Notification) => item.type === "reminder" ? item.reminderId ?? (item.resourceType === "reminder" ? item.resourceId : undefined) : undefined;

export function LiveNotificationPulse({ userId }: { userId: string }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const seenIdsRef = useRef<Set<string> | null>(null);
  const pollRef = useRef<() => void>(() => {});
  const inFlightRef = useRef(false);
  const bellRef = useRef<HTMLAnchorElement>(null);
  const toastRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      if (inFlightRef.current || document.visibilityState === "hidden") return;
      inFlightRef.current = true;
      try {
        const next = await listLiveNotifications();
        if (!active || next.some((item) => item.userId !== userId)) return;
        setItems(next);
        if (seenIdsRef.current) {
          const unseen = next.filter((item) => !item.readAt && !seenIdsRef.current!.has(item.id));
          if (unseen.length) {
            const item = unseen.find((entry) => entry.type === "reminder" || entry.type === "deadline_warning") ?? unseen[0];
            setToasts((current) => [{ item, count: unseen.length }, ...current].slice(0, 3));
            setActionError("");
          }
          next.forEach((item) => seenIdsRef.current!.add(item.id));
        } else seenIdsRef.current = new Set(next.map((item) => item.id));
        window.dispatchEvent(new CustomEvent(notificationSnapshotEvent, { detail: next }));
      } catch { /* The inbox keeps its last good count; it shows request errors on open. */ }
      finally { inFlightRef.current = false; }
    }
    pollRef.current = () => { void poll(); };
    queueMicrotask(() => { if (active) void poll(); });
    const interval = window.setInterval(() => { void poll(); }, pollMs);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    const onRefresh = () => { void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(notificationRefreshEvent, onRefresh);
    return () => {
      active = false; window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(notificationRefreshEvent, onRefresh);
    };
  }, [userId]);

  const unread = items.filter((item) => !item.readAt).length;
  const toast = toasts[0];
  const dismiss = () => {
    const returnFocus = toastRef.current?.contains(document.activeElement);
    setToasts((current) => current.slice(1)); setActionError("");
    if (returnFocus) requestAnimationFrame(() => bellRef.current?.focus());
  };

  async function markRead(item: Notification) {
    setBusy(true); setActionError("");
    try {
      await readLiveNotification(item.id);
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
      dismiss(); pollRef.current();
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function snooze(item: Notification, value: string) {
    const id = reminderId(item);
    if (!id || !value) return;
    setBusy(true); setActionError("");
    try {
      await snoozeLiveReminder(id, value === "never" ? "never" : Number(value) as 10 | 20 | 30);
      dismiss(); pollRef.current();
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  return <>
    <Link ref={bellRef} href="/notifications/live" aria-label={`Open notifications, ${unread}${unread >= 100 ? " or more" : ""} unread`} className="relative grid h-10 w-10 place-items-center rounded-xl text-neutral-500 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Bell size={18} />{unread > 0 && <span aria-hidden="true" className="absolute -right-1 -top-0.5 grid h-4 min-w-4 place-items-center rounded-md bg-[var(--color-primary-700)] px-0.5 text-[9px] font-bold leading-none text-white">{unread >= 100 ? "99+" : unread}</span>}</Link>
    {toast && <aside ref={toastRef} role="status" aria-label="New in-app notification" className="fixed right-3 top-16 z-30 w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-[var(--color-neutral-200)] bg-white p-4 text-left shadow-[0_12px_34px_rgba(38,38,55,.16)] sm:right-5">
      <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-700)]"><Bell size={17} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[.1em] text-[var(--color-primary-700)]">{toast.count > 1 ? `${toast.count} new notifications` : "New notification"}</p><h2 className="mt-1 break-words text-xs font-semibold text-[var(--color-neutral-800)]">{toast.item.title}</h2><p className="mt-1 line-clamp-3 break-words text-xs leading-5 text-[var(--color-neutral-500)]">{toast.item.body}</p></div><button type="button" onClick={dismiss} aria-label="Dismiss notification" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-neutral-400)] hover:bg-[var(--color-neutral-100)]"><X size={16} /></button></div>
      {actionError && <p role="alert" className="mt-3 text-xs text-red-700">{actionError}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2"><Link href={toast.item.resourceType === "task" ? `/tasks/live?task=${encodeURIComponent(toast.item.resourceId)}` : "/notifications/live"} onClick={dismiss} className="inline-flex min-h-9 items-center rounded-lg bg-[var(--color-primary-100)] px-3 text-[11px] font-semibold text-[var(--color-primary-700)]">{toast.item.resourceType === "task" ? "Open task" : "Open inbox"}</Link>{reminderId(toast.item) && <Select aria-label={`Snooze ${toast.item.title}`} disabled={busy} defaultValue="" onChange={(event) => { const value = event.currentTarget.value; event.currentTarget.value = ""; void snooze(toast.item, value); }} className="min-h-9 rounded-lg border border-[var(--color-neutral-200)] bg-white px-2 text-[11px] font-semibold text-[var(--color-neutral-700)]"><option value="">Snooze…</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option><option value="never">Never</option></Select>}<button type="button" disabled={busy} onClick={() => void markRead(toast.item)} className="min-h-9 px-2 text-[11px] font-semibold text-[var(--color-neutral-500)] disabled:opacity-40">Mark read</button></div>
    </aside>}
  </>;
}
