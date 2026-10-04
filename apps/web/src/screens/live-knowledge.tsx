"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, BookOpenText, Copy, Download, Edit, Plus, RefreshCw, Search } from "@/components/ui/icons";
import { createLiveDocument, getLiveDocument, listLiveDocuments, listLiveFiles, loadLiveSession, prepareLiveFileDownload, searchLiveKnowledge, updateLiveDocumentMetadata } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { KnowledgeDocumentTile } from "@/components/studio/knowledge-document-tile";
import { KnowledgeFileIcon } from "@/components/studio/knowledge-file-icon";
import { MarkdownBody, MarkdownViewToggle, type MarkdownView } from "@/components/studio/knowledge-markdown";
import { KnowledgeUploadDialog } from "@/components/studio/knowledge-upload-dialog";
import { useStudio } from "@/lib/studio-store";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Results = Awaited<ReturnType<typeof searchLiveKnowledge>>;
type DocumentDetail = Awaited<ReturnType<typeof getLiveDocument>>;
type DocumentMetadata = Awaited<ReturnType<typeof listLiveDocuments>>["items"][number];
type FileMetadata = Awaited<ReturnType<typeof listLiveFiles>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

function ReaderShell({ name, subtitle, onBack, action, children }: { name: string; subtitle: string; onBack: () => void; action: React.ReactNode; children: React.ReactNode }) {
  return <section aria-label={`Viewing ${name}`} className="relative flex h-[calc(100dvh-56px)] min-h-0 w-full flex-col overflow-hidden bg-neutral-50">
    <header className="absolute inset-x-0 top-0 z-10 flex min-h-14 items-center gap-3 border-b border-white/10 bg-[#183027]/85 px-4 text-white backdrop-blur-xl sm:px-6">
      <button type="button" onClick={onBack} aria-label="Back to library" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"><ArrowLeft size={17} /></button>
      <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-semibold" title={name}>{name}</h1><p className="truncate text-[10px] text-white/60">{subtitle}</p></div>
      {action}
    </header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto pt-14">{children}</div>
  </section>;
}

function DocumentReader({ detail, venture, onBack, onDetails, onEdit }: { detail: DocumentDetail; venture: string; onBack: () => void; onDetails: () => void; onEdit?: () => void }) {
  const [markdownView, setMarkdownView] = useState<MarkdownView>("rendered");
  return <ReaderShell name={detail.document.title} subtitle={`${venture} · Version ${detail.version.version} · ${detail.document.status}`} onBack={onBack} action={<div className="flex shrink-0 items-center gap-2"><MarkdownViewToggle value={markdownView} onChange={setMarkdownView} />{onEdit && <button type="button" onClick={onEdit} aria-label={`Edit ${detail.document.title}`} title="Open editor" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"><Edit size={17} /></button>}<button type="button" onClick={onDetails} className="min-h-9 shrink-0 rounded-xl px-3 text-xs font-semibold text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">Details & actions</button></div>}><div className="h-full w-full overflow-auto bg-white px-5 pb-12 pt-6 sm:px-10"><article className="mx-auto w-full max-w-5xl"><MarkdownBody markdown={detail.version.markdown} view={markdownView} /></article></div></ReaderShell>;
}

function FileReader({ file, url, venture, onBack }: { file: FileMetadata; url: string; venture: string; onBack: () => void }) {
  const isMarkdown = file.contentType.startsWith("text/markdown") || /\.(md|markdown)$/i.test(file.name);
  const isText = file.contentType.startsWith("text/") || /\.(md|markdown|txt)$/i.test(file.name);
  const [textPreview, setTextPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(isText);
  const [markdownView, setMarkdownView] = useState<MarkdownView>("rendered");
  useEffect(() => {
    if (!isText) return;
    let active = true;
    fetch(url).then((response) => { if (!response.ok) throw new Error("Preview unavailable"); return response.text(); }).then((value) => { if (active) setTextPreview(value); }).catch(() => { if (active) setPreviewError("This text file could not be previewed. Download it instead."); }).finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [isText, url]);
  const preview = isText ? <div className="h-full w-full overflow-auto bg-white px-5 pb-10 pt-6 sm:px-10"><article className="mx-auto w-full max-w-5xl">{previewLoading ? <p role="status" className="text-sm text-neutral-500">Loading preview…</p> : previewError ? <p role="alert" className="text-sm text-danger-text">{previewError}</p> : isMarkdown ? <MarkdownBody markdown={textPreview} view={markdownView} /> : <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-7 text-neutral-900">{textPreview}</pre>}</article></div>
    : file.contentType === "application/pdf" ? <iframe src={url} title={`Preview of ${file.name}`} className="h-full w-full border-0 bg-white" />
    : file.contentType.startsWith("image/") ? <Image src={url} alt={file.name} width={1600} height={1200} unoptimized className="max-h-full max-w-full object-contain" />
    : file.contentType.startsWith("video/") ? <video src={url} controls className="max-h-full max-w-full" />
    : file.contentType.startsWith("audio/") ? <audio src={url} controls className="w-full max-w-xl" /> : <div className="text-center"><KnowledgeFileIcon name={file.name} contentType={file.contentType} className="mx-auto mb-4 h-20 w-20" /><p className="text-sm text-neutral-500">A browser preview is not available for this file type.</p></div>;
  return <ReaderShell name={file.name} subtitle={`${venture} · ${(file.size / 1024).toFixed(1)} KB`} onBack={onBack} action={<div className="flex shrink-0 items-center gap-2">{isMarkdown && <MarkdownViewToggle value={markdownView} onChange={setMarkdownView} />}<a href={url} download={file.name} aria-label={`Download ${file.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"><Download size={16} /></a></div>}>{preview}</ReaderShell>;
}

export function LiveKnowledgeScreen() {
  const { activeVentureId: ventureId } = useStudio();
  const router = useRouter();
  const requestedDocumentId = useSearchParams().get("doc");
  const [view, setView] = useState<"library" | "search">("library");
  const [packetMode, setPacketMode] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "draft" | "approved" | "stale">("");
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [cursor, setCursor] = useState<string | undefined>();
  const [fileCursor, setFileCursor] = useState<string | undefined>();
  const [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<DocumentDetail | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ file: FileMetadata; url: string } | null>(null);
  const [uploadMode, setUploadMode] = useState<"markdown" | "file" | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createVentureId, setCreateVentureId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createMarkdown, setCreateMarkdown] = useState("");
  const [createEvidenceClass, setCreateEvidenceClass] = useState("founder_reported");
  const [createSensitivity, setCreateSensitivity] = useState("team");
  const [createSourceUri, setCreateSourceUri] = useState("");
  const [createSummary, setCreateSummary] = useState("Initial version");
  const [importName, setImportName] = useState("");
  const [createError, setCreateError] = useState("");
  const [packetIds, setPacketIds] = useState<string[]>([]);
  const [packetBusy, setPacketBusy] = useState(false);

  useEffect(() => { queueMicrotask(() => { setSelected(null); setSelectedFile(null); setResults(null); setPacketIds([]); setPacketMode(false); }); }, [ventureId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setLoadingDocuments(true); });
    queueMicrotask(() => Promise.all([loadLiveSession(), listLiveDocuments(undefined, { ...(ventureId ? { ventureId } : {}), ...(status ? { status } : {}) }), listLiveFiles(undefined, ventureId || undefined)]).then(([nextSession, page, filePage]) => {
      if (active) { setSession(nextSession); setDocuments(page.items); setCursor(page.nextCursor); setFiles(filePage.items); setFileCursor(filePage.nextCursor); setLoadingDocuments(false); setError(""); }
    }).catch((cause: unknown) => { if (active) { setLoadingDocuments(false); setError(cause instanceof Error ? cause.message : "Could not load the document library."); } }));
    return () => { active = false; };
  }, [ventureId, status, revision]);

  useEffect(() => {
    if (!requestedDocumentId) return;
    let active = true;
    queueMicrotask(() => getLiveDocument(requestedDocumentId).then((detail) => {
      if (active) { setSelected(detail); setSelectedFile(null); setView("library"); setDetailOpen(false); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not open the document."); }));
    return () => { active = false; };
  }, [requestedDocumentId]);

  useEffect(() => () => { if (selectedFile?.url) URL.revokeObjectURL(selectedFile.url); }, [selectedFile]);

  async function more() {
    if (!cursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveDocuments(cursor, { ...(ventureId ? { ventureId } : {}), ...(status ? { status } : {}) }); setDocuments((items) => [...items, ...page.items]); setCursor(page.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more documents."); }
    finally { setBusy(false); }
  }

  async function moreFiles() {
    if (!fileCursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveFiles(fileCursor, ventureId || undefined); setFiles((items) => [...items, ...page.items]); setFileCursor(page.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more files."); }
    finally { setBusy(false); }
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { setResults(await searchLiveKnowledge(q.trim(), ventureId || undefined)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Search failed."); }
    finally { setBusy(false); }
  }

  async function openDocument(id: string) {
    setBusy(true); setError(""); setResult("");
    try { setSelected(await getLiveDocument(id)); setSelectedFile(null); setDetailOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the document."); }
    finally { setBusy(false); }
  }

  async function openFile(file: FileMetadata) {
    setBusy(true); setError(""); setResult("");
    try { const url = await prepareLiveFileDownload(file.id, file.contentType); setSelected(null); setSelectedFile({ file, url }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the file."); }
    finally { setBusy(false); }
  }

  async function reviewDocument(status: "approved" | "stale") {
    if (!selected) return;
    setBusy(true); setError(""); setResult("");
    try {
      await updateLiveDocumentMetadata(selected.document.id, { status, ...(status === "approved" ? { lastReviewedAt: new Date().toISOString() } : {}) });
      setSelected(await getLiveDocument(selected.document.id)); setRevision((value) => value + 1);
      setResult(status === "approved" ? "The current document version was approved and audited." : "The document was marked stale and audited.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update document review status."); }
    finally { setBusy(false); }
  }

  const canEdit = !!selected && (session?.membership.role === "admin" || (!!selected.document.ventureId && ["venture_head", "contributor"].includes(session?.membership.role ?? "") && !!session?.membership.ventureIds.includes(selected.document.ventureId)));
  const canEditDocument = (document: DocumentMetadata) => session?.membership.role === "admin" || (!!document.ventureId && ["venture_head", "contributor"].includes(session?.membership.role ?? "") && !!session?.membership.ventureIds.includes(document.ventureId));
  const canApprove = !!selected && (session?.membership.role === "admin" || (session?.membership.role === "venture_head" && !!selected.document.ventureId && !!session.membership.ventureIds.includes(selected.document.ventureId)));
  const ventureName = (id?: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? "Workspace";
  const canCreate = session?.membership.role === "admin" || ((session?.membership.role === "venture_head" || session?.membership.role === "contributor") && session.hierarchy.ventures.length > 0);
  const lockedCreateScope = Boolean(ventureId);
  const libraryItems = [
    ...documents.map((item) => ({ kind: "document" as const, item, date: item.updatedAt })),
    ...files.map((item) => ({ kind: "file" as const, item, date: item.createdAt })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  function startCreate() {
    setCreateVentureId(ventureId);
    setCreateTitle(""); setCreateMarkdown(""); setCreateEvidenceClass("founder_reported"); setCreateSensitivity("team");
    setCreateSourceUri(""); setCreateSummary("Initial version"); setImportName(""); setCreateError(""); setCreating(true);
  }

  async function importMarkdown(file?: File) {
    if (!file) return;
    if (!/\.(md|markdown|txt)$/i.test(file.name) || file.size > 2_000_000 || file.size === 0) { setCreateError("Choose a nonempty .md or .txt file up to 2 MB."); return; }
    try {
      const text = await file.text();
      if (!text.trim() || text.length > 2_000_000) throw new Error("The file must contain Markdown text under 2 million characters.");
      setCreateMarkdown(text); setImportName(file.name); setCreateError("");
      if (!createTitle.trim()) setCreateTitle(file.name.replace(/\.(md|markdown|txt)$/i, ""));
    } catch (cause) { setCreateError(cause instanceof Error ? cause.message : "Could not read the file."); }
  }

  async function createDocument(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !canCreate || (session.membership.role !== "admin" && (!createVentureId || !session.membership.ventureIds.includes(createVentureId))) || (lockedCreateScope && createVentureId !== ventureId)) { setCreateError("The selected destination is unavailable."); return; }
    setBusy(true); setCreateError("");
    try {
      const created = await createLiveDocument({ ...(createVentureId ? { ventureId: createVentureId } : {}), title: createTitle, markdown: createMarkdown, evidenceClass: createEvidenceClass, sensitivity: createSensitivity, sourceUri: createSourceUri || undefined, changeSummary: createSummary });
      if ((created.ventureId ?? "") !== createVentureId) throw new Error("The document was created in an unexpected destination.");
      const detail = await getLiveDocument(created.id).catch(() => null);
      setCreating(false); setStatus(""); setRevision((value) => value + 1);
      if (detail) { setSelected(detail); setDetailOpen(true); }
      setResult(detail ? "Document created as a draft. Approval is a separate review action." : "Document created as a draft. Refresh the library to open it.");
    } catch (cause) { setCreateError(cause instanceof Error ? cause.message : "Could not create the document."); }
    finally { setBusy(false); }
  }

  function closeDocument() {
    setSelected(null); setDetailOpen(false);
    if (requestedDocumentId) router.replace("/knowledge/live");
  }

  async function preparePacket() {
    if (packetIds.length === 0) return;
    setPacketBusy(true); setError(""); setResult("");
    try {
      const details = await Promise.all(packetIds.map((id) => getLiveDocument(id)));
      if (details.some((item) => item.document.status !== "approved")) throw new Error("One selected record is no longer approved. Refresh the library and select approved records again.");
      const text = details.map((item) => `## ${item.document.title}\nRecord: ${item.document.id} · Version: ${item.version.version}\nEvidence: ${item.document.evidenceClass.replaceAll("_", " ")} · Sensitivity: ${item.document.sensitivity.replaceAll("_", " ")}\nSource: ${item.version.sourceUri || "Not recorded"}\n\n${item.version.markdown}`).join("\n\n---\n\n");
      return text;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare the context packet."); return null; }
    finally { setPacketBusy(false); }
  }

  async function copyPacket() {
    const text = await preparePacket();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setResult("Authorized context packet copied."); }
    catch { setError("Clipboard access failed. Try the Markdown export instead."); }
  }

  async function exportPacket() {
    const text = await preparePacket();
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "venture-studio-context-packet.md"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setResult("Authorized context packet exported as Markdown.");
  }

  if (selectedFile) return <FileReader file={selectedFile.file} url={selectedFile.url} venture={ventureName(selectedFile.file.ventureId)} onBack={() => setSelectedFile(null)} />;

  return <div className={selected ? "min-w-0 w-full" : "mx-auto min-w-0 w-full max-w-[1580px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6"}>
    {!selected && <PageTitle title="Knowledge" description="Browse records and files in one library." action={<div className="flex flex-wrap gap-2">{canCreate && <><button type="button" onClick={startCreate} className={primaryClass}><Plus size={15} />New record</button><button type="button" onClick={() => setUploadMode("file")} className={secondaryClass}>Upload file</button></>}<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button></div>} />}
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm font-semibold text-success-text">{result}</p>}
    {requestedDocumentId && !selected && !error ? <Panel className="p-8 text-sm text-neutral-500"><p role="status">Opening document…</p></Panel> : selected ? <DocumentReader key={selected.document.id} detail={selected} venture={ventureName(selected.document.ventureId)} onBack={closeDocument} onDetails={() => setDetailOpen(true)} onEdit={canEdit ? () => router.push(`/knowledge/live/edit/${encodeURIComponent(selected.document.id)}`) : undefined} /> : <>
      <div role="tablist" aria-label="Knowledge sections" className="mb-4 flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-1">{(["library", "search"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => setView(item)} className={`min-h-9 rounded-lg px-4 text-sm font-semibold transition-colors ${view === item ? "bg-primary-700 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}>{item === "search" ? "Evidence search" : "Library"}</button>)}</div>
      {view === "library" && <><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div className="w-full max-w-xs flex-1"><Field label="Record status"><Select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="">All visible statuses</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="stale">Stale</option></Select></Field></div><button type="button" onClick={() => { setPacketMode((value) => !value); setPacketIds([]); }} className={secondaryClass}>{packetMode ? "Done selecting" : "Create context packet"}</button></div>
        {packetMode && <Panel className="mb-4 flex flex-wrap items-center justify-between gap-3 border-primary-200 bg-primary-50 p-4"><p className="text-sm text-neutral-700"><span className="font-semibold">{packetIds.length} approved record{packetIds.length === 1 ? "" : "s"} selected.</span> Choose thumbnails, then copy or export the authorized Markdown.</p><div className="flex gap-2"><button type="button" disabled={!packetIds.length || packetBusy} onClick={() => void copyPacket()} className={secondaryClass}><Copy size={15} />Copy packet</button><button type="button" disabled={!packetIds.length || packetBusy} onClick={() => void exportPacket()} className={secondaryClass}><Download size={15} />Export</button></div></Panel>}
        <Panel className="p-4 sm:p-5"><div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-neutral-900">Library</h2><span className="text-xs text-neutral-500">{loadingDocuments ? "Loading…" : `${documents.length} records · ${files.length} files`}</span></div>{loadingDocuments ? <p role="status" className="py-12 text-center text-sm text-neutral-500">Loading library…</p> : libraryItems.length ? <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{libraryItems.map((entry) => entry.kind === "document" ? <KnowledgeDocumentTile key={`document-${entry.item.id}`} title={entry.item.title} venture={ventureName(entry.item.ventureId)} status={`Record · ${entry.item.status}`} updatedAt={stamp(entry.item.updatedAt)} onOpen={() => void openDocument(entry.item.id)} onEdit={!packetMode && canEditDocument(entry.item) ? () => router.push(`/knowledge/live/edit/${encodeURIComponent(entry.item.id)}`) : undefined} selected={packetIds.includes(entry.item.id)} onSelect={packetMode && entry.item.status === "approved" ? (checked) => setPacketIds((ids) => checked ? [...ids, entry.item.id] : ids.filter((id) => id !== entry.item.id)) : undefined} /> : <KnowledgeDocumentTile key={`file-${entry.item.id}`} fileId={entry.item.id} title={entry.item.name} fileName={entry.item.name} contentType={entry.item.contentType} venture={ventureName(entry.item.ventureId)} status="File" updatedAt={stamp(entry.item.createdAt)} onOpen={() => void openFile(entry.item)} />)}</div> : <Empty title="Nothing in this library yet" body="Create a record or upload a file to this venture." />}{(cursor || fileCursor) && <div className="mt-6 flex flex-wrap gap-3">{cursor && <button type="button" disabled={busy} onClick={more} className="text-xs font-semibold text-primary-700 underline">Load more records</button>}{fileCursor && <button type="button" disabled={busy} onClick={() => void moreFiles()} className="text-xs font-semibold text-primary-700 underline">Load more files</button>}</div>}</Panel>
      </>}
      {view === "search" && <Panel><PanelHead title="Evidence search" /><form onSubmit={search} className="flex flex-wrap gap-2 border-b border-neutral-100 p-4"><label className="relative min-w-48 flex-1"><span className="sr-only">Search knowledge</span><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input required minLength={2} maxLength={200} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search approved evidence" className={`${inputClass} pl-9`} /></label><button disabled={busy} className={primaryClass}>{busy ? "Searching…" : "Search"}</button></form>{!results ? <div className="px-5 py-8 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-primary-50 text-primary-700"><BookOpenText size={20} /></span><p className="mt-3 text-sm font-semibold text-neutral-800">Find a verified source</p><p className="mt-1 text-sm text-neutral-500">Enter at least two characters.</p></div> : results.items.length ? <div className="divide-y divide-neutral-100">{results.items.map((item, index) => <button key={`${item.documentId}-${item.versionId}-${index}`} type="button" onClick={() => void openDocument(item.documentId)} className="w-full px-5 py-4 text-left hover:bg-neutral-50"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-neutral-800">{item.title}</span><Badge tone="purple">{item.evidenceClass.replaceAll("_", " ")}</Badge></span><span className="mt-2 line-clamp-3 block whitespace-pre-wrap text-sm leading-6 text-neutral-600">{item.excerpt}</span><span className="mt-2 block break-all font-mono text-[10px] text-neutral-400">{item.sourceRef}</span></button>)}</div> : <Empty title="No authorized evidence matched" body={results.warnings[0] ?? "Try another query."} />}</Panel>}
    </>}
    {selected && detailOpen && <DetailDrawer title={selected.document.title} subtitle={`${ventureName(selected.document.ventureId)} · version ${selected.version.version}`} onClose={() => setDetailOpen(false)}>
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone="purple">{selected.document.evidenceClass.replaceAll("_", " ")}</Badge><Badge>{selected.document.sensitivity.replaceAll("_", " ")}</Badge><Badge tone={selected.document.status === "approved" ? "green" : "amber"}>{selected.document.status}</Badge></div>
      <p className="text-xs text-neutral-500">Last changed {stamp(selected.version.createdAt)} · Document {selected.document.id}</p>
      <p className="mt-2 text-xs text-neutral-500">{selected.versions.length} version{selected.versions.length === 1 ? "" : "s"} recorded. Only the current version can be opened here.</p>
      {error && <p role="alert" className="mt-3 rounded-xl bg-danger-surface p-3 text-xs font-semibold text-danger-text">{error}</p>}
      {result && <p role="status" className="mt-3 rounded-xl bg-success-surface p-3 text-xs font-semibold text-success-text">{result}</p>}
      {canApprove && <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={busy || selected.document.status === "approved"} onClick={() => reviewDocument("approved")} className={primaryClass}>Approve current version</button><button type="button" disabled={busy || selected.document.status === "stale"} onClick={() => reviewDocument("stale")} className={secondaryClass}>Mark stale</button></div>}
      {canEdit && <button type="button" onClick={() => router.push(`/knowledge/live/edit/${encodeURIComponent(selected.document.id)}`)} className={`${secondaryClass} mt-4`}><Edit size={15} />Open editor</button>}
    </DetailDrawer>}
    {creating && <DetailDrawer title="New knowledge document" subtitle="Create a draft in the selected destination" onClose={() => setCreating(false)}>
      <form onSubmit={createDocument} className="space-y-4">
        {lockedCreateScope ? <div aria-label="Document destination" className="rounded-xl bg-neutral-50 p-3 text-sm"><span className="block text-xs font-semibold text-neutral-500">Destination</span><span className="font-bold text-neutral-800">{ventureName(ventureId)}</span></div> : <Field label="Destination"><Select className={inputClass} value={createVentureId} onChange={(event) => setCreateVentureId(event.target.value)} required={session?.membership.role !== "admin"}>{session?.membership.role === "admin" ? <option value="">Workspace</option> : <option value="">Choose a venture</option>}{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>}
        <Field label="Title"><input required maxLength={200} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} className={inputClass} placeholder="What should this source be called?" /></Field>
        <Field label="Markdown"><textarea required maxLength={2_000_000} value={createMarkdown} onChange={(event) => setCreateMarkdown(event.target.value)} className={`${inputClass} min-h-56 py-3 font-mono`} placeholder="# Heading&#10;&#10;Write or paste the source content…" /></Field>
        <label className="block text-xs font-semibold text-neutral-600">Import Markdown or text file<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(event) => { void importMarkdown(event.target.files?.[0]); event.target.value = ""; }} className="mt-2 block w-full min-w-0 text-xs text-neutral-600 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-2 file:font-bold" /></label>
        {importName && <p className="text-xs text-neutral-500">Loaded {importName} into the editor. It is saved only when you create the document.</p>}
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Evidence class"><Select className={inputClass} value={createEvidenceClass} onChange={(event) => setCreateEvidenceClass(event.target.value)}>{["verified_fact", "founder_reported", "approved_decision", "planning_assumption", "hypothesis", "open_question", "historical"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</Select></Field><Field label="Sensitivity"><Select className={inputClass} value={createSensitivity} onChange={(event) => setCreateSensitivity(event.target.value)}>{["team", "venture_restricted", "manager", ...(session?.membership.role === "admin" ? ["founder_private"] : [])].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</Select></Field></div>
        <Field label="Source URL, optional"><input type="url" value={createSourceUri} onChange={(event) => setCreateSourceUri(event.target.value)} className={inputClass} placeholder="https://…" /></Field>
        <Field label="Change summary"><input required maxLength={500} value={createSummary} onChange={(event) => setCreateSummary(event.target.value)} className={inputClass} /></Field>
        <p className="text-xs leading-5 text-neutral-500">The source URL records provenance; it does not fetch or import the webpage. New documents start as drafts and are not in approved evidence search.</p>
        {createError && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-xs font-semibold text-danger-text">{createError}</p>}
        <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}>{busy ? "Creating…" : "Create draft document"}</button><button type="button" onClick={() => setCreating(false)} className={secondaryClass}>Cancel</button></div>
      </form>
    </DetailDrawer>}
    {uploadMode && session && <KnowledgeUploadDialog mode={uploadMode} session={session} activeVentureId={ventureId} onClose={() => setUploadMode(null)} onComplete={() => { setRevision((value) => value + 1); setResult("Upload complete. Markdown and text become draft records; other files stay private to their venture."); }} />}
  </div>;
}
