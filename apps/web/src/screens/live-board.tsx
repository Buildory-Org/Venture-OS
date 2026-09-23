"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Columns3, Database, RefreshCw } from "lucide-react";
import type { Task } from "@venture-studio/contracts";
import { listLiveTasks, loadLiveSession, updateLiveTask } from "@/lib/studio-api";
import { Badge, inputClass, PageFrame, PageTitle, Panel, secondaryClass } from "@/components/studio/primitives";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Status = Task["status"];
const statuses: Status[] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
const label = (value: string) => value.replaceAll("_", " ");

export function LiveBoardScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [ventureId, setVentureId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => { if (active) setSession(value); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the workspace."); }));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      listLiveTasks(undefined, { ...(ventureId ? { ventureId } : {}), ...(groupId ? { groupId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(priority ? { priority: priority as Task["priority"] } : {}), ...(tag ? { tag } : {}) }).then((page) => {
        if (active) { setTasks(page.items); setCursor(page.nextCursor); setError(""); setBusy(false); }
      }).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load the board."); setBusy(false); } });
    });
    return () => { active = false; };
  }, [session, ventureId, groupId, assigneeId, priority, tag, revision]);

  const groups = session?.hierarchy.ventures.filter((item) => !ventureId || item.id === ventureId).flatMap((item) => item.groups) ?? [];
  const ventureNames = new Map(session?.hierarchy.ventures.map((item) => [item.id, item.name]) ?? []);
  const editable = (task: Task) => session && (["admin", "venture_head"].includes(session.membership.role) || task.assigneeId === session.user.id || task.reviewerId === session.user.id);

  async function move(task: Task, status: Status) {
    if (status === task.status) return;
    setBusy(true); setError("");
    try {
      const changed = await updateLiveTask(task.id, { status, ...(status !== "blocked" && task.blocker ? { blocker: null } : {}) });
      setTasks((items) => items.map((item) => item.id === changed.id ? changed : item));
      setRevision((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not move the task."); }
    finally { setBusy(false); }
  }

  async function more() {
    if (!cursor || !session) return;
    setBusy(true);
    try { const page = await listLiveTasks(cursor, { ...(ventureId ? { ventureId } : {}), ...(groupId ? { groupId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(priority ? { priority: priority as Task["priority"] } : {}), ...(tag ? { tag } : {}) }); setTasks((items) => [...items, ...page.items]); setCursor(page.nextCursor); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more tasks."); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle eyebrow="Connected work management" title="Live board" description="Every column uses the same authorized task records as the connected task list." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>Status moves write to the API. Open a task to describe a blocker or submit completion evidence. <Link href="/demo/board" className="font-bold underline">Demo board</Link> remains separate.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel className="mb-4 grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-5"><label><span className="mb-1 block text-xs font-bold text-neutral-500">Venture</span><select className={inputClass} value={ventureId} onChange={(event) => { setVentureId(event.target.value); setGroupId(""); setAssigneeId(""); }}><option value="">All ventures</option>{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span className="mb-1 block text-xs font-bold text-neutral-500">Group</span><select className={inputClass} value={groupId} onChange={(event) => { setGroupId(event.target.value); setAssigneeId(""); }}><option value="">All groups</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><LiveMemberPicker label="Assignee" value={assigneeId} onChange={setAssigneeId} ventureId={ventureId || undefined} groupId={groupId || undefined} optional /><label><span className="mb-1 block text-xs font-bold text-neutral-500">Priority</span><select className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">All priorities</option>{(["low", "medium", "high", "urgent"] as const).map((item) => <option key={item} value={item}>{item}</option>)}</select></label><form onSubmit={(event) => { event.preventDefault(); setTag(tagDraft.trim()); }}><label htmlFor="live-board-tag" className="mb-1 block text-xs font-bold text-neutral-500">Tag</label><div className="flex gap-1"><input id="live-board-tag" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} className={inputClass} placeholder="Filter tag" /><button className="min-h-11 rounded-xl border border-neutral-200 px-3 text-xs font-bold text-neutral-700 hover:bg-neutral-50">Apply</button></div></form></Panel>
    <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-neutral-500"><span className="flex items-center gap-1"><Columns3 size={15} />{tasks.length} task{tasks.length === 1 ? "" : "s"} loaded{cursor ? " · more available" : ""}</span><Link href="/tasks/live" className="font-bold text-primary-700 hover:underline">Open live task list</Link></div>
    <div className="thin-scroll grid min-w-0 grid-flow-col auto-cols-[minmax(250px,280px)] gap-3 overflow-x-auto pb-3" aria-label="Live task board">{statuses.map((status) => <Panel key={status} className="min-h-64 p-3"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-extrabold capitalize text-neutral-800">{label(status)}</h2><Badge>{tasks.filter((task) => task.status === status).length}</Badge></div><div className="space-y-2">{tasks.filter((task) => task.status === status).map((task) => <article key={task.id} className="rounded-xl border border-neutral-100 bg-neutral-50 p-3"><Badge tone={task.priority === "urgent" || task.priority === "high" ? "red" : "neutral"}>{task.priority}</Badge><Link href={`/tasks/live?task=${encodeURIComponent(task.id)}`} className="mt-2 block text-sm font-extrabold text-neutral-800 hover:text-primary-700 hover:underline">{task.title}</Link><p className="mt-1 text-xs text-neutral-500">{ventureNames.get(task.ventureId) ?? task.ventureId}</p><p className="mt-1 text-xs text-neutral-400">Due {new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(task.dueAt))}</p>{editable(task) && <select aria-label={`Move ${task.title}`} disabled={busy} value={task.status} onChange={(event) => move(task, event.target.value as Status)} className="mt-3 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs font-bold capitalize text-neutral-600">{statuses.map((item) => <option key={item} value={item} disabled={item === "blocked" && !task.blocker && task.status !== "blocked"}>{label(item)}</option>)}</select>}</article>)}</div></Panel>)}</div>
    {cursor && <div className="mt-4 text-center"><button type="button" disabled={busy} onClick={more} className={secondaryClass}>{busy ? "Loading…" : "Load more tasks"}</button></div>}
  </PageFrame>;
}
