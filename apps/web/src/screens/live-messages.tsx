"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Database, RefreshCw, Send } from "lucide-react";
import type { Message } from "@venture-studio/contracts";
import { listLiveDirectMessages, loadLiveSession, sendLiveDirectMessage } from "@/lib/studio-api";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { Badge, Empty, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { useLiveRealtime } from "@/lib/use-live-realtime";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function LiveMessagesScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [composer, setComposer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const clientId = useRef<string | null>(null);
  const realtime = useLiveRealtime(() => setRevision((value) => value + 1));

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => { if (active) setSession(value); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load workspace identity."); }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!recipientId) return;
    let active = true;
    queueMicrotask(() => listLiveDirectMessages(recipientId).then((items) => { if (active) { setMessages(items); setError(""); } }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load direct messages."); }));
    return () => { active = false; };
  }, [recipientId, revision]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!recipientId || !composer.trim()) return;
    setBusy(true); setError("");
    try {
      clientId.current ??= crypto.randomUUID();
      const created = await sendLiveDirectMessage({ recipientId, body: composer.trim(), mentionUserIds: [], clientId: clientId.current, ...(replyTo ? { threadRootId: replyTo.id } : {}) });
      setMessages((items) => items.some((item) => item.id === created.id) ? items : [...items, created]); setComposer(""); setReplyTo(null); clientId.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send the message. Retry will use the same client ID."); }
    finally { setBusy(false); }
  }

  return <PageFrame><PageTitle eyebrow="Connected collaboration" title="Direct messages" description="Workspace-member conversations with server-owned history and delivery." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p><span className="font-extrabold">Realtime: {realtime === "live" ? "connected by same-origin polling" : realtime === "connecting" ? "connecting" : "unavailable; use Refresh"}.</span> Recipients come from the authorized member directory. History returns the latest 100 messages; older paging is unavailable. <Link href="/demo/messages" className="font-bold underline">Demo messages</Link> remain separate.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]"><Panel className="p-4"><LiveMemberPicker label="Recipient" value={recipientId} onChange={(id, member) => { setRecipientId(id); setRecipientName(member?.name ?? id); setMessages([]); setReplyTo(null); setComposer(""); clientId.current = null; }} excludeIds={session ? [session.user.id] : []} optional /><p className="mt-4 text-xs leading-5 text-neutral-500">Select any active workspace member. The server rechecks recipient membership when sending.</p></Panel><Panel className="flex min-h-[550px] flex-col overflow-hidden"><PanelHead title={recipientId ? recipientName || recipientId : "Choose a recipient"} aside={<Badge tone="blue">{messages.length} recent</Badge>} /><div className="thin-scroll flex-1 space-y-3 overflow-y-auto p-4">{recipientId ? messages.length ? messages.map((item) => <article key={item.id} className="rounded-xl bg-neutral-50 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-extrabold text-neutral-800">{item.authorId === session?.user.id ? "You" : recipientName || recipientId}</span><span className="text-[10px] text-neutral-400">{stamp(item.createdAt)}</span>{item.threadRootId && <Badge tone="blue">Thread reply</Badge>}</div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-neutral-700">{item.body}</p>{!item.threadRootId && <button type="button" onClick={() => setReplyTo(item)} className="mt-2 min-h-8 rounded-lg px-2 text-xs font-bold text-neutral-500 hover:bg-white">Reply in thread</button>}</article>) : <Empty title="No messages yet" body="Start this conversation with a useful update." /> : <Empty title="No recipient selected" body="Choose a workspace member to read your conversation." />}</div>{recipientId && <form onSubmit={send} className="border-t border-neutral-100 p-4">{replyTo && <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-primary-50 px-3 py-2 text-xs text-primary-800"><span>Replying to: {replyTo.body.slice(0, 80)}</span><button type="button" onClick={() => setReplyTo(null)} className="font-bold underline">Cancel</button></div>}<label htmlFor="live-dm-composer" className="sr-only">Direct message</label><textarea id="live-dm-composer" required maxLength={10000} value={composer} onChange={(event) => { setComposer(event.target.value); clientId.current = null; }} className={`${inputClass} min-h-20 py-3`} placeholder="Write a direct message…" /><div className="mt-2 flex justify-end"><button disabled={busy || !composer.trim()} className={primaryClass}><Send size={14} />{replyTo ? "Send reply" : "Send message"}</button></div></form>}</Panel></div>
  </PageFrame>;
}
