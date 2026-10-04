"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "@/components/ui/icons";
import clsx from "clsx";
import { useBoardMotion } from "@/components/ui/use-board-motion";
import { toast } from "@/components/ui/toast";
import { flashById } from "@/lib/motion";
import { createLiveOpportunity, createLivePipeline, listLiveOpportunities, listLivePipelines, loadLiveSession, updateLiveOpportunity, updateLivePipeline } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, Notice, PageFrame, PageTitle, Panel, primaryClass, RefreshButton, secondaryClass } from "@/components/studio/primitives";

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
      }).catch((cause: unknown) => { if (active) { setBusy(false); setError(describeError(cause, "Could not load sales records.")); } });
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
  const stageColumns = stages;
  const columnForStage = (stage: Opportunity["stage"]) => stage;

  async function createPipeline(event: React.FormEvent) {
    event.preventDefault();
    if (!manageableVentures.some((venture) => venture.id === destinationId)) { setError("Choose an available venture for this pipeline."); return; }
    setBusy(true); setError("");
    try {
      const created = await createLivePipeline({ ventureId: destinationId, name: pipelineName, offerName, status: "active" });
      if (created.ventureId !== destinationId) throw new Error("The pipeline was created outside the selected venture.");
      setNewPipeline(false); setPipelineDestinationId(""); setPipelineName(""); setOfferName(""); setRevision((value) => value + 1);
    }
    catch (cause) { setError(describeError(cause, "Could not create the pipeline.")); }
    finally { setBusy(false); }
  }

  async function createOpportunity(event: React.FormEvent) {
    event.preventDefault();
    if (!session) return;
    setBusy(true); setError("");
    try {
      const created = await createLiveOpportunity({ pipelineId, companyName, contactName, source, observedSignal: signal, fitReason, evidenceConfidence: confidence, stage: "identified", ownerId: session.user.id, nextAction, ...(nextActionAt ? { nextActionAt: new Date(nextActionAt).toISOString() } : {}) });
      toast({ title: "Opportunity added", body: created.companyName });
      flashById(created.id);
      setNewOpportunity(false); setCompanyName(""); setContactName(""); setSource(""); setSignal(""); setFitReason(""); setNextAction(""); setNextActionAt(""); setRevision((value) => value + 1);
    } catch (cause) { setError(describeError(cause, "Could not create the opportunity.")); }
    finally { setBusy(false); }
  }

  const canMoveOpportunity = (item: Opportunity) => !!session && (session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.includes(item.ventureId)) || item.ownerId === session.user.id);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const { rootRef: boardRef, capture, cardProps, columnProps, draggingId, overColumn } = useBoardMotion<Opportunity["stage"]>((id, stage) => {
    const item = opportunities.find((entry) => entry.id === id);
    if (!item || item.stage === stage || pendingIds.has(id) || !canMoveOpportunity(item)) return false;
    changeStage(item, stage);
    return true;
  });

  /** Moves the card at once and saves in the background; a failed save glides it back. Callers run capture() first. */
  function changeStage(item: Opportunity, stage: Opportunity["stage"], announce = false) {
    setError("");
    const moved = { ...item, stage };
    setOpportunities((items) => items.map((entry) => entry.id === item.id ? moved : entry));
    setSelectedOpportunity((current) => current?.id === item.id ? moved : current);
    setPendingIds((current) => new Set(current).add(item.id));
    updateLiveOpportunity(item.id, { stage })
      .then((updated) => {
        setOpportunities((items) => items.map((entry) => entry.id === item.id ? updated : entry));
        setSelectedOpportunity((current) => current?.id === item.id ? updated : current);
        if (announce) toast({ title: `Moved to ${stage}`, body: item.companyName });
      })
      .catch((cause: unknown) => {
        capture();
        setOpportunities((items) => items.map((entry) => entry.id === item.id ? item : entry));
        setSelectedOpportunity((current) => current?.id === item.id ? item : current);
        toast({ tone: "error", title: "Could not change the stage", body: describeError(cause, "The change was not saved.") });
      })
      .finally(() => setPendingIds((current) => { const next = new Set(current); next.delete(item.id); return next; }));
  }

  async function changePipelineStatus(item: Pipeline, status: Pipeline["status"]) {
    setBusy(true); setError("");
    try { const updated = await updateLivePipeline(item.id, { status }); setPipelines((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(describeError(cause, "Could not update the pipeline.")); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle title="Sales pipeline" description="Each venture keeps its own offers, leads, actions, evidence, and results." action={<div className="flex flex-wrap gap-2"><RefreshButton busy={busy && !!session} onClick={() => setRevision((value) => value + 1)} />{canCreatePipeline && <button type="button" onClick={() => { setPipelineDestinationId(""); setNewPipeline(true); }} className={secondaryClass}><Plus size={15} />New pipeline</button>}<button type="button" disabled={selectedPipelines.length === 0} onClick={() => { setPipelineId(selectedPipelines[0]?.id ?? ""); setNewOpportunity(true); }} className={primaryClass}><Plus size={15} />Add record</button></div>} />
    <Notice tone="error" message={!newPipeline && !newOpportunity && !selectedOpportunity ? error : ""} onDismiss={() => setError("")} className="pb-4" />
    {selectedPipelines.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-neutral-500">{selectedPipelines.map((pipeline) => <div key={pipeline.id} className="flex items-center gap-2 rounded-xl border border-neutral-100 bg-white px-3 py-2"><span className="font-semibold text-neutral-700">{pipeline.name}</span><Badge>{pipeline.status}</Badge>{canManage && <Select aria-label={`Status for ${pipeline.name}`} disabled={busy} className="!min-h-8 !w-28 !rounded-lg !px-2 !text-xs" value={pipeline.status} onChange={(event) => changePipelineStatus(pipeline, event.target.value as Pipeline["status"])}><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></Select>}</div>)}</div>}
    {!session ? <div role="status" aria-label="Loading sales records" className="grid gap-3 lg:grid-cols-4 2xl:grid-cols-7">{stages.map((stage) => <Panel key={stage} className="min-h-48 space-y-2 p-3"><span className="vso-skeleton mb-3 h-4 w-20" /><span className="vso-skeleton h-20 rounded-xl" /></Panel>)}</div> : selectedPipelines.length === 0 ? <Panel><Empty title="No pipeline for this venture" body="Create a pipeline to organize its opportunities." /></Panel> : <div ref={boardRef} className="vso-fade-enter grid gap-3 lg:grid-cols-4 2xl:grid-cols-7">{stageColumns.map((stage) => { const cards = visible.filter((item) => columnForStage(item.stage) === stage); const over = overColumn === stage && !!draggingId && !cards.some((item) => item.id === draggingId); return <div key={stage} className="min-w-0" {...columnProps(stage)}><Panel className={clsx("min-h-48 min-w-0 p-3 transition-[border-color,box-shadow] duration-150", over && "border-primary-500 ring-2 ring-primary-300")}><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold capitalize text-neutral-800">{stage}</h2><Badge><span key={cards.length} className="vso-label-swap tnum">{cards.length}</span></Badge></div>{cards.map((item) => { const movable = canMoveOpportunity(item) && !pendingIds.has(item.id); return <article key={item.id} {...cardProps(item.id, movable)} data-flash-id={item.id} role="button" tabIndex={0} aria-label={`Open ${item.companyName}`} aria-busy={pendingIds.has(item.id) || undefined} onClick={() => setSelectedOpportunity(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedOpportunity(item); } }} className={clsx("relative mb-2 w-full rounded-xl border border-transparent bg-neutral-50 p-3 text-left transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]", movable && "cursor-grab", draggingId === item.id && "border-dashed !border-primary-300 opacity-40")}><p className="text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere]">{item.companyName}</p><p className="mt-1 text-xs text-neutral-500">{item.observedSignal || pipelines.find((pipeline) => pipeline.id === item.pipelineId)?.offerName}</p><p className="mt-2 text-xs text-neutral-500">Next: {item.nextAction || "Not scheduled"} · {stamp(item.nextActionAt)}</p><p className="mt-1 text-xs text-neutral-400">{session?.user.id === item.ownerId ? session.user.name : "Team member"}</p></article>; })}{over && <div aria-hidden="true" className="vso-fade-enter grid min-h-14 place-items-center rounded-xl border-2 border-dashed border-primary-300 bg-primary-50 text-xs font-semibold text-primary-700">Drop here</div>}{!cards.length && !over && <p className="rounded-xl border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400">Nothing here yet</p>}</Panel></div>; })}</div>}
    {selectedOpportunity && <DetailDrawer title={selectedOpportunity.companyName} subtitle={`${ventureName(selectedOpportunity.ventureId)} · ${pipelines.find((pipeline) => pipeline.id === selectedOpportunity.pipelineId)?.name ?? "Pipeline"}`} onClose={() => { setSelectedOpportunity(null); setError(""); }}><div className="space-y-4 text-sm text-neutral-600"><Notice tone="error" message={error} onDismiss={() => setError("")} /><p><strong className="text-neutral-800">Contact:</strong> {selectedOpportunity.contactName || "Not recorded"}{selectedOpportunity.source ? ` · Source: ${selectedOpportunity.source}` : ""}</p><p><strong className="text-neutral-800">Observed signal:</strong> {selectedOpportunity.observedSignal || "Not recorded"}</p><p><strong className="text-neutral-800">Fit:</strong> {selectedOpportunity.fitReason || "Not recorded"}</p><p><strong className="text-neutral-800">Next:</strong> {selectedOpportunity.nextAction || "Not scheduled"} · {stamp(selectedOpportunity.nextActionAt)}</p><p><strong className="text-neutral-800">Evidence confidence:</strong> {selectedOpportunity.evidenceConfidence}</p>{(canManage || selectedOpportunity.ownerId === session?.user.id) && <Field label="Stage"><Select aria-label={`Stage for ${selectedOpportunity.companyName}`} disabled={pendingIds.has(selectedOpportunity.id)} className={inputClass} value={selectedOpportunity.stage} onChange={(event) => { capture(); changeStage(selectedOpportunity, event.target.value as Opportunity["stage"], true); }}>{stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}</Select></Field>}</div></DetailDrawer>}
    {newPipeline && <DetailDrawer title="Create pipeline" onClose={() => { setNewPipeline(false); setError(""); }}><form onSubmit={createPipeline} className="space-y-4">{ventureId ? <div aria-label="Pipeline destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Destination venture · fixed to current venture</span><span className="mt-1 block text-sm font-bold text-neutral-800">{ventureName(ventureId)}</span></div> : <Field label="Destination venture"><Select required className={inputClass} value={pipelineDestinationId} onChange={(event) => { setPipelineDestinationId(event.target.value); setError(""); }}><option value="">Choose a venture</option>{manageableVentures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}<Field label="Pipeline name"><input required maxLength={120} className={inputClass} value={pipelineName} onChange={(event) => setPipelineName(event.target.value)} /></Field><Field label="Offer"><input required maxLength={200} className={inputClass} value={offerName} onChange={(event) => setOfferName(event.target.value)} /></Field><Notice tone="error" message={error} onDismiss={() => setError("")} /><button disabled={busy || !destinationId} className={primaryClass}>{busy ? "Creating…" : "Create pipeline"}</button></form></DetailDrawer>}
    {newOpportunity && <DetailDrawer title="Create opportunity" onClose={() => { setNewOpportunity(false); setError(""); }}><form onSubmit={createOpportunity} className="space-y-4"><Field label="Pipeline"><Select required className={inputClass} value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>{selectedPipelines.map((item) => <option key={item.id} value={item.id}>{ventureName(item.ventureId)} · {item.name}</option>)}</Select></Field><Field label="Company"><input required maxLength={200} className={inputClass} value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></Field><Field label="Contact"><input maxLength={200} className={inputClass} value={contactName} onChange={(event) => setContactName(event.target.value)} /></Field><Field label="Source"><input maxLength={500} className={inputClass} value={source} onChange={(event) => setSource(event.target.value)} /></Field><Field label="Observed signal"><textarea maxLength={2000} className={`${inputClass} min-h-24 py-3`} value={signal} onChange={(event) => setSignal(event.target.value)} /></Field><Field label="Fit reason"><textarea maxLength={2000} className={`${inputClass} min-h-24 py-3`} value={fitReason} onChange={(event) => setFitReason(event.target.value)} /></Field><Field label="Evidence confidence"><Select className={inputClass} value={confidence} onChange={(event) => setConfidence(event.target.value as typeof confidence)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select></Field><Field label="Next action"><input maxLength={1000} className={inputClass} value={nextAction} onChange={(event) => setNextAction(event.target.value)} /></Field><Field label="Next action date"><input type="datetime-local" className={inputClass} value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} /></Field><p className="text-xs text-neutral-500">You will own this opportunity. It starts at the identified stage.</p><Notice tone="error" message={error} onDismiss={() => setError("")} /><button disabled={busy} className={primaryClass}>Create opportunity</button></form></DetailDrawer>}
  </PageFrame>;
}
