"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Select } from "@/components/ui/select";
import { createLiveDocument, uploadLiveFile } from "@/lib/studio-api";
import { Field, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";

type UploadSession = { membership: { role: string; ventureIds: string[] }; hierarchy: { ventures: Array<{ id: string; name: string }> } };
type UploadItem = { id: string; file: File; status: "queued" | "reading" | "uploading" | "finalizing" | "done" | "failed"; progress: number; error?: string };
const supported = ".pdf,.md,.txt,.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.mp3,.m4a,.ogg,.wav";

export function KnowledgeUploadDialog({ mode, session, activeVentureId, onClose, onComplete, onMarkdown, onFile, demo = false }: {
  mode: "markdown" | "file";
  session: UploadSession;
  activeVentureId: string;
  onClose: () => void;
  onComplete: () => void;
  onMarkdown?: (file: File, markdown: string, ventureId: string) => Promise<void>;
  onFile?: (file: File, ventureId: string, progress: (percent: number, phase: "uploading" | "finalizing") => void) => Promise<void>;
  demo?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [ventureId, setVentureId] = useState(activeVentureId);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const ventures = session.membership.role === "admin" ? session.hierarchy.ventures : session.hierarchy.ventures.filter((venture) => session.membership.ventureIds.includes(venture.id));
  const activeVenture = ventures.find((venture) => venture.id === activeVentureId);
  const update = (id: string, change: Partial<UploadItem>) => setItems((current) => current.map((item) => item.id === id ? { ...item, ...change } : item));

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    return () => node.close();
  }, []);

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    setItems((current) => [...current, ...Array.from(files).map((file) => ({ id: crypto.randomUUID(), file, status: "queued" as const, progress: 0 }))]);
  }

  async function submit() {
    if (uploading) return;
    if (!ventureId && (mode === "file" || session.membership.role !== "admin")) { setError("Choose a venture for these files."); return; }
    if (!items.some((item) => item.status === "queued" || item.status === "failed")) return;
    setError(""); setUploading(true);
    let completed = false;
    for (const item of items.filter((item) => item.status === "queued" || item.status === "failed")) {
      try {
        if (mode === "markdown") {
          if (!/\.(md|markdown|txt)$/i.test(item.file.name) || !item.file.size || item.file.size > 2_000_000) throw new Error("Choose a nonempty Markdown or text file up to 2 MB.");
          update(item.id, { status: "reading", progress: 0, error: undefined });
          const markdown = await item.file.text();
          if (!markdown.trim() || markdown.length > 2_000_000) throw new Error("The file must contain Markdown text under 2 million characters.");
          update(item.id, { status: "finalizing", progress: 0 });
          if (onMarkdown) await onMarkdown(item.file, markdown, ventureId);
          else await createLiveDocument({ ...(ventureId ? { ventureId } : {}), title: item.file.name.replace(/\.(md|markdown|txt)$/i, ""), markdown, evidenceClass: "founder_reported", sensitivity: "team", changeSummary: `Imported ${item.file.name}` });
        } else {
          if (!item.file.size || item.file.size > 25 * 1024 * 1024) throw new Error("Choose a nonempty file up to 25 MB.");
          update(item.id, { status: "uploading", progress: 0, error: undefined });
          const progress = (percent: number, phase: "uploading" | "finalizing") => update(item.id, { progress: percent, status: phase });
          if (onFile) await onFile(item.file, ventureId, progress);
          else await uploadLiveFile(item.file, { ventureId }, progress);
        }
        completed = true;
        update(item.id, { status: "done", progress: 100 });
      } catch (cause) {
        update(item.id, { status: "failed", error: cause instanceof Error ? cause.message : "Upload failed." });
      }
    }
    setUploading(false);
    if (completed) onComplete();
  }

  const title = mode === "markdown" ? "Upload Markdown" : "Upload files";
  return createPortal(<dialog ref={dialog} aria-label={title} onCancel={(event) => { event.preventDefault(); if (!uploading) onClose(); }} onClick={(event) => { if (!uploading && event.target === dialog.current) onClose(); }} className="knowledge-upload-modal fixed inset-0 m-auto w-[min(640px,calc(100vw-32px))] max-h-[min(780px,calc(100dvh-32px))] overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-0 text-neutral-900 shadow-2xl backdrop:bg-black/50">
    <div className="border-b border-neutral-100 px-5 py-4 sm:px-6"><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-bold">{title}</h2><p className="mt-1 text-sm leading-5 text-neutral-500">{demo ? "Demo only: selected files stay in this browser tab and are not sent to the server." : mode === "markdown" ? "Each file becomes a draft Knowledge record for review." : "Files stay private to their venture and are not added to evidence search."}</p></div><button type="button" disabled={uploading} onClick={onClose} className="min-h-9 rounded-lg px-3 text-sm font-semibold text-neutral-600 hover:bg-neutral-50 disabled:opacity-50">Close</button></div></div>
    <div className="space-y-5 p-5 sm:p-6">
      {activeVentureId ? <div aria-label="Upload destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Destination · fixed to current venture</span><span className="mt-1 block text-sm font-bold">{activeVenture?.name ?? "Current venture"}</span></div> : <Field label="Destination venture"><Select className={inputClass} value={ventureId} disabled={uploading} onChange={(event) => setVentureId(event.target.value)}>{mode === "markdown" && session.membership.role === "admin" ? <option value="">Workspace</option> : <option value="">Choose venture</option>}{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}
      <label className="block cursor-pointer rounded-xl border border-dashed border-primary-300 bg-primary-50 px-4 py-6 text-center focus-within:ring-2 focus-within:ring-primary-400"><span className="block text-sm font-semibold text-primary-800">Choose {mode === "markdown" ? "Markdown files" : "files"}</span><span className="mt-1 block text-xs text-neutral-500">{mode === "markdown" ? ".md, .markdown, .txt · 2 MB each" : "PDF, text, images, video, or audio · 25 MB each"}</span><span aria-hidden="true" className="mx-auto mt-3 inline-flex min-h-9 items-center justify-center rounded-lg border border-neutral-200 bg-white px-4 text-xs font-semibold text-neutral-800">Browse files</span><input type="file" multiple accept={mode === "markdown" ? ".md,.markdown,.txt,text/markdown,text/plain" : supported} disabled={uploading} onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} className="sr-only" /></label>
      {items.length > 0 && <div aria-label="Selected files" className="max-h-64 space-y-2 overflow-y-auto">{items.map((item) => <div key={item.id} className="rounded-xl border border-neutral-200 px-3 py-2"><div className="flex items-start justify-between gap-2"><span className="min-w-0 break-all text-sm font-semibold">{item.file.name}</span><span className="shrink-0 text-xs capitalize text-neutral-500">{item.status === "done" ? "Ready" : item.status}</span></div>{item.status === "uploading" || (item.status === "finalizing" && mode === "file") ? <div className="mt-2 flex items-center gap-2"><progress value={item.progress} max="100" aria-label={`${item.file.name} upload progress`} className="h-2 flex-1 accent-primary-700" /><span className="w-9 text-right text-xs tabular-nums text-neutral-500">{item.progress}%</span></div> : item.status === "reading" || item.status === "finalizing" ? <progress aria-label={`${item.file.name} processing`} className="mt-2 h-2 w-full accent-primary-700" /> : null}{item.error && <p role="alert" className="mt-1 text-xs text-danger-text">{item.error}</p>}</div>)}</div>}
      {error && <p role="alert" className="text-sm font-semibold text-danger-text">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={uploading} onClick={onClose} className={secondaryClass}>Done</button><button type="button" disabled={uploading || !items.some((item) => item.status === "queued" || item.status === "failed")} onClick={() => void submit()} className={primaryClass}>{uploading ? "Uploading…" : items.some((item) => item.status === "failed") ? "Retry failed" : `Upload ${items.filter((item) => item.status === "queued").length} ${mode === "markdown" ? "document" : "file"}${items.filter((item) => item.status === "queued").length === 1 ? "" : "s"}`}</button></div>
    </div>
  </dialog>, document.body);
}
