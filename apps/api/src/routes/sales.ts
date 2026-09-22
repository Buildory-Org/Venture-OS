import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db.js";
import { idSchema, isoDateSchema } from "@venture-studio/contracts";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";

const pipelineSchema = z.object({ ventureId: idSchema, name: z.string().trim().min(1).max(120), offerName: z.string().trim().min(1).max(200), status: z.enum(["active", "paused", "archived"]).default("active") });
const opportunitySchema = z.object({ pipelineId: idSchema, companyName: z.string().trim().min(1).max(200), contactName: z.string().trim().max(200).default(""), source: z.string().trim().max(500), observedSignal: z.string().trim().max(2_000), fitReason: z.string().trim().max(2_000), evidenceConfidence: z.enum(["low", "medium", "high"]), stage: z.enum(["identified", "qualified", "contacted", "conversation", "proposal", "won", "lost"]), ownerId: idSchema, nextAction: z.string().trim().max(1_000), nextActionAt: isoDateSchema.optional(), valueEstimateMinor: z.number().int().nonnegative().optional(), currency: z.string().length(3).optional() });

export function salesRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/pipelines", async (req, res) => {
    const actor = req.actor!; const filter = actor.membership.role === "admin" ? {} : { ventureId: { $in: actor.membership.ventureIds } };
    res.json({ ok: true, data: jsonValue(await db.collection("pipelines").find({ workspaceId: actor.membership.workspaceId, ...filter }).toArray()) });
  });
  router.post("/pipelines", async (req, res) => {
    const actor = req.actor!; const input = pipelineSchema.parse(req.body);
    if (actor.membership.role !== "admin" && (actor.membership.role !== "venture_head" || !actor.membership.ventureIds.includes(input.ventureId))) throw new AppError(403, "FORBIDDEN", "Pipeline access denied");
    const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...input, createdAt: new Date(), updatedAt: new Date() };
    await db.collection("pipelines").insertOne(item); await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "pipeline.create", objectType: "pipeline", objectId: String(item._id), ventureId: input.ventureId, result: "success" });
    res.status(201).json({ ok: true, data: jsonValue(item) });
  });
  router.get("/opportunities", async (req, res) => {
    const actor = req.actor!; const pipelines = await db.collection("pipelines").find({ workspaceId: actor.membership.workspaceId, ...(actor.membership.role === "admin" ? {} : { ventureId: { $in: actor.membership.ventureIds } }) }).project({ _id: 1 }).toArray();
    res.json({ ok: true, data: jsonValue(await db.collection("opportunities").find({ pipelineId: { $in: pipelines.map((item) => item._id) } }).toArray()) });
  });
  router.post("/opportunities", async (req, res) => {
    const actor = req.actor!; const input = opportunitySchema.parse(req.body); const pipeline = await db.collection("pipelines").findOne({ _id: input.pipelineId, workspaceId: actor.membership.workspaceId });
    if (!pipeline || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(String(pipeline.ventureId)))) throw new AppError(404, "NOT_FOUND", "Pipeline not found");
    const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ventureId: pipeline.ventureId, ...input, nextActionAt: input.nextActionAt ? new Date(input.nextActionAt) : undefined, createdAt: new Date(), updatedAt: new Date() };
    await db.collection("opportunities").insertOne(item); res.status(201).json({ ok: true, data: jsonValue(item) });
  });
  return router;
}
