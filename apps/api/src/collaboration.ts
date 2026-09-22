import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Router } from "express";
import { Server } from "socket.io";
import type { ClientSession } from "mongodb";
import { createChannelMessageSchema, createDirectMessageSchema, cursorQuerySchema, idSchema, pinUpdateSchema, reactionUpdateSchema, saveUpdateSchema } from "@venture-studio/contracts";
import { can, dmKey } from "@venture-studio/core";
import type { AppDb, Database } from "./db.js";
import { atomic } from "./db.js";
import { audit } from "./audit.js";
import { AppError } from "./errors.js";
import { jsonValue } from "./json.js";
import type { createActorResolver } from "./middleware.js";

type Actor = NonNullable<Express.Request["actor"]>;
const publishers = new WeakMap<Database, (value: Record<string, unknown>) => Promise<void>>();
async function publish(database: Database, value?: Record<string, unknown>) {
  if (!value) return;
  try { await publishers.get(database)?.(value); }
  catch (error) { console.error(JSON.stringify({ level: "error", event: "realtime.publish_failed", eventId: value.eventId, error: error instanceof Error ? error.message : "unknown" })); }
}

async function channelScope(db: AppDb, actor: Actor, channelId: string) {
  const channel = await db.collection("channels").findOne({ _id: channelId, workspaceId: actor.membership.workspaceId });
  if (!channel || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(channel.ventureId)) || !actor.membership.groupIds.includes(String(channel.groupId))))) throw new AppError(404, "NOT_FOUND", "Channel not found");
  return channel;
}

async function messageScope(db: AppDb, actor: Actor, messageId: string) {
  const message = await db.collection("messages").findOne({ _id: messageId, workspaceId: actor.membership.workspaceId });
  if (!message) throw new AppError(404, "NOT_FOUND", "Message not found");
  if (message.channelId) await channelScope(db, actor, String(message.channelId));
  else if (!message.dmKey || message.dmKey !== dmKey(actor.id, String(message.authorId === actor.id ? message.recipientId : message.authorId))) throw new AppError(404, "NOT_FOUND", "Message not found");
  return message;
}

async function decorateMessages(db: AppDb, actor: Actor, messages: Record<string, any>[]) {
  if (!messages.length) return [];
  const ids = messages.map((message) => message._id);
  const [reactions, saves] = await Promise.all([
    db.collection("message_reactions").find({ messageId: { $in: ids } }).toArray(),
    db.collection("message_saves").find({ userId: actor.id, messageId: { $in: ids } }).project({ messageId: 1 }).toArray(),
  ]);
  const saved = new Set(saves.map((item) => item.messageId));
  return messages.map((message) => {
    const own = reactions.filter((item) => item.messageId === message._id && item.userId === actor.id).map((item) => String(item.emoji));
    const counts = new Map<string, number>();
    for (const item of reactions.filter((item) => item.messageId === message._id)) counts.set(String(item.emoji), (counts.get(String(item.emoji)) ?? 0) + 1);
    return { ...message, reactions: Object.fromEntries(counts), myReactions: own, savedByMe: saved.has(message._id), pinned: Boolean(message.pinnedAt) };
  });
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
  if (!can(actor.membership, "message:write", { ventureId: String(channel.ventureId), groupId: String(channel.groupId) })) throw new AppError(403, "FORBIDDEN", "You cannot post in this channel");
  const prior = await database.db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: parsed.clientId });
  if (prior) {
    if (prior.channelId !== channelId) throw new AppError(409, "CONFLICT", "Message client ID was already used in another channel");
    const priorEvent = await database.db.collection("events").findOne({ _id: prior._id, workspaceId: actor.membership.workspaceId, type: "message.created" });
    if (!priorEvent) throw new AppError(409, "CONFLICT", "Message retry is waiting for its event; retry shortly");
    return { message: prior, event: priorEvent, replayed: true };
  }
  const mentioned = [...new Set(parsed.mentionUserIds)];
  if (parsed.threadRootId) {
    const root = await database.db.collection("messages").findOne({ _id: parsed.threadRootId, workspaceId: actor.membership.workspaceId, channelId });
    if (!root || root.threadRootId) throw new AppError(400, "BAD_REQUEST", "Thread root must be a top-level message in this channel");
  }
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
    const actor = req.actor!;
    await channelScope(db, actor, channelId);
    const query = cursorQuerySchema.parse(req.query);
    const pinned = req.query.pinned === "true";
    const threadRootId = typeof req.query.threadRootId === "string" ? idSchema.parse(req.query.threadRootId) : undefined;
    const cursor = query.cursor ? await db.collection("messages").findOne({ _id: query.cursor, channelId }) : undefined;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Message cursor not found");
    const after = cursor ? { $or: [{ createdAt: { $gt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $gt: cursor._id } }] } : {};
    const items = await db.collection("messages").find({ workspaceId: actor.membership.workspaceId, channelId, ...(pinned ? { pinnedAt: { $exists: true } } : {}), ...(threadRootId ? { threadRootId } : {}), ...after }).sort({ createdAt: 1, _id: 1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(await decorateMessages(db, actor, items.slice(0, query.limit))), nextCursor: items.length > query.limit ? items[query.limit - 1]?._id : undefined } });
  });
  router.post("/channels/:channelId/messages", async (req, res) => {
    const result = await createChannelMessage(database, req.actor!, idSchema.parse(req.params.channelId), req.body, "api");
    if (!result.replayed) await publish(database, result.event);
    res.status(result.replayed ? 200 : 201).json({ ok: true, data: jsonValue({ ...result, message: (await decorateMessages(db, req.actor!, [result.message]))[0] }) });
  });
  router.get("/direct-messages/:userId", async (req, res) => {
    const otherId = idSchema.parse(req.params.userId);
    const actor = req.actor!;
    const items = await db.collection("messages").find({ workspaceId: actor.membership.workspaceId, dmKey: dmKey(actor.id, otherId) }).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    res.json({ ok: true, data: jsonValue(await decorateMessages(db, actor, items.reverse())) });
  });
  router.post("/direct-messages", async (req, res) => {
    const input = createDirectMessageSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "message:write")) throw new AppError(403, "FORBIDDEN", "You cannot send direct messages");
    const recipient = await db.collection("memberships").findOne({ workspaceId: actor.membership.workspaceId, userId: input.recipientId, status: "active" });
    if (!recipient) throw new AppError(404, "NOT_FOUND", "Recipient not found");
    const key = dmKey(actor.id, input.recipientId);
    const prior = await db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: input.clientId });
    if (prior) {
      if (prior.dmKey !== key) throw new AppError(409, "CONFLICT", "Message client ID was already used elsewhere");
      res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [prior]))[0]) });
      return;
    }
    if (input.threadRootId) {
      const root = await db.collection("messages").findOne({ _id: input.threadRootId, workspaceId: actor.membership.workspaceId, dmKey: key });
      if (!root || root.threadRootId) throw new AppError(400, "BAD_REQUEST", "Thread root must be a top-level message in this conversation");
    }
    const message = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, dmKey: key, authorId: actor.id, ...input, createdAt: new Date() };
    let createdEvent: Record<string, unknown> | undefined;
    try { await atomic(database, async (session) => {
      await db.collection("messages").insertOne(message, { session });
      createdEvent = await event(db, actor, "direct_message.created", message, { audienceUserIds: [actor.id, input.recipientId] }, session);
      await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.recipientId, type: "message", title: `Message from ${actor.name}`, body: input.body.slice(0, 500), resourceType: "message", resourceId: message._id, idempotencyKey: `dm:${message._id}:${input.recipientId}`, state: "pending", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date(), updatedAt: new Date() }, { session });
    }); } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const duplicate = await db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: input.clientId, dmKey: key });
      if (!duplicate) throw new AppError(409, "CONFLICT", "Concurrent message retry is not yet readable; retry shortly");
      res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [duplicate]))[0]) });
      return;
    }
    await publish(database, createdEvent);
    res.status(201).json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [message]))[0]) });
  });
  router.get("/messages/saved", async (req, res) => {
    const actor = req.actor!;
    const visible = [];
    for await (const save of db.collection("message_saves").find({ workspaceId: actor.membership.workspaceId, userId: actor.id }).sort({ createdAt: -1, _id: -1 })) {
      try { visible.push(await messageScope(db, actor, String(save.messageId))); }
      catch (error) { if (!(error instanceof AppError && error.status === 404)) throw error; }
      if (visible.length === 100) break;
    }
    res.json({ ok: true, data: jsonValue(await decorateMessages(db, actor, visible)) });
  });
  router.put("/messages/:id/reaction", async (req, res) => {
    const actor = req.actor!; const message = await messageScope(db, actor, idSchema.parse(req.params.id));
    if (!can(actor.membership, "message:write", message.channelId ? { ventureId: String(message.ventureId), groupId: String(message.groupId) } : {})) throw new AppError(403, "FORBIDDEN", "You cannot react to this message");
    const input = reactionUpdateSchema.parse(req.body);
    const changedEvent = await atomic(database, async (session) => {
      const existing = await db.collection("message_reactions").findOne({ messageId: message._id, userId: actor.id, emoji: input.emoji }, { session });
      if (Boolean(existing) === input.active) return undefined;
      if (input.active) await db.collection("message_reactions").updateOne({ messageId: message._id, userId: actor.id, emoji: input.emoji }, { $setOnInsert: { _id: randomUUID(), workspaceId: actor.membership.workspaceId, messageId: message._id, userId: actor.id, emoji: input.emoji, createdAt: new Date() } }, { upsert: true, session });
      else await db.collection("message_reactions").deleteOne({ messageId: message._id, userId: actor.id, emoji: input.emoji }, { session });
      return event(db, actor, "message.reaction", { messageId: message._id, emoji: input.emoji, active: input.active }, message.channelId ? { ventureId: message.ventureId, groupId: message.groupId, channelId: message.channelId } : { audienceUserIds: [message.authorId, message.recipientId] }, session);
    });
    await publish(database, changedEvent);
    res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [message]))[0]) });
  });
  router.put("/messages/:id/save", async (req, res) => {
    const actor = req.actor!; const message = await messageScope(db, actor, idSchema.parse(req.params.id));
    const { saved } = saveUpdateSchema.parse(req.body);
    if (saved) await db.collection("message_saves").updateOne({ messageId: message._id, userId: actor.id }, { $setOnInsert: { _id: randomUUID(), workspaceId: actor.membership.workspaceId, messageId: message._id, userId: actor.id, createdAt: new Date() } }, { upsert: true });
    else await db.collection("message_saves").deleteOne({ messageId: message._id, userId: actor.id });
    res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [message]))[0]) });
  });
  router.put("/messages/:id/pin", async (req, res) => {
    const actor = req.actor!; const message = await messageScope(db, actor, idSchema.parse(req.params.id));
    if (!message.channelId || (actor.membership.role !== "admin" && actor.membership.role !== "venture_head")) throw new AppError(403, "FORBIDDEN", "Only admins or venture heads may pin channel messages");
    const { pinned } = pinUpdateSchema.parse(req.body);
    const changedEvent = await atomic(database, async (session) => {
      const current = await db.collection("messages").findOne({ _id: message._id, workspaceId: actor.membership.workspaceId }, { session });
      if (Boolean(current?.pinnedAt) === pinned) return undefined;
      const now = new Date();
      await db.collection("messages").updateOne({ _id: message._id, workspaceId: actor.membership.workspaceId }, pinned ? { $set: { pinnedAt: now, pinnedBy: actor.id } } : { $unset: { pinnedAt: "", pinnedBy: "" } }, { session });
      const result = await event(db, actor, "message.pin", { messageId: message._id, pinned }, { ventureId: message.ventureId, groupId: message.groupId, channelId: message.channelId }, session);
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "message.pin", objectType: "message", objectId: String(message._id), ventureId: String(message.ventureId), result: "success" }, session);
      return result;
    });
    await publish(database, changedEvent);
    const current = await db.collection("messages").findOne({ _id: message._id, workspaceId: actor.membership.workspaceId });
    res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [current!]))[0]) });
  });
  router.get("/events", async (req, res) => {
    const actor = req.actor!;
    const after = typeof req.query.after === "string" ? idSchema.parse(req.query.after) : undefined;
    const cursor = after ? await db.collection("events").findOne({ _id: after, workspaceId: actor.membership.workspaceId }) : undefined;
    if (after && (!cursor || !eventAccessible(cursor, actor))) throw new AppError(404, "NOT_FOUND", "Event cursor not found");
    const audience = actor.membership.role === "admin"
      ? { $or: [{ audienceUserIds: actor.id }, { groupId: { $exists: true }, audienceUserIds: { $exists: false } }] }
      : { $or: [{ audienceUserIds: actor.id }, { groupId: { $in: actor.membership.groupIds }, ventureId: { $in: actor.membership.ventureIds }, audienceUserIds: { $exists: false } }] };
    const afterFilter = cursor ? { $or: [{ occurredAt: { $gt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, _id: { $gt: cursor._id } }] } : {};
    const events = await db.collection("events").find({ workspaceId: actor.membership.workspaceId, $and: [audience, afterFilter] }).sort({ occurredAt: 1, _id: 1 }).limit(500).toArray();
    res.json({ ok: true, data: jsonValue(events) });
  });
  return router;
}

export function attachRealtime(server: HttpServer, database: Database, resolveActor: ReturnType<typeof createActorResolver>, appOrigin: string): Server {
  const io = new Server(server, { cors: { origin: appOrigin, credentials: true } });
  publishers.set(database, async (value) => {
    if (typeof value.channelId === "string") await emitAuthorizedToChannel(io, database.db, resolveActor, value.channelId, jsonValue(value));
    else if (Array.isArray(value.audienceUserIds)) await emitAuthorizedToUsers(io, resolveActor, value, jsonValue(value));
  });
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
      try { const fresh = await resolveActor(socket.request.headers); if (!fresh) throw new Error("UNAUTHENTICATED"); await channelScope(database.db, fresh, idSchema.parse(channelId)); const room = `channel:${channelId}`; await socket.join(room); await emitAuthorizedPresence(io, database.db, resolveActor, channelId, fresh.id, "online"); if (typeof reply === "function") reply({ ok: true }); }
      catch { if (typeof reply === "function") reply({ ok: false, error: { code: "FORBIDDEN", message: "Channel access denied" } }); }
    });
    socket.on("message:create", async (input: { channelId: string; body: unknown }, reply: (value: unknown) => void) => {
      try {
        const fresh = await resolveActor(socket.request.headers);
        if (!fresh) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
        const result = await createChannelMessage(database, fresh, idSchema.parse(input.channelId), input.body, "socket");
        if (!result.replayed) {
          await publish(database, result.event);
          for (const userId of result.message.mentionUserIds) io.to(`user:${fresh.membership.workspaceId}:${userId}`).emit("notification:pending", { type: "mention", messageId: result.message._id });
        }
        if (typeof reply === "function") reply({ ok: true, data: jsonValue(result.message) });
      } catch (error) { if (typeof reply === "function") reply({ ok: false, error: { code: error instanceof AppError ? error.code : "BAD_REQUEST", message: error instanceof Error ? error.message : "Invalid message" } }); }
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

async function emitAuthorizedToUsers(io: Server, resolveActor: ReturnType<typeof createActorResolver>, value: Record<string, unknown>, payload: unknown): Promise<void> {
  for (const userId of value.audienceUserIds as string[]) {
    for (const socket of await io.in(`user:${value.workspaceId}:${userId}`).fetchSockets()) {
      const actor = await resolveActor(socket.data.authHeaders);
      if (actor && actor.id === userId && actor.membership.workspaceId === value.workspaceId) socket.emit("event", payload);
      else await socket.leave(`user:${value.workspaceId}:${userId}`);
    }
  }
}

function eventAccessible(value: Record<string, any>, actor: Actor): boolean {
  if (Array.isArray(value.audienceUserIds)) return value.audienceUserIds.includes(actor.id);
  if (typeof value.groupId === "string") return actor.membership.role === "admin" || (actor.membership.groupIds.includes(value.groupId) && actor.membership.ventureIds.includes(value.ventureId));
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
