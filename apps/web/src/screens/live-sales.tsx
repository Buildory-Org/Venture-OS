"use client";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, RefreshCw } from "@/components/ui/icons";
import { createLiveOpportunity, createLivePipeline, listLiveOpportunities, listLivePipelines, loadLiveSession, updateLiveOpportunity, updateLivePipeline } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageFrame, PageTitle, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Pipeline = Awaited<ReturnType<typeof listLivePipelines>>[number];
type Opportunity = Awaited<ReturnType<typeof listLiveOpportunities>>[number];
const stages = ["identified", "qualified", "contacted", "conversation", "proposal", "won", "lost"] as const;
const stamp = (value?: string) => value ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value)) : "No date";

export function LiveSalesScreen() {
  const { activeVentureId: ventureId, setActiveVentureId } = useStudio();
  const requestedVenture = useSearchParams().get("venture");
  const [session, setSession] = useState<Session | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [newPipeline, setNewPipeline] = useState(false);
  const [pipelineDestinationId, setPipelineDestinationId] = useState("");
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
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null);

  useEffect(() => { if (requestedVenture) queueMicrotask(() => setActiveVentureId(requestedVenture)); }, [requestedVenture, setActiveVentureId]);
  useEffect(() => { queueMicrotask(() => { setSelectedOpportunity(null); setNewPipeline(false); setPipelineDestinationId(""); setNewOpportunity(false); setPipelineId(""); }); }, [ventureId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      Promise.all([loadLiveSession(), listLivePipelines(), listLiveOpportunities()]).then(([nextSession, nextPipelines, nextOpportunities]) => {
        if (!active) return;
        setSession(nextSession); setPipelines(nextPipelines); setOpportunities(nextOpportunities);
        setBusy(false); setError("");
      }).catch((cause: unknown) => { if (active) { setBusy(false); setError(cause instanceof Error ? cause.message : "Could not load sales records."); } });
    });
    return () => { active = false; };
  }, [revision]);

  const selectedPipelines = pipelines.filter((item) => !ventureId || item.ventureId === ventureId);
  const visible = opportunities.filter((item) => selectedPipelines.some((pipeline) => pipeline.id === item.pipelineId));
  const canManage = !!ventureId && (session?.membership.role === "admin" || (session?.membership.role === "venture_head" && session.membership.ventureIds.includes(ventureId)));
  const manageableVentures = session?.hierarchy.ventures.filter((venture) => session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.includes(venture.id))) ?? [];
  const canCreatePipeline = ventureId ? canManage : manageableVentures.length > 0;
  const destinationId = ventureId || pipelineDestinationId;
  const ventureName = (id: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? id;
  const stageColumns = ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"] as const;
  const columnForStage = (stage: Opportunity["stage"]) => stage === "identified" || stage === "contacted" ? "New" : stage === "conversation" ? "Negotiation" : stage[0].toUpperCase() + stage.slice(1);

  async function createPipeline(event: React.FormEvent) {
    event.preventDefault();
    if (!manageableVentures.some((venture) => venture.id === destinationId)) { setError("Choose an available venture for this pipeline."); return; }
    setBusy(true); setError("");
    try {
      const created = await createLivePipeline({ ventureId: destinationId, name: pipelineName, offerName, status: "active" });
      if (created.ventureId !== destinationId) throw new Error("The pipeline was created outside the selected venture.");
      setNewPipeline(false); setPipelineDestinationId(""); setPipelineName(""); setOfferName(""); setRevision((value) => value + 1);
    }
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
    try { const updated = await updateLiveOpportunity(item.id, { stage }); setOpportunities((items) => items.map((entry) => entry.id === item.id ? updated : entry)); setSelectedOpportunity(updated); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the stage."); }
    finally { setBusy(false); }
  }

  async function changePipelineStatus(item: Pipeline, status: Pipeline["status"]) {
    setBusy(true); setError("");
    try { const updated = await updateLivePipeline(item.id, { status }); setPipelines((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the pipeline."); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle title="Sales pipeline" description="Each venture keeps its own offers, leads, actions, evidence, and results." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>{canCreatePipeline && <button type="button" onClick={() => { setPipelineDestinationId(""); setNewPipeline(true); }} className={secondaryClass}><Plus size={15} />New pipeline</button>}<button type="button" disabled={selectedPipelines.length === 0} onClick={() => { setPipelineId(selectedPipelines[0]?.id ?? ""); setNewOpportunity(true); }} className={primaryClass}><Plus size={15} />Add record</button></div>} />
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {selectedPipelines.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-neutral-500">{selectedPipelines.map((pipeline) => <div key={pipeline.id} className="flex items-center gap-2 rounded-xl border border-neutral-100 bg-white px-3 py-2"><span className="font-semibold text-neutral-700">{pipeline.name}</span><Badge>{pipeline.status}</Badge>{canManage && <Select aria-label={`Status for ${pipeline.name}`} disabled={busy} className="!min-h-8 !w-28 !rounded-lg !px-2 !text-xs" value={pipeline.status} onChange={(event) => changePipelineStatus(pipeline, event.target.value as Pipeline["status"])}><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></Select>}</div>)}</div>}
    {busy && !session ? <Panel className="p-8 text-sm text-neutral-500">Loading sales records…</Panel> : selectedPipelines.length === 0 ? <Panel><Empty title="No pipeline for this venture" body="Create a pipeline to organize its opportunities." /></Panel> : <div className="grid gap-3 lg:grid-cols-3 2xl:grid-cols-6">{stageColumns.map((stage) => <Panel key={stage} className="min-h-48 p-3"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-neutral-800">{stage}</h2><Badge>{visible.filter((item) => columnForStage(item.stage) === stage).length}</Badge></div>{visible.filter((item) => columnForStage(item.stage) === stage).map((item) => <button type="button" key={item.id} onClick={() => setSelectedOpportunity(item)} className="mb-2 w-full rounded-xl bg-neutral-50 p-3 text-left transition-colors hover:bg-neutral-100"><p className="text-sm font-semibold text-neutral-800">{item.companyName}</p><p className="mt-1 text-xs text-neutral-500">{item.observedSignal || pipelines.find((pipeline) => pipeline.id === item.pipelineId)?.offerName}</p><p className="mt-2 text-xs text-neutral-500">Next: {item.nextAction || "Not scheduled"} · {stamp(item.nextActionAt)}</p><p className="mt-1 text-xs text-neutral-400">{session?.user.id === item.ownerId ? session.user.name : "Team member"}</p></button>)}</Panel>)}</div>}
    {selectedOpportunity && <DetailDrawer title={selectedOpportunity.companyName} subtitle={`${ventureName(selectedOpportunity.ventureId)} · ${pipelines.find((pipeline) => pipeline.id === selectedOpportunity.pipelineId)?.name ?? "Pipeline"}`} onClose={() => setSelectedOpportunity(null)}><div className="space-y-4 text-sm text-neutral-600"><p><strong className="text-neutral-800">Observed signal:</strong> {selectedOpportunity.observedSignal || "Not recorded"}</p><p><strong className="text-neutral-800">Fit:</strong> {selectedOpportunity.fitReason || "Not recorded"}</p><p><strong className="text-neutral-800">Next:</strong> {selectedOpportunity.nextAction || "Not scheduled"} · {stamp(selectedOpportunity.nextActionAt)}</p><p><strong className="text-neutral-800">Evidence confidence:</strong> {selectedOpportunity.evidenceConfidence}</p>{(canManage || selectedOpportunity.ownerId === session?.user.id) && <Field label="Stage"><Select aria-label={`Stage for ${selectedOpportunity.companyName}`} disabled={busy} className={inputClass} value={selectedOpportunity.stage} onChange={(event) => changeStage(selectedOpportunity, event.target.value as Opportunity["stage"])}>{stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}</Select></Field>}</div></DetailDrawer>}
    {newPipeline && <DetailDrawer title="Create pipeline" onClose={() => setNewPipeline(false)}><form onSubmit={createPipeline} className="space-y-4">{ventureId ? <div aria-label="Pipeline destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Destination venture · fixed to current venture</span><span className="mt-1 block text-sm font-bold text-neutral-800">{ventureName(ventureId)}</span></div> : <Field label="Destination venture"><Select required className={inputClass} value={pipelineDestinationId} onChange={(event) => { setPipelineDestinationId(event.target.value); setError(""); }}><option value="">Choose a venture</option>{manageableVentures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}<Field label="Pipeline name"><input required maxLength={120} className={inputClass} value={pipelineName} onChange={(event) => setPipelineName(event.target.value)} /></Field><Field label="Offer"><input required maxLength={200} className={inputClass} value={offerName} onChange={(event) => setOfferName(event.target.value)} /></Field>{error && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}<button disabled={busy || !destinationId} className={primaryClass}>{busy ? "Creating…" : "Create pipeline"}</button></form></DetailDrawer>}
    {newOpportunity && <DetailDrawer title="Create opportunity" onClose={() => setNewOpportunity(false)}><form onSubmit={createOpportunity} className="space-y-4"><Field label="Pipeline"><Select required className={inputClass} value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>{selectedPipelines.map((item) => <option key={item.id} value={item.id}>{ventureName(item.ventureId)} · {item.name}</option>)}</Select></Field><Field label="Company"><input required maxLength={200} className={inputClass} value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></Field><Field label="Contact"><input maxLength={200} className={inputClass} value={contactName} onChange={(event) => setContactName(event.target.value)} /></Field><Field label="Source"><input maxLength={500} className={inputClass} value={source} onChange={(event) => setSource(event.target.value)} /></Field><Field label="Observed signal"><textarea maxLength={2000} className={`${inputClass} min-h-24 py-3`} value={signal} onChange={(event) => setSignal(event.target.value)} /></Field><Field label="Fit reason"><textarea maxLength={2000} className={`${inputClass} min-h-24 py-3`} value={fitReason} onChange={(event) => setFitReason(event.target.value)} /></Field><Field label="Evidence confidence"><Select className={inputClass} value={confidence} onChange={(event) => setConfidence(event.target.value as typeof confidence)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select></Field><Field label="Next action"><input maxLength={1000} className={inputClass} value={nextAction} onChange={(event) => setNextAction(event.target.value)} /></Field><Field label="Next action date"><input type="datetime-local" className={inputClass} value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} /></Field><p className="text-xs text-neutral-500">You will own this opportunity. It starts at the identified stage.</p><button disabled={busy} className={primaryClass}>Create opportunity</button></form></DetailDrawer>}
  </PageFrame>;
}
