"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useKanbanDnd } from "@/components/ui/use-kanban-dnd";
import { useEffect, useState } from "react";
import clsx from "clsx";
import Link from "next/link";
import { Columns3, RefreshCw } from "@/components/ui/icons";
import type { Task } from "@venture-studio/contracts";
import { listLiveTasks, loadLiveSession, updateLiveTask } from "@/lib/studio-api";
import { Badge, inputClass, PageFrame, PageTitle, Panel, secondaryClass } from "@/components/studio/primitives";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Status = Task["status"];
const statuses: Status[] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
const columns = ["Backlog", "Ready", "In progress", "In review", "Blocked", "Done"] as const;
type Column = typeof columns[number];
const columnStatus: Record<Column, Status> = { Backlog: "backlog", Ready: "todo", "In progress": "in_progress", "In review": "review", Blocked: "blocked", Done: "done" };
const columnForStatus = (status: Status): Column => status === "done" ? "Done" : status === "blocked" ? "Blocked" : status === "review" ? "In review" : status === "in_progress" ? "In progress" : status === "accepted" || status === "todo" ? "Ready" : "Backlog";
const label = (value: string) => value.replaceAll("_", " ");

export function LiveBoardScreen() {
  const { activeVentureId: ventureId } = useStudio();
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [groupId, setGroupId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => { queueMicrotask(() => { setGroupId(""); setAssigneeId(""); }); }, [ventureId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => { if (active) setSession(value); }).catch((cause: unknown) => { if (active) setError(describeError(cause, "Could not load the workspace.")); }));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      listLiveTasks(undefined, { ...(ventureId ? { ventureId } : {}), ...(groupId ? { groupId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(priority ? { priority: priority as Task["priority"] } : {}), ...(tag ? { tag } : {}) }).then((page) => {
        if (active) { setTasks(page.items); setCursor(page.nextCursor); setError(""); setBusy(false); }
      }).catch((cause: unknown) => { if (active) { setError(describeError(cause, "Could not load the board.")); setBusy(false); } });
    });
    return () => { active = false; };
  }, [session, ventureId, groupId, assigneeId, priority, tag, revision]);

  const groups = session?.hierarchy.ventures.filter((item) => !ventureId || item.id === ventureId).flatMap((item) => item.groups) ?? [];
  const ventureNames = new Map(session?.hierarchy.ventures.map((item) => [item.id, item.name]) ?? []);
  const editable = (task: Task) => session && (["admin", "venture_head"].includes(session.membership.role) || task.assigneeId === session.user.id);

  async function move(task: Task, status: Status) {
    if (status === task.status) return;
    if (status === "blocked" && !task.blocker) { setError("Open the task and record its blocker before moving it to Blocked."); return; }
    setBusy(true); setError("");
    try {
      const changed = await updateLiveTask(task.id, { status, ...(status !== "blocked" && task.blocker ? { blocker: null } : {}) });
      setTasks((items) => items.map((item) => item.id === changed.id ? changed : item));
      setRevision((value) => value + 1);
    } catch (cause) { setError(describeError(cause, "Could not move the task.")); }
    finally { setBusy(false); }
  }

  const dnd = useKanbanDnd<Column>((taskId, column) => {
    const task = tasks.find((item) => item.id === taskId);
    if (task && !busy && editable(task) && columnForStatus(task.status) !== column) void move(task, columnStatus[column]);
  });
  const boardTasks = tasks.filter((task) => task.status !== "cancelled");

  async function more() {
    if (!cursor || !session) return;
    setBusy(true);
    try { const page = await listLiveTasks(cursor, { ...(ventureId ? { ventureId } : {}), ...(groupId ? { groupId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(priority ? { priority: priority as Task["priority"] } : {}), ...(tag ? { tag } : {}) }); setTasks((items) => [...items, ...page.items]); setCursor(page.nextCursor); setError(""); }
    catch (cause) { setError(describeError(cause, "Could not load more tasks.")); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle title="Kanban board" description="Move work through clear stages; each card retains its precise task status." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel className="mb-4 grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4"><label><span className="mb-1 block text-xs font-semibold text-neutral-500">Group</span><Select className={inputClass} value={groupId} onChange={(event) => { setGroupId(event.target.value); setAssigneeId(""); }}><option value="">All groups</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label><LiveMemberPicker label="Assignee" value={assigneeId} onChange={setAssigneeId} ventureId={ventureId || undefined} groupId={groupId || undefined} optional /><label><span className="mb-1 block text-xs font-semibold text-neutral-500">Priority</span><Select className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">All priorities</option>{(["low", "medium", "high", "urgent"] as const).map((item) => <option key={item} value={item}>{item}</option>)}</Select></label><form onSubmit={(event) => { event.preventDefault(); setTag(tagDraft.trim()); }}><label htmlFor="live-board-tag" className="mb-1 block text-xs font-semibold text-neutral-500">Tag</label><div className="flex gap-1"><input id="live-board-tag" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} className={inputClass} placeholder="Filter tag" /><button className="min-h-11 rounded-xl border border-neutral-200 px-3 text-xs font-semibold text-neutral-700 hover:bg-neutral-50">Apply</button></div></form></Panel>
    <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-neutral-500"><span className="flex items-center gap-1"><Columns3 size={15} />{boardTasks.length} task{boardTasks.length === 1 ? "" : "s"} loaded{tasks.length !== boardTasks.length ? ` · ${tasks.length - boardTasks.length} cancelled hidden` : ""}{cursor ? " · more available" : ""}</span><Link href="/tasks/live" className="font-bold text-primary-700 hover:underline">Open task list</Link></div>
    <div className="grid min-w-0 gap-3 lg:grid-cols-3 2xl:grid-cols-6" aria-label="Live task board">{columns.map((column) => <div key={column} className="min-w-0" {...dnd.columnProps(column)}><Panel className={clsx("min-h-48 p-3 transition-[border-color,box-shadow] duration-150", dnd.overStatus === column && "border-primary-500 ring-2 ring-primary-300")}><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-neutral-800">{column}</h2><Badge>{boardTasks.filter((task) => columnForStatus(task.status) === column).length}</Badge></div><div className="space-y-2">{boardTasks.filter((task) => columnForStatus(task.status) === column).map((task) => <article key={task.id} {...(editable(task) && !busy ? dnd.cardProps(task.id) : {})} className={clsx("min-w-0 rounded-xl border border-neutral-100 bg-neutral-50 p-3", editable(task) && !busy && "cursor-grab active:cursor-grabbing", dnd.draggingId === task.id && "opacity-45")}><div className="flex flex-wrap gap-1"><Badge tone={task.priority === "urgent" || task.priority === "high" ? "red" : "neutral"}>{task.priority}</Badge><Badge>{label(task.status)}</Badge>{task.deadlineRisk && !["done", "cancelled", "parked"].includes(task.status) && <Badge tone="amber">Deadline risk</Badge>}</div><Link href={`/tasks/live?task=${encodeURIComponent(task.id)}`} className="mt-2 block text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere] hover:text-primary-700 hover:underline">{task.title}</Link><p className="mt-1 text-xs text-neutral-500">{ventureNames.get(task.ventureId) ?? "Venture"}</p><p className="mt-1 text-xs text-neutral-400">Due {new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(task.dueAt))}</p>{editable(task) && <Select aria-label={`Move ${task.title}`} disabled={busy} value={task.status} onChange={(event) => move(task, event.target.value as Status)} className="mt-3 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs font-semibold capitalize text-neutral-600">{statuses.map((item) => <option key={item} value={item} disabled={item === "blocked" && !task.blocker && task.status !== "blocked"}>{label(item)}</option>)}</Select>}</article>)}</div></Panel></div>)}</div>
    {cursor && <div className="mt-4 text-center"><button type="button" disabled={busy} onClick={more} className={secondaryClass}>{busy ? "Loading…" : "Load more tasks"}</button></div>}
  </PageFrame>;
}
