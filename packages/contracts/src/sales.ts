import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

export const pipelineInputSchema = z.object({ ventureId: idSchema, name: z.string().trim().min(1).max(120), offerName: z.string().trim().min(1).max(200), status: z.enum(["active", "paused", "archived"]).default("active") });
// Zod keeps .default() values inside .partial(); updates override defaulted fields so an omitted field is never overwritten.
export const updatePipelineSchema = pipelineInputSchema.omit({ ventureId: true }).extend({ status: z.enum(["active", "paused", "archived"]) }).partial().refine((value) => Object.keys(value).length > 0);
export const pipelineSchema = pipelineInputSchema.extend({ id: idSchema, workspaceId: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema });

export const opportunityInputSchema = z.object({ pipelineId: idSchema, companyName: z.string().trim().min(1).max(200), contactName: z.string().trim().max(200).default(""), source: z.string().trim().max(500), observedSignal: z.string().trim().max(2_000), fitReason: z.string().trim().max(2_000), evidenceConfidence: z.enum(["low", "medium", "high"]), stage: z.enum(["identified", "qualified", "contacted", "conversation", "proposal", "won", "lost"]), ownerId: idSchema, nextAction: z.string().trim().max(1_000), nextActionAt: isoDateSchema.optional(), valueEstimateMinor: z.number().int().nonnegative().optional(), currency: z.string().length(3).optional() });
export const updateOpportunitySchema = opportunityInputSchema.omit({ pipelineId: true }).extend({ contactName: z.string().trim().max(200) }).partial().refine((value) => Object.keys(value).length > 0);
export const opportunitySchema = opportunityInputSchema.extend({ id: idSchema, workspaceId: idSchema, ventureId: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema });
