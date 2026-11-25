// The sales autopilot loop (docs/sales-autopilot.md section 4), built like the lead finder (sales/finder/runner.ts): every minute it takes
// each venture whose autopilot is on, one at a time, under a lease in `sales_autopilot_state` (5 minutes, renewed while it works; a second
// API process skips a venture another one holds), and makes one pass in the order of the spec: replies, review, fixes, follow-ups, first
// messages, judging, the daily search, and (mode "automatic" only) queueing. It works as the venture's chosen person, via "claude", so
// nothing it writes counts as a person's decision. One item's failure is logged and counted and the pass goes on; a model error that won't
// pass by itself (no key, a refused key, no credit) stops the pass and is kept as `lastError`. One JSON log line per model call and per
// pass; never a key, page text, a message, a reply or a rule's message (short reason codes only).
//
// What bounds the spend, in three layers: a hard daily budget of calls per venture (callBudget), taken before every call; a count of tries
// on each item (attempts.ts), taken before its call, that backs off and stops at 3; and everything that can be checked without a call (who
// may edit the lead, the message rules, what was already written) checked first, in the queries themselves where it can be.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { findRunInputSchema, OPEN_DRAFT_STATUSES } from "@venture-studio/contracts";
import { atomic, type AppDocument, type Database } from "../../db.js";
import { AppError } from "../../errors.js";
import { isHeadOf } from "../access.js";
import { auditSales, type SalesCtx } from "../ctx.js";
import { MESSAGE_KINDS, needsPersonApproval } from "../drafts.js";
import { addressBlocker } from "../channels/mailbox-guard.js";
import { enqueueDraft } from "../channels/send-queue.js";
import { createReader, type FetchImpl, type LookupImpl, type Reader } from "../finder/fetch.js";
import { isNotCompanyHost } from "../finder/extract.js";
import { SITE_BUDGET_MS, homesOf, readSite } from "../finder/runner.js";
import { defined } from "../leads.js";
import { usableOffers } from "../offers.js";
import { resolveSearchKeys } from "../search-keys.js";
import { hostOf } from "../search-engines.js";
import { calendarOf, loadSettings } from "../settings.js";
import { isWorkingDay, localDay } from "../workdays.js";
import { BUSY_WAIT_MS, MAX_TRIES, countTry, giveBack, mayTry, noteFailure, triable } from "./attempts.js";
import { bump, callBudget, callsMade, leadWork, releaseCall, reserveCall, type DayCount } from "./days.js";
import { checkVerdict, judgeAnswerSchema, judgeBlocker, judgePrompt, readFailureText, saveVerdict, unreadableVerdict, type ReadPage } from "./judge.js";
import { anthropicModel, type AskQuestion, type AutopilotModel } from "./model.js";
import { offerContext } from "./prompt.js";
import { applySort, checkReply, replyAnswerSchema, replyPrompt } from "./replies.js";
import { checkReview, draftProblems, reviewAnswerSchema, reviewPrompt, reviewerSession, saveReview } from "./review.js";
import { STATE, runAsActor, type AutopilotEnv } from "./status.js";
import { checkMessage, createDraft, firstMessagePrompt, fixPrompt, followUpPrompt, isAutopilotWriter, messageAnswerSchema, messageBlocker, reviseDraft, writerSession, type Purpose } from "./write.js";

/** The autopilot runs in the API process when SALES_AUTOPILOT is on, never under the test runner (tests call runOnce themselves). */
export const autopilotEnabled = (config: { SALES_AUTOPILOT: "on" | "off"; NODE_ENV: string }) => config.SALES_AUTOPILOT === "on" && config.NODE_ENV !== "test";

export const POLL_MS = 60_000;
export const LEASE_MS = 5 * 60_000;
/** The most each step takes on in one pass. */
export const PASS_LIMITS = { replies: 10, review: 10, fix: 5, followUps: 5, firstMessages: 5, judge: 5 } as const;
/** Rounds of the reviewer's fixes before a draft stays for a person. */
export const MAX_FIX_ROUNDS = 2;
const CALL_TOKENS = 16_000;
const CALL_TIMEOUT_MS = 180_000;
/** One id per process: two containers share a hostname and PID 1, so the lease must tell them apart. */
const PROCESS_ID = randomUUID().slice(0, 8);

export type AutopilotOptions = {
  database: Database; env: AutopilotEnv & { APP_ORIGIN: string };
  model?: AutopilotModel; reader?: Reader; fetchImpl?: FetchImpl; lookupImpl?: LookupImpl;
  /** The send queue's enqueue (injectable for tests). */
  enqueue?: typeof enqueueDraft;
  now?: () => Date; pollMs?: number; leaseMs?: number; siteBudgetMs?: number; workerId?: string;
  log?: (line: Record<string, unknown>) => void;
};
export type PassSummary = { ventureId: string; status: "done" | "skipped" | "stopped"; reason?: string; counts: Partial<Record<DayCount, number>>; failed: number };
export type Autopilot = { runOnce: (ventureId?: string) => Promise<PassSummary[]>; start: () => void; stop: () => Promise<void>; workerId: string };

/** The pass stops here: `reason` is kept as the venture's lastError (none when the server is stopping). */
class Stop extends Error { constructor(readonly reason?: string) { super(reason ?? "stopped"); } }
/** The day's budget of calls is used up: the pass ends quietly (the status says so). */
class BudgetSpent extends Error {}
/** Claude was busy (or the server is stopping mid-call): no more model work this pass. */
class Pause extends Error {}
/** The item changed between reading it and counting its try: no call was made; it is looked at again next pass. */
class Skip extends Error {}
/** A failure with a short code for the log (never the text of a message, a page or a reply). */
class ItemError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const codeOf = (error: unknown) => error instanceof ItemError ? error.code : error instanceof AppError ? String(error.code).toLowerCase() : "error";

export function createAutopilot(options: AutopilotOptions): Autopilot {
  const { database, env } = options;
  const db = database.db;
  const states = db.collection(STATE);
  const now = options.now ?? (() => new Date());
  const model = options.model ?? anthropicModel({ apiKey: env.ANTHROPIC_API_KEY, model: env.SALES_AUTOPILOT_MODEL });
  const reader = options.reader ?? createReader({ origin: env.APP_ORIGIN, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.lookupImpl ? { lookupImpl: options.lookupImpl } : {}) });
  const enqueue = options.enqueue ?? enqueueDraft;
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const siteBudgetMs = options.siteBudgetMs ?? SITE_BUDGET_MS;
  const workerId = (options.workerId ?? `${hostname()}-${process.pid}-${PROCESS_ID}-autopilot`).slice(0, 100);
  const log = options.log ?? ((line: Record<string, unknown>) => console.info(JSON.stringify(line)));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<PassSummary[]> | undefined;

  /** Takes the venture's lease, or false when another worker holds it (one conditional upsert: a held lease makes it collide on _id). */
  async function takeLease(ventureId: string, workspaceId: string): Promise<boolean> {
    const at = now();
    try {
      const result = await states.updateOne({ _id: ventureId, $or: [{ leaseUntil: { $lt: at } }, { leaseUntil: null }, { workerId }] }, { $set: { workspaceId, leaseUntil: new Date(at.getTime() + leaseMs), workerId, leaseAt: at } }, { upsert: true });
      return result.matchedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  /** The ventures to work: the one asked for, or every venture whose autopilot is on, a "run now" first, then the longest waiting. */
  async function ventures(only?: string): Promise<{ ventureId: string; workspaceId: string }[]> {
    const rows = await db.collection("sales_settings").find({ ...(only ? { _id: only } : { "autopilot.enabled": true }) }, { projection: { workspaceId: 1 } }).toArray();
    const live = new Set((await db.collection("ventures").find({ _id: { $in: rows.map((row) => row._id) }, status: { $ne: "archived" } }, { projection: { _id: 1 } }).toArray()).map((row) => String(row._id)));
    const state = new Map((await states.find({ _id: { $in: rows.map((row) => row._id) } }).toArray()).map((row) => [String(row._id), row]));
    const time = (value: unknown) => value instanceof Date ? value.getTime() : 0;
    return rows.filter((row) => live.has(String(row._id))).map((row) => ({ ventureId: String(row._id), workspaceId: String(row.workspaceId), state: state.get(String(row._id)) }))
      .sort((a, b) => time(b.state?.runRequestedAt) - time(a.state?.runRequestedAt) || time(a.state?.lastRunAt) - time(b.state?.lastRunAt))
      .map(({ ventureId, workspaceId }) => ({ ventureId, workspaceId }));
  }

  async function runOnce(only?: string): Promise<PassSummary[]> {
    const summaries: PassSummary[] = [];
    for (const venture of await ventures(only)) {
      if (stopped) break;
      summaries.push(await leased(venture.ventureId, venture.workspaceId));
    }
    return summaries;
  }

  /** One pass under the lease, renewed while it works; the state keeps when it ran, why it stopped, and a "run now" it answered. */
  async function leased(ventureId: string, workspaceId: string): Promise<PassSummary> {
    if (!await takeLease(ventureId, workspaceId)) return { ventureId, status: "skipped", reason: "Another server is working on this venture", counts: {}, failed: 0 };
    const started = now();
    const renew = setInterval(() => void states.updateOne({ _id: ventureId, workerId }, { $set: { leaseUntil: new Date(now().getTime() + leaseMs) } }).catch(() => undefined), Math.max(1_000, Math.floor(leaseMs / 3)));
    renew.unref();
    let summary: PassSummary;
    try {
      summary = await pass(ventureId, workspaceId);
    } catch (error) {
      // Not a model error: something unexpected (the database, a bug). Kept as the venture's last error, in short.
      log({ level: "warn", event: "sales.autopilot.pass_failed", ventureId, code: codeOf(error) });
      summary = { ventureId, status: "stopped", reason: `The autopilot hit an error and stopped: ${messageOf(error).slice(0, 200)}`, counts: {}, failed: 0 };
    } finally {
      clearInterval(renew);
    }
    const at = now();
    const lastError = summary.status === "stopped" ? summary.reason : undefined;
    await states.updateOne({ _id: ventureId, workerId }, { $set: { leaseUntil: at, ...(summary.status === "skipped" && summary.reason === "off" ? {} : { lastRunAt: at }), ...(lastError ? { lastError } : {}) }, ...(lastError ? {} : { $unset: { lastError: "" } }) });
    await states.updateOne({ _id: ventureId, runRequestedAt: { $lte: started } }, { $unset: { runRequestedAt: "" } });
    log({ level: "info", event: "sales.autopilot.pass", ventureId, workerId, status: summary.status, ...(summary.reason === "budget" ? { reason: "budget" } : {}), failed: summary.failed, ms: at.getTime() - started.getTime(), ...summary.counts });
    return summary;
  }

  async function pass(ventureId: string, workspaceId: string): Promise<PassSummary> {
    const settings = await loadSettings(db, workspaceId, ventureId);
    const auto = settings.autopilot;
    const counts: Partial<Record<DayCount, number>> = {};
    let failed = 0;
    if (!auto.enabled) return { ventureId, status: "skipped", reason: "off", counts, failed };
    const calendar = calendarOf(settings);
    /** The venture's local day, read at each use: a pass that crosses midnight charges the new day from then on. */
    const today = () => localDay(now(), calendar);
    const day = today();
    const cap = callBudget(auto.dailyLeadLimit);
    const count = async (more: Partial<Record<DayCount, number>>) => {
      for (const [key, value] of Object.entries(more) as [DayCount, number][]) counts[key] = (counts[key] ?? 0) + value;
      await bump(db, workspaceId, ventureId, today(), more);
    };
    try {
      // Nobody it may work as (left, became read-only, lost the venture): nothing runs, and the status says why.
      const who = await runAsActor(db, workspaceId, ventureId, auto.runAsUserId);
      if ("problem" in who) throw new Stop(who.problem);
      const ctx: SalesCtx = { database, db, actor: who.actor, via: "claude", channel: "engine", workspaceId, settings: new Map() };
      // The model steps run only with a key and while the day's calls aren't used up (checked before any step: no try, no call).
      const modelReady = Boolean(env.ANTHROPIC_API_KEY) && await callsMade(db, ventureId, day) < cap;
      /** Claude was busy (a rate limit, an overload, a timeout): no more model work this pass; the next pass tries again. */
      let paused = false;
      const leads = db.collection("opportunities");
      const drafts = db.collection("sales_drafts");
      const activities = db.collection("sales_activities");
      const live = { workspaceId, ventureId, deletedAt: null };
      // A head edits every lead of the venture; anyone else only their own. Leads they can't edit are left out before any call (the status
      // counts them for a head to act on).
      const head = isHeadOf(who.actor, ventureId);
      const mine = head ? {} : { ownerId: who.actor.id };
      const ownedIds = head ? undefined : (await leads.find({ ...live, ...mine }, { projection: { _id: 1 } }).toArray()).map((row) => String(row._id));
      const onMyLeads = ownedIds ? { leadId: { $in: ownedIds } } : {};
      // Leads whose offer has an approved, active packet (or, with no offer, the venture's only usable one): the others wait without a
      // place in the candidates (the status says the packet is missing).
      const usableIds = (await usableOffers(db, workspaceId, ventureId)).map((offer) => String(offer._id));
      const withPacket = { $or: [{ offerId: { $in: usableIds } }, ...(usableIds.length === 1 ? [{ offerId: null }] : [])] };

      /** The item a call is about: its try is counted once the call is reserved (`tried`), and given back if the failure is about us. */
      type On = { collection: typeof leads; doc: AppDocument; step: string; tried: boolean };
      /**
       * One question to the model. The day's call is reserved first (none left: the pass ends quietly), then a try is counted on the item,
       * then one log line and the tokens. A failure that is about us gives the try back: a lasting one stops the pass, a busy one ends this
       * pass's model work and makes the item wait 5 minutes. Any other failure is about the item: its try stays.
       */
      const ask = async <T>(question: Omit<AskQuestion<T>, "maxTokens" | "timeoutMs">, on: On, options: { leadWork?: boolean } = {}): Promise<T> => {
        const callDay = today();
        if (!await reserveCall(db, workspaceId, ventureId, callDay, cap)) throw new BudgetSpent();
        const taken = await countTry(on.collection, on.doc, on.step, now());
        if (!taken) { await releaseCall(db, ventureId, callDay); throw new Skip(); }
        on.tried = true;
        counts.modelCalls = (counts.modelCalls ?? 0) + 1;
        const result = stopped ? { error: "The server is stopping", busy: true } as const : await model.ask({ ...question, maxTokens: CALL_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
        const usage = "usage" in result ? result.usage : undefined;
        log({ level: "value" in result ? "info" : "warn", event: "sales.autopilot.call", step: on.step, ventureId, model: model.name, ok: "value" in result, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, stop: usage?.stop ?? null, ...("error" in result ? { error: result.error, ...("detail" in result ? result.detail ?? {} : {}), ...("busy" in result && result.busy ? { busy: true } : {}) } : {}) });
        if (usage) await count({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
        if ("error" in result && (("lasting" in result && result.lasting) || ("busy" in result && result.busy))) {
          const busy = "busy" in result && result.busy === true;
          await giveBack(on.collection, on.doc._id, taken, busy ? new Date(now().getTime() + BUSY_WAIT_MS) : undefined);
          on.tried = false;
          throw busy ? (stopped ? new Stop() : new Pause()) : new Stop(result.error);
        }
        if (options.leadWork) await count({ leadWork: 1 });
        if ("error" in result) throw new ItemError("model_error", result.error);
        return result.value;
      };
      /**
       * One item (a lead, a draft or a reply), skipped while it is at its stop or waiting. A failure is logged (as a code), kept on the item
       * (when its try was counted) and counted, and the pass goes on. Busy: no more model work this pass.
       */
      const each = async (step: string, collection: typeof leads, item: AppDocument, work: (on: On) => Promise<void>) => {
        if (stopped) throw new Stop();
        if (paused || !mayTry(item, now())) return;
        const on: On = { collection, doc: item, step, tried: false };
        try { await work(on); } catch (error) {
          if (error instanceof Stop || error instanceof BudgetSpent) throw error;
          if (error instanceof Pause) { paused = true; return; }
          if (error instanceof Skip) return;
          failed++;
          await count({ failed: 1 });
          if (on.tried) await noteFailure(collection, item._id, codeOf(error));
          log({ level: "warn", event: "sales.autopilot.item_failed", step, ventureId, id: String(item._id), code: codeOf(error) });
        }
      };
      /** Counts a try on an item without a model call (a hold saved for a site that can't be read): a save that fails can't loop. */
      const tryWithoutCall = async (on: On) => { const taken = await countTry(on.collection, on.doc, on.step, now()); if (!taken) throw new Skip(); on.tried = true; };
      /** Room left in the day's lead limit (judging, first messages and follow-ups share it). */
      const room = async () => (await leadWork(db, ventureId, today())) < auto.dailyLeadLimit;
      const verdictOf = async (lead: AppDocument) => {
        const verdict = typeof lead.verdict?.verdictId === "string" ? await db.collection("sales_verdicts").findOne({ _id: lead.verdict.verdictId, workspaceId }, { projection: { signal: 1, summary: 1 } }) : null;
        return { signal: String(verdict?.signal ?? lead.observedSignal ?? ""), summary: String(verdict?.summary ?? lead.verdict?.summary ?? "") };
      };
      const lastSent = async (leadId: unknown) => String((await activities.find({ workspaceId, leadId: String(leadId), direction: "out", kind: { $in: [...MESSAGE_KINDS] } }).sort({ at: -1 }).limit(1).next())?.body ?? "");
      const leadDrafts = (leadId: unknown) => drafts.find({ workspaceId, leadId: String(leadId) }).toArray();
      /** Leads that already have this message written (open) or sent: left out of the candidates in the query, so they can't fill a page. */
      const writtenFor = async (purpose: string) => (await drafts.distinct("leadId", { workspaceId, ventureId, purpose, status: { $in: [...OPEN_DRAFT_STATUSES, "sent"] } })).map(String);

      // 1. Replies: sort each one waiting in the Inbox, and draft the answer to a warm email.
      if (auto.replies && modelReady) {
        const waiting = await activities.find({ workspaceId, ventureId, direction: "in", replyType: null, handledAt: null, kind: { $in: [...MESSAGE_KINDS] }, ...onMyLeads, ...triable(now()) }).sort({ at: 1, _id: 1 }).limit(PASS_LIMITS.replies).toArray();
        for (const activity of waiting) await each("replies", activities, activity, async (on) => {
          const lead = await leads.findOne({ _id: activity.leadId, ...live });
          if (!lead) return;
          const offer = await offerContext(db, workspaceId, lead);
          const answer = await ask({ event: "sales.autopilot.reply", schema: replyAnswerSchema, ...replyPrompt(lead, offer, activity, await lastSent(lead._id)) }, on);
          const checked = checkReply(answer, activity.kind);
          await applySort(ctx, String(activity._id), checked.replyType);
          await count({ repliesSorted: 1 });
          if (checked.problem) log({ level: "info", event: "sales.autopilot.reply_not_drafted", ventureId, id: String(activity._id), code: "rule_broken" });
          if (!checked.draft) return;
          const fresh = await leads.findOne({ _id: lead._id, ...live });
          if (!fresh || messageBlocker(fresh, await leadDrafts(lead._id), "reply", settings, String(activity._id))) return;
          await createDraft(ctx, String(lead._id), { purpose: "reply", ...checked.draft, inReplyTo: String(activity._id), sessionId: writerSession() });
          await count({ replyDrafts: 1 });
        });
      }

      // 2. Review: every draft waiting for review in the venture, each in its own call and session.
      if (auto.review && modelReady) {
        const waiting = await drafts.find({ workspaceId, ventureId, status: "in_review", sendLock: null, ...triable(now()) }).sort({ updatedAt: 1, _id: 1 }).limit(PASS_LIMITS.review).toArray();
        for (const draft of waiting) await each("review", drafts, draft, async (on) => {
          const lead = await leads.findOne({ _id: draft.leadId, ...live });
          if (!lead) return;
          const offer = await offerContext(db, workspaceId, lead);
          const answering = draft.inReplyTo ? String((await activities.findOne({ _id: draft.inReplyTo, workspaceId }, { projection: { body: 1 } }))?.body ?? "") : undefined;
          const signal = (await verdictOf(lead)).signal;
          const answer = await ask({ event: "sales.autopilot.review", schema: reviewAnswerSchema, ...reviewPrompt(draft, lead, offer, { signal, ...(answering !== undefined ? { answering } : {}) }) }, on);
          const status = await saveReview(ctx, draft, checkReview(answer, draftProblems(draft, lead)), reviewerSession());
          await count(status === "ready" ? { passed: 1 } : { needChanges: 1 });
        });
      }

      // 3. Fixes: the autopilot's own drafts the reviewer sent back, up to MAX_FIX_ROUNDS; after that they stay for a person. The round is
      // counted before the rewrite is asked for, so a rewrite that fails (or breaks a rule) still uses it up.
      if (auto.write && modelReady) {
        const sentBack = await drafts.find({ workspaceId, ventureId, status: "needs_changes", channel: "email", sendLock: null, authorSessionId: /^auto-w:/, autoRevisions: { $not: { $gte: MAX_FIX_ROUNDS } }, ...onMyLeads, ...triable(now()) }).sort({ updatedAt: 1, _id: 1 }).limit(PASS_LIMITS.fix).toArray();
        for (const draft of sentBack) await each("fix", drafts, draft, async (on) => {
          if (!isAutopilotWriter(draft.authorSessionId)) return;
          const lead = await leads.findOne({ _id: draft.leadId, ...live });
          if (!lead) return;
          const others = (await leadDrafts(lead._id)).filter((item) => item._id !== draft._id);
          if (messageBlocker(lead, others, draft.purpose as Purpose, settings, typeof draft.inReplyTo === "string" ? draft.inReplyTo : undefined)) return;
          const offer = await offerContext(db, workspaceId, lead);
          if (!offer) return;
          const round = Number(draft.autoRevisions ?? 0) + 1;
          const counted = await drafts.updateOne({ _id: draft._id, status: "needs_changes", updatedAt: draft.updatedAt, autoRevisions: draft.autoRevisions ?? null }, { $set: { autoRevisions: round } });
          if (!counted.modifiedCount) return;
          let answer;
          try {
            answer = await ask({ event: "sales.autopilot.fix", schema: messageAnswerSchema, ...fixPrompt(lead, offer, draft, Array.isArray(draft.review?.issues) ? draft.review.issues.map(String) : []) }, on);
          } catch (error) {
            // No call was made, or the failure was about us: the round is given back with the try.
            if (error instanceof BudgetSpent || error instanceof Pause || error instanceof Stop || error instanceof Skip) await drafts.updateOne({ _id: draft._id, autoRevisions: round }, round > 1 ? { $set: { autoRevisions: round - 1 } } : { $unset: { autoRevisions: "" } });
            throw error;
          }
          const message = checkMessage(answer, draft.purpose as Purpose);
          if ("problem" in message) throw new ItemError("rule_broken", message.problem);
          await reviseDraft(ctx, draft, { ...message, sessionId: writerSession(), round });
        });
      }

      // 4 and 5. The one follow-up when it is due, then first messages for recommended leads: email only, inside the day's lead limit.
      const write = async (purpose: "follow_up" | "first_touch", candidates: AppDocument[], most: number) => {
        let written = 0;
        for (const lead of candidates) {
          if (written >= most || paused || !(await room())) break;
          await each(purpose, leads, lead, async (on) => {
            if (messageBlocker(lead, await leadDrafts(lead._id), purpose, settings)) return;
            // Its address bounced, was refused or takes no mail (channels/mailbox-guard.ts): nothing is written until a person adds another.
            if (await addressBlocker(ctx, { channel: "email", purpose }, lead)) return;
            const offer = await offerContext(db, workspaceId, lead);
            if (!offer) return;
            const verdict = await verdictOf(lead);
            const prompt = purpose === "first_touch" ? firstMessagePrompt(lead, offer, verdict) : followUpPrompt(lead, offer, verdict, await lastSent(lead._id));
            written++;
            const answer = await ask({ event: `sales.autopilot.${purpose}`, schema: messageAnswerSchema, ...prompt }, on, { leadWork: true });
            const message = checkMessage(answer, purpose);
            if ("problem" in message) throw new ItemError("rule_broken", message.problem);
            await createDraft(ctx, String(lead._id), { purpose, ...message, sessionId: writerSession() });
            await count(purpose === "first_touch" ? { written: 1 } : { followUps: 1 });
          });
        }
      };
      const contactable = { ...live, ...mine, ...withPacket, doNotContact: { $ne: true }, needsYou: { $ne: true }, "verdict.decision": "recommend", "verdict.overridden": { $ne: true }, "verdict.via": { $ne: "app" }, "contactRoutes.kind": "email" };
      if (auto.followUps && modelReady) await write("follow_up", await leads.find({ ...contactable, stage: "contacted", followUpDueAt: { $lte: now() }, _id: { $nin: await writtenFor("follow_up") }, ...triable(now()) }).sort({ followUpDueAt: 1, _id: 1 }).limit(PASS_LIMITS.followUps * 4).toArray(), PASS_LIMITS.followUps);
      if (auto.write && modelReady) await write("first_touch", await leads.find({ ...contactable, stage: "approved_for_contact", _id: { $nin: await writtenFor("first_touch") }, ...triable(now()) }).sort({ updatedAt: 1, _id: 1 }).limit(PASS_LIMITS.firstMessages * 4).toArray(), PASS_LIMITS.firstMessages);

      // 6. Judge new leads: the server reads the company's own site; a site that can't be read, or a website that isn't a web address, is
      // held without a model call (with a try counted, so a hold that can't be saved isn't re-read every minute).
      if (auto.judge && modelReady) {
        reader.newRun();
        const fresh = await leads.find({ ...live, ...mine, ...withPacket, stage: "identified", verdict: null, needsYou: { $ne: true }, doNotContact: { $ne: true }, website: { $type: "string", $ne: "" }, ...triable(now()) }).sort({ createdAt: 1, _id: 1 }).limit(PASS_LIMITS.judge * 4).toArray();
        let judged = 0;
        for (const lead of fresh) {
          if (judged >= PASS_LIMITS.judge || paused || !(await room())) break;
          await each("judge", leads, lead, async (on) => {
            if (judgeBlocker(lead)) return;
            const offer = await offerContext(db, workspaceId, lead);
            if (!offer) return;
            const homes = homesOf(String(lead.website));
            if (!homes.length) {
              // Not an address at all ("Acme Pvt Ltd"): nothing to read. It doesn't use up the pass's judging.
              await tryWithoutCall(on);
              await saveVerdict(ctx, String(lead._id), unreadableVerdict("its website isn't a web address: fix the lead's website", `${env.APP_ORIGIN}/sales/live/leads?lead=${encodeURIComponent(String(lead._id))}`, offer));
              await count({ judged: 1, held: 1 });
              return;
            }
            judged++;
            const host = hostOf(homes[0]!);
            const read = host && !isNotCompanyHost(host) ? await readSite(reader, homes, AbortSignal.timeout(siteBudgetMs)) : undefined;
            if (!read?.pages.length) {
              const reason = !host ? "its address isn't a website" : !read ? "it is a directory or a platform, not the company's own site" : readFailureText(read.failure);
              await tryWithoutCall(on);
              await saveVerdict(ctx, String(lead._id), unreadableVerdict(reason, homes[0]!, offer));
              await count({ judged: 1, held: 1 });
              return;
            }
            const pages: ReadPage[] = read.pages.map((page) => ({ url: page.url, lines: page.lines }));
            const answer = await ask({ event: "sales.autopilot.judge", schema: judgeAnswerSchema, ...judgePrompt(lead, offer, pages) }, on, { leadWork: true });
            const checked = checkVerdict(answer, pages, offer, now());
            await saveVerdict(ctx, String(lead._id), checked.input);
            const decision = checked.input.decision;
            await count({ judged: 1, ...(decision === "recommend" ? { recommended: 1 } : decision === "hold" ? { held: 1 } : { rejected: 1 }) });
            if (checked.dropped || checked.held) log({ level: "info", event: "sales.autopilot.judge_checked", ventureId, id: String(lead._id), droppedQuotes: checked.dropped, held: Boolean(checked.held) });
          });
        }
      }

      // 7. The daily search: one queued find run per working day, as the person it works as; the built-in finder works it.
      if (auto.find.enabled && auto.find.offerId && isWorkingDay(day, calendarOf(settings))) {
        try {
          const offer = (await usableOffers(db, workspaceId, ventureId)).find((row) => row._id === auto.find.offerId);
          const keys = await resolveSearchKeys(db, workspaceId, env);
          // Claimed for the day first, so two passes on the same day never queue two searches.
          const ready = offer && env.SALES_FINDER === "on" && (keys.tinyfish.length || keys.exa.length);
          const claimed = ready ? await states.updateOne({ _id: ventureId, findDay: { $ne: day } }, { $set: { findDay: day } }) : undefined;
          if (offer && claimed?.modifiedCount) {
            const input = findRunInputSchema.parse({ ventureId, offerId: String(offer._id), request: auto.find.request.length >= 3 ? auto.find.request : `Daily search for ${String(offer.name)}`, kind: "find", plan: { places: auto.find.places, categories: [], searches: [], limit: auto.find.perDay } });
            const at = now();
            const run = defined({ _id: randomUUID(), workspaceId, ...input, status: "queued", createdBy: ctx.actor.id, createdVia: "app", autopilot: true, createdAt: at, updatedAt: at });
            const person: SalesCtx = { ...ctx, via: "app" };
            await atomic(database, async (session) => {
              await db.collection("sales_find_runs").insertOne(run, { session });
              await auditSales(person, "sales.find_run.create", "find_run", String(run._id), ventureId, { status: "queued", limit: input.plan.limit, offerId: String(offer._id), autopilot: true }, session);
            });
          }
        } catch (error) {
          failed++;
          log({ level: "warn", event: "sales.autopilot.item_failed", step: "find", ventureId, id: ventureId, code: codeOf(error) });
        }
      }

      // 8. Queue (mode "automatic" only): emails that passed review in a play whose first batch a head approved, on a venture that does not
      // ask for a person on every message, that no person took back (`queueHold`). The sender is the person it works as (their standing
      // instruction): enqueue checks the rest.
      if (auto.send === "automatic" && settings.approvalMode !== "person_approves_every_message") {
        const ready = await drafts.find({ workspaceId, ventureId, status: "ready", channel: "email", purpose: { $in: ["first_touch", "follow_up"] }, sendQueue: null, sendLock: null, queueHold: null, authorVia: "claude", "review.result": "pass", "review.via": "claude", playId: { $type: "string" }, ...onMyLeads }).sort({ updatedAt: 1, _id: 1 }).limit(20).toArray();
        const person: SalesCtx = { ...ctx, via: "app" };
        for (const draft of ready) {
          if (stopped) throw new Stop();
          try {
            const play = await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId, ventureId });
            if (!play || play.firstBatchReviewed !== true || needsPersonApproval(draft, play, settings)) continue;
            const lead = await leads.findOne({ _id: draft.leadId, ...live });
            if (!lead) continue;
            const result = await enqueue(person, env, draft, lead, { auto: true, now: now() });
            if (result.queued) await count({ queued: 1 });
            else log({ level: "info", event: "sales.autopilot.not_queued", ventureId, id: String(draft._id), code: "refused" });
          } catch (error) {
            failed++;
            log({ level: "warn", event: "sales.autopilot.item_failed", step: "queue", ventureId, id: String(draft._id), code: codeOf(error) });
          }
        }
      }
      return { ventureId, status: "done", counts, failed };
    } catch (error) {
      if (error instanceof BudgetSpent) return { ventureId, status: "done", reason: "budget", counts, failed };
      if (!(error instanceof Stop)) throw error;
      return { ventureId, status: error.reason ? "stopped" : "skipped", ...(error.reason ? { reason: error.reason } : { reason: "The server is stopping" }), counts, failed };
    }
  }

  function start(): void {
    if (timer || stopped) return;
    const tick = () => {
      if (running || stopped) return;
      running = runOnce().catch((error: unknown) => { log({ level: "warn", event: "sales.autopilot.loop_failed", code: codeOf(error) }); return []; }).finally(() => { running = undefined; });
    };
    timer = setInterval(tick, options.pollMs ?? POLL_MS);
    timer.unref();
    log({ level: "info", event: "sales.autopilot.started", workerId });
    tick();
  }

  /** Stops the loop; a pass in progress ends after the item it is on (waiting up to 10 seconds), and its lease runs out by itself. */
  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearInterval(timer);
    if (running) await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
  }

  return { runOnce, start, stop, workerId };
}

export { MAX_TRIES };
