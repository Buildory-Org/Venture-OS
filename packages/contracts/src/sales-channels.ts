import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// Channel accounts (docs/sales-channels.md). Every connection Sales sends or receives through is an account linked to one or more
// ventures: a person's own mailbox (email, several allowed: one per venture if they like), a venture's WhatsApp Business number, a venture's
// Instagram professional account, or a person's LinkedIn profile (LinkedIn has no messaging API for apps: hand-sending, tracked). Secrets
// (mail passwords, Meta access tokens, app secrets) are stored encrypted, never returned, never logged; people see only whether one is set
// and its last four characters. Claude never creates, changes or sends through an account: a person clicks Send in the app.

export const CHANNEL_KINDS = ["email", "whatsapp", "instagram", "linkedin"] as const;
export const channelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = z.infer<typeof channelKindSchema>;
/** Personal accounts belong to one person (they send as themselves); venture accounts are shared by a venture's sellers. */
export const PERSONAL_CHANNEL_KINDS: readonly ChannelKind[] = ["email", "linkedin"];

/**
 * A mail server's public name (smtp.gmail.com): not an IP address, not a one-word or local name (localhost, mongo, *.local, *.internal).
 * The API also checks what the name resolves to before connecting (no private or reserved addresses).
 */
const hostSchema = z.string().trim().toLowerCase().min(1).max(255).regex(/^[a-z0-9.-]+$/, "a host name such as smtp.gmail.com")
  .refine((host) => !/^[\d.]+$/.test(host), "the mail server's name (such as smtp.gmail.com), not an IP address")
  .refine((host) => host.includes(".") && !/(^|\.)(localhost|local|internal|localdomain|home|lan|corp)$/.test(host), "a public mail server name (such as smtp.gmail.com)");
/** Mail always travels encrypted (SSL/TLS or STARTTLS) and only on the standard mail ports, so a mailbox can't point at other services. */
export const SMTP_PORTS = [25, 465, 587, 2525] as const;
export const IMAP_PORTS = [143, 993] as const;
const portIn = (ports: readonly number[], what: string) => z.number().int().refine((port) => ports.includes(port), `${what} uses port ${ports.join(", ")}`);
const securitySchema = z.enum(["ssl", "starttls"]);
const metaIdSchema = z.string().trim().regex(/^\d{5,30}$/, "the numeric id Meta shows");

export const emailAccountSettingsSchema = z.object({
  address: z.email(), senderName: z.string().trim().min(1).max(120), username: z.string().trim().min(1).max(320),
  smtp: z.object({ host: hostSchema, port: portIn(SMTP_PORTS, "Sending mail (SMTP)"), security: securitySchema }),
  imap: z.object({ host: hostSchema, port: portIn(IMAP_PORTS, "Reading mail (IMAP)"), security: securitySchema }),
  /** Read new mail in the inbox every few minutes and file replies from leads (never deletes or marks anything read). */
  syncInbox: z.boolean().default(true),
  /** Also save a copy of each sent message in the mailbox's Sent folder (Gmail does this by itself: leave it off there). */
  saveToSent: z.boolean().default(false),
});
export const whatsappAccountSettingsSchema = z.object({ phoneNumberId: metaIdSchema, businessAccountId: metaIdSchema, displayNumber: z.string().trim().max(40).optional() });
export const instagramAccountSettingsSchema = z.object({ instagramAccountId: metaIdSchema, username: z.string().trim().max(80).optional() });
export const linkedinAccountSettingsSchema = z.object({
  profileUrl: z.url().refine((value) => /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(value), "a LinkedIn profile address (https://www.linkedin.com/in/…)"),
  name: z.string().trim().max(120).optional(),
});

/** A mail password is kept exactly as typed (spaces included); Meta tokens and secrets are trimmed (a pasted line break is never part of them). */
const password = z.string().min(1).max(4_000).refine((value) => value.trim().length > 0, "the password is empty");
const token = z.string().trim().min(1).max(4_000);
export const emailAccountSecretsSchema = z.object({ password });
export const metaAccountSecretsSchema = z.object({ accessToken: token, appSecret: token });

const common = {
  label: z.string().trim().min(1).max(120),
  /** The ventures that may use this account (at least one). */
  ventureIds: z.array(idSchema).min(1).max(20),
  /** Of those, the ventures where it is the default for its channel (for a personal account: the person's default there). */
  defaultFor: z.array(idSchema).max(20).default([]),
  enabled: z.boolean().default(true),
};
export const channelAccountInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), ...common, settings: emailAccountSettingsSchema, secrets: emailAccountSecretsSchema }),
  z.object({ kind: z.literal("whatsapp"), ...common, settings: whatsappAccountSettingsSchema, secrets: metaAccountSecretsSchema }),
  z.object({ kind: z.literal("instagram"), ...common, settings: instagramAccountSettingsSchema, secrets: metaAccountSecretsSchema }),
  z.object({ kind: z.literal("linkedin"), ...common, settings: linkedinAccountSettingsSchema }),
]);
export type ChannelAccountInput = z.infer<typeof channelAccountInputSchema>;
/** Changes: any of these; `settings` replaces the whole settings object; `secrets` replaces only the secrets given. */
export const channelAccountUpdateSchema = z.object({
  label: common.label, ventureIds: common.ventureIds, defaultFor: z.array(idSchema).max(20), enabled: z.boolean(),
  settings: z.union([emailAccountSettingsSchema, whatsappAccountSettingsSchema, instagramAccountSettingsSchema, linkedinAccountSettingsSchema]),
  secrets: z.union([emailAccountSecretsSchema.partial(), metaAccountSecretsSchema.partial()]),
}).partial().refine((value) => Object.keys(value).length > 0);

export const CHANNEL_ACCOUNT_STATUSES = ["not_tested", "connected", "needs_attention"] as const;
export const channelAccountSchema = z.object({
  id: idSchema, workspaceId: idSchema, kind: channelKindSchema, label: z.string(),
  /** Personal accounts only: the person who owns it (and the only one who sends through it). */
  ownerUserId: idSchema.optional(),
  ventureIds: z.array(idSchema), defaultFor: z.array(idSchema), enabled: z.boolean(),
  status: z.enum(CHANNEL_ACCOUNT_STATUSES), statusNote: z.string().optional(),
  settings: z.union([emailAccountSettingsSchema, whatsappAccountSettingsSchema, instagramAccountSettingsSchema, linkedinAccountSettingsSchema]),
  /** Which secrets are saved (never their values): for each, set or not; Meta tokens also show their last four characters, to the people who manage the account only. */
  secrets: z.record(z.string(), z.object({ set: z.boolean(), last4: z.string().optional(), setAt: isoDateSchema.optional() })),
  /** WhatsApp and Instagram: what to paste into the Meta app's webhook settings. */
  webhook: z.object({ url: z.string(), verifyToken: z.string() }).optional(),
  lastCheckedAt: isoDateSchema.optional(), lastSyncAt: isoDateSchema.optional(), lastError: z.string().optional(),
  /** True when the person reading may change it (its owner, or for a venture account a head of every venture it serves, or an admin). */
  canManage: z.boolean(),
  createdBy: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export type ChannelAccount = z.infer<typeof channelAccountSchema>;
export const channelAccountQuerySchema = z.object({ ventureId: idSchema.optional(), kind: channelKindSchema.optional() });
export const channelAccountTestSchema = z.object({
  ok: z.boolean(), message: z.string(), checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().optional() })).default([]),
  /** What the test read from the provider and stored on the account (e.g. the WhatsApp display number, the Instagram username). */
  learned: z.record(z.string(), z.string()).optional(),
});
export type ChannelAccountTest = z.infer<typeof channelAccountTestSchema>;

/** Ready-made settings for common mail providers (the person still types their address, username and app password). */
export const EMAIL_PROVIDER_PRESETS = {
  gmail: { label: "Gmail / Google Workspace", smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" }, imap: { host: "imap.gmail.com", port: 993, security: "ssl" }, saveToSent: false },
  outlook: { label: "Outlook / Microsoft 365", smtp: { host: "smtp.office365.com", port: 587, security: "starttls" }, imap: { host: "outlook.office365.com", port: 993, security: "ssl" }, saveToSent: false },
  zoho: { label: "Zoho Mail (India)", smtp: { host: "smtp.zoho.in", port: 465, security: "ssl" }, imap: { host: "imap.zoho.in", port: 993, security: "ssl" }, saveToSent: true },
  hostinger: { label: "Hostinger", smtp: { host: "smtp.hostinger.com", port: 465, security: "ssl" }, imap: { host: "imap.hostinger.com", port: 993, security: "ssl" }, saveToSent: true },
  godaddy: { label: "GoDaddy (Titan)", smtp: { host: "smtp.titan.email", port: 465, security: "ssl" }, imap: { host: "imap.titan.email", port: 993, security: "ssl" }, saveToSent: true },
} as const;

/** Delivery of one outbound message sent through an account: set while sending, then by the provider (WhatsApp ticks) or a bounce. */
export const DELIVERY_STATES = ["sending", "sent", "delivered", "read", "failed", "uncertain", "bounced"] as const;
export const deliveryStateSchema = z.enum(DELIVERY_STATES);
/** `to`: where it went (an email address, or a WhatsApp number as sent, with its country code), so people can check it. */
export const deliverySchema = z.object({ state: deliveryStateSchema, at: isoDateSchema, accountId: idSchema.optional(), error: z.string().optional(), to: z.string().optional() });

/** A WhatsApp template the venture's number may send outside the 24-hour window (Meta approves them), with the draft's filled-in values. */
export const whatsappTemplateRefSchema = z.object({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(15), variables: z.array(z.string().trim().max(1_000)).max(20).default([]) });
export const whatsappTemplateSchema = z.object({ name: z.string(), language: z.string(), status: z.string(), category: z.string().optional(), body: z.string(), variableCount: z.number().int().nonnegative() });
export type WhatsappTemplate = z.infer<typeof whatsappTemplateSchema>;

/** A person reconciling a send whose result was unclear (a timeout): it went out, or it didn't. */
export const draftDeliveryReconcileSchema = z.object({ outcome: z.enum(["sent", "not_sent"]) });

/** A WhatsApp or Instagram message from someone who is not a lead yet: a new conversation a person attaches to a lead or turns into one. */
export const inboundConversationSchema = z.object({
  id: idSchema, workspaceId: idSchema, accountId: idSchema, kind: z.enum(["whatsapp", "instagram"]), ventureIds: z.array(idSchema),
  from: z.string(), name: z.string().optional(), body: z.string(), at: isoDateSchema, messages: z.number().int().positive(),
  handledAt: isoDateSchema.optional(), handledBy: idSchema.optional(), leadId: idSchema.optional(),
  /** The messages kept so far (up to 50, oldest first): linking the conversation files them on the lead. */
  items: z.array(z.object({ externalId: z.string(), body: z.string(), at: isoDateSchema })).optional(),
});
export type InboundConversation = z.infer<typeof inboundConversationSchema>;
export const inboundAttachSchema = z.object({ leadId: idSchema });
