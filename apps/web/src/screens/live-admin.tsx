"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Search, UserPlus, X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { flashById } from "@/lib/motion";
import { WorkspaceLink as Link } from "@/components/shell/workspace-link";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { InviteMemberDrawer } from "@/components/studio/invite-member-drawer";
import { MemberTable } from "@/components/studio/member-table";
import { createLiveChannel, listLiveMembers, listLiveMemberships, loadLiveSession, updateLiveMembership } from "@/lib/studio-api";
import { ActionLabel, Badge, DetailDrawer, Empty, Field, inputClass, Notice, PageFrame, PageTitle, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Membership = Awaited<ReturnType<typeof listLiveMemberships>>[number];
type Role = Membership["role"];
const roleLabel = (value: string) => value.replaceAll("_", " ");
const rank: Record<Role, number> = { admin: 4, venture_head: 3, reviewer: 2, contributor: 2, learner: 1 };
const checkRow = "flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700 transition-colors duration-150 hover:bg-neutral-100 has-[:checked]:bg-primary-50 has-[:checked]:text-primary-800";

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
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  // Saving a change that removes access asks once more, showing exactly what will change.
  const [confirming, setConfirming] = useState(false);
  const [inviting, setInviting] = useState(false);
  const confirmShownAt = useRef(0);
  const tabMotion = useTabMotion(tab, ["Members", "Structure"]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setLoading(true); });
    queueMicrotask(() => loadLiveSession().then(async (value) => {
      if (!active) return;
      setSession(value);
      if (value.membership.role !== "admin") { setError(""); setLoading(false); return; }
      const [next, directory] = await Promise.all([listLiveMemberships(), listLiveMembers({ limit: 100 }).catch(() => null)]);
      if (active) { setMemberships(next); setMembers(directory?.items ?? []); setError(""); setLoading(false); }
    }).catch((cause: unknown) => { if (active) { setError(describeError(cause, "Could not load administration records.")); setLoading(false); } }));
    return () => { active = false; };
  }, [revision]);

  const groups = session?.hierarchy.ventures.flatMap((venture) => venture.groups.map((group) => ({ ...group, ventureName: venture.name }))) ?? [];
  const ventureName = (id: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? id;
  const groupName = (id: string) => groups.find((item) => item.id === id)?.name ?? id;
  const personName = (id: string) => members.find((item) => item.id === id)?.name ?? (id === session?.user.id ? session.user.name : "Workspace member");

  function edit(item: Membership) {
    setSelected(item); setRole(item.role); setVentureIds(item.ventureIds); setGroupIds(item.groupIds); setError(""); setConfirming(false);
  }

  const changes = selected ? {
    role: role !== selected.role ? { from: selected.role, to: role } : null,
    addedVentures: ventureIds.filter((id) => !selected.ventureIds.includes(id)),
    removedVentures: selected.ventureIds.filter((id) => !ventureIds.includes(id)),
    addedGroups: groupIds.filter((id) => !selected.groupIds.includes(id)),
    removedGroups: selected.groupIds.filter((id) => !groupIds.includes(id)),
  } : null;
  const dirty = Boolean(changes && (changes.role || changes.addedVentures.length || changes.removedVentures.length || changes.addedGroups.length || changes.removedGroups.length));
  const risky = Boolean(changes && ((changes.role && (rank[changes.role.to] < rank[changes.role.from] || changes.role.to === "admin")) || changes.removedVentures.length || changes.removedGroups.length));
  const needle = query.trim().toLowerCase();
  const shown = needle ? memberships.filter((item) => `${personName(item.userId)} ${item.role} ${item.ventureIds.map(ventureName).join(" ")}`.toLowerCase().includes(needle)) : memberships;

  function toggleVenture(id: string) {
    const next = ventureIds.includes(id) ? ventureIds.filter((item) => item !== id) : [...ventureIds, id];
    setVentureIds(next);
    setGroupIds((current) => current.filter((groupId) => groups.some((group) => group.id === groupId && next.includes(group.ventureId))));
  }

  async function saveMembership(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !dirty || busy) return;
    if (risky && !confirming) { confirmShownAt.current = Date.now(); setConfirming(true); return; }
    // The confirm button sits where Save was; ignore a double-click that lands before the summary can be read.
    if (risky && Date.now() - confirmShownAt.current < 600) return;
    setBusy(true); setError("");
    try {
      const updated = await updateLiveMembership(selected.id, { role, ventureIds, groupIds });
      setMemberships((items) => items.map((item) => item.id === updated.id ? updated : item));
      setSelected(null); setConfirming(false);
      toast({ title: "Access updated", body: `${personName(updated.userId)} is now ${roleLabel(updated.role)} with ${updated.ventureIds.length} venture${updated.ventureIds.length === 1 ? "" : "s"}.` });
      flashById(`membership-${updated.id}`);
    } catch (cause) { setError(describeError(cause, "Could not update membership.")); setConfirming(false); }
    finally { setBusy(false); }
  }

  async function addChannel(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const created = await createLiveChannel({ groupId: channelGroupId, name: channelName });
      setChannelName(""); toast({ title: `#${created.name} created`, body: `In ${groupName(created.groupId)}.` }); setRevision((value) => value + 1); flashById(`channel-${created.id}`);
    } catch (cause) { setError(describeError(cause, "Could not create channel.")); }
    finally { setBusy(false); }
  }

  return <PageFrame>
    <PageTitle title="People & access" description="Manage the workspace hierarchy and member access." action={<div className="flex flex-wrap gap-2">{session?.membership.role === "admin" && <button type="button" onClick={() => setInviting(true)} className={primaryClass}><UserPlus size={15} />Invite member</button>}<RefreshButton busy={loading} onClick={() => setRevision((value) => value + 1)} /></div>} />
    <Notice tone="error" message={selected ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    {session?.membership.role !== "admin" ? session ? <Panel className="p-8 text-sm text-neutral-600">Only workspace admins can manage access.</Panel> : <Panel><SkeletonRows rows={4} label="Loading workspace access" /></Panel> : <><SlidingTabs tabs={[{ key: "Members", label: "Members" }, { key: "Structure", label: "Structure" }]} active={tab} onChange={(key) => setTab(key as typeof tab)} label="Administration sections" className="mb-4" />
      <div key={tab} className={tabMotion.className} style={tabMotion.style}>{tab === "Members" && <Panel><PanelHead title="Workspace members" aside={<Badge tone="blue">{needle ? `${shown.length} of ${memberships.length}` : memberships.length}</Badge>} /><div className="border-b border-neutral-100 px-5 py-3"><label className="flex h-10 items-center gap-2 rounded-xl bg-neutral-100 px-3 text-neutral-400 transition-[background-color,box-shadow] duration-150 focus-within:bg-white focus-within:ring-2 focus-within:ring-primary-100"><Search size={15} /><span className="sr-only">Search members</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} placeholder="Search by name, role, or venture" className="min-w-0 flex-1 bg-transparent text-sm text-neutral-800 outline-none placeholder:text-neutral-400" />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="vso-fade-enter grid h-7 w-7 place-items-center rounded-md transition-colors duration-150 hover:bg-neutral-200 hover:text-neutral-600"><X size={13} /></button>}</label></div><div className="divide-y divide-neutral-100">{loading && !memberships.length ? <SkeletonRows rows={4} label="Loading members" /> : shown.length ? <div key={needle} className="vso-stagger-in"><MemberTable rows={shown.map((item) => {
        const handle = members.find((member) => member.id === item.userId)?.handle;
        return { id: item.id, flashId: `membership-${item.id}`, name: personName(item.userId), ...(handle ? { detail: `@${handle}` } : {}), you: item.userId === session.user.id, role: roleLabel(item.role), allVentures: item.role === "admin", ventures: item.ventureIds.map(ventureName), groups: item.role === "admin" ? null : item.groupIds.length,
          // Your own access is changed by another admin, so your row has no edit button.
          action: item.userId !== session.user.id ? <button type="button" onClick={() => edit(item)} aria-label={`Edit access for ${personName(item.userId)}`} className="min-h-8 rounded-lg px-3 text-xs font-semibold text-neutral-600 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-900 active:scale-[0.97]">Edit</button> : undefined };
      })} /></div> : needle ? <Empty title="No matching members" body={`Nobody matches “${query.trim()}”.`} action={<button type="button" onClick={() => setQuery("")} className={secondaryClass}>Clear search</button>} /> : <Empty title="No members" body="No members are listed in this workspace." />}</div></Panel>}
      {tab === "Structure" && <><div className="grid gap-4 lg:grid-cols-3"><Panel className="p-4"><PanelHead title="Ventures" aside={<Link href="/ventures" className="text-xs font-semibold text-primary-700">Open ventures</Link>} />{session.hierarchy.ventures.map((item) => <div key={item.id} className="border-b border-neutral-100 py-3 text-sm font-semibold text-neutral-800">{item.name}</div>)}</Panel><Panel className="p-4"><PanelHead title="Groups" aside={<Link href="/channels" className="text-xs font-semibold text-primary-700">Open groups</Link>} />{groups.map((item) => <div key={item.id} className="border-b border-neutral-100 py-3"><p className="text-sm font-semibold text-neutral-800">{item.name}</p><p className="text-xs text-neutral-500">{item.ventureName}</p></div>)}</Panel><Panel className="p-4"><PanelHead title="Channels" />{groups.flatMap((group) => group.channels.map((channel) => <div key={channel.id} data-flash-id={`channel-${channel.id}`} className="-mx-2 rounded-lg border-b border-neutral-100 px-2 py-3"><p className="text-sm font-semibold text-neutral-800"># {channel.name}</p><p className="text-xs text-neutral-500">{group.ventureName} · {group.name}</p></div>))}</Panel></div><Panel className="mt-4 max-w-xl"><PanelHead title="Create channel" /><form onSubmit={addChannel} className="space-y-4 p-5"><Field label="Group"><Select required className={inputClass} value={channelGroupId} onChange={(event) => setChannelGroupId(event.target.value)}><option value="">Choose a group</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.ventureName} · {item.name}</option>)}</Select></Field><Field label="Channel name"><input required maxLength={80} className={inputClass} value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="product-updates" /></Field><p className="text-xs leading-5 text-neutral-500">Names become channel addresses. Each name must be unique within its group.</p><button disabled={busy || !channelGroupId} className={primaryClass}><ActionLabel busy={busy} busyText="Creating…" idle="Create channel" /></button></form></Panel></>}</div>
    </>}
    {selected && <DetailDrawer title="Edit member access" subtitle={personName(selected.userId)} dirty={dirty} onClose={() => { setSelected(null); setConfirming(false); }}><form onSubmit={saveMembership} className="space-y-5"><Notice tone="error" message={error} onDismiss={() => setError("")} /><Field label="Role"><Select className={inputClass} value={role} onChange={(event) => { setRole(event.target.value as Role); setConfirming(false); }}><option value="admin">Admin</option><option value="venture_head">Venture head</option><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option><option value="learner">Learner</option></Select></Field><fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Ventures</legend><div className="space-y-2">{session?.hierarchy.ventures.map((item) => <label key={item.id} className={checkRow}><input type="checkbox" checked={ventureIds.includes(item.id)} onChange={() => { toggleVenture(item.id); setConfirming(false); }} />{item.name}</label>)}</div></fieldset><fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Groups within selected ventures</legend><div className="space-y-2">{groups.filter((item) => ventureIds.includes(item.ventureId)).map((item) => <label key={item.id} className={clsx(checkRow, "vso-row-enter")}><input type="checkbox" checked={groupIds.includes(item.id)} onChange={() => { setGroupIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]); setConfirming(false); }} />{item.ventureName} · {item.name}</label>)}{!groups.some((item) => ventureIds.includes(item.ventureId)) && <p className="text-xs text-neutral-500">Choose a venture to see its groups.</p>}</div></fieldset>
      <div data-open={dirty} className="vso-collapse"><div><div className={clsx("rounded-xl border p-3 text-xs leading-5 transition-colors duration-200", confirming ? "border-warning bg-warning-surface text-warning-text" : "border-neutral-200 bg-neutral-50 text-neutral-600")}><p className="font-semibold">{confirming ? changes?.role?.to === "admin" && !changes.removedVentures.length && !changes.removedGroups.length ? "Admins can see and change everything. Confirm:" : "This changes access. Confirm these changes:" : "Changes to save"}</p><ul className="mt-1.5 space-y-0.5">{changes?.role && <li>Role: {roleLabel(changes.role.from)} → <strong>{roleLabel(changes.role.to)}</strong></li>}{changes?.addedVentures.map((id) => <li key={`+v${id}`}>+ Venture {ventureName(id)}</li>)}{changes?.removedVentures.map((id) => <li key={`-v${id}`} className="font-semibold">− Venture {ventureName(id)}</li>)}{changes?.addedGroups.map((id) => <li key={`+g${id}`}>+ Group {groupName(id)}</li>)}{changes?.removedGroups.map((id) => <li key={`-g${id}`} className="font-semibold">− Group {groupName(id)}</li>)}</ul></div></div></div>
      <p className="text-xs leading-5 text-neutral-500">Saving replaces the member’s role and access. Changes are recorded in the audit log.</p><div className="flex flex-wrap gap-2"><button disabled={busy || !dirty} className={clsx(primaryClass, confirming && "!bg-[#a95142] hover:!bg-[#94463a]")}><ActionLabel busy={busy} idle={confirming ? "Confirm and save" : "Save access"} /></button>{confirming && <button type="button" onClick={() => setConfirming(false)} className={clsx(secondaryClass, "vso-fade-enter")}>Review again</button>}</div></form></DetailDrawer>}
    {inviting && session && <InviteMemberDrawer ventures={session.hierarchy.ventures} onClose={() => setInviting(false)} onInvited={(email) => { setInviting(false); toast({ title: "Invitation sent", body: `${email} will get a link to join. They appear here once they accept.` }); }} />}
  </PageFrame>;
}
