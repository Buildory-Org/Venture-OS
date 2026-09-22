"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, CircleAlert, Database, Layers3, RefreshCw, Target } from "lucide-react";
import clsx from "clsx";
import { listLiveTasks, loadLiveDashboard, updateLiveTask } from "@/lib/studio-api";

type DashboardData = Awaited<ReturnType<typeof loadLiveDashboard>>;
type TaskPage = Awaited<ReturnType<typeof listLiveTasks>>;
type LiveData = DashboardData & { taskPage: TaskPage };
type LiveTask = TaskPage["items"][number];

const card = "rounded-2xl border border-neutral-200/75 bg-white shadow-card";
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-3.5 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

function statusTone(value: string) {
  if (value === "blocked") return "bg-danger-surface text-danger-text";
  if (value === "review" || value === "proposed") return "bg-warning-surface text-warning-text";
  if (value === "done") return "bg-success-surface text-success-text";
  return "bg-neutral-100 text-neutral-600";
}

function TaskRow({ task, ventureName, canUpdate, busy, onStart }: { task: LiveTask; ventureName: string; canUpdate: boolean; busy: boolean; onStart: (id: string) => void }) {
  return <div className="grid gap-3 border-b border-neutral-100 px-4 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-bold text-neutral-900">{task.title}</span><span className={clsx("rounded-md px-2 py-1 text-[10px] font-bold capitalize", statusTone(task.status))}>{statusLabel(task.status)}</span></div>
      <p className="mt-1 text-[11px] font-medium text-neutral-500">{ventureName} · {task.priority} priority · Due {dateLabel(task.dueAt)}</p>
      <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-neutral-600">{task.outcome}</p>
    </div>
    {canUpdate && ["accepted", "todo", "backlog"].includes(task.status) && <button type="button" disabled={busy} onClick={() => onStart(task.id)} className={clsx(button, "justify-self-start bg-neutral-900 text-white hover:bg-neutral-800 disabled:cursor-wait disabled:opacity-50")}>{busy ? "Starting…" : "Start task"}<ArrowRight size={14} /></button>}
  </div>;
}

export function LiveDashboard() {
  const [data, setData] = useState<LiveData | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scope, setScope] = useState("all");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      Promise.all([loadLiveDashboard(), listLiveTasks()]).then(([dashboard, taskPage]) => {
        if (!active) return;
        setData({ ...dashboard, taskPage });
        setError("");
        setLoading(false);
      }).catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not load the connected dashboard.");
        setLoading(false);
      });
    });
    return () => { active = false; };
  }, [revision]);

  const ventures = data?.bootstrap.hierarchy.ventures ?? [];
  const filteredTasks = useMemo(() => (data?.taskPage.items ?? []).filter((task) => scope === "all" || task.ventureId === scope), [data, scope]);
  const filteredOutcomes = (data?.dashboard.outcomes ?? []).filter((outcome) => scope === "all" || outcome.ventureId === scope);
  const myTasks = (data?.dashboard.tasks ?? []).filter((task) => scope === "all" || task.ventureId === scope);
  const blockers = (data?.dashboard.blockers ?? []).filter((task) => scope === "all" || task.ventureId === scope);
  const activeVentures = ventures.filter((venture) => venture.status === "active" && (scope === "all" || venture.id === scope));
  const ventureNames = new Map(ventures.map((venture) => [venture.id, venture.name]));
  const firstTask = filteredTasks.find((task) => !["done", "cancelled", "parked"].includes(task.status));

  async function startTask(id: string) {
    setBusyId(id);
    setError("");
    try {
      await updateLiveTask(id, { status: "in_progress" });
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the task.");
    } finally {
      setBusyId(null);
    }
  }

  async function loadMoreTasks() {
    const cursor = data?.taskPage.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setError("");
    try {
      const next = await listLiveTasks(cursor);
      setData((current) => current ? { ...current, taskPage: { items: [...current.taskPage.items, ...next.items], nextCursor: next.nextCursor } } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more tasks.");
    } finally {
      setLoadingMore(false);
    }
  }

  return <div className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6">
    <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="text-[11px] font-bold uppercase tracking-[0.12em] text-primary-600">Venture Studio / Connected dashboard</p><h1 className="mt-1.5 text-[clamp(1.6rem,3vw,2.1rem)] font-extrabold tracking-[-0.045em] text-neutral-900">{data ? `Good morning, ${data.bootstrap.user.name.split(" ")[0]}.` : "Your connected workspace"}</h1><p className="mt-1 text-[13px] font-medium text-neutral-500">Live API records · {data ? data.bootstrap.hierarchy.workspace.name : "Loading workspace"}</p></div>
      <div className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor="live-venture">Filter connected data by venture</label><select id="live-venture" value={scope} onChange={(event) => setScope(event.target.value)} className="min-h-10 min-w-36 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-bold text-neutral-700 shadow-sm"><option value="all">All ventures</option>{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</select><button type="button" disabled={loading} onClick={() => { setLoading(true); setRevision((value) => value + 1); }} className={clsx(button, "border border-neutral-200 bg-white text-neutral-700 shadow-sm hover:bg-neutral-50 disabled:cursor-wait disabled:opacity-50")}><RefreshCw size={14} />{loading ? "Refreshing…" : "Refresh"}</button><Link href="/dashboard" className={clsx(button, "bg-neutral-900 text-white hover:bg-neutral-800")}>Demo dashboard<ArrowUpRight size={14} /></Link></div>
    </header>

    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 px-4 py-3 text-[12px] leading-5 text-primary-800"><Database size={16} className="mt-0.5 shrink-0" /><p>This page reads the connected API. The sidebar and other studio pages still use sample records; actions there do not update these records.</p></div>
    {error && <div role="alert" className="mb-4 rounded-xl border border-danger-surface bg-white px-4 py-3 text-sm font-semibold text-danger-text">{error}{error.toLowerCase().includes("auth") && <Link href="/sign-in" className="ml-2 underline">Sign in</Link>}</div>}
    {loading && !data ? <div className={clsx(card, "p-8 text-sm text-neutral-500")}>Loading connected workspace…</div> : !data ? <div className={clsx(card, "p-8 text-sm text-neutral-600")}>The connected workspace is unavailable. Check that the API is running, then refresh.</div> : <>
      <section aria-label="Connected studio metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[{ icon: Layers3, label: "Active ventures", value: activeVentures.length, note: "From workspace hierarchy", tone: "bg-primary-50 text-primary-700" }, { icon: Target, label: "My open work", value: myTasks.length, note: "Assigned to you", tone: "bg-ai-surface text-ai-text" }, { icon: CircleAlert, label: "My blockers", value: blockers.length, note: "Needing resolution", tone: "bg-danger-surface text-danger-text" }, { icon: Database, label: "Active outcomes", value: filteredOutcomes.filter((item) => item.status === "active").length, note: "Canonical records", tone: "bg-success-surface text-success-text" }].map((stat) => <div key={stat.label} className={clsx(card, "min-w-0 px-4 py-4")}><span className={clsx("grid h-9 w-9 place-items-center rounded-xl", stat.tone)}><stat.icon size={17} /></span><p className="mt-3 text-[24px] font-extrabold leading-none tracking-tight text-neutral-900 tnum">{stat.value}</p><p className="mt-2 text-[11px] font-extrabold uppercase tracking-[0.07em] text-neutral-600">{stat.label}</p><p className="mt-1 truncate text-[11px] font-medium text-neutral-400">{stat.note}</p></div>)}
      </section>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <section className={clsx(card, "col-span-12 overflow-hidden lg:col-span-8")}><div className="grid h-full md:grid-cols-[minmax(0,1fr)_220px]"><div className="p-5 sm:p-6"><p className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-primary-700">Operating brief</p><h2 className="mt-5 max-w-xl text-[clamp(1.4rem,2.4vw,1.9rem)] font-extrabold leading-tight tracking-[-0.04em] text-neutral-900">{blockers.length ? "Clear the blocker. Keep the plan moving." : firstTask ? "The next piece of work is ready." : "Your workspace is clear."}</h2><p className="mt-3 max-w-xl text-[13px] font-medium leading-6 text-neutral-500">{firstTask ? `${ventureNames.get(firstTask.ventureId) ?? "Venture"}: ${firstTask.title}. ${firstTask.outcome}` : "No open tasks in this scope. This view only shows records returned by the API."}</p><p className="mt-5 text-[11px] font-medium text-neutral-400">Snapshot {dateLabel(data.dashboard.asOf)} · {filteredTasks.length} shared task{filteredTasks.length === 1 ? "" : "s"} loaded</p></div><div className="flex flex-col justify-between bg-[#14203b] p-5 text-white"><div><p className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-white/45">30-day direction</p><p className="mt-3 text-[16px] font-extrabold leading-6">{filteredOutcomes[0]?.title ?? "Set the next outcome"}</p><p className="mt-2 text-[12px] font-medium leading-5 text-white/60">{filteredOutcomes[0]?.description ?? "No outcome has been recorded for this scope."}</p></div><a href="#connected-tasks" className={clsx(button, "mt-5 bg-white text-neutral-900 hover:bg-neutral-100")}>View live tasks<ArrowRight size={14} /></a></div></div></section>
        <section className={clsx(card, "col-span-12 p-5 lg:col-span-4 sm:p-6")}><p className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-neutral-400">Venture health</p><h2 className="mt-1 text-[16px] font-extrabold tracking-tight text-neutral-900">Across the studio</h2><div className="mt-5 space-y-4">{activeVentures.map((venture) => <div key={venture.id}><div className="flex items-center justify-between gap-3"><span className="truncate text-[12px] font-bold text-neutral-700">{venture.name}</span><span className="text-[11px] font-bold text-neutral-500 tnum">{venture.health === undefined ? "Not rated" : `${venture.health}/100`}</span></div>{venture.health !== undefined && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100"><div className="h-full rounded-full bg-primary-600" style={{ width: `${venture.health}%` }} /></div>}<p className="mt-1.5 text-[11px] leading-4 text-neutral-400">{venture.goal30Day || "No 30-day goal recorded"}</p></div>)}</div></section>
        <section id="connected-tasks" className={clsx(card, "col-span-12 overflow-hidden lg:col-span-8")}><div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5"><div><p className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-neutral-400">Canonical task records</p><h2 className="mt-1 text-[16px] font-extrabold tracking-tight text-neutral-900">Shared work queue</h2></div><span className="text-[11px] font-semibold text-neutral-400">{filteredTasks.length} shown{data.taskPage.nextCursor ? " · More available" : ""}</span></div><div className="mt-2">{filteredTasks.length ? filteredTasks.map((task) => <TaskRow key={task.id} task={task} ventureName={ventureNames.get(task.ventureId) ?? "Unknown venture"} canUpdate={data.bootstrap.membership.role === "admin" || data.bootstrap.membership.role === "venture_head" || task.assigneeId === data.bootstrap.user.id || task.reviewerId === data.bootstrap.user.id} busy={busyId === task.id} onStart={startTask} />) : <p className="px-5 py-9 text-sm text-neutral-500">No tasks in this venture.</p>}</div>{data.taskPage.nextCursor && <div className="p-4 text-center"><button type="button" disabled={loadingMore} onClick={loadMoreTasks} className={clsx(button, "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:cursor-wait disabled:opacity-50")}>{loadingMore ? "Loading…" : "Load more tasks"}</button></div>}</section>
        <section className={clsx(card, "col-span-12 p-5 lg:col-span-4 sm:p-6")}><p className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-neutral-400">Outcomes</p><h2 className="mt-1 text-[16px] font-extrabold tracking-tight text-neutral-900">30-day commitments</h2><div className="mt-4 space-y-3">{filteredOutcomes.map((outcome) => <div key={outcome.id} className="rounded-xl bg-neutral-50 p-3"><p className="text-[12px] font-bold text-neutral-800">{outcome.title}</p><p className="mt-1 text-[10px] font-medium text-neutral-400">{ventureNames.get(outcome.ventureId) ?? "Venture"} · Review {dateLabel(outcome.reviewAt)}</p><span className={clsx("mt-2 inline-block rounded-md px-2 py-1 text-[10px] font-bold capitalize", statusTone(outcome.status))}>{statusLabel(outcome.status)}</span></div>)}{filteredOutcomes.length === 0 && <p className="text-sm text-neutral-500">No outcomes in this scope.</p>}</div></section>
      </div>
      <p className="mt-5 text-center text-[10px] font-medium text-neutral-400">Connected API preview · Refresh to read the latest canonical records.</p>
    </>}
  </div>;
}
