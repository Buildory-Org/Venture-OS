import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import type { Db } from "mongodb";
import type { AppConfig } from "./config.js";

async function sendMagicLink(config: AppConfig, email: string, url: string): Promise<void> {
  if (!config.RESEND_API_KEY) {
    console.info(JSON.stringify({ level: "info", adapter: "local", event: "magic_link", email, url }));
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.EMAIL_FROM, to: email, subject: "Sign in to Venture Studio", html: `<p><a href="${url}">Sign in to Venture Studio</a></p>` }),
  });
  if (!response.ok) throw new Error(`Resend rejected magic link: ${response.status}`);
}

export async function sendInvitationEmail(config: AppConfig, email: string, url: string, invitationId: string): Promise<string> {
  if (!config.RESEND_API_KEY) throw new Error("Resend is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `invitation/${invitationId}` },
    body: JSON.stringify({ from: config.EMAIL_FROM, to: email, subject: "Join Venture Studio", text: `You have been invited to Venture Studio. Open this one-time link to join:\n\n${url}\n\nThis invitation expires in 7 days.` }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend rejected invitation: ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") throw new Error("Resend did not confirm an email ID");
  return result.id;
}

export function createAuth(db: Db, config: AppConfig) {
  return betterAuth({
    // Magic-link verification must be served through the web origin so its
    // session cookie belongs to the same host used by subsequent /v1 calls.
    baseURL: config.APP_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_ORIGIN],
    // Sign-in rate limits use the edge's client-address header when one is configured (see CLIENT_IP_HEADER).
    ...(config.CLIENT_IP_HEADER ? { advanced: { ipAddress: { ipAddressHeaders: [config.CLIENT_IP_HEADER] } } } : {}),
    database: mongodbAdapter(db),
    plugins: [magicLink({ sendMagicLink: ({ email, url }) => sendMagicLink(config, email, url) })],
  });
}

export type Auth = ReturnType<typeof createAuth>;
