import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import type { ErrorCode } from "@venture-studio/contracts";
import type { AppDb } from "./db.js";
import { audit } from "./audit.js";

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: ErrorCode, message: string) { super(message); }
}

export function createErrorHandler(db: AppDb) { return async function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): Promise<void> {
  const auditIdentity = req.actor ? { workspaceId: req.actor.membership.workspaceId, actorId: req.actor.id } : req.identity && req.auditWorkspaceId ? { workspaceId: req.auditWorkspaceId, actorId: req.identity.id } : undefined;
  if (error instanceof ZodError) {
    if (auditIdentity) await audit(db, { ...auditIdentity, channel: req.interfaceChannel, action: `${req.method} ${req.path}`, objectType: "request", result: "validation_failure", metadata: { issueCount: error.issues.length } });
    res.status(400).json({ ok: false, error: { code: "BAD_REQUEST", message: "Request validation failed", requestId: req.id, issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
    return;
  }
  if (error instanceof AppError) {
    if (auditIdentity && [400, 401, 403, 404, 409, 429].includes(error.status)) await audit(db, { ...auditIdentity, channel: req.interfaceChannel, action: `${req.method} ${req.path}`, objectType: "request", result: [401, 403, 429].includes(error.status) ? "denied" : "failure", metadata: { code: error.code } });
    res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message, requestId: req.id } });
    return;
  }
  console.error(JSON.stringify({ level: "error", requestId: req.id, error: error instanceof Error ? error.message : "unknown" }));
  res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "An internal error occurred", requestId: req.id } });
}; }
