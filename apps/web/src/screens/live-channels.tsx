"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Hash, Info, Menu, MoreHorizontal, Plus, Send, X } from "lucide-react";
import clsx from "clsx";
import type { CommandPreview, Message } from "@venture-studio/contracts";
import { createLiveChannel, createLiveGroup, createLiveVenture, executeLiveCommand, listLiveChannelMessages, listLiveMembers, loadLiveSession, previewLiveCommand, sendLiveChannelMessage, updateLiveMessagePin, updateLiveMessageReaction, updateLiveMessageSave } from "@/lib/studio-api";
import { ChatAvatar, ChatCredit, ChatEmpty, ChatNav, ChatSearch, ChatShell } from "@/components/studio/chat-ui";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { useLiveRealtime } from "@/lib/use-live-realtime";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
type CreateKind = "venture" | "group" | "channel";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Please try again.";
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function LiveChannelsScreen() {
  const params = useSearchParams();
  const [session, setSession] = useState<Session | null>(null);
  const [selectedId, setSelectedId] = useState(params.get("channel") ?? "");
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [listOpen, setListOpen] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [createName, setCreateName] = useState("");
  const [createGoal, setCreateGoal] = useState("");
  const [createParent, setCreateParent] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const clientId = useRef<string | null>(null);
  const realtime = useLiveRealtime(() => setRevision((value) => value + 1), selectedId || undefined);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => {
      if (!active) return;
      setSession(value);
      const available = value.hierarchy.ventures.flatMap((venture) => venture.groups.flatMap((group) => group.channels));
      setSelectedId((current) => available.some((channel) => channel.id === current) ? current : available[0]?.id ?? "");
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  }, []);

  const channels = session?.hierarchy.ventures.flatMap((venture) => venture.groups.flatMap((group) => group.channels)) ?? [];
  const groups = session?.hierarchy.ventures.flatMap((venture) => venture.groups) ?? [];
  const selected = channels.find((channel) => channel.id === selectedId);
  const group = groups.find((item) => item.id === selected?.groupId);
  const venture = session?.hierarchy.ventures.find((item) => item.id === selected?.ventureId);
  const canCreate = session?.membership.role === "admin";

  useEffect(() => {
    if (!createKind) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setCreateKind(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createKind]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    queueMicrotask(() => listLiveChannelMessages(selectedId).then((page) => {
      if (active) { setMessages(page.items); setCursor(page.nextCursor); setError(""); }
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  }, [selectedId, revision]);

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

  function changeChannel(id: string) {
    setSelectedId(id); setListOpen(false); setMessages([]); setPreview(null); setReplyTo(null); setComposer(""); setMentions([]); setMentionCandidate(""); setResult(""); clientId.current = null;
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
    setCreateKind(kind); setCreateName(""); setCreateGoal(""); setCreateParent(parent || (kind === "group" ? session?.hierarchy.ventures[0]?.id : kind === "channel" ? groups[0]?.id : "") || ""); setError("");
  }

  async function createSpace(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !createKind || !canCreate) return;
    setBusy(true); setError(""); setResult("");
    try {
      let nextChannel = "";
      let notice = "";
      if (createKind === "venture") {
        const created = await createLiveVenture({ name: createName.trim(), ownerId: session.user.id, goal30Day: createGoal.trim() });
        notice = `${created.name} created. Add a group to start its conversations.`;
      } else if (createKind === "group") {
        const created = await createLiveGroup({ ventureId: createParent, name: createName.trim() });
        nextChannel = created.channels[0]?.id ?? "";
        notice = `${created.name} created with a #general channel.`;
      } else {
        const created = await createLiveChannel({ groupId: createParent, name: createName.trim() });
        nextChannel = created.id;
        notice = `#${created.name} created.`;
      }
      setSession(await loadLiveSession());
      if (nextChannel) changeChannel(nextChannel);
      setCreateKind(null); setResult(notice);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  const memberName = (id: string) => id === session?.user.id ? session.user.name : members.find((item) => item.id === id)?.name ?? "Member";
  const details = <aside className={clsx("chat-details thin-scroll border-l border-[#eeeef1] bg-white p-5 xl:w-[290px] xl:shrink-0", detailsOpen ? "fixed inset-y-0 right-0 z-20 w-[min(320px,92vw)] shadow-2xl xl:static xl:shadow-none" : "hidden xl:block")}>
    <div className="flex items-center justify-between"><p className="text-xs font-bold">Group Details</p><button type="button" aria-label="Close details" onClick={() => setDetailsOpen(false)} className="chat-icon xl:!hidden"><X size={17} /></button></div>
    {selected ? <><div className="mt-7 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#fff1e7] text-[#f58229]"><Hash size={22} /></span><div><h2 className="text-sm font-bold">#{selected.name}</h2><p className="mt-1 text-[11px] text-[#a1a1aa]">{venture?.name} · {group?.name}</p></div></div><div className="mt-7 border-t border-[#f0f0f2] pt-5"><p className="text-xs font-bold">Members <span className="font-normal text-[#aaaab3]">{members.length}</span></p><div className="mt-3 flex -space-x-2">{members.slice(0, 7).map((member) => <ChatAvatar key={member.id} id={member.id} name={member.name} size={30} />)}</div>{members.length === 0 && <p className="mt-2 text-xs text-[#a2a2ab]">No scoped members listed.</p>}</div><div className="mt-7 border-t border-[#f0f0f2] pt-5"><p className="text-xs font-bold">Pinned messages</p>{messages.filter((item) => item.pinned).slice(0, 3).map((item) => <p key={item.id} className="mt-2 line-clamp-3 rounded-lg bg-[#faf9f8] p-3 text-[11px] leading-5 text-[#62636e]">{item.body}</p>)}{!messages.some((item) => item.pinned) && <p className="mt-2 text-xs text-[#a2a2ab]">No pinned messages yet.</p>}</div><Link href={`/board/live?group=${encodeURIComponent(selected.groupId)}`} className="mt-7 flex min-h-10 items-center justify-between rounded-lg bg-[#fff2e8] px-3 text-xs font-semibold text-[#e4781f]">View Kanban board →</Link></> : <p className="mt-6 text-xs text-[#999aa4]">Choose a channel to see its details.</p>}
    <div className="mt-8"><ChatCredit /></div>
  </aside>;

  return <ChatShell>
    {listOpen && <button type="button" aria-label="Close channel list" onClick={() => setListOpen(false)} className="fixed inset-0 z-10 bg-[#252632]/25 md:!hidden" />}
    <aside className={clsx("chat-list w-[min(282px,85vw)] shrink-0 flex-col border-r border-[#eeeef1] bg-white max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:shadow-xl md:flex md:w-[240px] xl:w-[282px]", listOpen ? "flex" : "hidden")}>
      <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-[#f0f0f2] px-3 sm:px-5"><ChatNav mode="channels" /><span className="hidden text-[10px] font-semibold text-[#b1b1b9] xl:block">VENTURE STUDIO</span></div>
      <div className="px-3 pb-3 pt-5 sm:px-5"><div className="mb-4 flex items-center justify-between"><h1 className="text-[15px] font-bold tracking-tight">Channels</h1>{canCreate && <button type="button" aria-label="Create venture, group or channel" title="Create space" onClick={() => openCreate("channel")} className="chat-icon"><Plus size={17} /></button>}</div><ChatSearch value={search} onChange={setSearch} placeholder="Search channels..." /></div>
      {canCreate && <div className="flex flex-wrap gap-1 px-3 pb-3 sm:px-5"><button type="button" onClick={() => openCreate("venture")} className="rounded-full bg-[#fff2e8] px-2 py-1.5 text-[10px] font-semibold text-[#e4781f]">+ Venture</button><button type="button" onClick={() => openCreate("group")} className="rounded-full bg-[#fff2e8] px-2 py-1.5 text-[10px] font-semibold text-[#e4781f]">+ Group</button><button type="button" onClick={() => openCreate("channel")} className="rounded-full bg-[#fff2e8] px-2 py-1.5 text-[10px] font-semibold text-[#e4781f]">+ Channel</button></div>}
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-5">{session?.hierarchy.ventures.map((item) => <div key={item.id} className="mb-4"><div className="flex items-center justify-between px-3 py-2"><p className="truncate text-[11px] font-bold text-[#393944]">{item.name}</p>{canCreate && <button type="button" aria-label={`Add group to ${item.name}`} title="Add group" onClick={() => openCreate("group", item.id)} className="text-[#b0b0b8] hover:text-[#f58229]"><Plus size={13} /></button>}</div>{item.groups.map((entry) => <div key={entry.id}><div className="flex items-center justify-between px-3 py-1"><p className="truncate text-[9px] font-semibold uppercase tracking-[.08em] text-[#a2a2ad]">{entry.name}</p>{canCreate && <button type="button" aria-label={`Add channel to ${entry.name}`} title="Add channel" onClick={() => openCreate("channel", entry.id)} className="text-[#b0b0b8] hover:text-[#f58229]"><Plus size={12} /></button>}</div>{entry.channels.filter((channel) => channel.name.toLowerCase().includes(search.toLowerCase())).map((channel) => <button key={channel.id} type="button" onClick={() => changeChannel(channel.id)} className={clsx("my-0.5 flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-[11px] font-medium transition-colors hover:bg-[#faf8f7]", selectedId === channel.id ? "bg-[#fff2e8] font-semibold text-[#e4781f]" : "text-[#666773]")}><Hash size={14} className="shrink-0" /><span className="truncate">{channel.name}</span></button>)}</div>)}</div>)}{session && channels.length === 0 && <p className="px-3 py-6 text-xs text-[#999aa4]">No channels yet. {canCreate ? "Create a venture or group to begin." : "Ask an admin to add you to a group."}</p>}</div>
      {session && <div className="flex items-center gap-2 border-t border-[#f0f0f2] px-3 py-3 sm:px-5"><ChatAvatar id={session.user.id} name={session.user.name} size={30} /><span className="min-w-0 truncate text-[10px] font-semibold">{session.user.name}</span><span className="ml-auto hidden text-[9px] text-[#9b9ca6] sm:inline">{realtime === "live" ? "Live" : "Offline"}</span></div>}
    </aside>
    <section className="relative flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-[#eeeef1] px-4 sm:px-6"><button type="button" aria-label="Open channel list" onClick={() => setListOpen(true)} className="chat-icon md:!hidden"><Menu size={18} /></button><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#fff1e7] text-[#f58229]"><Hash size={17} /></span><div className="min-w-0 flex-1"><h2 className="truncate text-[12px] font-bold">{selected ? `# ${selected.name}` : "Choose a channel"}</h2><p className="truncate text-[10px] text-[#a0a1aa]">{venture?.name}{group ? ` · ${group.name}` : ""}</p></div><button type="button" aria-label="Show group details" onClick={() => setDetailsOpen(true)} className="chat-icon"><Info size={17} /></button><button type="button" aria-label="Refresh messages" onClick={() => setRevision((value) => value + 1)} className="chat-icon"><MoreHorizontal size={18} /></button></header>
      {error && <p role="alert" className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}{result && <p role="status" className="mx-5 mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{result}</p>}
      <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-7">{selected ? messages.length ? <>{cursor && <button type="button" disabled={busy} onClick={more} className="mx-auto block min-h-8 text-[11px] font-semibold text-[#e4781f]">Load older messages</button>}<div className="my-2 text-center text-[10px] font-semibold uppercase tracking-[.12em] text-[#b0b0b8]">Channel conversation</div>{messages.map((item) => { const mine = item.authorId === session?.user.id; return <article key={item.id} className={clsx("flex items-end gap-2", mine && "flex-row-reverse")}><ChatAvatar id={item.authorId} name={memberName(item.authorId)} size={25} /><div className={clsx("max-w-[min(78%,620px)]", mine && "text-right")}><div className={clsx("mb-1 flex items-center gap-2 text-[10px]", mine && "flex-row-reverse")}><span className="font-semibold">{mine ? "You" : memberName(item.authorId)}</span><time className="text-[#aaaab3]">{stamp(item.createdAt)}</time>{item.pinned && <span className="text-[#f58229]">Pinned</span>}</div><p className={clsx("inline-block whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-left text-[12px] leading-[1.65]", mine ? "rounded-br-[5px] bg-[#ff8b25] text-white" : "rounded-bl-[5px] border border-[#f0f0f2] bg-white text-[#444450]")}>{item.body}</p><div className={clsx("flex flex-wrap gap-2 text-[10px] text-[#a3a3ac]", mine && "justify-end")}><button type="button" disabled={busy} onClick={() => updateMessage(item, "reaction")} className="min-h-7 hover:text-[#f58229]">👍 {item.reactions?.["👍"] ?? 0}</button><button type="button" disabled={busy} onClick={() => updateMessage(item, "save")} className="min-h-7 hover:text-[#f58229]">{item.savedByMe ? "Saved" : "Save"}</button>{(session?.membership.role === "admin" || session?.membership.role === "venture_head") && <button type="button" disabled={busy} onClick={() => updateMessage(item, "pin")} className="min-h-7 hover:text-[#f58229]">{item.pinned ? "Unpin" : "Pin"}</button>}<button type="button" onClick={() => { setReplyTo(item); setPreview(null); }} className="min-h-7 hover:text-[#f58229]">Reply</button></div></div></article>; })}<div ref={bottomRef} /></> : <ChatEmpty title="A fresh conversation" detail="Send the first update to this channel." /> : <ChatEmpty title="Choose a channel" detail="Find a venture and group on the left to join its conversation." />}</div>
      {preview && <section className="shrink-0 border-t border-[#f3e6db] bg-[#fff8f2] px-4 py-3 sm:px-6"><p className="text-[10px] font-bold uppercase tracking-wider text-[#e4781f]">Review command</p><p className="mt-1 text-xs font-semibold">{preview.command.kind === "assign" ? `Assign “${preview.command.title}” to @${preview.command.assignee}` : `Notify @${preview.command.recipient}: “${preview.command.message}”`}</p><p className="mt-1 text-[10px] text-[#9c9ca5]">{preview.command.kind === "assign" ? `Due ${stamp(preview.command.dueAt)} · ${preview.command.estimatedMinutes} min` : `At ${stamp(preview.command.scheduledAt)}`}</p>{preview.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-amber-700">{warning}</p>)}<div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={execute} className="rounded-lg bg-[#ff8b25] px-3 py-2 text-[11px] font-semibold text-white">Confirm command</button><button type="button" onClick={() => setPreview(null)} className="px-3 py-2 text-[11px] font-semibold text-[#888995]">Cancel</button></div></section>}
      {selected && <form onSubmit={send} className="shrink-0 border-t border-[#eeeef1] bg-white p-3 sm:px-6 sm:py-4">{replyTo && <div className="mb-2 flex items-center justify-between rounded-lg bg-[#fff3ea] px-3 py-2 text-[11px] text-[#8d5633]"><span className="truncate">Replying to: {replyTo.body.slice(0, 70)}</span><button type="button" onClick={() => setReplyTo(null)} className="ml-2 font-bold">Cancel</button></div>}{mentionOpen && <div className="mb-2 rounded-xl border border-[#eeeef1] bg-white p-3 shadow-sm"><LiveMemberPicker label="Mention member" value={mentionCandidate} onChange={(id, member) => { setMentionCandidate(id); if (member) { setMentions((items) => items.some((item) => item.id === member.id) ? items : [...items, member]); setMentionCandidate(""); } }} groupId={selected.groupId} excludeIds={[...(session ? [session.user.id] : []), ...mentions.map((member) => member.id)]} optional /></div>}{mentions.length > 0 && <div className="mb-2 flex flex-wrap gap-1">{mentions.map((member) => <button key={member.id} type="button" onClick={() => setMentions((items) => items.filter((item) => item.id !== member.id))} className="rounded-full bg-[#fff2e8] px-2 py-1 text-[10px] text-[#e4781f]">@{member.handle ?? member.name} ×</button>)}</div>}<div className="flex items-end gap-2 rounded-xl border border-[#e9e9ed] px-3 py-2 focus-within:border-[#ffb56e]"><button type="button" aria-label="Mention a member" title="Mention a member" onClick={() => setMentionOpen((current) => !current)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-[#f58229] hover:bg-[#fff2e8]">@</button><label htmlFor="channel-composer" className="sr-only">Message or slash command</label><textarea id="channel-composer" maxLength={10000} rows={1} value={composer} onChange={(event) => { setComposer(event.target.value); setPreview(null); clientId.current = null; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} className="min-h-8 max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-[#aaaab3]" placeholder="Type a message, /assign or /notify..." /><button type="submit" disabled={busy || !composer.trim()} aria-label={composer.trim().startsWith("/") ? "Preview command" : "Send message"} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#ff8b25] text-white transition-colors hover:bg-[#ed7619] disabled:opacity-40"><Send size={15} /></button></div></form>}
    </section>
    {details}
    {createKind && <div className="fixed inset-0 z-30 grid place-items-center bg-[#272736]/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateKind(null); }}><section role="dialog" aria-modal="true" aria-label={`Create ${createKind}`} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center justify-between"><h2 className="text-base font-bold">Create {createKind}</h2><button type="button" aria-label="Close" onClick={() => setCreateKind(null)} className="chat-icon"><X size={18} /></button></div><p className="mt-2 text-xs leading-5 text-[#9798a3]">Add a {createKind} to this workspace. {createKind === "group" ? "A #general channel is created automatically." : ""}</p><form onSubmit={createSpace} className="mt-5 space-y-4">{createKind !== "venture" && <label className="block text-xs font-semibold">{createKind === "group" ? "Venture" : "Group"}<select required value={createParent} onChange={(event) => setCreateParent(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-[#e6e6eb] bg-white px-3 text-xs outline-none focus:border-[#ffb56e]"><option value="">Choose {createKind === "group" ? "venture" : "group"}</option>{createKind === "group" ? session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : session?.hierarchy.ventures.flatMap((item) => item.groups.map((entry) => <option key={entry.id} value={entry.id}>{item.name} · {entry.name}</option>))}</select></label>}<label className="block text-xs font-semibold">Name<input required maxLength={createKind === "channel" ? 80 : 120} value={createName} onChange={(event) => setCreateName(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-[#e6e6eb] px-3 text-xs outline-none focus:border-[#ffb56e]" placeholder={createKind === "channel" ? "product-updates" : createKind === "group" ? "Product team" : "New venture"} /></label>{createKind === "venture" && <label className="block text-xs font-semibold">30-day goal <span className="font-normal text-[#aaaab3]">(optional)</span><textarea maxLength={500} value={createGoal} onChange={(event) => setCreateGoal(event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-[#e6e6eb] p-3 text-xs outline-none focus:border-[#ffb56e]" placeholder="What will this venture achieve next?" /></label>}{error && <p role="alert" className="text-xs text-red-700">{error}</p>}<div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setCreateKind(null)} className="min-h-10 rounded-lg px-4 text-xs font-semibold text-[#777883]">Cancel</button><button type="submit" disabled={busy || !createName.trim() || (createKind !== "venture" && !createParent)} className="min-h-10 rounded-lg bg-[#ff8b25] px-4 text-xs font-semibold text-white disabled:opacity-50">Create {createKind}</button></div></form></section></div>}
  </ChatShell>;
}
