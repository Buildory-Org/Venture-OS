import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema } from "./common.js";

export const fileSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), groupId: idSchema.optional(), taskId: idSchema.optional(), recipientId: idSchema.optional(),
  ownerId: idSchema, name: z.string().min(1).max(255), contentType: z.string().min(1).max(120),
  size: z.number().int().min(1).max(25 * 1024 * 1024), objectKey: z.string(),
  status: z.enum(["pending", "ready", "abandoned", "deleted"]),
  createdAt: isoDateSchema, completedAt: isoDateSchema.optional(),
});
export const groupFileSchema = fileSchema.omit({ objectKey: true });

export const uploadIntentSchema = z.object({
  ventureId: idSchema.optional(), groupId: idSchema.optional(), taskId: idSchema.optional(), recipientId: idSchema.optional(), name: z.string().trim().min(1).max(255),
  contentType: z.enum(["application/pdf", "text/markdown", "text/plain", "image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav"]),
  size: z.number().int().min(1).max(25 * 1024 * 1024),
}).refine((value) => Boolean(value.ventureId) !== Boolean(value.recipientId), { message: "Choose a venture or a direct-message recipient" })
  .refine((value) => !value.recipientId || (!value.groupId && !value.taskId), { message: "Direct-message uploads cannot have a group or task" })
  .refine((value) => !value.taskId || Boolean(value.groupId), { message: "Task attachments require a group", path: ["groupId"] });
export const uploadCompleteSchema = z.object({ etag: z.string().min(1).max(200) });

export const searchQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().min(2).max(200), ventureId: idSchema.optional(), groupId: idSchema.optional(),
  types: z.array(z.enum(["message", "task", "file"])).default(["message", "task", "file"]),
});

export const patCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(["today:read", "ventures:read", "tasks:read", "messages:read", "files:read", "knowledge:read", "classes:read", "decisions:read"])).min(1),
  expiresAt: isoDateSchema.optional(),
});

export const patSchema = z.object({
  id: idSchema, workspaceId: idSchema, userId: idSchema, name: z.string(),
  prefix: z.string(), scopes: patCreateSchema.shape.scopes, createdAt: isoDateSchema,
  expiresAt: isoDateSchema.optional(), revokedAt: isoDateSchema.optional(), lastUsedAt: isoDateSchema.optional(),
});
