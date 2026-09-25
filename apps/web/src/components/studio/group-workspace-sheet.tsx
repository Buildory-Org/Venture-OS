/* eslint-disable @next/next/no-img-element -- Blob URLs are fetched on demand and cannot use Next image optimization. */
"use client";

import { Select } from "@/components/ui/select";
import { useKanbanDnd } from "@/components/ui/use-kanban-dnd";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Download, Eye, Paperclip, Plus, X } from "@/components/ui/icons";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import type { Message, Task } from "@venture-studio/contracts";
import { listLiveGroupFiles, listLiveGroupSavedMessages, listLiveTasks, prepareLiveFileDownload, updateLiveMessageSave, updateLiveTask, uploadLiveFile } from "@/lib/studio-api";

export type WorkspaceTab = "kanban" | "attachments" | "saved";
type FileItem = Awaited<ReturnType<typeof listLiveGroupFiles>>["items"][number];
type SavedItem = Awaited<ReturnType<typeof listLiveGroupSavedMessages>>["items"][number];
type Page<T> = { scope: string; items: T[]; cursor?: string; loading: boolean; error: string };
type Group = { id: string; name: string; channels: { id: string; name: string }[] };

const statuses: Task["status"][] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
const tabs: WorkspaceTab[] = ["kanban", "attachments", "saved"];
const label = (value: string) => value.replaceAll("_", " ");
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Please try again.";
const mediaAccept = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/ogg,audio/webm,audio/wav";
const emptyPage = <T,>(): Page<T> => ({ scope: "", items: [], loading: false, error: "" });

export function GroupWorkspaceSheet({ tab, onTabChange, onClose, ventureId, ventureName, group, userId, role, onSavedChange }: {
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onClose: () => void;
  ventureId: string;
  ventureName: string;
  group?: Group;
  userId: string;
  role: string;
  onSavedChange: (message: Message) => void;
}) {
  const groupId = group?.id ?? "";
  const [tasks, setTasks] = useState<Page<Task>>(emptyPage);
  const [files, setFiles] = useState<Page<FileItem>>(emptyPage);
  const [saved, setSaved] = useState<Page<SavedItem>>(emptyPage);
  const [taskRevision, setTaskRevision] = useState(0);
  const [fileRevision, setFileRevision] = useState(0);
  const [savedRevision, setSavedRevision] = useState(0);
  const [busyTaskId, setBusyTaskId] = useState("");
  const [busyFileId, setBusyFileId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busySavedId, setBusySavedId] = useState("");
  const [actionError, setActionError] = useState("");
  const [preview, setPreview] = useState<{ file: FileItem; url: string; groupId: string } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const previewUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);
  const previewReturnRef = useRef<HTMLElement | null>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => { previewRequestRef.current++; if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); }, []);
  useEffect(() => { queueMicrotask(() => closePreview(false)); }, [groupId]);
  useEffect(() => { if (preview) previewCloseRef.current?.focus(); }, [preview]);

  useEffect(() => {
    if (tab !== "kanban" || !groupId || !ventureId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setTasks({ scope: groupId, items: [], loading: true, error: "" });
      listLiveTasks(undefined, { ventureId, groupId }).then((page) => {
        if (!active) return;
        if (page.items.some((task) => task.groupId !== groupId || task.ventureId !== ventureId)) throw new Error("The task response included an item outside this group.");
        setTasks({ scope: groupId, items: page.items, cursor: page.nextCursor, loading: false, error: "" });
      }).catch((cause: unknown) => { if (active) setTasks({ scope: groupId, items: [], loading: false, error: errorText(cause) }); });
    });
    return () => { active = false; };
  }, [tab, groupId, ventureId, taskRevision]);

  useEffect(() => {
    if (tab !== "attachments" || !groupId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setFiles({ scope: groupId, items: [], loading: true, error: "" });
      listLiveGroupFiles(groupId).then((page) => {
        if (active) setFiles({ scope: groupId, items: page.items, cursor: page.nextCursor, loading: false, error: "" });
      }).catch((cause: unknown) => { if (active) setFiles({ scope: groupId, items: [], loading: false, error: errorText(cause) }); });
    });
    return () => { active = false; };
  }, [tab, groupId, fileRevision]);

  useEffect(() => {
    if (tab !== "saved" || !groupId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSaved({ scope: groupId, items: [], loading: true, error: "" });
      listLiveGroupSavedMessages(groupId).then((page) => { if (active) setSaved({ scope: groupId, items: page.items, cursor: page.nextCursor, loading: false, error: "" }); })
        .catch((cause: unknown) => { if (active) setSaved({ scope: groupId, items: [], loading: false, error: errorText(cause) }); });
    });
    return () => { active = false; };
  }, [tab, groupId, savedRevision]);

  const currentTasks = tasks.scope === groupId ? tasks : { ...emptyPage<Task>(), loading: Boolean(groupId) };
  const currentFiles = files.scope === groupId ? files : { ...emptyPage<FileItem>(), loading: Boolean(groupId) };
  const currentSaved = saved.scope === groupId ? saved : { ...emptyPage<SavedItem>(), loading: Boolean(groupId) };
  const orderedStatuses = [...statuses.filter((status) => currentTasks.items.some((task) => task.status === status)), ...statuses.filter((status) => !currentTasks.items.some((task) => task.status === status))];
  const canUpload = ["admin", "venture_head", "contributor"].includes(role);
  const canMove = (task: Task) => ["admin", "venture_head"].includes(role) || task.assigneeId === userId;
  const canPreview = (file: FileItem) => mediaAccept.split(",").includes(file.contentType);
  const dnd = useKanbanDnd<Task["status"]>((taskId, status) => {
    const task = currentTasks.items.find((item) => item.id === taskId && item.groupId === groupId && item.ventureId === ventureId);
    if (task && canMove(task) && !busyTaskId) void move(task, status);
  });

  function closePreview(returnFocus = true) {
    previewRequestRef.current++;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null); setPreviewError("");
    if (returnFocus) requestAnimationFrame(() => previewReturnRef.current?.getClientRects().length && previewReturnRef.current.focus());
  }

  async function openPreview(file: FileItem) {
    if (!canPreview(file)) return;
    previewReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const requestId = ++previewRequestRef.current;
    setBusyFileId(file.id); setActionError(""); setPreviewError("");
    try {
      const url = await prepareLiveFileDownload(file.id);
      if (requestId !== previewRequestRef.current) { URL.revokeObjectURL(url); return; }
      closePreview(false);
      previewUrlRef.current = url;
      setPreview({ file, url, groupId });
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyFileId(""); }
  }

  async function move(task: Task, status: Task["status"]) {
    if (status === task.status) return;
    if (status === "blocked" && !task.blocker) { setActionError("Open the task and record its blocker before moving it to Blocked."); return; }
    setBusyTaskId(task.id); setActionError("");
    try {
      const changed = await updateLiveTask(task.id, { status, ...(status !== "blocked" && task.blocker ? { blocker: null } : {}) });
      setTasks((page) => page.scope === task.groupId && changed.groupId === task.groupId ? { ...page, items: page.items.map((item) => item.id === changed.id ? changed : item) } : page);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyTaskId(""); }
  }

  async function moreTasks() {
    if (!currentTasks.cursor || !groupId) return;
    setBusyTaskId("more"); setActionError("");
    try {
      const page = await listLiveTasks(currentTasks.cursor, { ventureId, groupId });
      if (page.items.some((task) => task.groupId !== groupId || task.ventureId !== ventureId)) throw new Error("The task response included an item outside this group.");
      setTasks((value) => value.scope === groupId ? { ...value, items: [...value.items, ...page.items], cursor: page.nextCursor } : value);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyTaskId(""); }
  }

  async function moreFiles() {
    if (!currentFiles.cursor || !groupId) return;
    setBusyFileId("more"); setActionError("");
    try {
      const page = await listLiveGroupFiles(groupId, currentFiles.cursor);
      setFiles((value) => value.scope === groupId ? { ...value, items: [...value.items, ...page.items], cursor: page.nextCursor } : value);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyFileId(""); }
  }

  async function moreSaved() {
    if (!currentSaved.cursor || !groupId) return;
    setBusySavedId("more"); setActionError("");
    try {
      const page = await listLiveGroupSavedMessages(groupId, currentSaved.cursor);
      setSaved((value) => value.scope === groupId ? { ...value, items: [...value.items, ...page.items], cursor: page.nextCursor } : value);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusySavedId(""); }
  }

  async function upload(file: File) {
    if (!groupId || !ventureId) return;
    if (!mediaAccept.split(",").includes(file.type)) { setActionError("Choose a supported image, video, or audio file."); return; }
    if (file.size > 25 * 1024 * 1024) { setActionError("Files must be 25 MB or smaller."); return; }
    setUploading(true); setActionError("");
    try { await uploadLiveFile(file, { ventureId, groupId }); setFileRevision((value) => value + 1); }
    catch (cause) { setActionError(errorText(cause)); }
    finally { setUploading(false); }
  }

  async function download(file: FileItem) {
    setBusyFileId(file.id); setActionError("");
    try {
      const objectUrl = await prepareLiveFileDownload(file.id);
      const link = document.createElement("a");
      link.href = objectUrl; link.download = file.name; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyFileId(""); }
  }

  async function unsave(item: SavedItem) {
    setBusySavedId(item.id); setActionError("");
    try {
      const changed = await updateLiveMessageSave(item.id, false);
      setSaved((value) => ({ ...value, items: value.items.filter((message) => message.id !== item.id) }));
      onSavedChange(changed);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusySavedId(""); }
  }

  return <section role="region" aria-label="Group workspace" className="vso-enter-bottom absolute inset-x-0 bottom-0 z-30 flex h-[80dvh] max-h-full min-h-0 flex-col border-t border-[var(--color-neutral-200)] bg-white shadow-[0_-18px_48px_rgba(38,38,55,.12)]">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-neutral-200)] px-4 py-3 sm:px-6"><div className="min-w-0"><h2 className="text-sm font-semibold text-[var(--color-neutral-800)]">Group workspace</h2><p className="truncate text-[11px] text-[var(--color-neutral-400)]">{group ? `${ventureName} · ${group.name}` : "Choose a group"}</p></div><button type="button" onClick={onClose} aria-label="Close group workspace" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-neutral-500)] hover:bg-[var(--color-neutral-100)]"><X size={18} /></button></header>
    <SlidingTabs tabs={tabs.map((item) => ({ key: item, label: item === "saved" ? "Saved messages" : item }))} active={tab} onChange={(key) => { setActionError(""); onTabChange(key as WorkspaceTab); }} label="Group workspace views" className="mx-3 my-2 shrink-0 sm:mx-5" />
    {actionError && <p role="alert" className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 sm:mx-6">{actionError}</p>}
    <div role="tabpanel" aria-label={tab === "saved" ? "Saved messages" : label(tab)} className="thin-scroll min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6">
      {!group ? <p className="py-16 text-center text-sm text-[var(--color-neutral-400)]">Choose a group in the navigator to see its workspace.</p> : tab === "kanban" ? <>
        <div className="mb-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--color-neutral-400)]">{currentTasks.items.length} task{currentTasks.items.length === 1 ? "" : "s"} in {group.name}</p><button type="button" onClick={() => setTaskRevision((value) => value + 1)} className="min-h-9 rounded-lg px-3 text-xs font-semibold text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]">Refresh</button></div>
        {currentTasks.loading ? <p role="status" className="py-12 text-center text-sm text-[var(--color-neutral-400)]">Loading group tasks…</p> : currentTasks.error ? <p role="alert" className="py-12 text-center text-sm text-red-700">{currentTasks.error}</p> : <>
          <p className="mb-2 text-[11px] text-[var(--color-neutral-400)]">Drag cards between columns, or use Move task for keyboard and touch.</p>
          <div aria-label="Group Kanban board" className="thin-scroll grid grid-flow-col auto-cols-[minmax(210px,240px)] gap-3 overflow-x-auto pb-3">
            {orderedStatuses.map((status) => <div key={status} {...dnd.columnProps(status)} className={clsx("min-h-48 rounded-xl border border-transparent bg-[var(--color-neutral-100)] p-3 transition-[border-color,box-shadow] duration-150", dnd.overStatus === status && "border-[var(--color-primary-500)] ring-2 ring-[var(--color-primary-200)]")}>
              <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold capitalize text-[var(--color-neutral-700)]">{label(status)}</h3><span className="text-[10px] text-[var(--color-neutral-400)]">{currentTasks.items.filter((task) => task.status === status).length}</span></div>
              <div className="space-y-2">{currentTasks.items.filter((task) => task.status === status).map((task) => <article key={task.id} {...(canMove(task) && !busyTaskId ? dnd.cardProps(task.id) : {})} className={clsx("rounded-lg bg-white p-3", canMove(task) && !busyTaskId && "cursor-grab active:cursor-grabbing", dnd.draggingId === task.id && "opacity-45")}>
                <p className="break-words text-xs font-semibold text-[var(--color-neutral-800)]">{task.title}</p><p className="mt-1 text-[10px] capitalize text-[var(--color-neutral-400)]">{task.priority} priority · Due {new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(task.dueAt))}</p>
                {canMove(task) && <label className="mt-3 block text-[10px] font-semibold text-[var(--color-neutral-500)]">Move task<Select aria-label={`Move ${task.title}`} disabled={Boolean(busyTaskId)} value={task.status} onChange={(event) => move(task, event.target.value as Task["status"])} className="mt-1 block min-h-9 w-full rounded-lg bg-[var(--color-neutral-100)] px-2 text-xs capitalize text-[var(--color-neutral-700)]">{statuses.map((item) => <option key={item} value={item} disabled={item === "blocked" && !task.blocker && task.status !== "blocked"}>{label(item)}</option>)}</Select></label>}
              </article>)}</div>
            </div>)}
          </div>
          {currentTasks.items.length === 0 && <p className="mt-2 text-center text-xs text-[var(--color-neutral-400)]">No tasks in this group yet.</p>}
          {currentTasks.cursor && <button type="button" disabled={Boolean(busyTaskId)} onClick={moreTasks} className="mt-3 min-h-10 rounded-lg bg-[var(--color-primary-100)] px-4 text-xs font-semibold text-[var(--color-primary-700)]">Load more tasks</button>}
        </>}
      </> : tab === "attachments" ? <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold text-[var(--color-neutral-700)]">Group attachments</p><p className="mt-1 text-[11px] text-[var(--color-neutral-400)]">Ready files shared in {group.name}</p></div><div className="flex items-center gap-2"><button type="button" onClick={() => setFileRevision((value) => value + 1)} className="min-h-9 rounded-lg px-3 text-xs font-semibold text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]">Refresh</button>{canUpload && <label className="flex min-h-9 cursor-pointer items-center gap-1 rounded-lg bg-[var(--color-primary-600)] px-3 text-xs font-semibold text-white"><Plus size={14} />{uploading ? "Uploading…" : "Add media"}<input type="file" accept={mediaAccept} disabled={uploading} className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} /></label>}</div></div>
        {currentFiles.loading ? <p role="status" className="py-12 text-center text-sm text-[var(--color-neutral-400)]">Loading group files…</p> : currentFiles.error ? <p role="alert" className="py-12 text-center text-sm text-red-700">{currentFiles.error}</p> : currentFiles.items.length ? <><div className="space-y-2">{currentFiles.items.map((file) => <article key={file.id} className="flex min-w-0 items-center gap-3 rounded-xl bg-[var(--color-neutral-50)] p-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white text-[var(--color-primary-600)]"><Paperclip size={18} /></span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[var(--color-neutral-800)]">{file.name}</p><p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{file.contentType} · {(file.size / 1024).toFixed(1)} KB</p></div>{canPreview(file) && <button type="button" disabled={Boolean(busyFileId)} onClick={() => openPreview(file)} aria-label={`Preview ${file.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]"><Eye size={17} /></button>}<button type="button" disabled={Boolean(busyFileId)} onClick={() => download(file)} aria-label={`Download ${file.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]"><Download size={17} /></button></article>)}</div>{currentFiles.cursor && <button type="button" disabled={Boolean(busyFileId)} onClick={moreFiles} className="mt-3 min-h-10 rounded-lg bg-[var(--color-primary-100)] px-4 text-xs font-semibold text-[var(--color-primary-700)]">Load more files</button>}</> : <p className="py-12 text-center text-sm text-[var(--color-neutral-400)]">No files in this group yet.</p>}
        {canUpload && <p className="mt-4 text-[10px] text-[var(--color-neutral-400)]">Supported images, video, and audio · Up to 25 MB each.</p>}
      </> : <>
        <div className="mb-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--color-neutral-400)]">Saved messages in {group.name}</p><button type="button" onClick={() => setSavedRevision((value) => value + 1)} className="min-h-9 rounded-lg px-3 text-xs font-semibold text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]">Refresh</button></div>
        {currentSaved.loading ? <p role="status" className="py-12 text-center text-sm text-[var(--color-neutral-400)]">Loading saved messages…</p> : currentSaved.error ? <p role="alert" className="py-12 text-center text-sm text-red-700">{currentSaved.error}</p> : currentSaved.items.length ? <><div className="space-y-2">{currentSaved.items.map((item) => <article key={item.id} className="rounded-xl bg-[var(--color-neutral-50)] p-4"><div className="flex items-center justify-between gap-3"><p className="text-[10px] font-semibold text-[var(--color-primary-700)]"># {group.channels.find((channel) => channel.id === item.channelId)?.name ?? "Channel"}</p><time className="text-[10px] text-[var(--color-neutral-400)]">{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(item.createdAt))}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-neutral-700)]">{item.body}</p><button type="button" disabled={Boolean(busySavedId)} onClick={() => unsave(item)} className="mt-3 min-h-8 text-[11px] font-semibold text-[var(--color-primary-700)]">Remove from saved</button></article>)}</div>{currentSaved.cursor && <button type="button" disabled={Boolean(busySavedId)} onClick={moreSaved} className="mt-3 min-h-10 rounded-lg bg-[var(--color-primary-100)] px-4 text-xs font-semibold text-[var(--color-primary-700)]">Load more saved messages</button>}</> : <p className="py-12 text-center text-sm text-[var(--color-neutral-400)]">No saved messages in this group yet.</p>}
      </>}
    </div>
    {preview && preview.groupId === groupId && <div role="dialog" aria-label={`Preview ${preview.file.name}`} onKeyDownCapture={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePreview(); } }} className="absolute inset-0 z-40 flex min-h-0 flex-col bg-white">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-neutral-200)] px-4 py-3 sm:px-6"><div className="min-w-0"><p className="truncate text-xs font-semibold text-[var(--color-neutral-800)]">{preview.file.name}</p><p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{group?.name} · {preview.file.contentType}</p></div><div className="flex shrink-0 items-center gap-1"><button type="button" disabled={Boolean(busyFileId)} onClick={() => download(preview.file)} aria-label={`Download ${preview.file.name}`} className="grid h-9 w-9 place-items-center rounded-lg text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]"><Download size={17} /></button><button ref={previewCloseRef} type="button" onClick={() => closePreview()} aria-label="Close attachment preview" className="grid h-9 w-9 place-items-center rounded-lg text-[var(--color-neutral-500)] hover:bg-[var(--color-neutral-100)]"><X size={18} /></button></div></div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--color-neutral-100)] p-4">{previewError ? <p role="alert" className="max-w-sm text-center text-xs leading-5 text-red-700">{previewError} Use Download to keep a copy.</p> : preview.file.contentType.startsWith("image/") ? <img src={preview.url} alt={preview.file.name} onError={() => setPreviewError("This image could not be previewed.")} className="max-h-full max-w-full object-contain" /> : preview.file.contentType.startsWith("video/") ? <video src={preview.url} controls playsInline onError={() => setPreviewError("This video could not be played.")} className="max-h-full max-w-full" /> : <audio src={preview.url} controls onError={() => setPreviewError("This audio could not be played.")} className="w-full max-w-lg" />}</div>
    </div>}
  </section>;
}
