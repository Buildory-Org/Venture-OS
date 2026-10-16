"use client";
import { useState } from "react";
import clsx from "clsx";
import { REPLY_TYPES, type Activity } from "@venture-studio/contracts";
import { ArrowLeft, ArrowUpRight, Check, Clock3, Reply } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { getLead, markActivityHandled, setActivityReplyType, type InboxItem } from "@/lib/sales-api";
import { Phone } from "./draft-icons";
import { CALL_OUTCOME_LABEL, canEditLead, canWriteIn, ChannelTile, CHANNEL_LABEL, kickerClass, OPT_IN_LABEL, OWNER_ONLY_NOTE, REPLY_LABEL, ReplyTypeChip, stamp, telHref, routeOf, useSalesLoad } from "./draft-shared";
import type { DraftChange } from "./draft-reader";
import { heldSibling, isOpenDraft } from "./draft-plan";
import { ClosedReplyLine, ReplyCard, ReplyComposer } from "./inbox-reply";
import { AskClaude } from "./ask-claude";
import { SlaChip, useNow, useSlaCalendars } from "./inbox-sla";
import { useSalesShell } from "./sales-context";
import { StageChip, VerdictChip, when } from "./sales-ui";
import { DeliveryTicks } from "./channel-delivery";

/** What the team's rules do with each kind of reply (docs/sales-dealflow.md section 5), in plain words. */
const NEXT_STEP: Record<string, string> = {
  interested: "Book the discovery call within {sla}. Offer two time slots.",
  send_details: "Send the details, short and in their words, then offer a call.",
  price_first: "Share the structure and a range, never a bare number before the written scope. Ask for a call.",
  not_now: "Parked for 30 days. No reply needed unless they wrote more.",
  wrong_person: "Ask who the right person is, or find them on the company site.",
  has_system: "Ask what they use and what is missing. Do not argue with it.",
  opt_out: "Never contact them again, on any channel. They are on the do-not-contact list for every venture.",
  hostile: "Do not reply. They are on the do-not-contact list for every venture.",
  silence: "Nothing to answer.",
  unclear: "Ask one short question to understand what they mean.",
};

/** "silence" is the absence of a reply, so it is not offered when sorting a message that arrived. */
const SORTABLE_TYPES = REPLY_TYPES.filter((type) => type !== "silence");

/** Message kinds shown as chat bubbles; calls, meetings and notes are one-line events. */
const MESSAGE_KINDS = ["email", "whatsapp", "linkedin", "instagram"];

/**
 * The right-hand pane of the Inbox: the conversation, what the reply means, and the answer: written here (ready at once), or Claude's,
 * sent from here exactly as in Review. Once it is sent the reply is handled and the list moves on.
 */
export function InboxReader({ item, onBack, onChanged }: { item: InboxItem; onBack: () => void; onChanged: (change: { kind: "handled" | "typed"; activity: Activity }) => void }) {
  const { session, openLead, refresh, personName } = useSalesShell();
  const { activity, lead } = item;
  // Answering, sorting and clearing a reply, and calling, are for the lead's owner, the venture head or an admin (as the API allows).
  // Another writer in the venture reads it and sees why the buttons are not there; a learner only reads.
  const writer = canEditLead(session, lead);
  const teammate = !writer && canWriteIn(session, lead.ventureId);
  const calendar = useSlaCalendars([lead.ventureId])(lead.ventureId);
  const detail = useSalesLoad(`lead|${lead.id}`, () => getLead(lead.id));
  const [composing, setComposing] = useState(false);
  // The reply just saved with "Save and send": its send step opens at once.
  const [justSaved, setJustSaved] = useState("");
  const [typePick, setTypePick] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const now = useNow();
  const handled = Boolean(activity.handledAt);
  const full = detail.data?.lead;
  const context = detail.data;
  const history = [...(detail.data?.activities ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const shown = history.length ? history.slice(-8) : [activity];
  // This message's open answers (a reply draft without a message named answers the latest one). Ready ones first: they go out next.
  const replyDrafts = (detail.data?.drafts ?? []).filter((draft) => draft.purpose === "reply" && isOpenDraft(draft) && (!draft.inReplyTo || draft.inReplyTo === activity.id))
    .sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready") || a.createdAt.localeCompare(b.createdAt));
  const readyReply = replyDrafts.some((draft) => draft.status === "ready");
  // Replies to this message that closed because another one went out (the API closes them): one line each.
  const closedReplies = (detail.data?.drafts ?? []).filter((draft) => draft.purpose === "reply" && draft.inReplyTo === activity.id && draft.status === "discarded" && draft.closedReason === "other_reply_sent");
  // Drafts still waiting for a review: writing your own answer replaces them.
  const pendingReplies = replyDrafts.filter((draft) => draft.status !== "ready");
  const phone = routeOf(lead.contactRoutes, "phone", "whatsapp");
  const phoneLink = phone ? telHref(phone.value) : "";
  // Nobody calls or writes to someone on the do-not-contact list. The reply itself may also say so (opt out, hostile).
  const doNotContact = lead.doNotContact || Boolean(full?.doNotContact) || activity.replyType === "opt_out" || activity.replyType === "hostile";
  // WhatsApp consent is a person's call: a message Claude logged only switches WhatsApp on when a person confirms it.
  const unconfirmedWhatsapp = activity.kind === "whatsapp" && activity.via === "claude" && !lead.whatsappOptIn;

  async function run<T>(name: string, action: () => Promise<T>, done: (result: T) => void) {
    setBusy(name); setError("");
    try { done(await action()); }
    catch (cause) { setError(describeError(cause, "That did not work. Try again.")); }
    finally { setBusy(""); }
  }
  const markHandled = () => void run("handled", () => markActivityHandled(activity.id), (updated) => { toast({ title: unconfirmedWhatsapp ? "WhatsApp confirmed and marked handled" : "Marked handled", body: lead.companyName }); onChanged({ kind: "handled", activity: updated }); refresh(); });
  const saveType = () => { if (typePick) void run("type", () => setActivityReplyType(activity.id, { replyType: typePick as (typeof REPLY_TYPES)[number] }), (result) => { toast({ title: "Reply type saved", body: `${lead.companyName}: ${REPLY_LABEL[typePick]}` }); onChanged({ kind: "typed", activity: result.activity }); refresh(); }); };
  function saved(draft: { id: string; status: string }, send: boolean) {
    setComposing(false); setError("");
    setJustSaved(send && draft.status === "ready" ? draft.id : "");
    toast(draft.status === "ready" ? { title: "Reply saved, ready to send", body: lead.companyName } : { title: "Saved for Claude to check", body: `${lead.companyName}. In a new chat, ask Claude: review drafts. Then send it from here.` });
    detail.reload(); refresh();
  }
  // A reply went out (through an account, or marked sent by hand): the API marks the message handled when the reply names it; one that
  // doesn't (an older Claude draft) is marked here. Then the list moves to the next reply.
  async function replyChanged(change: DraftChange) {
    setJustSaved("");
    if (change.kind !== "sent" || handled) { detail.reload(); return; }
    let cleared = change.draft.inReplyTo === activity.id;
    if (!cleared && !unconfirmedWhatsapp) cleared = await markActivityHandled(activity.id).then(() => true, () => false);
    if (!cleared) { detail.reload(); return; }
    onChanged({ kind: "handled", activity: { ...activity, handledAt: new Date().toISOString(), ...(session ? { handledBy: session.user.id } : {}) } });
  }

  return <article className="vso-fade-enter min-w-0">
    <div className="flex flex-wrap items-start gap-3 border-b border-neutral-100 px-4 py-4 sm:px-5">
      <button type="button" onClick={onBack} aria-label="Back to the list" className="-ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.95] lg:hidden"><ArrowLeft size={18} /></button>
      <ChannelTile channel={activity.kind} size={40} className="max-sm:hidden" />
      <div className="min-w-0 flex-1 basis-48">
        <h2 className="text-lg font-extrabold tracking-[-.02em] text-neutral-900 [overflow-wrap:anywhere]">{lead.companyName}{lead.city ? <span className="whitespace-nowrap font-semibold text-neutral-400"> · {lead.city}</span> : null}</h2>
        <p className="mt-0.5 text-xs font-medium text-neutral-500">{CHANNEL_LABEL[activity.kind] ?? activity.kind} reply{lead.contactName ? ` from ${lead.contactName}` : ""} · <span className="whitespace-nowrap">{stamp(activity.at)}</span></p>
      </div>
      {handled ? <Badge tone="green">Handled</Badge> : <span className="flex flex-wrap items-center justify-end gap-1.5"><SlaChip activity={activity} now={now} calendar={calendar} /><ReplyTypeChip {...(activity.replyType ? { type: activity.replyType } : {})} /></span>}
    </div>

    <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-4">
        <div className="space-y-3 rounded-2xl bg-neutral-50 p-3 sm:p-4" aria-label="Conversation">
          {detail.busy && !detail.data && <span className="vso-skeleton block h-12 w-2/3 rounded-2xl" />}
          {history.length > shown.length && <p className="text-center text-[11px] font-medium text-neutral-400">Earlier messages are on the lead.</p>}
          {shown.map((entry) => <Bubble key={entry.id} entry={entry} selected={entry.id === activity.id} who={entry.direction === "in" ? lead.contactName || lead.companyName : entry.via === "claude" ? `Claude, for ${personName(entry.actorId)}` : personName(entry.actorId)} loggedByClaude={entry.via === "claude" && entry.direction === "in"} />)}
          {detail.error && !detail.data && <p className="text-center text-[11px] text-neutral-400">Could not load the earlier messages. {detail.error}</p>}
        </div>

        <Notice tone="error" message={error} onDismiss={() => setError("")} />

        {doNotContact && <p role="note" className="rounded-2xl bg-danger-surface p-3.5 text-xs font-semibold leading-5 text-danger-text">On the do-not-contact list. Do not call or write to them again, on any channel.</p>}
        {unconfirmedWhatsapp && !handled && <p role="note" className="rounded-2xl bg-primary-50 p-3.5 text-xs leading-5 text-primary-900"><b>Claude logged this WhatsApp message.</b> WhatsApp stays off for {lead.companyName} until you confirm they really messaged us.</p>}

        {full && context && replyDrafts.map((draft) => <ReplyCard key={draft.id} draft={draft} lead={full} autoSend={draft.id === justSaved} heldBy={heldSibling(replyDrafts, draft)} detail={context} onChanged={(change) => void replyChanged(change)} />)}
        {closedReplies.length > 0 && <div className="space-y-1.5">{closedReplies.map((draft) => <ClosedReplyLine key={draft.id} draft={draft} />)}</div>}

        {composing && writer && !doNotContact && <ReplyComposer lead={full ?? lead} activity={activity} activities={detail.data ? history : null} pending={pendingReplies} onSaved={saved} onCancel={() => setComposing(false)} />}

        <div className="flex flex-wrap items-center gap-2">
          {writer && !doNotContact && !composing && !readyReply && <button type="button" onClick={() => { setComposing(true); setError(""); }} className={replyDrafts.length ? secondaryClass : primaryClass}><Reply size={16} />{replyDrafts.length ? "Write my own reply" : "Write a reply"}</button>}
          {writer && (!handled || unconfirmedWhatsapp) && <button type="button" onClick={markHandled} disabled={busy === "handled"} className={clsx(unconfirmedWhatsapp || doNotContact ? primaryClass : secondaryClass, "max-w-full", unconfirmedWhatsapp && "!h-auto !py-2.5 text-left leading-5")}><ActionLabel busy={busy === "handled"} busyText="Saving…" idle={<><Check size={16} className="shrink-0" />{unconfirmedWhatsapp ? "Confirm they messaged us on WhatsApp and mark handled" : "Mark handled"}</>} /></button>}
          <button type="button" onClick={() => openLead(lead.id)} className={secondaryClass}><ArrowUpRight size={16} />Open lead</button>
          {phone && phoneLink && writer && !doNotContact && <a href={phoneLink} className={secondaryClass}><Phone size={16} />Call</a>}
        </div>
        {teammate && <p className="text-xs text-neutral-500">{OWNER_ONLY_NOTE}</p>}
        {!writer && !teammate && <p className="text-xs text-neutral-500">You can read replies. The lead&apos;s owner or a venture head answers them.</p>}
        {writer && !handled && !doNotContact && replyDrafts.length === 0 && !composing && <AskClaude prompt="draft replies to my inbox" note="reviewed in a new chat, then sent from here" />}

        {!activity.replyType && writer && !doNotContact && <div className="space-y-2 rounded-2xl border border-warning-surface bg-warning-surface p-4">
          <p className="text-[13px] font-bold text-warning-text">What kind of reply is this?</p>
          <p className="text-xs leading-5 text-warning-text opacity-90">Nobody has sorted it yet. The kind decides the next step (and an opt-out puts them on the do-not-contact list), so pick one.</p>
          <div className="flex flex-wrap items-center gap-2"><div className="w-56 max-w-full"><Select aria-label="Reply type" className={inputClass} value={typePick} onChange={(event) => setTypePick(event.target.value)}><option value="">Choose…</option>{SORTABLE_TYPES.map((type) => <option key={type} value={type}>{REPLY_LABEL[type]}</option>)}</Select></div><button type="button" onClick={saveType} disabled={!typePick || busy === "type"} className={secondaryClass}><ActionLabel busy={busy === "type"} idle="Save" /></button></div>
        </div>}
      </div>

      <aside className="min-w-0 space-y-5 xl:border-l xl:border-neutral-100 xl:pl-5">
        <div className="space-y-2">
          <span className={kickerClass}>Lead</span>
          <div className="space-y-2 rounded-2xl bg-neutral-50 p-3.5">
            <button type="button" onClick={() => openLead(lead.id)} className="group flex w-full items-start justify-between gap-2 text-left"><span className="min-w-0"><span className="block text-sm font-bold text-neutral-900 [overflow-wrap:anywhere] group-hover:underline">{lead.companyName}</span><span className="block text-xs text-neutral-500">{[lead.contactName, lead.city].filter(Boolean).join(" · ") || "No contact name yet"}</span></span><ArrowUpRight size={15} className="mt-0.5 shrink-0 text-neutral-400" aria-hidden="true" /></button>
            <div className="flex flex-wrap gap-1.5"><StageChip stage={lead.stage} /><VerdictChip verdict={lead.verdict} /></div>
            {lead.verdict?.summary && <p className="text-xs leading-5 text-neutral-600">{lead.verdict.summary}</p>}
            {lead.whatsappOptIn && <p className="text-xs font-semibold text-success-text">WhatsApp OK: {OPT_IN_LABEL[lead.whatsappOptIn.how].toLowerCase()}</p>}
            <p className="text-xs text-neutral-500">Owner <b className="font-semibold text-neutral-700">{personName(lead.ownerId)}</b></p>
            {lead.nextAction && <p className="flex items-start gap-1.5 text-xs text-neutral-600"><Clock3 size={13} className="mt-0.5 shrink-0 text-neutral-400" aria-hidden="true" /><span>{lead.nextAction}{lead.nextActionAt ? ` · ${when(lead.nextActionAt)}` : ""}</span></p>}
            {full?.doNotContact && <p className="text-xs font-semibold text-danger-text">On the do-not-contact list</p>}
          </div>
        </div>
        {activity.replyType && <div className="space-y-2">
          <span className={kickerClass}>What to do</span>
          <p className="rounded-2xl bg-neutral-50 p-3.5 text-xs leading-5 text-neutral-700">{NEXT_STEP[activity.replyType]?.replace("{sla}", `${calendar.hours} working hour${calendar.hours === 1 ? "" : "s"}`)}</p>
        </div>}
        {handled && activity.handledBy && <p className="text-xs text-neutral-500">Handled by {personName(activity.handledBy)}{activity.handledAt ? `, ${stamp(activity.handledAt)}` : ""}</p>}
      </aside>
    </div>
  </article>;
}

function Bubble({ entry, selected, who, loggedByClaude }: { entry: Activity; selected: boolean; who: string; loggedByClaude: boolean }) {
  const mine = entry.direction === "out";
  if (!MESSAGE_KINDS.includes(entry.kind)) {
    const label = entry.kind === "call" ? `${mine ? "Call" : "Called us"}${entry.callOutcome ? `: ${CALL_OUTCOME_LABEL[entry.callOutcome]}` : ""}` : CHANNEL_LABEL[entry.kind] ?? entry.kind;
    return <p className={clsx("rounded-xl px-3 py-1.5 text-center text-[11px] font-medium text-neutral-500", selected && "bg-primary-50 text-primary-800")}>{label} · {stamp(entry.at)}{loggedByClaude ? " · logged by Claude" : ""}{entry.body ? ` · ${entry.body}` : ""}</p>;
  }
  return <div className={clsx("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
    <span className="px-1 text-[11px] text-neutral-400"><b className="font-semibold text-neutral-500">{who}</b> · {stamp(entry.at)}{loggedByClaude && <span className="ml-1.5 inline-flex rounded bg-ai-surface px-1.5 py-0.5 text-[10px] font-semibold text-ai-text">logged by Claude</span>}</span>
    <div className={clsx("max-w-[92%] rounded-2xl px-4 py-2.5 text-sm leading-6 [overflow-wrap:anywhere] sm:max-w-[85%]", mine ? "rounded-br-md border border-primary-200 bg-primary-100 text-neutral-900" : "rounded-bl-md border border-neutral-200 bg-white text-neutral-800", selected && "ring-2 ring-primary-400 ring-offset-2 ring-offset-neutral-50")}><p className="whitespace-pre-wrap">{entry.body || "(no text)"}</p></div>
    {mine && entry.message?.delivery && <DeliveryTicks delivery={entry.message.delivery} className="px-1" />}
  </div>;
}
