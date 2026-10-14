import { Router } from "express";
import { MAX_SEARCH_KEYS, salesSearchEngineSchema, salesSearchKeyIdSchema, salesSearchKeyInputSchema, type SalesSearchEngine, type SalesSearchKeyTest } from "@venture-studio/contracts";
import type { AppConfig } from "../config.js";
import { atomic, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { overLimit } from "../middleware.js";
import { forbidClaude, forbidden } from "../sales/access.js";
import { auditSales, salesCtx, type SalesCtx } from "../sales/ctx.js";
import { SEARCH_CAPS, SearchError, markRefused, reserveSearch, searchExa, searchTinyfish } from "../sales/search-engines.js";
import { addSearchKey, forgetSearchKeys, removeSearchKey, resolveSearchKeys, searchKeyStatus } from "../sales/search-keys.js";

const ok = (data: unknown) => ({ ok: true, data });
const LABEL: Record<SalesSearchEngine, string> = { tinyfish: "TinyFish", exa: "Exa" };
// One small search per test: a few results, so a test costs one call against the key's allowance.
const TEST_QUERY = "software companies in Bengaluru";
const TESTS_PER_MINUTE = 5;

/**
 * The company-search keys (TinyFish, Exa) behind search_companies and the lead finder, for the whole workspace: up to 10 per engine, tried in
 * order. Admins only, in the app: they see the status, add or remove a key (encrypted, see sales/search-keys.ts) and run one small test
 * search with a key. No route ever returns a key or any part of it beyond its last four characters, and the audit log records only the
 * engine and the key's id.
 */
export function salesSearchKeyRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();
  const admin = (ctx: SalesCtx, what: string) => { if (ctx.actor.membership.role !== "admin") throw forbidden(`Only an admin can ${what}`); };

  router.get("/search-keys", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "see the company-search keys");
    res.json(ok(await searchKeyStatus(db, ctx.workspaceId, config)));
  });

  // Adds one key after the engine's others. Saved keys replace the server's at once (the cache in this process is cleared).
  router.post("/search-keys/:engine", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "change the company-search keys");
    forbidClaude(ctx.via, "Changing the company-search keys");
    const engine = salesSearchEngineSchema.parse(req.params.engine);
    const { key } = salesSearchKeyInputSchema.parse(req.body ?? {});
    await atomic(database, async (session) => {
      const result = await addSearchKey(db, ctx.workspaceId, engine, key, config.BETTER_AUTH_SECRET, ctx.actor.id, session);
      if ("refused" in result) throw new AppError(409, "CONFLICT", result.refused === "duplicate" ? `That ${LABEL[engine]} key is already saved` : `${LABEL[engine]} already has ${MAX_SEARCH_KEYS} keys: remove one first`);
      await auditSales(ctx, "sales.search_key.add", "sales_search_keys", ctx.workspaceId, undefined, { engine, keyId: result.added }, session);
    });
    forgetSearchKeys(db, ctx.workspaceId);
    res.json(ok(await searchKeyStatus(db, ctx.workspaceId, config)));
  });

  // Removes one saved key; with none left the server's keys (if any) are used again. Removing a key that isn't saved changes nothing.
  router.delete("/search-keys/:engine/:keyId", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "change the company-search keys");
    forbidClaude(ctx.via, "Changing the company-search keys");
    const engine = salesSearchEngineSchema.parse(req.params.engine);
    const keyId = salesSearchKeyIdSchema.parse(req.params.keyId);
    await atomic(database, async (session) => {
      if (await removeSearchKey(db, ctx.workspaceId, engine, keyId, session)) await auditSales(ctx, "sales.search_key.remove", "sales_search_keys", ctx.workspaceId, undefined, { engine, keyId }, session);
    });
    forgetSearchKeys(db, ctx.workspaceId);
    res.json(ok(await searchKeyStatus(db, ctx.workspaceId, config)));
  });

  // One small search with one key in use (saved in the app, else the server's), counted against that key's allowance even while it is
  // paused after a refusal: a test that works clears the pause, so search uses the key again; a refusal pauses it for an hour. Answers { ok } or
  // { ok: false, message } with the engines' short messages, which carry no URL, header, response body or key.
  router.post("/search-keys/:engine/:keyId/test", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "test the company-search keys");
    forbidClaude(ctx.via, "Testing the company-search keys");
    const engine = salesSearchEngineSchema.parse(req.params.engine);
    const keyId = salesSearchKeyIdSchema.parse(req.params.keyId);
    const wait = await overLimit(db, `sales-search-key-test:${ctx.actor.id}`, TESTS_PER_MINUTE);
    if (wait) { res.setHeader("retry-after", String(wait)); throw new AppError(429, "RATE_LIMITED", `Too many key tests in a minute; try again in ${wait} s`); }
    const key = (await resolveSearchKeys(db, ctx.workspaceId, config))[engine].find((entry) => entry.id === keyId)?.key;
    let result: SalesSearchKeyTest;
    const countedAt = new Date();
    if (!key) result = { ok: false, message: `That ${LABEL[engine]} key isn't in use: it was removed, can't be read, or a key saved in the app replaces it` };
    else if (!(await reserveSearch(db, ctx.workspaceId, engine, keyId, SEARCH_CAPS[engine].limit, true, countedAt))) result = { ok: false, message: `This ${LABEL[engine]} key has used its ${SEARCH_CAPS[engine].period === "day" ? "daily" : "monthly"} allowance` };
    else {
      try {
        await (engine === "tinyfish" ? searchTinyfish(key, TEST_QUERY, "IN", 1) : searchExa(key, TEST_QUERY, "IN", 1));
        await markRefused(db, ctx.workspaceId, engine, keyId, false, countedAt);
        result = { ok: true };
      } catch (error) {
        if (error instanceof SearchError && error.reason === "refused") await markRefused(db, ctx.workspaceId, engine, keyId, true, countedAt);
        result = { ok: false, message: error instanceof Error ? error.message : "The test search failed" };
      }
    }
    await auditSales(ctx, "sales.search_key.test", "sales_search_keys", ctx.workspaceId, undefined, { engine, keyId });
    res.json(ok(result));
  });

  return router;
}
