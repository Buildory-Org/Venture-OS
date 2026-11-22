import { Router } from "express";
import { z } from "zod";
import { autopilotRunResultSchema, autopilotSettingsSchema, idSchema, type AutopilotSettings } from "@venture-studio/contracts";
import type { Database } from "../db.js";
import { AppError } from "../errors.js";
import { forbidClaude, loadVenture, requireHead } from "../sales/access.js";
import { auditSales, salesCtx } from "../sales/ctx.js";
import { dropAutoQueued } from "../sales/channels/send-queue.js";
import { OFFERS } from "../sales/offers.js";
import { loadSettings } from "../sales/settings.js";
import { STATE, buildStatus, runAsActor, type AutopilotEnv } from "../sales/autopilot/status.js";

const querySchema = z.object({ ventureId: idSchema });
const ok = (data: unknown) => ({ ok: true, data });

/**
 * The venture's sales autopilot (docs/sales-autopilot.md sections 2, 4 and 6): anyone who can open the venture reads its status; a venture
 * head or an admin changes its settings and asks for a pass now, in the app only (never Claude).
 */
export function salesAutopilotRoutes(database: Database, env: AutopilotEnv): Router {
  const db = database.db;
  const router = Router();

  router.get("/autopilot", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { ventureId } = querySchema.parse(req.query);
    await loadVenture(db, ctx.actor, ventureId);
    res.json(ok(await buildStatus(db, env, ctx.actor, ventureId)));
  });

  // Saves the autopilot only (PUT /sales/settings keeps it as stored). Switching it on without `runAsUserId` sets the caller.
  router.put("/autopilot", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { ventureId } = querySchema.parse({ ventureId: req.query.ventureId ?? (req.body as { ventureId?: unknown } | undefined)?.ventureId });
    await loadVenture(db, ctx.actor, ventureId);
    forbidClaude(ctx.via, "Changing a venture's autopilot");
    requireHead(ctx.actor, ventureId, "change the autopilot");
    const { ventureId: _ignored, ...body } = (req.body ?? {}) as Record<string, unknown>;
    const parsed = autopilotSettingsSchema.parse(body);
    const before = (await loadSettings(db, ctx.workspaceId, ventureId)).autopilot;
    // Who it works as: kept as stored when left out; switched on with nobody stored, the caller.
    const runAsUserId = parsed.runAsUserId ?? before.runAsUserId ?? (parsed.enabled ? ctx.actor.id : undefined);
    const input: AutopilotSettings = { ...parsed, ...(runAsUserId ? { runAsUserId } : {}) };
    const nameOf = async (userId: string) => String((await db.collection("users").findOne({ _id: userId, workspaceId: ctx.workspaceId }, { projection: { name: 1 } }))?.name ?? "That person");
    // The person it works as consents: only they make it work as them (it writes and, in "automatic", sends from their mailbox).
    if (input.runAsUserId && input.runAsUserId !== ctx.actor.id && input.runAsUserId !== before.runAsUserId) throw new AppError(403, "FORBIDDEN", `You can only make the autopilot work as yourself: ${await nameOf(input.runAsUserId)} has to switch it on for their own mailbox`);
    // Switching it off is always possible for a head, even when the person it works as is no longer valid.
    if (input.runAsUserId && input.enabled) {
      const who = await runAsActor(db, ctx.workspaceId, ventureId, input.runAsUserId);
      if ("problem" in who) throw new AppError(400, "BAD_REQUEST", "The autopilot works as an active member who can work in this venture: pick someone else");
    }
    // Automatic sending is the run-as person's own choice: they set it, or it was already theirs.
    // Kept only while it was on: switched off by its person, nobody else switches automatic sending back on from their mailbox.
    const automaticKept = before.enabled && before.send === "automatic" && before.runAsUserId === input.runAsUserId;
    if (input.enabled && input.send === "automatic" && input.runAsUserId !== ctx.actor.id && !automaticKept) throw new AppError(403, "FORBIDDEN", `Only ${input.runAsUserId ? await nameOf(input.runAsUserId) : "the person it works as"} can switch on automatic sending: the emails go from their mailbox`);
    if (input.find.offerId && !await db.collection(OFFERS).findOne({ _id: input.find.offerId, workspaceId: ctx.workspaceId, ventureId, state: { $ne: "archived" } }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "The daily search's offer must be one of this venture's offers");
    const changed = (Object.keys(input) as (keyof AutopilotSettings)[]).filter((key) => JSON.stringify(input[key]) !== JSON.stringify(before[key]));
    const now = new Date();
    // Automatic sending stops here when it is switched off, leaves "automatic", or works as someone else: the emails it queued leave the
    // queue in this same request (the queue's worker would drop them too, but not before its next turn).
    const stopsAutomatic = (before.enabled && !input.enabled) || (before.send === "automatic" && input.send !== "automatic") || (Boolean(before.runAsUserId) && before.runAsUserId !== input.runAsUserId);
    await db.collection("sales_settings").updateOne({ _id: ventureId, workspaceId: ctx.workspaceId }, { $set: { autopilot: input, updatedAt: now, updatedBy: ctx.actor.id }, $setOnInsert: { createdAt: now } }, { upsert: true });
    const dropped = stopsAutomatic ? await dropAutoQueued({ db, workspaceId: ctx.workspaceId }, ventureId, "The autopilot's automatic sending was switched off or changed", now) : 0;
    await auditSales(ctx, "sales.autopilot.update", "sales_settings", ventureId, ventureId, { changed: changed.join(",") || "none", enabled: input.enabled, send: input.send, dropped });
    res.json(ok(await buildStatus(db, env, ctx.actor, ventureId)));
  });

  // Asks for a pass now: the next turn of the loop takes this venture first.
  router.post("/autopilot/run", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { ventureId } = querySchema.parse({ ventureId: req.query.ventureId ?? (req.body as { ventureId?: unknown } | undefined)?.ventureId });
    await loadVenture(db, ctx.actor, ventureId);
    forbidClaude(ctx.via, "Running the autopilot");
    requireHead(ctx.actor, ventureId, "run the autopilot");
    const settings = (await loadSettings(db, ctx.workspaceId, ventureId)).autopilot;
    const answer = (reason: string) => res.json(ok(autopilotRunResultSchema.parse({ started: false, reason })));
    if (env.SALES_AUTOPILOT !== "on") { answer("Autopilot is switched off on this server."); return; }
    if (!settings.enabled) { answer("The autopilot is switched off for this venture: switch it on first."); return; }
    const now = new Date();
    await db.collection(STATE).updateOne({ _id: ventureId }, { $set: { workspaceId: ctx.workspaceId, runRequestedAt: now } }, { upsert: true });
    await auditSales(ctx, "sales.autopilot.run", "sales_settings", ventureId, ventureId);
    res.json(ok(autopilotRunResultSchema.parse({ started: true })));
  });

  return router;
}
