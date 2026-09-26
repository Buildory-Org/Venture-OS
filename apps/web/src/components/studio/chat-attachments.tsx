"use client";
/* eslint-disable @next/next/no-img-element -- Authorized blob previews cannot use Next image optimization. */

import { useEffect, useRef, useState } from "react";
import { Download, FileText, Paperclip, X } from "@/components/ui/icons";
import type { Message } from "@venture-studio/contracts";
import { prepareLiveFileDownload, uploadLiveFile } from "@/lib/studio-api";

export type ChatAttachment = { id: string; name: string; contentType: string; size: number };
export type ChatUploadScope = { ventureId: string; groupId: string } | { recipientId: string };

const allowedTypes = new Set([
  "application/pdf", "text/markdown", "text/plain", "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav",
]);
const typeByExtension: Record<string, string> = {
  pdf: "application/pdf", md: "text/markdown", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The file could not be uploaded.";
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function messageAttachments(message: Message): ChatAttachment[] {
  return "attachments" in message && Array.isArray(message.attachments) ? message.attachments as ChatAttachment[] : [];
}

export function useChatAttachments(scopeKey: string, scope: ChatUploadScope | null) {
  const [state, setState] = useState<{ key: string; items: ChatAttachment[]; uploading: boolean; error: string }>({ key: scopeKey, items: [], uploading: false, error: "" });
  const activeKey = useRef(scopeKey);
  const current = state.key === scopeKey ? state : { key: scopeKey, items: [], uploading: false, error: "" };

  useEffect(() => { activeKey.current = scopeKey; setState({ key: scopeKey, items: [], uploading: false, error: "" }); }, [scopeKey]);

  async function addFiles(files: FileList | null) {
    if (!scope || !files?.length || current.uploading) return;
    const key = scopeKey;
    const chosen = Array.from(files);
    if (chosen.length + current.items.length > 10) {
      setState((value) => value.key === key ? { ...value, error: "A message can have up to 10 files." } : value);
      return;
    }
    setState((value) => value.key === key ? { ...value, uploading: true, error: "" } : value);
    try {
      for (const file of chosen) {
        const type = file.type || typeByExtension[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
        if (!allowedTypes.has(type) || file.size < 1 || file.size > 25 * 1024 * 1024) throw new Error("Choose a supported file up to 25 MB.");
        const uploaded = await uploadLiveFile(file, scope);
        if (activeKey.current !== key) return;
        setState((value) => value.key === key ? { ...value, items: [...value.items, { id: uploaded.id, name: uploaded.name, contentType: uploaded.contentType, size: uploaded.size }] } : value);
      }
    } catch (cause) {
      if (activeKey.current === key) setState((value) => value.key === key ? { ...value, error: errorText(cause) } : value);
    } finally {
      setState((value) => value.key === key ? { ...value, uploading: false } : value);
    }
  }

  return {
    items: current.items,
    uploading: current.uploading,
    error: current.error,
    addFiles,
    remove: (id: string) => setState((value) => value.key === scopeKey ? { ...value, items: value.items.filter((item) => item.id !== id) } : value),
    clear: () => setState((value) => value.key === scopeKey ? { ...value, items: [], error: "" } : value),
  };
}

type AttachmentState = ReturnType<typeof useChatAttachments>;

export function AttachmentTray({ attachments }: { attachments: AttachmentState }) {
  return <>
    {(attachments.items.length > 0 || attachments.uploading) && <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Files ready to send">
      {attachments.items.map((file) => <span key={file.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--color-neutral-100)] px-2 py-1 text-[11px] text-[var(--color-neutral-700)]"><FileText size={13} className="shrink-0" /><span className="max-w-44 truncate">{file.name}</span><span className="text-[var(--color-neutral-400)]">{fileSize(file.size)}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => attachments.remove(file.id)} className="grid h-6 w-6 place-items-center rounded-md hover:bg-[var(--color-neutral-200)]"><X size={13} /></button></span>)}
      {attachments.uploading && <span role="status" className="text-[11px] text-[var(--color-neutral-500)]">Uploading…</span>}
    </div>}
    {attachments.error && <p role="alert" className="mb-2 text-[11px] text-red-700">{attachments.error}</p>}
  </>;
}

export function AttachmentMenu({ attachments, disabled }: { attachments: AttachmentState; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const images = useRef<HTMLInputElement>(null);
  const documents = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLInputElement>(null);
  const onFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    void attachments.addFiles(event.target.files);
    event.target.value = "";
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [open]);

  return <div ref={root} className="relative shrink-0" onKeyDown={(event) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
  }}>
    <input ref={images} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm" onChange={onFiles} />
    <input ref={documents} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" accept=".pdf,.md,.txt" onChange={onFiles} />
    <input ref={audio} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" accept=".mp3,.m4a,.ogg,.wav,.webm" onChange={onFiles} />
    <button ref={trigger} type="button" aria-label="Attach files" title="Attach files" aria-haspopup="menu" aria-expanded={open} disabled={disabled || attachments.uploading || attachments.items.length >= 10} onClick={() => setOpen((value) => !value)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-primary-600)] hover:bg-[var(--color-primary-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)] disabled:opacity-40"><Paperclip size={16} /></button>
    {open && <div role="menu" aria-label="Choose attachment type" className="absolute bottom-full left-0 z-30 mb-2 w-48 rounded-xl border border-[var(--color-neutral-200)] bg-white p-1.5 shadow-e3">
      <button type="button" role="menuitem" onClick={() => { setOpen(false); images.current?.click(); }} className="flex min-h-9 w-full items-center rounded-lg px-3 text-left text-xs text-[var(--color-neutral-700)] hover:bg-[var(--color-primary-50)]">Images & videos</button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); documents.current?.click(); }} className="flex min-h-9 w-full items-center rounded-lg px-3 text-left text-xs text-[var(--color-neutral-700)] hover:bg-[var(--color-primary-50)]">Documents</button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); audio.current?.click(); }} className="flex min-h-9 w-full items-center rounded-lg px-3 text-left text-xs text-[var(--color-neutral-700)] hover:bg-[var(--color-primary-50)]">Audio</button>
    </div>}
  </div>;
}

export function AttachmentPicker({ attachments, disabled }: { attachments: AttachmentState; disabled?: boolean }) {
  return <><AttachmentTray attachments={attachments} /><AttachmentMenu attachments={attachments} disabled={disabled} /></>;
}

function MessageAttachmentCard({ file }: { file: ChatAttachment }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const previewable = file.contentType.startsWith("image/") || file.contentType.startsWith("video/") || file.contentType.startsWith("audio/") || file.contentType === "application/pdf";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function preview() {
    if (url) { setUrl(""); return; }
    setLoading(true); setError("");
    try {
      const previewUrl = await prepareLiveFileDownload(file.id, file.contentType);
      if (mounted.current) setUrl(previewUrl);
      else URL.revokeObjectURL(previewUrl);
    }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }

  async function download() {
    setLoading(true); setError("");
    try {
      const downloadUrl = await prepareLiveFileDownload(file.id);
      const link = document.createElement("a");
      link.href = downloadUrl; link.download = file.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }

  return <div className="min-w-0 max-w-full rounded-xl bg-[var(--color-neutral-100)] p-2 text-left text-[var(--color-neutral-700)]">
    <div className="flex min-w-0 items-center gap-2"><FileText size={15} className="shrink-0 text-[var(--color-primary-700)]" /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold" title={file.name}>{file.name}</p><p className="text-[10px] text-[var(--color-neutral-400)]">{fileSize(file.size)}</p></div>{previewable && <button type="button" disabled={loading} onClick={preview} className="min-h-8 rounded-md px-2 text-[10px] font-semibold text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]">{url ? "Close" : "Preview"}</button>}<button type="button" disabled={loading} onClick={download} aria-label={`Download ${file.name}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-md hover:bg-[var(--color-neutral-200)]"><Download size={14} /></button></div>
    {loading && <p role="status" className="mt-2 text-[10px] text-[var(--color-neutral-500)]">Loading file…</p>}
    {error && <p role="alert" className="mt-2 text-[10px] text-red-700">{error}</p>}
    {url && <div className="mt-2 overflow-hidden rounded-lg bg-white">{file.contentType.startsWith("image/") ? <img src={url} alt={file.name} className="max-h-72 max-w-full object-contain" /> : file.contentType.startsWith("video/") ? <video src={url} controls className="max-h-72 max-w-full" /> : file.contentType.startsWith("audio/") ? <audio src={url} controls className="w-full" /> : <iframe src={url} title={`Preview ${file.name}`} className="h-72 w-full" />}</div>}
  </div>;
}

export function MessageAttachmentList({ files }: { files: ChatAttachment[] }) {
  if (!files.length) return null;
  return <div className="mt-1 flex max-w-80 flex-col gap-1.5">{files.map((file) => <MessageAttachmentCard key={file.id} file={file} />)}</div>;
}
