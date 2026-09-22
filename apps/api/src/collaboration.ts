import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Router } from "express";
import { Server } from "socket.io";
import type { ClientSession } from "mongodb";
import { createChannelMessageSchema, createDirectMessageSchema, cursorQuerySchema, idSchema } from "@venture-studio/contracts";
import { dmKey } from "@venture-studio/core";
import type { AppDb, Database } from "./db.js";
import { atomic } from "./db.js";
import { audit } from "./audit.js";
import { AppError } from "./errors.js";
import { jsonValue } from "./json.js";
import type { createActorResolver } from "./middleware.js";

type Actor = NonNullable<Express.Request["actor"]>;

async function channelScope(db: AppDb, actor: Actor, channelId: string) {
  const channel = await db.collection("channels").findOne({ _id: channelId, workspaceId: actor.membership.workspaceId });
  if (!channel || (actor.membership.role !== "admin" && !actor.membership.groupIds.includes(String(channel.groupId)))) throw new AppError(404, "NOT_FOUND", "Channel not found");
  return channel;
}

async function event(db: AppDb, actor: Actor, type: string, payload: Record<string, unknown>, scope: Record<string, unknown>, session?: ClientSession, stableEventId?: string) {
  const eventId = stableEventId ?? randomUUID();
  const value = { _id: eventId, eventId, version: 1, occurredAt: new Date(), actorId: actor.id, workspaceId: actor.membership.workspaceId, ...scope, type, payload };
  await db.collection("events").insertOne(value, { session });
  return value;
}

async function createChannelMessage(database: Database, actor: Actor, channelId: string, input: unknown, interfaceChannel: "api" | "socket") {
  const parsed = createChannelMessageSchema.parse(input);
  const channel = await channelScope(database.db, actor, channelId);
  const prior = await database.db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: parsed.clientId });
  if (prior) {
    if (prior.channelId !== channelId) throw new AppError(409, "CONFLICT", "Message client ID was already used in another channel");
    const priorEvent = await database.db.collection("events").findOne({ _id: prior._id, workspaceId: actor.membership.workspaceId, type: "message.created" });
    if (!priorEvent) throw new AppError(409, "CONFLICT", "Message retry is waiting for its event; retry shortly");
    return { message: prior, event: priorEvent, replayed: true };
  }
  const mentioned = [...new Set(parsed.mentionUserIds)];
  if (mentioned.length) {
    const valid = await database.db.collection("memberships").countDocuments({ workspaceId: actor.membership.workspaceId, userId: { $in: mentioned }, status: "active", ventureIds: channel.ventureId, groupIds: channel.groupId });
    if (valid !== mentioned.length) throw new AppError(400, "BAD_REQUEST", "Every mention must be an active member of this venture and group");
  }
  const message = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ventureId: channel.ventureId, groupId: channel.groupId, channelId, authorId: actor.id, ...parsed, createdAt: new Date() };
  let createdEvent: Record<string, unknown> | undefined;
  try {
    await atomic(database, async (session) => {
      await database.db.collection("messages").insertOne(message, { session });
      createdEvent = await event(database.db, actor, "message.created", message, { ventureId: channel.ventureId, groupId: channel.groupId, channelId }, session, message._id);
      for (const userId of parsed.mentionUserIds) {
        await database.db.collection("notification_outbox").updateOne(
          { idempotencyKey: `mention:${message._id}:${userId}` },
          { $setOnInsert: { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId, type: "mention", title: `Mention from ${actor.name}`, body: parsed.body.slice(0, 500), resourceType: "message", resourceId: message._id, idempotencyKey: `mention:${message._id}:${userId}`, state: "pending", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date(), updatedAt: new Date() } },
          { upsert: true, session },
        );
      }
      await audit(database.db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: interfaceChannel, action: "message.create", objectType: "message", objectId: message._id, ventureId: String(channel.ventureId), result: "success" }, session);
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const duplicate = await database.db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: parsed.clientId, channelId });
    const duplicateEvent = duplicate ? await database.db.collection("events").findOne({ _id: duplicate._id, workspaceId: actor.membership.workspaceId, type: "message.created" }) : null;
    if (!duplicate || !duplicateEvent) throw new AppError(409, "CONFLICT", "Concurrent message retry is not yet readable; retry shortly");
    return { message: duplicate, event: duplicateEvent, replayed: true };
  }
  return { message, event: createdEvent!, replayed: false };
}

export function collaborationRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  router.get("/channels/:channelId/messages", async (req, res) => {
    const channelId = idSchema.parse(req.params.channelId);
    await channelScope(db, req.actor!, channelId);
    const query = cursorQuerySchema.parse(req.query);
    const cursor = query.cursor ? await db.collection("messages").findOne({ _id: query.cursor, channelId }) : undefined;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Message cursor not found");
    const after = cursor ? { $or: [{ createdAt: { $gt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $gt: cursor._id } }] } : {};
    const items = await db.collection("messages").find({ channelId, ...after }).sort({ createdAt: 1, _id: 1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(items.slice(0, query.limit)), nextCursor: items.length > query.limit ? items[query.limit - 1]?._id : undefined } });
  });
  router.post("/channels/:channelId/messages", async (req, res) => {
    const result = await createChannelMessage(database, req.actor!, idSchema.parse(req.params.channelId), req.body, "api");
    res.status(result.replayed ? 200 : 201).json({ ok: true, data: jsonValue(result) });
  });
  router.get("/direct-messages/:userId", async (req, res) => {
    const otherId = idSchema.parse(req.params.userId);
    const actor = req.actor!;
    const items = await db.collection("messages").find({ workspaceId: actor.membership.workspaceId, dmKey: dmKey(actor.id, otherId) }).sort({ createdAt: 1 }).limit(100).toArray();
    res.json({ ok: true, data: jsonValue(items) });
  });
  router.post("/direct-messages", async (req, res) => {
    const input = createDirectMessageSchema.parse(req.body);
    const actor = req.actor!;
    const recipient = await db.collection("memberships").findOne({ workspaceId: actor.membership.workspaceId, userId: input.recipientId, status: "active" });
    if (!recipient) throw new AppError(404, "NOT_FOUND", "Recipient not found");
    const message = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, dmKey: dmKey(actor.id, input.recipientId), authorId: actor.id, ...input, createdAt: new Date() };
    await atomic(database, async (session) => {
      await db.collection("messages").insertOne(message, { session });
      await event(db, actor, "direct_message.created", message, { audienceUserIds: [actor.id, input.recipientId] }, session);
      await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.recipientId, type: "message", title: `Message from ${actor.name}`, body: input.body.slice(0, 500), resourceType: "message", resourceId: message._id, idempotencyKey: `dm:${message._id}:${input.recipientId}`, state: "pending", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date(), updatedAt: new Date() }, { session });
    });
    res.status(201).json({ ok: true, data: jsonValue(message) });
  });
  router.get("/events", async (req, res) => {
    const actor = req.actor!;
    const after = typeof req.query.after === "string" ? idSchema.parse(req.query.after) : undefined;
    const cursor = after ? await db.collection("events").findOne({ _id: after, workspaceId: actor.membership.workspaceId }) : undefined;
    if (after && (!cursor || !eventAccessible(cursor, actor))) throw new AppError(404, "NOT_FOUND", "Event cursor not found");
    const audience = actor.membership.role === "admin"
      ? { $or: [{ audienceUserIds: actor.id }, { groupId: { $exists: true }, audienceUserIds: { $exists: false } }] }
      : { $or: [{ audienceUserIds: actor.id }, { groupId: { $in: actor.membership.groupIds }, audienceUserIds: { $exists: false } }] };
    const afterFilter = cursor ? { $or: [{ occurredAt: { $gt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, _id: { $gt: cursor._id } }] } : {};
    const events = await db.collection("events").find({ workspaceId: actor.membership.workspaceId, $and: [audience, afterFilter] }).sort({ occurredAt: 1, _id: 1 }).limit(500).toArray();
    res.json({ ok: true, data: jsonValue(events) });
  });
  return router;
}

export function attachRealtime(server: HttpServer, database: Database, resolveActor: ReturnType<typeof createActorResolver>, appOrigin: string): Server {
  const io = new Server(server, { cors: { origin: appOrigin, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const actor = await resolveActor(socket.request.headers);
      if (!actor) return next(new Error("UNAUTHENTICATED"));
      socket.data.actor = actor;
      socket.data.authHeaders = socket.request.headers;
      next();
    } catch { next(new Error("UNAUTHENTICATED")); }
  });
  io.on("connection", (socket) => {
    const actor = socket.data.actor as Actor;
    socket.join(`user:${actor.membership.workspaceId}:${actor.id}`);
    socket.on("channel:join", async (channelId: string, reply: (value: unknown) => void) => {
      try { const fresh = await resolveActor(socket.request.headers); if (!fresh) throw new Error("UNAUTHENTICATED"); await channelScope(database.db, fresh, idSchema.parse(channelId)); const room = `channel:${channelId}`; await socket.join(room); await emitAuthorizedPresence(io, database.db, resolveActor, channelId, fresh.id, "online"); reply({ ok: true }); }
      catch { reply({ ok: false, error: { code: "FORBIDDEN", message: "Channel access denied" } }); }
    });
    socket.on("message:create", async (input: { channelId: string; body: unknown }, reply: (value: unknown) => void) => {
      try {
        const fresh = await resolveActor(socket.request.headers);
        if (!fresh) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
        const result = await createChannelMessage(database, fresh, idSchema.parse(input.channelId), input.body, "socket");
        if (!result.replayed) {
          await emitAuthorizedToChannel(io, database.db, resolveActor, input.channelId, jsonValue(result.event));
          for (const userId of result.message.mentionUserIds) io.to(`user:${fresh.membership.workspaceId}:${userId}`).emit("notification:pending", { type: "mention", messageId: result.message._id });
        }
        reply({ ok: true, data: jsonValue(result.message) });
      } catch (error) { reply({ ok: false, error: { code: error instanceof AppError ? error.code : "BAD_REQUEST", message: error instanceof Error ? error.message : "Invalid message" } }); }
    });
    socket.on("disconnecting", async () => {
      for (const room of socket.rooms) {
        if (!room.startsWith("channel:")) continue;
        const channelId = room.slice("channel:".length);
        const peers = await io.in(room).fetchSockets();
        let hasAuthorizedSameUserPeer = false;
        for (const peer of peers) {
          if (peer.id === socket.id) continue;
          try {
            const fresh = await resolveActor(peer.data.authHeaders);
            if (!fresh) throw new Error("UNAUTHENTICATED");
            await channelScope(database.db, fresh, channelId);
            if (fresh.id === actor.id) hasAuthorizedSameUserPeer = true;
          } catch { await peer.leave(room); }
        }
        if (!hasAuthorizedSameUserPeer) await emitAuthorizedPresence(io, database.db, resolveActor, channelId, actor.id, "offline");
      }
    });
  });
  return io;
}

function eventAccessible(value: Record<string, any>, actor: Actor): boolean {
  if (Array.isArray(value.audienceUserIds)) return value.audienceUserIds.includes(actor.id);
  if (typeof value.groupId === "string") return actor.membership.role === "admin" || actor.membership.groupIds.includes(value.groupId);
  return false;
}

async function emitAuthorizedToChannel(io: Server, db: AppDb, resolveActor: ReturnType<typeof createActorResolver>, channelId: string, value: unknown): Promise<void> {
  const sockets = await io.in(`channel:${channelId}`).fetchSockets();
  for (const socket of sockets) {
    try {
      const actor = await resolveActor(socket.data.authHeaders);
      if (!actor) throw new Error("UNAUTHENTICATED");
      await channelScope(db, actor, channelId);
      socket.emit("event", value);
    } catch { await socket.leave(`channel:${channelId}`); }
  }
}

async function emitAuthorizedPresence(io: Server, db: AppDb, resolveActor: ReturnType<typeof createActorResolver>, channelId: string, userId: string, state: "online" | "offline"): Promise<void> {
  const room = `channel:${channelId}`;
  const sockets = await io.in(room).fetchSockets();
  for (const socket of sockets) {
    try {
      const actor = await resolveActor(socket.data.authHeaders);
      if (!actor) throw new Error("UNAUTHENTICATED");
      await channelScope(db, actor, channelId);
      socket.emit("presence:update", { userId, state });
    } catch { await socket.leave(room); }
  }
}
