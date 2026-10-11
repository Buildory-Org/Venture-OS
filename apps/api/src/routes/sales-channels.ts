import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { ClientSession } from "mongodb";
import {
  EMAIL_PROVIDER_PRESETS, channelAccountInputSchema, channelAccountQuerySchema, channelAccountTestSchema, channelAccountUpdateSchema, emailAccountSecretsSchema, emailAccountSettingsSchema, idSchema,
  instagramAccountSettingsSchema, linkedinAccountSettingsSchema, metaAccountSecretsSchema, whatsappAccountSettingsSchema, type ChannelAccountTest, type ChannelKind,
} from "@venture-studio/contracts";
import type { z } from "zod";
import type { AppConfig } from "../config.js";
import { atomic, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { overLimit } from "../middleware.js";
import { canSeeVenture, canWriteIn, forbidClaude, forbidden, isHeadOf, loadVenture } from "../sales/access.js";
import { ACCOUNTS, SECRET_NAMES, accountJson, canManageAccount, canSeeAccount, isPersonalKind, loadAccount, missingSecrets, newVerifyToken, openSecrets, sealSecret } from "../sales/channels/accounts.js";
import { providerFor } from "../sales/channels/provider.js";
import { auditSales, salesCtx, type SalesCtx } from "../sales/ctx.js";
import { salesDraftSendRoutes } from "./sales-drafts.js";

const ok = (data: unknown) => ({ ok: true, data });
const TESTS_PER_MINUTE = 5;
/** A connection test's own limit (both mail servers are tried at once within it), and the route's hard stop: inside the web app's proxy limit. */
const TEST_TIMEOUT_MS = 35_000;
const TEST_ROUTE_LIMIT_MS = 40_000;
/** Mailboxes one person may connect: each is read every few minutes, so one person can't make the inbox sync slow for everyone. */
export const MAX_MAILBOXES_PER_PERSON = 5;

/** Each kind's settings and secrets, checked against the account's own kind (a PATCH can't turn a mailbox into a WhatsApp number). */
const SETTINGS: Record<ChannelKind, z.ZodType> = { email: emailAccountSettingsSchema, whatsapp: whatsappAccountSettingsSchema, instagram: instagramAccountSettingsSchema, linkedin: linkedinAccountSettingsSchema };
const SECRETS: Record<ChannelKind, z.ZodType | null> = { email: emailAccountSecretsSchema.partial().strict(), whatsapp: metaAccountSecretsSchema.partial().strict(), instagram: metaAccountSecretsSchema.partial().strict(), linkedin: null };
/** The settings that decide where the app connects (changing one means the connection has to be tested again). */
const CONNECTION_FIELDS: Record<ChannelKind, readonly string[]> = { email: ["address", "username", "smtp", "imap"], whatsapp: ["phoneNumberId", "businessAccountId"], instagram: ["instagramAccountId"], linkedin: ["profileUrl"] };
const NAMES: Record<ChannelKind, string> = { email: "mailbox", whatsapp: "WhatsApp number", instagram: "Instagram account", linkedin: "LinkedIn profile" };
const DUPLICATE: Record<ChannelKind, string> = {
  email: "You have already connected this mailbox", whatsapp: "This WhatsApp number is already connected in this workspace", instagram: "This Instagram account is already connected in this workspace", linkedin: "This LinkedIn profile is already connected",
};
/** What the webhook-based tests may learn about the account and keep in its settings (the number Meta shows, the Instagram username). */
const LEARNED: Partial<Record<ChannelKind, readonly string[]>> = { whatsapp: ["displayNumber"], instagram: ["username"] };

const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;
const unique = (ids: readonly string[]) => [...new Set(ids)];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Connected accounts (docs/sales-channels.md section 1): mailboxes and LinkedIn profiles (a person's own), WhatsApp numbers and Instagram
 * accounts (a venture's). Session only: Claude is refused on every route. No answer ever carries a secret or a sealed blob: people see
 * whether each secret is set and its last four characters. Every change is audited with the kind and which fields changed, never a value.
 * Also mounts sending drafts through these accounts (routes/sales-drafts.ts salesDraftSendRoutes).
 */
export function salesChannelRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const accounts = db.collection(ACCOUNTS);
  const router = Router();
  const json = (ctx: SalesCtx, account: AppDocument) => accountJson(account, ctx.actor, config);
  const fresh = async (id: string) => (await accounts.findOne({ _id: id }))!;

  /** The person may connect an account of this kind for every one of these ventures: a writer there (personal), a head there (venture kinds). */
  async function requireConnect(ctx: SalesCtx, kind: ChannelKind, ventureIds: string[]) {
    for (const ventureId of ventureIds) {
      await loadVenture(db, ctx.actor, ventureId);
      if (isPersonalKind(kind) ? !canWriteIn(ctx.actor, ventureId) : !isHeadOf(ctx.actor, ventureId)) {
        throw forbidden(isPersonalKind(kind) ? "Your role in this venture is read-only: you cannot connect accounts for it" : `Only a head of every venture it serves (or an admin) can connect a ${NAMES[kind]}`);
      }
    }
  }

  /** One default per venture and kind (and person, for personal accounts): naming this account the default there unsets it on the others. */
  async function claimDefaults(ctx: SalesCtx, account: { _id: string; kind: ChannelKind; ownerUserId?: string | undefined }, defaultFor: string[], now: Date, session?: ClientSession) {
    if (!defaultFor.length) return;
    await accounts.updateMany(
      { workspaceId: ctx.workspaceId, kind: account.kind, _id: { $ne: account._id }, defaultFor: { $in: defaultFor }, ...(isPersonalKind(account.kind) ? { ownerUserId: account.ownerUserId } : {}) },
      { $pull: { defaultFor: { $in: defaultFor } } as never, $set: { updatedAt: now } }, { session },
    );
  }

  // Everyone sees the accounts they may see (their own mailboxes, their ventures' numbers; heads also see who connected which mailbox).
  router.get("/channels", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Connected accounts");
    const query = channelAccountQuerySchema.parse(req.query);
    if (query.ventureId && !canSeeVenture(ctx.actor, query.ventureId)) { res.json(ok([])); return; }
    const rows = await accounts.find({ workspaceId: ctx.workspaceId, ...(query.kind ? { kind: query.kind } : {}), ...(query.ventureId ? { ventureIds: query.ventureId } : {}) }).sort({ kind: 1, label: 1, _id: 1 }).limit(500).toArray();
    res.json(ok(rows.filter((account) => canSeeAccount(ctx.actor, account)).map((account) => json(ctx, account))));
  });

  // Before the /channels/:id routes: "presets" is not an account id.
  router.get("/channels/presets", (req, res) => {
    forbidClaude(salesCtx(database, req).via, "Connected accounts");
    res.json(ok(EMAIL_PROVIDER_PRESETS));
  });

  router.post("/channels", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Connecting an account");
    const input = channelAccountInputSchema.parse(req.body ?? {});
    const ventureIds = unique(input.ventureIds);
    const defaultFor = unique(input.defaultFor);
    if (defaultFor.some((ventureId) => !ventureIds.includes(ventureId))) throw new AppError(400, "BAD_REQUEST", "An account can only be the default for ventures it serves");
    await requireConnect(ctx, input.kind, ventureIds);
    if (input.kind === "email" && await accounts.countDocuments({ workspaceId: ctx.workspaceId, kind: "email", ownerUserId: ctx.actor.id }) >= MAX_MAILBOXES_PER_PERSON) {
      throw new AppError(409, "CONFLICT", `You can connect at most ${MAX_MAILBOXES_PER_PERSON} mailboxes: remove one you no longer use first`);
    }
    const now = new Date();
    const _id = randomUUID();
    const secrets = "secrets" in input ? Object.fromEntries(Object.entries(input.secrets as Record<string, string>).map(([name, value]) => [name, sealSecret(config, ctx.workspaceId, _id, name, value, ctx.actor.id, now)])) : {};
    const personal = isPersonalKind(input.kind);
    const account: AppDocument = {
      _id, workspaceId: ctx.workspaceId, kind: input.kind, label: input.label, ...(personal ? { ownerUserId: ctx.actor.id } : {}), ventureIds, defaultFor, enabled: input.enabled, status: "not_tested",
      settings: input.settings, secrets, ...(input.kind === "whatsapp" || input.kind === "instagram" ? { verifyToken: newVerifyToken() } : {}), createdBy: ctx.actor.id, createdAt: now, updatedAt: now,
    };
    try {
      await atomic(database, async (session) => {
        await accounts.insertOne(account, { session });
        await claimDefaults(ctx, { _id, kind: input.kind, ownerUserId: personal ? ctx.actor.id : undefined }, defaultFor, now, session);
        await auditSales(ctx, "sales.channel.create", "channel_account", _id, ventureIds[0], { kind: input.kind }, session);
      });
    } catch (error) {
      if (isDuplicate(error)) throw new AppError(409, "CONFLICT", DUPLICATE[input.kind]);
      throw error;
    }
    res.status(201).json(ok(json(ctx, await fresh(_id))));
  });

  // Changes by a manager. An admin who doesn't own a personal account may only switch it on or off (or remove it).
  router.patch("/channels/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Changing a connected account");
    const account = await loadAccount(ctx, idSchema.parse(req.params.id));
    if (!canManageAccount(ctx.actor, account)) throw forbidden(isPersonalKind(account.kind) ? `Only the person who connected this ${NAMES[account.kind as ChannelKind]} can change it` : `Only a head of every venture it serves (or an admin) can change this ${NAMES[account.kind as ChannelKind]}`);
    const kind = account.kind as ChannelKind;
    const input = channelAccountUpdateSchema.parse(req.body ?? {});
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const fields = Object.keys(input);
    const owner = !isPersonalKind(kind) || account.ownerUserId === ctx.actor.id;
    if (!owner && fields.some((field) => field !== "enabled")) throw forbidden(`An admin can switch someone's ${NAMES[kind]} off or remove it; only its owner changes anything else`);
    const now = new Date();
    const $set: Record<string, unknown> = { updatedAt: now };
    const $unset: Record<string, ""> = {};
    if (input.label !== undefined) $set.label = input.label;
    if (input.enabled !== undefined) $set.enabled = input.enabled;
    // The settings are checked against this account's own kind, from what was sent (not the shared union's reading of it).
    let reconnect = false;
    if (input.settings !== undefined) {
      const settings = SETTINGS[kind].parse(raw.settings) as Record<string, unknown>;
      const before = (account.settings ?? {}) as Record<string, unknown>;
      reconnect = CONNECTION_FIELDS[kind].some((field) => !same(settings[field], before[field]));
      // What a test learned (the WhatsApp number's display name, the Instagram username) stays unless the change names it.
      for (const field of LEARNED[kind] ?? []) if (settings[field] === undefined && before[field] !== undefined && !reconnect) settings[field] = before[field];
      $set.settings = settings;
    }
    if (input.secrets !== undefined) {
      const schema = SECRETS[kind];
      if (!schema) throw new AppError(400, "BAD_REQUEST", `A ${NAMES[kind]} has no password or token to save`);
      const secrets = schema.parse(raw.secrets) as Record<string, string | undefined>;
      for (const [name, value] of Object.entries(secrets)) {
        if (!value || !SECRET_NAMES[kind].includes(name)) continue;
        $set[`secrets.${name}`] = sealSecret(config, ctx.workspaceId, String(account._id), name, value, ctx.actor.id, now);
        reconnect = true;
      }
    }
    // A new password, token or server means the connection has to be tested again (and a mailbox read from the start of the new one).
    if (reconnect) {
      $set.status = "not_tested";
      $unset.statusNote = ""; $unset.lastError = "";
      if (kind === "email") $unset.mailSync = "";
    }
    const ventureIds = input.ventureIds !== undefined ? unique(input.ventureIds) : (account.ventureIds as string[]).map(String);
    if (input.ventureIds !== undefined) {
      const added = ventureIds.filter((ventureId) => !(account.ventureIds as string[]).includes(ventureId));
      await requireConnect(ctx, kind, added);
      $set.ventureIds = ventureIds;
    }
    const currentDefaults = Array.isArray(account.defaultFor) ? (account.defaultFor as string[]).map(String) : [];
    if (input.defaultFor !== undefined && input.defaultFor.some((ventureId) => !ventureIds.includes(ventureId))) throw new AppError(400, "BAD_REQUEST", "An account can only be the default for ventures it serves");
    const defaultFor = input.defaultFor !== undefined ? unique(input.defaultFor) : currentDefaults.filter((ventureId) => ventureIds.includes(ventureId));
    if (!same(defaultFor, currentDefaults)) $set.defaultFor = defaultFor;
    const newDefaults = defaultFor.filter((ventureId) => !currentDefaults.includes(ventureId));
    try {
      await atomic(database, async (session) => {
        const changed = await accounts.updateOne({ _id: account._id, workspaceId: ctx.workspaceId }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { session });
        if (!changed.matchedCount) throw new AppError(404, "NOT_FOUND", "Connected account not found");
        await claimDefaults(ctx, { _id: String(account._id), kind, ownerUserId: typeof account.ownerUserId === "string" ? account.ownerUserId : undefined }, newDefaults, now, session);
        await auditSales(ctx, "sales.channel.update", "channel_account", String(account._id), ventureIds[0], { kind, fields: fields.sort().join(",") }, session);
      });
    } catch (error) {
      if (isDuplicate(error)) throw new AppError(409, "CONFLICT", DUPLICATE[kind]);
      throw error;
    }
    res.json(ok(json(ctx, await fresh(String(account._id)))));
  });

  // Removing an account: past activities keep their message.accountId (the timeline still says it went through an account).
  router.delete("/channels/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Removing a connected account");
    const account = await loadAccount(ctx, idSchema.parse(req.params.id));
    if (!canManageAccount(ctx.actor, account)) throw forbidden(`You can't remove this ${NAMES[account.kind as ChannelKind]}`);
    await atomic(database, async (session) => {
      await accounts.deleteOne({ _id: account._id, workspaceId: ctx.workspaceId }, { session });
      await auditSales(ctx, "sales.channel.delete", "channel_account", String(account._id), String((account.ventureIds as string[])[0] ?? ""), { kind: String(account.kind) }, session);
    });
    res.json(ok({ deleted: true }));
  });

  // Checks the connection without sending anything to anyone, and stores the result on the account. 5 tests a minute per person.
  router.post("/channels/:id/test", async (req, res) => {
    const ctx = salesCtx(database, req);
    forbidClaude(ctx.via, "Testing a connected account");
    const account = await loadAccount(ctx, idSchema.parse(req.params.id));
    if (!canManageAccount(ctx.actor, account)) throw forbidden(`Only the people who may change this ${NAMES[account.kind as ChannelKind]} can test it`);
    const wait = await overLimit(db, `sales-channel-test:${ctx.actor.id}`, TESTS_PER_MINUTE);
    if (wait) { res.setHeader("retry-after", String(wait)); throw new AppError(429, "RATE_LIMITED", `Too many connection tests in a minute; try again in ${wait} s`); }
    const kind = account.kind as ChannelKind;
    const missing = missingSecrets(config, account);
    let result: ChannelAccountTest;
    let learned: Record<string, string> = {};
    if (missing.length) {
      result = { ok: false, message: `The saved ${missing.join(" and ")} can't be read any more: enter ${missing.length > 1 ? "them" : "it"} again`, checks: missing.map((name) => ({ name, ok: false, detail: "Not saved, or it can't be read any more" })) };
    } else {
      try {
        // The provider stops at its own limit; the route never waits longer than 40 seconds whatever the provider does.
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<ChannelAccountTest>((resolve) => { timer = setTimeout(() => resolve({ ok: false, message: "The test took too long: check the server name and port, then try again", checks: [] }), TEST_ROUTE_LIMIT_MS); });
        const answer = await Promise.race([providerFor(kind).test(account, openSecrets(config, account), AbortSignal.timeout(TEST_TIMEOUT_MS)), late]).finally(() => clearTimeout(timer));
        const { learned: extra = {}, ...rest } = channelAccountTestSchema.parse(answer);
        // Only the fields this kind may learn are kept on the account, and only those are shown back.
        learned = Object.fromEntries((LEARNED[kind] ?? []).flatMap((field) => (typeof extra[field] === "string" && extra[field] ? [[field, String(extra[field]).slice(0, 120)]] : [])));
        result = { ...rest, ...(Object.keys(learned).length ? { learned } : {}) };
      } catch {
        result = { ok: false, message: "The test could not finish: try again in a minute", checks: [] };
      }
    }
    const now = new Date();
    await accounts.updateOne({ _id: account._id, workspaceId: ctx.workspaceId }, {
      $set: { status: result.ok ? "connected" : "needs_attention", statusNote: result.message.slice(0, 500), lastCheckedAt: now, ...(result.ok ? {} : { lastError: result.message.slice(0, 500) }), ...Object.fromEntries(Object.entries(learned).map(([field, value]) => [`settings.${field}`, value])) },
      // A passing test also lets a mailbox whose inbox sign-in failed be read again.
      ...(result.ok ? { $unset: { lastError: "", "mailSync.authFailedAt": "" } } : {}),
    });
    await auditSales(ctx, "sales.channel.test", "channel_account", String(account._id), String((account.ventureIds as string[])[0] ?? ""), { kind, ok: result.ok });
    res.json(ok(result));
  });

  // Sending drafts through these accounts needs the same server secret: POST /drafts/:id/send and /drafts/:id/delivery.
  router.use(salesDraftSendRoutes(database, config));
  return router;
}
