"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Database, RefreshCw } from "@/components/ui/icons";
import { createLiveChannel, listLiveMemberships, loadLiveSession, updateLiveMembership } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Membership = Awaited<ReturnType<typeof listLiveMemberships>>[number];
type Role = Membership["role"];

export function LiveAdminScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selected, setSelected] = useState<Membership | null>(null);
  const [role, setRole] = useState<Role>("contributor");
  const [ventureIds, setVentureIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [channelGroupId, setChannelGroupId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then(async (value) => {
      if (!active) return;
      setSession(value);
      if (value.membership.role !== "admin") { setError(""); return; }
      const next = await listLiveMemberships();
      if (active) { setMemberships(next); setError(""); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load administration records."); }));
    return () => { active = false; };
  }, [revision]);

  const groups = session?.hierarchy.ventures.flatMap((venture) => venture.groups.map((group) => ({ ...group, ventureName: venture.name }))) ?? [];
  const ventureName = (id: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? id;
  const groupName = (id: string) => groups.find((item) => item.id === id)?.name ?? id;

  function edit(item: Membership) {
    setSelected(item); setRole(item.role); setVentureIds(item.ventureIds); setGroupIds(item.groupIds); setError("");
  }

  function toggleVenture(id: string) {
    const next = ventureIds.includes(id) ? ventureIds.filter((item) => item !== id) : [...ventureIds, id];
    setVentureIds(next);
    setGroupIds((current) => current.filter((groupId) => groups.some((group) => group.id === groupId && next.includes(group.ventureId))));
  }

  async function saveMembership(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setResult("");
    try {
      const updated = await updateLiveMembership(selected.id, { role, ventureIds, groupIds });
      setMemberships((items) => items.map((item) => item.id === updated.id ? updated : item));
      setSelected(null); setResult("Member access updated.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update membership."); }
    finally { setBusy(false); }
  }

  async function addChannel(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setResult("");
    try {
      const created = await createLiveChannel({ groupId: channelGroupId, name: channelName });
      setChannelName(""); setResult(`#${created.name} created in ${groupName(created.groupId)}.`); setRevision((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create channel."); }
    finally { setBusy(false); }
  }

  return <PageFrame>
    <PageTitle eyebrow="Connected administration" title="Workspace access" description="Manage member access and channels." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>Group access depends on venture access. You cannot edit your own membership here. Account IDs are shown when names are unavailable. <Link href="/demo/admin" className="font-bold underline">Explore sample administration</Link> in the demo.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm font-semibold text-success-text">{result}</p>}
    {session?.membership.role !== "admin" ? <Panel className="p-8 text-sm text-neutral-600">{session ? "Only workspace admins can manage access." : "Loading workspace access…"}</Panel> : <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Panel><PanelHead title="Members" aside={<Badge tone="blue">{memberships.length}</Badge>} /><div className="divide-y divide-neutral-100">{memberships.length ? memberships.map((item) => <article key={item.id} className="flex flex-wrap items-center gap-3 p-5"><div className="min-w-0 flex-1"><p className="break-all text-sm font-extrabold text-neutral-800">{item.userId === session.user.id ? "You" : item.userId}</p><p className="mt-1 break-all text-xs text-neutral-400">Membership {item.id}</p><div className="mt-2 flex flex-wrap gap-1"><Badge tone="blue">{item.role.replaceAll("_", " ")}</Badge>{item.ventureIds.map((id) => <Badge key={id}>{ventureName(id)}</Badge>)}</div><p className="mt-2 text-xs text-neutral-500">{item.groupIds.length} groups</p></div>{item.userId !== session.user.id && <button type="button" onClick={() => edit(item)} className={secondaryClass}>Edit access</button>}</article>) : <Empty title="No members" body="No members are listed in this workspace." />}</div></Panel>
      <Panel><PanelHead title="Create channel" /><form onSubmit={addChannel} className="space-y-4 p-5"><Field label="Group"><select required className={inputClass} value={channelGroupId} onChange={(event) => setChannelGroupId(event.target.value)}><option value="">Choose a group</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.ventureName} · {item.name}</option>)}</select></Field><Field label="Channel name"><input required maxLength={80} className={inputClass} value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="product-updates" /></Field><p className="text-xs leading-5 text-neutral-500">Names become channel addresses. Each name must be unique within its group.</p><button disabled={busy || !channelGroupId} className={primaryClass}>Create channel</button></form></Panel>
    </div>}
    {selected && <DetailDrawer title="Edit member access" subtitle={selected.userId} onClose={() => setSelected(null)}><form onSubmit={saveMembership} className="space-y-5"><Field label="Role"><select className={inputClass} value={role} onChange={(event) => setRole(event.target.value as Role)}><option value="admin">Admin</option><option value="venture_head">Venture head</option><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option><option value="learner">Learner</option></select></Field><fieldset><legend className="mb-2 text-xs font-extrabold text-neutral-600">Ventures</legend><div className="space-y-2">{session?.hierarchy.ventures.map((item) => <label key={item.id} className="flex min-h-10 items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700"><input type="checkbox" checked={ventureIds.includes(item.id)} onChange={() => toggleVenture(item.id)} />{item.name}</label>)}</div></fieldset><fieldset><legend className="mb-2 text-xs font-extrabold text-neutral-600">Groups within selected ventures</legend><div className="space-y-2">{groups.filter((item) => ventureIds.includes(item.ventureId)).map((item) => <label key={item.id} className="flex min-h-10 items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700"><input type="checkbox" checked={groupIds.includes(item.id)} onChange={() => setGroupIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} />{item.ventureName} · {item.name}</label>)}</div></fieldset><p className="text-xs leading-5 text-neutral-500">Saving replaces the member’s role and access. Changes are recorded in the audit log.</p><button disabled={busy} className={primaryClass}>Save access</button></form></DetailDrawer>}
  </PageFrame>;
}
