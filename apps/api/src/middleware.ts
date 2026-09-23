import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { AppDb } from "./db.js";
import { membershipSchema, type Membership } from "@venture-studio/contracts";
import { can, type Action } from "@venture-studio/core";
import type { AppConfig } from "./config.js";
import type { Auth } from "./auth.js";
import { AppError } from "./errors.js";
import { audit } from "./audit.js";

type Actor = { id: string; email: string; name: string; membership: Membership };

function membershipValue(document: Record<string, unknown>): Membership {
  return membershipSchema.parse({ ...document, id: document._id, createdAt: (document.createdAt as Date).toISOString(), updatedAt: (document.updatedAt as Date).toISOString() });
}

export function createActorResolver(auth: Auth, db: AppDb, config: AppConfig) {
  const resolveIdentity = createIdentityResolver(auth, db, config);
  return async (headers: IncomingHttpHeaders): Promise<Actor | undefined> => {
    const user = await resolveIdentity(headers);
    if (!user) return undefined;
    const memberships = await db.collection("memberships").find({ userId: user.id, status: "active" }).limit(2).toArray();
    if (memberships.length !== 1) return undefined;
    return { ...user, membership: membershipValue(memberships[0]!) };
  };
}

export function createIdentityResolver(auth: Auth, db: AppDb, config: AppConfig) {
  return async (headers: IncomingHttpHeaders): Promise<{ id: string; email: string; name: string } | undefined> => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    let user = session?.user;
    if (!user && config.ALLOW_DEV_AUTH && config.APP_MODE === "local") {
      const id = headers["x-dev-user-id"];
      if (typeof id === "string") {
        const seeded = await db.collection("users").findOne({ _id: id, status: "active" });
        if (seeded) user = { id, email: String(seeded.email), name: String(seeded.name), emailVerified: true, createdAt: new Date(), updatedAt: new Date(), image: null };
      }
    }
    if (!user) return undefined;
    return { id: user.id, email: user.email, name: user.name };
  };
}

export function requireIdentity(resolveIdentity: ReturnType<typeof createIdentityResolver>) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const identity = await resolveIdentity(req.headers);
      if (!identity) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
      req.identity = identity;
      next();
    } catch (error) { next(error); }
  };
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.id = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 100) : randomUUID();
  req.interfaceChannel = "api";
  res.setHeader("x-request-id", req.id);
  const startedAt = Date.now();
  res.on("finish", () => console.info(JSON.stringify({ level: "info", requestId: req.id, method: req.method, path: req.path.replace(/\/local-objects\/[^/]+/i, "/local-objects/[redacted]"), status: res.statusCode, durationMs: Date.now() - startedAt })));
  next();
}

export function requireActor(resolveActor: ReturnType<typeof createActorResolver>) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = await resolveActor(req.headers);
      if (!actor) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
      req.actor = actor;
      next();
    } catch (error) { next(error); }
  };
}

export function authorize(db: AppDb, action: Action, scope: (req: Request) => { ventureId?: string; groupId?: string } = () => ({})) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const actor = req.actor;
    if (!actor) return next(new AppError(401, "UNAUTHENTICATED", "Authentication required"));
    const requestedScope = scope(req);
    if (!can(actor.membership, action, requestedScope)) {
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action, objectType: "scope", ventureId: requestedScope.ventureId, result: "denied" });
      return next(new AppError(403, "FORBIDDEN", "You do not have access to this resource"));
    }
    next();
  };
}

export function rateLimit(db: AppDb, max: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const now = Date.now();
    const key = req.actor?.id ?? req.ip ?? "unknown";
    const windowStart = Math.floor(now / windowMs) * windowMs;
    try {
      const entry = await db.collection("api_rate_limits").findOneAndUpdate(
        { _id: `${key}:${windowStart}` },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs), createdAt: new Date(now) } },
        { upsert: true, returnDocument: "after" },
      );
      const count = Number(entry?.count ?? 1);
      res.setHeader("x-ratelimit-remaining", Math.max(0, max - count));
      if (count > max) return next(new AppError(429, "RATE_LIMITED", "Too many requests"));
      next();
    } catch (error) { next(error); }
  };
}
