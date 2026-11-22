// Judging a lead (docs/sales-autopilot.md section 4, step 6): the server reads the company's own pages, Claude answers against the offer's
// approved packet, and the server checks the answer before anything is saved (rule 3, "evidence or nothing"): a quote is kept only when it
// is on the page it names, as read in this pass; a "recommend" without a checked signal quote, with a failed or unanswered gate, or without
// any checked evidence is saved as "hold" (which waits for a person). The page text is never stored. The verdict is saved through the same
// rules as POST /sales/leads/:id/verdicts (planVerdict, verdictOffer, the person's-word checks), as the person it works as, via "claude".
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verdictInputSchema } from "@venture-studio/contracts";
import { atomic } from "../../db.js";
import { AppError } from "../../errors.js";
import { auditSales, type SalesCtx } from "../ctx.js";
import type { ReadFailure } from "../finder/fetch.js";
import { discardOpenDrafts, loadLead, requireLeadEditor, stageNote } from "../leads.js";
import { notifyNeedsYou } from "../notify.js";
import { verdictOffer } from "../offers.js";
import { planVerdict, type VerdictInput } from "../rules.js";
import { DATA_RULE, dataBlock, leadBlock, rulesText, type OfferContext } from "./prompt.js";
import type { AppDocument } from "../../db.js";

/** A page as read in this pass: its address and its visible lines. Kept in memory for the checks only. */
export type ReadPage = { url: string; lines: readonly string[] };

const PAGE_CHARS = 7_000;

/** Claude's answer. Plain types only (lengths are checked here, after the answer, not by the output format). */
export const judgeAnswerSchema = z.object({
  evidence: z.array(z.object({ claim: z.string(), quote: z.string(), url: z.string() })),
  gates: z.array(z.object({ gate: z.string(), result: z.enum(["pass", "fail", "unknown"]), note: z.string() })),
  against: z.string(), offerFit: z.string(),
  signalQuote: z.string(), signalUrl: z.string(),
  contactRoute: z.string(), openQuestion: z.string(),
  decision: z.enum(["recommend", "hold", "reject"]), confidence: z.enum(["low", "medium", "high"]), summary: z.string(),
});
export type JudgeAnswer = z.infer<typeof judgeAnswerSchema>;

export function judgePrompt(lead: AppDocument, offer: OfferContext, pages: readonly ReadPage[]): { system: string; user: string } {
  const system = [
    "You judge whether a company is worth contacting for one offer, using only the company's own web pages given to you. You work for a small sales team in India.",
    DATA_RULE,
    "Work in this order:",
    "1. Evidence first: each claim you rely on, with a quote copied word for word from the page lines (at least 4 words, under 25, never change a word) and the exact URL of the page it is on, as given. Never quote from memory or from the lead record. Write nothing you did not see.",
    "2. Every gate of the offer, by its code (for example \"G1\"): pass, fail or unknown, with a short note naming what you saw.",
    "3. The case against: the strongest honest reason not to contact them, starting \"May\".",
    "4. The signal a first message would open with: a quote from a page (signalQuote) and its URL (signalUrl); empty when there is none.",
    "5. Decide last: recommend only with a signal quote, every gate passed and medium or high confidence; reject when a gate fails; hold when you are unsure, the evidence conflicts, or it is a national brand. Low confidence asks a person.",
    "contactRoute: the business email or phone the company publishes, with the page it is on, or \"none seen\". openQuestion: what a person should check, if anything. summary: one line, the verdict and why.",
    "The team's rules for this offer:",
    rulesText(offer),
  ].join("\n");
  const user = [
    "The lead:", leadBlock(lead),
    `The company's pages, as the server read them just now (${pages.length}):`,
    ...pages.map((page, index) => dataBlock(`page ${index + 1}`, `URL: ${page.url}\n${page.lines.join("\n")}`, PAGE_CHARS)),
    "Judge this lead against the offer.",
  ].join("\n\n");
  return { system, user };
}

// ---- The checks ------------------------------------------------------------------------------------------------------------------

/** Case, white space and curly quote marks set aside: what "word for word" compares. */
export const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"').replace(/\s+/g, " ").trim();
/** A page address compared without its fragment or a trailing slash. */
function pageKey(url: string): string | undefined {
  try { const parsed = new URL(url.trim()); parsed.hash = ""; return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`; } catch { return undefined; }
}
/** A quote that counts says something: at least 20 characters and 4 words ("Contact us" proves nothing). */
const MIN_QUOTE_CHARS = 20;
const MIN_QUOTE_WORDS = 4;

/** Whether `quote` is on the page at `url` among the pages read in this pass. */
export function quoteOnPage(quote: string, url: string, pages: readonly ReadPage[]): boolean {
  const wanted = normalized(quote);
  const key = pageKey(url);
  if (wanted.length < MIN_QUOTE_CHARS || wanted.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word)).length < MIN_QUOTE_WORDS || !key) return false;
  const page = pages.find((item) => pageKey(item.url) === key);
  return Boolean(page) && normalized(page!.lines.join(" ")).includes(wanted);
}

const clip = (value: string, max: number) => { const text = value.replace(/\s+/g, " ").trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };

export type CheckedVerdict = { input: VerdictInput; dropped: number; held?: string };

/**
 * The answer as the verdict the server saves: unchecked quotes dropped, the packet's gates answered by code (one not answered reads
 * unknown), and a recommend that lacks a checked signal, checked evidence or a passed gate turned into hold with the reason.
 */
export function checkVerdict(answer: JudgeAnswer, pages: readonly ReadPage[], offer: OfferContext, now: Date): CheckedVerdict {
  const seenAt = now.toISOString();
  const evidence = answer.evidence.filter((item) => quoteOnPage(item.quote, item.url, pages)).slice(0, 20)
    .map((item) => ({ claim: clip(item.claim, 500) || "Seen on the company's page", quote: clip(item.quote, 1_000), url: item.url.trim(), seenAt }));
  const dropped = answer.evidence.length - evidence.length;
  const packetGates = offer.packet.gates;
  // A gate is answered by its exact code, the answer's first word ("G1", "G1:", "G1 makes pumps"): "G10" never answers for "G1".
  const codeOf = (text: string) => normalized(text).split(" ")[0]?.replace(/[^a-z0-9-]/g, "") ?? "";
  const answered = (code: string) => answer.gates.find((gate) => codeOf(gate.gate) === normalized(code));
  const gates = (packetGates.length
    ? packetGates.map((gate) => { const found = answered(gate.code); return { gate: clip(`${gate.code} ${gate.rule}`, 80), result: found?.result ?? "unknown", note: clip(found?.note ?? "Not answered", 500) }; })
    : answer.gates.map((gate) => ({ gate: clip(gate.gate, 80) || "Gate", result: gate.result, note: clip(gate.note, 500) }))).slice(0, 12);
  const signalChecked = answer.signalQuote.trim() !== "" && quoteOnPage(answer.signalQuote, answer.signalUrl, pages);
  let decision = answer.decision;
  let held: string | undefined;
  if (decision === "recommend") {
    if (!signalChecked) held = "the signal quote was not found on the page it names";
    else if (gates.some((gate) => gate.result === "fail")) held = "a gate failed";
    else if (gates.some((gate) => gate.result === "unknown")) held = "a gate could not be answered";
    else if (!evidence.length) held = "none of its quotes was found on the pages read";
  } else if (decision === "reject" && !evidence.length) held = "none of its quotes was found on the pages read";
  if (held) decision = "hold";
  // A verdict carries at least one piece of evidence: with none checked, only the address of the page that was read (never its text).
  const home = pages[0];
  const shown = evidence.length || !home ? evidence : [{ claim: "None of Claude's quotes could be checked on the pages read: a person reads the site", quote: clip(home.url, 1_000), url: home.url, seenAt }];
  const openQuestion = clip([held ? `Saved as hold: ${held}.` : "", answer.openQuestion].filter(Boolean).join(" "), 1_000);
  const input = verdictInputSchema.parse({
    decision, confidence: answer.confidence, offer: clip(offer.name, 200), offerId: offer.offerId, offerFit: clip(answer.offerFit, 2_000) || "Not said",
    evidence: shown, gates, against: clip(answer.against, 2_000) || "May not be a fit: no reason against was given.", openQuestion, contactRoute: clip(answer.contactRoute, 500),
    signal: signalChecked ? clip(`"${answer.signalQuote.trim()}" (${answer.signalUrl.trim()})`, 1_000) : "", ...(signalChecked ? { signalSeenAt: seenAt } : {}),
    summary: clip(held ? `Hold (${held}): ${answer.summary}` : answer.summary, 500) || `${decision} for ${offer.name}`,
  });
  return { input, dropped, ...(held ? { held } : {}) };
}

const READ_WORDS: Record<ReadFailure["failed"], string> = {
  unsafe: "its address is not a public website", robots: "its robots.txt closes it to crawlers", challenge: "it is behind a CAPTCHA or bot check", blocked: "it refused the reader (HTTP 403 or 429)",
  not_html: "it is not a web page", http: "it answered with an error", network: "it did not answer",
};
export const readFailureText = (failure: ReadFailure | undefined) => failure ? READ_WORDS[failure.failed] : "nothing on it could be read";

/** The hold for a site that couldn't be read: no model call, the reason in plain words, a person checks it. */
export function unreadableVerdict(reason: string, homeUrl: string, offer: OfferContext): VerdictInput {
  return verdictInputSchema.parse({
    decision: "hold", confidence: "low", offer: clip(offer.name, 200), offerId: offer.offerId, offerFit: "Not judged: the website could not be read.",
    evidence: [{ claim: clip(`The website could not be read: ${reason}`, 500), quote: clip(homeUrl, 1_000), url: homeUrl }],
    against: "May not be a fit: nothing on its website could be read to judge it.", openQuestion: "Check the website by hand, or correct its address, then judge it again.",
    summary: clip(`Hold: the website could not be read (${reason}). A person checks it.`, 500),
  });
}

// ---- Saving ----------------------------------------------------------------------------------------------------------------------

/** Why the autopilot may not judge this lead (rule 4: a person's word stands), or undefined when it may. */
export function judgeBlocker(lead: AppDocument): string | undefined {
  if (lead.doNotContact) return "on the do-not-contact list";
  if (lead.needsYou) return "waits for a person's decision";
  if (lead.verdict) return lead.verdict.overridden || lead.verdict.via === "app" ? "a person set its verdict" : "already judged";
  if (lead.stage !== "identified") return "no longer at identified";
  return undefined;
}

/**
 * Saves a verdict as POST /sales/leads/:id/verdicts does for Claude (via "claude"): the lead read again first and the person's-word checks
 * applied again, then one transaction that only lands while the lead still has no verdict.
 */
export async function saveVerdict(ctx: SalesCtx, leadId: string, input: VerdictInput): Promise<{ verdictId: string; stage: string; needsYou: boolean }> {
  const lead = await loadLead(ctx, leadId);
  requireLeadEditor(ctx, lead, "save a verdict on this lead");
  const blocked = judgeBlocker(lead);
  if (blocked) throw new AppError(409, "CONFLICT", `Not judged: the lead ${blocked}`);
  const offer = await verdictOffer(ctx, lead, input.offerId);
  const now = new Date();
  const verdictId = randomUUID();
  const sessionId = `auto-j:${randomUUID()}`;
  const plan = planVerdict(lead, input, verdictId, now, { via: ctx.via, actorId: ctx.actor.id });
  if (offer.setOnLead) plan.set.offerId = offer.offerId;
  const verdict = {
    _id: verdictId, workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, createdBy: ctx.actor.id, via: ctx.via, createdAt: now, ...input, sessionId, ...(offer.offerId ? { offerId: offer.offerId } : {}),
    evidence: input.evidence.map((item) => ({ ...item, ...(item.seenAt ? { seenAt: new Date(item.seenAt) } : {}) })), ...(input.signalSeenAt ? { signalSeenAt: new Date(input.signalSeenAt) } : {}),
  };
  await atomic(ctx.database, async (session) => {
    const changed = await ctx.db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, stage: lead.stage, verdict: null, needsYou: { $ne: true } }, { $set: { ...plan.set, updatedAt: now }, ...(plan.unset.length ? { $unset: Object.fromEntries(plan.unset.map((field) => [field, ""])) } : {}) }, { session });
    if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Not judged: the lead changed meanwhile");
    await ctx.db.collection("sales_verdicts").insertOne(verdict, { session });
    if (plan.stageTo) {
      await stageNote(ctx, lead, plan.stageFrom, plan.stageTo, "system", now, session, `Stage: ${plan.stageFrom} -> ${plan.stageTo} after Claude's verdict (${input.decision})`);
      await discardOpenDrafts(ctx, String(lead._id), plan.discardDrafts, `Lead moved to ${plan.stageTo}`, now, session);
    }
    if (plan.set.needsYou === true && lead.needsYou !== true) await notifyNeedsYou(ctx, lead, verdictId, `${input.decision}, ${input.confidence} confidence: ${input.summary}`, now, session);
    await auditSales(ctx, "sales.verdict.save", "verdict", verdictId, String(lead.ventureId), { decision: input.decision, confidence: input.confidence, needsYou: Boolean(plan.set.needsYou), autopilot: true, ...(offer.offerId ? { offerId: offer.offerId } : {}), ...(plan.stageTo ? { stageTo: plan.stageTo } : {}) }, session);
  });
  return { verdictId, stage: String(plan.stageTo ?? lead.stage), needsYou: plan.set.needsYou === true };
}
