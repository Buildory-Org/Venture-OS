"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bookmark, Columns3, FolderOpen, Hash, Info, Menu, MoreHorizontal, Send, X } from "lucide-react";
import clsx from "clsx";
import type { CommandPreview, Message } from "@venture-studio/contracts";
import { createLiveChannel, createLiveGroup, createLiveVenture, executeLiveCommand, listLiveChannelMessages, listLiveMembers, loadLiveSession, previewLiveCommand, sendLiveChannelMessage, updateLiveMessagePin, updateLiveMessageReaction, updateLiveMessageSave } from "@/lib/studio-api";
import { ChatAvatar, ChatCredit, ChatEmpty, ChatShell } from "@/components/studio/chat-ui";
import { ChannelNavigator } from "@/components/studio/channel-navigator";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { GroupWorkspaceSheet, type WorkspaceTab } from "@/components/studio/group-workspace-sheet";
import { useLiveRealtime } from "@/lib/use-live-realtime";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
type CreateKind = "venture" | "group" | "channel";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Please try again.";
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function LiveChannelsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const initialScope = useRef({ venture: params.get("venture"), group: params.get("group"), channel: params.get("channel") });
  const [session, setSession] = useState<Session | null>(null);
  const [selectedVentureId, setSelectedVentureId] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [railExpanded, setRailExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [members, setMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [mentions, setMentions] = useState<Member[]>([]);
  const [mentionCandidate, setMentionCandidate] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [createName, setCreateName] = useState("");
  const [createGoal, setCreateGoal] = useState("");
  const [createParent, setCreateParent] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const listButtonRef = useRef<HTMLButtonElement>(null);
  const createDialogRef = useRef<HTMLElement>(null);
  const createReturnRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const workspaceReturnRef = useRef<HTMLElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const clientId = useRef<string | null>(null);
  const realtime = useLiveRealtime(() => setRevision((value) => value + 1), selectedId || undefined);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => {
      if (!active) return;
      setSession(value);
      const ventures = value.hierarchy.ventures;
      const requested = initialScope.current;
      const channelVenture = ventures.find((venture) => venture.groups.some((group) => group.channels.some((channel) => channel.id === requested.channel)));
      const channelGroup = channelVenture?.groups.find((group) => group.channels.some((channel) => channel.id === requested.channel));
      const groupVenture = ventures.find((venture) => venture.groups.some((group) => group.id === requested.group));
      const chosenVenture = channelVenture ?? (requested.venture ? ventures.find((venture) => venture.id === requested.venture) : undefined) ?? groupVenture ?? ventures[0];
      const chosenGroup = channelGroup ?? chosenVenture?.groups.find((group) => group.id === requested.group) ?? chosenVenture?.groups[0];
      const chosenChannel = chosenGroup?.channels.find((channel) => channel.id === requested.channel) ?? chosenGroup?.channels[0];
      setSelectedVentureId(chosenVenture?.id ?? "");
      setSelectedGroupId(chosenGroup?.id ?? "");
      setSelectedId(chosenChannel?.id ?? "");
      setMessagesLoading(Boolean(chosenChannel));
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  }, []);

  const venture = session?.hierarchy.ventures.find((item) => item.id === selectedVentureId);
  const group = venture?.groups.find((item) => item.id === selectedGroupId);
  const selected = group?.channels.find((channel) => channel.id === selectedId);
  const canCreate = session?.membership.role === "admin";

  useEffect(() => {
    if (!createKind) return;
    createDialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeCreate(); return; }
      if (event.key !== "Tab") return;
      const items = createDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])');
      if (!items?.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createKind]);

  useEffect(() => {
    if (!listOpen || createKind) return;
    const navigator = document.querySelector<HTMLElement>('aside[aria-label="Channel navigation"]');
    navigator?.querySelector<HTMLSelectElement>("#channel-venture")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setListOpen(false); listButtonRef.current?.focus(); return; }
      if (event.key !== "Tab") return;
      const items = navigator?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]), input:not([disabled])');
      if (!items?.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen, createKind]);

  useEffect(() => {
    if (!workspaceTab || createKind) return;
    workspaceRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeWorkspace(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaceTab, createKind]);

  useEffect(() => {
    if (!workspaceTab) return;
    const onResize = () => { if (window.innerWidth < 1024) setDetailsOpen(false); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [workspaceTab]);

  useEffect(() => {
    if (!selectedId || !session) return;
    let active = true;
    queueMicrotask(() => { if (active) setMessagesLoading(true); });
    queueMicrotask(() => listLiveChannelMessages(selectedId).then((page) => {
      if (active) { setMessages(page.items); setCursor(page.nextCursor); setMessagesError(""); setMessagesLoading(false); }
    }).catch((cause: unknown) => { if (active) { setMessagesError(errorText(cause)); setMessagesLoading(false); } }));
    return () => { active = false; };
  }, [selectedId, revision, session]);

  useEffect(() => {
    if (!selected?.groupId) return;
    let active = true;
    const groupId = selected.groupId;
    queueMicrotask(() => listLiveMembers({ groupId, limit: 100 }).then((page) => {
      if (active) setMembers(page.items);
    }).catch(() => { if (active) setMembers([]); }));
    return () => { active = false; };
  }, [selected?.groupId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, selectedId]);

  function writeScope(ventureId: string, groupId: string, channelId: string) {
    const next = new URLSearchParams();
    if (ventureId) next.set("venture", ventureId);
    if (groupId) next.set("group", groupId);
    if (channelId) next.set("channel", channelId);
    router.replace(`/channels/live${next.size ? `?${next}` : ""}`, { scroll: false });
  }

  function resetConversation(channelId: string) {
    setSelectedId(channelId); setMessages([]); setCursor(undefined); setMessagesLoading(Boolean(channelId)); setMessagesError(""); setPreview(null); setReplyTo(null); setComposer(""); setMentions([]); setMentionCandidate(""); setMentionOpen(false); setResult(""); setError(""); clientId.current = null;
  }

  function changeVenture(id: string) {
    const nextVenture = session?.hierarchy.ventures.find((item) => item.id === id);
    if (!nextVenture) return;
    const nextGroup = nextVenture.groups[0];
    const nextChannel = nextGroup?.channels[0];
    setSelectedVentureId(id); setSelectedGroupId(nextGroup?.id ?? ""); setRailExpanded(false); setSearch(""); if ((nextChannel?.id ?? "") !== selectedId) resetConversation(nextChannel?.id ?? ""); closeList(); writeScope(id, nextGroup?.id ?? "", nextChannel?.id ?? "");
  }

  function changeGroup(id: string) {
    const nextGroup = venture?.groups.find((item) => item.id === id);
    if (!nextGroup) return;
    const nextChannel = nextGroup.channels[0];
    setSelectedGroupId(id); setRailExpanded(false); setSearch(""); if ((nextChannel?.id ?? "") !== selectedId) resetConversation(nextChannel?.id ?? ""); closeList(); writeScope(selectedVentureId, id, nextChannel?.id ?? "");
  }

  function changeChannel(id: string) {
    if (!group?.channels.some((item) => item.id === id)) return;
    if (id !== selectedId) resetConversation(id); closeList(); writeScope(selectedVentureId, selectedGroupId, id);
  }

  function closeList() { setListOpen(false); if (listOpen) listButtonRef.current?.focus(); }

  function openWorkspace(tab: WorkspaceTab) {
    workspaceReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (window.matchMedia("(max-width: 1023px)").matches) setDetailsOpen(false);
    setWorkspaceTab(tab);
  }

  function closeWorkspace() {
    setWorkspaceTab(null);
    requestAnimationFrame(() => (workspaceReturnRef.current?.getClientRects().length ? workspaceReturnRef.current : detailsButtonRef.current)?.focus());
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = composer.trim();
    if (!selectedId || !body) return;
    setBusy(true); setError(""); setResult(""); setPreview(null);
    try {
      if (body.startsWith("/")) setPreview(await previewLiveCommand({ channelId: selectedId, input: body }));
      else {
        const handles = [...new Set([...body.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9._-]*)/gi)].map((match) => match[1]!.toLowerCase()))];
        const resolved = await Promise.all(handles.map(async (handle) => {
          const page = await listLiveMembers({ groupId: selected?.groupId, handle, limit: 1 });
          const member = page.items[0];
          if (!member || member.handle?.toLowerCase() !== handle) throw new Error(`@${handle} is not an active member of this channel.`);
          return member.id;
        }));
        clientId.current ??= crypto.randomUUID();
        const created = await sendLiveChannelMessage(selectedId, { body, mentionUserIds: [...new Set([...mentions.map((member) => member.id), ...resolved])], clientId: clientId.current, ...(replyTo ? { threadRootId: replyTo.id } : {}) });
        setMessages((items) => items.some((item) => item.id === created.message.id) ? items : [...items, created.message]);
        clientId.current = null; setComposer(""); setMentions([]); setReplyTo(null); setMentionOpen(false);
      }
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function execute() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const executed = await executeLiveCommand({ previewId: preview.previewId, idempotencyKey: preview.previewId }, preview.command.kind);
      setResult(executed.task ? `Task ${executed.task.id} created; its reminder is scheduled.` : `Reminder ${executed.reminder.id} scheduled.`);
      setPreview(null); setComposer(""); setMentions([]);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function more() {
    if (!selectedId || !cursor) return;
    setBusy(true);
    try { const page = await listLiveChannelMessages(selectedId, cursor); setMessages((items) => [...items, ...page.items]); setCursor(page.nextCursor); setError(""); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function updateMessage(item: Message, kind: "reaction" | "save" | "pin") {
    setBusy(true); setError("");
    try {
      const updated = kind === "reaction" ? await updateLiveMessageReaction(item.id, "👍", !(item.myReactions ?? []).includes("👍")) : kind === "save" ? await updateLiveMessageSave(item.id, !item.savedByMe) : await updateLiveMessagePin(item.id, !item.pinned);
      setMessages((items) => items.map((message) => message.id === updated.id ? updated : message));
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  function openCreate(kind: CreateKind, parent = "") {
    if (kind !== "venture" && !parent) return;
    createReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCreateKind(kind); setCreateName(""); setCreateGoal(""); setCreateParent(kind === "venture" ? "" : parent); setError("");
  }

  function closeCreate() {
    setCreateKind(null);
    requestAnimationFrame(() => (createReturnRef.current?.isConnected ? createReturnRef.current : listButtonRef.current)?.focus());
  }

  async function createSpace(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !createKind || !canCreate) return;
    if (!createParentValid) { setError("This parent space is no longer available. Close this dialog and reopen it from the current space."); return; }
    setBusy(true); setError(""); setResult("");
    try {
      let nextVenture = selectedVentureId;
      let nextGroup = selectedGroupId;
      let nextChannel = selectedId;
      let notice = "";
      if (createKind === "venture") {
        const created = await createLiveVenture({ name: createName.trim(), ownerId: session.user.id, goal30Day: createGoal.trim() });
        nextVenture = created.id; nextGroup = ""; nextChannel = "";
        notice = `${created.name} created. Add a group to start its conversations.`;
      } else if (createKind === "group") {
        const created = await createLiveGroup({ ventureId: createParent, name: createName.trim() });
        nextVenture = createParent; nextGroup = created.id;
        nextChannel = created.channels[0]?.id ?? "";
        notice = `${created.name} created with a #general channel.`;
      } else {
        const created = await createLiveChannel({ groupId: createParent, name: createName.trim() });
        const parent = session.hierarchy.ventures.find((item) => item.groups.some((entry) => entry.id === createParent));
        nextVenture = parent?.id ?? selectedVentureId; nextGroup = createParent;
        nextChannel = created.id;
        notice = `#${created.name} created.`;
      }
      setSession(await loadLiveSession());
      setSelectedVentureId(nextVenture); setSelectedGroupId(nextGroup); setRailExpanded(false); setSearch(""); resetConversation(nextChannel); writeScope(nextVenture, nextGroup, nextChannel);
      closeCreate(); setResult(notice);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  const memberName = (id: string) => id === session?.user.id ? session.user.name : members.find((item) => item.id === id)?.name ?? "Member";
  const createVentureParent = session?.hierarchy.ventures.find((item) => item.id === createParent || item.groups.some((entry) => entry.id === createParent));
  const createGroupParent = createVentureParent?.groups.find((item) => item.id === createParent);
  const createParentValid = createKind === "venture" || createKind === null || (createKind === "group" ? createVentureParent?.id === createParent : Boolean(createGroupParent));
  const createScopeLabel = createKind === "group" ? createVentureParent?.name : createKind === "channel" ? `${createGroupParent?.name ?? "Unknown group"} · ${createVentureParent?.name ?? "Unknown venture"}` : "";
  const details = <aside aria-label="Group details" className={clsx("chat-details thin-scroll overflow-y-auto border-l border-[#eeeef1] bg-white p-5", detailsOpen ? "fixed inset-y-0 right-0 z-20 w-[min(320px,92vw)] shadow-2xl lg:static lg:z-auto lg:block lg:w-[290px] lg:shrink-0 lg:shadow-none" : "hidden")}>
    <div className="flex items-center justify-between gap-2"><p className="text-xs font-bold">Group Details</p><button type="button" aria-label="Close details" onClick={() => { setDetailsOpen(false); detailsButtonRef.current?.focus(); }} className="chat-icon"><X size={17} /></button></div>
    {selected ? <><div className="mt-7 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#fff1e7] text-[#f58229]"><Hash size={22} /></span><div><h2 className="text-sm font-bold">#{selected.name}</h2><p className="mt-1 text-[11px] text-[#a1a1aa]">{venture?.name} · {group?.name}</p></div></div><div className="mt-7 border-t border-[#f0f0f2] pt-5"><p className="text-xs font-bold">Members <span className="font-normal text-[#aaaab3]">{members.length}</span></p><div className="mt-3 flex -space-x-2">{members.slice(0, 7).map((member) => <ChatAvatar key={member.id} id={member.id} name={member.name} size={30} />)}</div>{members.length === 0 && <p className="mt-2 text-xs text-[#a2a2ab]">No scoped members listed.</p>}</div><div className="mt-7 border-t border-[#f0f0f2] pt-5"><p className="text-xs font-bold">Pinned messages</p>{messages.filter((item) => item.pinned).slice(0, 3).map((item) => <p key={item.id} className="mt-2 line-clamp-3 rounded-lg bg-[#faf9f8] p-3 text-[11px] leading-5 text-[#62636e]">{item.body}</p>)}{!messages.some((item) => item.pinned) && <p className="mt-2 text-xs text-[#a2a2ab]">No pinned messages yet.</p>}</div><div className="mt-7 space-y-2"><button type="button" onClick={() => openWorkspace("kanban")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[#fff2e8] px-3 text-left text-xs font-semibold text-[#e4781f]"><Columns3 size={16} />Kanban</button><button type="button" onClick={() => openWorkspace("attachments")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[#f6f6f8] px-3 text-left text-xs font-semibold text-[#555560]"><FolderOpen size={16} />Attachments</button><button type="button" onClick={() => openWorkspace("saved")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[#f6f6f8] px-3 text-left text-xs font-semibold text-[#555560]"><Bookmark size={16} />Saved messages</button></div></> : <p className="mt-6 text-xs text-[#999aa4]">Choose a channel to see its details.</p>}
    <div className="mt-8"><ChatCredit /></div>
  </aside>;

  return <ChatShell>
    {listOpen && <button type="button" aria-label="Close channel list" onClick={closeList} className="fixed inset-0 z-10 bg-[#252632]/25 md:!hidden" />}
    <ChannelNavigator session={session} selectedVentureId={selectedVentureId} selectedGroupId={selectedGroupId} selectedChannelId={selectedId} railExpanded={railExpanded} listOpen={listOpen} search={search} realtime={realtime} canCreate={canCreate} onVentureSelect={changeVenture} onGroupSelect={changeGroup} onChannelSelect={changeChannel} onToggleRail={() => setRailExpanded((value) => !value)} onSearch={setSearch} onCreate={openCreate} />
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
    <section className="relative flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-[#eeeef1] px-4 sm:px-6"><button ref={listButtonRef} type="button" aria-label="Open channel list" aria-expanded={listOpen} onClick={() => setListOpen(true)} className="chat-icon md:!hidden"><Menu size={18} /></button><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#fff1e7] text-[#f58229]"><Hash size={17} /></span><div className="min-w-0 flex-1"><h2 className="truncate text-[12px] font-bold">{selected ? `# ${selected.name}` : "Choose a channel"}</h2><p className="truncate text-[10px] text-[#a0a1aa]">{venture?.name}{group ? ` · ${group.name}` : ""}</p></div><button ref={detailsButtonRef} type="button" aria-label={detailsOpen ? "Hide group details" : "Show group details"} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)} className="chat-icon"><Info size={17} /></button><button type="button" aria-label="Refresh messages" onClick={() => setRevision((value) => value + 1)} className="chat-icon"><MoreHorizontal size={18} /></button></header>
      {error && <p role="alert" className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}{result && <p role="status" className="mx-5 mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{result}</p>}
      <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-7">{!session ? <ChatEmpty title="Loading workspace…" detail="Checking your channel access." /> : selected ? messagesLoading ? <ChatEmpty title="Loading messages…" detail={`Opening #${selected.name}.`} /> : messagesError ? <ChatEmpty title="Messages unavailable" detail={messagesError} /> : messages.length ? <>{cursor && <button type="button" disabled={busy} onClick={more} className="mx-auto block min-h-8 text-[11px] font-semibold text-[#e4781f]">Load older messages</button>}<div className="my-2 text-center text-[10px] font-semibold uppercase tracking-[.12em] text-[#b0b0b8]">Channel conversation</div>{messages.map((item) => { const mine = item.authorId === session?.user.id; return <article key={item.id} className={clsx("flex items-end gap-2", mine && "flex-row-reverse")}><ChatAvatar id={item.authorId} name={memberName(item.authorId)} size={25} /><div className={clsx("max-w-[min(78%,620px)]", mine && "text-right")}><div className={clsx("mb-1 flex items-center gap-2 text-[10px]", mine && "flex-row-reverse")}><span className="font-semibold">{mine ? "You" : memberName(item.authorId)}</span><time className="text-[#aaaab3]">{stamp(item.createdAt)}</time>{item.pinned && <span className="text-[#f58229]">Pinned</span>}</div><p className={clsx("inline-block whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-left text-[12px] leading-[1.65]", mine ? "rounded-br-[5px] bg-[#ff8b25] text-white" : "rounded-bl-[5px] border border-[#f0f0f2] bg-white text-[#444450]")}>{item.body}</p><div className={clsx("flex flex-wrap gap-2 text-[10px] text-[#a3a3ac]", mine && "justify-end")}><button type="button" disabled={busy} onClick={() => updateMessage(item, "reaction")} className="min-h-7 hover:text-[#f58229]">👍 {item.reactions?.["👍"] ?? 0}</button><button type="button" disabled={busy} onClick={() => updateMessage(item, "save")} className="min-h-7 hover:text-[#f58229]">{item.savedByMe ? "Saved" : "Save"}</button>{(session?.membership.role === "admin" || session?.membership.role === "venture_head") && <button type="button" disabled={busy} onClick={() => updateMessage(item, "pin")} className="min-h-7 hover:text-[#f58229]">{item.pinned ? "Unpin" : "Pin"}</button>}<button type="button" onClick={() => { setReplyTo(item); setPreview(null); }} className="min-h-7 hover:text-[#f58229]">Reply</button></div></div></article>; })}<div ref={bottomRef} /></> : <ChatEmpty title="A fresh conversation" detail="Send the first update to this channel." />  : <ChatEmpty title={group ? "No channels in this group" : venture ? "Choose a group" : "Choose a venture"} detail={group ? "Create or choose a channel in this group to start a conversation." : "Use the navigator on the left to choose a conversation."} />}</div>
      {preview && <section className="shrink-0 border-t border-[#f3e6db] bg-[#fff8f2] px-4 py-3 sm:px-6"><p className="text-[10px] font-bold uppercase tracking-wider text-[#e4781f]">Review command</p><p className="mt-1 text-xs font-semibold">{preview.command.kind === "assign" ? `Assign “${preview.command.title}” to @${preview.command.assignee}` : `Notify @${preview.command.recipient}: “${preview.command.message}”`}</p><p className="mt-1 text-[10px] text-[#9c9ca5]">{preview.command.kind === "assign" ? `Due ${stamp(preview.command.dueAt)} · ${preview.command.estimatedMinutes} min` : `At ${stamp(preview.command.scheduledAt)}`}</p>{preview.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-amber-700">{warning}</p>)}<div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={execute} className="rounded-lg bg-[#ff8b25] px-3 py-2 text-[11px] font-semibold text-white">Confirm command</button><button type="button" onClick={() => setPreview(null)} className="px-3 py-2 text-[11px] font-semibold text-[#888995]">Cancel</button></div></section>}
      {selected && <form onSubmit={send} className="shrink-0 border-t border-[#eeeef1] bg-white p-3 sm:px-6 sm:py-4">{replyTo && <div className="mb-2 flex items-center justify-between rounded-lg bg-[#fff3ea] px-3 py-2 text-[11px] text-[#8d5633]"><span className="truncate">Replying to: {replyTo.body.slice(0, 70)}</span><button type="button" onClick={() => setReplyTo(null)} className="ml-2 font-bold">Cancel</button></div>}{mentionOpen && <div className="mb-2 rounded-xl border border-[#eeeef1] bg-white p-3 shadow-sm"><LiveMemberPicker label="Mention member" value={mentionCandidate} onChange={(id, member) => { setMentionCandidate(id); if (member) { setMentions((items) => items.some((item) => item.id === member.id) ? items : [...items, member]); setMentionCandidate(""); } }} groupId={selected.groupId} excludeIds={[...(session ? [session.user.id] : []), ...mentions.map((member) => member.id)]} optional /></div>}{mentions.length > 0 && <div className="mb-2 flex flex-wrap gap-1">{mentions.map((member) => <button key={member.id} type="button" onClick={() => setMentions((items) => items.filter((item) => item.id !== member.id))} className="rounded-full bg-[#fff2e8] px-2 py-1 text-[10px] text-[#e4781f]">@{member.handle ?? member.name} ×</button>)}</div>}<div className="flex items-end gap-2 rounded-xl border border-[#e9e9ed] px-3 py-2 focus-within:border-[#ffb56e]"><button type="button" aria-label="Mention a member" title="Mention a member" onClick={() => setMentionOpen((current) => !current)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-[#f58229] hover:bg-[#fff2e8]">@</button><label htmlFor="channel-composer" className="sr-only">Message or slash command</label><textarea id="channel-composer" maxLength={10000} rows={1} value={composer} onChange={(event) => { setComposer(event.target.value); setPreview(null); clientId.current = null; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} className="min-h-8 max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-[#aaaab3]" placeholder="Type a message, /assign or /notify..." /><button type="submit" disabled={busy || !composer.trim()} aria-label={composer.trim().startsWith("/") ? "Preview command" : "Send message"} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#ff8b25] text-white transition-colors hover:bg-[#ed7619] disabled:opacity-40"><Send size={15} /></button></div></form>}
    </section>
    {details}
    {workspaceTab && <div ref={workspaceRef} className="contents"><GroupWorkspaceSheet tab={workspaceTab} onTabChange={setWorkspaceTab} onClose={closeWorkspace} ventureId={venture?.id ?? ""} ventureName={venture?.name ?? ""} group={group} userId={session?.user.id ?? ""} role={session?.membership.role ?? ""} onSavedChange={(changed) => setMessages((items) => items.map((item) => item.id === changed.id ? changed : item))} /></div>}
    </div>
    {createKind && <div className="fixed inset-0 z-30 grid place-items-center bg-[#272736]/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}><section ref={createDialogRef} role="dialog" aria-modal="true" aria-label={`Create ${createKind}`} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center justify-between"><h2 className="text-base font-bold">Create {createKind}</h2><button type="button" aria-label="Close" onClick={closeCreate} className="chat-icon"><X size={18} /></button></div><p className="mt-2 text-xs leading-5 text-[#9798a3]">{createKind === "venture" ? "Add a venture to this workspace." : createKind === "group" ? "Add a group to this venture. A #general channel is created automatically." : "Add a channel to this group."}</p><form onSubmit={createSpace} className="mt-5 space-y-4">{createKind !== "venture" && <div aria-label="Creation scope" className="rounded-lg bg-[#f6f6f8] px-3 py-2.5"><p className="text-[10px] font-semibold uppercase tracking-[.08em] text-[#999aa4]">{createKind === "group" ? "Venture" : "Group · Venture"}</p><p className="mt-1 text-xs font-bold text-[#393944]">In {createScopeLabel}</p></div>}<label className="block text-xs font-semibold">Name<input required maxLength={createKind === "channel" ? 80 : 120} value={createName} onChange={(event) => setCreateName(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-[#e6e6eb] px-3 text-xs outline-none focus:border-[#ffb56e]" placeholder={createKind === "channel" ? "product-updates" : createKind === "group" ? "Product team" : "New venture"} /></label>{createKind === "venture" && <label className="block text-xs font-semibold">30-day goal <span className="font-normal text-[#aaaab3]">(optional)</span><textarea maxLength={500} value={createGoal} onChange={(event) => setCreateGoal(event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-[#e6e6eb] p-3 text-xs outline-none focus:border-[#ffb56e]" placeholder="What will this venture achieve next?" /></label>}{!createParentValid && <p role="alert" className="text-xs text-red-700">This parent space is unavailable. Reopen creation from the current space.</p>}{error && <p role="alert" className="text-xs text-red-700">{error}</p>}<div className="flex justify-end gap-2 pt-2"><button type="button" onClick={closeCreate} className="min-h-10 rounded-lg px-4 text-xs font-semibold text-[#777883]">Cancel</button><button type="submit" disabled={busy || !createName.trim() || !createParentValid} className="min-h-10 rounded-lg bg-[#ff8b25] px-4 text-xs font-semibold text-white disabled:opacity-50">Create {createKind}</button></div></form></section></div>}
  </ChatShell>;
}
