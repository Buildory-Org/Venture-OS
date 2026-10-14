"use client";
import { useEffect, useState } from "react";
import { PERSONAL_CHANNEL_KINDS, type ChannelAccount, type ChannelKind } from "@venture-studio/contracts";
import { getCachedChannelAccounts } from "@/lib/sales-channels-api";
import type { Tone } from "./sales-ui";

// Words, small rules and the shared account list for Sales channels (docs/sales-channels.md). The API enforces every rule; these only
// decide what to show.

export const KIND_NAME: Record<ChannelKind, { one: string; many: string; add: string }> = {
  email: { one: "Mailbox", many: "Mailboxes", add: "Add a mailbox" },
  linkedin: { one: "LinkedIn profile", many: "LinkedIn profiles", add: "Add a LinkedIn profile" },
  whatsapp: { one: "WhatsApp number", many: "WhatsApp numbers", add: "Add a WhatsApp number" },
  instagram: { one: "Instagram account", many: "Instagram accounts", add: "Add an Instagram account" },
};
/** Email and LinkedIn belong to one person (they send as themselves); WhatsApp and Instagram belong to the venture. */
export const isPersonalKind = (kind: ChannelKind) => PERSONAL_CHANNEL_KINDS.includes(kind);

type EmailSettings = Extract<ChannelAccount["settings"], { address: string }>;
type WhatsappSettings = Extract<ChannelAccount["settings"], { phoneNumberId: string }>;
type InstagramSettings = Extract<ChannelAccount["settings"], { instagramAccountId: string }>;
type LinkedinSettings = Extract<ChannelAccount["settings"], { profileUrl: string }>;
export const emailSettingsOf = (account: ChannelAccount) => account.kind === "email" && "address" in account.settings ? account.settings as EmailSettings : null;
export const whatsappSettingsOf = (account: ChannelAccount) => account.kind === "whatsapp" && "phoneNumberId" in account.settings ? account.settings as WhatsappSettings : null;
export const instagramSettingsOf = (account: ChannelAccount) => account.kind === "instagram" && "instagramAccountId" in account.settings ? account.settings as InstagramSettings : null;
export const linkedinSettingsOf = (account: ChannelAccount) => account.kind === "linkedin" && "profileUrl" in account.settings ? account.settings as LinkedinSettings : null;

/** What tells an account apart at a glance: the address, the number, the @username, the profile. */
export function accountLine(account: ChannelAccount): string {
  const email = emailSettingsOf(account);
  if (email) return email.address;
  const whatsapp = whatsappSettingsOf(account);
  if (whatsapp) return whatsapp.displayNumber || `Phone number id ${whatsapp.phoneNumberId}`;
  const instagram = instagramSettingsOf(account);
  if (instagram) return instagram.username ? `@${instagram.username.replace(/^@/, "")}` : `Account id ${instagram.instagramAccountId}`;
  const linkedin = linkedinSettingsOf(account);
  if (linkedin) return linkedin.profileUrl.replace(/^https:\/\/(www\.)?/i, "").replace(/\/$/, "");
  return "";
}

/** The status chip: switched off, connected, needs attention, or not tested yet. */
export function statusOf(account: Pick<ChannelAccount, "enabled" | "status">): { tone: Tone; text: string } {
  if (!account.enabled) return { tone: "neutral", text: "Switched off" };
  if (account.status === "connected") return { tone: "green", text: "Connected" };
  if (account.status === "needs_attention") return { tone: "red", text: "Needs attention" };
  return { tone: "amber", text: "Not tested" };
}

/**
 * The accounts this person can send through for a venture and channel, as the API picks them: switched on, serving the venture, and for a
 * mailbox or LinkedIn profile their own. The venture's default comes first, then by name.
 */
export function usableAccounts(accounts: readonly ChannelAccount[] | null | undefined, ventureId: string, kind: string, userId: string | undefined): ChannelAccount[] {
  if (!accounts || !userId) return [];
  return accounts
    .filter((account) => account.kind === kind && account.enabled && account.ventureIds.includes(ventureId) && (!isPersonalKind(account.kind) || account.ownerUserId === userId))
    .sort((a, b) => Number(b.defaultFor.includes(ventureId)) - Number(a.defaultFor.includes(ventureId)) || a.label.localeCompare(b.label));
}

/** The label of the account a message went through, or "" when it is not one this person can see (or it was removed). */
export const accountLabel = (accounts: readonly ChannelAccount[] | null | undefined, accountId: string | undefined) => accountId ? accounts?.find((account) => account.id === accountId)?.label ?? "" : "";

/**
 * Every account the person can see, through the one-minute cache in lib/sales-channels-api. `accounts` is null while it loads, when this
 * server has no channels yet (`available: false`), or when it could not be read. Off (no request) while `enabled` is false.
 */
export function useChannelAccounts(enabled = true): { accounts: ChannelAccount[] | null; ready: boolean; available: boolean } {
  const [state, setState] = useState<{ accounts: ChannelAccount[] | null; ready: boolean; available: boolean }>({ accounts: null, ready: false, available: false });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    getCachedChannelAccounts()
      .then((accounts) => { if (active) setState({ accounts, ready: true, available: accounts !== null }); })
      .catch(() => { if (active) setState({ accounts: null, ready: true, available: false }); });
    return () => { active = false; };
  }, [enabled]);
  return state;
}

/** How to connect the venture's WhatsApp number or Instagram account on Meta's side, in plain steps (docs/sales-channels.md section 9). */
export const META_STEPS: Record<"whatsapp" | "instagram", string[]> = {
  whatsapp: [
    "In Meta Business Manager, open the venture's app (or create one), add the WhatsApp product and add the business phone number.",
    "In Business settings, create a system user that can use the WhatsApp Business account, and generate a permanent token with the whatsapp_business_messaging and whatsapp_business_management permissions.",
    "Here, paste the phone number id, the WhatsApp Business account id (both on the app's WhatsApp > API setup page), the token, and the app secret (App settings > Basic). Then press Test.",
    "In the Meta app's Webhooks settings, paste the callback URL and verify token shown on this card, and subscribe to messages.",
    "First messages, and follow-ups after 24 hours of silence, go out as message templates. Create them in WhatsApp Manager; Meta approves them.",
  ],
  instagram: [
    "In the Meta app, add Instagram (API setup with Instagram login) and connect the venture's professional Instagram account.",
    "Generate a long-lived access token with the instagram_business_basic and instagram_business_manage_messages permissions.",
    "Here, paste the Instagram account id and the token (both on that setup page) and the Instagram app secret. Then press Test.",
    "In the app's Webhooks settings, paste the callback URL and verify token shown on this card, and subscribe to messages.",
    "The app answers people within 24 hours of their last message. A first message to someone who hasn't written goes from the Instagram app.",
  ],
};
