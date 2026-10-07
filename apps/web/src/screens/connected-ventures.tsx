"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { Plus } from "@/components/ui/icons";
import { PageFrame, PageTitle, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { CreateVentureDrawer } from "@/components/studio/create-venture-drawer";
import { VenturesScreen } from "./studio-ventures";
import { useStudio } from "@/lib/studio-store";
import { connectedDashboardData } from "@/lib/live-shell-data";
import { listLiveDecisions, listLiveDocuments, listLiveMembers, listLiveOpportunities, listLiveOutcomes, listLiveTasks, loadLiveSession, updateLiveVentureGoal } from "@/lib/studio-api";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Snapshot = ReturnType<typeof connectedDashboardData>;

export function ConnectedVentures() {
  const { activeVentureId } = useStudio();
  const params = useSearchParams();
  const router = useRouter();
  const selectedId = params.get("venture");
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [missing, setMissing] = useState(false);
  // A venture switch keeps the current page on screen, dimmed, until the new one arrives.
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      if (active) setLoading(true);
      try {
        const nextSession = await loadLiveSession();
        if (selectedId && !nextSession.hierarchy.ventures.some((venture) => venture.id === selectedId)) {
          if (active) { setSession(nextSession); setMissing(true); setError(""); setLoading(false); }
          return;
        }
        const ventureId = selectedId ?? (activeVentureId || nextSession.hierarchy.ventures[0]?.id);
        const [tasks, outcomes, decisions, documents, opportunities, members] = await Promise.all([
          listLiveTasks(), listLiveOutcomes(), listLiveDecisions(), listLiveDocuments(),
          listLiveOpportunities(), listLiveMembers({ ...(ventureId ? { ventureId } : {}), limit: 100 }),
        ]);
        if (!active) return;
        const snapshot = connectedDashboardData(nextSession, {
          tasks: tasks.items, notifications: [], members: members.items, outcomes, decisions,
          documents: documents.items, opportunities, focusHistory: [], classes: [],
        });
        snapshot.people = snapshot.people.map((person) => ({ ...person, ventureIds: ventureId && members.items.some((member) => member.id === person.id) ? [ventureId] : [] }));
        setSession(nextSession);
        setMissing(false);
        setData(snapshot);
        setError("");
        setLoading(false);
      } catch (cause) {
        if (active) { setError(describeError(cause, "Could not load venture spaces.")); setLoading(false); }
      }
    });
    return () => { active = false; };
  }, [selectedId, activeVentureId, revision]);

  // Mirrors the API rule: an admin, or a venture head assigned to that venture.
  const canEditGoal = (ventureId: string) => Boolean(session && (session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.includes(ventureId))));
  const saveGoal = async (ventureId: string, goal: string) => {
    const updated = await updateLiveVentureGoal(ventureId, goal);
    setData((current) => current && { ...current, ventures: current.ventures.map((venture) => venture.id === updated.id ? { ...venture, goal: updated.goal30Day } : venture) });
    // The shell keeps its own copy of the hierarchy (dashboard, venture menu); have it reload.
    window.dispatchEvent(new Event("venture:hierarchy-changed"));
    toast({ title: goal ? "Goal updated" : "Goal cleared", body: goal ? "Others see the new 30-day goal the next time they open this venture." : "This venture has no 30-day goal now." });
  };
  const action = session?.membership.role === "admin" ? <button type="button" onClick={() => setCreating(true)} className={primaryClass}><Plus size={15} />Create venture</button> : undefined;
  return <>
    {error && <div role="alert" className="vso-fade-enter mx-6 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger-surface bg-white p-4 text-sm text-danger-text"><span>{error}</span><button type="button" onClick={() => { setError(""); setRevision((value) => value + 1); }} className={secondaryClass}>Try again</button></div>}
    {missing ? <PageFrame><PageTitle title="Ventures" description="Goals, work, evidence, and decisions for each venture." action={action} /><Panel className="flex flex-wrap items-center justify-between gap-3 p-6 text-sm text-neutral-600"><p role="alert">This venture is not available. It may have been removed, or you may not have access to it.</p><button type="button" onClick={() => router.replace("/ventures/live")} className={secondaryClass}>Back to ventures</button></Panel></PageFrame>
      : !data ? error ? null : <PageFrame><div role="status" aria-label="Loading venture spaces"><span className="vso-skeleton h-9 w-60" /><span className="vso-skeleton mt-2 h-4 w-96 max-w-full" /><span className="vso-skeleton mt-6 h-11 w-[520px] max-w-full rounded-xl" /><span className="vso-skeleton mt-4 h-40 rounded-2xl" /><div className="mt-4 grid gap-4 xl:grid-cols-3"><span className="vso-skeleton h-56 rounded-2xl xl:col-span-2" /><span className="vso-skeleton h-56 rounded-2xl" /></div></div></PageFrame>
      : data.ventures.length ? <div aria-busy={loading || undefined} className={clsx("transition-opacity duration-200", loading && "pointer-events-none opacity-60")}><VenturesScreen snapshot={data} action={action} onSaveGoal={saveGoal} canEditGoal={canEditGoal} /></div>
      : <PageFrame><PageTitle title="Ventures" description="Create the first venture space for your team." action={action} /><Panel className="p-6 text-sm text-neutral-500">No ventures have been created yet.</Panel></PageFrame>}
    {creating && session && <CreateVentureDrawer workspaceName={session.hierarchy.workspace.name} ownerId={session.user.id} onClose={() => setCreating(false)} onCreated={(venture) => { setCreating(false); toast({ title: "Venture created", body: `${venture.name} is ready for its first group and outcome.` }); router.push(`/ventures/live?venture=${encodeURIComponent(venture.id)}`); }} />}
  </>;
}
