"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BookOpenText, Copy, Download, Plus, RefreshCw, Search } from "@/components/ui/icons";
import { createLiveDocument, getLiveDocument, listLiveDocuments, loadLiveSession, searchLiveKnowledge, updateLiveDocument, updateLiveDocumentMetadata } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { LiveFileLibrary } from "@/components/studio/live-file-library";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Results = Awaited<ReturnType<typeof searchLiveKnowledge>>;
type DocumentDetail = Awaited<ReturnType<typeof getLiveDocument>>;
type DocumentMetadata = Awaited<ReturnType<typeof listLiveDocuments>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

export function LiveKnowledgeScreen() {
  const requestedDocumentId = useSearchParams().get("doc");
  const [session, setSession] = useState<Session | null>(null);
  const [q, setQ] = useState("");
  const [ventureId, setVentureId] = useState("");
  const [status, setStatus] = useState<"" | "draft" | "approved" | "stale">("");
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<DocumentDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [sourceUri, setSourceUri] = useState("");
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

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([loadLiveSession(), listLiveDocuments(undefined, { ...(ventureId ? { ventureId } : {}), ...(status ? { status } : {}) })]).then(([nextSession, page]) => {
      if (active) { setSession(nextSession); setDocuments(page.items); setCursor(page.nextCursor); setError(""); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the document library."); }));
    return () => { active = false; };
  }, [ventureId, status, revision]);

  useEffect(() => {
    if (!requestedDocumentId) return;
    let active = true;
    queueMicrotask(() => getLiveDocument(requestedDocumentId).then((detail) => {
      if (active) { setSelected(detail); setDetailOpen(true); setEditing(false); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not open the document."); }));
    return () => { active = false; };
  }, [requestedDocumentId]);

  async function more() {
    if (!cursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveDocuments(cursor, { ...(ventureId ? { ventureId } : {}), ...(status ? { status } : {}) }); setDocuments((items) => [...items, ...page.items]); setCursor(page.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more documents."); }
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
    try { setSelected(await getLiveDocument(id)); setDetailOpen(false); setEditing(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the document."); }
    finally { setBusy(false); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setResult("");
    try {
      await updateLiveDocument(selected.document.id, { markdown, changeSummary, ...(sourceUri ? { sourceUri } : {}) });
      setSelected(await getLiveDocument(selected.document.id)); setEditing(false); setRevision((value) => value + 1);
      setResult("A new draft version was saved. Approval is a separate review action.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the document version."); }
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
  const canApprove = !!selected && (session?.membership.role === "admin" || (session?.membership.role === "venture_head" && !!selected.document.ventureId && !!session.membership.ventureIds.includes(selected.document.ventureId)));
  const ventureName = (id?: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? "Workspace";
  const canCreate = session?.membership.role === "admin" || ((session?.membership.role === "venture_head" || session?.membership.role === "contributor") && session.hierarchy.ventures.length > 0);
  const lockedCreateScope = Boolean(ventureId);

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
      if (detail) { setSelected(detail); setDetailOpen(true); setEditing(false); }
      setResult(detail ? "Document created as a draft. Approval is a separate review action." : "Document created as a draft. Refresh the library to open it.");
    } catch (cause) { setCreateError(cause instanceof Error ? cause.message : "Could not create the document."); }
    finally { setBusy(false); }
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

  return <PageFrame>
    <PageTitle title="Knowledge" description="Search Markdown records with ownership, source, evidence class, and review history." action={<div className="flex flex-wrap gap-2">{canCreate && <button type="button" onClick={startCreate} className={primaryClass}><Plus size={15} />New record</button>}<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button></div>} />
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm font-semibold text-success-text">{result}</p>}
    <Panel className="mb-4 border-primary-100 bg-primary-50/50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-neutral-900">Context packet for ChatGPT / Codex</p><p className="mt-1 text-sm text-neutral-600">Select approved records below. The packet includes current Markdown, source IDs, evidence labels, and versions; access is rechecked when you export.</p></div><div className="flex gap-2"><button type="button" disabled={!packetIds.length || packetBusy} onClick={() => void copyPacket()} className={secondaryClass}><Copy size={15} />Copy packet</button><button type="button" disabled={!packetIds.length || packetBusy} onClick={() => void exportPacket()} className={secondaryClass}><Download size={15} />Export</button></div></div><p className="mt-2 text-xs font-semibold text-primary-700">{packetIds.length} approved record{packetIds.length === 1 ? "" : "s"} selected</p></Panel>
    <Panel className="mb-4 grid gap-3 p-4 sm:grid-cols-2"><Field label="Venture"><Select className={inputClass} value={ventureId} onChange={(event) => { setVentureId(event.target.value); setResults(null); }}><option value="">All authorized ventures</option>{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="Status"><Select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="">All visible statuses</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="stale">Stale</option></Select></Field></Panel>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]"><Panel><PanelHead title="Documents" aside={<Badge tone="blue">{documents.length}{cursor ? "+" : ""}</Badge>} /><div className="divide-y divide-neutral-100">{documents.length ? documents.map((item) => <div key={item.id} className="flex items-start gap-3 p-4 hover:bg-neutral-50"><input type="checkbox" aria-label={`Include ${item.title} in context packet`} disabled={item.status !== "approved"} checked={packetIds.includes(item.id)} onChange={(event) => setPacketIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} className="mt-1 h-4 w-4 accent-primary-600" /><button type="button" onClick={() => openDocument(item.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-neutral-800">{item.title}</span><span className="mt-1 block text-xs text-neutral-500">{ventureName(item.ventureId)} · Updated {stamp(item.updatedAt)}</span></span><Badge tone={item.status === "approved" ? "green" : item.status === "draft" ? "amber" : "neutral"}>{item.status}</Badge><Badge tone="purple">{item.evidenceClass.replaceAll("_", " ")}</Badge></button></div>) : <Empty title="No authorized documents" body="No documents are available in this scope." />}</div>{cursor && <button type="button" disabled={busy} onClick={more} className="m-4 text-xs font-semibold text-primary-700 underline">Load more documents</button>}</Panel>
    <Panel>{selected ? <><PanelHead title={selected.document.title} aside={<button type="button" onClick={() => setDetailOpen(true)} className="text-xs font-semibold text-primary-700">Open full record</button>} /><div className="p-5"><div className="flex flex-wrap gap-2"><Badge tone={selected.document.status === "approved" ? "green" : "amber"}>{selected.document.status}</Badge><Badge tone="purple">{selected.document.evidenceClass.replaceAll("_", " ")}</Badge><Badge>{selected.document.sensitivity.replaceAll("_", " ")}</Badge></div><p className="mt-3 text-xs text-neutral-500">{ventureName(selected.document.ventureId)} · Version {selected.version.version} · Updated {stamp(selected.document.updatedAt)}</p><pre className="mt-4 max-h-[34rem] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-neutral-700">{selected.version.markdown}</pre></div></> : <Empty title="Select a record" body="Its evidence, source, Markdown, and review metadata appear here." />}</Panel></div>
    <Panel className="my-4"><PanelHead title="Evidence search" /><form onSubmit={search} className="flex flex-wrap gap-2 border-b border-neutral-100 p-4"><label className="relative min-w-48 flex-1"><span className="sr-only">Search knowledge</span><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input required minLength={2} maxLength={200} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search approved evidence" className={`${inputClass} pl-9`} /></label><button disabled={busy} className={primaryClass}>{busy ? "Searching…" : "Search"}</button></form>{!results ? <div className="px-5 py-8 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-primary-50 text-primary-700"><BookOpenText size={20} /></span><p className="mt-3 text-sm font-semibold text-neutral-800">Find a verified source</p><p className="mt-1 text-sm text-neutral-500">Enter at least two characters.</p></div> : results.items.length ? <div className="divide-y divide-neutral-100">{results.items.map((item, index) => <button key={`${item.documentId}-${item.versionId}-${index}`} type="button" onClick={() => openDocument(item.documentId)} className="w-full px-5 py-4 text-left hover:bg-neutral-50"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-neutral-800">{item.title}</span><Badge tone="purple">{item.evidenceClass.replaceAll("_", " ")}</Badge></span><span className="mt-2 line-clamp-3 block whitespace-pre-wrap text-sm leading-6 text-neutral-600">{item.excerpt}</span><span className="mt-2 block break-all font-mono text-[10px] text-neutral-400">{item.sourceRef}</span></button>)}</div> : <Empty title="No authorized evidence matched" body={results.warnings[0] ?? "Try another query."} />}</Panel>
    <LiveFileLibrary session={session} />
    {selected && detailOpen && <DetailDrawer title={selected.document.title} subtitle={`${ventureName(selected.document.ventureId)} · version ${selected.version.version}`} onClose={() => { setDetailOpen(false); setEditing(false); }}>
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone="purple">{selected.document.evidenceClass.replaceAll("_", " ")}</Badge><Badge>{selected.document.sensitivity.replaceAll("_", " ")}</Badge><Badge tone={selected.document.status === "approved" ? "green" : "amber"}>{selected.document.status}</Badge></div>
      <p className="text-xs text-neutral-500">Last changed {stamp(selected.version.createdAt)} · Document {selected.document.id}</p>
      <p className="mt-2 text-xs text-neutral-500">{selected.versions.length} version{selected.versions.length === 1 ? "" : "s"} recorded. Only the current version can be opened here.</p>
      {error && <p role="alert" className="mt-3 rounded-xl bg-danger-surface p-3 text-xs font-semibold text-danger-text">{error}</p>}
      {result && <p role="status" className="mt-3 rounded-xl bg-success-surface p-3 text-xs font-semibold text-success-text">{result}</p>}
      {canApprove && !editing && <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={busy || selected.document.status === "approved"} onClick={() => reviewDocument("approved")} className={primaryClass}>Approve current version</button><button type="button" disabled={busy || selected.document.status === "stale"} onClick={() => reviewDocument("stale")} className={secondaryClass}>Mark stale</button></div>}
      {editing ? <form onSubmit={save} className="mt-5 space-y-4"><Field label="Markdown"><textarea required maxLength={2000000} value={markdown} onChange={(event) => setMarkdown(event.target.value)} className={`${inputClass} min-h-64 py-3 font-mono`} /></Field><Field label="Change summary"><input required maxLength={500} value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} className={inputClass} /></Field><Field label="Source URL, optional"><input type="url" value={sourceUri} onChange={(event) => setSourceUri(event.target.value)} className={inputClass} /></Field><p className="text-xs leading-5 text-warning-text">Saving creates a new draft version. It does not automatically approve or publish it to evidence search.</p><div className="flex gap-2"><button disabled={busy} className={primaryClass}>Save draft version</button><button type="button" onClick={() => setEditing(false)} className={secondaryClass}>Cancel</button></div></form> : <><pre className="mt-5 whitespace-pre-wrap break-words rounded-xl bg-neutral-50 p-4 font-sans text-sm leading-6 text-neutral-700">{selected.version.markdown}</pre>{canEdit && <button type="button" onClick={() => { setMarkdown(selected.version.markdown); setSourceUri(selected.version.sourceUri ?? ""); setChangeSummary(""); setEditing(true); }} className={`${secondaryClass} mt-4`}>Edit as new draft</button>}</>}
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
  </PageFrame>;
}
