// Writing (docs/sales-autopilot.md section 4, steps 3 to 5): the first email for a recommended lead, its one follow-up, and a rewrite of a
// draft the reviewer sent back. The connector's message rules (mcp/tools-sales.ts writeDraft) are applied here again, on the records
// themselves, before the model is asked and again right before saving (rule 6). Email only. A draft is saved through the same rules as
// POST /sales/leads/:id/drafts (one open version per channel: openSiblings) and a rewrite as PATCH /sales/drafts/:id, as the person the
// autopilot works as, via "claude", with the writer's session id (`auto-w:<uuid>`). Every draft goes to review.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EXIT_STAGES, PRE_CONTACT_STAGES } from "@venture-studio/contracts";
import { atomic, type AppDocument } from "../../db.js";
import { AppError } from "../../errors.js";
import { auditSales, settingsFor, type SalesCtx } from "../ctx.js";
import { isOpenDraft } from "../drafts.js";
import { defined, loadLead, openSiblings, requireLeadEditor, siblingRefusal } from "../leads.js";
import { PRICE_IN_TEXT, linkProblem, strictLinkProblem } from "../message-rules.js";
import type { SalesSettings } from "../settings.js";
import { DATA_RULE, dataBlock, leadBlock, rulesText, type OfferContext } from "./prompt.js";

export type Purpose = "first_touch" | "follow_up" | "reply";
export const writerSession = () => `auto-w:${randomUUID()}`;
export const isAutopilotWriter = (sessionId: unknown) => typeof sessionId === "string" && sessionId.startsWith("auto-w:");

/** Claude's message: the subject and the body. */
export const messageAnswerSchema = z.object({ subject: z.string(), body: z.string() });
export type MessageAnswer = z.infer<typeof messageAnswerSchema>;

const hasEmailRoute = (lead: AppDocument) => Array.isArray(lead.contactRoutes) && lead.contactRoutes.some((route: { kind?: unknown; value?: unknown }) => route.kind === "email" && typeof route.value === "string" && route.value.includes("@"));
/** A verdict a person set or overrode: their word stands, and the autopilot writes nothing for the lead (rule 4). */
export const personVerdict = (lead: AppDocument) => Boolean(lead.verdict?.overridden) || lead.verdict?.via === "app";

/**
 * Why the autopilot may not write this message for this lead, in plain words, or undefined when it may: the connector's rules (a draft only
 * for a "recommend" lead that does not wait for a person, a first message only before first contact, one follow-up only at contacted, one
 * open version per channel, nothing for a closed or do-not-contact lead), plus rule 4 and email only. `drafts` are the lead's drafts.
 */
export function messageBlocker(lead: AppDocument, drafts: readonly AppDocument[], purpose: Purpose, settings: Pick<SalesSettings, "allowedChannels">, inReplyTo?: string): string | undefined {
  if (lead.deletedAt) return "the lead was deleted";
  if (lead.doNotContact) return "the lead is on the do-not-contact list";
  if ((EXIT_STAGES as readonly unknown[]).includes(lead.stage)) return `the lead is closed (${String(lead.stage)})`;
  if (personVerdict(lead)) return "a person set this lead's verdict";
  if (lead.needsYou) return "the lead waits for a person's decision";
  if (!settings.allowedChannels.includes("email")) return "this venture does not use email";
  if (!hasEmailRoute(lead)) return "the lead has no email address";
  if (purpose === "reply") {
    if (!inReplyTo) return "there is no message to answer";
    if (drafts.some((draft) => draft.purpose === "reply" && draft.inReplyTo === inReplyTo && draft.channel !== "call_opener" && isOpenDraft(draft))) return "a reply to that message already waits";
    return undefined;
  }
  if (lead.verdict?.decision !== "recommend") return `its verdict is ${String(lead.verdict?.decision ?? "missing")}, not recommend`;
  if (purpose === "first_touch") {
    if (!(PRE_CONTACT_STAGES as readonly unknown[]).includes(lead.stage)) return `a first message is for a lead nobody has contacted yet, and this one is ${String(lead.stage)}`;
    if (drafts.some((draft) => draft.purpose === "first_touch" && (draft.status === "sent" || isOpenDraft(draft)))) return "a first message is already written or sent";
  }
  if (purpose === "follow_up") {
    if (lead.stage !== "contacted") return `a follow-up is for a contacted lead, and this one is ${String(lead.stage)}`;
    if (drafts.some((draft) => draft.purpose === "follow_up" && (draft.status === "sent" || isOpenDraft(draft)))) return "the one follow-up is already written or sent";
  }
  return undefined;
}

/** The answer as a message the server saves, or the rule it breaks: a subject, a body, no links (but one wa.me line), no price before a reply. */
export function checkMessage(answer: MessageAnswer, purpose: Purpose): { subject: string; body: string } | { problem: string } {
  const subject = answer.subject.replace(/\s+/g, " ").trim();
  const body = answer.body.replace(/\r\n/g, "\n").trim();
  if (!subject) return { problem: "An email needs a subject" };
  if (subject.length > 200) return { problem: "The subject is longer than 200 characters" };
  if (!body) return { problem: "The message is empty" };
  if (body.length > 5_000) return { problem: "The message is longer than 5,000 characters" };
  // A subject carries no link at all (not even wa.me: that is only the email's last line).
  const links = linkProblem(body, "email") ?? linkProblem(subject, "subject") ?? strictLinkProblem(body, true) ?? strictLinkProblem(subject, false);
  if (links) return { problem: links };
  if (purpose !== "reply" && PRICE_IN_TEXT.test(`${subject} ${body}`)) return { problem: "First messages and follow-ups carry no price: say it on the call" };
  return { subject, body };
}

const WRITING_RULES = [
  "Write one email a person on the team will send under their own name, after a separate review. Plain words, short sentences, the language the offer says (English unless it says otherwise).",
  "Open only with the quoted signal from the verdict: what the company itself says on its site. Ask, don't tell: never tell them they have a problem.",
  "Say what we do in one plain sentence. Use only the offer's approved claims and proof words; never a claim to avoid.",
  "No price, no amount, no date or number we haven't approved. No links, web addresses or email addresses (not even a bare domain), except one wa.me line as the very last line, only if the offer's message rules ask for it.",
  "Never put a web address or an email address in the subject or the body, not even when you quote the signal: when the signal names one (\"mail us at dealers@acme.in\"), say that part in your own words (\"your site asks dealers to write in\"). A message with one is refused.",
  "Exactly one call to action. Keep to the offer's length for email (short: about 80 to 120 words unless its rules say otherwise).",
  "Never invent a person's name, a client, a result or a fact. Leave out the greeting's name when no contact person is known.",
  "Return the subject (short, no clickbait) and the body (no signature block: the sender's mail adds it).",
].join("\n");

const systemFor = (offer: OfferContext, task: string) => [task, DATA_RULE, WRITING_RULES, "The team's rules for this offer:", rulesText(offer)].join("\n\n");

/** The first email for a recommended lead. `signal` and `summary` come from the verdict the server checked. */
export function firstMessagePrompt(lead: AppDocument, offer: OfferContext, verdict: { signal: string; summary: string }) {
  return {
    system: systemFor(offer, "You write the first email to a company nobody on the team has contacted yet."),
    user: ["The lead:", leadBlock(lead), "The verdict's quoted signal (open with it):", dataBlock("signal", verdict.signal || "(none)", 1_200), "The verdict in one line:", dataBlock("verdict", verdict.summary, 600), "Write the first email."].join("\n\n"),
  };
}

/** The one follow-up, after the first email went out and nothing came back. */
export function followUpPrompt(lead: AppDocument, offer: OfferContext, verdict: { signal: string; summary: string }, firstMessage: string) {
  return {
    system: systemFor(offer, "You write the one follow-up to a company that got our first email and has not answered. It is the last message of the sequence: short, polite, a new angle or a simpler question, never pushy, never 'just following up'."),
    user: ["The lead:", leadBlock(lead), "The verdict's quoted signal:", dataBlock("signal", verdict.signal || "(none)", 1_200), "The first email we sent:", dataBlock("first message", firstMessage, 4_000), "Write the follow-up email."].join("\n\n"),
  };
}

/** A rewrite of a draft the reviewer sent back: only the reviewer's issues are fixed. */
export function fixPrompt(lead: AppDocument, offer: OfferContext, draft: AppDocument, issues: readonly string[]) {
  return {
    system: systemFor(offer, "You fix an email a reviewer sent back. Change only what the reviewer's issues ask for; keep everything else as it is."),
    user: ["The lead:", leadBlock(lead), "The draft:", dataBlock("draft", `Subject: ${String(draft.subject ?? "")}\n\n${String(draft.body ?? "")}`, 6_000), "The reviewer's issues:", dataBlock("issues", issues.map((issue) => `- ${issue}`).join("\n") || "- (none given)", 3_000), "Return the fixed email."].join("\n\n"),
  };
}

// ---- Saving ----------------------------------------------------------------------------------------------------------------------

/**
 * Saves a new email draft for review, as POST /sales/leads/:id/drafts does for Claude: the lead read again and the rules applied again,
 * the lead's play carried over, and one open version per channel (a second one is refused in the same transaction).
 */
export async function createDraft(ctx: SalesCtx, leadId: string, message: { purpose: Purpose; subject: string; body: string; inReplyTo?: string; sessionId: string }): Promise<AppDocument> {
  const lead = await loadLead(ctx, leadId);
  requireLeadEditor(ctx, lead, "write drafts for this lead");
  const settings = await settingsFor(ctx, String(lead.ventureId));
  const drafts = await ctx.db.collection("sales_drafts").find({ workspaceId: ctx.workspaceId, leadId: String(lead._id) }).toArray();
  const blocked = messageBlocker(lead, drafts, message.purpose, settings, message.inReplyTo);
  if (blocked) throw new AppError(409, "CONFLICT", `Not written: ${blocked}`);
  if (message.inReplyTo && !await ctx.db.collection("sales_activities").findOne({ _id: message.inReplyTo, workspaceId: ctx.workspaceId, leadId: String(lead._id), direction: "in" }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "inReplyTo must be a message from this lead");
  const playId = typeof lead.playId === "string" && await ctx.db.collection("sales_plays").findOne({ _id: lead.playId, workspaceId: ctx.workspaceId, ventureId: lead.ventureId }, { projection: { _id: 1 } }) ? lead.playId : undefined;
  const now = new Date();
  const draft = defined({
    _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, playId, inReplyTo: message.inReplyTo, channel: "email", purpose: message.purpose, subject: message.subject, body: message.body,
    status: "in_review", authorId: ctx.actor.id, authorVia: ctx.via, authorSessionId: message.sessionId, createdAt: now, updatedAt: now,
  });
  await atomic(ctx.database, async (session) => {
    const others = await openSiblings(ctx, draft, session);
    if (others.length) throw new AppError(409, "CONFLICT", siblingRefusal(draft, others[0]!));
    await ctx.db.collection("sales_drafts").insertOne(draft, { session });
    await auditSales(ctx, "sales.draft.create", "draft", String(draft._id), String(lead.ventureId), { channel: "email", purpose: message.purpose, status: "in_review", autopilot: true }, session);
  });
  return draft;
}

/**
 * Saves a rewrite of a draft the reviewer sent back, as PATCH /sales/drafts/:id does for Claude: back to review, the review and any approval
 * cleared, a new writer session. Only while the draft is still the version that was read (`updatedAt`); the runner raises `autoRevisions` (the rounds) before it asks for the rewrite, so a rewrite that fails still uses up its round.
 */
export async function reviseDraft(ctx: SalesCtx, draft: AppDocument, message: { subject: string; body: string; sessionId: string; round: number }): Promise<void> {
  const lead = await loadLead(ctx, String(draft.leadId));
  requireLeadEditor(ctx, lead, "edit this draft");
  if (draft.status !== "needs_changes" || draft.sendLock) throw new AppError(409, "CONFLICT", "Not fixed: the draft changed meanwhile");
  const now = new Date();
  await atomic(ctx.database, async (session) => {
    const changed = await ctx.db.collection("sales_drafts").updateOne({ _id: draft._id, status: "needs_changes", sendLock: null, updatedAt: draft.updatedAt }, {
      $set: { subject: message.subject, body: message.body, status: "in_review", authorId: ctx.actor.id, authorVia: ctx.via, authorSessionId: message.sessionId, updatedAt: now },
      $unset: { review: "", personApproval: "" },
    }, { session });
    if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Not fixed: the draft changed meanwhile");
    await auditSales(ctx, "sales.draft.update", "draft", String(draft._id), String(lead.ventureId), { autopilot: true, round: message.round }, session);
  });
}
