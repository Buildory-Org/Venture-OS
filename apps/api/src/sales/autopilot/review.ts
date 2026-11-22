// Reviewing (docs/sales-autopilot.md section 4, step 2; rule 5, "Claude never approves its own work"): every draft waiting for review in
// the venture (the autopilot's own and those written in a Claude chat) gets a separate call with its own session id (`auto-r:<uuid>`). The
// reviewer sees the draft, the lead's facts, the offer's rules and the checks, never the writer's reasoning (none is kept). The server
// checks the draft itself too: a draft that breaks a message rule fails whatever the model says. Saved through the same rule as
// POST /sales/drafts/:id/review (reviewOutcome), via "claude". It never sets a person's approval.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomic, type AppDocument } from "../../db.js";
import { AppError } from "../../errors.js";
import { requireWriter } from "../access.js";
import { auditSales, settingsFor, type SalesCtx } from "../ctx.js";
import { needsPersonApproval, reviewOutcome } from "../drafts.js";
import { defined, loadLead } from "../leads.js";
import { PRICE_IN_TEXT, linkProblem, strictLinkProblem } from "../message-rules.js";
import { notifyApprovalNeeded } from "../notify.js";
import { DATA_RULE, dataBlock, leadBlock, rulesText, type OfferContext } from "./prompt.js";

export const reviewerSession = () => `auto-r:${randomUUID()}`;

export const reviewAnswerSchema = z.object({ result: z.enum(["pass", "fail"]), issues: z.array(z.string()), notes: z.string() });
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>;

const CHECKS = [
  "Check the draft against the offer, in this order, and fail it when any check fails:",
  "1. The opening signal is the verdict's quoted signal (what the company says on its own site), not something made up.",
  "2. It asks and does not tell: it never tells them they have a problem.",
  "3. Proof uses only the offer's approved claims and proof words, and no claim to avoid.",
  "4. No price, amount, date or number we haven't approved (a reply answering a price question may give the approved price wording). No link, except one wa.me line as the last line of an email.",
  "5. Exactly one call to action. The length and the language fit the channel.",
  "6. Nothing invented: no name, client, result or fact that isn't in the lead's facts or the offer.",
  "7. A reply answers what they actually wrote.",
  "Never rewrite the draft. Pass it, or fail it with each exact fix needed as one issue (short, plain words). notes: anything else a person should know.",
].join("\n");

export function reviewPrompt(draft: AppDocument, lead: AppDocument, offer: OfferContext | null, context: { signal: string; answering?: string }) {
  const system = [
    "You review a sales message before a person on the team sends it. You did not write it, and you only review.",
    DATA_RULE, CHECKS,
    offer ? `The team's rules for this offer:\n${rulesText(offer)}` : "This lead has no offer with an approved packet: judge the message on the checks alone, and fail anything that makes a claim you cannot check.",
  ].join("\n\n");
  const user = [
    "The lead:", leadBlock(lead),
    "The verdict's quoted signal:", dataBlock("signal", context.signal || "(none)", 1_200),
    ...(context.answering ? ["The message from them that this answers:", dataBlock("their message", context.answering, 4_000)] : []),
    `The draft (${String(draft.channel)}, ${String(draft.purpose).replaceAll("_", " ")}):`, dataBlock("draft", `${draft.subject ? `Subject: ${String(draft.subject)}\n\n` : ""}${String(draft.body ?? "")}`, 6_000),
    "Review it.",
  ].join("\n\n");
  return { system, user };
}

/** The message rules the server checks on any draft by itself (the same as when it is written), in plain words. */
export function draftProblems(draft: AppDocument, lead: AppDocument): string[] {
  const body = String(draft.body ?? "");
  const problems: string[] = [];
  if (lead.doNotContact) problems.push("The lead is on the do-not-contact list: this must not be sent");
  if (draft.channel === "email" && !String(draft.subject ?? "").trim()) problems.push("An email needs a subject");
  const links = linkProblem(body, String(draft.channel)) ?? strictLinkProblem(body, draft.channel === "email") ?? strictLinkProblem(String(draft.subject ?? ""), false);
  if (links) problems.push(links);
  if (draft.purpose !== "reply" && PRICE_IN_TEXT.test(`${String(draft.subject ?? "")} ${body}`)) problems.push("First messages and follow-ups carry no price: say it on the call");
  return problems.map((problem) => problem.slice(0, 300));
}

/** The review the server saves: the server's own problems always fail it; a fail always carries at least one issue. */
export function checkReview(answer: ReviewAnswer, problems: readonly string[]): { result: "pass" | "fail"; issues: string[]; notes: string } {
  const said = answer.issues.map((issue) => issue.replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean);
  const result = problems.length ? "fail" : answer.result;
  const issues = result === "fail" ? [...problems, ...said].slice(0, 20) : [];
  return { result, issues: result === "fail" && !issues.length ? ["The reviewer failed it without saying why: read it again"] : issues, notes: answer.notes.trim().slice(0, 2_000) };
}

/**
 * Saves the review as POST /sales/drafts/:id/review does for Claude: only a draft still waiting for review and still the version that was
 * read, never from the session that wrote it. A ready draft that waits for a person's approval tells the venture's heads, as today.
 */
export async function saveReview(ctx: SalesCtx, draft: AppDocument, review: { result: "pass" | "fail"; issues: string[]; notes: string }, sessionId: string): Promise<"ready" | "needs_changes"> {
  const lead = await loadLead(ctx, String(draft.leadId));
  requireWriter(ctx.actor, lead.ventureId, "review drafts");
  // The writer never reviews: whoever wrote it (a person's or a chat's session), this session is not theirs.
  if (draft.authorSessionId === sessionId) throw new AppError(409, "CONFLICT", "A review must come from another session than the one that wrote the draft");
  const status = reviewOutcome(draft, { result: review.result, sessionId }, ctx.via);
  const now = new Date();
  await atomic(ctx.database, async (session) => {
    const changed = await ctx.db.collection("sales_drafts").updateOne({ _id: draft._id, status: "in_review", updatedAt: draft.updatedAt }, { $set: { status, review: defined({ result: review.result, issues: review.issues, notes: review.notes, sessionId, by: ctx.actor.id, via: ctx.via, at: now }), updatedAt: now } }, { session });
    if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed while it was being reviewed");
    if (status === "ready") {
      const play = draft.playId ? await ctx.db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }, { session }) : null;
      if (needsPersonApproval({ ...draft, status: "ready" }, play, await settingsFor(ctx, String(lead.ventureId)))) await notifyApprovalNeeded(ctx, lead, draft, now, session);
    }
    await auditSales(ctx, "sales.draft.review", "draft", String(draft._id), String(lead.ventureId), { result: review.result, status, autopilot: true }, session);
  });
  return status;
}
