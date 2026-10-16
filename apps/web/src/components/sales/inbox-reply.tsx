"use client";
import { useState } from "react";
import clsx from "clsx";
import type { Activity, Draft, Lead } from "@venture-studio/contracts";
import { ArrowUpRight, Send, Sparkles, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { describeError } from "@/lib/errors";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { ActionLabel, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createDraft, discardDraft, type ReviewDraft } from "@/lib/sales-api";
import { CHANNEL_LABEL, ChannelTile, routeOf, useVentureSettings } from "./draft-shared";
import { usableAccounts, useChannelAccounts } from "./channel-model";
import { replyWindow } from "./channel-send";
import { closedLabel, replyFromLine, replyOptions, sendPlanOf, TONE_DOT, TONE_TEXT, versionStatus, type ReplyChannel } from "./draft-plan";
import { DraftReader, type DraftChange, type LeadContext } from "./draft-reader";
import { useSalesShell } from "./sales-context";

// Answering a reply without leaving the Inbox (docs/sales-dealflow.md section 6): write it here and it is ready at once (a person's own
// reply needs no Claude review), or ask Claude to check it first; a ready reply, the person's or Claude's, sends from here exactly as in
// Review (the same draft reader, send box, "Did you send it?" and how-it's-recorded line).

type ComposerLead = Pick<Lead, "id" | "ventureId" | "companyName" | "contactName" | "contactRoutes" | "whatsappOptIn" | "doNotContact">;

/** "Re: <their subject>", else "Re: " the last email we sent them (a hand-sent one keeps its subject as the first line), else nothing. */
function replySubject(activity: Activity, activities: readonly Activity[] | null): string {
  const re = (subject: string) => `Re: ${subject.replace(/^(re:\s*)+/i, "").trim()}`;
  if (activity.message?.subject) return re(activity.message.subject);
  const sent = [...(activities ?? [])].filter((entry) => entry.kind === "email" && entry.direction === "out").sort((a, b) => b.at.localeCompare(a.at))[0];
  const subject = sent?.message?.subject ?? /^Subject: ([^\n]+)/.exec(sent?.body ?? "")?.[1];
  return subject ? re(subject) : "";
}

/**
 * The reply box: the channels this lead can be answered on (the others named with the reason), the text, where it goes out from, and two
 * buttons. "Save and send" saves it ready (the person's own approval) and opens its send step; "Ask Claude to check it first" saves it for
 * Claude's review in another chat. `pending`: this message's drafts still waiting for a review, replaced by the new one: the API discards the
 * replies to this message in the same step (one open reply per message), and this box discards the older ones that name no message.
 */
export function ReplyComposer({ lead, activity, activities, pending, onSaved, onCancel }: {
  lead: ComposerLead; activity: Activity; activities: readonly Activity[] | null; pending: readonly Draft[];
  onSaved: (draft: Draft, send: boolean) => void; onCancel: () => void;
}) {
  const { session } = useSalesShell();
  const settings = useVentureSettings([lead.ventureId])[lead.ventureId];
  const { accounts } = useChannelAccounts();
  const usable = (kind: string) => usableAccounts(accounts, lead.ventureId, kind, session?.user.id);
  const whatsappAccounts = usable("whatsapp");
  const wroteOn = activity.kind;
  const instagramReachable = Boolean(routeOf(lead.contactRoutes, "instagram")) || wroteOn === "instagram" || (activities ?? []).some((entry) => entry.kind === "instagram");
  const options = replyOptions({ lead, allowedChannels: settings?.allowedChannels, wroteOn, whatsappConnected: whatsappAccounts.length > 0, whatsappWindow: replyWindow(activities, "whatsapp", whatsappAccounts[0]?.id), instagramReachable });
  const usableOptions = options.filter((option) => option.ok);
  const [picked, setPicked] = useState<ReplyChannel | "">("");
  // The channel they wrote on, when it can carry the answer; else the first that can.
  const channel = (usableOptions.find((option) => option.channel === picked) ?? usableOptions.find((option) => option.channel === wroteOn) ?? usableOptions[0])?.channel;
  const [editedSubject, setSubject] = useState<string | null>(null);
  const subject = editedSubject ?? replySubject(activity, activities);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "check">("");
  const [error, setError] = useState("");

  // Where it goes out from, worked out like the send step will: a connected account, else the person's own app.
  const sendAccounts = channel === "email" || channel === "whatsapp" || channel === "instagram" ? usable(channel) : [];
  const instagramClosed = channel === "instagram" && replyWindow(activities, "instagram", sendAccounts[0]?.id) === "closed";
  const plan = channel ? sendPlanOf({ draft: { status: "ready", channel, body: text, ...(subject ? { subject } : {}) }, lead, approvalNeeded: false, sendAccounts, instagramClosed }) : null;
  const fromLine = plan ? replyFromLine(plan, plan.kind === "through" ? plan.accounts[0] : undefined) : "";
  const off = options.filter((option) => !option.ok);
  const offLine = off.map((option) => `${CHANNEL_LABEL[option.channel] ?? option.channel} (${option.why})`).join(" · ");

  async function save(check: boolean) {
    const body = text.trim();
    if (!channel) return;
    if (!body) { setError("Write the reply first."); return; }
    setBusy(check ? "check" : "send"); setError("");
    try {
      const draft = await createDraft(lead.id, { channel, purpose: "reply", inReplyTo: activity.id, body, ...(channel === "email" && subject.trim() ? { subject: subject.trim() } : {}), ...(check ? { checkByClaude: true } : {}) });
      // The new reply replaces the ones still waiting for a review. The API discarded the replies to this message with it; an older draft
      // that names no message (written before replies did) is discarded here. A discard that fails changes nothing.
      await Promise.all(pending.filter((other) => !other.inReplyTo).map((other) => discardDraft(other.id).catch(() => undefined)));
      onSaved(draft, !check);
    } catch (cause) { setError(describeError(cause, "Could not save the reply. Try again.")); }
    finally { setBusy(""); }
  }

  if (!channel) return <div className="vso-fade-enter space-y-3 rounded-2xl border border-neutral-200 bg-white p-4">
    <p className="text-[13px] font-bold text-neutral-900">There is no way to answer {lead.companyName} from here yet</p>
    {offLine && <p className="text-xs leading-5 text-neutral-600">{offLine}.</p>}
    <p className="text-xs leading-5 text-neutral-500">Call them, or add an email address on the lead.</p>
    <button type="button" onClick={onCancel} className={secondaryClass}>Close</button>
  </div>;

  return <form aria-label="Your reply" onSubmit={(event) => { event.preventDefault(); void save(false); }} className="vso-fade-enter space-y-3 rounded-2xl border border-primary-300 bg-white p-3.5 ring-2 ring-primary-100 sm:p-4">
    <div className="-mr-1.5 -mt-1.5 flex items-center justify-between gap-2">
      <p className="min-w-0 text-[13px] font-bold text-neutral-900 [overflow-wrap:anywhere]">Reply to {lead.contactName || lead.companyName}</p>
      <button type="button" onClick={onCancel} disabled={busy !== ""} aria-label="Close the reply" title="Close (Esc)" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.95]"><X size={16} aria-hidden="true" /></button>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-full sm:w-44"><Field label="Reply by"><Select aria-label="Reply by" className={inputClass} value={channel} onChange={(event) => setPicked(event.target.value as ReplyChannel)}>{options.map((option) => <option key={option.channel} value={option.channel} disabled={!option.ok}>{CHANNEL_LABEL[option.channel] ?? option.channel}{option.ok ? "" : " (not available)"}</option>)}</Select></Field></div>
      {channel === "email" && <div className="min-w-0 flex-1 basis-56"><Field label="Subject"><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} placeholder="Subject" className={inputClass} /></Field></div>}
    </div>
    <Field label="Your reply"><textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={5000} rows={5} autoFocus placeholder="Short, in their language, one next step."
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(false); } }}
      className={clsx(inputClass, "py-3 leading-7")} /></Field>
    {fromLine && <p className="flex items-start gap-1.5 text-xs font-medium leading-5 text-neutral-600"><Send size={13} aria-hidden="true" className="mt-1 shrink-0 text-primary-700" /><span className="min-w-0 [overflow-wrap:anywhere]">{fromLine}</span></p>}
    {offLine && <p className="text-[11px] leading-4 text-neutral-400 [overflow-wrap:anywhere]">Not offered: {offLine}.</p>}
    {pending.length > 0 && <p className="text-xs leading-5 text-neutral-500">Saving this replaces the draft above that waits for a review.</p>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
    <div className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={busy !== ""} className={clsx(primaryClass, "max-sm:w-full")}><ActionLabel busy={busy === "send"} idle={<><Send size={16} aria-hidden="true" />Save and send</>} /></button>
      <button type="button" onClick={() => void save(true)} disabled={busy !== ""} className={clsx(secondaryClass, "max-sm:w-full")}><ActionLabel busy={busy === "check"} idle={<><Sparkles size={15} aria-hidden="true" className="text-ai" />Ask Claude to check it first</>} /></button>
    </div>
  </form>;
}

/**
 * A reply to this message that is still open (the person's, a teammate's or Claude's): who wrote it and its state, then the draft reader
 * Review uses, inline, so it is approved, sent, or marked sent by hand right here. "Open in Review" stays as a small link. `heldBy`: another
 * reply to the same message whose send isn't settled yet; `detail`: the lead's messages and drafts (the Inbox has them already).
 */
export function ReplyCard({ draft, lead, autoSend, heldBy, detail, onChanged }: { draft: Draft; lead: Lead; autoSend: boolean; heldBy?: Draft | undefined; detail: LeadContext; onChanged: (change: DraftChange) => void }) {
  const { session, personName } = useSalesShell();
  const review: ReviewDraft = { ...draft, lead };
  const status = versionStatus(draft, Boolean(draft.needsPersonApproval));
  const who = draft.authorVia === "claude" ? "Claude's reply" : draft.authorId === session?.user.id ? "Your reply" : `${personName(draft.authorId)}'s reply`;
  return <section aria-label={who} className="vso-fade-enter space-y-3 rounded-2xl border border-neutral-200 bg-white p-3.5 sm:p-4">
    <div className="flex items-center gap-2.5">
      <ChannelTile channel={draft.channel} size={30} />
      <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5"><b className="text-[13px] font-bold text-neutral-900">{who}</b><span className={clsx("inline-flex items-center gap-1 text-[11px] font-semibold", TONE_TEXT[status.tone])}><span aria-hidden="true" className={clsx("h-1.5 w-1.5 rounded-full", TONE_DOT[status.tone])} />{status.label}</span></p>
      <WorkspaceLink href={`/sales/live/review?draft=${encodeURIComponent(draft.id)}`} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Open in Review<ArrowUpRight size={12} aria-hidden="true" /></WorkspaceLink>
    </div>
    <DraftReader inline draft={review} editNonce={0} autoSend={autoSend} detail={detail} {...(heldBy ? { heldBy } : {})} onChanged={onChanged} />
  </section>;
}

/** A reply to this message that a rule closed because another one went out: one quiet line, with a link to read it in Review. */
export function ClosedReplyLine({ draft }: { draft: Draft }) {
  const { session, personName } = useSalesShell();
  const who = draft.authorVia === "claude" ? "Claude's reply" : draft.authorId === session?.user.id ? "Your reply" : `${personName(draft.authorId)}'s reply`;
  return <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl bg-neutral-50 py-1 pl-2 pr-1 text-xs text-neutral-500">
    <ChannelTile channel={draft.channel} size={22} />
    <b className="font-semibold text-neutral-700">{who}</b>
    <span>{closedLabel(draft)}</span>
    <WorkspaceLink href={`/sales/live/review?draft=${encodeURIComponent(draft.id)}`} className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-lg px-2 font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Read it<ArrowUpRight size={12} aria-hidden="true" /></WorkspaceLink>
  </p>;
}
