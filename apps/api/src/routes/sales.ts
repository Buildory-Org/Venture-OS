import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { AppDb } from "../db.js";
import { idSchema, opportunityInputSchema, pipelineInputSchema, updateOpportunitySchema, updatePipelineSchema } from "@venture-studio/contracts";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue, omitNullFields } from "../json.js";


export function salesRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/pipelines", async (req, res) => {
    const actor = req.actor!; const filter = actor.membership.role === "admin" ? {} : { ventureId: { $in: actor.membership.ventureIds } };
    res.json({ ok: true, data: jsonValue(await db.collection("pipelines").find({ workspaceId: actor.membership.workspaceId, ...filter }).toArray()) });
  });
  router.post("/pipelines", async (req, res) => {
    const actor = req.actor!; const input = pipelineInputSchema.parse(req.body);
    if (actor.membership.role !== "admin" && (actor.membership.role !== "venture_head" || !actor.membership.ventureIds.includes(input.ventureId))) throw new AppError(403, "FORBIDDEN", "Pipeline access denied");
    const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...input, createdAt: new Date(), updatedAt: new Date() };
    await db.collection("pipelines").insertOne(item); await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "pipeline.create", objectType: "pipeline", objectId: String(item._id), ventureId: input.ventureId, result: "success" });
    res.status(201).json({ ok: true, data: jsonValue(item) });
  });
  router.patch("/pipelines/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const pipeline = await db.collection("pipelines").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!pipeline || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(String(pipeline.ventureId)))) throw new AppError(404, "NOT_FOUND", "Pipeline not found");
    if (actor.membership.role !== "admin" && actor.membership.role !== "venture_head") throw new AppError(403, "FORBIDDEN", "Only venture leads may edit pipelines");
    const input = updatePipelineSchema.parse(req.body);
    await db.collection("pipelines").updateOne({ _id: id, workspaceId: actor.membership.workspaceId }, { $set: { ...input, updatedAt: new Date() } });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "pipeline.update", objectType: "pipeline", objectId: id, ventureId: String(pipeline.ventureId), result: "success" });
    res.json({ ok: true, data: jsonValue(await db.collection("pipelines").findOne({ _id: id })) });
  });
  router.get("/opportunities", async (req, res) => {
    const actor = req.actor!; const pipelines = await db.collection("pipelines").find({ workspaceId: actor.membership.workspaceId, ...(actor.membership.role === "admin" ? {} : { ventureId: { $in: actor.membership.ventureIds } }) }).project({ _id: 1 }).toArray();
    res.json({ ok: true, data: jsonValue((await db.collection("opportunities").find({ pipelineId: { $in: pipelines.map((item) => item._id) } }).toArray()).map((item) => omitNullFields(item, ["nextActionAt"]))) });
  });
  router.post("/opportunities", async (req, res) => {
    const actor = req.actor!; const input = opportunityInputSchema.parse(req.body); const pipeline = await db.collection("pipelines").findOne({ _id: input.pipelineId, workspaceId: actor.membership.workspaceId });
    if (!pipeline || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(String(pipeline.ventureId)))) throw new AppError(404, "NOT_FOUND", "Pipeline not found");
    const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ventureId: pipeline.ventureId, ...input, ...(input.nextActionAt ? { nextActionAt: new Date(input.nextActionAt) } : {}), createdAt: new Date(), updatedAt: new Date() };
    await db.collection("opportunities").insertOne(item); res.status(201).json({ ok: true, data: jsonValue(item) });
  });
  router.patch("/opportunities/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const item = await db.collection("opportunities").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!item || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(String(item.ventureId)))) throw new AppError(404, "NOT_FOUND", "Opportunity not found");
    if (actor.membership.role !== "admin" && actor.membership.role !== "venture_head" && item.ownerId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the owner or venture lead may edit this opportunity");
    const input = updateOpportunitySchema.parse(req.body);
    await db.collection("opportunities").updateOne({ _id: id, workspaceId: actor.membership.workspaceId }, { $set: { ...input, ...(input.nextActionAt ? { nextActionAt: new Date(input.nextActionAt) } : {}), updatedAt: new Date() } });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "opportunity.update", objectType: "opportunity", objectId: id, ventureId: String(item.ventureId), result: "success" });
    const updated = await db.collection("opportunities").findOne({ _id: id });
    res.json({ ok: true, data: updated ? jsonValue(omitNullFields(updated, ["nextActionAt"])) : null });
  });
  return router;
}
