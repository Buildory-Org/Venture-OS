import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema } from "./common.js";

export const messageSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  ventureId: idSchema.optional(),
  groupId: idSchema.optional(),
  channelId: idSchema.optional(),
  dmKey: z.string().optional(),
  authorId: idSchema,
  body: z.string().min(1).max(10_000),
  mentionUserIds: z.array(idSchema).default([]),
  threadRootId: idSchema.optional(),
  createdAt: isoDateSchema,
  editedAt: isoDateSchema.optional(),
  pinnedAt: isoDateSchema.optional(),
  pinnedBy: idSchema.optional(),
  pinned: z.boolean().optional(),
  savedByMe: z.boolean().optional(),
  reactions: z.record(z.string(), z.number().int().nonnegative()).optional(),
  myReactions: z.array(z.string()).optional(),
});
export const reactionUpdateSchema = z.object({ emoji: z.string().trim().min(1).max(32), active: z.boolean() });
export const saveUpdateSchema = z.object({ saved: z.boolean() });
export const pinUpdateSchema = z.object({ pinned: z.boolean() });

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
  reminderId: idSchema.optional(),
  readAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
});
export const notificationPreferencesSchema = z.object({ email: z.boolean(), webPush: z.boolean(), mentions: z.boolean(), messages: z.boolean(), assignments: z.boolean(), reminders: z.boolean() });

export type Message = z.infer<typeof messageSchema>;
