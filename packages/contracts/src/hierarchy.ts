import { z } from "zod";
import { appRoleSchema, idSchema, isoDateSchema, successEnvelope } from "./common.js";

export const workspaceSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  createdAt: isoDateSchema,
});

export const ventureSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1).max(120),
  status: z.enum(["active", "parked", "archived"]),
  goal30Day: z.string().max(500).default(""),
  health: z.number().int().min(0).max(100).optional(),
  createdAt: isoDateSchema,
});

export const groupSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  ventureId: idSchema,
  name: z.string().min(1).max(120),
  createdAt: isoDateSchema,
});

export const channelSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  ventureId: idSchema,
  groupId: idSchema,
  name: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  createdAt: isoDateSchema,
});
export const createChannelSchema = z.object({ groupId: idSchema, name: z.string().trim().min(1).max(80) });
export const updateMembershipSchema = z.object({ role: appRoleSchema, ventureIds: z.array(idSchema).max(100), groupIds: z.array(idSchema).max(500) });

export const membershipSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  role: appRoleSchema,
  ventureIds: z.array(idSchema),
  groupIds: z.array(idSchema),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export const memberDirectoryItemSchema = z.object({ id: idSchema, name: z.string(), handle: z.string().optional(), role: appRoleSchema });
export const memberDirectoryQuerySchema = z.object({
  ventureId: idSchema.optional(), groupId: idSchema.optional(), handle: z.string().trim().min(1).max(80).optional(),
  q: z.string().trim().min(2).max(80).optional(), cursor: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const hierarchySchema = z.object({
  workspace: workspaceSchema,
  ventures: z.array(ventureSchema.extend({
    groups: z.array(groupSchema.extend({ channels: z.array(channelSchema) })),
  })),
});

export const sessionBootstrapSchema = z.object({
  user: z.object({ id: idSchema, name: z.string(), email: z.email() }),
  membership: membershipSchema,
  hierarchy: hierarchySchema,
});
export const sessionBootstrapResponseSchema = successEnvelope(sessionBootstrapSchema);

export type Membership = z.infer<typeof membershipSchema>;
