import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema } from "./common.js";

export const evidenceClassSchema = z.enum(["verified_fact", "founder_reported", "approved_decision", "planning_assumption", "hypothesis", "open_question", "historical"]);
export const sensitivitySchema = z.enum(["team", "venture_restricted", "manager", "founder_private"]);

export const documentSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200),
  slug: z.string().min(1).max(160), ownerId: idSchema, status: z.enum(["draft", "approved", "stale", "archived"]),
  evidenceClass: evidenceClassSchema, sensitivity: sensitivitySchema, authoritativeRank: z.number().int().min(0).max(100),
  currentVersionId: idSchema, lastReviewedAt: isoDateSchema.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});

export const documentVersionSchema = z.object({
  id: idSchema, workspaceId: idSchema, documentId: idSchema, version: z.number().int().positive(),
  markdown: z.string().min(1).max(2_000_000), changeSummary: z.string().min(1).max(500),
  createdBy: idSchema, createdAt: isoDateSchema, sourceUri: z.url().optional(),
});

export const createDocumentSchema = z.object({
  ventureId: idSchema.optional(), title: z.string().trim().min(1).max(200), markdown: z.string().min(1).max(2_000_000),
  evidenceClass: evidenceClassSchema, sensitivity: sensitivitySchema, authoritativeRank: z.number().int().min(0).max(100).default(50),
  sourceUri: z.url().optional(), changeSummary: z.string().trim().min(1).max(500).default("Initial version"),
});

export const updateDocumentSchema = z.object({
  markdown: z.string().min(1).max(2_000_000), changeSummary: z.string().trim().min(1).max(500), sourceUri: z.url().optional(),
});

export const knowledgeSearchSchema = cursorQuerySchema.extend({
  q: z.string().trim().min(2).max(200), ventureId: idSchema.optional(), evidenceClasses: z.array(evidenceClassSchema).optional(),
});

export const decisionSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200),
  text: z.string().min(1).max(10_000), ownerId: idSchema, decidedAt: isoDateSchema, evidence: z.array(z.string()).max(100),
  reason: z.string().min(1).max(5_000), affectedWork: z.array(idSchema).max(100), reviewTrigger: z.string().max(1_000),
  status: z.enum(["draft", "approved", "superseded", "stale"]), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});

export const informationRequestSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema, requesterId: idSchema, respondentId: idSchema,
  question: z.string().min(1).max(5_000), purpose: z.string().min(1).max(2_000), dueAt: isoDateSchema,
  status: z.enum(["open", "answered", "reviewed", "closed"]), responseMarkdown: z.string().max(100_000).optional(),
  sourceRefs: z.array(z.string()).max(100), reviewedBy: idSchema.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});

export const classSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2_000), scheduledAt: isoDateSchema, durationMinutes: z.number().int().min(1).max(480),
  facilitatorId: idSchema, materialDocumentId: idSchema.optional(), participantIds: z.array(idSchema).max(100),
  status: z.enum(["scheduled", "completed", "cancelled"]), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});

export const classApplicationSchema = z.object({
  id: idSchema, workspaceId: idSchema, classId: idSchema, userId: idSchema, taskId: idSchema.optional(),
  exercise: z.string().min(1).max(5_000), evidenceItemId: idSchema.optional(), assessment: z.string().max(5_000).optional(),
  reviewerId: idSchema, nextGap: z.string().max(2_000).optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
