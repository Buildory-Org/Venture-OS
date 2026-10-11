import express, { Router } from "express";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { AppError } from "../errors.js";
import { ACCOUNTS } from "../sales/channels/accounts.js";
import { configureMeta } from "../sales/channels/meta/graph.js";
import { handleMetaDelivery } from "../sales/channels/meta/webhook.js";

/**
 * Meta's webhook for WhatsApp and Instagram (no session: the signature is the proof): docs/sales-channels.md section 6. Mounted before the
 * session gate with a per-address rate limit; app.ts leaves the body unparsed here, so the signature is checked against the exact bytes.
 */
export function salesWebhookRoutes(database: Database, config: AppConfig): Router {
  configureMeta({ graphVersion: config.META_GRAPH_VERSION });
  const router = Router();

  // Meta's handshake when someone saves the callback address in the Meta app: the verify token must be one of our WhatsApp or Instagram
  // accounts' tokens, and the answer is the challenge as plain text.
  router.get("/meta", async (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && typeof token === "string" && token.length >= 8 && token.length <= 200 && typeof challenge === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(challenge)) {
      const account = await database.db.collection(ACCOUNTS).findOne({ verifyToken: token, kind: { $in: ["whatsapp", "instagram"] } }, { projection: { _id: 1 } });
      if (account) { res.status(200).type("text/plain").send(challenge); return; }
    }
    throw new AppError(403, "FORBIDDEN", "That verify token doesn't belong to a connected WhatsApp or Instagram account");
  });

  // A delivery (messages, statuses). Answered once it is verified and processed; processing problems are logged and audited, never returned.
  router.post("/meta", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const answer = await handleMetaDelivery(database, config, raw, req.get("x-hub-signature-256"));
    if (answer.status !== 200) throw new AppError(answer.status, answer.status === 401 ? "UNAUTHENTICATED" : answer.status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", answer.message);
    res.status(200).json({ ok: true, data: { received: true } });
  });

  return router;
}
