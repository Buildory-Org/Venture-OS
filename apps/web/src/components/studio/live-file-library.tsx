"use client";

import { Select } from "@/components/ui/select";
import { useState } from "react";
import { loadLiveSession, searchLiveFiles, type LiveFileSearchHit } from "@/lib/studio-api";
import { LiveFileDownload, LiveFileUpload } from "@/components/studio/live-file-controls";
import { Field, inputClass, Panel, PanelHead, primaryClass } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;

export function LiveFileLibrary({ session }: { session: Session | null }) {
  const [ventureId, setVentureId] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LiveFileSearchHit[] | null>(null);
  const [recent, setRecent] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canUpload = !!session && ["admin", "venture_head", "contributor"].includes(session.membership.role);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { setHits(await searchLiveFiles(query.trim(), ventureId || undefined)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "File search failed."); }
    finally { setBusy(false); }
  }

  return <Panel className="mb-4"><PanelHead title="Files & links" /><div className="grid gap-5 p-4 lg:grid-cols-2"><div className="space-y-3"><p className="text-xs leading-5 text-neutral-500">Files are private to their authorized venture and group. A general file list is not available; search a name to find existing files.</p><Field label="File venture"><Select className={inputClass} value={ventureId} onChange={(event) => { setVentureId(event.target.value); setHits(null); setRecent(null); }}><option value="">All authorized ventures for search</option>{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>{canUpload && (ventureId ? <LiveFileUpload key={ventureId} ventureId={ventureId} onUploaded={(file) => setRecent({ id: file.id, name: file.name })} /> : <p className="text-xs text-neutral-500">Choose a venture to upload a file. Group-scoped files are uploaded from their task detail.</p>)}{recent && <div role="status" className="rounded-xl bg-success-surface p-3 text-sm text-success-text"><p className="font-bold">Upload ready: {recent.name}</p><LiveFileDownload id={recent.id} name={recent.name} /></div>}</div><div><form onSubmit={search} className="flex flex-wrap gap-2"><label className="min-w-48 flex-1"><span className="sr-only">Search file names</span><input required minLength={2} maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search file names" className={inputClass} /></label><button disabled={busy} className={primaryClass}>{busy ? "Searching…" : "Search files"}</button></form>{error && <p role="alert" className="mt-2 text-xs text-danger-text">{error}</p>}{hits && <div className="mt-3 space-y-2" aria-live="polite">{hits.length ? hits.map((file) => <div key={file.id} className="rounded-xl bg-neutral-50 p-3"><p className="break-words text-sm font-semibold text-neutral-800">{file.title}</p><p className="text-xs text-neutral-500">{file.excerpt} · {file.sourceRef}</p><LiveFileDownload id={file.id} name={file.title} /></div>) : <p className="text-sm text-neutral-500">No authorized files matched this name.</p>}</div>}</div></div></Panel>;
}
