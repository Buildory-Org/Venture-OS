import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { draftDeliveryReconcileSchema, draftInputSchema, draftReviewInputSchema, draftSendInputSchema, draftSendThroughInputSchema, draftUpdateSchema, draftVetoInputSchema, idSchema } from "@venture-studio/contracts";
import { atomic, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { forbidClaude, forbidden, isHeadOf, notFound, requireHead, requireWriter } from "../sales/access.js";
import { canUseAccount, loadAccount, type ChannelEnv } from "../sales/channels/accounts.js";
import { flipStaleSend, lockedMessage, sendDraftThrough, sendTargetsFor, settleDelivery, shownSendState } from "../sales/channels/dispatch.js";
import { auditSales, salesCtx, settingsFor, type SalesCtx } from "../sales/ctx.js";
import { OWN_REPLY_KINDS, approvalNeed, changedSince, channelOf, draftChanged, expectedVersion, isOpenDraft, isOwnReply, needsPersonApproval, reviewOutcome, sendBlocker, startsAsOwnReply } from "../sales/drafts.js";
import { notifyApprovalNeeded } from "../sales/notify.js";
import { startOfLocalDay } from "../sales/workdays.js";
import { applyActivity, claimSendSlot, closeOtherVersions, defined, isCappedChannel, loadLead, markHandled, payloadHash, requireLeadEditor, versionBlocker } from "../sales/leads.js";
import { leadJson, present } from "../sales/present.js";
import { getDraftWithLead, listDrafts, versionsOf } from "../sales/queries.js";

const draftsQuerySchema = z.object({ ventureId: idSchema.optional(), status: z.string().max(200).optional(), owner: z.union([z.literal("me"), idSchema]).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
const ok = (data: unknown) => ({ ok: true, data });
/** A draft that is being sent through an account (or whose send is unclear) can't be edited, vetoed, discarded or marked sent meanwhile. */
const SENDING = "This draft is being sent through a connected account: wait for it, or say whether an unclear send went out";
/** The refusal for a locked draft: a send nobody finished (its lock older than two minutes) turns uncertain first and asks for an answer. */
async function refuseLocked(database: Database, draft: AppDocument): Promise<never> {
  throw new AppError(409, "CONFLICT", lockedMessage(await flipStaleSend(database.db, draft), SENDING));
}
/** Which kind of account a draft's channel goes out through (a mailbox for email, a LinkedIn profile for LinkedIn, the venture's number or account otherwise). */
const ACCOUNT_KIND: Record<string, string> = { email: "email", linkedin: "linkedin", whatsapp: "whatsapp", instagram: "instagram" };

async function loadDraft(database: Database, ctx: SalesCtx, id: string, session?: import("mongodb").ClientSession) {
  const draft = await database.db.collection("sales_drafts").findOne({ _id: id, workspaceId: ctx.workspaceId }, { session });
  if (!draft) throw notFound("Draft");
  return { draft, lead: await loadLead(ctx, String(draft.leadId), session) };
}
/**
 * The draft as the API returns it: with whether it waits for a person's approval, and why (the same rule the send route applies), its other
 * versions and where a send through an account would go (`sendTarget`). A send still "sending" two minutes after it started reads as uncertain.
 */
async function shownDraft(database: Database, ctx: SalesCtx, draft: AppDocument) {
  const play = typeof draft.playId === "string" ? await database.db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }) : null;
  const lead = await database.db.collection("opportunities").findOne({ _id: String(draft.leadId), workspaceId: ctx.workspaceId });
  const target = lead ? (await sendTargetsFor(ctx, [{ draft, lead }]))(draft) : {};
  return shownSendState({ ...present(draft), ...approvalNeed(draft, play, await settingsFor(ctx, String(draft.ventureId))), ...(await versionsOf(ctx, [draft]))(draft), ...target });
}

/** Drafts: written (usually by Claude), reviewed in a separate pass, approved for a play's first batch by a head, sent by a person. */
export function salesDraftRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  const shown = (ctx: SalesCtx, draft: AppDocument) => shownDraft(database, ctx, draft);
  const reload = async (ctx: SalesCtx, id: unknown) => shown(ctx, (await db.collection("sales_drafts").findOne({ _id: String(id) }))!);

  /**
   * How many of a play's drafts a venture head or admin approved: only those count toward its first batch. Approvals stored before
   * `byHead` existed count when the approver heads the play's venture or is an admin. A head's own reply is not a read of the batch.
   */
  async function headApprovals(ctx: SalesCtx, play: AppDocument, session?: import("mongodb").ClientSession): Promise<number> {
    const rows = await db.collection("sales_drafts").find({ workspaceId: ctx.workspaceId, playId: String(play._id), personApproval: { $type: "object" }, "personApproval.own": { $ne: true } }, { session, projection: { personApproval: 1 } }).toArray();
    const legacy = [...new Set(rows.filter((row) => row.personApproval.byHead === undefined).map((row) => String(row.personApproval.by)))];
    const heads = new Set(legacy.length ? (await db.collection("memberships").find({ workspaceId: ctx.workspaceId, userId: { $in: legacy }, status: "active", $or: [{ role: "admin" }, { role: "venture_head", ventureIds: play.ventureId }] }, { session, projection: { userId: 1 } }).toArray()).map((row) => String(row.userId)) : []);
    return rows.filter((row) => row.personApproval.byHead === true || (row.personApproval.byHead === undefined && heads.has(String(row.personApproval.by)))).length;
  }

  router.get("/drafts", async (req, res) => {
    res.json(ok((await listDrafts(salesCtx(database, req), draftsQuerySchema.parse(req.query))).map((row) => shownSendState(row))));
  });

  // One draft, shaped like a list row (lead summary, whether it waits for a person's approval): anyone who can open the lead's venture.
  router.get("/drafts/:id", async (req, res) => {
    res.json(ok(shownSendState(await getDraftWithLead(salesCtx(database, req), idSchema.parse(req.params.id)))));
  });

  router.post("/leads/:id/drafts", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "write drafts for this lead");
    const input = draftInputSchema.parse(req.body);
    if (lead.doNotContact) throw new AppError(409, "CONFLICT", "This lead is on the do-not-contact list: no drafts can be written for it");
    const settings = await settingsFor(ctx, String(lead.ventureId));
    if (!settings.allowedChannels.includes(channelOf(input) as never)) throw new AppError(409, "CONFLICT", `This venture does not use ${channelOf(input)} for outreach (see its sales settings)`);
    // A lead that belongs to a play brings its drafts into that play (and its first-batch approval).
    const playId = input.playId ?? (typeof lead.playId === "string" ? lead.playId : undefined);
    if (playId && !await db.collection("sales_plays").findOne({ _id: playId, workspaceId: ctx.workspaceId, ventureId: lead.ventureId }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "That play does not belong to this lead's venture");
    const answers = input.inReplyTo ? await db.collection("sales_activities").findOne({ _id: input.inReplyTo, workspaceId: ctx.workspaceId, leadId: String(lead._id) }, { projection: { direction: 1, kind: 1, handledAt: 1 } }) : null;
    if (input.inReplyTo && !answers) throw new AppError(400, "BAD_REQUEST", "inReplyTo must be an activity on this lead");
    const now = new Date();
    // A reply a person writes here, answering a message from them, is ready at once, approved by them (warm replies are due within hours,
    // and Claude's review is a separate chat). `checkByClaude` sends it to that review instead. Claude's replies, and every other draft, go
    // through review as before. "A message from them" is a message the lead sent (email, WhatsApp, Instagram or LinkedIn) or their call,
    // still waiting in the Inbox or their latest one: an answer to anything else (our own message, a meeting note, an older message already
    // answered) is reviewed as usual.
    const answersInbound = async () => {
      if (!answers || answers.direction !== "in" || !(OWN_REPLY_KINDS as readonly unknown[]).includes(answers.kind)) return false;
      if (!answers.handledAt) return true;
      const latest = await db.collection("sales_activities").find({ workspaceId: ctx.workspaceId, leadId: String(lead._id), direction: "in" }, { projection: { _id: 1 } }).sort({ at: -1, _id: -1 }).limit(1).next();
      return latest?._id === answers._id;
    };
    const own = startsAsOwnReply(input, ctx.via, true) && await answersInbound();
    const draft = defined({
      _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, playId, inReplyTo: input.inReplyTo, channel: input.channel, purpose: input.purpose, subject: input.subject, body: input.body,
      status: own ? "ready" : input.submit ? "in_review" : "draft", authorId: ctx.actor.id, authorVia: ctx.via, authorSessionId: input.sessionId, createdAt: now, updatedAt: now,
      personApproval: own ? { by: ctx.actor.id, at: now, byHead: isHeadOf(ctx.actor, lead.ventureId), own: true } : undefined,
    });
    await atomic(database, async (session) => {
      await db.collection("sales_drafts").insertOne(draft, { session });
      await auditSales(ctx, "sales.draft.create", "draft", draft._id, String(lead.ventureId), { channel: input.channel, purpose: input.purpose, status: draft.status, ...(own ? { ownReply: true } : {}) }, session);
    });
    res.status(201).json(ok(await shown(ctx, draft)));
  });

  // Editing the text sends the draft back to review and clears the review and any approval. A person's own ready reply stays ready when a
  // person edits it in the app: the editor (the lead's owner, a head or an admin) approves the new text. Claude's edit sends it to review.
  router.patch("/drafts/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "edit this draft");
    if (!isOpenDraft(draft)) throw new AppError(409, "CONFLICT", `A ${draft.status} draft can no longer be edited`);
    if (draft.sendLock) await refuseLocked(database, draft);
    const input = draftUpdateSchema.parse(req.body);
    const now = new Date();
    const keepsReady = ctx.via === "app" && draft.status === "ready" && isOwnReply(draft);
    const text = { ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(input.body !== undefined ? { body: input.body } : {}) };
    await atomic(database, async (session) => {
      const changed = keepsReady
        ? await db.collection("sales_drafts").updateOne({ _id: draft._id, status: "ready", purpose: "reply", authorVia: "app", "personApproval.own": true, sendLock: null }, {
          $set: { ...text, authorId: ctx.actor.id, authorVia: ctx.via, personApproval: { by: ctx.actor.id, at: now, byHead: isHeadOf(ctx.actor, lead.ventureId), own: true }, updatedAt: now },
          $unset: { review: "", authorSessionId: "" },
        }, { session })
        : await db.collection("sales_drafts").updateOne({ _id: draft._id, status: { $in: ["draft", "in_review", "ready", "needs_changes"] }, sendLock: null }, {
          $set: { ...text, status: "in_review", authorId: ctx.actor.id, authorVia: ctx.via, updatedAt: now, ...(input.sessionId ? { authorSessionId: input.sessionId } : {}) },
          $unset: { review: "", personApproval: "", ...(input.sessionId ? {} : { authorSessionId: "" }) },
        }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      await auditSales(ctx, "sales.draft.update", "draft", String(draft._id), String(lead.ventureId), keepsReady ? { ownReply: true } : undefined, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  // Review pass: pass -> ready, fail -> needs_changes. Claude's review of a Claude draft must come from a different session.
  router.post("/drafts/:id/review", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    requireWriter(ctx.actor, lead.ventureId, "review drafts");
    const input = draftReviewInputSchema.parse(req.body);
    const status = reviewOutcome(draft, input, ctx.via);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: "in_review" }, { $set: { status, review: defined({ result: input.result, issues: input.issues, notes: input.notes, sessionId: input.sessionId, by: ctx.actor.id, via: ctx.via, at: now }), updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed while it was being reviewed: reload it and try again");
      // Ready, but a person has to approve it before it can be sent: the venture's heads and admins are told once per draft.
      if (status === "ready") {
        const play = draft.playId ? await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }, { session }) : null;
        if (needsPersonApproval({ ...draft, status: "ready" }, play, await settingsFor(ctx, String(lead.ventureId)))) await notifyApprovalNeeded(ctx, lead, draft, now, session);
      }
      await auditSales(ctx, "sales.draft.review", "draft", String(draft._id), String(lead.ventureId), { result: input.result, status }, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  // A person reads a play's first batch in full: head or admin, in the app only. Enough head approvals mark the batch as reviewed.
  router.post("/drafts/:id/approve", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    forbidClaude(ctx.via, "Approving a draft");
    // First-batch approval is for a head or admin; where every message needs a person, the lead's owner may approve their own messages too
    // (to send them), but only a head's or admin's approval counts toward a play's first batch.
    if ((await settingsFor(ctx, String(lead.ventureId))).approvalMode === "person_approves_every_message") requireLeadEditor(ctx, lead, "approve a message");
    else requireHead(ctx.actor, lead.ventureId, "approve a draft");
    if (draft.status !== "ready") throw new AppError(409, "CONFLICT", "Only a draft that passed review (ready) can be approved");
    // Not while it is being sent (or its send is unclear): the send was started on the version without this approval.
    if (draft.sendLock) await refuseLocked(database, draft);
    // A person's own reply is approved by its author: a second approval would only turn it into a read of a play's first batch.
    if (isOwnReply(draft)) throw new AppError(409, "CONFLICT", "A person's own reply is already approved by its author");
    const byHead = isHeadOf(ctx.actor, lead.ventureId);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: "ready", sendLock: null, "personApproval.own": { $ne: true } }, { $set: { personApproval: { by: ctx.actor.id, at: now, byHead }, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      if (draft.playId && byHead) {
        const play = await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }, { session });
        if (play && !play.firstBatchReviewed && await headApprovals(ctx, play, session) >= Number(play.batchSize ?? 10)) await db.collection("sales_plays").updateOne({ _id: play._id }, { $set: { firstBatchReviewed: true, updatedAt: now } }, { session });
      }
      await auditSales(ctx, "sales.draft.approve", "draft", String(draft._id), String(lead.ventureId), { byHead }, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  // Mark sent records what a person sent by hand: from their own mail app, phone, WhatsApp, Instagram or LinkedIn. Sending through a connected
  // account is POST /drafts/:id/send. `accountId` optionally names the mailbox, LinkedIn profile or venture account it went from.
  router.post("/drafts/:id/sent", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "mark this draft sent");
    const input = draftSendInputSchema.parse(req.body ?? {}); // sentVia defaults to manual, so a bare POST is a manual send
    if (input.sentVia !== "manual") throw new AppError(400, "BAD_REQUEST", "Mark sent is for a message you sent yourself (sentVia manual): to send it through a connected account, use Send (POST /v1/sales/drafts/:id/send)");
    // The account it went from: one the person can see and send through for this venture, of the draft's channel.
    if (input.accountId) {
      const account = await loadAccount(ctx, input.accountId);
      const kind = ACCOUNT_KIND[String(draft.channel)];
      if (!kind || account.kind !== kind) throw new AppError(400, "BAD_REQUEST", `That account is ${String(account.kind)}: a ${String(draft.channel).replace("_", " ")} message goes out through ${kind ? `a ${kind} account` : "no account"}`);
      if (!canUseAccount(ctx.actor, account, String(lead.ventureId))) throw new AppError(400, "BAD_REQUEST", account.enabled === false ? "That account is switched off" : "You can't send through that account for this venture");
    }
    const sentHash = payloadHash({ draftId: String(draft._id), sentVia: input.sentVia });
    const result = async () => {
      const activity = await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, draftId: String(draft._id), direction: "out" });
      return { draft: await reload(ctx, draft._id), activity: present(activity!), lead: leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!) };
    };
    // The same requestId repeats the first answer (a different draft or content under the same id is refused).
    const replay = async () => {
      if (!input.requestId) return false;
      const prior = await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, leadId: String(lead._id), requestId: input.requestId });
      if (!prior) return false;
      if (prior.draftId !== String(draft._id) || (prior.payloadHash && prior.payloadHash !== sentHash)) throw new AppError(409, "CONFLICT", "That requestId was already used for something else: use a new requestId");
      res.json(ok(await result()));
      return true;
    };
    if (draft.status === "sent" && await replay()) return;
    if (draft.sendLock) await refuseLocked(database, draft);
    // The person marks sent the version they read: a draft edited, reviewed or approved since they opened it is read again first (checked
    // again, atomically, in the claim below).
    if (draft.status !== "sent" && changedSince(draft, input.expectedUpdatedAt)) throw draftChanged();
    const play = draft.playId ? await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }) : null;
    const settings = await settingsFor(ctx, String(lead.ventureId));
    const blocker = sendBlocker(draft, lead, play, settings);
    if (blocker) throw new AppError(409, "CONFLICT", blocker);
    const now = new Date();
    const channel = channelOf(draft);
    const at = input.at ? new Date(input.at) : now;
    let activity: AppDocument;
    let release: (() => Promise<void>) | undefined;
    try {
      activity = await atomic(database, async (session) => {
        // A retried transaction gives back the send it took on the first try.
        await release?.();
        release = undefined;
        // Claim the draft first: only one request moves it from ready to sent, so a repeated or parallel call never writes a second activity.
        // With `expectedUpdatedAt` it is claimed only while it is still the version the person read.
        const claimed = await db.collection("sales_drafts").findOneAndUpdate({ _id: draft._id, status: "ready", sendLock: null, ...expectedVersion(input.expectedUpdatedAt) }, { $set: { status: "sent", sentAt: at, sentBy: ctx.actor.id, sentVia: "manual", ...(input.accountId ? { sentAccountId: input.accountId } : {}), updatedAt: now } }, { session, returnDocument: "before" });
        if (!claimed) {
          const current = input.expectedUpdatedAt ? await db.collection("sales_drafts").findOne({ _id: draft._id }, { session }) : null;
          if (current && current.status !== "sent" && !current.sendLock && changedSince(current, input.expectedUpdatedAt)) throw draftChanged();
          throw new AppError(409, "CONFLICT", "This draft was already marked sent, or changed: reload it");
        }
        try {
          // Then one of the day's sends (the venture's daily cap per person and channel, counted per local day in one atomic update):
          // refused when the cap is used up, and given back below if marking it sent fails. A message marked sent for an earlier day
          // (`at`) is not one of today's sends.
          if (isCappedChannel(channel) && at.getTime() >= startOfLocalDay(now, settings.timezone).getTime()) release = await claimSendSlot(ctx, String(lead.ventureId), channel, now);
          const fresh = await loadLead(ctx, String(lead._id), session);
          const nowBlocked = sendBlocker(claimed, fresh, play, settings) ?? await versionBlocker(ctx, claimed, session, true);
          if (nowBlocked) throw new AppError(409, "CONFLICT", nowBlocked);
          // The text as claimed (a person's own reply can be edited and stay ready, so the copy read at the start may be older).
          const subject = claimed.subject ? `Subject: ${claimed.subject}\n\n` : "";
          const logged = await applyActivity(ctx, fresh, { kind: draft.channel as "email" | "whatsapp" | "linkedin" | "instagram", direction: "out", body: `${subject}${claimed.body}`.slice(0, 10_000), at: at.toISOString(), draftId: String(draft._id), ...(input.requestId ? { requestId: input.requestId } : {}) }, now, session, ctx.via, { payloadHash: sentHash, sendClaimed: true, ...(input.accountId ? { message: { accountId: input.accountId } } : {}) });
          // Answering a reply clears it from the Inbox.
          if (draft.inReplyTo) {
            const replied = await db.collection("sales_activities").findOne({ _id: String(draft.inReplyTo), workspaceId: ctx.workspaceId }, { session });
            if (replied && !replied.handledAt) await markHandled(ctx, await loadLead(ctx, String(lead._id), session), replied, now, session);
          }
          // One version goes out: the lead's other open versions of this message close with it.
          const closed = await closeOtherVersions(ctx, claimed, String(draft.channel), now, session);
          await auditSales(ctx, "sales.draft.sent", "draft", String(draft._id), String(lead.ventureId), { channel: String(draft.channel), sentVia: "manual", ...(input.accountId ? { account: true } : {}), ...(logged.stageTo ? { stageTo: logged.stageTo } : {}), ...(closed.length ? { closedVersions: closed.length } : {}) }, session);
          return logged.activity;
        } catch (error) {
          // Without transactions (local development) the claim is already stored: give the draft back as it was (its `updatedAt` too, so the
          // version the person read can still be sent) so it can be sent again.
          if (!session) await db.collection("sales_drafts").updateOne({ _id: draft._id, status: "sent", sentBy: ctx.actor.id, sentAt: at }, { $set: { status: "ready", updatedAt: claimed.updatedAt }, $unset: { sentAt: "", sentBy: "", sentVia: "", sentAccountId: "" } }).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      // Nothing was marked sent: the day's send goes back to the counter.
      await release?.();
      // A parallel call with the same requestId that lost the claim gets the first call's answer.
      if (input.requestId && ((error as { code?: number }).code === 11000 || (error instanceof AppError && error.status === 409)) && await replay()) return;
      throw error;
    }
    res.status(201).json(ok({ draft: await reload(ctx, draft._id), activity: present(activity), lead: leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!) }));
  });

  router.post("/drafts/:id/veto", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    requireWriter(ctx.actor, lead.ventureId, "veto drafts");
    const input = draftVetoInputSchema.parse(req.body);
    if (!isOpenDraft(draft)) throw new AppError(409, "CONFLICT", `A ${draft.status} draft can no longer be vetoed`);
    if (draft.sendLock) await refuseLocked(database, draft);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: { $in: ["draft", "in_review", "ready", "needs_changes"] }, sendLock: null }, { $set: { status: "vetoed", veto: { reason: input.reason, by: ctx.actor.id, at: now }, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      await auditSales(ctx, "sales.draft.veto", "draft", String(draft._id), String(lead.ventureId), undefined, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  router.post("/drafts/:id/discard", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    requireWriter(ctx.actor, lead.ventureId, "discard drafts");
    if (!isHeadOf(ctx.actor, lead.ventureId) && lead.ownerId !== ctx.actor.id && draft.authorId !== ctx.actor.id) throw forbidden("Only the lead's owner, the draft's author or a venture head can discard this draft");
    if (!isOpenDraft(draft)) throw new AppError(409, "CONFLICT", `A ${draft.status} draft can no longer be discarded`);
    if (draft.sendLock) await refuseLocked(database, draft);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: { $in: ["draft", "in_review", "ready", "needs_changes"] }, sendLock: null }, { $set: { status: "discarded", discardedAt: now, discardedBy: ctx.actor.id, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      await auditSales(ctx, "sales.draft.discard", "draft", String(draft._id), String(lead.ventureId), undefined, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  return router;
}

/**
 * Sending a ready draft through a connected account (docs/sales-channels.md section 2), and settling a send whose result was unclear. Mounted
 * with the channel routes (they need the server secret that opens the accounts' passwords and tokens). In the app only: Claude is refused.
 */
export function salesDraftSendRoutes(database: Database, env: ChannelEnv): Router {
  const db = database.db;
  const router = Router();
  const reload = async (ctx: SalesCtx, id: unknown) => shownDraft(database, ctx, (await db.collection("sales_drafts").findOne({ _id: String(id) }))!);

  // 201 { draft, activity, lead, to } when it went out; 202 { draft, to } when the result is unclear (a person checks and answers /delivery); 502
  // SEND_FAILED when it didn't go (the draft stays ready). The same requestId repeats the first answer.
  router.post("/drafts/:id/send", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Sending a message");
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    const input = draftSendThroughInputSchema.parse(req.body ?? {});
    const result = await sendDraftThrough(ctx, env, draft, lead, { accountId: input.accountId, template: input.template ? { ...input.template, variables: input.template.variables ?? [] } : undefined, requestId: input.requestId, expectedUpdatedAt: input.expectedUpdatedAt });
    // `to`: where it went (the lead's address, or the WhatsApp number as normalised), also kept on the draft's delivery.
    const to = result.to ? { to: result.to } : {};
    if (result.outcome === "uncertain") { res.status(202).json(ok({ draft: await reload(ctx, draft._id), ...to })); return; }
    res.status(201).json(ok({ draft: await reload(ctx, draft._id), activity: present(result.activity), lead: leadJson(result.lead), ...to }));
  });

  // A person says whether an unclear send went out: "sent" records it (201 { draft, activity, lead }), "not_sent" frees the draft (200 { draft }).
  router.post("/drafts/:id/delivery", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Saying whether a message went out");
    const { draft, lead } = await loadDraft(database, ctx, idSchema.parse(req.params.id));
    const { outcome } = draftDeliveryReconcileSchema.parse(req.body ?? {});
    const result = await settleDelivery(ctx, draft, lead, outcome);
    if (result.activity && result.lead) { res.status(201).json(ok({ draft: await reload(ctx, draft._id), activity: present(result.activity), lead: leadJson(result.lead) })); return; }
    res.json(ok({ draft: await reload(ctx, draft._id) }));
  });

  return router;
}
