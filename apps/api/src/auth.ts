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

export function createAuth(db: Db, config: AppConfig) {
  return betterAuth({
    baseURL: config.API_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_ORIGIN],
    database: mongodbAdapter(db),
    plugins: [magicLink({ sendMagicLink: ({ email, url }) => sendMagicLink(config, email, url) })],
  });
}

export type Auth = ReturnType<typeof createAuth>;
