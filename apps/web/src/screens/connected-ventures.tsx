"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "@/components/ui/icons";
import { PageFrame, PageTitle, Panel, primaryClass } from "@/components/studio/primitives";
import { CreateVentureDrawer } from "@/components/studio/create-venture-drawer";
import { VenturesScreen } from "./studio-ventures";
import { useStudio } from "@/lib/studio-store";
import { connectedDashboardData } from "@/lib/live-shell-data";
import { listLiveDecisions, listLiveDocuments, listLiveMembers, listLiveOpportunities, listLiveOutcomes, listLiveTasks, loadLiveSession } from "@/lib/studio-api";

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

  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      try {
        const nextSession = await loadLiveSession();
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
        setData(snapshot);
        setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load venture spaces.");
      }
    });
    return () => { active = false; };
  }, [selectedId, activeVentureId]);

  const action = session?.membership.role === "admin" ? <button type="button" onClick={() => setCreating(true)} className={primaryClass}><Plus size={15} />Create venture</button> : undefined;
  return <>
    {error && <div role="alert" className="mx-6 mt-5 rounded-xl border border-danger-surface bg-white p-4 text-sm text-danger-text">{error}</div>}
    {!data ? <PageFrame><Panel className="p-6 text-sm text-neutral-500">Loading venture spaces…</Panel></PageFrame>
      : data.ventures.length ? <VenturesScreen snapshot={data} action={action} />
      : <PageFrame><PageTitle title="Ventures" description="Create the first venture space for your team." action={action} /><Panel className="p-6 text-sm text-neutral-500">No ventures have been created yet.</Panel></PageFrame>}
    {creating && session && <CreateVentureDrawer workspaceName={session.hierarchy.workspace.name} ownerId={session.user.id} onClose={() => setCreating(false)} onCreated={(venture) => { setCreating(false); router.push(`/ventures/live?venture=${encodeURIComponent(venture.id)}`); }} />}
  </>;
}
