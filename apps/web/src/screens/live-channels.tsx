"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bookmark, Columns3, FolderOpen, Hash, Info, Menu, MoreHorizontal, Send, X } from "@/components/ui/icons";
import clsx from "clsx";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { CommandPreview, Message } from "@venture-studio/contracts";
import { createLiveChannel, createLiveGroup, createLiveVenture, executeLiveCommand, listLiveChannelMessages, listLiveMembers, loadLiveSession, previewLiveCommand, sendLiveChannelMessage, updateLiveMessagePin, updateLiveMessageReaction, updateLiveMessageSave } from "@/lib/studio-api";
import { ChatAvatar, ChatCredit, ChatEmpty, ChatShell } from "@/components/studio/chat-ui";
import { ChannelNavigator } from "@/components/studio/channel-navigator";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { GroupWorkspaceSheet, type WorkspaceTab } from "@/components/studio/group-workspace-sheet";
import { GroupPeople } from "@/components/studio/group-people";
import { AttachmentPicker, MessageAttachmentList, messageAttachments, useChatAttachments } from "@/components/studio/chat-attachments";
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
  const [memberState, setMemberState] = useState<{ groupId: string; items: Member[]; loading: boolean; error: string }>({ groupId: "", items: [], loading: false, error: "" });
  const [memberRevision, setMemberRevision] = useState(0);
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
  const activeConversationId = useRef(selectedId);
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
  const attachments = useChatAttachments(selectedId, selected ? { ventureId: selectedVentureId, groupId: selectedGroupId } : null);
  useEffect(() => { activeConversationId.current = selectedId; }, [selectedId]);
  const activeGroupId = group?.id ?? "";
  const members = memberState.groupId === activeGroupId ? memberState.items : [];
  const membersLoading = Boolean(activeGroupId) && (memberState.groupId !== activeGroupId || memberState.loading);
  const membersError = memberState.groupId === activeGroupId ? memberState.error : "";
  const canCreate = session?.membership.role === "admin";

  useEffect(() => {
    if (!createKind) return;
    createDialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('[role="combobox"]'))) return; closeCreate(); return; }
      if (event.key !== "Tab") return;
      const items = createDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), input:not([disabled]), textarea:not([disabled])');
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
      if (event.key === "Escape") { if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('[role="combobox"]'))) return; setListOpen(false); listButtonRef.current?.focus(); return; }
      if (event.key !== "Tab") return;
      const items = navigator?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), input:not([disabled])');
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
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof HTMLElement && event.target.closest('[role="combobox"]'))) closeWorkspace(); };
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
    if (!group?.id) return;
    let active = true;
    const groupId = group.id;
    queueMicrotask(async () => {
      if (!active) return;
      setMemberState({ groupId, items: [], loading: true, error: "" });
      try {
        const items: Member[] = [];
        let cursor: string | undefined;
        do {
          const page = await listLiveMembers({ groupId, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!active) return;
          items.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        if (active) setMemberState({ groupId, items, loading: false, error: "" });
      } catch (cause) { if (active) setMemberState({ groupId, items: [], loading: false, error: errorText(cause) }); }
    });
    return () => { active = false; };
  }, [group?.id, memberRevision]);

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
    if (!selectedId || busy || (!body && !attachments.items.length) || attachments.uploading) return;
    setBusy(true); setError(""); setResult(""); setPreview(null);
    try {
      if (body.startsWith("/")) {
        if (attachments.items.length) throw new Error("Send attachments separately from slash commands.");
        setPreview(await previewLiveCommand({ channelId: selectedId, input: body }));
      }
      else {
        const handles = [...new Set([...body.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9._-]*)/gi)].map((match) => match[1]!.toLowerCase()))];
        const resolved = await Promise.all(handles.map(async (handle) => {
          const page = await listLiveMembers({ groupId: selected?.groupId, handle, limit: 1 });
          const member = page.items[0];
          if (!member || member.handle?.toLowerCase() !== handle) throw new Error(`@${handle} is not an active member of this channel.`);
          return member.id;
        }));
        clientId.current ??= crypto.randomUUID();
        const created = await sendLiveChannelMessage(selectedId, { body, attachmentFileIds: attachments.items.map((file) => file.id), mentionUserIds: [...new Set([...mentions.map((member) => member.id), ...resolved])], clientId: clientId.current, ...(replyTo ? { threadRootId: replyTo.id } : {}) });
        if (activeConversationId.current === selectedId) {
          setMessages((items) => items.some((item) => item.id === created.message.id) ? items : [...items, created.message]);
          clientId.current = null; setComposer(""); setMentions([]); setReplyTo(null); setMentionOpen(false); attachments.clear();
        }
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
  const details = <aside aria-label="Group details" className={clsx("chat-details thin-scroll overflow-y-auto border-l border-[var(--color-neutral-200)] bg-white p-5", detailsOpen ? "fixed inset-y-0 right-0 z-20 w-[min(320px,92vw)] shadow-2xl vso-enter-right lg:animate-none! lg:static lg:z-auto lg:block lg:w-[290px] lg:shrink-0 lg:shadow-none" : "hidden")}>
    <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold">Group Details</p><button type="button" aria-label="Close details" onClick={() => { setDetailsOpen(false); detailsButtonRef.current?.focus(); }} className="chat-icon"><X size={17} /></button></div>
    {group ? <>
      <div className="mt-7 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--color-primary-100)] text-[var(--color-primary-600)]"><Hash size={22} /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{group.name}</h2><p className="mt-1 truncate text-[11px] text-[var(--color-neutral-400)]">{venture?.name}{selected ? ` · #${selected.name}` : ""}</p></div></div>
      <GroupPeople key={group.id} ventureId={venture?.id ?? ""} ventureName={venture?.name ?? ""} groupId={group.id} groupName={group.name} members={members} loading={membersLoading} error={membersError} canManage={canCreate} onOpen={() => setWorkspaceTab(null)} onRefresh={() => setMemberRevision((value) => value + 1)} />
      <div className="mt-7 border-t border-[var(--color-neutral-100)] pt-5"><p className="text-xs font-semibold">Pinned messages</p>{messages.filter((item) => item.pinned).slice(0, 3).map((item) => <p key={item.id} className="mt-2 line-clamp-3 rounded-lg bg-[var(--color-neutral-50)] p-3 text-[11px] leading-5 text-[var(--color-neutral-600)]">{item.body}</p>)}{!messages.some((item) => item.pinned) && <p className="mt-2 text-xs text-[var(--color-neutral-400)]">No pinned messages yet.</p>}</div>
      <div className="mt-7 space-y-2"><button type="button" onClick={() => openWorkspace("kanban")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[var(--color-primary-100)] px-3 text-left text-xs font-semibold text-[var(--color-primary-700)]"><Columns3 size={16} />Kanban</button><button type="button" onClick={() => openWorkspace("attachments")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[var(--color-neutral-100)] px-3 text-left text-xs font-semibold text-[var(--color-neutral-700)]"><FolderOpen size={16} />Attachments</button><button type="button" onClick={() => openWorkspace("saved")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[var(--color-neutral-100)] px-3 text-left text-xs font-semibold text-[var(--color-neutral-700)]"><Bookmark size={16} />Saved messages</button></div>
    </> : <p className="mt-6 text-xs text-[var(--color-neutral-400)]">Choose a group to see its details.</p>}
    <div className="mt-8"><ChatCredit /></div>
  </aside>;

  return <ChatShell ready={Boolean(error) || (Boolean(session) && !messagesLoading)}>
    {listOpen && <button type="button" aria-label="Close channel list" onClick={closeList} className="fixed inset-0 z-10 bg-[var(--color-neutral-900)]/25 md:!hidden" />}
    <ChannelNavigator session={session} selectedVentureId={selectedVentureId} selectedGroupId={selectedGroupId} selectedChannelId={selectedId} railExpanded={railExpanded} listOpen={listOpen} search={search} realtime={realtime} canCreate={canCreate} onVentureSelect={changeVenture} onGroupSelect={changeGroup} onChannelSelect={changeChannel} onToggleRail={() => setRailExpanded((value) => !value)} onSearch={setSearch} onCreate={openCreate} />
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
    <section className="relative flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-[var(--color-neutral-200)] px-4 sm:px-6"><button ref={listButtonRef} type="button" aria-label="Open channel list" aria-expanded={listOpen} onClick={() => setListOpen(true)} className="chat-icon md:!hidden"><Menu size={18} /></button><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-600)]"><Hash size={17} /></span><div className="min-w-0 flex-1"><h2 className="truncate text-[12px] font-semibold">{selected ? `# ${selected.name}` : "Choose a channel"}</h2><p className="truncate text-[10px] text-[var(--color-neutral-400)]">{venture?.name}{group ? ` · ${group.name}` : ""}</p></div><ThemeToggle /><button ref={detailsButtonRef} type="button" aria-label={detailsOpen ? "Hide group details" : "Show group details"} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)} className="chat-icon"><Info size={17} /></button><button type="button" aria-label="Refresh messages" onClick={() => setRevision((value) => value + 1)} className="chat-icon"><MoreHorizontal size={18} /></button></header>
      {error && <p role="alert" className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}{result && <p role="status" className="mx-5 mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{result}</p>}
      <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-7">{!session ? <ChatEmpty title="Loading workspace…" detail="Checking your channel access." /> : selected ? messagesLoading ? <ChatEmpty title="Loading messages…" detail={`Opening #${selected.name}.`} /> : messagesError ? <ChatEmpty title="Messages unavailable" detail={messagesError} /> : messages.length ? <>{cursor && <button type="button" disabled={busy} onClick={more} className="mx-auto block min-h-8 text-[11px] font-semibold text-[var(--color-primary-700)]">Load older messages</button>}<div className="my-2 text-center text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--color-neutral-400)]">Channel conversation</div>{messages.map((item) => { const mine = item.authorId === session?.user.id; return <article key={item.id} className={clsx("flex items-end gap-2", mine && "flex-row-reverse")}><ChatAvatar id={item.authorId} name={memberName(item.authorId)} size={25} /><div className={clsx("max-w-[min(78%,620px)]", mine && "text-right")}><div className={clsx("mb-1 flex items-center gap-2 text-[10px]", mine && "flex-row-reverse")}><span className="font-semibold">{mine ? "You" : memberName(item.authorId)}</span><time className="text-[var(--color-neutral-400)]">{stamp(item.createdAt)}</time>{item.pinned && <span className="text-[var(--color-primary-600)]">Pinned</span>}</div>{item.body && <p className={clsx("inline-block whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-left text-[12px] leading-[1.65]", mine ? "rounded-br-[5px] bg-[var(--color-primary-600)] text-white" : "rounded-bl-[5px] border border-[var(--color-neutral-100)] bg-white text-[var(--color-neutral-700)]")}>{item.body}</p>}<MessageAttachmentList files={messageAttachments(item)} /><div className={clsx("flex flex-wrap gap-2 text-[10px] text-[var(--color-neutral-400)]", mine && "justify-end")}><button type="button" disabled={busy} onClick={() => updateMessage(item, "reaction")} className="min-h-7 hover:text-[var(--color-primary-600)]">👍 {item.reactions?.["👍"] ?? 0}</button><button type="button" disabled={busy} onClick={() => updateMessage(item, "save")} className="min-h-7 hover:text-[var(--color-primary-600)]">{item.savedByMe ? "Saved" : "Save"}</button>{(session?.membership.role === "admin" || session?.membership.role === "venture_head") && <button type="button" disabled={busy} onClick={() => updateMessage(item, "pin")} className="min-h-7 hover:text-[var(--color-primary-600)]">{item.pinned ? "Unpin" : "Pin"}</button>}<button type="button" onClick={() => { setReplyTo(item); setPreview(null); }} className="min-h-7 hover:text-[var(--color-primary-600)]">Reply</button></div></div></article>; })}<div ref={bottomRef} /></> : <ChatEmpty title="A fresh conversation" detail="Send the first update to this channel." />  : <ChatEmpty title={group ? "No channels in this group" : venture ? "Choose a group" : "Choose a venture"} detail={group ? "Create or choose a channel in this group to start a conversation." : "Use the navigator on the left to choose a conversation."} />}</div>
      {preview && <section className="shrink-0 border-t border-[var(--color-primary-200)] bg-[var(--color-primary-50)] px-4 py-3 sm:px-6"><p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-primary-700)]">Review command</p><p className="mt-1 text-xs font-semibold">{preview.command.kind === "assign" ? `Assign “${preview.command.title}” to @${preview.command.assignee}` : `Notify @${preview.command.recipient}: “${preview.command.message}”`}</p><p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{preview.command.kind === "assign" ? `Due ${stamp(preview.command.dueAt)} · ${preview.command.estimatedMinutes} min` : `At ${stamp(preview.command.scheduledAt)}`}</p>{preview.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-amber-700">{warning}</p>)}<div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={execute} className="rounded-lg bg-[var(--color-primary-600)] px-3 py-2 text-[11px] font-semibold text-white">Confirm command</button><button type="button" onClick={() => setPreview(null)} className="px-3 py-2 text-[11px] font-semibold text-[var(--color-neutral-500)]">Cancel</button></div></section>}
      {selected && <form onSubmit={send} className="shrink-0 border-t border-[var(--color-neutral-200)] bg-white p-3 sm:px-6 sm:py-4">{replyTo && <div className="mb-2 flex items-center justify-between rounded-lg bg-[var(--color-primary-50)] px-3 py-2 text-[11px] text-[var(--color-primary-800)]"><span className="truncate">Replying to: {replyTo.body.slice(0, 70)}</span><button type="button" onClick={() => setReplyTo(null)} className="ml-2 font-bold">Cancel</button></div>}{mentionOpen && <div className="mb-2 rounded-xl border border-[var(--color-neutral-200)] bg-white p-3 shadow-sm"><LiveMemberPicker label="Mention member" value={mentionCandidate} onChange={(id, member) => { setMentionCandidate(id); if (member) { setMentions((items) => items.some((item) => item.id === member.id) ? items : [...items, member]); setMentionCandidate(""); } }} groupId={selected.groupId} excludeIds={[...(session ? [session.user.id] : []), ...mentions.map((member) => member.id)]} optional /></div>}{mentions.length > 0 && <div className="mb-2 flex flex-wrap gap-1">{mentions.map((member) => <button key={member.id} type="button" onClick={() => setMentions((items) => items.filter((item) => item.id !== member.id))} className="rounded-full bg-[var(--color-primary-100)] px-2 py-1 text-[10px] text-[var(--color-primary-700)]">@{member.handle ?? member.name} ×</button>)}</div>}<div className="mb-2"><AttachmentPicker attachments={attachments} scopeLabel={`#${selected.name}`} disabled={busy} /></div><div className="flex items-end gap-2 rounded-xl border border-[var(--color-neutral-200)] px-3 py-2 focus-within:border-[var(--color-primary-400)]"><button type="button" aria-label="Mention a member" title="Mention a member" onClick={() => setMentionOpen((current) => !current)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-semibold text-[var(--color-primary-600)] hover:bg-[var(--color-primary-100)]">@</button><label htmlFor="channel-composer" className="sr-only">Message or slash command</label><textarea id="channel-composer" maxLength={10000} rows={1} value={composer} onChange={(event) => { setComposer(event.target.value); setPreview(null); clientId.current = null; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} className="min-h-8 max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-[var(--color-neutral-400)]" placeholder="Type a message, /assign or /notify..." /><button type="submit" disabled={busy || attachments.uploading || (!composer.trim() && !attachments.items.length)} aria-label={composer.trim().startsWith("/") ? "Preview command" : "Send message"} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-600)] text-white transition-colors hover:bg-[var(--color-primary-600)] disabled:opacity-40"><Send size={15} /></button></div></form>}
    </section>
    {details}
    {workspaceTab && <div ref={workspaceRef} className="contents"><GroupWorkspaceSheet tab={workspaceTab} onTabChange={setWorkspaceTab} onClose={closeWorkspace} ventureId={venture?.id ?? ""} ventureName={venture?.name ?? ""} group={group} userId={session?.user.id ?? ""} role={session?.membership.role ?? ""} onSavedChange={(changed) => setMessages((items) => items.map((item) => item.id === changed.id ? changed : item))} /></div>}
    </div>
    {createKind && <div className="fixed inset-0 z-30 grid place-items-center bg-[#272736]/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}><section ref={createDialogRef} role="dialog" aria-modal="true" aria-label={`Create ${createKind}`} className="vso-enter-modal w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center justify-between"><h2 className="text-base font-bold">Create {createKind}</h2><button type="button" aria-label="Close" onClick={closeCreate} className="chat-icon"><X size={18} /></button></div><p className="mt-2 text-xs leading-5 text-[var(--color-neutral-400)]">{createKind === "venture" ? "Add a venture to this workspace." : createKind === "group" ? "Add a group to this venture. A #general channel is created automatically." : "Add a channel to this group."}</p><form onSubmit={createSpace} className="mt-5 space-y-4">{createKind !== "venture" && <div aria-label="Creation scope" className="rounded-lg bg-[var(--color-neutral-100)] px-3 py-2.5"><p className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--color-neutral-400)]">{createKind === "group" ? "Venture" : "Group · Venture"}</p><p className="mt-1 text-xs font-semibold text-[var(--color-neutral-700)]">In {createScopeLabel}</p></div>}<label className="block text-xs font-semibold">Name<input required maxLength={createKind === "channel" ? 80 : 120} value={createName} onChange={(event) => setCreateName(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-neutral-200)] px-3 text-xs outline-none focus:border-[var(--color-primary-400)]" placeholder={createKind === "channel" ? "product-updates" : createKind === "group" ? "Product team" : "New venture"} /></label>{createKind === "venture" && <label className="block text-xs font-semibold">30-day goal <span className="font-normal text-[var(--color-neutral-400)]">(optional)</span><textarea maxLength={500} value={createGoal} onChange={(event) => setCreateGoal(event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-[var(--color-neutral-200)] p-3 text-xs outline-none focus:border-[var(--color-primary-400)]" placeholder="What will this venture achieve next?" /></label>}{!createParentValid && <p role="alert" className="text-xs text-red-700">This parent space is unavailable. Reopen creation from the current space.</p>}{error && <p role="alert" className="text-xs text-red-700">{error}</p>}<div className="flex justify-end gap-2 pt-2"><button type="button" onClick={closeCreate} className="min-h-10 rounded-lg px-4 text-xs font-semibold text-[var(--color-neutral-500)]">Cancel</button><button type="submit" disabled={busy || !createName.trim() || !createParentValid} className="min-h-10 rounded-lg bg-[var(--color-primary-600)] px-4 text-xs font-semibold text-white disabled:opacity-50">Create {createKind}</button></div></form></section></div>}
  </ChatShell>;
}
