// Instagram through a venture's professional account (Instagram API with Instagram Login, graph.instagram.com) (docs/sales-channels.md
// section 5). The test reads the account behind the token (/me) without sending anything. A send is a reply to someone who wrote first,
// within 24 hours of their last message (the send route checks the window): POST /<instagramAccountId>/messages to their Instagram-scoped
// id. First messages are never sent by the app (Meta's rules): people copy them into the Instagram app and mark them sent.
import type { ChannelAccountTest } from "@venture-studio/contracts";
import type { AppDocument } from "../../../db.js";
import type { ChannelProvider, SendOutcome, SendRequest } from "../provider.js";
import { graphCall, type MetaSecrets } from "./graph.js";
import type { MetaTestResult } from "./whatsapp.js";

const META_ID = /^\d{5,30}$/;
/** Instagram's limit for a text message: 1,000 bytes of UTF-8. */
const MAX_TEXT_BYTES = 1_000;
/** The username lookup runs while Meta waits for the webhook's answer: it gets a short timeout. */
const PROFILE_TIMEOUT_MS = 5_000;

async function testInstagram(account: AppDocument, secrets: Record<string, string>, signal: AbortSignal): Promise<MetaTestResult> {
  const settings = (account.settings ?? {}) as Record<string, unknown>;
  const missing = ["accessToken", "appSecret"].filter((name) => !secrets[name]);
  if (missing.length) {
    const detail = `Save ${missing.map((name) => (name === "accessToken" ? "the access token" : "the app secret")).join(" and ")} again: ${missing.length > 1 ? "they are" : "it is"} missing or can't be read`;
    return { ok: false, message: detail, checks: [{ name: "Token and app secret", ok: false, detail }] };
  }
  const expected = String(settings.instagramAccountId ?? "");
  const me = await graphCall<any>("instagram", secrets, "GET", "me", { query: { fields: "user_id,username" }, signal });
  if (!me.ok) return { ok: false, message: `Instagram account: ${me.message}`, checks: [{ name: "Instagram account", ok: false, detail: me.message }] };
  const userId = me.data?.user_id === undefined ? "" : String(me.data.user_id);
  const username = typeof me.data?.username === "string" ? me.data.username : undefined;
  const checks: ChannelAccountTest["checks"] = [];
  if (!userId || userId !== expected) {
    const detail = `This token belongs to ${username ? `@${username}` : "another account"}${userId ? ` (id ${userId})` : ""}, not the Instagram account id saved here${userId ? `: save ${userId} as the account id, or use that account's token` : ""}`;
    checks.push({ name: "Instagram account", ok: false, detail });
  } else checks.push({ name: "Instagram account", ok: true, detail: username ? `@${username}` : `id ${userId}` });
  checks.push({ name: "Webhook signature", ok: true, detail: "The app secret is checked when Meta's first message arrives" });
  const failed = checks.find((check) => !check.ok);
  return {
    ok: !failed, message: failed ? failed.detail ?? "Not connected" : `Connected${username ? `: @${username}` : ""}. Nothing was sent.`, checks,
    ...(username && !failed ? { learned: { username } } : {}),
  };
}

async function sendInstagram(request: SendRequest, signal: AbortSignal): Promise<SendOutcome> {
  const { account, secrets } = request;
  const settings = (account.settings ?? {}) as Record<string, unknown>;
  const accountId = String(settings.instagramAccountId ?? "");
  if (!META_ID.test(accountId)) return { state: "failed", error: "This Instagram account has no valid account id: fix it in Sales > Channels" };
  if (!secrets.accessToken) return { state: "failed", error: "This Instagram account's access token can't be read: save it again in Sales > Channels" };
  const recipient = request.to.trim();
  if (!/^\d{5,40}$/.test(recipient)) return { state: "failed", error: "There is no Instagram conversation with this person to answer: they need to write to the venture's account first" };
  if (request.template) return { state: "failed", error: "Instagram has no message templates: answer within 24 hours of their last message, or from the Instagram app" };
  if (!request.body.trim()) return { state: "failed", error: "The message is empty" };
  if (Buffer.byteLength(request.body, "utf8") > MAX_TEXT_BYTES) return { state: "failed", error: "Instagram messages can be at most 1,000 bytes (about 1,000 letters, fewer with emoji or Hindi): shorten it" };
  const answer = await graphCall<any>("instagram", secrets, "POST", `${accountId}/messages`, { body: { recipient: { id: recipient }, message: { text: request.body } }, signal });
  if (!answer.ok) return { state: answer.kind, error: answer.message };
  const id = answer.data?.message_id;
  const from = typeof settings.username === "string" && settings.username ? `@${settings.username.replace(/^@/, "")}` : undefined;
  return { state: "sent", ...(typeof id === "string" && id ? { externalId: id } : {}), threadKey: `${String(account._id)}:${recipient}`, to: recipient, ...(from ? { from } : {}) };
}

/**
 * The username and name behind an Instagram-scoped id (allowed once they have written to the account). Undefined when Instagram doesn't
 * say (a block, no consent, a network problem): the message then waits as a new conversation.
 */
export async function instagramProfile(secrets: MetaSecrets, igsid: string, signal?: AbortSignal): Promise<{ username?: string; name?: string } | undefined> {
  if (!/^\d{5,40}$/.test(igsid)) return undefined;
  const answer = await graphCall<any>("instagram", secrets, "GET", igsid, { query: { fields: "username,name" }, signal, timeoutMs: PROFILE_TIMEOUT_MS });
  if (!answer.ok) return undefined;
  const username = typeof answer.data?.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(answer.data.username) ? answer.data.username : undefined;
  const name = typeof answer.data?.name === "string" && answer.data.name.trim() ? answer.data.name.trim().slice(0, 120) : undefined;
  return username || name ? { ...(username ? { username } : {}), ...(name ? { name } : {}) } : undefined;
}

export const instagramProvider: ChannelProvider = {
  kind: "instagram",
  async test(account, secrets, signal) {
    try { return await testInstagram(account, secrets, signal); } catch { return { ok: false, message: "The Instagram test could not finish: try again", checks: [] }; }
  },
  async send(request, signal) {
    try { return await sendInstagram(request, signal); } catch { return { state: "uncertain", error: "Something broke while sending through Instagram: check the Instagram app before sending again" }; }
  },
};
