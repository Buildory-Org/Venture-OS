"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { CalendarDays, Plus, RefreshCw, Search } from "@/components/ui/icons";
import { listLiveClasses, listLiveDecisions, listLiveInformationRequests, listLiveMembers, listLiveOutcomes, loadLiveSession, updateLiveClass, updateLiveDecision, updateLiveInformationRequest, updateLiveOutcome } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { LiveClassApplications } from "@/components/studio/live-class-applications";
import { PlanningCreateDrawer, type PlanningCreateKind } from "@/components/studio/planning-create-drawer";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Outcome = Awaited<ReturnType<typeof listLiveOutcomes>>[number];
type Decision = Awaited<ReturnType<typeof listLiveDecisions>>[number];
type Class = Awaited<ReturnType<typeof listLiveClasses>>[number];
type Request = Awaited<ReturnType<typeof listLiveInformationRequests>>[number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

export function LivePlanningScreen({ view = null }: { view?: "decisions" | "classes" | "timeline" | "requests" | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [ventureId, setVentureId] = useState("");
  const [selected, setSelected] = useState<Request | null>(null);
  const [selectedClass, setSelectedClass] = useState<Class | null>(null);
  const [activeClass, setActiveClass] = useState<Class | null>(null);
  const [selectedDecision, setSelectedDecision] = useState<Decision | null>(null);
  const [decisionQuery, setDecisionQuery] = useState("");
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [requestQuery, setRequestQuery] = useState("");
  const [response, setResponse] = useState("");
  const [sources, setSources] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [createKind, setCreateKind] = useState<PlanningCreateKind | null>(null);
  const [result, setResult] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      Promise.all([loadLiveSession(), listLiveOutcomes(), listLiveDecisions(), listLiveClasses(), listLiveInformationRequests(), listLiveMembers({ limit: 100 }).catch(() => null)]).then(([nextSession, nextOutcomes, nextDecisions, nextClasses, nextRequests, nextMembers]) => {
        if (!active) return;
        setSession(nextSession); setOutcomes(nextOutcomes); setDecisions(nextDecisions); setClasses(nextClasses); setRequests(nextRequests); setMemberNames(Object.fromEntries(nextMembers?.items.map((item) => [item.id, item.name]) ?? [])); setError(""); setBusy(false);
      }).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load planning records."); setBusy(false); } });
    });
    return () => { active = false; };
  }, [revision]);

  const visibleOutcomes = outcomes.filter((item) => !ventureId || item.ventureId === ventureId);
  const visibleDecisions = decisions.filter((item) => !ventureId || item.ventureId === ventureId);
  const decisionRows = visibleDecisions.filter((item) => `${item.title} ${item.reason} ${item.text}`.toLowerCase().includes(decisionQuery.trim().toLowerCase()));
  const visibleClasses = classes.filter((item) => !ventureId || item.ventureId === ventureId);
  const visibleRequests = requests.filter((item) => !ventureId || item.ventureId === ventureId);
  const requestRows = visibleRequests.filter((item) => `${item.question} ${item.purpose} ${item.responseMarkdown ?? ""}`.toLowerCase().includes(requestQuery.trim().toLowerCase()));
  const activeRequest = requestRows.find((item) => item.id === selectedRequestId) ?? null;
  const ventureName = (id?: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? "Workspace";
  const canManage = (id?: string) => session?.membership.role === "admin" || (session?.membership.role === "venture_head" && !!id && session.membership.ventureIds.includes(id));
  const canRequest = !!ventureId && !!session && (session.membership.role === "admin" || session.membership.ventureIds.includes(ventureId));
  const canCreatePlanning = !!session && (session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.length > 0));
  const canCreateRequest = !!session && (session.membership.role === "admin" || session.membership.ventureIds.length > 0);
  const createButton = (kind: PlanningCreateKind) => <button type="button" onClick={() => { setCreateKind(kind); setResult(""); }} className={`${secondaryClass} !min-h-8 !rounded-lg !px-2 !text-xs`} aria-label={`Create ${kind === "request" ? "information request" : kind}`}><Plus size={13} />Create</button>;
  const timeline = [
    ...visibleOutcomes.map((item) => ({ id: item.id, at: item.reviewAt, type: "Outcome review", title: item.title, ventureId: item.ventureId })),
    ...visibleClasses.map((item) => ({ id: item.id, at: item.scheduledAt, type: "Class", title: item.title, ventureId: item.ventureId })),
    ...visibleRequests.filter((item) => item.status === "open").map((item) => ({ id: item.id, at: item.dueAt, type: "Request due", title: item.question, ventureId: item.ventureId })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  async function answer(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await updateLiveInformationRequest(selected.id, { status: "answered", responseMarkdown: response, sourceRefs: sources.split("\n").map((item) => item.trim()).filter(Boolean) });
      setSelected(null); setRevision((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not answer the request."); }
    finally { setBusy(false); }
  }

  async function changeOutcome(item: Outcome, status: Outcome["status"]) {
    setBusy(true); setError("");
    try { const updated = await updateLiveOutcome(item.id, { status }); setOutcomes((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the outcome."); }
    finally { setBusy(false); }
  }

  async function changeDecision(item: Decision, status: Decision["status"]) {
    setBusy(true); setError("");
    try { const updated = await updateLiveDecision(item.id, { status }); setDecisions((items) => items.map((entry) => entry.id === item.id ? updated : entry)); setSelectedDecision(updated); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the decision."); }
    finally { setBusy(false); }
  }

  async function changeClass(item: Class, status: Class["status"]) {
    setBusy(true); setError("");
    try { const updated = await updateLiveClass(item.id, { status }); setClasses((items) => items.map((entry) => entry.id === item.id ? updated : entry)); setActiveClass(updated); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the class."); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle title={view === "decisions" ? "Decisions" : view === "classes" ? "Classes" : view === "timeline" ? "30-day timeline" : view === "requests" ? "Questions & requests" : "Outcomes & operating records"} description={view === "decisions" ? "What was approved, why, which evidence supported it, and when to review it." : view === "classes" ? "Lessons connect to practice, live assignments, and assessment evidence." : view === "timeline" ? "Outcomes, reviews, and work that contribute to the plan." : view === "requests" ? "Assign missing information with sources and unresolved points." : "Track 30-day commitments, decisions, classes, requests, and reviews."} action={<div className="flex flex-wrap gap-2">{((view === "decisions" || view === "classes") && canCreatePlanning || view === "requests" && canCreateRequest) && <button type="button" onClick={() => setCreateKind(view === "decisions" ? "decision" : view === "classes" ? "class" : "request")} className={primaryClass}><Plus size={15} />{view === "decisions" ? "Record decision" : view === "classes" ? "Schedule class" : "New request"}</button>}<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button></div>} />
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm font-semibold text-success-text">{result}</p>}
    <Panel className="mb-4 p-4"><label className="block max-w-sm"><span className="mb-1 block text-xs font-semibold text-neutral-500">Venture</span><Select className={inputClass} value={ventureId} onChange={(event) => { setVentureId(event.target.value); setSelectedDecision(null); setActiveClass(null); setSelectedRequestId(""); }}><option value="">All authorized ventures</option>{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label></Panel>
    {view === "decisions" && <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]">
      <Panel>
        <div className="border-b border-neutral-100 p-4"><label className="relative block"><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input aria-label="Search decisions" value={decisionQuery} onChange={(event) => setDecisionQuery(event.target.value)} placeholder="Search decisions" className={`${inputClass} pl-9`} /></label></div>
        {decisionRows.map((item) => <button type="button" key={item.id} onClick={() => setSelectedDecision(item)} className="flex w-full flex-wrap items-start justify-between gap-3 border-b border-neutral-100 p-5 text-left hover:bg-neutral-50"><div><p className="text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 text-xs text-neutral-500">{ventureName(item.ventureId)} · {stamp(item.decidedAt)}</p></div><Badge tone={item.status === "approved" ? "green" : "amber"}>{item.status}</Badge></button>)}
        {decisionRows.length === 0 && <Empty title="No decisions found" body="Choose another venture or try another search." />}
      </Panel>
      <Panel>{selectedDecision ? <><PanelHead title={selectedDecision.title} /><dl className="space-y-4 p-5 text-sm">{([["Status", selectedDecision.status], ["Decision", selectedDecision.text], ["Reason", selectedDecision.reason], ["Evidence", selectedDecision.evidence.join(", ")], ["Affected work", selectedDecision.affectedWork.join(", ")], ["Review trigger", selectedDecision.reviewTrigger]] as const).map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase text-neutral-400">{label}</dt><dd className="mt-1 leading-6 text-neutral-700">{value || "Not recorded"}</dd></div>)}{canManage(selectedDecision.ventureId) && <div><dt className="text-xs font-semibold uppercase text-neutral-400">Change status</dt><dd className="mt-2"><Select aria-label={`Status for decision ${selectedDecision.title}`} disabled={busy} value={selectedDecision.status} onChange={(event) => changeDecision(selectedDecision, event.target.value as Decision["status"])} className={inputClass}><option value="draft">Draft</option><option value="approved">Approved</option><option value="superseded">Superseded</option><option value="stale">Stale</option></Select></dd></div>}</dl></> : <Empty title="Select a decision" body="The approval reason and review trigger appear here." />}</Panel>
    </div>}
    {view === "classes" && <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]">
      <Panel><PanelHead title="Schedule" aside={<CalendarDays size={16} className="text-neutral-400" />} />{visibleClasses.length ? [...visibleClasses].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map((item) => <button type="button" key={item.id} onClick={() => setActiveClass(item)} className="flex w-full items-start gap-3 border-b border-neutral-100 p-5 text-left hover:bg-neutral-50"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-50 font-mono text-sm font-semibold text-primary-700">{new Date(item.scheduledAt).getDate()}</span><span className="min-w-0"><span className="block text-sm font-semibold text-neutral-800">{item.title}</span><span className="mt-1 block text-xs text-neutral-500">{ventureName(item.ventureId)} · {new Date(item.scheduledAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</span><span className="mt-2 block text-sm text-neutral-600">{item.objective}</span></span></button>) : <Empty title="No classes" body="No classes are available in this scope." />}</Panel>
      <Panel>{activeClass ? <><PanelHead title={activeClass.title} aside={<Badge tone="blue">{activeClass.status}</Badge>} /><div className="space-y-4 p-5 text-sm"><p className="leading-6 text-neutral-700">{activeClass.objective}</p><dl className="space-y-3">{([["Scheduled", new Date(activeClass.scheduledAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })], ["Duration", `${activeClass.durationMinutes} minutes`], ["Participants", String(activeClass.participantIds.length)], ["Material", activeClass.materialDocumentId ? "Linked knowledge document" : "Not recorded"]] as const).map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase text-neutral-400">{label}</dt><dd className="mt-1 text-neutral-700">{value}</dd></div>)}</dl>{canManage(activeClass.ventureId) && <Select aria-label={`Status for class ${activeClass.title}`} disabled={busy} value={activeClass.status} onChange={(event) => { void changeClass(activeClass, event.target.value as Class["status"]); }} className={inputClass}><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></Select>}<button type="button" onClick={() => setSelectedClass(activeClass)} className={secondaryClass}>Applications & assessments</button></div></> : <Empty title="Select a class" body="Open a class to view its schedule, participants, and applied-work assessments." />}</Panel>
    </div>}
    {view === "requests" && <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]">
      <Panel>
        <div className="border-b border-neutral-100 p-4"><label className="relative block"><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input aria-label="Search requests" value={requestQuery} onChange={(event) => setRequestQuery(event.target.value)} placeholder="Search requests" className={`${inputClass} pl-9`} /></label></div>
        {requestRows.map((item) => <button type="button" key={item.id} onClick={() => setSelectedRequestId(item.id)} aria-current={item.id === selectedRequestId ? "true" : undefined} className="flex w-full flex-wrap items-start justify-between gap-3 border-b border-neutral-100 p-5 text-left transition-colors hover:bg-neutral-50 aria-[current=true]:bg-primary-50"><span className="min-w-0"><span className="block text-sm font-semibold text-neutral-800">{item.question}</span><span className="mt-1 block text-xs text-neutral-500">{ventureName(item.ventureId)} · {memberNames[item.requesterId] ?? "Requester"} → {memberNames[item.respondentId] ?? "Respondent"} · Due {stamp(item.dueAt)}</span><span className="mt-2 block line-clamp-2 text-sm text-neutral-600">{item.responseMarkdown || item.purpose}</span></span><Badge tone={item.status === "open" ? "amber" : "green"}>{item.status}</Badge></button>)}
        {requestRows.length === 0 && <Empty title="No requests found" body="Choose another venture or try another search." />}
      </Panel>
      <Panel>{activeRequest ? <><PanelHead title={activeRequest.question} aside={<Badge tone={activeRequest.status === "open" ? "amber" : "green"}>{activeRequest.status}</Badge>} /><dl className="space-y-4 p-5 text-sm">{([["Venture", ventureName(activeRequest.ventureId)], ["Requester", memberNames[activeRequest.requesterId] ?? "Requester"], ["Respondent", memberNames[activeRequest.respondentId] ?? "Respondent"], ["Due", stamp(activeRequest.dueAt)], ["Purpose", activeRequest.purpose], ["Answer", activeRequest.responseMarkdown || "Answer pending"], ["Sources", activeRequest.sourceRefs.join(", ") || "Not recorded"]] as const).map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase text-neutral-400">{label}</dt><dd className="mt-1 whitespace-pre-wrap leading-6 text-neutral-700">{value}</dd></div>)}{activeRequest.respondentId === session?.user.id && activeRequest.status === "open" && <button type="button" onClick={() => { setSelected(activeRequest); setResponse(""); setSources(""); }} className={primaryClass}>Answer request</button>}</dl></> : <Empty title="Select a request" body="The question, answer, and sources appear here." />}</Panel>
    </div>}
    {busy && !session ? <Panel className="p-8 text-sm text-neutral-500">Loading operating records…</Panel> : <div className={view ? "grid gap-4" : "grid gap-4 xl:grid-cols-2"}>
      {(!view) && (<Panel><PanelHead title="30-day outcomes" aside={<div className="flex items-center gap-2"><Badge tone="blue">{visibleOutcomes.length}</Badge>{ventureId && canManage(ventureId) && createButton("outcome")}</div>} /><div className="divide-y divide-neutral-100">{visibleOutcomes.length ? visibleOutcomes.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.title}</h2><Badge tone={item.status === "at_risk" ? "amber" : "green"}>{item.status.replaceAll("_", " ")}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.description}</p><p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · Review {stamp(item.reviewAt)} · {item.priority} priority</p><p className="mt-2 text-xs text-neutral-500">Success evidence: {item.successEvidence}</p>{item.risk && <p className="mt-1 text-xs text-danger-text">Risk: {item.risk}</p>}{canManage(item.ventureId) && <Select aria-label={`Status for outcome ${item.title}`} disabled={busy} value={item.status} onChange={(event) => changeOutcome(item, event.target.value as Outcome["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="draft">Draft</option><option value="approved">Approved</option><option value="active">Active</option><option value="at_risk">At risk</option><option value="achieved">Achieved</option><option value="cancelled">Cancelled</option></Select>}</article>) : <Empty title="No outcomes" body="No outcomes are available in this scope." />}</div></Panel>)}
      {(!view || view === "timeline") && (<Panel><PanelHead title="Milestone timeline" aside={<CalendarDays size={16} className="text-neutral-400" />} /><div className="divide-y divide-neutral-100">{timeline.length ? timeline.map((item) => <div key={`${item.type}-${item.id}`} className="flex gap-3 p-4"><span className="w-24 shrink-0 text-xs font-semibold text-neutral-500">{stamp(item.at)}</span><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{item.type}</p><p className="mt-1 text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 text-xs text-neutral-400">{ventureName(item.ventureId)}</p></div></div>) : <Empty title="No milestones" body="Nothing is scheduled in this scope." />}</div></Panel>)}
      {!view && (<Panel><PanelHead title="Decision log" aside={<div className="flex items-center gap-2"><Badge>{visibleDecisions.length}</Badge>{ventureId && canManage(ventureId) && createButton("decision")}</div>} /><div className="divide-y divide-neutral-100">{visibleDecisions.length ? visibleDecisions.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.title}</h2><Badge tone={item.status === "approved" ? "green" : "amber"}>{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.text}</p><p className="mt-2 text-xs text-neutral-500">Reason: {item.reason}</p><p className="mt-1 text-xs text-neutral-400">{ventureName(item.ventureId)} · Decided {stamp(item.decidedAt)} · {item.evidence.length} evidence references</p>{canManage(item.ventureId) && <Select aria-label={`Status for decision ${item.title}`} disabled={busy} value={item.status} onChange={(event) => changeDecision(item, event.target.value as Decision["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="draft">Draft</option><option value="approved">Approved</option><option value="superseded">Superseded</option><option value="stale">Stale</option></Select>}</article>) : <Empty title="No decisions" body="No decisions are available in this scope." />}</div></Panel>)}
      {!view && (<Panel><PanelHead title="Classes" aside={<div className="flex items-center gap-2"><Badge>{visibleClasses.length}</Badge>{ventureId && canManage(ventureId) && createButton("class")}</div>} /><div className="divide-y divide-neutral-100">{visibleClasses.length ? visibleClasses.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.title}</h2><Badge tone="blue">{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.objective}</p><p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · {stamp(item.scheduledAt)} · {item.durationMinutes} min · {item.participantIds.length} participant{item.participantIds.length === 1 ? "" : "s"}</p>{canManage(item.ventureId) && <Select aria-label={`Status for class ${item.title}`} disabled={busy} value={item.status} onChange={(event) => changeClass(item, event.target.value as Class["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></Select>}<button type="button" onClick={() => setSelectedClass(item)} className={`${secondaryClass} mt-3`}>Applications & assessments</button></article>) : <Empty title="No classes" body="No classes are available in this scope." />}</div></Panel>)}
      {!view && (<Panel className="xl:col-span-2"><PanelHead title="Information requests" aside={<div className="flex items-center gap-2"><Badge tone="amber">{visibleRequests.filter((item) => item.status === "open").length} open</Badge>{canRequest && createButton("request")}</div>} /><div className="divide-y divide-neutral-100">{visibleRequests.length ? visibleRequests.map((item) => <article key={item.id} className="flex flex-wrap items-start gap-3 p-5"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.question}</h2><Badge tone={item.status === "open" ? "amber" : "green"}>{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.purpose}</p>{item.responseMarkdown && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">Answer: {item.responseMarkdown}</p>}<p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · Due {stamp(item.dueAt)}</p></div>{item.respondentId === session?.user.id && item.status === "open" && <button type="button" onClick={() => { setSelected(item); setResponse(""); setSources(""); }} className={secondaryClass}>Answer</button>}</article>) : <Empty title="No requests" body="No information requests are available in this scope." />}</div></Panel>)}
    </div>}
    {selected && <DetailDrawer title="Answer information request" subtitle={selected.question} onClose={() => setSelected(null)}><form onSubmit={answer} className="space-y-4"><label className="block"><span className="mb-1 block text-xs font-semibold text-neutral-600">Response</span><textarea required value={response} onChange={(event) => setResponse(event.target.value)} className={`${inputClass} min-h-44 py-3`} /></label><label className="block"><span className="mb-1 block text-xs font-semibold text-neutral-600">Source references, one per line</span><textarea value={sources} onChange={(event) => setSources(event.target.value)} className={`${inputClass} min-h-24 py-3`} /></label><p className="text-xs text-neutral-500">Only the assigned respondent can submit an answer.</p><button disabled={busy} className={primaryClass}>Submit answer</button></form></DetailDrawer>}
    {selectedClass && session && <LiveClassApplications item={selectedClass} session={session} onClose={() => setSelectedClass(null)} />}
    {createKind && session && <PlanningCreateDrawer key={`${createKind}-${ventureId}`} kind={createKind} ventureId={ventureId} ventureName={ventureName(ventureId)} session={session} onClose={() => setCreateKind(null)} onCreated={(kind, title, destinationId) => { setCreateKind(null); setResult(`${kind === "request" ? "Information request" : kind[0]!.toUpperCase() + kind.slice(1)} “${title}” created in ${ventureName(destinationId)}.`); setRevision((value) => value + 1); }} />}
  </PageFrame>;
}
