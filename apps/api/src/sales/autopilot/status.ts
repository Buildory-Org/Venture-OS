// GET /v1/sales/autopilot (docs/sales-autopilot.md section 6): the venture's autopilot settings, who it works as, what this server can do,
// the state, the blockers (plain sentences that say what fixes them), today's and the previous active day's counts, and what waits.
import { AUTOPILOT_STEPS, autopilotStatusSchema, type AutopilotSettings, type AutopilotStatus } from "@venture-studio/contracts";
import type { AppDb, AppDocument } from "../../db.js";
import { actorFor } from "../../middleware.js";
import { canWriteIn, isHeadOf, type Actor } from "../access.js";
import { ACCOUNTS, canUseAccount, chooseSendAccount, type ChannelEnv } from "../channels/accounts.js";
import { guardOf, pauseWords, recordsProblem } from "../channels/mailbox-guard.js";
import { needsPersonApproval } from "../drafts.js";
import { usableOffers } from "../offers.js";
import { resolveSearchKeys, type SearchKeyEnv } from "../search-keys.js";
import { calendarOf, loadSettings, type SalesSettings } from "../settings.js";
import { localDay, startOfLocalDay } from "../workdays.js";
import { budgetText, callBudget, callsMade, readDays } from "./days.js";
import { NO_KEY } from "./model.js";
import { stoppedClause } from "./attempts.js";

export const STATE = "sales_autopilot_state";
/** What the autopilot needs from the server's config. */
export type AutopilotEnv = SearchKeyEnv & ChannelEnv & { SALES_AUTOPILOT: "on" | "off"; NODE_ENV: string; ANTHROPIC_API_KEY?: string | undefined; SALES_AUTOPILOT_MODEL: string; SALES_FINDER: "on" | "off" };
type Step = (typeof AUTOPILOT_STEPS)[number];
type Blocker = { step?: Step; text: string };

/** The person the autopilot works as, as an actor who can write in the venture, or why not (in plain words). */
export async function runAsActor(db: AppDb, workspaceId: string, ventureId: string, userId: string | undefined): Promise<{ actor: Actor; name: string } | { problem: string; name?: string }> {
  if (!userId) return { problem: "Pick who the autopilot works as." };
  const user = await db.collection("users").findOne({ _id: userId }, { projection: { email: 1, name: 1, status: 1 } });
  const name = String(user?.name ?? "The person it works as");
  const actor = user && user.status === "active" ? await actorFor(db, { id: String(user._id), email: String(user.email ?? ""), name: String(user.name ?? "") }) : undefined;
  if (!actor || actor.membership.workspaceId !== workspaceId || !canWriteIn(actor, ventureId)) return { problem: `${name} can no longer work in this venture: a head picks who the autopilot works as.`, name };
  return { actor, name };
}

/** The steps switched on in the settings. */
export function stepsOn(settings: AutopilotSettings): Step[] {
  return AUTOPILOT_STEPS.filter((step) => step === "find" ? settings.find.enabled : step === "send" ? settings.send !== "by_hand" : settings[step]);
}
const MODEL_STEPS: readonly Step[] = ["judge", "write", "review", "followUps", "replies"];

/** The enabled mailboxes the person may send from for this venture. */
async function mailboxesOf(db: AppDb, actor: Actor, ventureId: string): Promise<AppDocument[]> {
  const rows = await db.collection(ACCOUNTS).find({ workspaceId: actor.membership.workspaceId, kind: "email", ventureIds: ventureId, enabled: { $ne: false } }).limit(50).toArray();
  return rows.filter((account) => canUseAccount(actor, account, ventureId));
}

/**
 * The venture's leads with work for the autopilot (to judge, to write to, to follow up, or a reply to sort) that `userId` does not own: the
 * autopilot skips them when it works as someone who isn't a head.
 */
export async function unownedWork(db: AppDb, workspaceId: string, ventureId: string, userId: string): Promise<number> {
  const live = { workspaceId, ventureId, deletedAt: null, doNotContact: { $ne: true }, ownerId: { $ne: userId } };
  const replied = (await db.collection("sales_activities").distinct("leadId", { workspaceId, ventureId, direction: "in", replyType: null, handledAt: null })).map(String);
  return db.collection("opportunities").countDocuments({ ...live, $or: [
    { stage: "identified", verdict: null, website: { $type: "string", $ne: "" } },
    { stage: { $in: ["approved_for_contact", "contacted"] }, "verdict.decision": "recommend" },
    { _id: { $in: replied } },
  ] });
}

/** What can't run and why: the server, the person it works as, the key, the offers, the daily search, the mailbox, the day's calls, leads they don't own. */
export async function autopilotBlockers(db: AppDb, env: AutopilotEnv, workspaceId: string, ventureId: string, settings: AutopilotSettings, day?: string): Promise<{ blockers: Blocker[]; partial: Blocker[]; runAs?: { id: string; name: string }; server: AutopilotStatus["server"] }> {
  const blockers: Blocker[] = [];
  /** Blockers that stop part of the work only (the rest runs): shown, but they don't make the state "blocked". */
  const partial: Blocker[] = [];
  const on = stepsOn(settings);
  const serverOn = env.SALES_AUTOPILOT === "on";
  const modelReady = Boolean(env.ANTHROPIC_API_KEY);
  const keys = await resolveSearchKeys(db, workspaceId, env);
  const finderReady = env.SALES_FINDER === "on" && (keys.tinyfish.length > 0 || keys.exa.length > 0);
  const who = await runAsActor(db, workspaceId, ventureId, settings.runAsUserId);
  const mailboxes = "actor" in who ? await mailboxesOf(db, who.actor, ventureId) : [];
  const mailboxReady = mailboxes.length > 0;
  if (!serverOn) blockers.push({ text: "Autopilot is switched off on this server." });
  if (settings.enabled && "problem" in who) blockers.push({ text: who.problem });
  if (!modelReady) for (const step of MODEL_STEPS.filter((item) => on.includes(item))) blockers.push({ step, text: NO_KEY });
  const offers = await usableOffers(db, workspaceId, ventureId);
  if (!offers.length) for (const step of (["judge", "write"] as const).filter((item) => on.includes(item))) blockers.push({ step, text: "The offer has no approved packet yet." });
  if (settings.find.enabled) {
    if (!settings.find.offerId) blockers.push({ step: "find", text: "Pick an offer for the daily search." });
    else if (!offers.some((offer) => offer._id === settings.find.offerId)) blockers.push({ step: "find", text: "The offer for the daily search is paused or has no approved packet yet: a head approves or activates it." });
    if (env.SALES_FINDER !== "on") blockers.push({ step: "find", text: "The lead finder is switched off on this server." });
    else if (!finderReady) blockers.push({ step: "find", text: "Company search has no key: an admin adds one in Sales settings." });
  }
  if (settings.send !== "by_hand" && "actor" in who && !mailboxReady) blockers.push({ step: "send", text: `${who.name} has no mailbox connected: connect one in Channels.` });
  // The sender protection (channels/mailbox-guard.ts) on the mailbox the queue would pick: a pause, and for automatic sending the domain's records.
  const mailbox = settings.send !== "by_hand" ? chooseSendAccount(mailboxes, ventureId) : undefined;
  if (mailbox) {
    const paused = pauseWords(mailbox, new Date());
    if (paused) partial.push({ step: "send", text: paused });
    const records = settings.send === "automatic" ? recordsProblem(mailbox, guardOf(mailbox).dns) : undefined;
    if (records) partial.push({ step: "send", text: `Automatic sending waits: ${records}.` });
  }
  if (day) {
    const cap = callBudget(settings.dailyLeadLimit);
    if (await callsMade(db, ventureId, day) >= cap) blockers.push({ text: budgetText(cap) });
  }
  // Leads the person can't edit are skipped without a call: say how many, once.
  if (settings.enabled && "actor" in who && !isHeadOf(who.actor, ventureId)) {
    const unowned = await unownedWork(db, workspaceId, ventureId, who.actor.id);
    if (unowned) partial.push({ text: `${who.name} can't work on ${unowned} ${unowned === 1 ? "lead they don't" : "leads they don't"} own: make them a head, or reassign the leads.` });
  }
  return { blockers, partial, ...("actor" in who ? { runAs: { id: who.actor.id, name: who.name } } : {}), server: { on: serverOn, modelReady, finderReady, mailboxReady } };
}

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" ? value : undefined;

/** What waits in the venture: leads to judge and to write for, drafts in review, to approve, ready to send and queued. */
async function waiting(db: AppDb, workspaceId: string, ventureId: string, settings: SalesSettings): Promise<AutopilotStatus["waiting"]> {
  const leads = db.collection("opportunities");
  const open = { workspaceId, ventureId, deletedAt: null, doNotContact: { $ne: true }, needsYou: { $ne: true } };
  const [toJudge, writeIds, drafts] = await Promise.all([
    leads.countDocuments({ ...open, stage: "identified", verdict: null, website: { $type: "string", $ne: "" } }),
    leads.find({ ...open, stage: "approved_for_contact", "verdict.decision": "recommend", "verdict.overridden": { $ne: true }, "verdict.via": { $ne: "app" }, "contactRoutes.kind": "email" }, { projection: { _id: 1 } }).limit(2_000).toArray(),
    db.collection("sales_drafts").find({ workspaceId, ventureId, status: { $in: ["in_review", "ready"] } }, { projection: { status: 1, channel: 1, playId: 1, personApproval: 1, sendQueue: 1, purpose: 1, authorVia: 1 } }).limit(2_000).toArray(),
  ]);
  const written = new Set((await db.collection("sales_drafts").distinct("leadId", { workspaceId, leadId: { $in: writeIds.map((row) => row._id) }, purpose: "first_touch", status: { $in: ["draft", "in_review", "ready", "needs_changes", "sent"] } })).map(String));
  const playIds = [...new Set(drafts.map((draft) => draft.playId).filter((id): id is string => typeof id === "string"))];
  const plays = new Map(playIds.length ? (await db.collection("sales_plays").find({ _id: { $in: playIds }, workspaceId }).toArray()).map((play) => [String(play._id), play]) : []);
  const ready = drafts.filter((draft) => draft.status === "ready");
  const queued = ready.filter((draft) => draft.sendQueue);
  const free = ready.filter((draft) => !draft.sendQueue && draft.channel !== "call_opener");
  const approve = (draft: AppDocument) => needsPersonApproval(draft, plays.get(String(draft.playId)), settings);
  const next = queued.map((draft) => new Date(draft.sendQueue.notBefore).getTime()).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return {
    toJudge, toWrite: writeIds.filter((row) => !written.has(String(row._id))).length, inReview: drafts.filter((draft) => draft.status === "in_review").length,
    toApprove: free.filter(approve).length, readyToSend: free.filter((draft) => !approve(draft)).length, queued: queued.length,
    ...(next !== undefined ? { nextSendAt: new Date(next).toISOString() } : {}),
  };
}

/**
 * What the autopilot gave up on (at AUTOPILOT_MAX_TRIES, unchanged since): drafts waiting for review, leads to judge, leads to write to
 * (first message or follow-up), replies to sort. Drafts sent back that reached their fix limit aren't counted: they show under Fix.
 */
async function stuck(db: AppDb, workspaceId: string, ventureId: string): Promise<AutopilotStatus["stuck"]> {
  const open = { workspaceId, ventureId, deletedAt: null, doNotContact: { $ne: true }, needsYou: { $ne: true } };
  const [review, judge, write, replies] = await Promise.all([
    db.collection("sales_drafts").countDocuments({ workspaceId, ventureId, status: "in_review", ...stoppedClause }),
    db.collection("opportunities").countDocuments({ ...open, stage: "identified", verdict: null, "autopilot.step": "judge", ...stoppedClause }),
    db.collection("opportunities").countDocuments({ ...open, stage: { $in: ["approved_for_contact", "contacted"] }, "autopilot.step": { $in: ["first_touch", "follow_up"] }, ...stoppedClause }),
    db.collection("sales_activities").countDocuments({ workspaceId, ventureId, direction: "in", replyType: null, handledAt: null, ...stoppedClause }),
  ]);
  return { judge, write, review, replies };
}

/** The whole status for one viewer (`canChange`: a head of the venture or an admin). */
export async function buildStatus(db: AppDb, env: AutopilotEnv, viewer: Actor, ventureId: string, now = new Date()): Promise<AutopilotStatus> {
  const workspaceId = viewer.membership.workspaceId;
  const settings = await loadSettings(db, workspaceId, ventureId);
  const autopilot = settings.autopilot;
  const day = localDay(now, calendarOf(settings));
  const [checked, state, days, wait, gaveUp] = await Promise.all([
    autopilotBlockers(db, env, workspaceId, ventureId, autopilot, day),
    db.collection(STATE).findOne({ _id: ventureId, workspaceId }),
    readDays(db, workspaceId, ventureId, day),
    waiting(db, workspaceId, ventureId, settings),
    stuck(db, workspaceId, ventureId),
  ]);
  // Found today: what the autopilot's own find runs added since the venture's local midnight (the finder counts them, not the autopilot).
  const runs = await db.collection("sales_find_runs").find({ workspaceId, ventureId, autopilot: true, createdAt: { $gte: startOfLocalDay(now, settings.timezone) } }, { projection: { results: 1, progress: 1 } }).toArray();
  const found = runs.reduce((sum, run) => sum + Number(run.results?.added ?? run.progress?.added ?? 0), 0);
  const on = stepsOn(autopilot);
  const stepless = checked.blockers.some((blocker) => !blocker.step);
  const everyStepBlocked = on.length > 0 && on.every((step) => checked.blockers.some((blocker) => blocker.step === step));
  const leaseUntil = state?.leaseUntil instanceof Date ? state.leaseUntil : undefined;
  const stateName = !autopilot.enabled ? "off" : leaseUntil && leaseUntil > now ? "working" : stepless || everyStepBlocked || !on.length ? "blocked" : "idle";
  if (autopilot.enabled && !on.length) checked.blockers.push({ text: "Every step is switched off: switch on the steps it should do." });
  return autopilotStatusSchema.parse({
    ventureId, settings: autopilot, canChange: isHeadOf(viewer, ventureId), ...(checked.runAs ? { runAs: checked.runAs } : {}), server: checked.server, state: stateName, blockers: [...checked.blockers, ...checked.partial],
    ...(iso(state?.lastRunAt) ? { lastRunAt: iso(state?.lastRunAt) } : {}), ...(typeof state?.lastError === "string" ? { lastError: state.lastError } : {}),
    today: { ...days.today, found: Math.max(days.today.found, found) }, ...(days.previous ? { previous: days.previous } : {}), waiting: wait, stuck: gaveUp,
  });
}
