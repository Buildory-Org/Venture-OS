"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowLeft, Edit, Eye } from "@/components/ui/icons";
import { MarkdownBody } from "@/components/studio/knowledge-markdown";
import { getLiveDocument, loadLiveSession, updateLiveDocument } from "@/lib/studio-api";

type DocumentDetail = Awaited<ReturnType<typeof getLiveDocument>>;
type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type EditorMode = "write" | "split" | "preview";

export function LiveKnowledgeEditorScreen({ documentId }: { documentId: string }) {
  const router = useRouter();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const discardDialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [sourceUri, setSourceUri] = useState("");
  const [summary, setSummary] = useState("");
  const [mode, setMode] = useState<EditorMode>("split");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([getLiveDocument(documentId), loadLiveSession()]).then(([nextDetail, nextSession]) => {
      if (!active) return;
      setDetail(nextDetail);
      setSession(nextSession);
      setMarkdown(nextDetail.version.markdown);
      setSourceUri(nextDetail.version.sourceUri ?? "");
      setLoading(false);
    }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : "Could not open the editor."); setLoading(false); }
    });
    return () => { active = false; };
  }, [documentId]);

  const canEdit = !!detail && !!session && (session.membership.role === "admin" || (!!detail.document.ventureId && ["venture_head", "contributor"].includes(session.membership.role) && session.membership.ventureIds.includes(detail.document.ventureId)));
  const contentChanged = !!detail && (markdown !== detail.version.markdown || sourceUri !== (detail.version.sourceUri ?? ""));
  const dirty = contentChanged || !!summary.trim();
  const venture = session?.hierarchy.ventures.find((item) => item.id === detail?.document.ventureId)?.name ?? "Workspace";
  const wordCount = markdown.trim() ? markdown.trim().split(/\s+/).length : 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const dialog = discardDialog.current;
    if (!dialog || !confirmDiscard) return;
    dialog.showModal();
    return () => dialog.close();
  }, [confirmDiscard]);

  function returnToDocument() {
    if (dirty) { setConfirmDiscard(true); return; }
    router.push(`/knowledge/live?doc=${encodeURIComponent(documentId)}`);
  }

  function format(before: string, after = "", placeholder = "text") {
    const input = textarea.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = markdown.slice(start, end) || placeholder;
    const blockPrefix = ["## ", "- ", "> "].includes(before) && start > 0 && markdown[start - 1] !== "\n" ? "\n" : "";
    const blockSuffix = ["## ", "- ", "> "].includes(before) && markdown[end] !== "\n" ? "\n" : "";
    setMarkdown(`${markdown.slice(0, start)}${blockPrefix}${before}${selected}${after}${blockSuffix}${markdown.slice(end)}`);
    setMode("write");
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + blockPrefix.length + before.length, start + blockPrefix.length + before.length + selected.length);
    });
  }

  async function save() {
    if (!detail || !canEdit || saving) return;
    if (!contentChanged) { setError("Make a change to the document before saving a new version."); return; }
    if (!markdown.trim()) { setError("The document cannot be empty."); return; }
    if (!summary.trim()) { setError("Add a short change summary before saving."); return; }
    if (sourceUri && !/^https?:\/\//i.test(sourceUri)) { setError("The source URL must start with http:// or https://."); return; }
    setSaving(true); setError("");
    try {
      const latest = await getLiveDocument(documentId);
      if (latest.version.id !== detail.version.id) throw new Error("A newer version was saved while you were editing. Copy your changes before reloading this editor.");
      await updateLiveDocument(documentId, { markdown, changeSummary: summary.trim(), ...(sourceUri ? { sourceUri } : {}) });
      router.push(`/knowledge/live?doc=${encodeURIComponent(documentId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this document.");
      setSaving(false);
    }
  }

  if (loading) return <div role="status" className="p-8 text-sm text-neutral-500">Opening editor…</div>;
  if (!detail || !session || !canEdit) return <div className="mx-auto max-w-xl p-8"><h1 className="text-xl font-bold text-neutral-900">Editor unavailable</h1><p role="alert" className="mt-3 text-sm text-danger-text">{error || "You do not have permission to edit this record."}</p><button type="button" onClick={() => router.push("/knowledge/live")} className="mt-5 text-sm font-semibold text-primary-700 underline">Back to Knowledge</button></div>;

  return <section aria-label={`Editing ${detail.document.title}`} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }} className="flex h-[calc(100dvh-56px)] min-h-0 flex-col overflow-hidden bg-neutral-50">
    <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3 sm:px-6">
      <button type="button" onClick={returnToDocument} aria-label="Back to document" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"><ArrowLeft size={18} /></button>
      <div className="min-w-0 flex-1"><h1 className="truncate text-base font-bold text-neutral-900" title={detail.document.title}>{detail.document.title}</h1><p className="truncate text-xs text-neutral-500">{venture} · Editing version {detail.version.version} · {dirty ? "Unsaved changes" : "No changes"}</p></div>
      <button type="button" onClick={() => void save()} disabled={saving || !contentChanged} aria-keyshortcuts="Control+S Meta+S" className="min-h-10 rounded-xl bg-primary-700 px-4 text-sm font-bold text-white hover:bg-primary-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2">{saving ? "Saving…" : "Save new draft"}</button>
    </header>

    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4 pt-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Editor layout" className="flex gap-1 rounded-xl border border-neutral-200 bg-white p-1">
          {(["write", "split", "preview"] as const).map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} className={`min-h-9 rounded-lg px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${mode === item ? "bg-primary-700 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}>{item === "write" ? "Write" : item === "split" ? "Split" : "Preview"}</button>)}
        </div>
        <span className="text-xs tabular-nums text-neutral-500">{wordCount.toLocaleString()} words · {markdown.length.toLocaleString()} characters</span>
      </div>

      {mode !== "preview" && <div role="toolbar" aria-label="Markdown formatting" className="mb-3 flex flex-wrap gap-1 rounded-xl border border-neutral-200 bg-white p-1.5">
        {[{ label: "Heading", before: "## ", after: "", placeholder: "Heading" }, { label: "Bold", before: "**", after: "**", placeholder: "bold text" }, { label: "Italic", before: "*", after: "*", placeholder: "italic text" }, { label: "Link", before: "[", after: "](https://example.com)", placeholder: "link text" }, { label: "Bullets", before: "- ", after: "", placeholder: "List item" }, { label: "Quote", before: "> ", after: "", placeholder: "Quoted text" }, { label: "Code", before: "`", after: "`", placeholder: "code" }].map((item) => <button key={item.label} type="button" onClick={() => format(item.before, item.after, item.placeholder)} className="min-h-8 rounded-lg px-2.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">{item.label}</button>)}
      </div>}

      <div className={`grid min-h-0 flex-1 gap-3 ${mode === "split" ? "md:grid-cols-2" : "grid-cols-1"}`}>
        {mode !== "preview" && <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white"><label htmlFor="knowledge-editor-content" className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2 text-xs font-bold text-neutral-600"><Edit size={14} />Markdown source</label><textarea ref={textarea} id="knowledge-editor-content" value={markdown} onChange={(event) => setMarkdown(event.target.value)} maxLength={2_000_000} spellCheck className="min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-7 text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500" /></div>}
        {mode !== "write" && <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white"><div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2 text-xs font-bold text-neutral-600"><Eye size={14} />Live preview</div><div className="min-h-0 flex-1 overflow-auto px-5 py-5 sm:px-7"><MarkdownBody markdown={markdown} view="rendered" /></div></div>}
      </div>

      <div className="mt-3 grid gap-3 rounded-xl border border-neutral-200 bg-white p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="min-w-0 text-xs font-semibold text-neutral-600">Change summary <span className="font-normal text-neutral-500">(required to save)</span><input value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={500} placeholder="What changed in this version?" className="mt-1 block min-h-10 w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-primary-500" /></label>
        <label className="min-w-0 text-xs font-semibold text-neutral-600">Source URL <span className="font-normal text-neutral-500">(optional)</span><input type="url" value={sourceUri} onChange={(event) => setSourceUri(event.target.value)} placeholder="https://…" className="mt-1 block min-h-10 w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-primary-500" /></label>
      </div>
      <p className="mt-2 text-xs text-neutral-500">Saving creates a new draft version. It does not approve or publish the record to evidence search.</p>
      {error && <p role="alert" className="mt-2 rounded-lg bg-danger-surface px-3 py-2 text-xs font-semibold text-danger-text">{error}</p>}
    </div>
    {createPortal(<dialog ref={discardDialog} aria-labelledby="knowledge-discard-title" onCancel={(event) => { event.preventDefault(); setConfirmDiscard(false); }} className="w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-neutral-200 bg-white p-0 text-neutral-900 shadow-2xl backdrop:bg-black/60">
      <div className="p-5">
        <h2 id="knowledge-discard-title" className="text-lg font-bold">Discard unsaved edits?</h2>
        <p className="mt-2 text-sm text-neutral-600">Your changes to this record will be lost.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus onClick={() => setConfirmDiscard(false)} className="min-h-10 rounded-xl border border-neutral-200 px-4 text-sm font-semibold hover:bg-neutral-100">Keep editing</button>
          <button type="button" onClick={() => { setConfirmDiscard(false); router.push(`/knowledge/live?doc=${encodeURIComponent(documentId)}`); }} className="min-h-10 rounded-xl bg-danger-surface px-4 text-sm font-semibold text-danger-text hover:opacity-80">Discard edits</button>
        </div>
      </div>
    </dialog>, document.body)}
  </section>;
}
