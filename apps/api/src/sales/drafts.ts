// Draft state machine: draft -> in_review -> ready | needs_changes; edits return to in_review; sent, vetoed and discarded end it.
// Written by Claude or a person, reviewed in a separate pass, sent by a person (docs/sales-dealflow.md sections 1 and 5). One exception: a
// reply a person writes in the app is ready at once, approved by them (`isOwnReply`), and their edits keep it ready.
import { OPEN_DRAFT_STATUSES, PRE_CONTACT_STAGES } from "@venture-studio/contracts";
import type { AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import type { Via } from "./access.js";
import type { SalesSettings } from "./settings.js";

/** Messages (not calls, meetings or notes): one sent to the lead, or any word from them, means the conversation has started. */
export const MESSAGE_KINDS = ["email", "whatsapp", "linkedin", "instagram"] as const;

/** An outbound message whose email bounced: it never reached the lead. */
const bounced = (activity: { message?: unknown }) => (activity.message as { delivery?: { state?: unknown } } | undefined)?.delivery?.state === "bounced";

/**
 * Whether a lead's first message can still be written in another version (its WhatsApp version next to the waiting email): the lead is before
 * first contact, or at replied only because a person logged a call where it said yes to WhatsApp; no message reached it and nothing came
 * from it (a lead that wrote to us gets a reply, not a first message). A message that bounced never reached it: a lead whose every message
 * bounced (it moved to contacted when the first one went) still has its first message due. Claude's tools and the "WhatsApp versions to
 * write" lists share it.
 */
export function firstMessageStillDue(stage: unknown, activities: { kind?: unknown; direction?: unknown; message?: unknown }[]): boolean {
  if (activities.some((activity) => activity.direction === "in")) return false;
  const sent = activities.filter((activity) => activity.direction === "out" && (MESSAGE_KINDS as readonly unknown[]).includes(activity.kind));
  if (sent.some((activity) => !bounced(activity))) return false;
  if ((PRE_CONTACT_STAGES as readonly unknown[]).includes(stage) || stage === "replied") return true;
  return stage === "contacted" && sent.length > 0;
}

/** A draft that can still change (OPEN_DRAFT_STATUSES: not sent, vetoed or discarded). */
export const isOpenDraft = (draft: Record<string, unknown>) => (OPEN_DRAFT_STATUSES as readonly unknown[]).includes(draft.status);

/** A draft's channel and purpose in the plain words the API and Claude's tools use in their messages. */
export const CHANNEL_WORDS: Readonly<Record<string, string>> = { email: "email", whatsapp: "WhatsApp", linkedin: "LinkedIn", instagram: "Instagram", call_opener: "call opener" };
export const PURPOSE_WORDS: Readonly<Record<string, string>> = { first_touch: "first message", follow_up: "follow-up", reply: "reply", proposal: "proposal", other: "message" };
/** "an email", "a WhatsApp", "a call opener". */
export const channelWithArticle = (channel: unknown) => { const word = CHANNEL_WORDS[String(channel)] ?? String(channel); return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`; };

/**
 * A person's decision against a lead's WhatsApp first message: they vetoed its WhatsApp version, or discarded it themselves (`discardedBy`).
 * A version a rule closed (`closedReason`: another version went out) or discarded (do not contact, the lead closed: no `discardedBy`) is no
 * decision. A decided lead gets no WhatsApp version suggested, and Claude writes none (a person still can, in the app). `decidedWhatsapp` is
 * the same rule as a filter on `sales_drafts`.
 */
export const isWhatsappDecided = (draft: Record<string, unknown>) =>
  draft.purpose === "first_touch" && draft.channel === "whatsapp" && (draft.status === "vetoed" || (draft.status === "discarded" && typeof draft.discardedBy === "string" && draft.discardedBy.length > 0 && !draft.closedReason));
export const decidedWhatsapp = { purpose: "first_touch", channel: "whatsapp", $or: [{ status: "vetoed" }, { status: "discarded", discardedBy: { $type: "string", $ne: "" }, closedReason: null }] } as const;

/**
 * A reply a person wrote in the app themselves: ready without Claude's review, approved by that person (`personApproval.own`). A person's
 * edit keeps it ready (the editor approves it); Claude's edit sends it to review like any draft.
 */
export const isOwnReply = (draft: AppDocument) => draft.purpose === "reply" && draft.authorVia === "app" && draft.personApproval?.own === true;
/** Inbound activities a person's own reply can answer: a message the lead sent, or their call (a meeting or a note is not one). */
export const OWN_REPLY_KINDS = ["email", "whatsapp", "instagram", "linkedin", "call"] as const;
/**
 * Whether a new draft is a person's own reply: written in the app (not through Claude), submitted, not sent to Claude's check on purpose,
 * and answering a message from them (`answersInbound`: its `inReplyTo` is an inbound message or call on the lead that still waits in the
 * Inbox, or the lead's latest one). A "reply" with nothing to answer is really a first message or a follow-up, and goes through review like one.
 */
export const startsAsOwnReply = (input: { purpose: string; submit: boolean; checkByClaude?: boolean | undefined }, via: Via, answersInbound: boolean) => via === "app" && input.purpose === "reply" && input.submit && input.checkByClaude !== true && answersInbound;

/**
 * A ready draft waits for a person's approval before it can be sent: the first batch of a play that no person has read yet
 * (venture setting "claude_review_enough"), or every message ("person_approves_every_message"; call openers are scripts, not messages).
 * In the every-message mode any approval (the lead's owner's too) lets it go; a play's first batch needs a head's or admin's approval
 * (`personApproval.byHead`; approvals stored before that flag existed were a head's). A person's own reply (`personApproval.own`) is
 * approved by its author in either mode: the first batch is for reading Claude's messages, and there is none in it.
 */
export function needsPersonApproval(draft: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode">): boolean {
  if (draft.status !== "ready") return false;
  if (settings?.approvalMode === "person_approves_every_message") return draft.channel !== "call_opener" && !draft.personApproval;
  const headApproved = Boolean(draft.personApproval) && (draft.personApproval.byHead !== false || isOwnReply(draft));
  return !headApproved && Boolean(draft.playId) && Boolean(play) && play!.firstBatchReviewed !== true;
}

/** Why a draft waits for a person (the payload's `needsPersonApproval` and `approvalReason`): "every_message" or "first_batch", or nothing. */
export function approvalNeed(draft: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode">): { needsPersonApproval: boolean; approvalReason: "first_batch" | "every_message" | null } {
  if (!needsPersonApproval(draft, play, settings)) return { needsPersonApproval: false, approvalReason: null };
  return { needsPersonApproval: true, approvalReason: settings?.approvalMode === "person_approves_every_message" ? "every_message" : "first_batch" };
}

// ---- The version the person read (`expectedUpdatedAt` on a send) ----------------------------------------------------------------------

export const DRAFT_CHANGED_MESSAGE = "This draft changed since you opened it: read it again before sending";
/** 409 DRAFT_CHANGED: the draft was edited, reviewed or approved after the person opened it. */
export const draftChanged = () => new AppError(409, "DRAFT_CHANGED", DRAFT_CHANGED_MESSAGE);
/** The claim filter for `expectedUpdatedAt`: a send claims the draft only while it is still the version the person read (nothing when not given). */
export const expectedVersion = (expected: string | undefined): { updatedAt?: Date } => (expected ? { updatedAt: new Date(expected) } : {});
/** Whether the stored draft is no longer the version the person read (false when they didn't say which one). */
export function changedSince(draft: AppDocument, expected: string | undefined): boolean {
  if (!expected) return false;
  const stored = draft.updatedAt instanceof Date ? draft.updatedAt.getTime() : Date.parse(String(draft.updatedAt));
  return stored !== new Date(expected).getTime();
}

/** The channel a draft is sent on, as the venture's allowed-channels setting names it (a call opener is a call). */
export const channelOf = (draft: Record<string, any>): string => (draft.channel === "call_opener" ? "call" : String(draft.channel));

/** Why a draft cannot be marked sent right now, or undefined when it can. */
export function sendBlocker(draft: AppDocument, lead: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode" | "allowedChannels">): string | undefined {
  if (draft.status === "sent") return "This draft was already marked sent";
  if (draft.status !== "ready") return "Only a ready draft (one that passed review, or a person's own reply) can be marked sent";
  if (draft.channel === "call_opener") return "A call opener is a script for call mode: it cannot be marked sent";
  if (lead.doNotContact) return "This lead is on the do-not-contact list";
  if (draft.channel === "whatsapp" && !lead.whatsappOptIn) return "No WhatsApp message goes out before the lead opts in (they message first, or say yes on a call or by email)";
  if (settings && !settings.allowedChannels.includes(channelOf(draft) as never)) return `This venture does not use ${channelOf(draft)} for outreach (see its sales settings)`;
  if (needsPersonApproval(draft, play, settings)) return settings?.approvalMode === "person_approves_every_message" ? "This venture needs a person's approval for every message before it is sent" : "The first batch of a play needs a person's approval before it is sent";
  return undefined;
}

/** What the Overview's "ready to send" list shows: ready, approved where needed, and sendable to this lead. */
export const canSendNow = (draft: AppDocument, lead: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode" | "allowedChannels">) => sendBlocker(draft, lead, play, settings) === undefined;

/** The status after a review: pass -> ready, fail -> needs_changes. Throws when the draft is not waiting for review or the review comes from the writing session. */
export function reviewOutcome(draft: AppDocument, input: { result: "pass" | "fail"; sessionId?: string | undefined }, via: Via): "ready" | "needs_changes" {
  if (draft.status !== "in_review") throw new AppError(409, "CONFLICT", draft.status === "ready" || draft.status === "needs_changes" ? "This draft was already reviewed; edit it to send it back to review" : "Only a draft waiting for review can be reviewed");
  // Claude never approves its own work: its review of a Claude draft must come from another session than the one that wrote it.
  if (draft.authorVia === "claude" && via === "claude" && (!input.sessionId || input.sessionId === draft.authorSessionId)) {
    throw new AppError(409, "CONFLICT", "A Claude review of a Claude draft must come from a different session than the one that wrote it (send this session's sessionId)");
  }
  return input.result === "pass" ? "ready" : "needs_changes";
}
