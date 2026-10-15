"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, ArrowUpRight, BellRing, Check, Clock3 } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { dismissToast, toast } from "@/components/ui/toast";
import { dismissLiveNotification, getLiveNotificationPreferences, getLiveReminder, listLiveNotifications, listLiveReminders, markLiveNotificationsRead, readLiveNotification, snoozeLiveReminder, StudioApiError, updateLiveNotificationPreferences, updateLiveTask } from "@/lib/studio-api";
import { noticeReminderId, notificationRefreshEvent, notificationSnapshotEvent } from "@/lib/notification-events";
import { iconButton, NotificationHistory, NotificationRow, SnoozeMenu, type SnoozeChoice } from "@/components/studio/notification-row";
import { ActionLabel, Badge, HeaderActions, Notice, PageFrame, PageTitle, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass, SkeletonRows, useFlag } from "@/components/studio/primitives";
import { LiveWebPush } from "@/components/studio/live-web-push";

type Notification = Awaited<ReturnType<typeof listLiveNotifications>>[number];
type Preferences = Awaited<ReturnType<typeof getLiveNotificationPreferences>>;
type Reminder = Awaited<ReturnType<typeof listLiveReminders>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const preferenceLabels: Record<keyof Preferences, string> = { email: "Email delivery", webPush: "Push when the site is closed", mentions: "@mentions in channels", messages: "Direct messages", assignments: "Assignments", reminders: "Reminders", calendar: "Calendar invitations and changes" };
const UNDO_MS = 5000;
const snoozeText = (value: SnoozeChoice) => value === "never" ? "Reminder cancelled" : `Snoozed: ${value} more minutes of quiet`;
// The notice went while this waited (a reminder rang again, and its new row took this one's place): nothing left to do.
const gone = (cause: unknown) => cause instanceof StudioApiError && cause.code === "NOT_FOUND";

export function LiveNotificationsScreen() {
  const [items, setItems] = useState<Notification[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderCursor, setReminderCursor] = useState<string | undefined>();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState("");
  // A failed first load shows in the inbox itself (never as "nothing yet"); other errors stay in the banner.
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const filterMotion = useTabMotion(unreadOnly ? "unread" : "all", ["all", "unread"]);
  const [revision, setRevision] = useState(0);
  const [linkedReminderId, setLinkedReminderId] = useState("");
  const [linkedReminderError, setLinkedReminderError] = useState("");
  // Mark read is undoable: the row reads as read at once and the change is sent when the Undo window closes.
  const [pendingReads, setPendingReads] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  // Removing is undoable the same way: the row goes at once and the change is sent when the Undo window closes.
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  const awaitingRemoval = useRef(new Set<string>());
  const [historyOf, setHistoryOf] = useState<Notification | null>(null);
  const awaitingRead = useRef(new Set<string>());
  // Reads already sent stay shown as read even if an older inbox snapshot arrives afterwards.
  const sentReads = useRef(new Set<string>());
  const [saved, markSaved] = useFlag();

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([listLiveNotifications(), listLiveReminders(), getLiveNotificationPreferences()]).then(([nextItems, page, nextPreferences]) => {
      if (active) { setItems(nextItems); setReminders((current) => { const linked = current.find((item) => item.id === new URLSearchParams(window.location.search).get("reminder")); return linked && !page.items.some((item) => item.id === linked.id) ? [linked, ...page.items] : page.items; }); setReminderCursor(page.nextCursor); setPreferences(nextPreferences); setLoading(false); setError(""); setLoadError(""); }
    }).catch((cause: unknown) => { if (active) { const message = describeError(cause, "Could not load your inbox."); setError(message); setLoadError(message); setLoading(false); } }));
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
      if (!Array.isArray(snapshot)) return;
      snapshot.forEach((item) => { if (item.readAt) sentReads.current.delete(item.id); });
      setItems(snapshot.map((item) => !item.readAt && sentReads.current.has(item.id) ? { ...item, readAt: new Date().toISOString() } : item));
    };
    window.addEventListener(notificationSnapshotEvent, onSnapshot);
    return () => window.removeEventListener(notificationSnapshotEvent, onSnapshot);
  }, []);

  async function act(id: string, action: () => Promise<unknown>, done?: string) {
    setBusyId(id); setError("");
    try { await action(); setRevision((value) => value + 1); window.dispatchEvent(new Event(notificationRefreshEvent)); if (done) toast({ title: done }); }
    catch (cause) { setError(describeError(cause, "Could not update the record.")); }
    finally { setBusyId(null); }
  }

  const setIn = (setter: typeof setPendingReads, id: string, on: boolean) => setter((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });

  function commitRead(id: string) {
    if (!awaitingRead.current.delete(id)) return;
    sentReads.current.add(id);
    readLiveNotification(id).then(() => {
      setItems((current) => current.map((item) => item.id === id && !item.readAt ? { ...item, readAt: new Date().toISOString() } : item));
      window.dispatchEvent(new Event(notificationRefreshEvent));
    }).catch((cause: unknown) => { sentReads.current.delete(id); if (!gone(cause)) toast({ tone: "error", title: "Could not mark it read", body: describeError(cause, "Please try again.") }); })
      .finally(() => setIn(setPendingReads, id, false));
  }

  function commitRemoval(id: string) {
    if (!awaitingRemoval.current.delete(id)) return;
    dismissLiveNotification(id).then(() => {
      setItems((current) => current.filter((item) => item.id !== id));
      window.dispatchEvent(new Event(notificationRefreshEvent));
    }).catch((cause: unknown) => {
      if (gone(cause)) return;
      setIn(setPendingRemovals, id, false);
      toast({ tone: "error", title: "Could not remove it", body: describeError(cause, "Please try again.") });
    });
  }

  /** Swiped away (or ×): it folds out at once, with five seconds to undo. A reminder keeps ringing; snooze or cancel stops it. */
  function remove(item: Notification) {
    setIn(setPendingRemovals, item.id, true);
    setIn(setLeaving, item.id, true);
    window.setTimeout(() => setIn(setLeaving, item.id, false), 320);
    awaitingRemoval.current.add(item.id);
    toast({ id: `remove-${item.id}`, title: "Removed from your inbox", body: item.body || item.title, duration: UNDO_MS, action: { label: "Undo", onClick: () => undefined }, onClose: (reason) => {
      if (reason === "dismissed") { commitRemoval(item.id); return; }
      awaitingRemoval.current.delete(item.id);
      setIn(setPendingRemovals, item.id, false);
    } });
  }

  /** Starts the task a "Start:" reminder is about, which also stops the reminder; the notice is then read. */
  function start(item: Notification) {
    void act(item.id, async () => {
      await updateLiveTask(item.resourceId, { status: "in_progress" });
      await readLiveNotification(item.id).catch(() => undefined);
    }, `Started: ${item.body.replace(/^Start:\s*/, "")}`);
  }

  function snooze(id: string, reminderId: string, minutes: SnoozeChoice) {
    void act(id, () => snoozeLiveReminder(reminderId, minutes), snoozeText(minutes));
  }

  function markRead(item: Notification) {
    setIn(setPendingReads, item.id, true);
    // In the Unread view the row folds away (decision 16B); in All it simply turns read.
    if (unreadOnly) { setIn(setLeaving, item.id, true); window.setTimeout(() => setIn(setLeaving, item.id, false), 320); }
    awaitingRead.current.add(item.id);
    toast({ id: `read-${item.id}`, title: "Marked as read", body: item.title, duration: UNDO_MS, action: { label: "Undo", onClick: () => undefined }, onClose: (reason) => {
      if (reason === "dismissed") { commitRead(item.id); return; }
      awaitingRead.current.delete(item.id);
      setIn(setPendingReads, item.id, false);
    } });
  }

  // Leaving the inbox (or the page) sends any read that is still inside its Undo window.
  useEffect(() => {
    const pending = awaitingRead.current;
    const removals = awaitingRemoval.current;
    const flush = () => { [...pending].forEach((id) => dismissToast(`read-${id}`)); [...removals].forEach((id) => dismissToast(`remove-${id}`)); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);

  async function markAll() {
    const unread = items.filter((item) => !item.readAt).length;
    setBusyId("all"); setError("");
    const before = items;
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt }));
    try { await markLiveNotificationsRead(); window.dispatchEvent(new Event(notificationRefreshEvent)); toast({ title: "All caught up", body: `${unread} notification${unread === 1 ? "" : "s"} marked as read.` }); }
    catch (cause) { setItems(before); setError(describeError(cause, "Could not mark notifications read.")); }
    finally { setBusyId(null); }
  }

  async function savePreferences(event: React.FormEvent) {
    event.preventDefault();
    if (!preferences) return;
    setBusyId("preferences"); setError("");
    try { setPreferences(await updateLiveNotificationPreferences(preferences)); markSaved("preferences"); }
    catch (cause) { setError(describeError(cause, "Could not save preferences.")); }
    finally { setBusyId(null); }
  }

  async function moreReminders() {
    if (!reminderCursor) return;
    setBusyId("reminders"); setError("");
    try { const page = await listLiveReminders(reminderCursor); setReminders((current) => [...current, ...page.items]); setReminderCursor(page.nextCursor); }
    catch (cause) { setError(describeError(cause, "Could not load more reminders.")); }
    finally { setBusyId(null); }
  }

  const effective = items.map((item) => !item.readAt && pendingReads.has(item.id) ? { ...item, readAt: "pending" } : item);
  const unreadCount = effective.filter((item) => !item.readAt).length;
  const visible = effective.filter((item) => leaving.has(item.id) || (!pendingRemovals.has(item.id) && (!unreadOnly || !item.readAt)));
  const retry = () => { setLoading(true); setRevision((value) => value + 1); };
  const loadFailed = Boolean(loadError) && !items.length && !loading;
  return <PageFrame>
    <PageTitle title="Notifications" description="Messages, reminders, and delivery preferences for your workspace." action={<HeaderActions><RefreshButton busy={loading} onClick={retry} /></HeaderActions>} />
    <Notice tone="error" message={loadFailed ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    <Notice tone="error" message={linkedReminderError} onDismiss={() => setLinkedReminderError("")} className="pb-4" />
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
      <Panel><div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 p-3"><SlidingTabs fitContent label="Notification filter" active={unreadOnly ? "unread" : "all"} onChange={(key) => setUnreadOnly(key === "unread")} tabs={[{ key: "all", label: "All" }, { key: "unread", label: "Unread", ...(unreadCount ? { badge: unreadCount } : {}) }]} />{unreadCount > 0 && <button type="button" disabled={busyId === "all"} onClick={() => void markAll()} className="vso-fade-enter ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-primary-50 active:scale-[0.97] disabled:opacity-40"><Check size={15} />Mark all read</button>}</div>
        {loading && !items.length ? <SkeletonRows rows={4} label="Loading notifications" /> : visible.length ? <div key={unreadOnly ? "unread" : "all"} className={filterMotion.className} style={filterMotion.style}>{visible.map((item) => {
          const reminderId = noticeReminderId(item);
          return <NotificationRow key={item.id} item={item} leaving={leaving.has(item.id)} busy={busyId === item.id} onRead={() => markRead(item)} onRemove={() => remove(item)} onSnooze={(minutes) => reminderId && snooze(item.id, reminderId, minutes)} onStart={() => start(item)} onHistory={() => setHistoryOf(item)} />;
        })}</div> : loadFailed ? <EmptyState variant="error" title="Could not load your inbox" body={loadError} action={{ label: "Try again", onClick: retry }} /> : <EmptyState variant="card" tone="teal" icon={BellRing} title={unreadOnly ? "All caught up" : "No notifications yet"} body="New assignments, mentions and reminders appear here." secondary={unreadOnly && items.length ? { label: "Show all", onClick: () => setUnreadOnly(false) } : undefined} />}
      </Panel>
      <div className="space-y-4"><Panel><PanelHead title="Delivery preferences" /><form onSubmit={savePreferences} className="space-y-2 p-4">{preferences ? (Object.keys(preferenceLabels) as (keyof Preferences)[]).map((key) => <label key={key} className="flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-xl bg-neutral-50 px-3 text-sm font-semibold text-neutral-700 transition-colors duration-150 hover:bg-neutral-100"><span>{preferenceLabels[key]}</span><input type="checkbox" role="switch" className="vso-toggle" checked={preferences[key]} onChange={(event) => setPreferences((current) => current ? { ...current, [key]: event.target.checked } : current)} /></label>) : <div role="status" aria-label="Loading preferences" className="grid gap-2">{[0, 1, 2, 3, 4, 5].map((index) => <span key={index} className="vso-skeleton h-10 rounded-xl" />)}</div>}<button disabled={!preferences || busyId === "preferences"} className={clsx(primaryClass, "mt-2", saved && "!bg-success hover:!bg-success")}><ActionLabel busy={busyId === "preferences"} done={Boolean(saved)} idle="Save preferences" doneText="Saved" /></button></form></Panel>
        <Panel><PanelHead title="This device" /><LiveWebPush preferenceEnabled={preferences?.webPush} /></Panel>
        <Panel><PanelHead title="Your reminders" aside={<Badge tone="blue">{reminders.length}{reminderCursor ? "+" : ""}</Badge>} /><div className="divide-y divide-neutral-100">{loading && !reminders.length ? <SkeletonRows rows={2} label="Loading reminders" /> : reminders.length ? reminders.map((item) => <article key={item.id} id={`reminder-${item.id}`} tabIndex={-1} className={clsx("p-4 outline-none transition-[background-color,box-shadow] duration-300", linkedReminderId === item.id && "bg-primary-50 ring-2 ring-inset ring-primary-300")}><p className="break-words text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere]">{item.message}</p><p className="mt-1 text-xs text-neutral-500">{stamp(item.scheduledAt)} · {item.state}</p>{(item.taskId || item.state === "scheduled") && <div className="mt-2 flex items-center gap-1.5">{item.taskId && <Link href={`/tasks/live?task=${encodeURIComponent(item.taskId)}`} aria-label="Open task" title="Open task" className={iconButton}><ArrowUpRight size={16} aria-hidden="true" /></Link>}{item.state === "scheduled" && <SnoozeMenu label={`Snooze ${item.message}`} disabled={busyId === item.id} onChoose={(minutes) => snooze(item.id, item.id, minutes)} />}</div>}</article>) : loadFailed ? <EmptyState variant="compact" icon={AlertTriangle} title="Reminders unavailable" body="They did not load with your inbox." className="m-4" /> : <EmptyState variant="card" tone="teal" icon={Clock3} title="No reminders scheduled" body="Reminders from tasks and /notify appear here." />}</div>{reminderCursor && <div className="p-4 text-center"><button type="button" disabled={busyId === "reminders"} onClick={moreReminders} className={secondaryClass}><ActionLabel busy={busyId === "reminders"} busyText="Loading…" idle="Load more reminders" /></button></div>}</Panel>
      </div>
    </div>
    {historyOf && <NotificationHistory item={historyOf} onClose={() => setHistoryOf(null)} />}
  </PageFrame>;
}
