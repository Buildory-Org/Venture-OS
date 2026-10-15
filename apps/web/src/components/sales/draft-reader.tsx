"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import type { Activity, ChannelAccount, Draft, Play } from "@venture-studio/contracts";
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, CircleAlert, CircleCheck, Clock3, Copy, Edit, Info, Mail, RotateCcw, Send, ShieldCheck, Sparkles, X, type Icon } from "@/components/ui/icons";
import { SlidingTabs, tabDomId } from "@/components/ui/sliding-tabs";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { ActionLabel, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { approveDraft, discardDraft, getDraft, getLead, markDraftSent, updateDraft, vetoDraft, type ReviewDraft, type SalesSettingsView } from "@/lib/sales-api";
import { errorCode, type SendResult } from "@/lib/sales-channels-api";
import { Instagram, Linkedin, Phone, Trash, UserX, Whatsapp } from "./draft-icons";
import { approvalOf, canApprove, canEditLead, canWriteIn, CHANNEL_ICON, copyText, CHANNEL_LABEL, kickerClass, OPT_IN_LABEL, PURPOSE_LABEL, routeOf, shortSession, stamp, telHref, useSalesLoad, wordCount, type ApprovalReason } from "./draft-shared";
import { accountLabel, usableAccounts, useChannelAccounts } from "./channel-model";
import { DeliveryReconcile, replyWindow, SendBox, SentFromPicker } from "./channel-send";
import { DeliveryTicks } from "./channel-delivery";
import { ActionMenu, type MenuAction } from "./action-menu";
import { AskClaude } from "./ask-claude";
import { answeredBy, closedLabel, handLabel, heldLine, heldSibling, isOpenDraft, isOwnReply, isVersioned, noRouteLabel, reachableOnWhatsapp, recordedLine, sendFromLabel, sendPlanOf, TONE_DOT, TONE_TEXT, versionLabels, versionStatus, type HandApp } from "./draft-plan";
import { useSalesShell } from "./sales-context";
import { StageChip, VerdictChip, when } from "./sales-ui";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
export const DRAFT_STATUS: Record<Draft["status"], { label: string; tone: Tone }> = {
  draft: { label: "Not submitted", tone: "neutral" }, in_review: { label: "To review", tone: "blue" }, ready: { label: "Ready to send", tone: "green" },
  needs_changes: { label: "Needs changes", tone: "amber" }, sent: { label: "Sent", tone: "purple" }, vetoed: { label: "Vetoed", tone: "red" }, discarded: { label: "Discarded", tone: "neutral" },
};

/**
 * "delivery": the draft stays open with a new delivery state (a send that could not be confirmed, or one a person said didn't go).
 * "reloaded": a send was refused because the draft changed since it was opened (409 DRAFT_CHANGED): this is the draft as it is now, open
 * or not (sent or closed meanwhile).
 */
export type DraftChange = { kind: "edited" | "approved" | "sent" | "closed" | "delivery" | "reloaded"; draft: Draft };
/** The lead's messages and drafts, when the screen already has them (the Inbox): the reader then doesn't read the lead again. */
export type LeadContext = { activities: readonly Activity[]; drafts: readonly Draft[] };
export type Approval = { needed: boolean; reason: ApprovalReason | null };
/** Where a hand-sent message went from, in the confirm and the Sent note. */
const OWN_APP: Record<string, string> = { email: "mail app", whatsapp: "WhatsApp", linkedin: "LinkedIn", instagram: "Instagram" };
const HAND_ICON: Record<HandApp, Icon> = { mail: Mail, whatsapp: Whatsapp, linkedin: Linkedin, instagram: Instagram };
const COPIED: Record<HandApp, string> = { mail: "Copied. Your mail app is opening.", whatsapp: "Copied.", linkedin: "Copied. Paste it into LinkedIn.", instagram: "Copied. Paste it into Instagram." };
const LINKEDIN_NOTE_LIMIT = 300;
const MISSING_WHATSAPP = "missing-whatsapp";
const CHANGED_SINCE = "This draft changed since you opened it. Read it again before sending.";
/** The main button of the send area: full width on a phone, its own width from a tablet up (narrower when its row is, as in the Inbox). */
const mainButton = clsx(primaryClass, "!min-h-11 min-w-0 flex-1 py-2 sm:flex-initial");
/** A long label ("Send from someone@company.com") wraps onto a second line on a phone rather than being cut. */
const labelWrap = "min-w-0 text-center leading-5 [overflow-wrap:anywhere]";

/**
 * The right-hand pane of Review: one lead's versions of a message (an email and a WhatsApp version of the same first message) as tabs,
 * and the open version with Claude's review on top and one main action under it. `allowMissing`: offer a WhatsApp tab that explains how to
 * get a WhatsApp version when the lead could be reached there and has none.
 */
export function DraftVersions({ versions, selected, onSelect, approvalFor, playFor, settingsFor, allowMissing, editNonce, onBack, onChanged }: {
  versions: ReviewDraft[]; selected: ReviewDraft; onSelect: (draftId: string) => void; approvalFor: (draft: ReviewDraft) => Approval;
  playFor: (draft: ReviewDraft) => Play | undefined; settingsFor: (draft: ReviewDraft) => SalesSettingsView | undefined;
  allowMissing: boolean; editNonce: number; onBack: () => void; onChanged: (change: DraftChange) => void;
}) {
  const { openLead, personName } = useSalesShell();
  const lead = selected.lead;
  const [missingOpen, setMissingOpen] = useState(false);
  const labels = versionLabels(versions);
  // Versions the list doesn't hold (filtered to Mine, past the first 100, or a draft opened from a link): the API names them on the draft.
  const elsewhere = (selected.otherVersions ?? []).filter((other) => !versions.some((draft) => draft.id === other.id));
  const showMissing = allowMissing && isOpenDraft(selected) && selected.purpose !== "reply" && ![...versions, ...elsewhere].some((draft) => draft.channel === "whatsapp") && reachableOnWhatsapp(lead);
  const siblings = versions.filter((draft) => draft.purpose === selected.purpose && isOpenDraft(draft)).length + elsewhere.length;
  const oneOfMany = isVersioned(selected.purpose) && isOpenDraft(selected) && (siblings > 1 || showMissing);
  const active = missingOpen && showMissing ? MISSING_WHATSAPP : selected.id;
  const play = playFor(selected);
  const settings = settingsFor(selected);
  // Another version whose send is held (in flight, or waiting for a person to say whether it went out): this one waits until it is settled.
  const held = isOpenDraft(selected) ? heldSibling(versions, selected) : undefined;
  const panelId = useId();

  const tabs = versions.map((draft) => {
    const status = versionStatus(draft, approvalFor(draft).needed);
    const ChannelIcon = CHANNEL_ICON[draft.channel] ?? Mail;
    return { key: draft.id, label: <span className="flex items-center gap-2"><ChannelIcon size={15} aria-hidden="true" />{labels[draft.id]}<span className={clsx("inline-flex items-center gap-1 text-[11px] font-semibold", TONE_TEXT[status.tone])}><span aria-hidden="true" className={clsx("h-1.5 w-1.5 rounded-full", TONE_DOT[status.tone])} /><span className="sr-only">: </span>{status.label}</span></span> };
  });
  for (const other of elsewhere) {
    const status = versionStatus(other, false);
    const ChannelIcon = CHANNEL_ICON[other.channel] ?? Mail;
    tabs.push({ key: other.id, label: <span className="flex items-center gap-2"><ChannelIcon size={15} aria-hidden="true" />{CHANNEL_LABEL[other.channel] ?? other.channel}<span className={clsx("inline-flex items-center gap-1 text-[11px] font-semibold", TONE_TEXT[status.tone])}><span aria-hidden="true" className={clsx("h-1.5 w-1.5 rounded-full", TONE_DOT[status.tone])} /><span className="sr-only">: </span>{status.label}</span></span> });
  }
  if (showMissing) tabs.push({ key: MISSING_WHATSAPP, label: <span className="flex items-center gap-2"><Whatsapp size={15} aria-hidden="true" />WhatsApp<span className="text-[11px] font-semibold text-neutral-400"><span className="sr-only">: </span>None yet</span></span> });

  return <article className="vso-fade-enter min-w-0">
    <header className="border-b border-neutral-100 px-4 pb-3 pt-4 sm:px-5">
      <div className="flex items-start gap-3">
        <button type="button" onClick={onBack} aria-label="Back to the list" className="-ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.95] lg:hidden"><ArrowLeft size={18} /></button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold tracking-[-.02em] text-neutral-900 [overflow-wrap:anywhere]">
            <button type="button" onClick={() => openLead(lead.id)} title="Open the lead" className="group inline rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="group-hover:underline">{lead.companyName}</span>{lead.city ? <span className="font-semibold text-neutral-400"> · {lead.city}</span> : null}<ArrowUpRight size={14} aria-hidden="true" className="ml-1 inline align-baseline text-neutral-400" /></button>
          </h2>
          <p className="mt-0.5 text-xs font-medium text-neutral-500">{PURPOSE_LABEL[selected.purpose]}{lead.contactName ? ` for ${lead.contactName}` : ""} · Owner {personName(lead.ownerId)}</p>
        </div>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 max-sm:hidden"><StageChip stage={lead.stage} /><VerdictChip verdict={lead.verdict} /></span>
      </div>
      <SlidingTabs label={`Versions for ${lead.companyName}`} active={active} panelId={panelId} className="mt-3 !bg-neutral-50 ring-1 ring-inset ring-neutral-100"
        onChange={(key) => { if (key === MISSING_WHATSAPP) setMissingOpen(true); else { setMissingOpen(false); if (key !== selected.id) onSelect(key); } }} tabs={tabs} />
      {oneOfMany && <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-neutral-500"><Info size={13} aria-hidden="true" className="mt-px shrink-0 text-neutral-400" />{selected.purpose === "follow_up" ? "The follow-up" : "The first message"} goes out on one channel: sending one version closes the others.</p>}
    </header>
    <div role="tabpanel" id={panelId} aria-labelledby={tabDomId(panelId, active)}>
      {active === MISSING_WHATSAPP
        ? <MissingWhatsapp draft={selected} />
        : <DraftReader key={selected.id} draft={selected} {...(play ? { play } : {})} {...(settings ? { settings } : {})} {...(held ? { heldBy: held } : {})} editNonce={editNonce} onChanged={onChanged} />}
    </div>
  </article>;
}

/** The WhatsApp tab of a lead that has no WhatsApp version: how to get one, and whether it could be sent. */
function MissingWhatsapp({ draft }: { draft: ReviewDraft }) {
  const { session, openLead } = useSalesShell();
  const lead = draft.lead;
  const editor = canEditLead(session, lead);
  return <div className="vso-fade-enter space-y-4 p-4 sm:p-5">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-success-surface text-success-text"><Whatsapp size={19} /></span>
      <div className="min-w-0">
        <h3 className="text-[15px] font-bold text-neutral-900">No WhatsApp version yet</h3>
        <p className="mt-1 text-xs leading-5 text-neutral-500">Ask Claude for one. It lands here as its own tab beside the {CHANNEL_LABEL[draft.channel]?.toLowerCase() ?? "other"} version and goes through the same review.</p>
      </div>
    </div>
    <AskClaude prompt={`write a WhatsApp version for ${lead.companyName}`} />
    {lead.whatsappOptIn
      ? <p className="flex items-center gap-1.5 text-xs font-semibold text-success-text"><Whatsapp size={13} aria-hidden="true" />WhatsApp OK: {OPT_IN_LABEL[lead.whatsappOptIn.how]?.toLowerCase() ?? "they opted in"}, {stamp(lead.whatsappOptIn.at)}</p>
      : <Callout tone="amber" icon={Whatsapp} title="It can only be sent once they opt in">{lead.companyName} hasn&apos;t said yes to WhatsApp yet. They opt in when they message the venture&apos;s WhatsApp, or say yes on a call or by email, and a person records it on the lead. Until then, the email or a call goes first.{editor && <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><button type="button" onClick={() => openLead(lead.id)} className="inline-flex min-h-8 items-center gap-1.5 font-semibold underline underline-offset-2"><Check size={14} aria-hidden="true" />Record their yes on the lead</button><WorkspaceLink href={`/sales/live/calls?call=${encodeURIComponent(lead.id)}`} className="inline-flex min-h-8 items-center gap-1.5 font-semibold underline underline-offset-2"><Phone size={14} aria-hidden="true" />Call instead</WorkspaceLink></span>}</Callout>}
  </div>;
}

/**
 * One draft: Claude's review on top, the message, then one main action (send, approve, fix) with the rest under More. `inline`: shown
 * inside another screen (the Inbox's reply card): no padding, no "Why this lead", and the send row is not pinned. `autoSend`: the person
 * just said "Save and send", so a send through a connected account opens its confirm straight away. `heldBy`: another version (or reply)
 * whose send isn't settled yet, so this one's send waits. `detail`: the lead's messages and drafts when the screen has them.
 * Every send names the version the person read (`expectedUpdatedAt`): a draft changed since is refused, read again and never resent by itself.
 */
export function DraftReader({ draft, play, settings, editNonce, onChanged, inline = false, autoSend = false, heldBy, detail }: {
  draft: ReviewDraft; play?: Play; settings?: SalesSettingsView; editNonce: number; onChanged: (change: DraftChange) => void; inline?: boolean; autoSend?: boolean;
  heldBy?: Pick<Draft, "channel" | "purpose"> | undefined; detail?: LeadContext | null | undefined;
}) {
  const { session, refresh, personName, ventureName } = useSalesShell();
  const lead = draft.lead;
  // What this person may do here, as the API decides it: any writer in the venture vetoes and copies; the lead's owner, a venture head
  // or an admin edits, sends and discards (the draft's author may discard too). Learners only read.
  const writer = canWriteIn(session, draft.ventureId);
  const editor = canEditLead(session, lead);
  const mayDiscard = editor || (writer && draft.authorId === session?.user.id);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);
  const [confirm, setConfirm] = useState<"sent" | "veto" | "discard" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // A send was refused because the draft changed since it was opened: said in the send row, where the person is looking.
  const [stale, setStale] = useState(false);
  const questionId = useId();
  const noteId = useId();
  // Nothing is sent to, or opened for, a company on the do-not-contact list.
  const doNotContact = lead.doNotContact;

  const open = isOpenDraft(draft);
  // A reply a person wrote and approved themselves: a person's edit keeps it ready (the API decides), every other edit goes back to review.
  const keepsReady = draft.status === "ready" && isOwnReply(draft);
  const isEmail = draft.channel === "email";
  const isCallOpener = draft.channel === "call_opener";
  const approval = approvalOf(draft, play, settings);
  const mayApprove = approval.needed && canApprove(session, draft, approval.reason);
  const whatsappLocked = draft.channel === "whatsapp" && !lead.whatsappOptIn;
  const approver = approval.reason === "every_message" ? "the lead's owner or a venture head" : "a venture head";
  const emailRoute = routeOf(lead.contactRoutes, "email");
  const phoneRoute = routeOf(lead.contactRoutes, "whatsapp", "phone");
  const phoneLink = phoneRoute ? telHref(phoneRoute.value) : "";
  const linkedinRoute = routeOf(lead.contactRoutes, "linkedin");
  const instagramRoute = routeOf(lead.contactRoutes, "instagram");
  const fullText = isEmail && draft.subject ? `Subject: ${draft.subject}\n\n${draft.body}` : draft.body;
  // Where a send through an account really goes (the API works it out: the number they wrote from, the linked Instagram conversation), else the route on file.
  const toLine = draft.sendTarget?.to || (isEmail ? emailRoute?.value : draft.channel === "linkedin" ? linkedinRoute?.value : draft.channel === "instagram" ? instagramRoute?.value : phoneRoute?.value);

  // Connected accounts (Sales > Channels): a ready email, WhatsApp or Instagram draft goes out through one with Send; a hand-sent email or
  // LinkedIn message can say which mailbox or profile it went from. Without channels on the server, everything works as before.
  const delivery = draft.delivery;
  const uncertain = draft.status === "ready" && delivery?.state === "uncertain";
  // A send in flight (from another tab or person) or one waiting for an answer holds the draft: no second send, no edits.
  const inFlight = draft.status === "ready" && delivery?.state === "sending";
  const held = uncertain || inFlight;
  const sendChannel = draft.channel === "email" || draft.channel === "whatsapp" || draft.channel === "instagram";
  const { accounts: channelAccounts, available: channelsOn } = useChannelAccounts(editor || draft.status === "sent");
  const sendAccounts = sendChannel ? usableAccounts(channelAccounts, draft.ventureId, draft.channel, session?.user.id) : [];
  const handAccounts = isEmail || draft.channel === "linkedin" ? usableAccounts(channelAccounts, draft.ventureId, draft.channel, session?.user.id) : [];
  const [sentFrom, setSentFrom] = useState<string | null>(null);
  const sentFromId = sentFrom ?? handAccounts[0]?.id ?? "";
  // WhatsApp and Instagram only allow free text within 24 hours of the lead's last message: their messages say whether that window is open.
  const windowChannel = draft.channel === "whatsapp" || draft.channel === "instagram" ? draft.channel : null;
  const needWindow = Boolean(windowChannel) && editor && draft.status === "ready" && !approval.needed && !doNotContact && sendAccounts.length > 0;
  // The lead's messages and drafts also say whether a reply's message was already answered, and which version a bounce opened again.
  const bounced = draft.status === "sent" && delivery?.state === "bounced";
  const needDetail = detail === undefined && (needWindow || (open && draft.purpose === "reply" && Boolean(draft.inReplyTo)) || bounced);
  const leadDetail = useSalesLoad(`draft-detail|${lead.id}|${needDetail}`, () => needDetail ? getLead(lead.id) : Promise.resolve(null));
  const context: LeadContext | null = detail !== undefined ? detail : leadDetail.data;
  const replyOpen = windowChannel ? replyWindow(needWindow ? context?.activities : [], windowChannel, sendAccounts[0]?.id) : "open";
  const answered = answeredBy(draft, context);
  const reopened = bounced ? (context?.drafts ?? []).filter((other) => other.id !== draft.id && other.reopenedBecause === "bounced" && isOpenDraft(other) && other.purpose === draft.purpose && (draft.purpose !== "reply" || other.inReplyTo === draft.inReplyTo)) : [];
  const instagramClosed = draft.channel === "instagram" && replyOpen === "closed";
  const plan = sendPlanOf({ draft, lead, approvalNeeded: approval.needed, sendAccounts, instagramClosed });
  const sentThroughLabel = draft.sentAccountId ? accountLabel(channelAccounts, draft.sentAccountId) : "";
  // A hand-sent message can be recorded whenever it could be sent: ready, approved, not locked, not held by a send through an account
  // (this one's, or another version's), and not a reply to a message that was already answered.
  const sendable = plan.kind === "through" || plan.kind === "hand" || plan.kind === "no_route";
  const mayMarkSent = editor && sendable && !heldBy && !answered;

  const startEdit = useCallback(() => { setSubject(draft.subject ?? ""); setBody(draft.body); setConfirm(null); setError(""); setStale(false); setEditing(true); }, [draft.subject, draft.body]);
  const seenNonce = useRef(editNonce);
  useEffect(() => {
    if (editNonce === seenNonce.current) return;
    seenNonce.current = editNonce;
    if (editor && isOpenDraft(draft) && !held) queueMicrotask(startEdit);
  }, [editNonce, editor, draft, held, startEdit]);
  // One request id for marking this draft sent, made when the question opens and kept for retries, so a retry after a lost answer
  // repeats the first one instead of logging the message twice.
  const sentRequestId = useRef("");
  // The question (or the veto and discard confirms) opens under the buttons: bring it into view (on a phone it would sit below the fold) and
  // move focus to its first button (the veto's reason box); closing it gives focus back to what opened it (More, or the send link).
  const confirmBox = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!confirm) return;
    confirmBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    confirmBox.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [confirm]);
  function openConfirm(kind: "sent" | "veto" | "discard") {
    const from = document.activeElement;
    if (!confirm) returnFocus.current = from instanceof HTMLElement && from !== document.body ? from : null;
    setConfirm(kind); setError("");
  }
  function closeConfirm() {
    setConfirm(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target) requestAnimationFrame(() => { if (target.isConnected) target.focus({ preventScroll: true }); });
  }

  // The draft changed since it was opened (edited, reviewed or approved in another tab or by someone else): say so and read it again. The
  // send is never repeated by itself; the person reads it and sends again.
  async function readAgain() {
    sentRequestId.current = "";
    closeConfirm();
    setError(""); setStale(true);
    try {
      const fresh = await getDraft(draft.id);
      if (fresh) onChanged({ kind: "reloaded", draft: fresh });
      // Sent or closed meanwhile: the reader goes with it, so the toast says it, and every list reloads.
      if (!fresh || !isOpenDraft(fresh)) { toast({ tone: "info", title: "This draft changed since you opened it", body: fresh ? `${lead.companyName}: it was ${fresh.status === "sent" ? "sent" : "closed"} meanwhile.` : lead.companyName }); refresh(); }
    } catch { refresh(); }
  }

  async function run<T>(name: string, action: () => Promise<T>, done: (result: T) => void) {
    setBusy(name); setError(""); setStale(false);
    try { done(await action()); }
    catch (cause) { if (errorCode(cause) === "DRAFT_CHANGED") void readAgain(); else setError(describeError(cause, "That did not work. Try again.")); }
    finally { setBusy(""); }
  }

  function save() {
    const text = body.trim();
    if (!text) { setError("Write the message first."); return; }
    const change: { subject?: string; body?: string } = {};
    if (text !== draft.body) change.body = text;
    if (isEmail && subject.trim() !== (draft.subject ?? "")) change.subject = subject.trim();
    if (!change.body && change.subject === undefined) { setEditing(false); return; }
    void run("save", () => updateDraft(draft.id, change), (updated) => {
      setEditing(false);
      toast({ title: updated.status === "ready" ? "Saved. Still ready to send." : "Saved. It goes back to review.", body: lead.companyName });
      onChanged({ kind: "edited", draft: updated }); refresh();
    });
  }
  const approve = () => void run("approve", () => approveDraft(draft.id), (updated) => { toast({ title: "Approved", body: `${lead.companyName}. You can send it now.` }); onChanged({ kind: "approved", draft: updated }); refresh(); });
  function askSent() {
    if (!sentRequestId.current) sentRequestId.current = crypto.randomUUID();
    openConfirm("sent");
  }
  const markSent = () => void run("sent", () => markDraftSent(draft.id, { sentVia: "manual", requestId: sentRequestId.current || (sentRequestId.current = crypto.randomUUID()), expectedUpdatedAt: draft.updatedAt, ...(sentFromId && handAccounts.some((account) => account.id === sentFromId) ? { accountId: sentFromId } : {}) }), (result) => {
    setConfirm(null);
    toast({ title: "Marked as sent", body: result.lead.followUpDueAt ? `${lead.companyName}. Follow-up due ${when(result.lead.followUpDueAt)}.` : lead.companyName });
    onChanged({ kind: "sent", draft: result.draft }); refresh();
  });
  function veto() {
    if (reason.trim().length < 3) { setError("Say why in a few words, so Claude and the team learn from it."); return; }
    void run("veto", () => vetoDraft(draft.id, { reason: reason.trim() }), (updated) => { setConfirm(null); setReason(""); toast({ title: "Vetoed", body: lead.companyName }); onChanged({ kind: "closed", draft: updated }); refresh(); });
  }
  function sentThrough(result: SendResult, account: ChannelAccount) {
    if (result.outcome === "sent") {
      toast({ title: `Sent from ${account.label}`, body: result.lead?.followUpDueAt ? `${lead.companyName}. Follow-up due ${when(result.lead.followUpDueAt)}.` : lead.companyName });
      onChanged({ kind: "sent", draft: result.draft });
    } else {
      toast({ tone: "info", title: "Couldn't confirm it went out", body: `${account.label} didn't answer in time. Check it, then say what happened.` });
      onChanged({ kind: "delivery", draft: result.draft });
    }
    refresh();
  }
  function reconciled(outcome: "sent" | "not_sent", updated: Draft) {
    toast(outcome === "sent" ? { title: "Recorded as sent", body: lead.companyName } : { tone: "info", title: "Recorded as not sent", body: `${lead.companyName}. You can send it again.` });
    onChanged({ kind: outcome === "sent" ? "sent" : "delivery", draft: updated }); refresh();
  }
  const discard = () => void run("discard", () => discardDraft(draft.id), (updated) => { setConfirm(null); toast({ title: "Discarded", body: lead.companyName }); onChanged({ kind: "closed", draft: updated }); refresh(); });

  // Everything but the main action, behind More. While a send waits for a person to say whether it went out, the draft is neither changed nor closed.
  const items: MenuAction[] = [
    ...(editor && open && !held && plan.kind !== "needs_changes" ? [{ key: "edit", label: "Edit", icon: Edit, shortcut: "e", onSelect: startEdit }] : []),
    { key: "copy", label: "Copy text", icon: Copy, onSelect: () => void copyText(fullText) },
    ...(mayMarkSent ? [{ key: "sent", label: "I sent it myself", icon: Check, onSelect: askSent }] : []),
    ...(writer && !held ? [{ key: "veto", label: "Veto", icon: X, danger: true, onSelect: () => openConfirm("veto") }] : []),
    ...(mayDiscard && !held ? [{ key: "discard", label: "Discard", icon: Trash, danger: true, onSelect: () => openConfirm("discard") }] : []),
  ];
  const more = <ActionMenu items={items} label={`More for the ${CHANNEL_LABEL[draft.channel]?.toLowerCase() ?? ""} version`} />;
  const quiet = (text: React.ReactNode, icon: Icon = Info) => { const QuietIcon = icon; return <p className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-xs font-medium leading-5 text-neutral-500"><QuietIcon size={14} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="min-w-0">{text}</span></p>; };
  const row = (main: React.ReactNode) => <div className="flex items-center gap-2">{main}{more}</div>;

  let main: React.ReactNode = null;
  let note: React.ReactNode = null;
  if (answered && plan.kind !== "held") main = row(quiet("Already answered: nothing to send.", CircleCheck));
  else if (plan.kind === "approve") {
    main = row(mayApprove ? <button type="button" onClick={approve} disabled={busy === "approve"} className={mainButton}><ActionLabel busy={busy === "approve"} busyText="Approving…" idle={<><Check size={16} aria-hidden="true" />Approve this message</>} /></button> : quiet(`Waits for ${approver} to approve it.`, ShieldCheck));
    note = approval.reason === "every_message" ? `${ventureName(draft.ventureId)} has a person approve every message before it goes out (its sales settings).` : `${play?.name ? `${play.name} is` : "Its play is"} still in its first batch, so a venture head reads each message before it goes out.`;
  } else if (!editor && (plan.kind === "through" || plan.kind === "hand" || plan.kind === "no_route" || plan.kind === "needs_changes")) main = row(quiet(`Only the lead's owner or a venture head can ${plan.kind === "needs_changes" ? "fix" : "send"} this draft.`));
  else if (heldBy && sendable) {
    // Only one version goes out: while another one's send is unsettled, this one's main button waits, saying which one to settle.
    const label = plan.kind === "through" ? sendFromLabel(draft.channel, plan.accounts[0]) : plan.kind === "hand" ? handLabel(plan) : noRouteLabel(plan);
    const HeldIcon = plan.kind === "through" ? Send : plan.kind === "hand" && plan.href ? HAND_ICON[plan.app] : plan.kind === "hand" ? Copy : Mail;
    main = row(<button type="button" disabled aria-describedby={noteId} className={mainButton}><HeldIcon size={16} aria-hidden="true" className="shrink-0" /><span className={labelWrap}>{label}</span></button>);
    note = heldLine(heldBy);
  }
  else if (plan.kind === "through") main = <SendBox draft={draft} accounts={plan.accounts} recipient={toLine} window={replyOpen} names={{ contact: lead.contactName, company: lead.companyName }} lastFailure={delivery?.state === "failed" ? delivery.error || "the last try failed." : undefined} more={more} startOpen={autoSend} onResult={sentThrough} onFailed={refresh} onStale={() => void readAgain()} />;
  else if (plan.kind === "hand") {
    const HandIcon = plan.href ? HAND_ICON[plan.app] : Copy;
    const onHand = () => { if (plan.copyFirst || !plan.href) void copyText(fullText, plan.href ? COPIED[plan.app] : "Copied. Paste it where you send it."); askSent(); };
    main = row(plan.href
      ? <a href={plan.href} {...(plan.app === "mail" ? {} : { target: "_blank", rel: "noopener noreferrer" })} onClick={onHand} className={mainButton}><HandIcon size={16} aria-hidden="true" className="shrink-0" /><span className={labelWrap}>{handLabel(plan)}</span></a>
      : <button type="button" onClick={onHand} className={mainButton}><HandIcon size={16} aria-hidden="true" className="shrink-0" /><span className={labelWrap}>{handLabel(plan)}</span></button>);
  } else if (plan.kind === "no_route") main = row(<button type="button" disabled className={mainButton}>{plan.app === "whatsapp" ? <Whatsapp size={16} aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}<span className={labelWrap}>{noRouteLabel(plan)}</span></button>);
  else if (plan.kind === "needs_changes") { main = row(<button type="button" onClick={startEdit} className={mainButton}><Edit size={16} aria-hidden="true" />Edit the message</button>); note = "Saving sends it back to Claude's review."; }
  else if (plan.kind === "waiting_review") main = row(quiet(plan.submitted ? "It can be sent once Claude's review passes." : "Edit it and save to send it for review."));
  else if (plan.kind === "call_script") main = row(<>{editor && <WorkspaceLink href={`/sales/live/calls?call=${encodeURIComponent(lead.id)}`} className={mainButton}><Phone size={16} aria-hidden="true" />Start the call</WorkspaceLink>}{editor && phoneLink && <a href={phoneLink} className={clsx(secondaryClass, "!min-h-11 max-sm:hidden")}>Call {phoneRoute?.value}</a>}{!editor && quiet("A script to read on the call.")}</>);
  else if (plan.kind === "whatsapp_locked" || plan.kind === "do_not_contact") main = row(quiet(plan.kind === "do_not_contact" ? "Nothing can be sent to them." : "Nothing can be sent on WhatsApp yet."));
  else if (plan.kind === "held") main = row(quiet("Waiting to hear whether it went out."));
  const recorded = editor && !answered ? recordedLine(plan, plan.kind === "through" ? plan.accounts[0] : undefined) : "";
  const connectMailbox = editor && isEmail && channelsOn && (plan.kind === "hand" || plan.kind === "no_route");

  return <div className={clsx("space-y-4", !inline && "p-4 sm:p-5")}>
    {(open || draft.review) && <ReviewStrip draft={draft} approval={approval} />}
    {writer && open && !editing && connectMailbox && confirm !== "sent" && <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary-200 bg-primary-50 p-3.5">
        <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-primary-700"><Mail size={17} /></span>
        <div className="min-w-0 flex-1 basis-56"><p className="text-[13px] font-bold text-primary-900">Send straight from here: connect your mailbox once</p><p className="mt-0.5 text-xs leading-5 text-primary-800">Then this button sends it from your own address, keeps a copy in your Sent folder and brings replies into Sales &gt; Inbox.</p></div>
        <WorkspaceLink href="/sales/live/channels" className={clsx(secondaryClass, "!min-h-10 max-sm:w-full")}>Connect a mailbox<ArrowUpRight size={14} aria-hidden="true" /></WorkspaceLink>
      </div>}

    {open && draft.reopenedBecause === "bounced" && <p className="flex items-center gap-1.5 text-xs font-semibold text-warning-text"><RotateCcw size={13} aria-hidden="true" className="shrink-0" />Reopened: the email bounced{draft.reopenedAt ? <span className="font-medium opacity-80"> · {stamp(draft.reopenedAt)}</span> : null}</p>}
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
      <span className="min-w-0">To <b className="font-semibold text-neutral-800 [overflow-wrap:anywhere]">{toLine || (isCallOpener ? "a phone call" : "no route on file")}</b></span>
      <span>Written by <b className="font-semibold text-neutral-800">{draft.authorVia === "claude" ? `Claude, for ${personName(draft.authorId)}` : personName(draft.authorId)}</b></span>
      <span>{stamp(draft.createdAt)}</span>
    </p>

    {editing ? <form onSubmit={(event) => { event.preventDefault(); save(); }} className="space-y-3 rounded-2xl border border-primary-300 bg-white p-4 ring-2 ring-primary-100">
      {isEmail && <Field label="Subject"><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} className={inputClass} /></Field>}
      <Field label="Message"><textarea value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); save(); } }} maxLength={5000} autoFocus rows={10} className={clsx(inputClass, "min-h-48 py-3 leading-7")} /></Field>
      <p className="text-xs text-neutral-500">{wordCount(body)} words. {keepsReady ? "A reply a person writes needs no review: it stays ready to send, approved by you." : "Saving sends it back for Claude to review again, and clears any approval."}</p>
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy === "save"} className={clsx(primaryClass, "max-sm:flex-1")}><ActionLabel busy={busy === "save"} idle={keepsReady ? "Save" : "Save and send back to review"} /></button><button type="button" onClick={() => setEditing(false)} className={clsx(secondaryClass, "max-sm:flex-1")}>Cancel</button></div>
    </form> : <DraftMessage draft={draft} />}

    <Notice tone="error" message={error || (stale && !(writer && open && main) ? CHANGED_SINCE : "")} onDismiss={() => { setError(""); setStale(false); }} />

    {draft.status === "sent" && <Callout tone="green" icon={CircleCheck} title="Sent">{draft.sentBy ? `${personName(draft.sentBy)} sent this` : "Sent"}{draft.sentAt ? ` on ${stamp(draft.sentAt)}` : ""}{draft.sentVia && draft.sentVia !== "manual" ? ` from ${sentThroughLabel || "a connected account"}, through the app. Replies arrive in Sales > Inbox.` : ` from their own ${OWN_APP[draft.channel] ?? "phone"}. The app only recorded it: log replies with They replied on the lead.`}{delivery && <span className="mt-1 block"><DeliveryTicks delivery={delivery} /></span>}</Callout>}
    {bounced && <Callout tone="red" icon={CircleAlert} title="It bounced">{delivery?.error ? `${delivery.error}. ` : ""}The address didn&apos;t take it. {reopened.length
      ? <>{draft.purpose === "reply" ? "The other reply" : reopened.length === 1 ? `The ${CHANNEL_LABEL[reopened[0]!.channel] ?? "other"} version` : "The other versions"} {reopened.length === 1 ? "is" : "are"} open again: send that instead, or check the email address on the lead.{reopened.length === 1 && <WorkspaceLink href={`/sales/live/review?draft=${encodeURIComponent(reopened[0]!.id)}`} className="mt-2 flex min-h-8 w-fit items-center gap-1.5 font-semibold underline underline-offset-2">Open the {draft.purpose === "reply" ? "other reply" : `${CHANNEL_LABEL[reopened[0]!.channel] ?? "other"} version`}<ArrowUpRight size={13} aria-hidden="true" /></WorkspaceLink>}</>
      : "Check the email address on the lead, or reach them another way."}</Callout>}
    {draft.status === "vetoed" && <Callout tone="red" icon={X} title="Vetoed">{draft.veto ? `${personName(draft.veto.by)}: ${draft.veto.reason}` : "A person vetoed this draft."}</Callout>}
    {draft.status === "discarded" && <Callout tone="neutral" icon={Trash} title={closedLabel(draft) || "Discarded"}>{draft.discardedReason ? `${draft.discardedReason}${draft.sentVersion ? ` on ${stamp(draft.sentVersion.at)}` : ""}. ` : ""}{draft.closedReason === "other_reply_sent" ? "Only one answer to a message goes out, so this one closed." : draft.closedReason ? "Only one version of a message goes out, so this one closed with it." : `${draft.discardedBy ? `${personName(draft.discardedBy)} discarded it` : "It was discarded"}${draft.discardedAt ? ` on ${stamp(draft.discardedAt)}` : ""}. It is out of the queue.`}</Callout>}

    {open && !editing && <div className="space-y-3">
      {doNotContact && <Callout tone="red" icon={UserX} title="On the do-not-contact list">{lead.companyName} asked not to be contacted, or matched the list. Nothing can be sent or opened for them, on any channel. Discard this draft.</Callout>}
      {whatsappLocked && !doNotContact && <Callout tone="amber" icon={Whatsapp} title="WhatsApp stays locked until they opt in">{lead.companyName} has not said yes to WhatsApp, so this cannot be sent or opened. They opt in when they message us, or say yes on a call or by email, and a person records it on the lead. Until then, start with a call, or an email that ends &ldquo;Prefer WhatsApp?&rdquo;.{editor && <WorkspaceLink href={`/sales/live/calls?call=${encodeURIComponent(lead.id)}`} className="mt-2 inline-flex min-h-8 items-center gap-1.5 font-semibold underline underline-offset-2"><Phone size={14} />Call instead</WorkspaceLink>}</Callout>}
      {answered && <Callout tone="blue" icon={CircleCheck} title="Their message was already answered">{answered.by ? (answered.by === session?.user.id ? "You" : personName(answered.by)) : "Someone"} replied by {CHANNEL_LABEL[answered.channel]?.toLowerCase() ?? answered.channel} on {stamp(answered.at)}. This reply isn&apos;t needed{mayDiscard ? ": discard it under More" : ""}.</Callout>}
      {isCallOpener && !doNotContact && <Callout tone="blue" icon={Phone} title="This is a script for a call, not a message">Claude shows it in call mode while you speak to them. There is nothing to send.</Callout>}
      {inFlight && <Callout tone="blue" icon={Clock3} title="Being sent right now">{sentThroughLabel ? `Through ${sentThroughLabel}. ` : ""}Refresh in a moment to see whether it went out.</Callout>}
      {uncertain && <Callout tone="amber" icon={CircleAlert} title="We couldn't confirm it went out">{delivery?.error ? `${delivery.error}. ` : ""}Check {isEmail ? "your Sent folder" : draft.channel === "whatsapp" ? "the venture's WhatsApp" : "the venture's Instagram"}{draft.sentAccountId && sentThroughLabel ? ` (${sentThroughLabel})` : ""}, then say what happened. It can&apos;t be sent again until you do.{editor && <span className="mt-2 block"><DeliveryReconcile draftId={draft.id} onDone={reconciled} /></span>}</Callout>}
      {plan.kind !== "through" && draft.status === "ready" && delivery?.state === "failed" && <Callout tone="red" icon={CircleAlert} title="The last try didn't send">{delivery.error ? `${delivery.error}. ` : ""}Nothing went out. Send it again, or send it yourself and mark it sent.</Callout>}
      {instagramClosed && editor && plan.kind === "hand" && <Callout tone="blue" icon={Instagram} title="Send this one from the Instagram app">Instagram only lets the app answer someone within 24 hours of their last message, and {lead.companyName} hasn&apos;t written in that time. Copy it, send it from the venture&apos;s Instagram, then mark it sent.</Callout>}
    </div>}

    {writer && open && !editing && main && <section aria-label="Send" className={inline ? "space-y-1.5" : "sticky bottom-0 z-[5] -mx-4 space-y-1.5 border-t border-neutral-100 bg-white px-4 pb-3 pt-3 sm:-mx-5 sm:px-5"}>
      {stale && <p role="alert" className="vso-fade-enter flex items-start gap-2 rounded-xl bg-warning-surface py-1.5 pl-3 pr-1 text-xs font-semibold leading-5 text-warning-text"><CircleAlert size={14} aria-hidden="true" className="mt-[3px] shrink-0" /><span className="min-w-0 flex-1 py-0.5">{CHANGED_SINCE}</span><button type="button" onClick={() => setStale(false)} aria-label="Dismiss" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors duration-150 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={14} aria-hidden="true" /></button></p>}
      {main}
      {(recorded || note) && <p id={noteId} className={clsx("text-xs leading-5", heldBy && sendable ? "font-semibold text-warning-text" : "text-neutral-500")}>{note ?? recorded}</p>}
    </section>}
    {writer && open && !editing && confirm && <div ref={confirmBox} className="scroll-mt-4" onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); closeConfirm(); } }}>
      {confirm === "sent" && <div role="alertdialog" aria-labelledby={questionId} className="vso-fade-enter rounded-2xl border border-primary-200 bg-primary-50 p-4">
        <p id={questionId} className="text-sm font-bold text-primary-900">Did you send it?</p>
        <p className="mt-1 text-xs leading-5 text-primary-800">Saying yes records that it went from your own {OWN_APP[draft.channel] ?? "account"}: {lead.companyName} moves to Contacted and the follow-up clock starts. Nothing is sent from here.{draft.channel === "linkedin" ? " It counts toward today's LinkedIn limit." : ""}</p>
        <SentFromPicker accounts={handAccounts} value={sentFromId} onChange={setSentFrom} />
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" data-autofocus onClick={markSent} disabled={busy === "sent"} className={clsx(primaryClass, "max-sm:flex-1")}><ActionLabel busy={busy === "sent"} busyText="Saving…" idle={<><Check size={16} aria-hidden="true" />Yes, mark it sent</>} /></button><button type="button" onClick={closeConfirm} className={clsx(secondaryClass, "max-sm:flex-1")}>Not yet</button></div>
      </div>}
      {confirm === "veto" && <form aria-label="Veto this draft" onSubmit={(event) => { event.preventDefault(); veto(); }} className="vso-fade-enter rounded-2xl border border-danger-surface bg-danger-surface p-4">
        <Field label="Why veto it?"><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={2} data-autofocus placeholder="For example: wrong person to write to, or the claim is not true." className={clsx(inputClass, "py-3")} /></Field>
        <div className="mt-3 flex flex-wrap gap-2"><button type="submit" disabled={busy === "veto"} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50 max-sm:flex-1"><ActionLabel busy={busy === "veto"} busyText="Vetoing…" idle="Veto this draft" /></button><button type="button" onClick={closeConfirm} className={clsx(secondaryClass, "max-sm:flex-1")}>Cancel</button></div>
      </form>}
      {confirm === "discard" && <div role="alertdialog" aria-label="Confirm discard" className="vso-fade-enter rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
        <p className="text-sm font-bold text-neutral-900">Discard this draft?</p>
        <p className="mt-1 text-xs leading-5 text-neutral-500">It is removed from the queue. Claude can write a new one.</p>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" data-autofocus onClick={discard} disabled={busy === "discard"} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50 max-sm:flex-1"><ActionLabel busy={busy === "discard"} busyText="Discarding…" idle="Discard" /></button><button type="button" onClick={closeConfirm} className={clsx(secondaryClass, "max-sm:flex-1")}>Keep it</button></div>
      </div>}
    </div>}
    {!writer && open && <p className="flex items-center gap-2 text-xs text-neutral-500"><Info size={14} />You can read drafts. The lead&apos;s owner or a venture head edits and sends them.</p>}

    {!inline && <WhyThisLead draft={draft} />}
  </div>;
}

/** Claude's review as one line on top of the draft, with its notes a tap away (open by default when it asks for changes). */
function ReviewStrip({ draft, approval }: { draft: ReviewDraft; approval: Approval }) {
  const { session, personName } = useSalesShell();
  const review = draft.review;
  const changes = draft.status === "needs_changes" || review?.result === "fail";
  const [expanded, setExpanded] = useState(changes);
  const notesId = useId();
  // A reply a person wrote themselves: no Claude review, approved by them, ready at once.
  if (!review && draft.status === "ready" && isOwnReply(draft) && draft.personApproval) {
    const by = draft.personApproval.by === session?.user.id ? "you" : personName(draft.personApproval.by);
    return <div className="flex min-h-11 items-center gap-2.5 rounded-2xl bg-success-surface px-3 py-1.5">
      <CircleCheck size={16} aria-hidden="true" className="shrink-0 text-success-text" />
      <p className="min-w-0 flex-1 text-[13px] font-bold leading-5 text-success-text">Written and approved by {by}<span className="font-medium opacity-90"><span className="max-sm:hidden"> · </span><span className="max-sm:block max-sm:text-xs">no review needed</span></span></p>
    </div>;
  }
  // A review kept on a draft that went back to review (it was edited since) is about the old text: it waits for a new one.
  const outdated = Boolean(review) && (draft.status === "in_review" || draft.status === "draft");
  if (!review || outdated) {
    const submitted = draft.status === "in_review";
    return <div className="space-y-2.5 rounded-2xl bg-neutral-50 p-3">
      <div className="flex items-start gap-2.5 px-0.5"><Clock3 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-neutral-400" /><p className="min-w-0 text-[13px] font-bold text-neutral-800">{submitted ? "Waiting for Claude's review" : "Not submitted for review yet"}<span className="block text-xs font-medium leading-5 text-neutral-500">{outdated ? "It was edited after its last review, so " : ""}{submitted ? `${outdated ? "a" : "A"} different chat from the one that wrote it checks it against the message rules.` : outdated ? "save it to send it for review again." : "Edit it and save to send it for review."}</span></p></div>
      {submitted && <AskClaude prompt="review drafts" note="in a new chat" />}
    </div>;
  }
  const pass = review.result === "pass" && !changes;
  const noteCount = review.issues.length + (review.notes ? 1 : 0);
  const detail = pass
    ? [review.issues.length ? `${review.issues.length} ${review.issues.length === 1 ? "note" : "notes"}` : "no issues", approval.needed ? "a person approves it next" : draft.personApproval ? `approved by ${personName(draft.personApproval.by)}` : ""].filter(Boolean).join(" · ")
    : review.issues.length ? `${review.issues.length} ${review.issues.length === 1 ? "point" : "points"} to fix` : "";
  const StripIcon = pass ? CircleCheck : CircleAlert;
  return <div className={clsx("rounded-2xl", pass ? "bg-success-surface" : "bg-warning-surface")}>
    <div className="flex min-h-11 items-center gap-2.5 py-1 pl-3 pr-1">
      <StripIcon size={16} aria-hidden="true" className={clsx("shrink-0", pass ? "text-success-text" : "text-warning-text")} />
      <p className={clsx("min-w-0 flex-1 text-[13px] font-bold leading-5", pass ? "text-success-text" : "text-warning-text")}>{pass ? "Passed Claude's review" : "Needs changes"}{detail && <span className="font-medium opacity-90"><span className="max-sm:hidden"> · </span><span className="max-sm:block max-sm:text-xs">{detail}</span></span>}</p>
      <button type="button" aria-expanded={expanded} aria-controls={notesId} onClick={() => setExpanded(!expanded)} className={clsx("inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", pass ? "text-success-text" : "text-warning-text")}>
        {expanded ? "Hide notes" : noteCount ? "Read notes" : "Details"}<ChevronDown size={14} aria-hidden="true" className={clsx("transition-transform duration-150", expanded && "rotate-180")} />
      </button>
    </div>
    {expanded && <div id={notesId} className="vso-fade-enter space-y-2 px-3 pb-3 pt-0.5 text-xs leading-5">
      {review.issues.length > 0 && <ul className="space-y-1.5">{review.issues.map((issue, index) => <li key={`${index}-${issue}`} className="flex items-start gap-2 text-neutral-700"><CircleAlert size={13} className="mt-1 shrink-0 text-warning-text" aria-hidden="true" /><span className="[overflow-wrap:anywhere]">{issue}</span></li>)}</ul>}
      {review.notes && <p className="text-neutral-700 [overflow-wrap:anywhere]">{review.notes}</p>}
      {pass && noteCount === 0 && <p className="text-neutral-600">No issues found against the message rules.</p>}
      <p className="text-[11px] leading-4 text-neutral-500">{review.via === "claude" ? `Claude, for ${personName(review.by)}` : personName(review.by)} · {stamp(review.at)}{draft.authorSessionId && review.sessionId ? ` · written in session ${shortSession(draft.authorSessionId)}, reviewed in session ${shortSession(review.sessionId)}` : ""}</p>
    </div>}
    {!pass && draft.status === "needs_changes" && <div className="px-2 pb-2"><AskClaude prompt="fix the drafts that need changes" className="!border-warning-text/30 !bg-transparent" /></div>}
  </div>;
}

/** What Claude saw on the lead and why it fits, under the message (it was a side column before). */
function WhyThisLead({ draft }: { draft: ReviewDraft }) {
  const lead = draft.lead;
  const signal = lead.observedSignal;
  const summary = lead.verdict?.summary;
  return <section aria-label="Why this lead" className="space-y-2 border-t border-neutral-100 pt-4">
    <span className={kickerClass}>Why this lead</span>
    <div className="flex flex-wrap items-center gap-1.5 sm:hidden"><StageChip stage={lead.stage} /><VerdictChip verdict={lead.verdict} /></div>
    {signal && <p className="border-l-2 border-primary-300 pl-2.5 text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">&ldquo;{signal}&rdquo;</p>}
    {summary && <p className="text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">{summary}</p>}
    {!signal && !summary && <p className="text-xs text-neutral-400">Claude hasn&apos;t written down what it saw yet.</p>}
    {lead.whatsappOptIn && <p className="flex items-center gap-1.5 text-xs font-semibold text-success-text"><Whatsapp size={13} aria-hidden="true" />WhatsApp OK: {OPT_IN_LABEL[lead.whatsappOptIn.how]?.toLowerCase() ?? "they opted in"}, {stamp(lead.whatsappOptIn.at)}</p>}
  </section>;
}

function DraftMessage({ draft }: { draft: ReviewDraft }) {
  const words = wordCount(draft.body);
  const text = <p className="whitespace-pre-wrap text-sm leading-7 text-neutral-800 [overflow-wrap:anywhere]">{draft.body}</p>;
  const chars = draft.body.length;
  const longNote = draft.channel === "linkedin" && chars > LINKEDIN_NOTE_LIMIT;
  const foot = <div><p className="text-[11px] font-medium text-neutral-400">{words} words{draft.channel === "linkedin" || draft.channel === "whatsapp" ? ` · ${chars} characters` : ""} · {CHANNEL_LABEL[draft.channel]} · {PURPOSE_LABEL[draft.purpose]}</p>{longNote && <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-warning-text"><CircleAlert size={13} aria-hidden="true" className="shrink-0" />Over {LINKEDIN_NOTE_LIMIT} characters: too long for a connection note. Fine as a message once you are connected.</p>}</div>;
  if (draft.channel === "whatsapp") return <div className="space-y-2 rounded-2xl bg-neutral-50 p-3 sm:p-4"><div className="ml-auto w-fit max-w-[92%] rounded-2xl rounded-br-md border border-primary-200 bg-primary-100 px-4 py-3 sm:max-w-[85%]">{text}</div><div className="text-right">{foot}</div></div>;
  if (draft.channel === "call_opener") return <div className="space-y-2 rounded-2xl border border-primary-200 bg-primary-50 p-4"><span className="flex items-center gap-2 text-xs font-bold text-primary-800"><Sparkles size={14} />Say this on the call</span>{text}{foot}</div>;
  return <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
    {draft.channel === "email" && <div className="border-b border-neutral-100 px-4 py-3"><span className={kickerClass}>Subject</span><p className="mt-0.5 text-sm font-bold text-neutral-900 [overflow-wrap:anywhere]">{draft.subject || "(no subject)"}</p></div>}
    <div className="px-4 py-4">{text}</div>
    <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-2">{foot}</div>
  </div>;
}

function Callout({ tone, icon: CalloutIcon, title, children }: { tone: "amber" | "blue" | "green" | "red" | "neutral"; icon: Icon; title: string; children: React.ReactNode }) {
  const tones = { amber: "bg-warning-surface text-warning-text", blue: "bg-primary-50 text-primary-800", green: "bg-success-surface text-success-text", red: "bg-danger-surface text-danger-text", neutral: "bg-neutral-50 text-neutral-600" };
  return <div role="note" className={clsx("flex items-start gap-3 rounded-2xl p-3.5", tones[tone])}><CalloutIcon size={17} className="mt-0.5 shrink-0" aria-hidden="true" /><div className="min-w-0 text-xs leading-5"><p className="text-[13px] font-bold">{title}</p><div className="mt-0.5 opacity-90">{children}</div></div></div>;
}
