// Channel accounts (docs/sales-channels.md): the connections Sales sends and receives through, stored in `sales_channel_accounts`, one row per
// account. A personal account (a mailbox, a LinkedIn profile) belongs to the person who connected it and only they send through it; a venture
// account (a WhatsApp Business number, an Instagram professional account) is shared by the sellers of the ventures it serves and managed by
// their heads. One account may serve several ventures, and a venture may have several accounts per channel: `defaultFor` names the ventures
// where an account is picked when the sender doesn't choose (per person for personal accounts). Secrets are sealed (secret-box.ts), bound to
// the workspace, the account and the secret's name; they are opened only for a provider call and never returned or logged.
import { randomBytes } from "node:crypto";
import { PERSONAL_CHANNEL_KINDS, type ChannelAccount, type ChannelKind } from "@venture-studio/contracts";
import type { AppDocument } from "../../db.js";
import { AppError } from "../../errors.js";
import { canSeeVenture, canWriteIn, isHeadOf, notFound, type Actor } from "../access.js";
import type { SalesCtx } from "../ctx.js";
import { present } from "../present.js";
import { secretBox, type SealedSecret } from "../secret-box.js";

export const ACCOUNTS = "sales_channel_accounts";
const SALT = "vso-sales-channel-secrets-v1";

/** The part of the API's config the channels need. Pass the whole config. */
export type ChannelEnv = { BETTER_AUTH_SECRET: string; APP_ORIGIN: string };

/** The secrets each kind of account holds. */
export const SECRET_NAMES: Readonly<Record<ChannelKind, readonly string[]>> = { email: ["password"], whatsapp: ["accessToken", "appSecret"], instagram: ["accessToken", "appSecret"], linkedin: [] };
export const isPersonalKind = (kind: unknown): boolean => (PERSONAL_CHANNEL_KINDS as readonly unknown[]).includes(kind);
/** Meta (WhatsApp and Instagram) calls the same webhook address for every account; the payload names the number or account it is for. */
export const META_WEBHOOK_PATH = "/v1/webhooks/meta";

const box = (env: Pick<ChannelEnv, "BETTER_AUTH_SECRET">) => secretBox(env.BETTER_AUTH_SECRET, SALT);
const binding = (workspaceId: string, accountId: string, name: string) => `${workspaceId}:${accountId}:${name}`;

/**
 * Seals one secret for its account. A mail password keeps nothing in clear (people see only that it is set and when); a Meta token or app
 * secret keeps its last four characters so its managers can tell which one is saved.
 */
export function sealSecret(env: Pick<ChannelEnv, "BETTER_AUTH_SECRET">, workspaceId: string, accountId: string, name: string, value: string, setBy: string, now = new Date()): SealedSecret {
  return box(env).seal(value, binding(workspaceId, accountId, name), setBy, now, name !== "password");
}

/** The account's secrets in plain text, for one provider call only (never returned, logged or stored). Secrets that don't open are left out. */
export function openSecrets(env: Pick<ChannelEnv, "BETTER_AUTH_SECRET">, account: AppDocument): Record<string, string> {
  const opened: Record<string, string> = {};
  const sealed = (account.secrets ?? {}) as Record<string, unknown>;
  for (const name of SECRET_NAMES[account.kind as ChannelKind] ?? []) {
    const value = box(env).open(sealed[name], binding(String(account.workspaceId), String(account._id), name));
    if (value !== undefined) opened[name] = value;
  }
  return opened;
}

/** The names of the account's secrets that are missing or don't open (sealed under another server secret, damaged). */
export function missingSecrets(env: Pick<ChannelEnv, "BETTER_AUTH_SECRET">, account: AppDocument): string[] {
  const opened = openSecrets(env, account);
  return (SECRET_NAMES[account.kind as ChannelKind] ?? []).filter((name) => opened[name] === undefined);
}

/** A fresh token people paste into the Meta app's webhook settings ("Verify token"). */
export const newVerifyToken = () => randomBytes(18).toString("base64url");

// ---- Who may see, manage and use an account ------------------------------------------------------------------------------------------

const ventureIdsOf = (account: AppDocument): string[] => Array.isArray(account.ventureIds) ? account.ventureIds.map(String) : [];

/** Personal: its owner, an admin, or a head of one of its ventures (they see who connected what, never a secret). Venture: anyone in one of its ventures. */
export function canSeeAccount(actor: Actor, account: AppDocument): boolean {
  if (account.workspaceId !== actor.membership.workspaceId) return false;
  if (actor.membership.role === "admin") return true;
  if (isPersonalKind(account.kind)) return account.ownerUserId === actor.id || ventureIdsOf(account).some((ventureId) => isHeadOf(actor, ventureId));
  return ventureIdsOf(account).some((ventureId) => canSeeVenture(actor, ventureId));
}

/** Personal: its owner (an admin may switch it off or remove it). Venture: an admin, or a head of every venture it serves. */
export function canManageAccount(actor: Actor, account: AppDocument): boolean {
  if (account.workspaceId !== actor.membership.workspaceId) return false;
  if (isPersonalKind(account.kind)) return account.ownerUserId === actor.id || actor.membership.role === "admin";
  const ventures = ventureIdsOf(account);
  return actor.membership.role === "admin" || (ventures.length > 0 && ventures.every((ventureId) => isHeadOf(actor, ventureId)));
}

/** Sends through it for this venture: switched on, serving the venture, the sender writes there, and a personal account is their own. */
export function canUseAccount(actor: Actor, account: AppDocument, ventureId: string): boolean {
  if (account.workspaceId !== actor.membership.workspaceId || account.enabled === false || !ventureIdsOf(account).includes(ventureId) || !canWriteIn(actor, ventureId)) return false;
  return !isPersonalKind(account.kind) || account.ownerUserId === actor.id;
}

// ---- Reading accounts ------------------------------------------------------------------------------------------------------------------

/** One account the actor can see, or 404 (an account they can't see reads as missing). */
export async function loadAccount(ctx: SalesCtx, id: string): Promise<AppDocument> {
  const account = await ctx.db.collection(ACCOUNTS).findOne({ _id: id, workspaceId: ctx.workspaceId });
  if (!account || !canSeeAccount(ctx.actor, account)) throw notFound("Connected account");
  return account;
}

/** The accounts the actor may send through for this venture and channel, defaults first, then by name. */
export async function usableAccounts(ctx: SalesCtx, ventureId: string, kind: ChannelKind): Promise<AppDocument[]> {
  const rows = await ctx.db.collection(ACCOUNTS).find({ workspaceId: ctx.workspaceId, kind, ventureIds: ventureId, enabled: { $ne: false } }).toArray();
  return rows.filter((account) => canUseAccount(ctx.actor, account, ventureId))
    .sort((a, b) => Number(isDefaultFor(b, ventureId)) - Number(isDefaultFor(a, ventureId)) || String(a.label ?? "").localeCompare(String(b.label ?? "")));
}

const isDefaultFor = (account: AppDocument, ventureId: string) => Array.isArray(account.defaultFor) && account.defaultFor.includes(ventureId);

/**
 * The account a send goes through: the one named (it must be usable), else the sender's default for the venture and channel, else the only
 * usable one. Refuses (409) when there is none, or several and no default.
 */
export async function pickSendAccount(ctx: SalesCtx, ventureId: string, kind: ChannelKind, accountId?: string): Promise<AppDocument> {
  if (accountId) {
    const account = await loadAccount(ctx, accountId);
    if (account.kind !== kind) throw new AppError(409, "CONFLICT", `That account is ${String(account.kind)}, not ${kind}`);
    if (!canUseAccount(ctx.actor, account, ventureId)) throw new AppError(409, "CONFLICT", account.enabled === false ? "That account is switched off" : "You can't send through that account for this venture");
    return account;
  }
  const usable = await usableAccounts(ctx, ventureId, kind);
  const chosen = usable.find((account) => isDefaultFor(account, ventureId)) ?? (usable.length === 1 ? usable[0] : undefined);
  if (chosen) return chosen;
  throw new AppError(409, "CONFLICT", usable.length ? `You have several ${kind} accounts for this venture: choose one` : `No ${kind} account is connected for you in this venture: connect one in Sales > Channels, or send it yourself and mark it sent`);
}

/** The account as API JSON for this viewer: settings, which secrets are saved (never their values), the webhook details for its managers. */
export function accountJson(account: AppDocument, actor: Actor, env: Pick<ChannelEnv, "BETTER_AUTH_SECRET" | "APP_ORIGIN">): ChannelAccount {
  const manage = canManageAccount(actor, account);
  const opened = openSecrets(env, account);
  const sealed = (account.secrets ?? {}) as Record<string, Partial<SealedSecret> | undefined>;
  // The last four characters only to the people who manage the account (never to a head looking at a teammate's mailbox).
  const shown = (name: string) => {
    const last4 = manage && typeof sealed[name]?.last4 === "string" ? sealed[name]!.last4!.slice(-4) : "";
    const setAt = sealed[name]?.setAt;
    return { ...(last4 ? { last4 } : {}), ...(setAt instanceof Date ? { setAt: setAt.toISOString() } : {}) };
  };
  const secrets = Object.fromEntries((SECRET_NAMES[account.kind as ChannelKind] ?? []).map((name) => [name, opened[name] !== undefined ? { set: true, ...shown(name) } : { set: false }]));
  const { secrets: _sealed, verifyToken, mailSync: _sync, ...rest } = account;
  const webhook = manage && (account.kind === "whatsapp" || account.kind === "instagram") && typeof verifyToken === "string" ? { url: `${env.APP_ORIGIN.replace(/\/$/, "")}${META_WEBHOOK_PATH}`, verifyToken } : undefined;
  return present({ ...rest, ventureIds: ventureIdsOf(account), defaultFor: Array.isArray(account.defaultFor) ? account.defaultFor : [], enabled: account.enabled !== false, status: account.status ?? "not_tested", secrets, ...(webhook ? { webhook } : {}), canManage: manage }) as unknown as ChannelAccount;
}
