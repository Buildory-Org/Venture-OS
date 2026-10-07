import { Router } from "express";
import { searchQuerySchema } from "@venture-studio/contracts";
import type { AppDb } from "../db.js";
import { audit } from "../audit.js";
import { jsonValue } from "../json.js";
import { inArchivedVenture, notArchived } from "../archive-scope.js";

export function searchRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/search", async (req, res) => {
    const query = searchQuerySchema.parse({ ...req.query, types: typeof req.query.types === "string" ? req.query.types.split(",") : undefined });
    const actor = req.actor!;
    const ventureIds = actor.membership.role === "admin" ? (query.ventureId ? (inArchivedVenture(actor.membership, query.ventureId) ? [] : [query.ventureId]) : undefined) : query.ventureId ? (actor.membership.ventureIds.includes(query.ventureId) ? [query.ventureId] : []) : actor.membership.ventureIds;
    const ventureScope = ventureIds ? { ventureId: { $in: ventureIds } } : notArchived(actor.membership);
    const allowedGroup = !query.groupId || actor.membership.role === "admin" || actor.membership.groupIds.includes(query.groupId);
    const groupScope = query.groupId ? { groupId: allowedGroup ? query.groupId : { $in: [] as string[] } } : actor.membership.role === "admin" ? {} : { groupId: { $in: actor.membership.groupIds } };
    const channels = query.types.includes("message") ? await db.collection("channels").find({ workspaceId: actor.membership.workspaceId, ...ventureScope, ...groupScope }).project({ _id: 1, groupId: 1 }).toArray() : [];
    const channelIds = channels.map((item) => item._id);
    const channelGroupIds = new Map(channels.map((item) => [item._id, item.groupId]));
    const escapedActor = actor.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const [tasks, messages, files] = await Promise.all([
      query.types.includes("task") ? db.collection("tasks").find({ workspaceId: actor.membership.workspaceId, ...ventureScope, ...groupScope, $text: { $search: query.q } }).limit(query.limit).toArray() : [],
      query.types.includes("message") ? db.collection("messages").find({ workspaceId: actor.membership.workspaceId, $text: { $search: query.q }, ...(query.groupId ? { channelId: { $in: channelIds } } : { $or: [{ channelId: { $in: channelIds } }, { dmKey: { $regex: `(^|:)${escapedActor}(:|$)` } }] }) }).limit(query.limit).toArray() : [],
      query.types.includes("file") ? db.collection("files").find({ workspaceId: actor.membership.workspaceId, recipientId: { $exists: false }, ...ventureScope, status: "ready", $text: { $search: query.q }, ...(query.groupId ? groupScope : actor.membership.role === "admin" ? {} : { $or: [{ groupId: { $exists: false } }, { groupId: { $in: actor.membership.groupIds } }] }) }).limit(query.limit).toArray() : [],
    ]);
    const buckets = [
      tasks.map((item) => ({ type: "task", id: item._id, title: item.title, excerpt: item.outcome, ventureId: item.ventureId, sourceRef: `task:${item._id}` })),
      messages.map((item) => ({ type: "message", id: item._id, title: item.channelId ? "Channel message" : "Direct message", excerpt: item.body, ventureId: item.ventureId, groupId: item.groupId ?? channelGroupIds.get(item.channelId), channelId: item.channelId, sourceRef: `message:${item._id}` })),
      files.map((item) => ({ type: "file", id: item._id, title: item.name, excerpt: item.contentType, ventureId: item.ventureId, groupId: item.groupId, contentType: item.contentType, sourceRef: `file:${item._id}` })),
    ];
    const items: (typeof buckets)[number][number][] = [];
    for (let index = 0; index < query.limit && items.length < query.limit; index++) {
      let found = false;
      for (const bucket of buckets) {
        const item = bucket[index];
        if (item && items.length < query.limit) { items.push(item); found = true; }
      }
      if (!found) break;
    }
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "search", objectType: "search", ventureId: query.ventureId, result: "success", metadata: { queryLength: query.q.length, resultCount: items.length } });
    res.json({ ok: true, data: { items: jsonValue(items), nextCursor: undefined } });
  });
  return router;
}
