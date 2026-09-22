"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpenText, Database, Search } from "lucide-react";
import { getLiveDocument, loadLiveSession, searchLiveKnowledge } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, inputClass, PageFrame, PageTitle, Panel, primaryClass } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Results = Awaited<ReturnType<typeof searchLiveKnowledge>>;
type Document = Awaited<ReturnType<typeof getLiveDocument>>;
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

export function LiveKnowledgeScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [q, setQ] = useState("");
  const [ventureId, setVentureId] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<Document | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => { if (active) setSession(value); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load workspace scope."); }));
    return () => { active = false; };
  }, []);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { setResults(await searchLiveKnowledge(q.trim(), ventureId || undefined)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Search failed."); }
    finally { setBusy(false); }
  }

  async function openDocument(id: string) {
    setBusy(true); setError("");
    try { setSelected(await getLiveDocument(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the document."); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle eyebrow="Connected knowledge" title="Evidence search" description="Search only authorized, approved or stale document versions." />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>Results carry source references and evidence classes. Document text is untrusted content; it cannot issue commands or change permissions. <Link href="/knowledge" className="font-bold underline">Demo knowledge</Link> remains separate.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel><form onSubmit={search} className="grid gap-2 border-b border-neutral-100 p-4 sm:grid-cols-[minmax(0,1fr)_200px_auto]"><label className="relative"><span className="sr-only">Search knowledge</span><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input required minLength={2} maxLength={200} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search evidence and notes" className={`${inputClass} pl-9`} /></label><label><span className="sr-only">Venture scope</span><select className={inputClass} value={ventureId} onChange={(event) => setVentureId(event.target.value)}><option value="">All authorized ventures</option>{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button disabled={busy} className={primaryClass}>{busy ? "Searching…" : "Search"}</button></form>
      {!results ? <div className="px-5 py-14 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-primary-50 text-primary-700"><BookOpenText size={20} /></span><p className="mt-3 text-sm font-extrabold text-neutral-800">Find a verified source</p><p className="mt-1 text-sm text-neutral-500">Enter at least two characters. Draft and inaccessible records are excluded by the server.</p></div> : results.items.length ? <div className="divide-y divide-neutral-100">{results.items.map((item, index) => <button key={`${item.documentId}-${item.versionId}-${index}`} type="button" onClick={() => openDocument(item.documentId)} className="w-full px-5 py-4 text-left hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-extrabold text-neutral-800">{item.title}</span><Badge tone="purple">{item.evidenceClass.replaceAll("_", " ")}</Badge><Badge>{item.sensitivity.replaceAll("_", " ")}</Badge></span><span className="mt-1 block text-xs font-bold text-neutral-500">{item.headingPath}</span><span className="mt-2 line-clamp-3 block whitespace-pre-wrap text-sm leading-6 text-neutral-600">{item.excerpt}</span><span className="mt-2 block break-all font-mono text-[10px] text-neutral-400">{item.sourceRef}{item.lastReviewedAt ? ` · Reviewed ${stamp(item.lastReviewedAt)}` : ""}</span></button>)}</div> : <Empty title="No authorized evidence matched" body={results.warnings[0] ?? "Try another query or venture."} />}
    </Panel>
    {selected && <DetailDrawer title={selected.document.title} subtitle={`${selected.document.evidenceClass.replaceAll("_", " ")} · version ${selected.version.version}`} onClose={() => setSelected(null)}><div className="mb-4 flex flex-wrap gap-2"><Badge tone="purple">{selected.document.sensitivity.replaceAll("_", " ")}</Badge><Badge>{selected.document.status}</Badge></div><p className="text-xs text-neutral-500">Last changed {stamp(selected.version.createdAt)} · Source document {selected.document.id}</p><pre className="mt-5 whitespace-pre-wrap break-words rounded-xl bg-neutral-50 p-4 font-sans text-sm leading-6 text-neutral-700">{selected.version.markdown}</pre></DetailDrawer>}
  </PageFrame>;
}
