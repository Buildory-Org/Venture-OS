import { Router } from "express";
import type { AppDb } from "../db.js";
import { jsonValue } from "../json.js";
import { dashboardReadModelSchema } from "@venture-studio/contracts";

export function hierarchyRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/session/bootstrap", async (req, res) => {
    const actor = req.actor!;
    const hierarchy = await loadHierarchy(db, actor.membership.workspaceId, actor.membership.role === "admin" ? undefined : actor.membership.ventureIds, actor.membership.role === "admin" ? undefined : actor.membership.groupIds);
    res.json({ ok: true, data: { user: { id: actor.id, name: actor.name, email: actor.email }, membership: actor.membership, hierarchy } });
  });
  router.get("/hierarchy", async (req, res) => {
    const actor = req.actor!;
    res.json({ ok: true, data: await loadHierarchy(db, actor.membership.workspaceId, actor.membership.role === "admin" ? undefined : actor.membership.ventureIds, actor.membership.role === "admin" ? undefined : actor.membership.groupIds) });
  });
  router.get("/dashboard", async (req, res) => {
    const actor = req.actor!;
    const workspaceId = actor.membership.workspaceId;
    const ventureFilter = actor.membership.role === "admin" ? {} : { ventureId: { $in: actor.membership.ventureIds } };
    const taskFilter = actor.membership.role === "admin" ? {} : { ...ventureFilter, groupId: { $in: actor.membership.groupIds } };
    const [tasks, reviews, blockers, classes, outcomes, mentions] = await Promise.all([
      db.collection("tasks").find({ workspaceId, ...taskFilter, assigneeId: actor.id, status: { $nin: ["done", "cancelled"] } }).sort({ dueAt: 1 }).limit(10).toArray(),
      db.collection("tasks").find({ workspaceId, ...taskFilter, reviewerId: actor.id, status: "review" }).sort({ reviewAt: 1 }).limit(10).toArray(),
      db.collection("tasks").find({ workspaceId, ...taskFilter, blocker: { $exists: true, $ne: "" }, status: { $ne: "done" } }).sort({ dueAt: 1 }).limit(10).toArray(),
      db.collection("classes").find({ workspaceId, participantIds: actor.id, scheduledAt: { $gte: new Date() } }).sort({ scheduledAt: 1 }).limit(3).toArray(),
      db.collection("outcomes").find({ workspaceId, ...ventureFilter, status: { $in: ["approved", "active", "at_risk"] } }).sort({ reviewAt: 1 }).limit(10).toArray(),
      db.collection("notifications").find({ workspaceId, userId: actor.id, type: "mention", readAt: { $exists: false } }).sort({ createdAt: -1 }).limit(10).toArray(),
    ]);
    const data = dashboardReadModelSchema.parse(jsonValue({ tasks, reviews, blockers, classes, outcomes, mentions, asOf: new Date() }));
    res.json({ ok: true, data });
  });
  return router;
}

async function loadHierarchy(db: AppDb, workspaceId: string, ventureIds?: string[], groupIds?: string[]): Promise<unknown> {
  const workspace = await db.collection("workspaces").findOne({ _id: workspaceId });
  const ventures = await db.collection("ventures").find({ workspaceId, ...(ventureIds ? { _id: { $in: ventureIds } } : {}) }).sort({ name: 1 }).toArray();
  const ventureIdList = ventures.map((venture) => String(venture._id));
  const [groups, channels] = await Promise.all([
    db.collection("groups").find({ ventureId: { $in: ventureIdList }, ...(groupIds ? { _id: { $in: groupIds } } : {}) }).sort({ name: 1 }).toArray(),
    db.collection("channels").find({ ventureId: { $in: ventureIdList }, ...(groupIds ? { groupId: { $in: groupIds } } : {}) }).sort({ name: 1 }).toArray(),
  ]);
  return jsonValue({ workspace, ventures: ventures.map((venture) => ({ ...venture, groups: groups.filter((group) => group.ventureId === venture._id).map((group) => ({ ...group, channels: channels.filter((channel) => channel.groupId === group._id) })) })) });
}
