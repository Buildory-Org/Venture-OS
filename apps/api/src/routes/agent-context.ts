import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Document } from "mongodb";
import { createSkillSchema, createVentureContextSchema, groupAttachmentQuerySchema, idSchema, skillListQuerySchema, taskAttachmentQuerySchema, updateSkillSchema, updateVentureContextSchema, type AttachmentKind } from "@venture-studio/contracts";
import { can, sharesKnowledge } from "@venture-studio/core";
import type { AppDb, Database } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { inArchivedVenture, notArchived } from "../archive-scope.js";
import { jsonValue } from "../json.js";

type Actor = NonNullable<Express.Request["actor"]>;

const CONTEXT_FILES_PER_VENTURE = 100;
// Claude reads a venture's whole context before starting, so it stays readable in one sitting (about 50 parts at most).
const CONTEXT_CHARACTERS_PER_VENTURE = 500_000;
const SKILLS_PER_WORKSPACE = 500;
// Lists show sizes, not text: the text is only read when one item is opened (older rows have their size worked out here).
const WITHOUT_TEXT = [{ $addFields: { characters: { $ifNull: ["$characters", { $strLenCP: "$markdown" }] } } }, { $project: { markdown: 0 } }];
const live = { deletedAt: { $exists: false } };
const KIND: Record<AttachmentKind, RegExp> = { image: /^image\//, video: /^video\//, audio: /^audio\//, document: /^(?!image\/|video\/|audio\/)/ };

/** Can this person open the venture (its context, its skills, its files)? Archived ventures are hidden from everyone. */
const readsVenture = (actor: Actor, ventureId: string) => !inArchivedVenture(actor.membership, ventureId) && (actor.membership.role === "admin" || actor.membership.ventureIds.includes(ventureId));
/** Admins and the venture's head write its context and its skills. */
const leadsVenture = (actor: Actor, ventureId: string) => (actor.membership.role === "admin" || actor.membership.role === "venture_head") && can(actor.membership, "knowledge:write", { ventureId });
/** A workspace-wide skill needs the permission to share knowledge with all ventures; a venture's skill needs its lead. */
const writesSkill = (actor: Actor, ventureId?: string) => ventureId ? leadsVenture(actor, ventureId) : sharesKnowledge(actor.membership);

async function openVenture(db: AppDb, actor: Actor, ventureId: string) {
  const venture = readsVenture(actor, ventureId) ? await db.collection("ventures").findOne({ _id: ventureId, workspaceId: actor.membership.workspaceId }) : null;
  if (!venture) throw new AppError(404, "NOT_FOUND", "Venture not found");
  return venture;
}

const contextJson = (item: Document, withText: boolean) => jsonValue({ id: item._id, ventureId: item.ventureId, title: item.title, ...(withText ? { markdown: item.markdown } : {}), characters: Number(item.characters ?? String(item.markdown ?? "").length), createdBy: item.createdBy, updatedBy: item.updatedBy, createdAt: item.createdAt, updatedAt: item.updatedAt });
const skillJson = (actor: Actor, item: Document, withText: boolean) => jsonValue({ id: item._id, ...(item.ventureId ? { ventureId: item.ventureId } : {}), title: item.title, description: item.description, ...(withText ? { markdown: item.markdown } : {}), characters: Number(item.characters ?? String(item.markdown ?? "").length), canEdit: writesSkill(actor, item.ventureId ? String(item.ventureId) : undefined), createdBy: item.createdBy, updatedBy: item.updatedBy, createdAt: item.createdAt, updatedAt: item.updatedAt });

export function agentContextRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  // A venture's context: several Markdown files, oldest first, that an agent reads before working on the venture.
  router.get("/ventures/:ventureId/context", async (req, res) => {
    const actor = req.actor!;
    const ventureId = idSchema.parse(req.params.ventureId);
    await openVenture(db, actor, ventureId);
    const full = req.query.full === "true";
    const items = await db.collection("venture_context").aggregate([{ $match: { workspaceId: actor.membership.workspaceId, ventureId, ...live } }, { $sort: { createdAt: 1, _id: 1 } }, { $limit: CONTEXT_FILES_PER_VENTURE }, ...(full ? [] : WITHOUT_TEXT)]).toArray();
    if (full) await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "venture_context.read", objectType: "venture", objectId: ventureId, ventureId, result: "success" });
    res.json({ ok: true, data: { items: items.map((item) => contextJson(item, full)), canEdit: leadsVenture(actor, ventureId) } });
  });

  router.get("/context/:id", async (req, res) => {
    const actor = req.actor!;
    const item = await db.collection("venture_context").findOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId, ...live });
    if (!item || !readsVenture(actor, String(item.ventureId))) throw new AppError(404, "NOT_FOUND", "Context file not found");
    res.json({ ok: true, data: contextJson(item, true) });
  });

  router.post("/ventures/:ventureId/context", async (req, res) => {
    const actor = req.actor!;
    const ventureId = idSchema.parse(req.params.ventureId);
    await openVenture(db, actor, ventureId);
    if (!leadsVenture(actor, ventureId)) throw new AppError(403, "FORBIDDEN", "Only admins and this venture's head can change its context");
    const input = createVentureContextSchema.parse(req.body);
    if (await db.collection("venture_context").countDocuments({ workspaceId: actor.membership.workspaceId, ventureId, ...live }) >= CONTEXT_FILES_PER_VENTURE) throw new AppError(409, "CONFLICT", `A venture can have up to ${CONTEXT_FILES_PER_VENTURE} context files; combine or remove some first`);
    await assertContextRoom(actor, ventureId, input.markdown.length);
    const now = new Date();
    const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ventureId, title: input.title, markdown: input.markdown, characters: input.markdown.length, createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now };
    await db.collection("venture_context").insertOne(item);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "venture_context.create", objectType: "venture_context", objectId: item._id, ventureId, result: "success" });
    res.status(201).json({ ok: true, data: contextJson(item, true) });
  });

  router.put("/context/:id", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const input = updateVentureContextSchema.parse(req.body);
    const item = await db.collection("venture_context").findOne({ _id: id, workspaceId: actor.membership.workspaceId, ...live });
    if (!item || !readsVenture(actor, String(item.ventureId))) throw new AppError(404, "NOT_FOUND", "Context file not found");
    if (!leadsVenture(actor, String(item.ventureId))) throw new AppError(403, "FORBIDDEN", "Only admins and this venture's head can change its context");
    if (input.markdown !== undefined) await assertContextRoom(actor, String(item.ventureId), input.markdown.length, id);
    const now = new Date();
    const changed = await db.collection("venture_context").updateOne({ _id: id, ...live }, { $set: { ...input, ...(input.markdown !== undefined ? { characters: input.markdown.length } : {}), updatedBy: actor.id, updatedAt: now } });
    if (!changed.matchedCount) throw new AppError(404, "NOT_FOUND", "Context file not found");
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "venture_context.update", objectType: "venture_context", objectId: id, ventureId: String(item.ventureId), result: "success" });
    res.json({ ok: true, data: contextJson((await db.collection("venture_context").findOne({ _id: id, ...live }))!, true) });
  });

  router.delete("/context/:id", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const item = await db.collection("venture_context").findOne({ _id: id, workspaceId: actor.membership.workspaceId, ...live });
    if (!item || !readsVenture(actor, String(item.ventureId))) throw new AppError(404, "NOT_FOUND", "Context file not found");
    if (!leadsVenture(actor, String(item.ventureId))) throw new AppError(403, "FORBIDDEN", "Only admins and this venture's head can change its context");
    // Kept, hidden, so a mistaken removal can be recovered from the database.
    if (!(await db.collection("venture_context").updateOne({ _id: id, ...live }, { $set: { deletedAt: new Date(), deletedBy: actor.id } })).matchedCount) throw new AppError(404, "NOT_FOUND", "Context file not found");
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "venture_context.delete", objectType: "venture_context", objectId: id, ventureId: String(item.ventureId), result: "success" });
    res.json({ ok: true, data: { id } });
  });

  /** Keeps a venture's whole context within what Claude can read before starting. */
  async function assertContextRoom(actor: Actor, ventureId: string, adding: number, replacing?: string) {
    const [sum] = await db.collection("venture_context").aggregate([
      { $match: { workspaceId: actor.membership.workspaceId, ventureId, ...live, ...(replacing ? { _id: { $ne: replacing } } : {}) } },
      { $group: { _id: null, characters: { $sum: { $ifNull: ["$characters", { $strLenCP: "$markdown" }] } } } },
    ]).toArray();
    const total = Number(sum?.characters ?? 0) + adding;
    if (total > CONTEXT_CHARACTERS_PER_VENTURE) throw new AppError(409, "CONFLICT", `A venture's context can hold up to ${CONTEXT_CHARACTERS_PER_VENTURE.toLocaleString("en")} characters in all (this would make ${total.toLocaleString("en")}); shorten or remove some files first`);
  }

  // Skills: the workspace's (every venture uses them) and each venture's own.
  router.get("/skills", async (req, res) => {
    const actor = req.actor!;
    const query = skillListQuerySchema.parse(req.query);
    if (query.ventureId) await openVenture(db, actor, query.ventureId);
    const ventures = query.ventureId ? { $or: [{ ventureId: { $exists: false } }, { ventureId: query.ventureId }] }
      : actor.membership.role === "admin" ? notArchived(actor.membership) : { $or: [{ ventureId: { $exists: false } }, { ventureId: { $in: actor.membership.ventureIds } }] };
    const items = await db.collection("skills").aggregate([{ $match: { workspaceId: actor.membership.workspaceId, ...live, ...ventures } }, { $sort: { title: 1, _id: 1 } }, { $limit: SKILLS_PER_WORKSPACE }, ...WITHOUT_TEXT]).toArray();
    res.json({ ok: true, data: { items: items.map((item) => skillJson(actor, item, false)) } });
  });

  async function openSkill(actor: Actor, id: string) {
    const item = await db.collection("skills").findOne({ _id: id, workspaceId: actor.membership.workspaceId, ...live });
    if (!item || (item.ventureId && !readsVenture(actor, String(item.ventureId)))) throw new AppError(404, "NOT_FOUND", "Skill not found");
    return item;
  }

  router.get("/skills/:id", async (req, res) => {
    const actor = req.actor!;
    res.json({ ok: true, data: skillJson(actor, await openSkill(actor, idSchema.parse(req.params.id)), true) });
  });

  router.post("/skills", async (req, res) => {
    const actor = req.actor!;
    const input = createSkillSchema.parse(req.body);
    if (input.ventureId) await openVenture(db, actor, input.ventureId);
    if (!writesSkill(actor, input.ventureId)) throw new AppError(403, "FORBIDDEN", input.ventureId ? "Only admins and this venture's head can add its skills" : "Only admins and people allowed to share knowledge with all ventures can add workspace-wide skills");
    if (await db.collection("skills").countDocuments({ workspaceId: actor.membership.workspaceId, ...live }) >= SKILLS_PER_WORKSPACE) throw new AppError(409, "CONFLICT", `A workspace can have up to ${SKILLS_PER_WORKSPACE} skills; remove some first`);
    const now = new Date();
    const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...(input.ventureId ? { ventureId: input.ventureId } : {}), title: input.title, description: input.description, markdown: input.markdown, characters: input.markdown.length, createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now };
    await db.collection("skills").insertOne(item);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "skill.create", objectType: "skill", objectId: item._id, ...(input.ventureId ? { ventureId: input.ventureId } : {}), result: "success" });
    res.status(201).json({ ok: true, data: skillJson(actor, item, true) });
  });

  router.put("/skills/:id", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const input = updateSkillSchema.parse(req.body);
    const item = await openSkill(actor, id);
    const from = item.ventureId ? String(item.ventureId) : undefined;
    if (!writesSkill(actor, from)) throw new AppError(403, "FORBIDDEN", "You can't change this skill");
    // Moving it: allowed only into a scope this person could have added it to.
    const to = input.ventureId === undefined ? from : input.ventureId ?? undefined;
    if (to !== from) {
      if (to) await openVenture(db, actor, to);
      if (!writesSkill(actor, to)) throw new AppError(403, "FORBIDDEN", to ? "Only admins and that venture's head can move a skill there" : "Only admins and people allowed to share knowledge with all ventures can make a skill workspace-wide");
    }
    const { ventureId: _scope, ...fields } = input;
    const now = new Date();
    const changed = await db.collection("skills").updateOne({ _id: id, ...live }, { $set: { ...fields, ...(fields.markdown !== undefined ? { characters: fields.markdown.length } : {}), ...(to ? { ventureId: to } : {}), updatedBy: actor.id, updatedAt: now }, ...(!to && from ? { $unset: { ventureId: "" } } : {}) });
    if (!changed.matchedCount) throw new AppError(404, "NOT_FOUND", "Skill not found");
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "skill.update", objectType: "skill", objectId: id, ...(to ? { ventureId: to } : {}), result: "success", ...(to !== from ? { metadata: { movedFrom: from ?? "workspace", movedTo: to ?? "workspace" } } : {}) });
    res.json({ ok: true, data: skillJson(actor, (await db.collection("skills").findOne({ _id: id, ...live }))!, true) });
  });

  router.delete("/skills/:id", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const item = await openSkill(actor, id);
    if (!writesSkill(actor, item.ventureId ? String(item.ventureId) : undefined)) throw new AppError(403, "FORBIDDEN", "You can't remove this skill");
    if (!(await db.collection("skills").updateOne({ _id: id, ...live }, { $set: { deletedAt: new Date(), deletedBy: actor.id } })).matchedCount) throw new AppError(404, "NOT_FOUND", "Skill not found");
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "skill.delete", objectType: "skill", objectId: id, ...(item.ventureId ? { ventureId: String(item.ventureId) } : {}), result: "success" });
    res.json({ ok: true, data: { id } });
  });

  // Everything shared in a group's channels (or one channel), newest first.
  router.get("/groups/:groupId/attachments", async (req, res) => {
    const actor = req.actor!;
    const groupId = idSchema.parse(req.params.groupId);
    const query = groupAttachmentQuerySchema.parse(req.query);
    const workspaceId = actor.membership.workspaceId;
    const group = await db.collection("groups").findOne({ _id: groupId, workspaceId });
    if (!group || inArchivedVenture(actor.membership, group.ventureId) || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(group.ventureId)) || !actor.membership.groupIds.includes(groupId)))) throw new AppError(404, "NOT_FOUND", "Group not found");
    if (query.channelId && !(await db.collection("channels").findOne({ _id: query.channelId, workspaceId, groupId }))) throw new AppError(404, "NOT_FOUND", "Channel not found");
    const cursor = query.cursor ? await db.collection("messages").findOne({ _id: query.cursor, workspaceId, groupId }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Cursor not found");
    const kind = query.kind ? KIND[query.kind] : null;
    const rows = await db.collection("messages").find({
      workspaceId, groupId, ...(query.channelId ? { channelId: query.channelId } : {}), "attachments.0": { $exists: true },
      ...(kind ? { attachments: { $elemMatch: { contentType: { $regex: kind } } } } : {}),
      ...(cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {}),
    }).sort({ createdAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    const page = rows.slice(0, query.limit);
    const items = page.flatMap((message) => (message.attachments as Document[]).filter((file) => !kind || kind.test(String(file.contentType))).map((file) => ({
      id: file.id, name: file.name, contentType: file.contentType, size: file.size, ...(file.width && file.height ? { width: file.width, height: file.height } : {}), ...(file.hd === true ? { hd: true } : {}),
      sharedAt: message.createdAt, sharedBy: message.authorId, ventureId: message.ventureId, groupId, channelId: message.channelId, messageId: message._id,
    })));
    res.json({ ok: true, data: { items: jsonValue(items), nextCursor: rows.length > query.limit ? String(page.at(-1)!._id) : undefined } });
  });

  // Every task attachment I can open, newest first, with its task's title.
  router.get("/attachments/tasks", async (req, res) => {
    const actor = req.actor!;
    const query = taskAttachmentQuerySchema.parse(req.query);
    const workspaceId = actor.membership.workspaceId;
    if (query.ventureId && !readsVenture(actor, query.ventureId)) throw new AppError(404, "NOT_FOUND", "Venture not found");
    // Like opening the task itself: admins see every venture's, others only their own groups'.
    const scope = actor.membership.role === "admin"
      ? (query.ventureId ? { ventureId: query.ventureId } : notArchived(actor.membership))
      : { ventureId: query.ventureId ?? { $in: actor.membership.ventureIds }, groupId: { $in: actor.membership.groupIds } };
    const base = { workspaceId, taskId: { $exists: true }, status: "ready", recipientId: { $exists: false }, ...scope, ...(query.kind ? { contentType: { $regex: KIND[query.kind] } } : {}) };
    const cursor = query.cursor ? await db.collection("files").findOne({ _id: query.cursor, ...base }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Cursor not found");
    const rows = await db.collection("files").find({ ...base, ...(cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {}) }).sort({ createdAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    const page = rows.slice(0, query.limit);
    const tasks = new Map((await db.collection("tasks").find({ workspaceId, _id: { $in: [...new Set(page.map((file) => String(file.taskId)))] } }).project({ title: 1, ventureId: 1, groupId: 1 }).toArray()).map((task) => [String(task._id), task]));
    const items = page.flatMap((file) => {
      const task = tasks.get(String(file.taskId));
      if (!task || String(task.ventureId) !== String(file.ventureId) || String(task.groupId) !== String(file.groupId)) return [];
      return [{ id: file._id, name: file.name, contentType: file.contentType, size: file.size, ...(file.width && file.height ? { width: file.width, height: file.height } : {}), ...(file.hd === true ? { hd: true } : {}),
        sharedAt: file.completedAt ?? file.createdAt, sharedBy: file.ownerId, ventureId: file.ventureId, groupId: file.groupId, taskId: file.taskId, taskTitle: task.title }];
    });
    res.json({ ok: true, data: { items: jsonValue(items), nextCursor: rows.length > query.limit ? String(page.at(-1)!._id) : undefined } });
  });

  return router;
}
