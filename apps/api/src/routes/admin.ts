import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Database } from "../db.js";
import { atomic } from "../db.js";
import { appRoleSchema, idSchema } from "@venture-studio/contracts";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue, slug } from "../json.js";

const inviteSchema = z.object({ email: z.email(), role: appRoleSchema, ventureIds: z.array(idSchema), groupIds: z.array(idSchema) });
const ventureSchema = z.object({ name: z.string().trim().min(1).max(120), ownerId: idSchema, goal30Day: z.string().trim().max(500).default("") });
const groupSchema = z.object({ ventureId: idSchema, name: z.string().trim().min(1).max(120) });

export function adminRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  router.post("/admin/invitations", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may invite members");
    const input = inviteSchema.parse(req.body);
    const ventures = await db.collection("ventures").countDocuments({ _id: { $in: input.ventureIds }, workspaceId: actor.membership.workspaceId });
    if (ventures !== input.ventureIds.length) throw new AppError(400, "BAD_REQUEST", "Every invited venture must exist in this workspace");
    const groups = await db.collection("groups").find({ _id: { $in: input.groupIds }, workspaceId: actor.membership.workspaceId }).toArray();
    if (groups.length !== input.groupIds.length || groups.some((group) => !input.ventureIds.includes(String(group.ventureId)))) throw new AppError(400, "BAD_REQUEST", "Every invited group must belong to an invited venture");
    const token = randomBytes(32).toString("base64url");
    const invite = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...input, email: input.email.toLowerCase(), tokenHash: createHash("sha256").update(token).digest("hex"), status: "pending", invitedBy: actor.id, expiresAt: new Date(Date.now() + 7 * 86_400_000), createdAt: new Date() };
    await atomic(database, async (session) => {
      await db.collection("invitations").updateMany({ workspaceId: actor.membership.workspaceId, email: input.email.toLowerCase(), status: "pending" }, { $set: { status: "superseded", updatedAt: new Date() } }, { session });
      await db.collection("invitations").insertOne(invite, { session });
    });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "invitation.create", objectType: "invitation", objectId: String(invite._id), result: "success" });
    res.status(201).json({ ok: true, data: { invitation: jsonValue({ ...invite, tokenHash: undefined }), token, next: "Send the user a Better Auth magic link, then accept this invitation after sign-in." } });
  });
  router.post("/admin/ventures", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may create ventures");
    const input = ventureSchema.parse(req.body); const now = new Date(); const id = randomUUID();
    const venture = { _id: id, workspaceId: actor.membership.workspaceId, ...input, slug: slug(input.name), status: "active", createdAt: now, updatedAt: now };
    await db.collection("ventures").insertOne(venture);
    res.status(201).json({ ok: true, data: jsonValue(venture) });
  });
  router.post("/admin/groups", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may create groups");
    const input = groupSchema.parse(req.body); const venture = await db.collection("ventures").findOne({ _id: input.ventureId, workspaceId: actor.membership.workspaceId });
    if (!venture) throw new AppError(404, "NOT_FOUND", "Venture not found");
    const now = new Date(); const groupId = randomUUID(); const channelId = randomUUID();
    const group = { _id: groupId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId, name: input.name, createdAt: now };
    const channel = { _id: channelId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId, groupId, name: "general", createdAt: now };
    await atomic(database, async (session) => { await db.collection("groups").insertOne(group, { session }); await db.collection("channels").insertOne(channel, { session }); });
    res.status(201).json({ ok: true, data: jsonValue({ ...group, channels: [channel] }) });
  });
  router.get("/admin/memberships", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may list memberships");
    res.json({ ok: true, data: jsonValue(await db.collection("memberships").find({ workspaceId: actor.membership.workspaceId }).toArray()) });
  });
  return router;
}

export function invitationAcceptanceRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  router.post("/invitations/accept", async (req, res) => {
    const identity = req.identity!;
    const token = z.object({ token: z.string().min(20) }).parse(req.body).token;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = new Date();
    const auditCandidate = await db.collection("invitations").findOne({ tokenHash }, { projection: { workspaceId: 1 } });
    if (auditCandidate) req.auditWorkspaceId = String(auditCandidate.workspaceId);
    await atomic(database, async (session) => {
      const invite = await db.collection("invitations").findOneAndUpdate({ email: identity.email.toLowerCase(), tokenHash, status: "pending", expiresAt: { $gt: now } }, { $set: { status: "accepting", updatedAt: now } }, { returnDocument: "after", session });
      if (!invite) throw new AppError(404, "NOT_FOUND", "Invitation is invalid or expired");
      const [ventureCount, groups] = await Promise.all([
        db.collection("ventures").countDocuments({ _id: { $in: invite.ventureIds }, workspaceId: invite.workspaceId }, { session }),
        db.collection("groups").find({ _id: { $in: invite.groupIds }, workspaceId: invite.workspaceId }, { session }).toArray(),
      ]);
      if (ventureCount !== invite.ventureIds.length || groups.length !== invite.groupIds.length || groups.some((group) => !invite.ventureIds.includes(group.ventureId))) throw new AppError(409, "CONFLICT", "Invitation scope is no longer valid");
      const activeMembership = await db.collection("memberships").findOne({ userId: identity.id, status: "active" }, { session });
      if (activeMembership && activeMembership.workspaceId !== invite.workspaceId) throw new AppError(409, "CONFLICT", "This account already has an active workspace membership");
      const existing = activeMembership?.workspaceId === invite.workspaceId ? activeMembership : null;
      if (existing && (existing.updatedAt as Date).getTime() > (invite.createdAt as Date).getTime()) throw new AppError(409, "CONFLICT", "Membership changed after this invitation was issued");
      await db.collection("users").updateOne({ _id: identity.id }, { $set: { email: identity.email, name: identity.name, workspaceId: invite.workspaceId, status: "active", updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true, session });
      await db.collection("memberships").updateOne({ workspaceId: invite.workspaceId, userId: identity.id }, { $set: { role: invite.role, ventureIds: invite.ventureIds, groupIds: invite.groupIds, status: "active", updatedAt: now }, $setOnInsert: { _id: randomUUID(), createdAt: now } }, { upsert: true, session });
      const accepted = await db.collection("invitations").updateOne({ _id: invite._id, status: "accepting" }, { $set: { status: "accepted", acceptedAt: now, acceptedBy: identity.id } }, { session });
      if (!accepted.matchedCount) throw new AppError(409, "CONFLICT", "Invitation was already claimed");
      await db.collection("invitations").updateMany({ workspaceId: invite.workspaceId, email: invite.email, status: "pending", _id: { $ne: invite._id } }, { $set: { status: "superseded", updatedAt: now } }, { session });
      await audit(db, { workspaceId: String(invite.workspaceId), actorId: identity.id, channel: "api", action: "invitation.accept", objectType: "invitation", objectId: String(invite._id), result: "success" }, session);
    });
    res.json({ ok: true, data: { accepted: true } });
  });
  return router;
}
