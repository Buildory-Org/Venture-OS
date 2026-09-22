"use client";

import { useEffect, useState } from "react";
import { createLiveClassApplication, listLiveClassApplications, listLiveClasses, loadLiveSession, reviewLiveClassApplication } from "@/lib/studio-api";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { Badge, DetailDrawer, Empty, Field, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Class = Awaited<ReturnType<typeof listLiveClasses>>[number];
type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Application = Awaited<ReturnType<typeof listLiveClassApplications>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

export function LiveClassApplications({ item, session, onClose }: { item: Class; session: Session; onClose: () => void }) {
  const [applications, setApplications] = useState<Application[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [exercise, setExercise] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [reviewing, setReviewing] = useState<Application | null>(null);
  const [assessment, setAssessment] = useState("");
  const [nextGap, setNextGap] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => listLiveClassApplications(item.id).then((page) => { if (active) { setApplications(page.items); setCursor(page.nextCursor); setError(""); } }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load applications."); }));
    return () => { active = false; };
  }, [item.id, revision]);

  async function more() {
    if (!cursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveClassApplications(item.id, cursor); setApplications((items) => [...items, ...page.items]); setCursor(page.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more applications."); }
    finally { setBusy(false); }
  }

  async function apply(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setResult("");
    try { await createLiveClassApplication(item.id, { exercise, reviewerId }); setExercise(""); setReviewerId(""); setRevision((value) => value + 1); setResult("Application submitted for review."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not submit the application."); }
    finally { setBusy(false); }
  }

  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (!reviewing) return;
    setBusy(true); setError(""); setResult("");
    try { await reviewLiveClassApplication(item.id, reviewing.id, { assessment, ...(nextGap ? { nextGap } : {}) }); setReviewing(null); setAssessment(""); setNextGap(""); setRevision((value) => value + 1); setResult("Assessment recorded and audited."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not review the application."); }
    finally { setBusy(false); }
  }

  const canApply = item.participantIds.includes(session.user.id);
  const canReviewAll = session.membership.role === "admin" || (session.membership.role === "venture_head" && !!item.ventureId && session.membership.ventureIds.includes(item.ventureId)) || item.facilitatorId === session.user.id;

  return <DetailDrawer title={item.title} subtitle="Class applications and assessments" onClose={onClose}>
    <p className="mb-4 text-sm text-neutral-600">{item.objective}</p>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm text-danger-text">{error}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm text-success-text">{result}</p>}
    <section><h3 className="text-sm font-extrabold text-neutral-900">Applications</h3><div className="mt-3 space-y-3">{applications.length ? applications.map((application) => <article key={application.id} className="rounded-xl bg-neutral-50 p-4"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-bold text-neutral-700">Applicant {application.userId}</p><Badge tone={application.reviewedAt ? "green" : "amber"}>{application.reviewedAt ? "Reviewed" : "Awaiting review"}</Badge></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">{application.exercise}</p>{application.assessment && <p className="mt-2 text-sm text-neutral-700">Assessment: {application.assessment}</p>}{application.nextGap && <p className="mt-1 text-xs text-neutral-500">Next gap: {application.nextGap}</p>}<p className="mt-2 text-xs text-neutral-400">Submitted {stamp(application.createdAt)} · Reviewer {application.reviewerId}</p>{(canReviewAll || application.reviewerId === session.user.id) && <button type="button" onClick={() => { setReviewing(application); setAssessment(application.assessment ?? ""); setNextGap(application.nextGap ?? ""); }} className={`${secondaryClass} mt-3`}>{application.reviewedAt ? "Update assessment" : "Review application"}</button>}</article>) : <Empty title="No applications" body="No one has submitted an applied assignment in your visible scope." />}</div>{cursor && <button type="button" disabled={busy} onClick={more} className="mt-3 text-xs font-bold text-primary-700 underline">Load more applications</button>}</section>
    {canApply && <form onSubmit={apply} className="mt-6 space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-extrabold text-neutral-900">Submit your applied work</h3><Field label="Exercise and evidence summary"><textarea required maxLength={5000} value={exercise} onChange={(event) => setExercise(event.target.value)} className={`${inputClass} min-h-32 py-3`} /></Field><LiveMemberPicker label="Reviewer" value={reviewerId} onChange={setReviewerId} ventureId={item.ventureId} excludeIds={[session.user.id]} /><p className="text-xs leading-5 text-neutral-500">The reviewer must be a different active member in this class scope. The server validates this.</p><button disabled={busy || !reviewerId} className={primaryClass}>Submit application</button></form>}
    {reviewing && <form onSubmit={review} className="mt-6 space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-extrabold text-neutral-900">Assess application</h3><Field label="Assessment"><textarea required maxLength={5000} value={assessment} onChange={(event) => setAssessment(event.target.value)} className={`${inputClass} min-h-32 py-3`} /></Field><Field label="Next gap, optional"><textarea maxLength={2000} value={nextGap} onChange={(event) => setNextGap(event.target.value)} className={`${inputClass} min-h-20 py-3`} /></Field><div className="flex gap-2"><button disabled={busy} className={primaryClass}>Save assessment</button><button type="button" onClick={() => setReviewing(null)} className={secondaryClass}>Cancel</button></div></form>}
  </DetailDrawer>;
}
