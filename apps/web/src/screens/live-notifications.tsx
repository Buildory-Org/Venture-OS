"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, Database, RefreshCw } from "lucide-react";
import { listLiveNotifications, readLiveNotification, snoozeLiveReminder } from "@/lib/studio-api";
import { Badge, Empty, PageFrame, PageTitle, Panel, secondaryClass } from "@/components/studio/primitives";

type Notification = Awaited<ReturnType<typeof listLiveNotifications>>[number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function LiveNotificationsScreen() {
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => listLiveNotifications().then((value) => { if (active) { setItems(value); setLoading(false); setError(""); } }).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load notifications."); setLoading(false); } }));
    return () => { active = false; };
  }, [revision]);

  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id); setError("");
    try { await action(); setRevision((value) => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update notification."); }
    finally { setBusyId(null); }
  }

  const visible = items.filter((item) => !unreadOnly || !item.readAt);
  return <PageFrame><PageTitle eyebrow="Connected inbox" title="Live notifications" description="Your server-owned mentions, assignments, messages, and reminders." action={<button type="button" className={secondaryClass} onClick={() => { setLoading(true); setRevision((value) => value + 1); }}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>This inbox reads canonical records. <Link href="/notifications" className="font-bold underline">Demo notifications</Link> are separate. Task reminders do not expose their reminder ID here, so only standalone reminder notices can be snoozed.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel><div className="flex gap-2 border-b border-neutral-100 p-3"><button onClick={() => setUnreadOnly(false)} className={`min-h-9 rounded-lg px-3 text-sm font-bold ${!unreadOnly ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-50"}`}>All</button><button onClick={() => setUnreadOnly(true)} className={`min-h-9 rounded-lg px-3 text-sm font-bold ${unreadOnly ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-50"}`}>Unread</button></div>
      {loading && !items.length ? <p className="p-8 text-sm text-neutral-500">Loading notifications…</p> : visible.length ? <div className="divide-y divide-neutral-100">{visible.map((item) => <article key={item.id} className={`flex flex-wrap items-start gap-3 p-4 ${!item.readAt ? "bg-primary-50/40" : ""}`}><span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-700"><Bell size={17} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-extrabold text-neutral-800">{item.title}</p><Badge tone={item.readAt ? "neutral" : "blue"}>{item.readAt ? "Read" : "Unread"}</Badge></div><p className="mt-1 text-sm text-neutral-500">{item.body}</p><p className="mt-1 text-xs text-neutral-400">{stamp(item.createdAt)} · {item.type}</p></div><div className="flex flex-wrap gap-2">{item.resourceType === "task" && <Link href={`/tasks/live?task=${encodeURIComponent(item.resourceId)}`} className={secondaryClass}>Open task</Link>}{!item.readAt && <button disabled={busyId === item.id} onClick={() => act(item.id, () => readLiveNotification(item.id))} className={secondaryClass}>Mark read</button>}{item.type === "reminder" && item.resourceType === "reminder" && <select aria-label={`Snooze ${item.title}`} disabled={busyId === item.id} defaultValue="" onChange={(event) => { const value = event.target.value; if (value) act(item.id, () => snoozeLiveReminder(item.resourceId, value === "never" ? "never" : Number(value) as 10 | 20 | 30)); event.currentTarget.value = ""; }} className="min-h-10 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-bold text-neutral-700"><option value="">Snooze…</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option><option value="never">Never</option></select>}</div></article>)}</div> : <Empty title="Inbox clear" body="The API returned no notifications in this view." />}
    </Panel>
  </PageFrame>;
}
