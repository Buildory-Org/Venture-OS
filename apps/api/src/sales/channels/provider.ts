// What every channel provider does (docs/sales-channels.md): test an account's connection, and (email, WhatsApp, Instagram) send one message
// through it. Providers never touch the database: the send route claims the draft and the day's send, calls `send`, and records the outcome.
// LinkedIn has no send: its messages are sent by hand and marked sent.
import type { ChannelAccountTest, ChannelKind } from "@venture-studio/contracts";
import type { AppDocument } from "../../db.js";
import { emailProvider } from "./email/provider.js";
import { instagramProvider } from "./meta/instagram.js";
import { whatsappProvider } from "./meta/whatsapp.js";

export type SendRequest = {
  account: AppDocument;
  /** The account's secrets in plain text (accounts.ts openSecrets): use them for this call only. */
  secrets: Record<string, string>;
  /** Email: one address. WhatsApp: the number as E.164 digits ("+919876543210"). Instagram: the person's Instagram-scoped id from their message. */
  to: string;
  toName?: string;
  subject?: string;
  body: string;
  /** WhatsApp outside the 24-hour window: the approved template and its filled-in values. */
  template?: { name: string; language: string; variables: string[] };
  /** Answering an earlier message: its provider id (email Message-ID, WhatsApp wamid) and thread. */
  inReplyTo?: { externalId?: string; threadKey?: string; references?: string[] };
  /** Stable per draft and attempt: providers that support it pass it on so a retried call is not sent twice. */
  idempotencyKey: string;
};

/**
 * `sent`: the provider accepted it (with its message id). `failed`: it certainly did not go out (bad password, refused recipient, Meta said
 * no) and may be tried again after fixing `error`. `uncertain`: the call broke after it may have gone out (a timeout, a dropped connection): a
 * person checks and says whether it went.
 */
export type SendOutcome =
  | { state: "sent"; externalId?: string; threadKey?: string; from?: string; to?: string }
  | { state: "failed"; error: string }
  | { state: "uncertain"; error: string };

export type ChannelProvider = {
  kind: ChannelKind;
  /** Checks the connection without sending anything to anyone. Never throws: problems come back as failed checks. */
  test(account: AppDocument, secrets: Record<string, string>, signal: AbortSignal): Promise<ChannelAccountTest>;
  send?(request: SendRequest, signal: AbortSignal): Promise<SendOutcome>;
};

const linkedinProvider: ChannelProvider = {
  kind: "linkedin",
  async test() { return { ok: true, message: "LinkedIn messages are sent by hand from your profile and marked sent here: nothing to connect", checks: [] }; },
};

const providers: Record<ChannelKind, ChannelProvider> = { email: emailProvider, whatsapp: whatsappProvider, instagram: instagramProvider, linkedin: linkedinProvider };

export const providerFor = (kind: ChannelKind): ChannelProvider => providers[kind];

/** Tests only: replaces one provider (e.g. a fake SMTP) and returns the function that puts the real one back. */
export function useProviderForTests(provider: ChannelProvider): () => void {
  if (process.env.NODE_ENV === "production") throw new Error("useProviderForTests is for tests only");
  const real = providers[provider.kind];
  providers[provider.kind] = provider;
  return () => { providers[provider.kind] = real; };
}
