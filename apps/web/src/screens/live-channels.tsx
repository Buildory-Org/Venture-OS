"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Database, Hash, RefreshCw, Send } from "lucide-react";
import clsx from "clsx";
import type { CommandPreview, Message } from "@venture-studio/contracts";
import { executeLiveCommand, listLiveChannelMessages, loadLiveSession, previewLiveCommand, sendLiveChannelMessage } from "@/lib/studio-api";
import { Badge, Empty, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The request failed. Please try again.";
const stamp = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));

export function LiveChannelsScreen() {
  const params = useSearchParams();
  const [session, setSession] = useState<Session | null>(null);
  const [selectedId, setSelectedId] = useState(params.get("channel") ?? "");
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [composer, setComposer] = useState("");
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const clientId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => {
      if (!active) return;
      setSession(value);
      const channels = value.hierarchy.ventures.flatMap((venture) => venture.groups.flatMap((group) => group.channels));
      setSelectedId((current) => channels.some((channel) => channel.id === current) ? current : channels[0]?.id ?? "");
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    queueMicrotask(() => listLiveChannelMessages(selectedId).then((page) => {
      if (!active) return;
      setMessages(page.items); setCursor(page.nextCursor); setError("");
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  }, [selectedId, revision]);

  const channels = session?.hierarchy.ventures.flatMap((venture) => venture.groups.flatMap((group) => group.channels)) ?? [];
  const selected = channels.find((channel) => channel.id === selectedId);
  const group = session?.hierarchy.ventures.flatMap((venture) => venture.groups).find((item) => item.id === selected?.groupId);
  const venture = session?.hierarchy.ventures.find((item) => item.id === selected?.ventureId);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = composer.trim();
    if (!selectedId || !body) return;
    setBusy(true); setError(""); setResult(""); setPreview(null);
    try {
      if (body.startsWith("/")) {
        const next = await previewLiveCommand({ channelId: selectedId, input: body });
        setPreview(next);
      } else {
        clientId.current ??= crypto.randomUUID();
        const created = await sendLiveChannelMessage(selectedId, { body, mentionUserIds: [], clientId: clientId.current });
        setMessages((items) => [...items, created.message]);
        clientId.current = null;
        setComposer("");
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
      setPreview(null); setComposer("");
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

  return <PageFrame><PageTitle eyebrow="Connected collaboration" title="Live channels" description="Authorized venture and group conversations from the API." action={<button type="button" onClick={() => setRevision((value) => value + 1)} className={secondaryClass}><RefreshCw size={15} />Refresh</button>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>Messages and command previews here use the API. <Link href="/channels" className="font-bold underline">Demo channels</Link> remain separate. Live @mention notifications and direct-message picking need a member directory that the API does not yet expose.</p></div>
    {error && <p role="alert" className="mb-4 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {result && <p role="status" className="mb-4 rounded-xl bg-success-surface p-3 text-sm font-semibold text-success-text">{result}</p>}
    <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]"><Panel className="p-3"><p className="px-2 pb-2 text-xs font-extrabold uppercase tracking-wide text-neutral-400">Venture channels</p>{session?.hierarchy.ventures.map((item) => <div key={item.id} className="mb-3"><p className="px-2 py-1 text-xs font-extrabold text-neutral-600">{item.name}</p>{item.groups.map((group) => <div key={group.id}><p className="px-2 text-[10px] font-bold uppercase tracking-wide text-neutral-400">{group.name}</p>{group.channels.map((channel) => <button key={channel.id} onClick={() => { setSelectedId(channel.id); setPreview(null); setComposer(""); setResult(""); clientId.current = null; }} className={clsx("my-0.5 flex min-h-10 w-full items-center gap-2 rounded-xl px-2 text-left text-xs font-bold", selectedId === channel.id ? "bg-primary-50 text-primary-700" : "text-neutral-600 hover:bg-neutral-50")}><Hash size={14} />{channel.name}</button>)}</div>)}</div>)}{session && channels.length === 0 && <p className="p-2 text-xs text-neutral-500">No authorized channels.</p>}</Panel>
      <Panel className="flex min-h-[590px] flex-col overflow-hidden"><PanelHead title={selected ? `# ${selected.name}` : "Select a channel"} aside={<span className="text-xs text-neutral-400">{venture?.name ?? ""}{group ? ` · ${group.name}` : ""}</span>} /><div className="thin-scroll flex-1 overflow-y-auto p-4"><div className="space-y-3">{messages.length ? messages.map((item) => <article key={item.id} className="rounded-xl bg-neutral-50 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-extrabold text-neutral-800">{item.authorId === session?.user.id ? "You" : `Member ${item.authorId}`}</span><span className="text-[10px] text-neutral-400">{stamp(item.createdAt)}</span>{item.threadRootId && <Badge tone="blue">Thread reply</Badge>}</div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-neutral-700">{item.body}</p></article>) : <Empty title="No messages yet" body="Send the first update in this channel." />}</div>{cursor && <button disabled={busy} type="button" onClick={more} className={`${secondaryClass} mt-4 w-full`}>Load more messages</button>}</div>
        {preview && <section className="border-t border-warning-surface bg-warning-surface/40 p-4"><p className="text-xs font-extrabold uppercase tracking-wide text-warning-text">Review command before execution</p><p className="mt-2 text-sm font-bold text-neutral-800">{preview.command.kind === "assign" ? `Assign “${preview.command.title}” to @${preview.command.assignee}` : `Notify @${preview.command.recipient}: “${preview.command.message}”`}</p><p className="mt-1 text-xs text-neutral-500">{preview.command.kind === "assign" ? `Due ${stamp(preview.command.dueAt)} · ${preview.command.estimatedMinutes} min` : `At ${stamp(preview.command.scheduledAt)}`}</p>{preview.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-warning-text">{warning}</p>)}<div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={execute} className={primaryClass}>Confirm command<ArrowRight size={14} /></button><button type="button" onClick={() => setPreview(null)} className={secondaryClass}>Cancel</button></div></section>}
        <form onSubmit={send} className="border-t border-neutral-100 p-4"><label htmlFor="live-channel-message" className="sr-only">Message or slash command</label><textarea id="live-channel-message" value={composer} onChange={(event) => { setComposer(event.target.value); setPreview(null); clientId.current = null; }} className={`${inputClass} min-h-20 py-3`} placeholder="Write an update, /assign, or /notify…" /><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="max-w-xl text-[11px] leading-4 text-neutral-400">Typing @name in a normal message is text only; live mention notifications are not wired. Commands require a known handle or email and an ISO time.</p><button disabled={busy || !selectedId || !composer.trim()} className={primaryClass}>{composer.trim().startsWith("/") ? "Preview command" : "Send message"}<Send size={14} /></button></div></form>
      </Panel></div>
  </PageFrame>;
}
