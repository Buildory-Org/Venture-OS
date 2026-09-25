"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "@/components/ui/icons";
import { DetailDrawer, Field, PageFrame, PageTitle, Panel, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { VenturesScreen } from "./studio-ventures";
import { connectedDashboardData } from "@/lib/live-shell-data";
import { createLiveVenture, listLiveDecisions, listLiveDocuments, listLiveMembers, listLiveOpportunities, listLiveOutcomes, listLiveTasks, loadLiveSession } from "@/lib/studio-api";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Snapshot = ReturnType<typeof connectedDashboardData>;

export function ConnectedVentures() {
  const params = useSearchParams();
  const router = useRouter();
  const selectedId = params.get("venture");
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      try {
        const nextSession = await loadLiveSession();
        const ventureId = selectedId ?? nextSession.hierarchy.ventures[0]?.id;
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
  }, [selectedId]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || busy) return;
    setBusy(true);
    setError("");
    try {
      const venture = await createLiveVenture({ name: name.trim(), ownerId: session.user.id, goal30Day: goal.trim() });
      setCreating(false);
      setName("");
      setGoal("");
      window.dispatchEvent(new Event("venture:hierarchy-changed"));
      router.push(`/ventures/live?venture=${encodeURIComponent(venture.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the venture.");
    } finally {
      setBusy(false);
    }
  }

  const action = session?.membership.role === "admin" ? <button type="button" onClick={() => setCreating(true)} className={primaryClass}><Plus size={15} />Create venture</button> : undefined;
  return <>
    {error && <div role="alert" className="mx-6 mt-5 rounded-xl border border-danger-surface bg-white p-4 text-sm text-danger-text">{error}</div>}
    {!data ? <PageFrame><Panel className="p-6 text-sm text-neutral-500">Loading venture spaces…</Panel></PageFrame>
      : data.ventures.length ? <VenturesScreen snapshot={data} action={action} />
      : <PageFrame><PageTitle title="Ventures" description="Create the first venture space for your team." action={action} /><Panel className="p-6 text-sm text-neutral-500">No ventures have been created yet.</Panel></PageFrame>}
    {creating && session && <DetailDrawer title="Create venture" subtitle={`Destination · ${session.hierarchy.workspace.name}`} onClose={() => setCreating(false)}><form onSubmit={create} className="space-y-5"><Field label="Venture name"><input required autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} placeholder="Venture name" /></Field><Field label="30-day goal"><textarea maxLength={500} value={goal} onChange={(event) => setGoal(event.target.value)} className={`${inputClass} min-h-28 py-3`} placeholder="What should this venture prove next?" /></Field><p className="text-xs text-neutral-500">The venture will be created in your current workspace.</p>{error && <p role="alert" className="text-sm text-danger-text">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={() => setCreating(false)} className={secondaryClass}>Cancel</button><button type="submit" disabled={busy} className={primaryClass}>{busy ? "Creating…" : "Create venture"}</button></div></form></DetailDrawer>}
  </>;
}
