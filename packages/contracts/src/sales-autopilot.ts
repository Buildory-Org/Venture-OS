import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// Sales autopilot (docs/sales-autopilot.md): the app does the steps a person used to carry to a Claude chat. Per venture, off until a head
// switches it on. Claude on the server judges leads, writes first messages and the one follow-up, reviews every draft in a separate call
// and sorts replies; a person approves, and the app sends what was approved (the send queue), spaced and inside the daily caps.
// This file depends only on common.ts: sales.ts imports it for the settings and the draft.

/**
 * How messages that passed review go out.
 * - "by_hand": a person sends each one (Send, or Mark sent), as before.
 * - "after_approval": a person approves a batch; the app sends the approved emails through that person's mailbox, spaced, inside the caps.
 * - "automatic": as "after_approval", and once a play's first batch was approved by a head, emails that pass review are queued without a tap.
 */
export const AUTOPILOT_SEND_MODES = ["by_hand", "after_approval", "automatic"] as const;
export type AutopilotSendMode = (typeof AUTOPILOT_SEND_MODES)[number];

/** The standing find rule: each working day, look for up to `perDay` new companies for one offer. */
export const autopilotFindSchema = z.object({
  enabled: z.boolean().default(false),
  /** The offer to search for (its approved packet gives the searches). Without one the rule waits. */
  offerId: idSchema.optional(),
  /** The request in the person's words, e.g. "hardware dealers in Raipur". */
  request: z.string().trim().max(500).default(""),
  places: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  perDay: z.number().int().min(1).max(50).default(10),
});

export const autopilotSettingsSchema = z.object({
  /** The venture's switch. Off: no step below runs (a person can still queue approved emails to send). */
  enabled: z.boolean().default(false),
  /** The person the autopilot works as: new leads are theirs and automatic emails go from their mailbox. Set when it is switched on. */
  runAsUserId: idSchema.optional(),
  find: autopilotFindSchema.prefault({}),
  /** The steps Claude does on the server. */
  judge: z.boolean().default(true),
  write: z.boolean().default(true),
  review: z.boolean().default(true),
  followUps: z.boolean().default(true),
  replies: z.boolean().default(true),
  send: z.enum(AUTOPILOT_SEND_MODES).default("by_hand"),
  /** Leads Claude works on in a day (judging and writing): the spend cap. */
  dailyLeadLimit: z.number().int().min(1).max(200).default(25),
});
export type AutopilotSettings = z.infer<typeof autopilotSettingsSchema>;
export type AutopilotSettingsInput = z.input<typeof autopilotSettingsSchema>;

/**
 * A ready draft waiting in the send queue. `by` is the person whose mailbox it goes from and who is recorded as the sender: the one who
 * tapped "Approve and send", or under the "automatic" mode the person the autopilot works as (`auto`). `version` is the draft's `updatedAt`
 * when it was queued: a draft that changed since is taken out of the queue, never sent. `notBefore` spaces the sends.
 */
export const draftSendQueueSchema = z.object({
  at: isoDateSchema, by: idSchema, auto: z.boolean().optional(), accountId: idSchema.optional(), version: isoDateSchema, notBefore: isoDateSchema,
  attempts: z.number().int().nonnegative().default(0), lastError: z.string().max(300).optional(),
});
export type DraftSendQueue = z.infer<typeof draftSendQueueSchema>;

// ---- Approving and queueing several drafts at once (POST /v1/sales/drafts/batch): a person only, never Claude.
/**
 * - "approve": a person's approval on each draft that waits for one (the same rules as approving one).
 * - "approve_and_send": approve where needed, then queue each email the person can send through their mailbox.
 * - "send": queue only (drafts that need no approval, or already have it).
 * - "unqueue": take drafts back out of the send queue.
 * Each draft answers on its own: one that can't be done is skipped with the reason in plain words.
 */
export const DRAFT_BATCH_ACTIONS = ["approve", "approve_and_send", "send", "unqueue"] as const;
export const draftBatchInputSchema = z.object({
  action: z.enum(DRAFT_BATCH_ACTIONS),
  /** `expectedUpdatedAt`: the version the person read; a draft that changed since is skipped. */
  drafts: z.array(z.object({ id: idSchema, expectedUpdatedAt: isoDateSchema.optional() })).min(1).max(50),
  /** The mailbox to send from (the person's default for the venture when left out). */
  accountId: idSchema.optional(),
});
export const DRAFT_BATCH_OUTCOMES = ["approved", "queued", "approved_and_queued", "unqueued", "skipped"] as const;
export const draftBatchResultSchema = z.object({
  results: z.array(z.object({ id: idSchema, outcome: z.enum(DRAFT_BATCH_OUTCOMES), reason: z.string().optional(), notBefore: isoDateSchema.optional() })),
  approved: z.number().int().nonnegative(), queued: z.number().int().nonnegative(), unqueued: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  /** When the first and the last queued message are due to go. */
  firstSendAt: isoDateSchema.optional(), lastSendAt: isoDateSchema.optional(),
});
export type DraftBatchInput = z.input<typeof draftBatchInputSchema>;
export type DraftBatchResult = z.infer<typeof draftBatchResultSchema>;

// ---- What the autopilot keeps on each lead, draft and reply it works on.
/** After this many failed tries on one item the autopilot stops and the item waits for a person. */
export const AUTOPILOT_MAX_TRIES = 3;
/**
 * `autopilot` on a lead, a draft or a reply (an inbound activity): how often the autopilot tried its step on it, when, and the short code
 * of why the last try failed. At AUTOPILOT_MAX_TRIES it has stopped: screens say so and offer the Claude chat again for that item.
 */
export const autopilotItemSchema = z.object({
  attempts: z.number().int().nonnegative().default(0), step: z.string().nullish(), at: isoDateSchema.nullish(), nextTryAt: isoDateSchema.nullish(), lastError: z.string().max(300).nullish(),
});
export type AutopilotItem = z.infer<typeof autopilotItemSchema>;
/** Whether the autopilot gave up on this item (it reached its last try). */
export const autopilotStopped = (item: { autopilot?: { attempts?: number | undefined } | null | undefined } | null | undefined): boolean => (item?.autopilot?.attempts ?? 0) >= AUTOPILOT_MAX_TRIES;

// ---- What the autopilot did, per venture and local day (collection `sales_autopilot_days`).
const count = z.number().int().nonnegative().default(0);
export const autopilotDaySchema = z.object({
  /** YYYY-MM-DD in the venture's time zone. */
  day: z.string(),
  found: count, judged: count, recommended: count, held: count, rejected: count,
  written: count, passed: count, needChanges: count, queued: count, sent: count,
  followUps: count, repliesSorted: count, replyDrafts: count,
  /** What it cost: calls to Claude and the tokens they used. */
  modelCalls: count, inputTokens: count, outputTokens: count,
});
export type AutopilotDay = z.infer<typeof autopilotDaySchema>;

export const AUTOPILOT_STEPS = ["find", "judge", "write", "review", "send", "followUps", "replies"] as const;
/** off: switched off for the venture. blocked: on, but nothing can run (see `blockers`). idle: on and waiting for work. working: a pass is running. */
export const AUTOPILOT_STATES = ["off", "blocked", "idle", "working"] as const;
/** GET /v1/sales/autopilot?ventureId=: the settings, whether the server can run each step, what it did and what waits. */
export const autopilotStatusSchema = z.object({
  ventureId: idSchema,
  settings: autopilotSettingsSchema,
  /** The viewer may change the settings (a venture head or an admin). */
  canChange: z.boolean(),
  runAs: z.object({ id: idSchema, name: z.string() }).optional(),
  server: z.object({
    /** The autopilot loop and the send queue run on this server (SALES_AUTOPILOT). */
    on: z.boolean(),
    /** A key for Claude is set on the server. */
    modelReady: z.boolean(),
    /** The built-in lead finder is on and has a search key. */
    finderReady: z.boolean(),
    /** The person it works as has a connected mailbox for this venture. */
    mailboxReady: z.boolean(),
  }),
  state: z.enum(AUTOPILOT_STATES),
  /** Why a step can't run, in plain words, with what fixes it. `step` absent: nothing runs. */
  blockers: z.array(z.object({ step: z.enum(AUTOPILOT_STEPS).optional(), text: z.string() })),
  lastRunAt: isoDateSchema.optional(),
  lastError: z.string().optional(),
  today: autopilotDaySchema,
  /** The latest earlier day it did anything, for "since you last looked". */
  previous: autopilotDaySchema.optional(),
  waiting: z.object({
    toJudge: count, toWrite: count, inReview: count, toApprove: count, readyToSend: count, queued: count,
    nextSendAt: isoDateSchema.optional(),
  }),
  /** Items the autopilot gave up on after AUTOPILOT_MAX_TRIES, by step: they wait for a person (or a Claude chat). */
  stuck: z.object({ judge: count, write: count, review: count, replies: count }).prefault({}),
});
export type AutopilotStatus = z.infer<typeof autopilotStatusSchema>;
/** POST /v1/sales/autopilot/run?ventureId=: asks for a pass now (a head or an admin). */
export const autopilotRunResultSchema = z.object({ started: z.boolean(), reason: z.string().optional() });
