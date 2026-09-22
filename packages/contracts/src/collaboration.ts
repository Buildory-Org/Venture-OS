import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema } from "./common.js";

export const messageSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  channelId: idSchema.optional(),
  dmKey: z.string().optional(),
  authorId: idSchema,
  body: z.string().min(1).max(10_000),
  mentionUserIds: z.array(idSchema).default([]),
  threadRootId: idSchema.optional(),
  createdAt: isoDateSchema,
  editedAt: isoDateSchema.optional(),
});

export const createChannelMessageSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  mentionUserIds: z.array(idSchema).max(50).default([]),
  threadRootId: idSchema.optional(),
  clientId: z.string().min(8).max(120),
});

export const createDirectMessageSchema = createChannelMessageSchema.extend({
  recipientId: idSchema,
});

export const messageListQuerySchema = cursorQuerySchema.extend({ afterEventId: idSchema.optional() });

export const notificationSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  type: z.enum(["mention", "assignment", "reminder", "deadline_warning", "message"]),
  title: z.string(),
  body: z.string(),
  resourceType: z.string(),
  resourceId: idSchema,
  readAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
});

export type Message = z.infer<typeof messageSchema>;
