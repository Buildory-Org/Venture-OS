"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, Database, RefreshCw } from "lucide-react";
import { listLiveClasses, listLiveDecisions, listLiveInformationRequests, listLiveOutcomes, loadLiveSession, updateLiveClass, updateLiveDecision, updateLiveInformationRequest, updateLiveOutcome } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { LiveClassApplications } from "@/components/studio/live-class-applications";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Outcome = Awaited<ReturnType<typeof listLiveOutcomes>>[number];
type Decision = Awaited<ReturnType<typeof listLiveDecisions>>[number];
type Class = Awaited<ReturnType<typeof listLiveClasses>>[number];
type Request = Awaited<ReturnType<typeof listLiveInformationRequests>>[number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

export function LivePlanningScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [ventureId, setVentureId] = useState("");
  const [selected, setSelected] = useState<Request | null>(null);
  const [selectedClass, setSelectedClass] = useState<Class | null>(null);
  const [response, setResponse] = useState("");
  const [sources, setSources] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      Promise.all([loadLiveSession(), listLiveOutcomes(), listLiveDecisions(), listLiveClasses(), listLiveInformationRequests()]).then(([nextSession, nextOutcomes, nextDecisions, nextClasses, nextRequests]) => {
        if (!active) return;
        setSession(nextSession); setOutcomes(nextOutcomes); setDecisions(nextDecisions); setClasses(nextClasses); setRequests(nextRequests); setError(""); setBusy(false);
      }).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load planning records."); setBusy(false); } });
    });
    return () => { active = false; };
  }, [revision]);

  const visibleOutcomes = outcomes.filter((item) => !ventureId || item.ventureId === ventureId);
  const visibleDecisions = decisions.filter((item) => !ventureId || item.ventureId === ventureId);
  const visibleClasses = classes.filter((item) => !ventureId || item.ventureId === ventureId);
  const visibleRequests = requests.filter((item) => !ventureId || item.ventureId === ventureId);
  const ventureName = (id?: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? "Workspace";
  const canManage = (id?: string) => session?.membership.role === "admin" || (session?.membership.role === "venture_head" && !!id && session.membership.ventureIds.includes(id));
  const timeline = useMemo(() => [
    ...visibleOutcomes.map((item) => ({ id: item.id, at: item.reviewAt, type: "Outcome review", title: item.title, ventureId: item.ventureId })),
    ...visibleClasses.map((item) => ({ id: item.id, at: item.scheduledAt, type: "Class", title: item.title, ventureId: item.ventureId })),
    ...visibleRequests.filter((item) => item.status === "open").map((item) => ({ id: item.id, at: item.dueAt, type: "Request due", title: item.question, ventureId: item.ventureId })),
  ].sort((a, b) => a.at.localeCompare(b.at)), [visibleOutcomes, visibleClasses, visibleRequests]);

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
    try { const updated = await updateLiveDecision(item.id, { status }); setDecisions((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the decision."); }
    finally { setBusy(false); }
  }

  async function changeClass(item: Class, status: Class["status"]) {
    setBusy(true); setError("");
    try { const updated = await updateLiveClass(item.id, { status }); setClasses((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the class."); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle eyebrow="Connected planning" title="Outcomes & operating records" description="Canonical 30-day commitments, decisions, classes, requests, and review dates." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>These records come from authorized API reads. The backend does not publish a percentage-progress field, so this timeline shows actual review and due dates rather than invented progress. Decisions, classes, and requests are limited to the API’s latest 100 records. <Link href="/timeline" className="font-bold underline">Demo timeline</Link> remains separate.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <Panel className="mb-4 p-4"><label className="block max-w-sm"><span className="mb-1 block text-xs font-bold text-neutral-500">Venture</span><select className={inputClass} value={ventureId} onChange={(event) => setVentureId(event.target.value)}><option value="">All authorized ventures</option>{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></Panel>
    {busy && !session ? <Panel className="p-8 text-sm text-neutral-500">Loading operating records…</Panel> : <div className="grid gap-4 xl:grid-cols-2">
      <Panel><PanelHead title="30-day outcomes" aside={<Badge tone="blue">{visibleOutcomes.length}</Badge>} /><div className="divide-y divide-neutral-100">{visibleOutcomes.length ? visibleOutcomes.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-extrabold text-neutral-800">{item.title}</h2><Badge tone={item.status === "at_risk" ? "amber" : "green"}>{item.status.replaceAll("_", " ")}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.description}</p><p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · Review {stamp(item.reviewAt)} · {item.priority} priority</p><p className="mt-2 text-xs text-neutral-500">Success evidence: {item.successEvidence}</p>{item.risk && <p className="mt-1 text-xs text-danger-text">Risk: {item.risk}</p>}{canManage(item.ventureId) && <select aria-label={`Status for outcome ${item.title}`} disabled={busy} value={item.status} onChange={(event) => changeOutcome(item, event.target.value as Outcome["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="draft">Draft</option><option value="approved">Approved</option><option value="active">Active</option><option value="at_risk">At risk</option><option value="achieved">Achieved</option><option value="cancelled">Cancelled</option></select>}</article>) : <Empty title="No outcomes" body="The API returned no outcomes in this scope." />}</div></Panel>
      <Panel><PanelHead title="Milestone timeline" aside={<CalendarDays size={16} className="text-neutral-400" />} /><div className="divide-y divide-neutral-100">{timeline.length ? timeline.map((item) => <div key={`${item.type}-${item.id}`} className="flex gap-3 p-4"><span className="w-24 shrink-0 text-xs font-bold text-neutral-500">{stamp(item.at)}</span><div className="min-w-0"><p className="text-xs font-extrabold uppercase tracking-wide text-primary-700">{item.type}</p><p className="mt-1 text-sm font-bold text-neutral-800">{item.title}</p><p className="mt-1 text-xs text-neutral-400">{ventureName(item.ventureId)}</p></div></div>) : <Empty title="No milestones" body="Nothing is scheduled in this scope." />}</div></Panel>
      <Panel><PanelHead title="Decision log" aside={<Badge>{visibleDecisions.length}</Badge>} /><div className="divide-y divide-neutral-100">{visibleDecisions.length ? visibleDecisions.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-extrabold text-neutral-800">{item.title}</h2><Badge tone={item.status === "approved" ? "green" : "amber"}>{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.text}</p><p className="mt-2 text-xs text-neutral-500">Reason: {item.reason}</p><p className="mt-1 text-xs text-neutral-400">{ventureName(item.ventureId)} · Decided {stamp(item.decidedAt)} · {item.evidence.length} evidence references</p>{canManage(item.ventureId) && <select aria-label={`Status for decision ${item.title}`} disabled={busy} value={item.status} onChange={(event) => changeDecision(item, event.target.value as Decision["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="draft">Draft</option><option value="approved">Approved</option><option value="superseded">Superseded</option><option value="stale">Stale</option></select>}</article>) : <Empty title="No decisions" body="The API returned no decisions in this scope." />}</div></Panel>
<Panel><PanelHead title="Classes" aside={<Badge>{visibleClasses.length}</Badge>} /><div className="divide-y divide-neutral-100">{visibleClasses.length ? visibleClasses.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-extrabold text-neutral-800">{item.title}</h2><Badge tone="blue">{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.objective}</p><p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · {stamp(item.scheduledAt)} · {item.durationMinutes} min · {item.participantIds.length} participants</p>{canManage(item.ventureId) && <select aria-label={`Status for class ${item.title}`} disabled={busy} value={item.status} onChange={(event) => changeClass(item, event.target.value as Class["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>}<button type="button" onClick={() => setSelectedClass(item)} className={`${secondaryClass} mt-3`}>Applications & assessments</button></article>) : <Empty title="No classes" body="The API returned no classes in this scope." />}</div></Panel>
      <Panel className="xl:col-span-2"><PanelHead title="Information requests" aside={<Badge tone="amber">{visibleRequests.filter((item) => item.status === "open").length} open</Badge>} /><div className="divide-y divide-neutral-100">{visibleRequests.length ? visibleRequests.map((item) => <article key={item.id} className="flex flex-wrap items-start gap-3 p-5"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-extrabold text-neutral-800">{item.question}</h2><Badge tone={item.status === "open" ? "amber" : "green"}>{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.purpose}</p>{item.responseMarkdown && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">Answer: {item.responseMarkdown}</p>}<p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · Due {stamp(item.dueAt)}</p></div>{item.respondentId === session?.user.id && item.status === "open" && <button type="button" onClick={() => { setSelected(item); setResponse(""); setSources(""); }} className={secondaryClass}>Answer</button>}</article>) : <Empty title="No requests" body="The API returned no information requests in this scope." />}</div></Panel>
    </div>}
    {selected && <DetailDrawer title="Answer information request" subtitle={selected.question} onClose={() => setSelected(null)}><form onSubmit={answer} className="space-y-4"><label className="block"><span className="mb-1 block text-xs font-bold text-neutral-600">Response</span><textarea required value={response} onChange={(event) => setResponse(event.target.value)} className={`${inputClass} min-h-44 py-3`} /></label><label className="block"><span className="mb-1 block text-xs font-bold text-neutral-600">Source references, one per line</span><textarea value={sources} onChange={(event) => setSources(event.target.value)} className={`${inputClass} min-h-24 py-3`} /></label><p className="text-xs text-neutral-500">Only the assigned respondent can submit an answer; the server checks this.</p><button disabled={busy} className={primaryClass}>Submit answer</button></form></DetailDrawer>}
    {selectedClass && session && <LiveClassApplications item={selectedClass} session={session} onClose={() => setSelectedClass(null)} />}
  </PageFrame>;
}
