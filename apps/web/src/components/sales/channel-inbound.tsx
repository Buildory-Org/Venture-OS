"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { InboundConversation, Lead } from "@venture-studio/contracts";
import { ChevronDown, LinkIcon, Search, UserPlus, X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, inputClass, Notice, Panel, secondaryClass } from "@/components/studio/primitives";
import { listLeads } from "@/lib/sales-api";
import { attachInbound, dismissInbound, errorCode, isRouteMissing, listInbound } from "@/lib/sales-channels-api";
import { ago, canWriteIn, ChannelTile, CHANNEL_LABEL, stamp, useSalesLoad } from "./draft-shared";
import { accountLabel, useChannelAccounts } from "./channel-model";
import { LeadCreate, type LeadPrefill } from "./lead-create";
import { useSalesShell } from "./sales-context";
import { StageChip, useDebounced } from "./sales-ui";

// New conversations (docs/sales-channels.md section 6): WhatsApp and Instagram messages from people who are not leads yet. A person links
// one to a lead (its messages are filed on the lead), creates the lead first, or dismisses it. Hidden on a server without channels.

/** An Instagram sender is an @username when the app could look it up, else a long number only Instagram understands. */
const isHandle = (value: string) => /^@?[A-Za-z0-9._]{1,30}$/.test(value) && !/^\d{10,}$/.test(value);
function senderOf(conversation: InboundConversation) {
  if (conversation.kind === "instagram") return isHandle(conversation.from) ? `@${conversation.from.replace(/^@/, "")}` : "Instagram user";
  return conversation.from;
}

export function NewConversations() {
  const { ventureId } = useSalesShell();
  const inbound = useSalesLoad(`inbound|${ventureId}`, async () => {
    try { return { available: true, list: await listInbound(ventureId ? { ventureId } : {}) }; }
    // A server without channels, or a reader who can't write in the venture (new conversations are for people who can answer them): hidden.
    catch (cause) { if (isRouteMissing(cause) || errorCode(cause) === "FORBIDDEN") return { available: false, list: [] as InboundConversation[] }; throw cause; }
  });
  const { accounts } = useChannelAccounts(Boolean(inbound.data?.list.length));
  const [open, setOpen] = useState(true);
  const list = inbound.data?.list ?? [];
  const remove = (id: string) => inbound.mutate((data) => ({ ...data, list: data.list.filter((item) => item.id !== id) }));

  if (inbound.error && !inbound.data) return <p role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-danger-surface p-3 text-xs font-semibold text-danger-text"><span className="min-w-0 flex-1">Could not read new conversations: {inbound.error}</span><button type="button" onClick={inbound.reload} disabled={inbound.busy} className={clsx(secondaryClass, "!min-h-9")}>Try again</button></p>;
  if (!inbound.data?.available || list.length === 0) return null;
  return <Panel className="mb-4 overflow-hidden">
    <h2><button type="button" aria-expanded={open} aria-controls="new-conversations" onClick={() => setOpen(!open)} className="flex min-h-12 w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600">
      <span className="min-w-0 flex-1"><span className="text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500">New conversations</span><span className="mt-0.5 block text-xs font-normal normal-case tracking-normal text-neutral-500">People who wrote to a venture&apos;s WhatsApp or Instagram and aren&apos;t leads yet.</span></span>
      <span className="tnum rounded-md bg-primary-50 px-1.5 py-0.5 text-[11px] font-bold text-primary-700">{list.length}</span>
      <ChevronDown size={15} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", open && "rotate-180")} />
    </button></h2>
    {open && <ul id="new-conversations" className="grid gap-px border-t border-neutral-100 bg-neutral-100 lg:grid-cols-2">{list.map((conversation) => <Conversation key={conversation.id} conversation={conversation} label={accountLabel(accounts, conversation.accountId)} onDone={() => remove(conversation.id)} />)}</ul>}
  </Panel>;
}

function Conversation({ conversation, label, onDone }: { conversation: InboundConversation; label: string; onDone: () => void }) {
  const { session, ventureId, ventureName, refresh } = useSalesShell();
  const writer = conversation.ventureIds.some((id) => canWriteIn(session, id));
  const [mode, setMode] = useState<"idle" | "link" | "dismiss">("idle");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const sender = senderOf(conversation);
  // The messages kept with the conversation (up to 50), oldest first: read in full before deciding who it is.
  const items = [...(conversation.items ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const [showAll, setShowAll] = useState(false);
  const channel = CHANNEL_LABEL[conversation.kind];
  const where = [label || `the venture's ${channel}`, ...(ventureId ? [] : conversation.ventureIds.map(ventureName))].join(" · ");

  async function link(lead: Pick<Lead, "id" | "companyName">) {
    setBusy(`link-${lead.id}`); setError("");
    try { await attachInbound(conversation.id, { leadId: lead.id }); toast({ title: `Linked to ${lead.companyName}`, body: "Their messages are on the lead, and in the Inbox to answer." }); onDone(); refresh(); }
    catch (cause) { setError(describeError(cause, "Could not link it. Try again.")); }
    finally { setBusy(""); }
  }
  async function dismiss() {
    setBusy("dismiss"); setError("");
    try { await dismissInbound(conversation.id); toast({ title: "Dismissed", body: `${conversation.name || sender}. Nothing was sent.` }); onDone(); }
    catch (cause) { setError(describeError(cause, "Could not dismiss it. Try again.")); }
    finally { setBusy(""); }
  }
  async function created(leadId: string) {
    setCreating(false);
    setBusy("link-new"); setError("");
    try { await attachInbound(conversation.id, { leadId }); toast({ title: "Lead created and linked", body: "Their messages are on the new lead." }); onDone(); refresh(); }
    catch (cause) { setError(`The lead was added, but linking the conversation failed: ${describeError(cause, "try Link to a lead.")}`); }
    finally { setBusy(""); }
  }
  const prefill: LeadPrefill = {
    ventureIds: conversation.ventureIds,
    ...(conversation.name ? { contactName: conversation.name } : {}),
    routes: conversation.kind === "whatsapp" ? [{ kind: "whatsapp", value: conversation.from, label: "They messaged us", publishedByCompany: false }] : isHandle(conversation.from) ? [{ kind: "instagram", value: `@${conversation.from.replace(/^@/, "")}`, label: "They messaged us", publishedByCompany: false }] : [],
    source: `${channel} message to ${label || `the venture's ${channel}`}`,
  };

  return <li className="min-w-0 bg-white p-4">
    <div className="flex items-start gap-3">
      <ChannelTile channel={conversation.kind} size={36} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2"><span className="truncate text-[13px] font-extrabold text-neutral-900">{conversation.name || sender}</span><time dateTime={conversation.at} className="tnum shrink-0 text-[11px] text-neutral-400">{ago(conversation.at)}</time></div>
        <p className="mt-0.5 truncate text-[11px] font-medium text-neutral-500">{conversation.name ? `${sender} · ` : ""}to {where}</p>
        {!showAll && <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-neutral-700 [overflow-wrap:anywhere]">{conversation.body || "(no text)"}</p>}
        {items.length > 1
          ? <button type="button" aria-expanded={showAll} aria-controls={`conversation-${conversation.id}`} onClick={() => setShowAll(!showAll)} className="mt-1 inline-flex min-h-8 items-center gap-1 rounded-lg text-[11px] font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{showAll ? "Hide the messages" : `Read all ${conversation.messages} messages`}<ChevronDown size={13} aria-hidden="true" className={clsx("transition-transform duration-150", showAll && "rotate-180")} /></button>
          : <p className="mt-1 text-[11px] font-medium text-neutral-400">{conversation.messages === 1 ? "1 message" : `${conversation.messages} messages`}</p>}
        {showAll && <ol id={`conversation-${conversation.id}`} aria-label="Their messages" className="vso-fade-enter mt-1.5 space-y-1.5 rounded-xl bg-neutral-50 p-2.5">{items.map((item) => <li key={item.externalId} className="w-fit max-w-full rounded-xl rounded-bl-md border border-neutral-200 bg-white px-3 py-2 text-xs leading-5 text-neutral-800"><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.body || "(no text)"}</p><time dateTime={item.at} className="mt-0.5 block text-[10px] text-neutral-400">{stamp(item.at)}</time></li>)}</ol>}
      </div>
    </div>
    {writer && mode === "idle" && <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => { setMode("link"); setError(""); }} disabled={busy !== ""} className={clsx(secondaryClass, "!min-h-9 !px-3 text-xs")}><LinkIcon size={14} aria-hidden="true" />Link to a lead</button>
      <button type="button" onClick={() => { setCreating(true); setError(""); }} disabled={busy !== ""} className={clsx(secondaryClass, "!min-h-9 !px-3 text-xs")}><ActionLabel busy={busy === "link-new"} busyText="Linking…" idle={<><UserPlus size={14} aria-hidden="true" />Create lead</>} /></button>
      <button type="button" onClick={() => { setMode("dismiss"); setError(""); }} disabled={busy !== ""} className={clsx(secondaryClass, "!min-h-9 !px-3 text-xs !text-neutral-500")}><X size={14} aria-hidden="true" />Dismiss</button>
    </div>}
    {writer && mode === "link" && <LeadSearch ventureIds={conversation.ventureIds} busy={busy} onPick={(lead) => void link(lead)} onCancel={() => setMode("idle")} />}
    {writer && mode === "dismiss" && <div role="alertdialog" aria-label="Dismiss this conversation?" className="vso-fade-enter mt-3 rounded-xl bg-neutral-50 p-3">
      <p className="text-xs font-semibold leading-5 text-neutral-800">Dismiss it? It leaves this list and nothing is sent. Use it for spam or a wrong number.</p>
      <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void dismiss()} disabled={busy !== ""} className={clsx(secondaryClass, "!min-h-9 !px-3 text-xs")}><ActionLabel busy={busy === "dismiss"} busyText="Dismissing…" idle="Dismiss" /></button><button type="button" onClick={() => setMode("idle")} className={clsx(secondaryClass, "!min-h-9 !px-3 text-xs")}>Keep it</button></div>
    </div>}
    {!writer && <p className="mt-2 text-[11px] text-neutral-400">A contributor or venture head links it to a lead.</p>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mt-3" />
    {creating && <LeadCreate prefill={prefill} onClose={() => setCreating(false)} onCreated={(leadId) => void created(leadId)} />}
  </li>;
}

/** Search the leads of the conversation's ventures by name, contact or number, and pick the one they belong to. */
function LeadSearch({ ventureIds, busy, onPick, onCancel }: { ventureIds: string[]; busy: string; onPick: (lead: Lead) => void; onCancel: () => void }) {
  const { ventureName } = useSalesShell();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const [result, setResult] = useState<{ q: string; leads: Lead[] | null; error: string } | null>(null);
  useEffect(() => {
    if (q.length < 2) return;
    let active = true;
    listLeads({ q, limit: 8, sort: "relevance", ...(ventureIds.length === 1 ? { ventureId: ventureIds[0] } : {}) })
      .then((list) => { if (active) setResult({ q, leads: list.items.filter((lead) => ventureIds.includes(lead.ventureId)), error: "" }); })
      .catch((cause: unknown) => { if (active) setResult({ q, leads: null, error: describeError(cause, "Could not search the leads.") }); });
    return () => { active = false; };
  }, [q, ventureIds]);
  const current = q.length >= 2 && result?.q === q ? result : null;
  return <div className="vso-fade-enter mt-3 space-y-2 rounded-xl bg-neutral-50 p-3">
    <label htmlFor="inbound-lead-search" className="block text-xs font-semibold text-neutral-600">Which lead is it?</label>
    <div className="relative"><Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" /><input id="inbound-lead-search" type="search" autoFocus autoComplete="off" maxLength={200} value={text} onChange={(event) => setText(event.target.value)} placeholder="Company, contact or number" className={clsx(inputClass, "pl-9")} /></div>
    {q.length >= 2 && !current && <span role="status" aria-label="Searching" className="vso-skeleton block h-10 rounded-xl" />}
    {current?.error && <p role="alert" className="text-xs font-semibold text-danger-text">{current.error}</p>}
    {current?.leads && (current.leads.length
      ? <ul className="grid gap-1.5">{current.leads.map((lead) => <li key={lead.id}><button type="button" onClick={() => onPick(lead)} disabled={busy !== ""} className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-left transition-[background-color,transform] duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99] disabled:opacity-60"><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold text-neutral-900">{busy === `link-${lead.id}` ? "Linking…" : lead.companyName}</span><span className="block truncate text-[11px] text-neutral-500">{[lead.contactName, lead.city, ventureIds.length > 1 ? ventureName(lead.ventureId) : ""].filter(Boolean).join(" · ") || "No contact name"}</span></span><StageChip stage={lead.stage} /></button></li>)}</ul>
      : <p className="text-xs text-neutral-500">No lead matches. Create the lead instead.</p>)}
    <button type="button" onClick={onCancel} className={clsx(secondaryClass, "!min-h-9 !px-3 text-xs")}>Cancel</button>
  </div>;
}
