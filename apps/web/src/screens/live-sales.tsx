"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Database, Plus, RefreshCw } from "lucide-react";
import { createLiveOpportunity, createLivePipeline, listLiveOpportunities, listLivePipelines, loadLiveSession, updateLiveOpportunity, updateLivePipeline } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Pipeline = Awaited<ReturnType<typeof listLivePipelines>>[number];
type Opportunity = Awaited<ReturnType<typeof listLiveOpportunities>>[number];
const stages = ["identified", "qualified", "contacted", "conversation", "proposal", "won", "lost"] as const;
const stamp = (value?: string) => value ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value)) : "No date";

export function LiveSalesScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [ventureId, setVentureId] = useState("");
  const [newPipeline, setNewPipeline] = useState(false);
  const [newOpportunity, setNewOpportunity] = useState(false);
  const [pipelineName, setPipelineName] = useState("");
  const [offerName, setOfferName] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [source, setSource] = useState("");
  const [signal, setSignal] = useState("");
  const [fitReason, setFitReason] = useState("");
  const [confidence, setConfidence] = useState<"low" | "medium" | "high">("low");
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      Promise.all([loadLiveSession(), listLivePipelines(), listLiveOpportunities()]).then(([nextSession, nextPipelines, nextOpportunities]) => {
        if (!active) return;
        setSession(nextSession); setPipelines(nextPipelines); setOpportunities(nextOpportunities); setBusy(false); setError("");
      }).catch((cause: unknown) => { if (active) { setBusy(false); setError(cause instanceof Error ? cause.message : "Could not load sales records."); } });
    });
    return () => { active = false; };
  }, [revision]);

  const selectedPipelines = pipelines.filter((item) => !ventureId || item.ventureId === ventureId);
  const visible = opportunities.filter((item) => selectedPipelines.some((pipeline) => pipeline.id === item.pipelineId));
  const canManage = session?.membership.role === "admin" || session?.membership.role === "venture_head";
  const ventureName = (id: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? id;

  async function createPipeline(event: React.FormEvent) {
    event.preventDefault();
    if (!ventureId) { setError("Choose one venture before creating a pipeline."); return; }
    setBusy(true); setError("");
    try { await createLivePipeline({ ventureId, name: pipelineName, offerName, status: "active" }); setNewPipeline(false); setPipelineName(""); setOfferName(""); setRevision((value) => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the pipeline."); }
    finally { setBusy(false); }
  }

  async function createOpportunity(event: React.FormEvent) {
    event.preventDefault();
    if (!session) return;
    setBusy(true); setError("");
    try {
      await createLiveOpportunity({ pipelineId, companyName, contactName, source, observedSignal: signal, fitReason, evidenceConfidence: confidence, stage: "identified", ownerId: session.user.id, nextAction, ...(nextActionAt ? { nextActionAt: new Date(nextActionAt).toISOString() } : {}) });
      setNewOpportunity(false); setCompanyName(""); setContactName(""); setSource(""); setSignal(""); setFitReason(""); setNextAction(""); setNextActionAt(""); setRevision((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the opportunity."); }
    finally { setBusy(false); }
  }

  async function changeStage(item: Opportunity, stage: Opportunity["stage"]) {
    setBusy(true); setError("");
    try { const updated = await updateLiveOpportunity(item.id, { stage }); setOpportunities((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the stage."); }
    finally { setBusy(false); }
  }

  async function changePipelineStatus(item: Pipeline, status: Pipeline["status"]) {
    setBusy(true); setError("");
    try { const updated = await updateLivePipeline(item.id, { status }); setPipelines((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the pipeline."); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle eyebrow="Connected sales" title="Venture pipelines" description="Evidence-led opportunities partitioned by venture." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>These pipelines and opportunities come from the authorized API. No revenue is inferred from an opportunity stage. <Link href="/sales" className="font-bold underline">Demo sales</Link> remains separate.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel className="mb-4 flex flex-wrap items-end gap-3 p-4"><Field label="Venture"><select className={inputClass} value={ventureId} onChange={(event) => setVentureId(event.target.value)}><option value="">All authorized ventures</option>{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>{canManage && <button type="button" disabled={!ventureId} onClick={() => setNewPipeline(true)} className={secondaryClass}><Plus size={15} />New pipeline</button>}<button type="button" disabled={selectedPipelines.length === 0} onClick={() => { setPipelineId(selectedPipelines[0]?.id ?? ""); setNewOpportunity(true); }} className={primaryClass}><Plus size={15} />New opportunity</button></Panel>
    {busy && !session ? <Panel className="p-8 text-sm text-neutral-500">Loading sales records…</Panel> : <div className="grid gap-4 xl:grid-cols-[310px_minmax(0,1fr)]"><Panel><PanelHead title="Pipelines" aside={<Badge tone="blue">{selectedPipelines.length}</Badge>} /><div className="divide-y divide-neutral-100">{selectedPipelines.length ? selectedPipelines.map((item) => <article key={item.id} className="p-5"><div className="flex items-center gap-2"><h2 className="text-sm font-extrabold text-neutral-800">{item.name}</h2><Badge>{item.status}</Badge></div><p className="mt-1 text-sm text-neutral-600">{item.offerName}</p><p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)}</p>{canManage && <select aria-label={`Status for ${item.name}`} disabled={busy} className={`${inputClass} mt-3`} value={item.status} onChange={(event) => changePipelineStatus(item, event.target.value as Pipeline["status"])}><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></select>}</article>) : <Empty title="No pipelines" body="Create one for an authorized venture to organize its opportunities." />}</div></Panel><Panel><PanelHead title="Opportunities" aside={<Badge tone="green">{visible.length}</Badge>} /><div className="divide-y divide-neutral-100">{visible.length ? visible.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-extrabold text-neutral-800">{item.companyName}</h2><Badge tone="blue">{item.stage}</Badge><Badge>{item.evidenceConfidence} confidence</Badge></div><p className="mt-1 text-xs text-neutral-400">{ventureName(item.ventureId)} · {pipelines.find((pipeline) => pipeline.id === item.pipelineId)?.name ?? item.pipelineId}</p><p className="mt-2 text-sm text-neutral-600">Observed signal: {item.observedSignal || "Not recorded"}</p><p className="mt-1 text-sm text-neutral-600">Fit: {item.fitReason || "Not recorded"}</p><p className="mt-2 text-xs text-neutral-500">Next: {item.nextAction || "Not scheduled"} · {stamp(item.nextActionAt)}</p>{(canManage || item.ownerId === session?.user.id) && <select aria-label={`Stage for ${item.companyName}`} disabled={busy} className={`${inputClass} mt-3 max-w-48`} value={item.stage} onChange={(event) => changeStage(item, event.target.value as Opportunity["stage"])}>{stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}</select>}</article>) : <Empty title="No opportunities" body="The API returned no opportunities in this scope." />}</div></Panel></div>}
    {newPipeline && <DetailDrawer title="Create pipeline" onClose={() => setNewPipeline(false)}><form onSubmit={createPipeline} className="space-y-4"><p className="text-xs text-neutral-500">For {ventureName(ventureId)}. The venture cannot be changed after creation.</p><Field label="Pipeline name"><input required maxLength={120} className={inputClass} value={pipelineName} onChange={(event) => setPipelineName(event.target.value)} /></Field><Field label="Offer"><input required maxLength={200} className={inputClass} value={offerName} onChange={(event) => setOfferName(event.target.value)} /></Field><button disabled={busy} className={primaryClass}>Create pipeline</button></form></DetailDrawer>}
    {newOpportunity && <DetailDrawer title="Create opportunity" onClose={() => setNewOpportunity(false)}><form onSubmit={createOpportunity} className="space-y-4"><Field label="Pipeline"><select required className={inputClass} value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>{selectedPipelines.map((item) => <option key={item.id} value={item.id}>{ventureName(item.ventureId)} · {item.name}</option>)}</select></Field><Field label="Company"><input required maxLength={200} className={inputClass} value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></Field><Field label="Contact"><input maxLength={200} className={inputClass} value={contactName} onChange={(event) => setContactName(event.target.value)} /></Field><Field label="Source"><input maxLength={500} className={inputClass} value={source} onChange={(event) => setSource(event.target.value)} /></Field><Field label="Observed signal"><textarea maxLength={2000} className={`${inputClass} min-h-24 py-3`} value={signal} onChange={(event) => setSignal(event.target.value)} /></Field><Field label="Fit reason"><textarea maxLength={2000} className={`${inputClass} min-h-24 py-3`} value={fitReason} onChange={(event) => setFitReason(event.target.value)} /></Field><Field label="Evidence confidence"><select className={inputClass} value={confidence} onChange={(event) => setConfidence(event.target.value as typeof confidence)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field><Field label="Next action"><input maxLength={1000} className={inputClass} value={nextAction} onChange={(event) => setNextAction(event.target.value)} /></Field><Field label="Next action date"><input type="datetime-local" className={inputClass} value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} /></Field><p className="text-xs text-neutral-500">You will own this opportunity. It starts at the identified stage.</p><button disabled={busy} className={primaryClass}>Create opportunity</button></form></DetailDrawer>}
  </PageFrame>;
}
