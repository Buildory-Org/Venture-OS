"use client";

import { useEffect, useRef, useState } from "react";
import { Info, MoreHorizontal, RefreshCw, X } from "@/components/ui/icons";
import clsx from "clsx";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { Message } from "@venture-studio/contracts";
import { listLiveDirectMessages, listLiveMembers, loadLiveSession, sendLiveDirectMessage } from "@/lib/studio-api";
import { ChatAvatar, ChatCredit, ChatEmpty, ChatNav, ChatSearch, ChatShell } from "@/components/studio/chat-ui";
import { useLiveRealtime } from "@/lib/use-live-realtime";
import { AttachmentPicker, MessageAttachmentList, messageAttachments, useChatAttachments } from "@/components/studio/chat-attachments";
import { ChatSendIcon, playChatSound, prepareChatAudio, useChatMessageArrival } from "@/components/studio/chat-message-effects";
import { useActiveChatPresence } from "@/lib/chat-presence";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
const time = (value: string) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
const errorText = (value: unknown) => value instanceof Error ? value.message : "Something went wrong.";

export function LiveMessagesScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [selectedRecipient, setSelectedRecipient] = useState<Member | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [composer, setComposer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const clientId = useRef<string | null>(null);
  const activeConversationId = useRef(recipientId);
  const realtime = useLiveRealtime(() => setRevision((value) => value + 1));
  const recipient = members.find((item) => item.id === recipientId) ?? (selectedRecipient?.id === recipientId ? selectedRecipient : undefined);
  const attachments = useChatAttachments(recipientId, recipientId ? { recipientId } : null);
  useActiveChatPresence("direct", recipientId);
  const arrived = useChatMessageArrival(recipientId, messages, session?.user.id, messagesLoaded);
  useEffect(() => { activeConversationId.current = recipientId; }, [recipientId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([loadLiveSession(), listLiveMembers({ limit: 100 })]).then(([identity, page]) => {
      if (!active) return;
      setSession(identity);
      setMembers(page.items.filter((item) => item.id !== identity.user.id));
      setCursor(page.nextCursor);
      setError("");
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session || (search.trim().length > 0 && search.trim().length < 2)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      listLiveMembers({ ...(search.trim() ? { q: search.trim() } : {}), limit: 100 }).then((page) => {
        if (active) { setMembers(page.items.filter((item) => item.id !== session.user.id)); setCursor(page.nextCursor); }
      }).catch((cause: unknown) => { if (active) setError(errorText(cause)); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, session]);

  useEffect(() => {
    if (!recipientId) return;
    let active = true;
    queueMicrotask(() => listLiveDirectMessages(recipientId).then((items) => { if (active) { setMessages(items); setMessagesLoaded(true); setError(""); } }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  }, [recipientId, revision]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, recipientId]);

  async function moreMembers() {
    if (!cursor) return;
    try {
      const page = await listLiveMembers({ ...(search.trim().length >= 2 ? { q: search.trim() } : {}), cursor, limit: 100 });
      setMembers((current) => [...current, ...page.items.filter((item) => item.id !== session?.user.id && !current.some((existing) => existing.id === item.id))]);
      setCursor(page.nextCursor);
    } catch (cause) { setError(errorText(cause)); }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = composer.trim();
    if (!recipientId || busy || (!body && !attachments.items.length) || attachments.uploading) return;
    prepareChatAudio();
    setBusy(true); setError("");
    try {
      const handles = [...body.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9._-]*)/gi)].map((match) => match[1]!.toLowerCase());
      const mentionUserIds = recipient?.handle && handles.includes(recipient.handle.toLowerCase()) ? [recipientId] : [];
      clientId.current ??= crypto.randomUUID();
      const created = await sendLiveDirectMessage({ recipientId, body, attachmentFileIds: attachments.items.map((file) => file.id), mentionUserIds: [...new Set(mentionUserIds)], clientId: clientId.current, ...(replyTo ? { threadRootId: replyTo.id } : {}) });
      playChatSound("sent");
      if (activeConversationId.current === recipientId) {
        setMessages((items) => items.some((item) => item.id === created.id) ? items : [...items, created]);
        setComposer(""); setReplyTo(null); clientId.current = null; attachments.clear();
      }
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  const visible = search.trim().length >= 2 ? members : members.filter((item) => `${item.name} ${item.handle ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const detailPanel = <aside className={clsx("chat-details thin-scroll border-l border-[var(--color-neutral-200)] bg-white p-5 xl:w-[290px] xl:shrink-0", detailsOpen ? "fixed inset-y-0 right-0 z-20 w-[min(320px,92vw)] shadow-2xl vso-enter-right xl:animate-none! xl:static xl:shadow-none" : "hidden xl:block")}>
    <div className="flex items-center justify-between"><p className="text-xs font-semibold text-[var(--color-neutral-800)]">Contact Details</p><button type="button" aria-label="Close details" onClick={() => setDetailsOpen(false)} className="chat-icon xl:!hidden"><X size={17} /></button></div>
    {recipient ? <><div className="mt-8 flex flex-col items-center text-center"><ChatAvatar id={recipient.id} name={recipient.name} size={78} /><h2 className="mt-3 text-sm font-semibold">{recipient.name}</h2><p className="mt-1 text-xs text-[var(--color-neutral-400)]">{recipient.handle ? `@${recipient.handle}` : recipient.role.replaceAll("_", " ")}</p></div><div className="mt-8 border-t border-[var(--color-neutral-100)] pt-5"><p className="text-xs font-semibold">Conversation</p><p className="mt-2 text-xs leading-5 text-[var(--color-neutral-400)]">{messages.length} recent messages with this workspace member. Direct messages are visible only to participants.</p></div><div className="mt-7 border-t border-[var(--color-neutral-100)] pt-5"><p className="text-xs font-semibold">Shared media</p><p className="mt-2 text-xs leading-5 text-[var(--color-neutral-400)]">Files in this conversation: {messages.reduce((count, item) => count + messageAttachments(item).length, 0)}.</p></div></> : <p className="mt-6 text-xs text-[var(--color-neutral-400)]">Choose a contact to see their details.</p>}
    <div className="mt-8"><ChatCredit /></div>
  </aside>;

  return <ChatShell ready={Boolean(session) || Boolean(error)}>
    <aside className={clsx("chat-list flex w-full shrink-0 flex-col border-r border-[var(--color-neutral-200)] bg-white md:w-[282px] xl:w-[310px]", recipientId ? "hidden md:flex" : "flex")}>
      <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-[var(--color-neutral-100)] px-5"><ChatNav mode="messages" /><span className="text-[10px] font-semibold text-[var(--color-neutral-400)]">VENTURE STUDIO</span></div>
      <div className="px-5 pb-3 pt-5"><div className="mb-4 flex items-center justify-between"><h1 className="text-[15px] font-bold tracking-tight">Messages <span className="text-[var(--color-neutral-400)]">⌄</span></h1><button type="button" aria-label="Refresh messages" title="Refresh messages" className="chat-icon" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button></div><ChatSearch value={search} onChange={setSearch} placeholder="Search people..." /></div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">{visible.map((member) => <button type="button" key={member.id} onClick={() => { setRecipientId(member.id); setSelectedRecipient(member); setMessages([]); setMessagesLoaded(false); setComposer(""); setReplyTo(null); clientId.current = null; }} className={clsx("flex min-h-[68px] w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-[var(--color-neutral-50)]", recipientId === member.id && "bg-[var(--color-primary-100)]")}><ChatAvatar id={member.id} name={member.name} size={39} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold">{member.name}</span><span className="mt-1 block truncate text-[10px] text-[var(--color-neutral-400)]">{member.handle ? `@${member.handle}` : member.role.replaceAll("_", " ")}</span></span></button>)}{visible.length === 0 && <p className="px-4 py-8 text-center text-xs text-[var(--color-neutral-400)]">No workspace members found.</p>}{cursor && <button type="button" onClick={moreMembers} className="mx-3 mt-2 min-h-9 text-xs font-semibold text-[var(--color-primary-600)]">Load more people</button>}</div>
      {session && <div className="flex items-center gap-2 border-t border-[var(--color-neutral-100)] px-5 py-3"><ChatAvatar id={session.user.id} name={session.user.name} size={30} /><span className="truncate text-[11px] font-semibold">{session.user.name}</span><span className="ml-auto text-[9px] text-[var(--color-neutral-400)]">{realtime === "live" ? "Live" : "Offline"}</span></div>}
    </aside>
    <section className={clsx("relative flex min-w-0 flex-1 flex-col bg-white", !recipientId && "hidden md:flex")}>
      <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-[var(--color-neutral-200)] px-4 sm:px-6"><button type="button" aria-label="Back to people" onClick={() => setRecipientId("")} className="chat-icon md:!hidden"><X size={18} /></button>{recipient ? <><ChatAvatar id={recipient.id} name={recipient.name} size={34} /><div className="min-w-0 flex-1"><h2 className="truncate text-[12px] font-semibold">{recipient.name}</h2><p className="truncate text-[10px] text-[var(--color-neutral-400)]">{recipient.handle ? `@${recipient.handle}` : "Workspace member"}</p></div></> : <h2 className="flex-1 text-sm font-semibold">Select a conversation</h2>}<ThemeToggle /><button type="button" aria-label="Show contact details" title="Contact details" onClick={() => setDetailsOpen(true)} className="chat-icon"><Info size={17} /></button><button type="button" aria-label="Refresh conversation" title="Refresh" onClick={() => setRevision((value) => value + 1)} className="chat-icon"><MoreHorizontal size={18} /></button></header>
      {error && <p role="alert" className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-7">{recipient ? messages.length ? <><div className="my-2 text-center text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--color-neutral-400)]">Conversation</div>{messages.map((item) => { const mine = item.authorId === session?.user.id; return <article key={item.id} className={clsx("flex items-start gap-2", arrived.has(item.id) && "chat-message-arrive", mine && "flex-row-reverse")}><span className="mt-5 shrink-0"><ChatAvatar id={item.authorId} name={mine ? session?.user.name ?? "You" : recipient.name} size={25} /></span><div className={clsx("max-w-[min(75%,560px)]", mine && "text-right")}><div className={clsx("mb-1 flex items-center gap-2 text-[10px]", mine && "flex-row-reverse")}><span className="font-semibold">{mine ? "You" : recipient.name}</span><time className="text-[var(--color-neutral-400)]">{time(item.createdAt)}</time></div>{item.body && <p className={clsx("inline-block whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-left text-[12px] leading-[1.65]", mine ? "rounded-br-[5px] bg-[var(--color-primary-600)] text-white" : "rounded-bl-[5px] border border-[var(--color-neutral-100)] bg-white text-[var(--color-neutral-700)]")}>{item.body}</p>}<MessageAttachmentList files={messageAttachments(item)} /><div><button type="button" onClick={() => setReplyTo(item)} className="mt-1 min-h-7 px-1 text-[10px] text-[var(--color-neutral-400)] hover:text-[var(--color-primary-600)]">{item.threadRootId ? "Reply again" : "Reply"}</button></div></div></article>; })}<div ref={bottomRef} /></> : <ChatEmpty title="No messages yet" detail="Start a conversation with a workspace member." /> : <ChatEmpty title="Your conversations, together" detail="Choose someone from the left to send a direct message." />}</div>
      {recipient && <form onSubmit={send} className="shrink-0 border-t border-[var(--color-neutral-200)] bg-white p-3 sm:px-6 sm:py-4">{replyTo && <div className="mb-2 flex items-center justify-between rounded-lg bg-[var(--color-primary-50)] px-3 py-2 text-[11px] text-[var(--color-primary-800)]"><span className="truncate">Replying to: {replyTo.body.slice(0, 70)}</span><button type="button" onClick={() => setReplyTo(null)} className="ml-2 font-bold">Cancel</button></div>}<div className="mb-2"><AttachmentPicker attachments={attachments} disabled={busy} /></div><div className="flex items-end gap-2 rounded-xl border border-[var(--color-neutral-200)] px-3 py-2 focus-within:border-[var(--color-primary-400)]"><label htmlFor="dm-composer" className="sr-only">Message</label><textarea id="dm-composer" maxLength={10000} rows={1} value={composer} onChange={(event) => { setComposer(event.target.value); clientId.current = null; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} className="min-h-8 max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-[var(--color-neutral-400)]" placeholder="Type a message..." /><button type="submit" disabled={busy || attachments.uploading || (!composer.trim() && !attachments.items.length)} aria-label="Send message" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-600)] text-white transition-colors hover:bg-[var(--color-primary-600)] disabled:opacity-40"><ChatSendIcon /></button></div></form>}
    </section>
    {detailPanel}
  </ChatShell>;
}
