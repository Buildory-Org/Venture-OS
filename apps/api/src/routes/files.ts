import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { AppDb } from "../db.js";
import { cursorQuerySchema, groupFileSchema, idSchema, uploadCompleteSchema, uploadIntentSchema } from "@venture-studio/contracts";
import { can } from "@venture-studio/core";
import type { ObjectStore } from "../storage.js";
import { LocalObjectStore } from "../storage.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";

export function fileRoutes(db: AppDb, store: ObjectStore): Router {
  const router = Router();
  router.get("/groups/:id/files", async (req, res) => {
    const groupId = idSchema.parse(req.params.id);
    const actor = req.actor!;
    const group = await db.collection("groups").findOne({ _id: groupId, workspaceId: actor.membership.workspaceId });
    if (!group || !can(actor.membership, "group:read", { ventureId: String(group.ventureId), groupId })) throw new AppError(404, "NOT_FOUND", "Group not found");
    const query = cursorQuerySchema.parse(req.query);
    const scope = { workspaceId: actor.membership.workspaceId, ventureId: group.ventureId, groupId, status: "ready" };
    const cursor = query.cursor ? await db.collection("files").findOne({ ...scope, _id: idSchema.parse(query.cursor) }) : undefined;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "File cursor not found");
    const before = cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {};
    const files = await db.collection("files").find({ ...scope, ...before }).sort({ createdAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: files.slice(0, query.limit).map((file) => groupFileSchema.parse(jsonValue(file))), nextCursor: files.length > query.limit ? files[query.limit - 1]?._id : undefined } });
  });
  router.post("/uploads", async (req, res) => {
    const input = uploadIntentSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "knowledge:write", { ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(403, "FORBIDDEN", "Upload access denied");
    if (input.groupId) {
      const group = await db.collection("groups").findOne({ _id: input.groupId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId });
      if (!group) throw new AppError(400, "BAD_REQUEST", "Upload group does not belong to the selected venture");
    }
    if (input.taskId) {
      const task = await db.collection("tasks").findOne({ _id: input.taskId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId, groupId: input.groupId });
      if (!task) throw new AppError(400, "BAD_REQUEST", "Attachment task does not belong to the selected venture and group");
    }
    const id = randomUUID();
    const uploadKey = `${actor.membership.workspaceId}/${input.ventureId}/staging/${id}`;
    const objectKey = `${actor.membership.workspaceId}/${input.ventureId}/objects/${id}`;
    const file = { _id: id, workspaceId: actor.membership.workspaceId, ...input, ownerId: actor.id, uploadKey, objectKey, status: "pending", storage: store.kind, createdAt: new Date() };
    await db.collection("files").insertOne(file);
    const uploadUrl = await store.uploadUrl(uploadKey, input.contentType, input.size);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "file.intent.create", objectType: "file", objectId: id, ventureId: input.ventureId, result: "success" });
    res.status(201).json({ ok: true, data: { file: jsonValue(file), uploadUrl, expiresInSeconds: 900 } });
  });
  router.post("/uploads/:id/complete", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = uploadCompleteSchema.parse(req.body);
    const actor = req.actor!;
    const file = await accessibleFile(db, actor, id, true);
    if (file.status === "ready") {
      if (file.uploadKey) {
        await store.discard(String(file.uploadKey));
        await db.collection("files").updateOne({ _id: id, status: "ready" }, { $unset: { uploadKey: "" } });
      }
      return void res.json({ ok: true, data: jsonValue(await db.collection("files").findOne({ _id: id })) });
    }
    if (file.status === "pending") {
      const metadata = await store.head(String(file.uploadKey));
      if (metadata.size !== file.size) throw new AppError(409, "CONFLICT", "Uploaded object size does not match the intent");
      if (store.kind === "r2" && metadata.etag !== input.etag.replaceAll('"', "")) throw new AppError(409, "CONFLICT", "Uploaded object ETag does not match");
      const claimed = await db.collection("files").updateOne({ _id: id, status: "pending" }, { $set: { status: "finalizing", stagingEtag: metadata.etag, finalizationStartedAt: new Date() } });
      if (!claimed.matchedCount) throw new AppError(409, "CONFLICT", "Upload completion is already in progress");
    } else if (file.status !== "finalizing") throw new AppError(409, "CONFLICT", "Upload cannot be completed from its current state");
    let finalized;
    try { finalized = await store.head(String(file.objectKey)); }
    catch { finalized = await store.finalize(String(file.uploadKey), String(file.objectKey)); }
    const changed = await db.collection("files").updateOne({ _id: id, status: "finalizing" }, { $set: { status: "ready", etag: finalized.etag, completedAt: new Date() }, $unset: { stagingEtag: "", finalizationStartedAt: "" } });
    if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Upload completion state changed; reload and retry");
    try { await store.discard(String(file.uploadKey)); await db.collection("files").updateOne({ _id: id, status: "ready" }, { $unset: { uploadKey: "" } }); }
    catch (error) { console.warn(JSON.stringify({ level: "warn", event: "upload_staging_cleanup_failed", fileId: id, message: error instanceof Error ? error.message : "Unknown cleanup error" })); }
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "file.complete", objectType: "file", objectId: id, ventureId: String(file.ventureId), result: "success" });
    res.json({ ok: true, data: jsonValue(await db.collection("files").findOne({ _id: id })) });
  });
  router.get("/files/:id/download", async (req, res) => {
    const actor = req.actor!;
    const file = await accessibleFile(db, actor, idSchema.parse(req.params.id));
    const downloadUrl = await store.downloadUrl(String(file.objectKey));
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "file.download_url", objectType: "file", objectId: String(file._id), ventureId: String(file.ventureId), result: "success" });
    res.json({ ok: true, data: { downloadUrl, expiresInSeconds: store.kind === "r2" ? 300 : 900 } });
  });
  return router;
}

export function localObjectRoutes(db: AppDb, store: LocalObjectStore): Router {
  const router = Router();
  router.put("/local-objects/:token", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
    try { const key = store.verify(req.params.token, "put"); const pending = await db.collection("files").findOne({ uploadKey: key, status: "pending" }); if (!pending) throw new Error("Upload completed"); await store.write(key, Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body)); res.status(204).end(); }
    catch { throw new AppError(403, "FORBIDDEN", "Upload URL is invalid or expired"); }
  });
  router.get("/local-objects/:token", async (req, res) => {
    try { const key = store.verify(req.params.token, "get"); res.send(await store.read(key)); }
    catch { throw new AppError(403, "FORBIDDEN", "Download URL is invalid or expired"); }
  });
  return router;
}

async function accessibleFile(db: AppDb, actor: NonNullable<Express.Request["actor"]>, id: string, allowPending = false) {
  const file = await db.collection("files").findOne({ _id: id, workspaceId: actor.membership.workspaceId, ...(allowPending ? {} : { status: "ready" }) });
  if (!file || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(file.ventureId)) || (file.groupId && !actor.membership.groupIds.includes(String(file.groupId)))))) throw new AppError(404, "NOT_FOUND", "File not found");
  return file;
}
