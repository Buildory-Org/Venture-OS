"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Mail, Plus, UserPlus, X } from "@/components/ui/icons";
import { addLiveGroupMember, createLiveGroupInvitation, listLiveMembers, removeLiveGroupMember } from "@/lib/studio-api";
import { ChatAvatar } from "@/components/studio/chat-ui";

type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
type InviteRole = "venture_head" | "contributor" | "reviewer" | "learner";
type Mode = "existing" | "invite";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Please try again.";

export function GroupPeople({ ventureId, ventureName, groupId, groupName, members, loading, error, canManage, onOpen, onRefresh }: {
  ventureId: string;
  ventureName: string;
  groupId: string;
  groupName: string;
  members: Member[];
  loading: boolean;
  error: string;
  canManage: boolean;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("existing");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [candidates, setCandidates] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [chosenId, setChosenId] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("contributor");
  const [inviteLink, setInviteLink] = useState("");
  const [showManualLink, setShowManualLink] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState("");
  const [busyRemoveId, setBusyRemoveId] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [peopleStatus, setPeopleStatus] = useState("");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || mode !== "existing") return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSearching(true); setSearchError(""); setCandidates([]); setCursor(undefined); setChosenId("");
      listLiveMembers({ ...(query ? { q: query } : {}), limit: 100 }).then((page) => {
        if (active) { setCandidates(page.items); setCursor(page.nextCursor); setSearching(false); }
      }).catch((cause: unknown) => { if (active) { setSearchError(errorText(cause)); setSearching(false); } });
    });
    return () => { active = false; };
  }, [open, mode, query, searchRevision]);

  useEffect(() => {
    if (!open) return;
    if (mode === "existing" && searching) return;
    (mode === "existing" ? searchRef.current : emailRef.current)?.focus();
  }, [open, mode, searching]);

  const existingIds = new Set(members.map((member) => member.id));
  const available = candidates.filter((member) => !existingIds.has(member.id));
  const chosen = available.find((member) => member.id === chosenId);

  function close() {
    setOpen(false); setInviteLink(""); setShowManualLink(false); setEmailSent(false); setActionError(""); setActionStatus("");
    requestAnimationFrame(() => { if (!dialogRef.current) addButtonRef.current?.focus(); });
  }

  function switchMode(next: Mode) {
    setMode(next); setActionError(""); setActionStatus(""); setInviteLink(""); setShowManualLink(false); setEmailSent(false);
  }

  function search(event: React.FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (next && next.length < 2) { setSearchError("Search at least two characters."); return; }
    setCandidates([]); setChosenId(""); setCursor(undefined);
    setQuery(next); setSearchRevision((value) => value + 1);
  }

  async function more() {
    if (!cursor || searching) return;
    setSearching(true); setSearchError("");
    try {
      const page = await listLiveMembers({ ...(query ? { q: query } : {}), cursor, limit: 100 });
      setCandidates((items) => [...items, ...page.items]); setCursor(page.nextCursor);
    } catch (cause) { setSearchError(errorText(cause)); }
    finally { setSearching(false); }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen || loading || busy) return;
    setBusy(true); setActionError(""); setActionStatus("");
    try {
      await addLiveGroupMember(groupId, ventureId, chosen.id);
      setPeopleStatus(`${chosen.name} added to ${groupName}.`);
      onRefresh(); close();
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setActionError(""); setActionStatus(""); setInviteLink(""); setShowManualLink(false); setEmailSent(false);
    try {
      const delivery = await createLiveGroupInvitation({ email: email.trim().toLowerCase(), role, ventureId, groupId });
      if (delivery.kind === "email") { setEmailSent(true); setActionStatus(`Invitation email sent to ${email.trim().toLowerCase()}.`); }
      else { setInviteLink(`${window.location.origin}/invite/live?token=${encodeURIComponent(delivery.token)}`); setActionStatus("Invite link ready. Copy it to share with the person you're inviting."); }
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(inviteLink); setActionError(""); setActionStatus("Invite link copied. Share it directly with the person you're inviting."); }
    catch { setShowManualLink(true); setActionError("Copy was unavailable. Select the link below to copy it."); requestAnimationFrame(() => linkRef.current?.select()); }
  }

  async function remove(member: Member) {
    setBusyRemoveId(member.id); setRemoveError(""); setPeopleStatus("");
    try { await removeLiveGroupMember(groupId, member.id); setConfirmRemoveId(""); setPeopleStatus(`${member.name} removed from ${groupName}. Other access may remain.`); onRefresh(); requestAnimationFrame(() => addButtonRef.current?.focus()); }
    catch (cause) { setRemoveError(errorText(cause)); }
    finally { setBusyRemoveId(""); }
  }

  function dialogKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])');
    if (!items?.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="mt-7 border-t border-[#f0f0f2] pt-5">
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-bold">People <span className="font-normal text-[#aaaab3]">{loading ? "…" : members.length}</span></h3>{canManage && <button ref={addButtonRef} type="button" onClick={() => { setPeopleStatus(""); onOpen(); setOpen(true); setMode("existing"); }} className="flex min-h-9 items-center gap-1 rounded-lg bg-[#fff2e8] px-2.5 text-[11px] font-semibold text-[#e4781f]"><UserPlus size={14} />Add people</button>}</div>
    {peopleStatus && <p role="status" className="mt-2 text-[11px] leading-4 text-emerald-700">{peopleStatus}</p>}
    {loading ? <p role="status" className="mt-3 text-xs text-[#92939e]">Loading group members…</p> : error ? <div className="mt-3"><p role="alert" className="text-xs text-red-700">{error}</p><button type="button" onClick={onRefresh} className="mt-2 min-h-8 text-xs font-semibold text-[#e4781f]">Retry</button></div> : members.length ? <ul className="mt-3 space-y-2">{members.map((member) => <li key={member.id} className="min-w-0"><div className="flex min-w-0 items-center gap-2"><ChatAvatar id={member.id} name={member.name} size={30} /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-[#444450]">{member.name}</p>{member.handle && <p className="truncate text-[10px] text-[#a1a1aa]">@{member.handle}</p>}</div>{canManage && member.role !== "admin" && <button type="button" disabled={Boolean(busyRemoveId)} onClick={() => { setConfirmRemoveId(member.id); setRemoveError(""); }} className="min-h-8 shrink-0 text-[10px] font-semibold text-[#a07869] hover:text-red-700">Remove from group</button>}</div>{confirmRemoveId === member.id && <div className="mt-2 rounded-lg bg-[#fff8f2] p-2.5"><p className="text-[11px] leading-4 text-[#8d5633]">Remove {member.name} from {groupName}? Other access may remain.</p><div className="mt-2 flex gap-2"><button type="button" disabled={Boolean(busyRemoveId)} onClick={() => remove(member)} className="min-h-8 rounded-lg bg-[#a95142] px-2.5 text-[10px] font-semibold text-white disabled:opacity-40">{busyRemoveId ? "Removing…" : "Confirm removal"}</button><button type="button" onClick={() => setConfirmRemoveId("")} className="min-h-8 px-2 text-[10px] font-semibold text-[#777883]">Cancel</button></div>{removeError && <p role="alert" className="mt-2 text-[11px] text-red-700">{removeError}</p>}</div>}</li>)}</ul> : <p className="mt-3 text-xs text-[#a2a2ab]">No members in this group yet.</p>}
    {open && canManage && createPortal(<div className="fixed inset-0 z-50 grid place-items-center bg-[#272736]/45 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section ref={dialogRef} role="dialog" aria-modal="true" aria-label="Add people to group" onKeyDownCapture={dialogKey} className="vso-enter-modal thin-scroll max-h-[min(90dvh,720px)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-bold text-[#34343f]">Add people</h2><button type="button" onClick={close} aria-label="Close add people" className="grid h-9 w-9 place-items-center rounded-lg text-[#777883] hover:bg-[#f6f6f8]"><X size={18} /></button></div>
      <div aria-label="Destination" className="mt-4 rounded-lg bg-[#f6f6f8] px-3 py-2.5"><p className="text-[10px] font-semibold uppercase tracking-[.08em] text-[#999aa4]">Adding to this group</p><p className="mt-1 text-xs font-bold text-[#393944]">{ventureName} · {groupName}</p></div>
      <div role="tablist" aria-label="Add people method" className="mt-5 flex gap-1 border-b border-[#eeeef1]"><button type="button" role="tab" aria-selected={mode === "existing"} onClick={() => switchMode("existing")} className={`min-h-10 border-b-2 px-3 text-xs font-semibold ${mode === "existing" ? "border-[#ff8b25] text-[#e4781f]" : "border-transparent text-[#898a96]"}`}><Plus size={14} className="mr-1 inline" />Existing member</button><button type="button" role="tab" aria-selected={mode === "invite"} onClick={() => switchMode("invite")} className={`min-h-10 border-b-2 px-3 text-xs font-semibold ${mode === "invite" ? "border-[#ff8b25] text-[#e4781f]" : "border-transparent text-[#898a96]"}`}><Mail size={14} className="mr-1 inline" />Invite by email</button></div>
      {mode === "existing" ? <div role="tabpanel" aria-label="Existing member" className="mt-5"><p className="text-xs leading-5 text-[#777883]">Find someone in your workspace who is not already in this group.</p><form onSubmit={search} className="mt-3 flex gap-2"><label htmlFor="group-person-search" className="sr-only">Search workspace people</label><input ref={searchRef} id="group-person-search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search name or handle" className="min-h-10 min-w-0 flex-1 rounded-lg border border-[#e6e6eb] px-3 text-xs outline-none focus:border-[#ffb56e]" /><button type="submit" disabled={searching} className="min-h-10 rounded-lg bg-[#f6f6f8] px-3 text-xs font-semibold text-[#555560] disabled:opacity-40">Search</button></form>
        {searchError && <p role="alert" className="mt-3 text-xs text-red-700">{searchError}</p>}
        {searching && candidates.length === 0 ? <p role="status" className="mt-4 text-xs text-[#92939e]">Searching workspace members…</p> : <form onSubmit={add} className="mt-4"><fieldset disabled={busy || loading}><legend className="mb-2 text-xs font-semibold text-[#555560]">Available people</legend><div className="thin-scroll max-h-56 space-y-1 overflow-y-auto">{available.map((member) => <label key={member.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-[#f6f6f8]"><input type="radio" name="new-group-member" checked={chosenId === member.id} onChange={() => setChosenId(member.id)} /><ChatAvatar id={member.id} name={member.name} size={28} /><span className="min-w-0 truncate text-xs font-semibold text-[#444450]">{member.name}{member.handle ? <span className="ml-1 font-normal text-[#999aa4]">@{member.handle}</span> : null}</span></label>)}{!available.length && !searchError && <p className="py-4 text-xs text-[#92939e]">{query ? "No eligible people matched this search." : "No other onboarded people found."}</p>}</div></fieldset>{cursor && <button type="button" disabled={searching} onClick={more} className="mt-2 min-h-8 text-xs font-semibold text-[#e4781f]">Load more people</button>}<div className="mt-5 flex justify-end"><button type="submit" disabled={!chosen || busy || loading} className="min-h-10 rounded-lg bg-[#ff8b25] px-4 text-xs font-semibold text-white disabled:opacity-40">{busy ? "Adding…" : "Add to group"}</button></div></form>}
      </div> : <form role="tabpanel" aria-label="Invite by email" onSubmit={invite} className="mt-5 space-y-4"><p className="text-xs leading-5 text-[#777883]">Invite someone new to this workspace. You&apos;ll receive an email confirmation or a link to share.</p><label className="block text-xs font-semibold text-[#555560]">Email<input ref={emailRef} required type="email" value={email} onChange={(event) => { setEmail(event.target.value); setInviteLink(""); setShowManualLink(false); setEmailSent(false); setActionStatus(""); }} className="mt-1.5 min-h-10 w-full rounded-lg border border-[#e6e6eb] px-3 text-xs outline-none focus:border-[#ffb56e]" placeholder="person@example.com" /></label><label className="block text-xs font-semibold text-[#555560]">Role<select value={role} onChange={(event) => { setRole(event.target.value as InviteRole); setInviteLink(""); setShowManualLink(false); setEmailSent(false); setActionStatus(""); }} className="mt-1.5 min-h-10 w-full rounded-lg border border-[#e6e6eb] px-3 text-xs outline-none focus:border-[#ffb56e]"><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option><option value="learner">Learner</option><option value="venture_head">Venture head</option></select></label><button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-[#ff8b25] px-4 text-xs font-semibold text-white disabled:opacity-40">{busy ? "Creating…" : "Create invitation"}</button>{emailSent && <p className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700">Invitation email sent. The recipient can open it to join this group.</p>}{inviteLink && <div className="rounded-lg bg-[#fff8f2] p-3"><p className="text-[11px] font-semibold text-[#8d5633]">Invite link ready</p><p className="mt-1 text-[11px] leading-4 text-[#8d5633]">Copy and share it with the intended recipient.</p><button type="button" onClick={copyLink} className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-[11px] font-semibold text-[#e4781f]"><Copy size={15} />Copy invite link</button>{showManualLink && <label className="mt-3 block text-[11px] font-semibold text-[#8d5633]">Select invite link<input ref={linkRef} readOnly value={inviteLink} onFocus={(event) => event.target.select()} className="mt-1 min-h-10 w-full rounded-lg border border-[#f4ded0] bg-white px-2 text-[11px] font-normal text-[#393944]" /></label>}</div>}</form>}
      {actionError && <p role="alert" className="mt-3 text-xs text-red-700">{actionError}</p>}{actionStatus && <p role="status" className="mt-3 flex items-start gap-1 text-xs text-emerald-700"><Check size={14} className="shrink-0" />{actionStatus}</p>}
    </section></div>, document.body)}
  </div>;
}
