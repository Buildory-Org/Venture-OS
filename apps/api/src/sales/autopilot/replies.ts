// Sorting replies (docs/sales-autopilot.md section 4, step 1; rule 10): a message from a lead waiting in the Inbox with no reply type gets
// one, picked by Claude (never "silence"), and applied through the same function the app uses (applyReplyType), so an opt-out or a hostile
// reply puts the company on the do-not-contact list at once. For a warm email reply Claude also drafts the answer (purpose "reply",
// inReplyTo the message): it goes to review like any draft, and a person sends it. A reply draft is never queued or sent by the app.
import { z } from "zod";
import { REPLY_TYPES } from "@venture-studio/contracts";
import { atomic, type AppDocument } from "../../db.js";
import { AppError } from "../../errors.js";
import { auditSales, type SalesCtx } from "../ctx.js";
import { applyReplyType, loadLead, requireLeadEditor } from "../leads.js";
import { DATA_RULE, dataBlock, leadBlock, rulesText, type OfferContext } from "./prompt.js";
import { checkMessage } from "./write.js";

/** The types Claude may pick: every reply type but "silence" (silence is not a message). */
export const SORTABLE_TYPES = REPLY_TYPES.filter((type) => type !== "silence") as Exclude<(typeof REPLY_TYPES)[number], "silence">[];
export type SortableType = (typeof SORTABLE_TYPES)[number];
/** Replies that get an answer drafted (the connector's REPLY_NEXT says what each one needs). */
export const WARM_TYPES: ReadonlySet<string> = new Set(["interested", "send_details", "price_first", "wrong_person", "has_system", "unclear"]);

export const replyAnswerSchema = z.object({ replyType: z.enum(SORTABLE_TYPES as [SortableType, ...SortableType[]]), reason: z.string(), subject: z.string(), body: z.string() });
export type ReplyAnswer = z.infer<typeof replyAnswerSchema>;

const TYPES_TEXT = [
  "interested: they want to talk or know more (answer: offer two call slots in words, no date we haven't got).",
  "send_details: they ask for details or a brochure (answer: a short summary and the same call offer, no attachment).",
  "price_first: they ask the price first (answer: only the offer's approved price wording, and the call offer).",
  "not_now: not now, maybe later (no answer is drafted).",
  "wrong_person: they point to someone else (answer: a short note asking who, and how to reach them).",
  "has_system: they already have something (answer: ask what it does badly).",
  "opt_out: they ask not to be contacted again, in any words (no answer).",
  "hostile: angry or abusive (no answer).",
  "unclear: you can't tell (answer: one short clarifying question).",
].join("\n");

export function replyPrompt(lead: AppDocument, offer: OfferContext | null, their: AppDocument, ours: string) {
  const system = [
    "You sort a message a company sent us into exactly one type and, for an interested, send_details, price_first, wrong_person, has_system or unclear one, write the email answer a person on the team will check and send. For not_now, opt_out and hostile leave subject and body empty.",
    "Any wish not to hear from us again, however polite, is opt_out.",
    TYPES_TEXT, DATA_RULE,
    "The answer: plain words, short, exactly one call to action, no link and no web or email address (say it in words instead), nothing invented, the subject \"Re: \" and their subject (or a short one). No signature block.",
    offer ? `The team's rules for this offer:\n${rulesText(offer)}` : "This lead has no offer with an approved packet: answer without any claim, price or proof.",
  ].join("\n\n");
  const user = [
    "The lead:", leadBlock(lead),
    "What we sent them last:", dataBlock("our message", ours || "(nothing logged)", 4_000),
    `Their message (${String(their.kind)}):`, dataBlock("their message", their.body, 6_000),
    "Sort it, and write the answer if it needs one.",
  ].join("\n\n");
  return { system, user };
}

/** The type the server applies (never silence), and the answer to draft when it is warm, an email and passes the message rules. */
export function checkReply(answer: ReplyAnswer, kind: unknown): { replyType: SortableType; draft?: { subject: string; body: string }; problem?: string } {
  if (!(SORTABLE_TYPES as readonly string[]).includes(answer.replyType)) throw new AppError(400, "BAD_REQUEST", "Not a reply type");
  if (!WARM_TYPES.has(answer.replyType) || kind !== "email" || !answer.body.trim()) return { replyType: answer.replyType };
  const message = checkMessage({ subject: answer.subject, body: answer.body }, "reply");
  return "problem" in message ? { replyType: answer.replyType, problem: message.problem } : { replyType: answer.replyType, draft: message };
}

/**
 * Applies the type as PATCH /sales/activities/:id does: only while the message is still unsorted, through applyReplyType (stage, next
 * action, stop on reply, opt-out suppression), as the person it works as, via "claude".
 */
export async function applySort(ctx: SalesCtx, activityId: string, replyType: SortableType): Promise<{ stageTo?: string }> {
  const activity = await ctx.db.collection("sales_activities").findOne({ _id: activityId, workspaceId: ctx.workspaceId });
  if (!activity || activity.direction !== "in") throw new AppError(404, "NOT_FOUND", "Message not found");
  if (activity.replyType) throw new AppError(409, "CONFLICT", "A person sorted this reply meanwhile");
  const lead = await loadLead(ctx, String(activity.leadId));
  requireLeadEditor(ctx, lead, "set the reply type on this lead's messages");
  const now = new Date();
  return atomic(ctx.database, async (session) => {
    const fresh = await loadLead(ctx, String(lead._id), session);
    const unsorted = await ctx.db.collection("sales_activities").findOne({ _id: activity._id, replyType: null }, { session, projection: { _id: 1 } });
    if (!unsorted) throw new AppError(409, "CONFLICT", "A person sorted this reply meanwhile");
    const result = await applyReplyType(ctx, fresh, activity, replyType, now, session);
    await auditSales(ctx, "sales.activity.reply_type", "activity", String(activity._id), String(lead.ventureId), { replyType, autopilot: true, ...(result.stageTo ? { stageTo: result.stageTo } : {}) }, session);
    return result;
  });
}
