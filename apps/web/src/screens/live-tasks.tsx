"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, FileText, ListTodo, MessageCircle, Paperclip, Plus, Search, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { openNewTask, TASK_CREATED_EVENT } from "@/components/studio/new-task-dialog";
import type { Task } from "@venture-studio/contracts";
import { commentOnLiveTask, getLiveTask, listLiveMembers, listLiveTasks, loadLiveSession, reviewLiveEvidence, submitLiveEvidence, updateLiveTask } from "@/lib/studio-api";
import { ActionLabel, Badge, DetailDrawer, Field, HeaderActions, inputClass, Notice, PageFrame, PageTitle, Panel, primaryClass, RefreshButton, secondaryClass, SkeletonRows, useFlag } from "@/components/studio/primitives";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { flashById } from "@/lib/motion";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { LiveFileDownload, LiveFileUpload } from "@/components/studio/live-file-controls";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Detail = Awaited<ReturnType<typeof getLiveTask>>;
type Status = Task["status"];

const statuses: Status[] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
const reviewPill = "inline-flex min-h-8 items-center rounded-lg px-2.5 text-xs font-semibold transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] disabled:opacity-50";
const typingTarget = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !!target.closest('[role="combobox"], [role="dialog"]'));
const label = (value: string) => value.replaceAll("_", " ");
const displayDate = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
const message = (cause: unknown) => describeError(cause, "The request failed. Please try again.");
const atRisk = (task: Task) => task.deadlineRisk && !["done", "cancelled", "parked"].includes(task.status);
const safeHttpUrl = (value: string) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };

function canEdit(session: Session, task: Task) {
  return ["admin", "venture_head"].includes(session.membership.role) || task.assigneeId === session.user.id || task.reviewerId === session.user.id;
}

function TaskDetail({ id, session, memberName, enter, onClose, onChanged }: { id: string; session: Session; memberName: (id: string) => string; enter: boolean; onClose: () => void; onChanged: () => void }) {
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
  const [editingDetails, setEditingDetails] = useState(false);
  const [draft, setDraft] = useState({ title: "", outcome: "", definitionOfDone: "", evidenceRequirement: "", tags: "" });
  // The details as they were when editing began: only fields changed since then are sent, so a refresh can't revert someone else's edit.
  const [draftBase, setDraftBase] = useState(draft);
  const [fileNotice, setFileNotice] = useState("");
  const [pending, setPending] = useState("");
  const [saved, markSaved] = useFlag();
  // Items present at first load stay still; anything added afterwards rises in.
  const [knownIds, setKnownIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => getLiveTask(id).then((result) => {
      if (!active) return;
      setDetail(result);
      setKnownIds((current) => current ?? new Set([...result.evidence, ...result.updates, ...result.attachments].map((item) => item.id)));
      setStatus(result.task.status);
      setAssigneeId(result.task.assigneeId);
      setReviewerId(result.task.reviewerId ?? "");
      setBlocker(result.task.blocker ?? "");
      setError("");
    }).catch((cause: unknown) => { if (active) setError(message(cause)); }));
    return () => { active = false; };
  }, [id, revision]);

  async function mutate(action: () => Promise<unknown>, reset?: () => void, key = "") {
    setBusy(true); setPending(key);
    setError("");
    try { await action(); reset?.(); setRevision((value) => value + 1); onChanged(); if (key) markSaved(key); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); setPending(""); }
  }
  const isNew = (itemId: string) => !!knownIds && !knownIds.has(itemId);

  const task = detail?.task;
  const reviewer = task && (["admin", "venture_head"].includes(session.membership.role) || task.reviewerId === session.user.id);
  const editable = task && canEdit(session, task);
  const canUpload = task && ["admin", "venture_head", "contributor"].includes(session.membership.role);
  // Mirrors the API: the assignee or a lead of this venture submits evidence; nobody approves their own submission or task.
  const canSubmitEvidence = task && (task.assigneeId === session.user.id || session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.includes(task.ventureId)));
  const canReviewEvidence = (submittedBy: string) => !!reviewer && (session.membership.role === "admin" || (submittedBy !== session.user.id && task?.assigneeId !== session.user.id));
  const venture = session.hierarchy.ventures.find((item) => item.id === task?.ventureId);
  // Mirrors the API: a task's details belong to whoever created it, and admins.
  const canEditDetails = task && !["done", "cancelled"].includes(task.status) && (session.membership.role === "admin" || task.creatorId === session.user.id);
  function startEditing() {
    if (!task) return;
    const current = { title: task.title, outcome: task.outcome, definitionOfDone: task.definitionOfDone, evidenceRequirement: task.evidenceRequirement, tags: task.tags.join(", ") };
    setDraft(current); setDraftBase(current);
    setEditingDetails(true);
  }
  function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    if (!task) return;
    const tags = [...new Set(draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean))];
    if (draft.tags !== draftBase.tags && (tags.length > 30 || tags.some((tag) => tag.length > 50))) { setError("Use up to 30 tags, each up to 50 characters."); return; }
    // Only what was changed in this form is sent, so the activity log names the right fields.
    const edited = (field: "title" | "outcome" | "definitionOfDone" | "evidenceRequirement") => draft[field].trim() !== draftBase[field].trim() ? { [field]: draft[field].trim() } : {};
    const change = { ...edited("title"), ...edited("outcome"), ...edited("definitionOfDone"), ...edited("evidenceRequirement"), ...(draft.tags !== draftBase.tags ? { tags } : {}) };
    if (!Object.keys(change).length) { setEditingDetails(false); return; }
    void mutate(() => updateLiveTask(task.id, change), () => setEditingDetails(false), "details");
  }
  const edit = (field: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((value) => ({ ...value, [field]: event.target.value }));
  const detailsForm = task && <form onSubmit={saveDetails} className="vso-fade-enter space-y-3 rounded-xl border border-neutral-100 p-4">
    <h3 className="text-sm font-semibold text-neutral-900">Edit details</h3>
    <Field label="Title"><input required maxLength={200} className={inputClass} value={draft.title} onChange={edit("title")} /></Field>
    <Field label="Outcome"><textarea required maxLength={2000} className={`${inputClass} min-h-20 py-3`} value={draft.outcome} onChange={edit("outcome")} /></Field>
    <Field label="Definition of done"><textarea required maxLength={5000} className={`${inputClass} min-h-20 py-3`} value={draft.definitionOfDone} onChange={edit("definitionOfDone")} /></Field>
    <Field label="Evidence required"><textarea required maxLength={2000} className={`${inputClass} min-h-16 py-3`} value={draft.evidenceRequirement} onChange={edit("evidenceRequirement")} /></Field>
    <Field label="Tags, separated by commas"><input className={inputClass} value={draft.tags} onChange={edit("tags")} placeholder="design, launch" /></Field>
    {task.assigneeId !== session.user.id && <p className="text-xs text-neutral-500">{memberName(task.assigneeId)} is told about the change.</p>}
    <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={pending === "details"} idle="Save details" /></button><button type="button" disabled={busy} onClick={() => setEditingDetails(false)} className={secondaryClass}>Cancel</button></div>
  </form>;

  return <DetailDrawer title={task?.title ?? "Task"} subtitle="Assignment, evidence, and review" enter={enter} onClose={onClose}>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="pb-4" />
    {!detail ? !error && <SkeletonRows rows={4} label="Loading task" className="!p-0" /> : <div className="vso-fade-enter space-y-6 [overflow-wrap:anywhere]">
      <div><div className="flex flex-wrap gap-2"><Badge tone={task?.priority === "urgent" || task?.priority === "high" ? "red" : "neutral"}>{task?.priority}</Badge><Badge tone={task?.status === "blocked" ? "red" : task?.status === "done" ? "green" : "blue"}>{label(task?.status ?? "")}</Badge>{task && atRisk(task) && <Badge tone="amber">Deadline risk</Badge>}{canEditDetails && !editingDetails && <button type="button" onClick={startEditing} className="ml-auto inline-flex min-h-7 items-center rounded-lg px-2.5 text-xs font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-50 active:scale-[0.97]">Edit details</button>}</div>{!editingDetails && <p className="mt-3 text-sm leading-6 text-neutral-700">{task?.outcome}</p>}{!editingDetails && !!task?.tags.length && <div className="mt-2 flex flex-wrap gap-1.5">{task.tags.map((tag) => <span key={tag} className="rounded-md bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">{tag}</span>)}</div>}<p className="mt-2 text-xs text-neutral-500">{venture?.name ?? "Venture"} · Due {displayDate(task!.dueAt)} · {task!.estimatedMinutes} min · {task!.timezone}</p>{atRisk(task!) && <p className="mt-2 text-xs font-semibold text-warning-text">The estimated effort is longer than the time left before the due date.</p>}</div>
      {editingDetails ? detailsForm : <div className="grid gap-3 rounded-xl bg-neutral-50 p-4 text-sm sm:grid-cols-2"><div><p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Definition of done</p><p className="mt-1 leading-5 text-neutral-700">{task!.definitionOfDone}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Evidence required</p><p className="mt-1 leading-5 text-neutral-700">{task!.evidenceRequirement}</p></div>{task!.blocker && <p className="sm:col-span-2 text-danger-text">Blocked: {task!.blocker}</p>}</div>}
      {editable && <form onSubmit={(event) => { event.preventDefault(); if (!task) return; mutate(() => updateLiveTask(task.id, { status, blocker: status === "blocked" ? blocker : null }), undefined, "status"); }} className="space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Update status</h3><div className="grid gap-2 sm:grid-cols-2"><Field label="Status"><Select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as Status)}>{statuses.map((item) => <option key={item} value={item}>{label(item)}</option>)}</Select></Field><Field label="Blocker, if blocked"><input className={inputClass} value={blocker} onChange={(event) => setBlocker(event.target.value)} placeholder="What is stopping work?" /></Field></div><p className="text-xs leading-5 text-neutral-500">Completion requires accepted evidence or a reviewed exception. Work cannot be marked done until that requirement is met.</p><button type="submit" disabled={busy || (status === "blocked" && !blocker.trim())} className={primaryClass}><ActionLabel busy={pending === "status"} done={saved === "status"} idle="Save status" /></button></form>}
      {editable && <form onSubmit={(event) => { event.preventDefault(); if (!task || !assigneeId) return; mutate(() => updateLiveTask(task.id, { assigneeId, ...(reviewerId ? { reviewerId } : {}) }), undefined, "people"); }} className="space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">People</h3><LiveMemberPicker label="Assignee" value={assigneeId} onChange={setAssigneeId} ventureId={task!.ventureId} groupId={task!.groupId} /><LiveMemberPicker label="Reviewer" value={reviewerId} onChange={setReviewerId} ventureId={task!.ventureId} groupId={task!.groupId} optional /><p className="text-xs text-neutral-500">Both people must be active members of this venture and group. An existing reviewer cannot be removed here.</p><button type="submit" disabled={busy || !assigneeId || (!!task!.reviewerId && !reviewerId)} className={secondaryClass}><ActionLabel busy={pending === "people"} done={saved === "people"} idle="Save people" /></button></form>}
      <section className="space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Task attachments</h3><p className="text-xs leading-5 text-neutral-500">Attachments are scoped to this task and can be downloaded after an access check. Uploading a file does not automatically create reviewed evidence.</p>{detail.attachments.length ? <ul className="space-y-2">{detail.attachments.map((file) => <li key={file.id} className={clsx("rounded-xl bg-neutral-50 p-3", isNew(file.id) && "vso-row-enter")}><p className="text-sm font-semibold text-neutral-800">{file.name}</p><p className="text-xs text-neutral-500">{file.contentType} · {Math.ceil(file.size / 1024)} KB · ID {file.id}</p><LiveFileDownload id={file.id} name={file.name} /></li>)}</ul> : <EmptyState variant="compact" icon={Paperclip} title="No files attached" body={canUpload ? "Upload one below." : undefined} />}{canUpload && <LiveFileUpload ventureId={task!.ventureId} groupId={task!.groupId} taskId={task!.id} onUploaded={(file) => { setFileNotice(`${file.name} is attached. The evidence form below was prepared with its file ID; submit it separately for review.`); setEvidenceTitle(file.name); setEvidenceDescription(`Review task attachment ${file.id} (${file.name}) as supporting evidence.`); setEvidenceUrl(""); setRevision((value) => value + 1); }} />}<Notice tone="success" message={fileNotice} onDismiss={() => setFileNotice("")} autoDismissMs={8000} /></section>
      <section className="border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Evidence</h3>{detail.evidence.length ? <ul className="mt-3 space-y-2">{detail.evidence.map((item) => <li key={item.id} className={clsx("rounded-xl bg-neutral-50 p-3", isNew(item.id) && "vso-row-enter")}><p className="text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 text-xs leading-5 text-neutral-500">{item.description}</p>{item.uri && safeHttpUrl(item.uri) && <a href={item.uri} target="_blank" rel="noopener noreferrer" className="mt-1 block break-all text-xs font-semibold text-primary-700 underline">Open source</a>}<div className="mt-2 flex flex-wrap items-center gap-2"><Badge tone={item.reviewStatus === "accepted" || item.reviewStatus === "exception" ? "green" : item.reviewStatus === "rejected" ? "red" : "amber"}>{item.reviewStatus}</Badge>{canReviewEvidence(item.submittedBy) && item.reviewStatus === "pending" && <><button type="button" disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "accepted"))} className={clsx(reviewPill, "bg-success-surface text-success-text")}>Accept</button><button type="button" disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "rejected"))} className={clsx(reviewPill, "bg-danger-surface text-danger-text")}>Reject</button><button type="button" disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "exception"))} className={clsx(reviewPill, "bg-primary-50 text-primary-700")}>Exception</button></>}</div></li>)}</ul> : <EmptyState variant="compact" icon={FileText} title="No evidence submitted yet" body={canSubmitEvidence ? "Use the form below to submit it for review." : "Submitted evidence appears here for review."} className="mt-3" />}
        {canSubmitEvidence && <form onSubmit={(event) => { event.preventDefault(); if (!task) return; if (evidenceUrl && !safeHttpUrl(evidenceUrl)) { setError("Evidence links must use http:// or https://."); return; } mutate(() => submitLiveEvidence(task.id, { title: evidenceTitle, description: evidenceDescription, ...(evidenceUrl ? { uri: evidenceUrl } : {}) }), () => { setEvidenceTitle(""); setEvidenceDescription(""); setEvidenceUrl(""); }, "evidence"); }} className="mt-4 grid gap-2"><Field label="Evidence title"><input required className={inputClass} value={evidenceTitle} onChange={(event) => setEvidenceTitle(event.target.value)} /></Field><Field label="Description"><textarea required className={`${inputClass} min-h-20 py-3`} value={evidenceDescription} onChange={(event) => setEvidenceDescription(event.target.value)} /></Field><Field label="Source URL, optional"><input type="url" className={inputClass} value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} /></Field><button disabled={busy} className={secondaryClass}><ActionLabel busy={pending === "evidence"} done={saved === "evidence"} idle="Submit evidence for review" busyText="Submitting…" doneText="Submitted for review" /></button></form>}
      </section>
      <section className="border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Activity</h3>{detail.updates.length ? <div className="mt-3 space-y-2">{detail.updates.map((item) => <div key={item.id} className={clsx("rounded-xl bg-neutral-50 p-3 text-xs text-neutral-600", isNew(item.id) && "vso-row-enter")}><p className="font-bold text-neutral-800">{item.authorId === session.user.id ? "You" : memberName(item.authorId)} <span className="font-semibold capitalize text-neutral-500">· {item.type} · {displayDate(item.createdAt)}</span>{item.via === "claude" && <span className="font-semibold text-neutral-500"> · via Claude</span>}</p><p className="mt-1 whitespace-pre-wrap">{item.body}</p></div>)}</div> : <EmptyState variant="compact" icon={MessageCircle} title="No activity yet" body="Status changes and comments appear here." className="mt-3" />}<form onSubmit={(event) => { event.preventDefault(); if (!task) return; mutate(() => commentOnLiveTask(task.id, comment.trim()), () => setComment(""), "comment"); }} className="mt-4 flex flex-col gap-2"><label className="text-xs font-semibold text-neutral-600" htmlFor="live-comment">Add comment</label><textarea id="live-comment" required aria-keyshortcuts="Control+Enter" className={`${inputClass} min-h-20 py-3`} value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="flex items-center gap-3"><button disabled={busy || !comment.trim()} className={secondaryClass}><ActionLabel busy={pending === "comment"} done={saved === "comment"} idle="Post comment" busyText="Posting…" doneText="Posted" /></button><span className="text-[11px] text-neutral-400">Ctrl+Enter to post</span></div></form></section>
    </div>}
  </DetailDrawer>;
}

export function LiveTasksScreen() {
  const { activeVentureId: ventureId } = useStudio();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const clearParam = (name: string) => { if (!params.has(name)) return; const next = new URLSearchParams(params); next.delete(name); router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false }); };
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof listLiveMembers>>["items"]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(params.get("task"));
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  // A drawer that replaces the create drawer opens without a second slide.
  const [detailEnter, setDetailEnter] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const canCreate = !!session && ["admin", "venture_head", "contributor"].includes(session.membership.role);

  // "/" focuses search and "c" starts a task, unless the member is typing or a drawer is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typingTarget(event.target) || selectedId) return;
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
      else if (event.key === "c" && canCreate) { event.preventDefault(); openNewTask(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canCreate, selectedId]);

  useEffect(() => { const taskId = params.get("task"); if (taskId) queueMicrotask(() => setSelectedId(taskId)); }, [params]);
  // Old links with ?new=1 still open the form (the shared popup), then drop the parameter.
  useEffect(() => { if (params.get("new") === "1") queueMicrotask(() => { openNewTask(); clearParam("new"); }); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  // A task created in the popup appears in the list and opens, as it did with the old drawer.
  useEffect(() => {
    const onCreated = (event: Event) => { const task = (event as CustomEvent<Task>).detail; setDetailEnter(true); setSelectedId(task.id); setRevision((value) => value + 1); flashById(task.id); };
    window.addEventListener(TASK_CREATED_EVENT, onCreated);
    return () => window.removeEventListener(TASK_CREATED_EVENT, onCreated);
  }, []);

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
    setLoadingMore(true);
    try { const page = await listLiveTasks(cursor, { ...(ventureId ? { ventureId } : {}), ...(status ? { status: status as Status } : {}) }); setTasks((items) => [...items, ...page.items]); setCursor(page.nextCursor); setError(""); }
    catch (cause) { setError(message(cause)); }
    finally { setLoadingMore(false); }
  }

  const visibleTasks = tasks.filter((task) => (!mine || task.assigneeId === session?.user.id) && `${task.title} ${task.outcome} ${task.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const memberName = (id: string) => members.find((member) => member.id === id)?.name ?? (id === session?.user.id ? session.user.name : "Assigned member");
  const mineCount = tasks.filter((task) => task.assigneeId === session?.user.id).length;
  // The count line only describes what search and Mine hide; the status filter reloads the list instead.
  const loadedFiltered = Boolean(query.trim() || mine);
  // Any active filter, status included, decides between "nothing yet" and "nothing matches".
  const filtered = loadedFiltered || Boolean(status);
  const clearFilters = () => { setQuery(""); setMine(false); setStatus(""); };
  const refresh = () => setRevision((value) => value + 1);
  // A failed load is an error, never an empty list; the error state carries the message, so the notice stays quiet.
  const failedWithoutTasks = !!error && !tasks.length;
  const loadFailed = failedWithoutTasks && !busy;
  const firstRun = !!session && !busy && !tasks.length && !filtered && !error;
  const searchLabel = query.trim().length > 32 ? `${query.trim().slice(0, 32)}…` : query.trim();

  return <PageFrame><PageTitle title="Tasks" description="Track assignments, evidence, reviews, and activity." action={<HeaderActions><RefreshButton busy={busy && !!session} onClick={refresh} /></HeaderActions>} />
    <Notice tone="error" message={failedWithoutTasks ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    {firstRun ? <EmptyState variant="page" icon={ListTodo} tone="green" title="No tasks yet" body="Tasks you create or are assigned land here, with their evidence and reviews." action={canCreate ? { label: "Create task", icon: Plus, onClick: openNewTask } : undefined} secondary={{ label: "Open the board", href: "/board/live" }} /> : <Panel><div className="grid items-center gap-2 border-b border-neutral-100 p-4 sm:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(200px,1fr)_auto_180px]"><label className="relative sm:col-span-2 xl:col-span-1"><Search size={16} className="pointer-events-none absolute left-3 top-3.5 text-neutral-400" /><input ref={searchRef} aria-label="Search loaded tasks" aria-keyshortcuts="/" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} placeholder="Search loaded work and tags" className={`${inputClass} pl-9 pr-10`} />{query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }} className="vso-fade-enter absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700"><X size={14} /></button> : <kbd aria-hidden="true" className="pointer-events-none absolute right-3 top-3 hidden rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neutral-400 sm:block">/</kbd>}</label><SlidingTabs fitContent label="Owner filter" className="bg-neutral-100 shadow-none" active={mine ? "mine" : "all"} onChange={(key) => setMine(key === "mine")} tabs={[{ key: "all", label: "All owners" }, { key: "mine", label: "Mine", badge: mineCount }]} /><Select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value)} className={inputClass}><option value="">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{label(item)}</option>)}</Select></div>
      {loadedFiltered && <p aria-live="polite" className="vso-fade-enter border-b border-neutral-100 px-5 py-2 text-xs font-semibold text-neutral-500">{visibleTasks.length} of {tasks.length} loaded tasks</p>}
      {visibleTasks.length ? <div aria-busy={busy || undefined} className={clsx("vso-stagger-in divide-y divide-neutral-100 transition-opacity duration-200", busy && "opacity-60")}>{visibleTasks.map((task) => <button key={task.id} type="button" data-flash-id={task.id} onClick={() => { setDetailEnter(true); setSelectedId(task.id); }} className="group flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:bg-neutral-100"><span className="min-w-0 flex-1"><span className="mb-1 flex flex-wrap items-center gap-2"><span className="min-w-0 text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere]">{task.title}</span><Badge tone={task.priority === "high" || task.priority === "urgent" ? "red" : "neutral"}>{task.priority}</Badge>{atRisk(task) && <Badge tone="amber">Deadline risk</Badge>}</span><span className="block line-clamp-3 text-sm leading-5 text-neutral-500 [overflow-wrap:anywhere]">{task.outcome}</span><span className="mt-1 block text-xs text-neutral-400">{session?.hierarchy.ventures.find((item) => item.id === task.ventureId)?.name ?? "Venture"} · {memberName(task.assigneeId)}{task.reviewerId ? ` → ${memberName(task.reviewerId)}` : ""}</span></span><span className="text-right"><Badge tone={task.status === "blocked" ? "red" : task.status === "done" ? "green" : "blue"}>{label(task.status)}</Badge><span className="mt-1 block text-xs font-semibold text-neutral-500">Due {displayDate(task.dueAt)}</span></span><ArrowRight size={15} className="text-neutral-400 transition-transform duration-150 group-hover:translate-x-0.5" /></button>)}</div> : loadFailed ? <EmptyState variant="error" title="Could not load tasks" body={error} action={{ label: "Try again", onClick: refresh }} /> : busy ? <SkeletonRows rows={5} label="Loading tasks" /> : <EmptyState variant="filtered" title={searchLabel ? `No tasks match "${searchLabel}"` : "No tasks match these filters"} body={cursor && loadedFiltered ? "Search covers the tasks loaded so far. Load more below, or clear the filters." : "Try a different search, owner, or status, or clear the filters."} action={{ label: "Clear filters", onClick: clearFilters }} />}
      {cursor && <div className="border-t border-neutral-100 p-4 text-center"><button type="button" disabled={loadingMore || busy} onClick={more} className={secondaryClass}>{loadingMore ? "Loading…" : "Load more"}</button></div>}
    </Panel>}
    {session && selectedId && <TaskDetail key={selectedId} id={selectedId} session={session} memberName={memberName} enter={detailEnter} onClose={() => { setSelectedId(null); clearParam("task"); }} onChanged={() => setRevision((value) => value + 1)} />}
  </PageFrame>;
}
