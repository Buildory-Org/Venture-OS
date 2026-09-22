import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { AppDb } from "../db.js";
import { idSchema, patCreateSchema } from "@venture-studio/contracts";
import { createPat } from "@venture-studio/core";
import type { AppConfig } from "../config.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";

export function patRoutes(db: AppDb, config: AppConfig): Router {
  const router = Router();
  router.post("/pats", async (req, res) => {
    if (config.APP_MODE !== "local") throw new AppError(403, "FORBIDDEN", "Local PATs are disabled outside local development");
    const input = patCreateSchema.parse(req.body);
    const actor = req.actor!;
    const generated = createPat();
    const pat = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: actor.id, name: input.name, prefix: generated.prefix, tokenHash: generated.hash, scopes: input.scopes, createdAt: new Date(), ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}) };
    await db.collection("pats").insertOne(pat);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "pat.create", objectType: "pat", objectId: String(pat._id), result: "success", metadata: { scopeCount: input.scopes.length } });
    res.status(201).json({ ok: true, data: { pat: jsonValue({ ...pat, tokenHash: undefined }), token: generated.token, warning: "This local development token is shown once. Hosted access requires OAuth." } });
  });
  router.post("/pats/:id/revoke", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const result = await db.collection("pats").updateOne({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "PAT not found");
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "pat.revoke", objectType: "pat", objectId: id, result: "success" });
    res.json({ ok: true, data: { revoked: true } });
  });
  return router;
}
