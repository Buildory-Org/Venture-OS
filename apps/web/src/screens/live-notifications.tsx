"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, RefreshCw } from "@/components/ui/icons";
import { getLiveNotificationPreferences, getLiveReminder, listLiveNotifications, listLiveReminders, readLiveNotification, snoozeLiveReminder, updateLiveNotificationPreferences } from "@/lib/studio-api";
import { notificationRefreshEvent, notificationSnapshotEvent } from "@/lib/notification-events";
import { Badge, Empty, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { LiveWebPush } from "@/components/studio/live-web-push";

type Notification = Awaited<ReturnType<typeof listLiveNotifications>>[number];
type Preferences = Awaited<ReturnType<typeof getLiveNotificationPreferences>>;
type Reminder = Awaited<ReturnType<typeof listLiveReminders>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const preferenceLabels: Record<keyof Preferences, string> = { email: "Email delivery", webPush: "Web push", mentions: "Mentions", messages: "Direct messages", assignments: "Assignments", reminders: "Reminders" };

export function LiveNotificationsScreen() {
  const [items, setItems] = useState<Notification[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderCursor, setReminderCursor] = useState<string | undefined>();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [revision, setRevision] = useState(0);
  const [linkedReminderId, setLinkedReminderId] = useState("");
  const [linkedReminderError, setLinkedReminderError] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([listLiveNotifications(), listLiveReminders(), getLiveNotificationPreferences()]).then(([nextItems, page, nextPreferences]) => {
      if (active) { setItems(nextItems); setReminders((current) => { const linked = current.find((item) => item.id === new URLSearchParams(window.location.search).get("reminder")); return linked && !page.items.some((item) => item.id === linked.id) ? [linked, ...page.items] : page.items; }); setReminderCursor(page.nextCursor); setPreferences(nextPreferences); setLoading(false); setError(""); }
    }).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load your inbox."); setLoading(false); } }));
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("reminder");
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    let active = true;
    queueMicrotask(() => getLiveReminder(id).then((item) => {
      if (!active) return;
      setLinkedReminderId(id);
      setReminders((current) => current.some((entry) => entry.id === id) ? current : [item, ...current]);
    }).catch(() => { if (active) setLinkedReminderError("The linked reminder is unavailable or no longer accessible."); }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!linkedReminderId || !reminders.some((item) => item.id === linkedReminderId)) return;
    const target = document.getElementById(`reminder-${linkedReminderId}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [linkedReminderId, reminders]);

  useEffect(() => {
    const onSnapshot = (event: Event) => {
      const snapshot = (event as CustomEvent<Notification[]>).detail;
      if (Array.isArray(snapshot)) setItems(snapshot);
    };
    window.addEventListener(notificationSnapshotEvent, onSnapshot);
    return () => window.removeEventListener(notificationSnapshotEvent, onSnapshot);
  }, []);

  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id); setError(""); setResult("");
    try { await action(); setRevision((value) => value + 1); window.dispatchEvent(new Event(notificationRefreshEvent)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the record."); }
    finally { setBusyId(null); }
  }

  async function savePreferences(event: React.FormEvent) {
    event.preventDefault();
    if (!preferences) return;
    setBusyId("preferences"); setError(""); setResult("");
    try { setPreferences(await updateLiveNotificationPreferences(preferences)); setResult("Notification preferences saved."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save preferences."); }
    finally { setBusyId(null); }
  }

  async function moreReminders() {
    if (!reminderCursor) return;
    setBusyId("reminders"); setError("");
    try { const page = await listLiveReminders(reminderCursor); setReminders((current) => [...current, ...page.items]); setReminderCursor(page.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more reminders."); }
    finally { setBusyId(null); }
  }

  const visible = items.filter((item) => !unreadOnly || !item.readAt);
  return <PageFrame>
    <PageTitle title="Notifications" description="Messages, reminders, and delivery preferences for your workspace." action={<button type="button" className={secondaryClass} onClick={() => { setLoading(true); setRevision((value) => value + 1); }}><RefreshCw size={15} />Refresh</button>} />
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {linkedReminderError && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{linkedReminderError}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm font-semibold text-success-text">{result}</p>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
      <Panel><div className="flex gap-2 border-b border-neutral-100 p-3"><button type="button" onClick={() => setUnreadOnly(false)} className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${!unreadOnly ? "bg-primary-700 text-white" : "text-neutral-500 hover:bg-neutral-50"}`}>All</button><button type="button" onClick={() => setUnreadOnly(true)} className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${unreadOnly ? "bg-primary-700 text-white" : "text-neutral-500 hover:bg-neutral-50"}`}>Unread</button></div>
        {loading && !items.length ? <p className="p-8 text-sm text-neutral-500">Loading notifications…</p> : visible.length ? <div className="divide-y divide-neutral-100">{visible.map((item) => {
          const reminderId = item.type === "reminder" ? item.reminderId ?? (item.resourceType === "reminder" ? item.resourceId : undefined) : undefined;
          return <article key={item.id} className={`flex flex-wrap items-start gap-3 p-4 ${!item.readAt ? "bg-primary-50/40" : ""}`}><span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-700"><Bell size={17} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-neutral-800">{item.title}</p><Badge tone={item.readAt ? "neutral" : "blue"}>{item.readAt ? "Read" : "Unread"}</Badge></div><p className="mt-1 text-sm text-neutral-500">{item.body}</p><p className="mt-1 text-xs text-neutral-400">{stamp(item.createdAt)} · {item.type}</p></div><div className="flex flex-wrap gap-2">{item.resourceType === "task" && <Link href={`/tasks/live?task=${encodeURIComponent(item.resourceId)}`} className={secondaryClass}>Open task</Link>}{!item.readAt && <button type="button" disabled={busyId === item.id} onClick={() => act(item.id, () => readLiveNotification(item.id))} className={secondaryClass}>Mark read</button>}{reminderId && <Select aria-label={`Snooze ${item.title}`} disabled={busyId === item.id} defaultValue="" onChange={(event) => { const value = event.target.value; if (value) act(item.id, () => snoozeLiveReminder(reminderId, value === "never" ? "never" : Number(value) as 10 | 20 | 30)); event.currentTarget.value = ""; }} className="min-h-10 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-semibold text-neutral-700"><option value="">Snooze…</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option><option value="never">Never</option></Select>}</div></article>;
        })}</div> : <Empty title="Inbox clear" body="No notifications in this view." />}
      </Panel>
      <div className="space-y-4"><Panel><PanelHead title="Delivery preferences" /><form onSubmit={savePreferences} className="space-y-2 p-4">{preferences ? (Object.keys(preferenceLabels) as (keyof Preferences)[]).map((key) => <label key={key} className="flex min-h-10 items-center justify-between gap-3 rounded-xl bg-neutral-50 px-3 text-sm font-semibold text-neutral-700"><span>{preferenceLabels[key]}</span><input type="checkbox" checked={preferences[key]} onChange={(event) => setPreferences((current) => current ? { ...current, [key]: event.target.checked } : current)} /></label>) : <p className="text-sm text-neutral-500">Loading preferences…</p>}<button disabled={!preferences || busyId === "preferences"} className={`${primaryClass} mt-2`}>Save preferences</button></form></Panel>
        <Panel><PanelHead title="Browser push" /><LiveWebPush preferenceEnabled={preferences?.webPush} /></Panel>
        <Panel><PanelHead title="Your reminders" aside={<Badge tone="blue">{reminders.length}{reminderCursor ? "+" : ""}</Badge>} /><div className="divide-y divide-neutral-100">{reminders.length ? reminders.map((item) => <article key={item.id} id={`reminder-${item.id}`} tabIndex={-1} className={`p-4 outline-none ${linkedReminderId === item.id ? "bg-primary-50 ring-2 ring-inset ring-primary-300" : ""}`}><p className="text-sm font-semibold text-neutral-800">{item.message}</p><p className="mt-1 text-xs text-neutral-500">{stamp(item.scheduledAt)} · {item.state} · {item.timezone}</p>{item.taskId && <Link href={`/tasks/live?task=${encodeURIComponent(item.taskId)}`} className="mt-2 inline-block text-xs font-semibold text-primary-700 underline">Open task</Link>}{item.state === "scheduled" && <Select aria-label={`Snooze reminder ${item.id}`} disabled={busyId === item.id} defaultValue="" onChange={(event) => { const value = event.target.value; if (value) act(item.id, () => snoozeLiveReminder(item.id, value === "never" ? "never" : Number(value) as 10 | 20 | 30)); event.currentTarget.value = ""; }} className="mt-2 block min-h-10 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-semibold text-neutral-700"><option value="">Snooze…</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option><option value="never">Never</option></Select>}</article>) : <Empty title="No reminders" body="Nothing has been scheduled for your account." />}</div>{reminderCursor && <button type="button" disabled={busyId === "reminders"} onClick={moreReminders} className="m-4 text-xs font-semibold text-primary-700 underline">Load more reminders</button>}</Panel>
      </div>
    </div>
  </PageFrame>;
}
