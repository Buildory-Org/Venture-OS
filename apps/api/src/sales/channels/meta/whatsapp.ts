// WhatsApp through a venture's WhatsApp Business number (Meta Cloud API) (docs/sales-channels.md section 4). The test reads the number and
// the WhatsApp Business account without sending anything; a send is one POST /<phoneNumberId>/messages: free text inside the 24-hour
// window, an approved template outside it (the send route decides which), answering their message when it replies to one. Meta saying no
// is `failed` (fix and send again); no clear answer is `uncertain` (a person checks WhatsApp before anything is sent again).
import type { ChannelAccountTest } from "@venture-studio/contracts";
import type { AppDocument } from "../../../db.js";
import type { ChannelProvider, SendOutcome, SendRequest } from "../provider.js";
import { graphCall } from "./graph.js";
import { templateParameterNames } from "./templates.js";

/** A test result plus what the test learned about the account (the test route merges `learned` into the stored settings). */
export type MetaTestResult = ChannelAccountTest & { learned?: Record<string, string> };

const META_ID = /^\d{5,30}$/;
/** WhatsApp's limit for a text message body. */
const MAX_TEXT = 4_096;

const missingSecrets = (secrets: Record<string, string>) => ["accessToken", "appSecret"].filter((name) => !secrets[name]);
const secretWords: Record<string, string> = { accessToken: "the access token", appSecret: "the app secret" };

async function testWhatsapp(account: AppDocument, secrets: Record<string, string>, signal: AbortSignal): Promise<MetaTestResult> {
  const settings = (account.settings ?? {}) as Record<string, unknown>;
  const missing = missingSecrets(secrets);
  if (missing.length) {
    const detail = `Save ${missing.map((name) => secretWords[name]).join(" and ")} again: ${missing.length > 1 ? "they are" : "it is"} missing or can't be read`;
    return { ok: false, message: detail, checks: [{ name: "Token and app secret", ok: false, detail }] };
  }
  const checks: ChannelAccountTest["checks"] = [];
  const phoneNumberId = String(settings.phoneNumberId ?? "");
  const businessAccountId = String(settings.businessAccountId ?? "");
  let displayNumber: string | undefined;
  if (!META_ID.test(phoneNumberId)) checks.push({ name: "Phone number", ok: false, detail: "The phone number id should be the long number Meta shows under WhatsApp > API setup" });
  else {
    const phone = await graphCall<any>("whatsapp", secrets, "GET", phoneNumberId, { query: { fields: "display_phone_number,verified_name,quality_rating" }, signal });
    if (phone.ok) {
      displayNumber = typeof phone.data?.display_phone_number === "string" ? phone.data.display_phone_number.trim() : undefined;
      const name = typeof phone.data?.verified_name === "string" ? phone.data.verified_name : "";
      const quality = typeof phone.data?.quality_rating === "string" ? phone.data.quality_rating : "";
      checks.push({ name: "Phone number", ok: true, detail: [displayNumber, name && `(${name})`, quality && `quality ${quality.toLowerCase()}`].filter(Boolean).join(" ") || "Found" });
    } else checks.push({ name: "Phone number", ok: false, detail: phone.message });
  }
  if (!META_ID.test(businessAccountId)) checks.push({ name: "WhatsApp Business account", ok: false, detail: "The WhatsApp Business account id should be the long number Meta shows under WhatsApp > API setup" });
  else {
    const templates = await graphCall<any>("whatsapp", secrets, "GET", `${businessAccountId}/message_templates`, { query: { limit: "1", fields: "name" }, signal });
    checks.push(templates.ok ? { name: "WhatsApp Business account", ok: true, detail: "Its message templates can be read" } : { name: "WhatsApp Business account", ok: false, detail: templates.message });
  }
  const failed = checks.find((check) => !check.ok);
  return {
    ok: !failed, message: failed ? `${failed.name}: ${failed.detail ?? "not reachable"}` : `Connected${displayNumber ? `: ${displayNumber}` : ""}. Nothing was sent.`, checks,
    ...(displayNumber ? { learned: { displayNumber } } : {}),
  };
}

async function sendWhatsapp(request: SendRequest, signal: AbortSignal): Promise<SendOutcome> {
  const { account, secrets } = request;
  const settings = (account.settings ?? {}) as Record<string, unknown>;
  const phoneNumberId = String(settings.phoneNumberId ?? "");
  if (!META_ID.test(phoneNumberId)) return { state: "failed", error: "This WhatsApp account has no valid phone number id: fix it in Sales > Channels" };
  if (!secrets.accessToken) return { state: "failed", error: "This WhatsApp account's access token can't be read: save it again in Sales > Channels" };
  // Meta takes the number as digits with the country code and no "+".
  const digits = request.to.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return { state: "failed", error: "The lead's WhatsApp number isn't a full international number" };
  const message: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", to: digits };
  if (request.template) {
    const { name, language, variables } = request.template;
    // A template with named values ({{first_name}}) needs each value's name; numbered ones go in order.
    const names = variables.length ? await templateParameterNames(account, secrets, name, language, signal) : undefined;
    message.type = "template";
    message.template = {
      name, language: { code: language },
      ...(variables.length ? { components: [{ type: "body", parameters: variables.map((text, index) => ({ type: "text", ...(names?.[index] ? { parameter_name: names[index] } : {}), text })) }] } : {}),
    };
  } else {
    if (!request.body.trim()) return { state: "failed", error: "The message is empty" };
    if (request.body.length > MAX_TEXT) return { state: "failed", error: `WhatsApp messages can be at most ${MAX_TEXT.toLocaleString("en-IN")} characters: shorten it` };
    message.type = "text";
    message.text = { preview_url: false, body: request.body };
  }
  if (request.inReplyTo?.externalId) message.context = { message_id: request.inReplyTo.externalId };
  const answer = await graphCall<any>("whatsapp", secrets, "POST", `${phoneNumberId}/messages`, { body: message, signal });
  if (!answer.ok) return { state: answer.kind, error: answer.message };
  const id = answer.data?.messages?.[0]?.id;
  const from = typeof settings.displayNumber === "string" && settings.displayNumber ? settings.displayNumber : undefined;
  return { state: "sent", ...(typeof id === "string" && id ? { externalId: id } : {}), threadKey: `${String(account._id)}:+${digits}`, to: `+${digits}`, ...(from ? { from } : {}) };
}

export const whatsappProvider: ChannelProvider = {
  kind: "whatsapp",
  async test(account, secrets, signal) {
    try { return await testWhatsapp(account, secrets, signal); } catch { return { ok: false, message: "The WhatsApp test could not finish: try again", checks: [] }; }
  },
  async send(request, signal) {
    try { return await sendWhatsapp(request, signal); } catch { return { state: "uncertain", error: "Something broke while sending through WhatsApp: check WhatsApp before sending again" }; }
  },
};
