import { Router } from "express";
import { searchQuerySchema } from "@venture-studio/contracts";
import type { AppDb } from "../db.js";
import { audit } from "../audit.js";
import { jsonValue } from "../json.js";

export function searchRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/search", async (req, res) => {
    const query = searchQuerySchema.parse({ ...req.query, types: typeof req.query.types === "string" ? req.query.types.split(",") : undefined });
    const actor = req.actor!;
    const ventureIds = actor.membership.role === "admin" ? (query.ventureId ? [query.ventureId] : undefined) : query.ventureId ? (actor.membership.ventureIds.includes(query.ventureId) ? [query.ventureId] : []) : actor.membership.ventureIds;
    const ventureScope = ventureIds ? { ventureId: { $in: ventureIds } } : {};
    const channelIds = (await db.collection("channels").find({ workspaceId: actor.membership.workspaceId, ...(actor.membership.role === "admin" ? ventureScope : { groupId: { $in: actor.membership.groupIds }, ...ventureScope }) }).project({ _id: 1 }).toArray()).map((item) => item._id);
    const escapedActor = actor.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const [tasks, messages, files] = await Promise.all([
      query.types.includes("task") ? db.collection("tasks").find({ workspaceId: actor.membership.workspaceId, ...ventureScope, ...(actor.membership.role === "admin" ? {} : { groupId: { $in: actor.membership.groupIds } }), $text: { $search: query.q } }).limit(query.limit).toArray() : [],
      query.types.includes("message") ? db.collection("messages").find({ workspaceId: actor.membership.workspaceId, $text: { $search: query.q }, $or: [{ channelId: { $in: channelIds } }, { dmKey: { $regex: `(^|:)${escapedActor}(:|$)` } }] }).limit(query.limit).toArray() : [],
      query.types.includes("file") ? db.collection("files").find({ workspaceId: actor.membership.workspaceId, ...ventureScope, status: "ready", $text: { $search: query.q }, ...(actor.membership.role === "admin" ? {} : { $or: [{ groupId: { $exists: false } }, { groupId: { $in: actor.membership.groupIds } }] }) }).limit(query.limit).toArray() : [],
    ]);
    const items = [
      ...tasks.map((item) => ({ type: "task", id: item._id, title: item.title, excerpt: item.outcome, ventureId: item.ventureId, sourceRef: `task:${item._id}` })),
      ...messages.map((item) => ({ type: "message", id: item._id, title: item.channelId ? "Channel message" : "Direct message", excerpt: item.body, ventureId: item.ventureId, sourceRef: `message:${item._id}` })),
      ...files.map((item) => ({ type: "file", id: item._id, title: item.name, excerpt: item.contentType, ventureId: item.ventureId, sourceRef: `file:${item._id}` })),
    ].slice(0, query.limit);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "search", objectType: "search", ventureId: query.ventureId, result: "success", metadata: { queryLength: query.q.length, resultCount: items.length } });
    res.json({ ok: true, data: { items: jsonValue(items), nextCursor: undefined } });
  });
  return router;
}
