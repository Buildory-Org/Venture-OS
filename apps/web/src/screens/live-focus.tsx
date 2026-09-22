"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock3, Database, Play, RefreshCw, Square } from "lucide-react";
import { completeLiveFocus, getCurrentLiveFocus, listLiveFocusHistory, startLiveFocus } from "@/lib/studio-api";
import { Badge, Empty, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Focus = Awaited<ReturnType<typeof getCurrentLiveFocus>>;
type History = Awaited<ReturnType<typeof listLiveFocusHistory>>["items"][number];

export function LiveFocusScreen() {
  const [focus, setFocus] = useState<Focus>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [minutes, setMinutes] = useState(25);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([getCurrentLiveFocus(), listLiveFocusHistory()]).then(([value, page]) => { if (active) { setFocus(value); setHistory(page.items); setCursor(page.nextCursor); setLoading(false); setError(""); } }).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load the focus sessions."); setLoading(false); } }));
    return () => { active = false; };
  }, [revision]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  async function act(action: () => Promise<Focus>) {
    setBusy(true); setError("");
    try { const next = await action(); setFocus(next?.completedAt ? null : next); setRevision((value) => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the focus session. Refresh before retrying."); }
    finally { setBusy(false); }
  }

  async function moreHistory() {
    if (!cursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveFocusHistory(cursor); setHistory((items) => [...items, ...page.items]); setCursor(page.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more focus sessions."); }
    finally { setBusy(false); }
  }

  const seconds = focus ? Math.max(0, Math.ceil((new Date(focus.endsAt).getTime() - now) / 1000)) : 0;
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return <PageFrame><PageTitle eyebrow="Connected focus" title="Focus session" description="The active timer is recovered from the server after refresh or reconnect." action={<button type="button" onClick={() => { setLoading(true); setRevision((value) => value + 1); }} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>This timer uses the canonical focus endpoints. The separate demo focus dock remains a local sample. <Link href="/tasks/live" className="font-bold underline">Open live tasks</Link>.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel className="mx-auto max-w-xl p-6 text-center sm:p-8"><span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary-50 text-primary-700"><Clock3 size={22} /></span>{loading ? <p className="mt-6 text-sm text-neutral-500">Checking for an active session…</p> : focus ? <><p className="mt-5 text-xs font-extrabold uppercase tracking-wide text-primary-700">Active focus session</p><p className="mt-3 font-mono text-[clamp(3.5rem,12vw,5rem)] font-extrabold leading-none tracking-tight text-neutral-900" role="timer" aria-live="off">{clock}</p><p className="mt-4 text-sm leading-6 text-neutral-500">{focus.plannedMinutes} minutes planned · Started {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(focus.startedAt))}{seconds === 0 ? " · Planned time elapsed; complete when you finish." : ""}</p><button type="button" disabled={busy} onClick={() => act(() => completeLiveFocus(focus.id))} className={`${primaryClass} mt-6`}><Square size={14} />Complete session</button></> : <><p className="mt-5 text-xs font-extrabold uppercase tracking-wide text-primary-700">Ready to focus</p><h2 className="mt-2 text-xl font-extrabold text-neutral-900">Start a focused work block</h2><p className="mt-2 text-sm leading-6 text-neutral-500">The server records the start and end time. Refreshing this page will not reset the session.</p><label className="mx-auto mt-5 flex max-w-48 flex-col text-left text-xs font-bold text-neutral-600">Planned minutes<input type="number" min={1} max={240} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} className="mt-1 min-h-11 rounded-xl border border-neutral-200 bg-white px-3 text-sm text-neutral-800" /></label><button type="button" disabled={busy || minutes < 1 || minutes > 240} onClick={() => act(() => startLiveFocus({ plannedMinutes: minutes }))} className={`${primaryClass} mt-5`}><Play size={15} />Start session</button></>}</Panel>
    <Panel className="mx-auto mt-4 max-w-xl"><PanelHead title="Completed sessions" aside={<Badge tone="blue">{history.length}{cursor ? "+" : ""}</Badge>} /><div className="divide-y divide-neutral-100">{history.length ? history.map((item) => <article key={item.id} className="flex items-center justify-between gap-3 p-4"><div><p className="text-sm font-bold text-neutral-800">{item.plannedMinutes} minute focus block</p><p className="mt-1 text-xs text-neutral-500">Started {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.startedAt))}</p></div><Badge tone="green">Completed</Badge></article>) : <Empty title="No completed sessions" body="Your completed focus blocks will appear here." />}</div>{cursor && <button type="button" disabled={busy} onClick={moreHistory} className="m-4 text-xs font-bold text-primary-700 underline">Load more sessions</button>}</Panel>
  </PageFrame>;
}
