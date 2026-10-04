"use client";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Plus, RefreshCw, Search } from "@/components/ui/icons";
import type { Task } from "@venture-studio/contracts";
import { createLiveTask, commentOnLiveTask, getLiveTask, listLiveMembers, listLiveTasks, loadLiveSession, reviewLiveEvidence, submitLiveEvidence, updateLiveTask } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageFrame, PageTitle, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { LiveFileDownload, LiveFileUpload } from "@/components/studio/live-file-controls";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Detail = Awaited<ReturnType<typeof getLiveTask>>;
type Status = Task["status"];

const statuses: Status[] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
const tomorrow = () => { const date = new Date(); date.setDate(date.getDate() + 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const label = (value: string) => value.replaceAll("_", " ");
const displayDate = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Please try again.";
const safeHttpUrl = (value: string) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };

function canEdit(session: Session, task: Task) {
  return ["admin", "venture_head"].includes(session.membership.role) || task.assigneeId === session.user.id || task.reviewerId === session.user.id;
}

function TaskDetail({ id, session, onClose, onChanged }: { id: string; session: Session; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<Status>("proposed");
  const [assigneeId, setAssigneeId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [blocker, setBlocker] = useState("");
  const [evidenceTitle, setEvidenceTitle] = useState("");
  const [evidenceDescription, setEvidenceDescription] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [comment, setComment] = useState("");
  const [fileNotice, setFileNotice] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => getLiveTask(id).then((result) => {
      if (!active) return;
      setDetail(result);
      setStatus(result.task.status);
      setAssigneeId(result.task.assigneeId);
      setReviewerId(result.task.reviewerId ?? "");
      setBlocker(result.task.blocker ?? "");
      setError("");
    }).catch((cause: unknown) => { if (active) setError(message(cause)); }));
    return () => { active = false; };
  }, [id, revision]);

  async function mutate(action: () => Promise<unknown>, reset?: () => void) {
    setBusy(true);
    setError("");
    try { await action(); reset?.(); setRevision((value) => value + 1); onChanged(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const task = detail?.task;
  const reviewer = task && (["admin", "venture_head"].includes(session.membership.role) || task.reviewerId === session.user.id);
  const editable = task && canEdit(session, task);
  const canUpload = task && ["admin", "venture_head", "contributor"].includes(session.membership.role);
  const venture = session.hierarchy.ventures.find((item) => item.id === task?.ventureId);

  return <DetailDrawer title={task?.title ?? "Task"} subtitle="Assignment, evidence, and review" onClose={onClose}>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {!detail ? <p className="text-sm text-neutral-500">Loading task detail…</p> : <div className="space-y-6">
      <div><div className="flex flex-wrap gap-2"><Badge tone={task?.priority === "urgent" || task?.priority === "high" ? "red" : "neutral"}>{task?.priority}</Badge><Badge tone={task?.status === "blocked" ? "red" : task?.status === "done" ? "green" : "blue"}>{label(task?.status ?? "")}</Badge></div><p className="mt-3 text-sm leading-6 text-neutral-700">{task?.outcome}</p><p className="mt-2 text-xs text-neutral-500">{venture?.name ?? "Venture"} · Due {displayDate(task!.dueAt)} · {task!.estimatedMinutes} min · {task!.timezone}</p></div>
      <div className="grid gap-3 rounded-xl bg-neutral-50 p-4 text-sm sm:grid-cols-2"><div><p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Definition of done</p><p className="mt-1 leading-5 text-neutral-700">{task!.definitionOfDone}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Evidence required</p><p className="mt-1 leading-5 text-neutral-700">{task!.evidenceRequirement}</p></div>{task!.blocker && <p className="sm:col-span-2 text-danger-text">Blocked: {task!.blocker}</p>}</div>
      {editable && <form onSubmit={(event) => { event.preventDefault(); if (!task) return; mutate(() => updateLiveTask(task.id, { status, blocker: status === "blocked" ? blocker : null })); }} className="space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Update status</h3><div className="grid gap-2 sm:grid-cols-2"><Field label="Status"><Select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as Status)}>{statuses.map((item) => <option key={item} value={item}>{label(item)}</option>)}</Select></Field><Field label="Blocker, if blocked"><input className={inputClass} value={blocker} onChange={(event) => setBlocker(event.target.value)} placeholder="What is stopping work?" /></Field></div><p className="text-xs leading-5 text-neutral-500">Completion requires accepted evidence or a reviewed exception. Work cannot be marked done until that requirement is met.</p><button type="submit" disabled={busy || (status === "blocked" && !blocker.trim())} className={primaryClass}>Save status</button></form>}
      {editable && <form onSubmit={(event) => { event.preventDefault(); if (!task || !assigneeId) return; mutate(() => updateLiveTask(task.id, { assigneeId, ...(reviewerId ? { reviewerId } : {}) })); }} className="space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">People</h3><LiveMemberPicker label="Assignee" value={assigneeId} onChange={setAssigneeId} ventureId={task!.ventureId} groupId={task!.groupId} /><LiveMemberPicker label="Reviewer" value={reviewerId} onChange={setReviewerId} ventureId={task!.ventureId} groupId={task!.groupId} optional /><p className="text-xs text-neutral-500">Both people must be active members of this venture and group. An existing reviewer cannot be removed here.</p><button type="submit" disabled={busy || !assigneeId || (!!task!.reviewerId && !reviewerId)} className={secondaryClass}>Save people</button></form>}
      <section className="space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Task attachments</h3><p className="text-xs leading-5 text-neutral-500">Attachments are scoped to this task and can be downloaded after an access check. Uploading a file does not automatically create reviewed evidence.</p>{detail.attachments.length ? <ul className="space-y-2">{detail.attachments.map((file) => <li key={file.id} className="rounded-xl bg-neutral-50 p-3"><p className="text-sm font-semibold text-neutral-800">{file.name}</p><p className="text-xs text-neutral-500">{file.contentType} · {Math.ceil(file.size / 1024)} KB · ID {file.id}</p><LiveFileDownload id={file.id} name={file.name} /></li>)}</ul> : <p className="text-xs text-neutral-500">No files are attached to this task.</p>}{canUpload && <LiveFileUpload ventureId={task!.ventureId} groupId={task!.groupId} taskId={task!.id} onUploaded={(file) => { setFileNotice(`${file.name} is attached. The evidence form below was prepared with its file ID; submit it separately for review.`); setEvidenceTitle(file.name); setEvidenceDescription(`Review task attachment ${file.id} (${file.name}) as supporting evidence.`); setEvidenceUrl(""); setRevision((value) => value + 1); }} />}{fileNotice && <p role="status" className="text-xs font-semibold text-success-text">{fileNotice}</p>}</section>
      <section className="border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Evidence</h3>{detail.evidence.length ? <ul className="mt-3 space-y-2">{detail.evidence.map((item) => <li key={item.id} className="rounded-xl bg-neutral-50 p-3"><p className="text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 text-xs leading-5 text-neutral-500">{item.description}</p>{item.uri && safeHttpUrl(item.uri) && <a href={item.uri} target="_blank" rel="noopener noreferrer" className="mt-1 block break-all text-xs font-semibold text-primary-700 underline">Open source</a>}<div className="mt-2 flex flex-wrap items-center gap-2"><Badge tone={item.reviewStatus === "accepted" || item.reviewStatus === "exception" ? "green" : item.reviewStatus === "rejected" ? "red" : "amber"}>{item.reviewStatus}</Badge>{reviewer && item.reviewStatus === "pending" && <><button disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "accepted"))} className="text-xs font-semibold text-success-text hover:underline">Accept</button><button disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "rejected"))} className="text-xs font-semibold text-danger-text hover:underline">Reject</button><button disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "exception"))} className="text-xs font-semibold text-primary-700 hover:underline">Exception</button></>}</div></li>)}</ul> : <p className="mt-2 text-xs text-neutral-500">No evidence submitted yet.</p>}
        <form onSubmit={(event) => { event.preventDefault(); if (!task) return; if (evidenceUrl && !safeHttpUrl(evidenceUrl)) { setError("Evidence links must use http:// or https://."); return; } mutate(() => submitLiveEvidence(task.id, { title: evidenceTitle, description: evidenceDescription, ...(evidenceUrl ? { uri: evidenceUrl } : {}) }), () => { setEvidenceTitle(""); setEvidenceDescription(""); setEvidenceUrl(""); }); }} className="mt-4 grid gap-2"><Field label="Evidence title"><input required className={inputClass} value={evidenceTitle} onChange={(event) => setEvidenceTitle(event.target.value)} /></Field><Field label="Description"><textarea required className={`${inputClass} min-h-20 py-3`} value={evidenceDescription} onChange={(event) => setEvidenceDescription(event.target.value)} /></Field><Field label="Source URL, optional"><input type="url" className={inputClass} value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} /></Field><button disabled={busy} className={secondaryClass}>Submit evidence for review</button></form>
      </section>
      <section className="border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Activity</h3><div className="mt-3 space-y-2">{detail.updates.map((item) => <div key={item.id} className="rounded-xl bg-neutral-50 p-3 text-xs text-neutral-600"><p className="font-bold capitalize text-neutral-800">{item.type} · {displayDate(item.createdAt)}</p><p className="mt-1">{item.body}</p></div>)}</div><form onSubmit={(event) => { event.preventDefault(); if (!task) return; mutate(() => commentOnLiveTask(task.id, comment.trim()), () => setComment("")); }} className="mt-4 flex flex-col gap-2"><label className="text-xs font-semibold text-neutral-600" htmlFor="live-comment">Add comment</label><textarea id="live-comment" required className={`${inputClass} min-h-20 py-3`} value={comment} onChange={(event) => setComment(event.target.value)} /><button disabled={busy || !comment.trim()} className={`${secondaryClass} self-start`}>Post comment</button></form></section>
    </div>}
  </DetailDrawer>;
}

function NewTask({ session, activeVentureId, onClose, onCreated }: { session: Session; activeVentureId: string; onClose: () => void; onCreated: (task: Task) => void }) {
  const firstVenture = session.hierarchy.ventures.find((item) => item.id === activeVentureId);
  const [ventureId, setVentureId] = useState(firstVenture?.id ?? "");
  const [groupId, setGroupId] = useState(firstVenture?.groups[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [outcome, setOutcome] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [dueDate, setDueDate] = useState(tomorrow);
  const [minutes, setMinutes] = useState(60);
  const [definition, setDefinition] = useState("");
  const [evidenceRequirement, setEvidenceRequirement] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const groups = session.hierarchy.ventures.find((item) => item.id === ventureId)?.groups ?? [];

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const task = await createLiveTask({ ventureId, groupId, title, outcome, assigneeId, ...(reviewerId ? { reviewerId } : {}), priority, dueAt: new Date(`${dueDate}T17:00:00`).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", estimatedMinutes: minutes, definitionOfDone: definition, evidenceRequirement, tags: tags.split(",").map((item) => item.trim()).filter(Boolean), dependencies: [], evidenceLinks: [] });
      onCreated(task);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  return <DetailDrawer title="Create task" subtitle="Assign a member of this venture and group" onClose={onClose}><form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
    {activeVentureId ? <div aria-label="Task destination" className="rounded-xl bg-neutral-50 p-3 text-sm"><span className="block text-xs font-semibold text-neutral-500">Venture</span><span className="font-bold text-neutral-800">{firstVenture?.name}</span></div> : <Field label="Venture"><Select className={inputClass} value={ventureId} onChange={(event) => { const next = session.hierarchy.ventures.find((item) => item.id === event.target.value); setVentureId(event.target.value); setGroupId(next?.groups[0]?.id ?? ""); setAssigneeId(""); setReviewerId(""); }}><option value="">Choose venture</option>{session.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>}
    <Field label="Group"><Select className={inputClass} value={groupId} onChange={(event) => { setGroupId(event.target.value); setAssigneeId(""); setReviewerId(""); }}>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
    <LiveMemberPicker label="Assignee" value={assigneeId} onChange={setAssigneeId} ventureId={ventureId} groupId={groupId} />
    <LiveMemberPicker label="Reviewer" value={reviewerId} onChange={setReviewerId} ventureId={ventureId} groupId={groupId} optional />
    <div className="sm:col-span-2"><Field label="Task title"><input required maxLength={200} className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} /></Field></div>
    <div className="sm:col-span-2"><Field label="Desired outcome"><textarea required className={`${inputClass} min-h-20 py-3`} value={outcome} onChange={(event) => setOutcome(event.target.value)} /></Field></div>
    <Field label="Priority"><Select className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value as Task["priority"])}>{(["low", "medium", "high", "urgent"] as const).map((item) => <option key={item} value={item}>{item}</option>)}</Select></Field>
    <Field label="Due date"><input required type="date" className={inputClass} value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
    <Field label="Estimated minutes"><input required min={1} max={100800} type="number" className={inputClass} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></Field>
    <Field label="Tags, comma-separated"><input className={inputClass} value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
    <div className="sm:col-span-2"><Field label="Definition of done"><textarea required className={`${inputClass} min-h-20 py-3`} value={definition} onChange={(event) => setDefinition(event.target.value)} /></Field></div>
    <div className="sm:col-span-2"><Field label="Evidence requirement"><textarea required className={`${inputClass} min-h-20 py-3`} value={evidenceRequirement} onChange={(event) => setEvidenceRequirement(event.target.value)} /></Field></div>
    {error && <p role="alert" className="sm:col-span-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button><button disabled={busy || !groupId || !assigneeId} className={primaryClass}>{busy ? "Creating…" : "Create task"}</button></div>
  </form></DetailDrawer>;
}

export function LiveTasksScreen() {
  const { activeVentureId: ventureId } = useStudio();
  const params = useSearchParams();
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof listLiveMembers>>["items"]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(params.get("task"));
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { const taskId = params.get("task"); if (taskId) queueMicrotask(() => setSelectedId(taskId)); }, [params]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      Promise.all([loadLiveSession(), listLiveTasks(undefined, { ...(ventureId ? { ventureId } : {}), ...(status ? { status: status as Status } : {}) }), listLiveMembers({ limit: 100 }).catch(() => null)]).then(([nextSession, page, directory]) => {
        if (!active) return;
        setSession(nextSession); setTasks(page.items); setMembers(directory?.items ?? []); setCursor(page.nextCursor); setError(""); setBusy(false);
      }).catch((cause: unknown) => { if (active) { setError(message(cause)); setBusy(false); } });
    });
    return () => { active = false; };
  }, [ventureId, status, revision]);

  async function more() {
    if (!cursor) return;
    setBusy(true);
    try { const page = await listLiveTasks(cursor, { ...(ventureId ? { ventureId } : {}), ...(status ? { status: status as Status } : {}) }); setTasks((items) => [...items, ...page.items]); setCursor(page.nextCursor); setError(""); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const visibleTasks = tasks.filter((task) => (!mine || task.assigneeId === session?.user.id) && `${task.title} ${task.outcome} ${task.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const memberName = (id: string) => members.find((member) => member.id === id)?.name ?? (id === session?.user.id ? session.user.name : "Assigned member");

  return <PageFrame><PageTitle title="Tasks" description="Track assignments, evidence, reviews, and activity." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>{session && ["admin", "venture_head", "contributor"].includes(session.membership.role) && <button type="button" onClick={() => setCreating(true)} className={primaryClass}><Plus size={16} />Create task</button>}</div>} />
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel><div className="grid gap-2 border-b border-neutral-100 p-4 sm:grid-cols-2 xl:grid-cols-[minmax(200px,1fr)_repeat(2,160px)]"><label className="relative"><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input aria-label="Search loaded tasks" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search loaded work and tags" className={`${inputClass} pl-9`} /></label><Select aria-label="Owner filter" value={mine ? "Mine" : "All owners"} onChange={(event) => setMine(event.target.value === "Mine")} className={inputClass}><option>All owners</option><option>Mine</option></Select><Select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value)} className={inputClass}><option value="">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{label(item)}</option>)}</Select></div>
      {visibleTasks.length ? <div data-vso-stagger-group className="divide-y divide-neutral-100">{visibleTasks.map((task) => <button key={task.id} type="button" onClick={() => setSelectedId(task.id)} className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="min-w-0 flex-1"><span className="mb-1 flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-neutral-800">{task.title}</span><Badge tone={task.priority === "high" || task.priority === "urgent" ? "red" : "neutral"}>{task.priority}</Badge></span><span className="block text-sm leading-5 text-neutral-500">{task.outcome}</span><span className="mt-1 block text-xs text-neutral-400">{session?.hierarchy.ventures.find((item) => item.id === task.ventureId)?.name ?? "Venture"} · {memberName(task.assigneeId)}{task.reviewerId ? ` → ${memberName(task.reviewerId)}` : ""}</span></span><span className="text-right"><Badge tone={task.status === "blocked" ? "red" : task.status === "done" ? "green" : "blue"}>{label(task.status)}</Badge><span className="mt-1 block text-xs font-semibold text-neutral-500">Due {displayDate(task.dueAt)}</span></span><ArrowRight size={15} className="text-neutral-400" /></button>)}</div> : busy ? <p className="p-8 text-sm text-neutral-500">Loading tasks…</p> : <Empty title="No matching tasks" body="No tasks are available in this scope." />}
      {cursor && <div className="border-t border-neutral-100 p-4 text-center"><button type="button" disabled={busy} onClick={more} className={secondaryClass}>{busy ? "Loading…" : "Load more"}</button></div>}
    </Panel>
    {session && selectedId && <TaskDetail key={selectedId} id={selectedId} session={session} onClose={() => setSelectedId(null)} onChanged={() => setRevision((value) => value + 1)} />}
    {session && creating && <NewTask key={ventureId || "all"} session={session} activeVentureId={ventureId} onClose={() => setCreating(false)} onCreated={(task) => { setCreating(false); setSelectedId(task.id); setRevision((value) => value + 1); }} />}
  </PageFrame>;
}
