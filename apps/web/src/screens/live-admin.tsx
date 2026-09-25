"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { RefreshCw } from "@/components/ui/icons";
import { WorkspaceLink as Link } from "@/components/shell/workspace-link";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { createLiveChannel, listLiveMembers, listLiveMemberships, loadLiveSession, updateLiveMembership } from "@/lib/studio-api";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Membership = Awaited<ReturnType<typeof listLiveMemberships>>[number];
type Role = Membership["role"];

export function LiveAdminScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof listLiveMembers>>["items"]>([]);
  const [tab, setTab] = useState<"Members" | "Structure">("Members");
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
      const [next, directory] = await Promise.all([listLiveMemberships(), listLiveMembers({ limit: 100 }).catch(() => null)]);
      if (active) { setMemberships(next); setMembers(directory?.items ?? []); setError(""); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load administration records."); }));
    return () => { active = false; };
  }, [revision]);

  const groups = session?.hierarchy.ventures.flatMap((venture) => venture.groups.map((group) => ({ ...group, ventureName: venture.name }))) ?? [];
  const ventureName = (id: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? id;
  const groupName = (id: string) => groups.find((item) => item.id === id)?.name ?? id;
  const personName = (id: string) => members.find((item) => item.id === id)?.name ?? (id === session?.user.id ? session.user.name : "Workspace member");

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
    <PageTitle title="People & access" description="Manage the workspace hierarchy and member access." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm font-semibold text-success-text">{result}</p>}
    {session?.membership.role !== "admin" ? <Panel className="p-8 text-sm text-neutral-600">{session ? "Only workspace admins can manage access." : "Loading workspace access…"}</Panel> : <><SlidingTabs tabs={[{ key: "Members", label: "Members" }, { key: "Structure", label: "Structure" }]} active={tab} onChange={(key) => setTab(key as typeof tab)} label="Administration sections" className="mb-4" />
      {tab === "Members" && <Panel><PanelHead title="Workspace members" aside={<Badge tone="blue">{memberships.length}</Badge>} /><div className="divide-y divide-neutral-100">{memberships.length ? memberships.map((item) => <article key={item.id} className="flex flex-wrap items-center gap-3 p-5"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-50 text-xs font-semibold text-primary-700">{personName(item.userId).split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("")}</span><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-neutral-800">{personName(item.userId)}{item.userId === session.user.id ? " · You" : ""}</p><div className="mt-2 flex flex-wrap gap-1"><Badge tone="blue">{item.role.replaceAll("_", " ")}</Badge>{item.ventureIds.map((id) => <Badge key={id}>{ventureName(id)}</Badge>)}</div><p className="mt-2 text-xs text-neutral-500">{item.groupIds.length} groups</p></div>{item.userId !== session.user.id && <button type="button" onClick={() => edit(item)} className={secondaryClass}>Edit access</button>}</article>) : <Empty title="No members" body="No members are listed in this workspace." />}</div></Panel>}
      {tab === "Structure" && <><div className="grid gap-4 lg:grid-cols-3"><Panel className="p-4"><PanelHead title="Ventures" aside={<Link href="/ventures" className="text-xs font-semibold text-primary-700">Open ventures</Link>} />{session.hierarchy.ventures.map((item) => <div key={item.id} className="border-b border-neutral-100 py-3 text-sm font-semibold text-neutral-800">{item.name}</div>)}</Panel><Panel className="p-4"><PanelHead title="Groups" aside={<Link href="/channels" className="text-xs font-semibold text-primary-700">Open groups</Link>} />{groups.map((item) => <div key={item.id} className="border-b border-neutral-100 py-3"><p className="text-sm font-semibold text-neutral-800">{item.name}</p><p className="text-xs text-neutral-500">{item.ventureName}</p></div>)}</Panel><Panel className="p-4"><PanelHead title="Channels" />{groups.flatMap((group) => group.channels.map((channel) => <div key={channel.id} className="border-b border-neutral-100 py-3"><p className="text-sm font-semibold text-neutral-800"># {channel.name}</p><p className="text-xs text-neutral-500">{group.ventureName} · {group.name}</p></div>))}</Panel></div><Panel className="mt-4 max-w-xl"><PanelHead title="Create channel" /><form onSubmit={addChannel} className="space-y-4 p-5"><Field label="Group"><Select required className={inputClass} value={channelGroupId} onChange={(event) => setChannelGroupId(event.target.value)}><option value="">Choose a group</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.ventureName} · {item.name}</option>)}</Select></Field><Field label="Channel name"><input required maxLength={80} className={inputClass} value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="product-updates" /></Field><p className="text-xs leading-5 text-neutral-500">Names become channel addresses. Each name must be unique within its group.</p><button disabled={busy || !channelGroupId} className={primaryClass}>Create channel</button></form></Panel></>}
    </>}
    {selected && <DetailDrawer title="Edit member access" subtitle={personName(selected.userId)} onClose={() => setSelected(null)}><form onSubmit={saveMembership} className="space-y-5"><Field label="Role"><Select className={inputClass} value={role} onChange={(event) => setRole(event.target.value as Role)}><option value="admin">Admin</option><option value="venture_head">Venture head</option><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option><option value="learner">Learner</option></Select></Field><fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Ventures</legend><div className="space-y-2">{session?.hierarchy.ventures.map((item) => <label key={item.id} className="flex min-h-10 items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700"><input type="checkbox" checked={ventureIds.includes(item.id)} onChange={() => toggleVenture(item.id)} />{item.name}</label>)}</div></fieldset><fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Groups within selected ventures</legend><div className="space-y-2">{groups.filter((item) => ventureIds.includes(item.ventureId)).map((item) => <label key={item.id} className="flex min-h-10 items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700"><input type="checkbox" checked={groupIds.includes(item.id)} onChange={() => setGroupIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} />{item.ventureName} · {item.name}</label>)}</div></fieldset><p className="text-xs leading-5 text-neutral-500">Saving replaces the member’s role and access. Changes are recorded in the audit log.</p><button disabled={busy} className={primaryClass}>Save access</button></form></DetailDrawer>}
  </PageFrame>;
}
