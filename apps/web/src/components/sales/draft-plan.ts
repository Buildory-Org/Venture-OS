import { OPEN_DRAFT_STATUSES, VERSIONED_DRAFT_PURPOSES, type ChannelAccount, type ContactRoute, type Draft } from "@venture-studio/contracts";
import { accountLine, emailSettingsOf } from "./channel-model";
import { CHANNEL_LABEL, instagramHref, linkedinHref, mailtoHref, PURPOSE_LABEL, routeOf, waDigits, waHref } from "./draft-shared";
import type { Tone } from "./sales-ui";

// What a person does next with one draft, worked out the same way in Review and in the lead drawer (docs/sales-channels.md sections 2, 3,
// 4, 7): send it through a connected account, send it by hand and say so, approve it, fix it, or wait. The API enforces every rule; this
// only decides what to show.

/** A draft that can still change (the API's OPEN_DRAFT_STATUSES: not sent, vetoed or discarded). */
export const isOpenDraft = (draft: Pick<Draft, "status">) => (OPEN_DRAFT_STATUSES as readonly Draft["status"][]).includes(draft.status);
/** A first message or a follow-up: written for several channels, only one version goes out and sending it closes the others (the API does). */
export const isVersioned = (purpose: string) => (VERSIONED_DRAFT_PURPOSES as readonly string[]).includes(purpose);
/**
 * A reply a person wrote and approved themselves, with no Claude review (`personApproval.own`): ready at once, and a person's edit keeps
 * it ready (the API decides; docs/sales-dealflow.md section 5, "A person's own reply").
 */
export const isOwnReply = (draft: Pick<Draft, "purpose" | "authorVia" | "personApproval">) => draft.purpose === "reply" && draft.authorVia === "app" && draft.personApproval?.own === true;

type PlanLead = { contactRoutes: ContactRoute[]; whatsappOptIn?: unknown; doNotContact?: boolean };
type PlanDraft = Pick<Draft, "status" | "channel" | "subject" | "body" | "delivery">;
export type HandApp = "mail" | "whatsapp" | "linkedin" | "instagram";

export type SendPlan =
  | { kind: "closed" }
  /** A send through an account is in flight, or waits for a person to say whether it went out. */
  | { kind: "held" }
  | { kind: "do_not_contact" }
  | { kind: "waiting_review"; submitted: boolean }
  | { kind: "needs_changes" }
  | { kind: "approve" }
  | { kind: "call_script" }
  | { kind: "whatsapp_locked" }
  /** Send through one of the person's (email) or the venture's (WhatsApp, Instagram) connected accounts. */
  | { kind: "through"; accounts: ChannelAccount[] }
  /** Send from their own mail app, phone, LinkedIn or Instagram, then say so. `href` is empty when only copying works. */
  | { kind: "hand"; app: HandApp; href: string; copyFirst: boolean }
  | { kind: "no_route"; app: HandApp; unusable: boolean };

const APP_OF: Record<string, HandApp> = { email: "mail", whatsapp: "whatsapp", linkedin: "linkedin", instagram: "instagram" };

/**
 * The next step for a draft. `sendAccounts`: the accounts this person can send it through (`usableAccounts`); `instagramClosed`: the lead
 * hasn't written on Instagram in the last 24 hours, so the app can't answer them there.
 */
export function sendPlanOf({ draft, lead, approvalNeeded, sendAccounts, instagramClosed = false }: { draft: PlanDraft; lead: PlanLead; approvalNeeded: boolean; sendAccounts: ChannelAccount[]; instagramClosed?: boolean }): SendPlan {
  if (!isOpenDraft(draft)) return { kind: "closed" };
  if (draft.status === "ready" && (draft.delivery?.state === "uncertain" || draft.delivery?.state === "sending")) return { kind: "held" };
  if (lead.doNotContact) return { kind: "do_not_contact" };
  if (draft.status === "draft" || draft.status === "in_review") return { kind: "waiting_review", submitted: draft.status === "in_review" };
  if (draft.status === "needs_changes") return { kind: "needs_changes" };
  if (approvalNeeded) return { kind: "approve" };
  if (draft.channel === "call_opener") return { kind: "call_script" };
  if (draft.channel === "whatsapp" && !lead.whatsappOptIn) return { kind: "whatsapp_locked" };
  const throughChannel = draft.channel === "email" || draft.channel === "whatsapp" || (draft.channel === "instagram" && !instagramClosed);
  if (throughChannel && sendAccounts.length > 0) return { kind: "through", accounts: sendAccounts };
  const app = APP_OF[draft.channel] ?? "mail";
  if (app === "mail") {
    const route = routeOf(lead.contactRoutes, "email");
    const href = route ? mailtoHref(route.value, draft.subject ?? "", draft.body) : "";
    return href ? { kind: "hand", app, href, copyFirst: true } : { kind: "no_route", app, unusable: Boolean(route) };
  }
  if (app === "whatsapp") {
    const route = routeOf(lead.contactRoutes, "whatsapp", "phone");
    const digits = route ? waDigits(route.value) : "";
    return digits ? { kind: "hand", app, href: waHref(digits, draft.body), copyFirst: false } : { kind: "no_route", app, unusable: Boolean(route) };
  }
  const route = routeOf(lead.contactRoutes, app);
  const href = route ? (app === "linkedin" ? linkedinHref(route.value) : instagramHref(route.value)) : "";
  return { kind: "hand", app, href, copyFirst: true };
}

const VENTURE_ACCOUNT: Record<string, string> = { whatsapp: "the venture's WhatsApp", instagram: "the venture's Instagram" };
/** "Send from admin@buildory.dev", "Send from the venture's WhatsApp". */
export const sendFromLabel = (channel: string, account: ChannelAccount | undefined) => `Send from ${channel === "email" ? (account ? accountLine(account) : "your mailbox") : VENTURE_ACCOUNT[channel] ?? "the connected account"}`;

const HAND_LABEL: Record<HandApp, { link: string; copy: string }> = {
  mail: { link: "Copy and open mail app", copy: "Copy text" },
  whatsapp: { link: "Open WhatsApp", copy: "Copy text" },
  linkedin: { link: "Copy and open LinkedIn", copy: "Copy text" },
  instagram: { link: "Copy and open Instagram", copy: "Copy text" },
};
const NO_ROUTE: Record<HandApp, string> = { mail: "No email on file", whatsapp: "No WhatsApp number on file", linkedin: "No LinkedIn profile on file", instagram: "No Instagram on file" };
export const handLabel = (plan: Extract<SendPlan, { kind: "hand" }>) => plan.href ? HAND_LABEL[plan.app].link : HAND_LABEL[plan.app].copy;
export const noRouteLabel = (plan: Extract<SendPlan, { kind: "no_route" }>) => plan.unusable ? (plan.app === "mail" ? "Email address is not usable" : "Number is not usable") : NO_ROUTE[plan.app];

/** The next step in a few words, for a link into Review (the lead drawer's draft list). */
export function nextStepLabel(plan: SendPlan, channel: string): string {
  switch (plan.kind) {
    case "through": return sendFromLabel(channel, plan.accounts[0]);
    case "hand": return handLabel(plan);
    case "no_route": return noRouteLabel(plan);
    case "approve": return "Approve it first";
    case "needs_changes": return "Fix it";
    case "waiting_review": return plan.submitted ? "Waiting for Claude's review" : "Not submitted yet";
    case "call_script": return "Use it on a call";
    case "whatsapp_locked": return "Locked until they opt in";
    case "do_not_contact": return "Do not contact";
    case "held": return "Say whether it went out";
    default: return "Open";
  }
}

const HAND_RECORDED = "Recorded when you mark it sent. Replies on your phone or mail app: log them with They replied on the lead.";
/** One plain line under the main button: how the message goes out, how it is recorded and where the answer arrives. */
export function recordedLine(plan: SendPlan, account?: ChannelAccount): string {
  if (plan.kind === "through") {
    const email = account ? emailSettingsOf(account) : null;
    if (account?.kind === "whatsapp") return "Sent and received through the venture's WhatsApp; replies arrive in Sales > Inbox automatically.";
    if (account?.kind === "instagram") return "Sent and received through the venture's Instagram; replies arrive in Sales > Inbox automatically.";
    const sent = email?.saveToSent === false ? "Goes from your mailbox" : "Goes from your mailbox, saved in your Sent folder";
    return email?.syncInbox === false ? `${sent}. Replies: log them with They replied on the lead (this mailbox doesn't read its inbox).` : `${sent}; replies arrive in Sales > Inbox.`;
  }
  if (plan.kind === "hand" && plan.app === "whatsapp") return "Sent from your own WhatsApp, recorded only when you confirm it went. Log their reply with They replied on the lead.";
  if (plan.kind === "hand" || plan.kind === "no_route") return HAND_RECORDED;
  return "";
}

// ---- Answering a reply from the Inbox --------------------------------------------------------------------------------------------

export type ReplyChannel = "email" | "whatsapp" | "linkedin" | "instagram";
export type ReplyOption = { channel: ReplyChannel; ok: boolean; why: string };
const DEFAULT_CHANNELS = ["call", "email", "whatsapp", "linkedin"];

/**
 * The channels a person can answer a lead on, as the API will take them (docs/sales-channels.md sections 2 and 4): email with an email
 * address on file; WhatsApp once they opted in and with a number, and, when the venture's number is connected, only inside the 24 hours
 * after their last WhatsApp (outside it the number sends approved templates only, which a written reply is not); LinkedIn with a profile or
 * a conversation there; Instagram where there is a conversation or a handle. Channels the venture doesn't use are left out, unless they
 * wrote on one (then it shows, explained). `whatsappWindow` is "unknown" while their messages load: not held against them.
 */
export function replyOptions({ lead, allowedChannels, wroteOn, whatsappConnected, whatsappWindow, instagramReachable }: {
  lead: PlanLead; allowedChannels: readonly string[] | undefined; wroteOn: string; whatsappConnected: boolean; whatsappWindow: "open" | "closed" | "unknown"; instagramReachable: boolean;
}): ReplyOption[] {
  const allowed = allowedChannels ?? DEFAULT_CHANNELS;
  const option = (channel: ReplyChannel, why: string): ReplyOption => ({ channel, ok: !why, why });
  const notUsed = "this venture doesn't use it";
  const options: ReplyOption[] = [];
  const offer = (channel: ReplyChannel) => allowed.includes(channel) || wroteOn === channel;
  if (offer("email")) options.push(option("email", !allowed.includes("email") ? notUsed : routeOf(lead.contactRoutes, "email") ? "" : "no email address on file"));
  if (offer("whatsapp")) {
    const number = routeOf(lead.contactRoutes, "whatsapp", "phone");
    options.push(option("whatsapp", !allowed.includes("whatsapp") ? notUsed : !lead.whatsappOptIn ? "they haven't said yes to WhatsApp yet"
      : !number && !(whatsappConnected && wroteOn === "whatsapp") ? "no WhatsApp number on file"
        : whatsappConnected && whatsappWindow === "closed" ? "their last WhatsApp is over 24 hours old, so the venture's number may only send an approved template" : ""));
  }
  if (offer("linkedin")) options.push(option("linkedin", !allowed.includes("linkedin") ? notUsed : routeOf(lead.contactRoutes, "linkedin") || wroteOn === "linkedin" ? "" : "no LinkedIn profile on file"));
  if (instagramReachable && offer("instagram")) options.push(option("instagram", allowed.includes("instagram") ? "" : notUsed));
  return lead.doNotContact ? options.map((item) => ({ ...item, ok: false, why: "they are on the do-not-contact list" })) : options;
}

/** Where a reply on this channel goes out from, in one line under the reply box ("Your reply goes out from admin@buildory.dev"). */
export function replyFromLine(plan: SendPlan, account?: ChannelAccount): string {
  if (plan.kind === "through") return `Your reply goes out from ${account?.kind === "email" ? accountLine(account) : VENTURE_ACCOUNT[account?.kind ?? ""] ?? "the connected account"}${account && account.kind !== "email" && accountLine(account) ? ` (${accountLine(account)})` : ""}.`;
  if (plan.kind === "hand") {
    const own: Record<HandApp, string> = { mail: "your own mail app", whatsapp: "your own WhatsApp", linkedin: "your LinkedIn", instagram: "the venture's Instagram app" };
    return `Your reply goes out from ${own[plan.app]}: you send it there, then say so here.`;
  }
  return "";
}

// ---- Versions: a lead's drafts side by side (an email and a WhatsApp version of the same first message) ----------------------------

const CHANNEL_ORDER = ["email", "whatsapp", "linkedin", "instagram", "call_opener"];
const PURPOSE_ORDER = ["first_touch", "follow_up", "reply", "proposal", "other"];
const order = (list: string[], value: string) => { const index = list.indexOf(value); return index < 0 ? list.length : index; };
/** Same purpose together (first messages first), then email, WhatsApp, LinkedIn, Instagram, call script; the oldest first. */
export function sortVersions<T extends Pick<Draft, "purpose" | "channel" | "createdAt">>(drafts: readonly T[]): T[] {
  return [...drafts].sort((a, b) => order(PURPOSE_ORDER, a.purpose) - order(PURPOSE_ORDER, b.purpose) || order(CHANNEL_ORDER, a.channel) - order(CHANNEL_ORDER, b.channel) || a.createdAt.localeCompare(b.createdAt));
}
/** How good a version is to act on, lowest first: ready, then to approve, in review, not submitted, needs changes; sent ones after. */
export function versionRank(draft: Pick<Draft, "status">, approvalNeeded: boolean): number {
  if (draft.status === "ready") return approvalNeeded ? 1 : 0;
  return ({ in_review: 2, draft: 3, needs_changes: 4, sent: 5 } as Record<string, number>)[draft.status] ?? 6;
}
/** Tab names: the channel, with the purpose when the lead's versions have more than one, and a number when two still match. */
export function versionLabels(drafts: readonly Pick<Draft, "id" | "channel" | "purpose">[]): Record<string, string> {
  const mixed = new Set(drafts.map((draft) => draft.purpose)).size > 1;
  const base = drafts.map((draft) => mixed ? `${CHANNEL_LABEL[draft.channel] ?? draft.channel} · ${PURPOSE_LABEL[draft.purpose] ?? "Message"}` : CHANNEL_LABEL[draft.channel] ?? draft.channel);
  const seen: Record<string, number> = {};
  return Object.fromEntries(drafts.map((draft, index) => {
    const name = base[index]!;
    const count = (seen[name] = (seen[name] ?? 0) + 1);
    return [draft.id, count > 1 || base.filter((item) => item === name).length > 1 ? `${name} ${count}` : name];
  }));
}
/** A lead WhatsApp could reach: they opted in, or there is a WhatsApp or phone number to ask on. */
export const reachableOnWhatsapp = (lead: PlanLead) => !lead.doNotContact && (Boolean(lead.whatsappOptIn) || Boolean(routeOf(lead.contactRoutes, "whatsapp", "phone")));

/**
 * Another open version of the same message (or another reply to the same message of theirs) whose send is held: in flight, or waiting for a
 * person to say whether it went out. While it is, this one is not sent (only one goes out).
 */
export function heldSibling<T extends Pick<Draft, "id" | "purpose" | "inReplyTo" | "status" | "delivery">>(drafts: readonly T[], draft: Pick<Draft, "id" | "purpose" | "inReplyTo">): T | undefined {
  const sibling = (other: T) => other.id !== draft.id && other.purpose === draft.purpose && (isVersioned(draft.purpose) || (draft.purpose === "reply" && Boolean(draft.inReplyTo) && other.inReplyTo === draft.inReplyTo));
  return drafts.find((other) => sibling(other) && other.status === "ready" && (other.delivery?.state === "sending" || other.delivery?.state === "uncertain"));
}
/** The line under a disabled main button while another version's send is held: "The email version's send isn't confirmed yet: settle it first." */
export const heldLine = (other: Pick<Draft, "channel" | "purpose">) => `The ${other.purpose === "reply" ? "other " : ""}${CHANNEL_LABEL[other.channel]?.toLowerCase() ?? "other"} ${other.purpose === "reply" ? "reply" : "version"}'s send isn't confirmed yet: settle it first.`;

/** Why a rule closed a draft, as a callout title or a list line: another version went out, or another reply to the same message did. */
export function closedLabel(draft: Pick<Draft, "status" | "closedReason">): string {
  if (draft.status !== "discarded" || !draft.closedReason) return "";
  return draft.closedReason === "other_reply_sent" ? "Closed: another reply went out" : "Closed: another version went out";
}

type DetailActivity = { id: string; kind: string; direction?: string | undefined; at: string; handledAt?: string | undefined; actorId?: string | undefined };
type DetailDraft = Pick<Draft, "id" | "purpose" | "inReplyTo" | "status" | "channel" | "sentAt" | "sentBy" | "updatedAt">;
const MESSAGE_KINDS = ["email", "whatsapp", "linkedin", "instagram"];
/**
 * An open reply whose message was already answered: another reply to it went out, or the message was handled and a message went to them
 * after it. Null when it still needs an answer (or the draft doesn't name the message it answers).
 */
export function answeredBy(draft: DetailDraft, detail: { activities: readonly DetailActivity[]; drafts: readonly DetailDraft[] } | null | undefined): { at: string; by?: string | undefined; channel: string } | null {
  if (!detail || draft.purpose !== "reply" || !draft.inReplyTo || !isOpenDraft(draft)) return null;
  const sent = detail.drafts.find((other) => other.id !== draft.id && other.purpose === "reply" && other.inReplyTo === draft.inReplyTo && other.status === "sent");
  if (sent) return { at: sent.sentAt ?? sent.updatedAt, by: sent.sentBy, channel: sent.channel };
  const message = detail.activities.find((activity) => activity.id === draft.inReplyTo);
  if (!message?.handledAt) return null;
  const out = detail.activities.filter((activity) => activity.direction === "out" && MESSAGE_KINDS.includes(activity.kind) && activity.at >= message.at).sort((a, b) => a.at.localeCompare(b.at))[0];
  return out ? { at: out.at, by: out.actorId, channel: out.kind } : null;
}

/** A version's state in one or two words, for its tab and its list row. */
export function versionStatus(draft: Pick<Draft, "status" | "delivery" | "closedReason">, approvalNeeded: boolean): { label: string; tone: Tone } {
  if (draft.status === "discarded" && draft.closedReason) return { label: "Closed", tone: "neutral" };
  if (draft.status === "ready" && draft.delivery?.state === "uncertain") return { label: "Check it", tone: "amber" };
  if (draft.status === "ready" && draft.delivery?.state === "sending") return { label: "Sending", tone: "blue" };
  if (draft.status === "ready" && draft.delivery?.state === "failed") return { label: "Didn't send", tone: "red" };
  if (draft.status === "ready") return approvalNeeded ? { label: "To approve", tone: "blue" } : { label: "Ready", tone: "green" };
  const words: Record<string, { label: string; tone: Tone }> = {
    in_review: { label: "In review", tone: "blue" }, draft: { label: "Not submitted", tone: "neutral" }, needs_changes: { label: "Needs changes", tone: "amber" },
    sent: { label: "Sent", tone: "purple" }, vetoed: { label: "Vetoed", tone: "red" }, discarded: { label: "Discarded", tone: "neutral" },
  };
  return words[draft.status] ?? { label: draft.status, tone: "neutral" };
}
export const TONE_TEXT: Record<Tone, string> = { neutral: "text-neutral-500", blue: "text-primary-700", green: "text-success-text", amber: "text-warning-text", red: "text-danger-text", purple: "text-ai-text" };
export const TONE_DOT: Record<Tone, string> = { neutral: "bg-neutral-300", blue: "bg-primary-500", green: "bg-success", amber: "bg-warning", red: "bg-danger", purple: "bg-ai" };
