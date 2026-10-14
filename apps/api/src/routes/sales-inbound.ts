import { Router } from "express";
import { idSchema, inboundAttachSchema } from "@venture-studio/contracts";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { AppError } from "../errors.js";
import { forbidClaude, forbidden } from "../sales/access.js";
import { canUseAccount, loadAccount, openSecrets } from "../sales/channels/accounts.js";
import { configureMeta } from "../sales/channels/meta/graph.js";
import { attachConversation, dismissConversation, listConversations } from "../sales/channels/meta/inbound.js";
import { listTemplates } from "../sales/channels/meta/templates.js";
import { salesCtx } from "../sales/ctx.js";

const ok = (data: unknown) => ({ ok: true, data });
const inboundQuerySchema = z.object({ ventureId: idSchema.optional() });

/**
 * WhatsApp and Instagram conversations from people who are not leads yet (link to a lead, or dismiss), and a WhatsApp account's approved
 * templates: docs/sales-channels.md sections 1 and 6. Session only: changes are a person's in the app, and Claude's connector never reaches
 * these routes.
 */
export function salesInboundRoutes(database: Database, config: AppConfig): Router {
  configureMeta({ graphVersion: config.META_GRAPH_VERSION });
  const router = Router();

  router.get("/inbound", async (req, res) => {
    const ctx = salesCtx(database, req);
    // Claude can't reach these routes (the MCP allowlist), and strangers' messages stay out of its reach even if that changed.
    forbidClaude(ctx.via, "Reading new conversations");
    const { ventureId } = inboundQuerySchema.parse(req.query);
    res.json(ok(await listConversations(ctx, ventureId)));
  });

  router.post("/inbound/:id/attach", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Linking a conversation to a lead");
    const { leadId } = inboundAttachSchema.parse(req.body ?? {});
    res.json(ok(await attachConversation(ctx, idSchema.parse(req.params.id), leadId)));
  });

  router.post("/inbound/:id/dismiss", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Dismissing a conversation");
    res.json(ok(await dismissConversation(ctx, idSchema.parse(req.params.id))));
  });

  // The approved templates a WhatsApp number can send outside the 24-hour window, for people who send through it (cached 10 minutes).
  router.get("/channels/:id/templates", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Reading WhatsApp templates");
    const account = await loadAccount(ctx, idSchema.parse(req.params.id));
    if (account.kind !== "whatsapp") throw new AppError(409, "CONFLICT", "Message templates belong to WhatsApp accounts");
    const ventures = Array.isArray(account.ventureIds) ? account.ventureIds.map(String) : [];
    if (!ventures.some((ventureId) => canUseAccount(ctx.actor, account, ventureId))) {
      if (account.enabled === false) throw new AppError(409, "CONFLICT", "That WhatsApp account is switched off");
      throw forbidden("You can't send through this WhatsApp account");
    }
    const secrets = openSecrets(config, account);
    if (!secrets.accessToken) throw new AppError(409, "CONFLICT", "This WhatsApp account's access token can't be read: reconnect it in Sales > Channels");
    const listed = await listTemplates(account, secrets);
    if (!listed.ok) throw new AppError(502, "INTEGRATION_UNAVAILABLE", listed.error);
    res.json(ok(listed.templates.map(({ name, language, status, category, body, variableCount }) => ({ name, language, status, ...(category ? { category } : {}), body, variableCount }))));
  });

  return router;
}
