// A small client for Meta's Graph API, shared by the WhatsApp (graph.facebook.com) and Instagram (graph.instagram.com) providers, the
// template listing and the webhook (docs/sales-channels.md sections 4 to 6). Every call sends the access token in the Authorization
// header (never in the address, so it can't end up in a log line), WhatsApp calls add `appsecret_proof`, and every call gives up after
// 20 seconds. Meta's errors come back as one plain sentence a person can act on; the token and the app secret are scrubbed from anything
// that comes back, in case Meta ever echoed them.
import { createHmac, timingSafeEqual } from "node:crypto";

export type MetaProduct = "whatsapp" | "instagram";
export type MetaSecrets = { accessToken?: string | undefined; appSecret?: string | undefined };

export const DEFAULT_GRAPH_VERSION = "v25.0";
export const GRAPH_TIMEOUT_MS = 20_000;
let graphVersion = DEFAULT_GRAPH_VERSION;

/**
 * The Graph version every call uses (config.META_GRAPH_VERSION). Providers get no config, so the routers set it once when they are built;
 * anything that doesn't look like "v23.0" is ignored.
 */
export function configureMeta(options: { graphVersion?: string | undefined }): void {
  if (options.graphVersion && /^v\d+\.\d+$/.test(options.graphVersion)) graphVersion = options.graphVersion;
}
export const currentGraphVersion = () => graphVersion;

const HOST: Record<MetaProduct, string> = { whatsapp: "https://graph.facebook.com", instagram: "https://graph.instagram.com" };
/**
 * Whether calls carry `appsecret_proof`. Meta documents it for graph.facebook.com (WhatsApp); the Instagram API with Instagram Login
 * (graph.instagram.com) doesn't mention it, so Instagram calls rely on the token alone and the app secret only checks webhook signatures.
 */
const SENDS_PROOF: Record<MetaProduct, boolean> = { whatsapp: true, instagram: false };
const LABEL: Record<MetaProduct, string> = { whatsapp: "Meta (WhatsApp)", instagram: "Instagram" };

export const graphBase = (product: MetaProduct) => `${HOST[product]}/${graphVersion}`;

/** HMAC-SHA256 of the access token keyed with the app secret, in hex: tells Meta the caller also holds the app secret. */
export const appsecretProof = (accessToken: string, appSecret: string) => createHmac("sha256", appSecret).update(accessToken).digest("hex");

/** Meta's webhook signature header ("sha256=<hex>") checked against the exact body bytes and one app secret, in constant time. */
export function signatureMatches(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(String(header ?? "").trim());
  if (!match || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `failed`: Meta answered and said no (nothing happened). `uncertain`: no clear answer (network, timeout, Meta's own 5xx): it may have happened. */
export type GraphFailure = { ok: false; kind: "failed" | "uncertain"; message: string; code?: number; status?: number };
export type GraphAnswer<T> = { ok: true; data: T } | GraphFailure;
type CallOptions = { query?: Record<string, string>; body?: unknown; signal?: AbortSignal | undefined; timeoutMs?: number };

/** One Graph call. Never throws: every problem comes back as a failure with a plain message. */
export async function graphCall<T = any>(product: MetaProduct, secrets: MetaSecrets, method: "GET" | "POST", path: string, options: CallOptions = {}): Promise<GraphAnswer<T>> {
  const token = secrets.accessToken;
  if (!token) return { ok: false, kind: "failed", message: "No access token is saved for this account: paste one in Sales > Channels" };
  const url = new URL(`${graphBase(product)}/${path.replace(/^\/+/, "")}`);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  if (SENDS_PROOF[product] && secrets.appSecret) url.searchParams.set("appsecret_proof", appsecretProof(token, secrets.appSecret));
  const timeoutMs = options.timeoutMs ?? GRAPH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(url, { method, headers, signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  } catch {
    return { ok: false, kind: "uncertain", message: timeout.aborted ? `${LABEL[product]} did not answer within ${Math.round(timeoutMs / 1000)} seconds` : `${LABEL[product]} could not be reached` };
  }
  let payload: any;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (response.ok) return payload === undefined ? { ok: false, kind: "uncertain", message: `${LABEL[product]} answered with something that is not JSON`, status: response.status } : { ok: true, data: payload as T };
  const error = payload && typeof payload === "object" ? payload.error : undefined;
  const code = Number(error?.code);
  return {
    ok: false, kind: response.status >= 500 ? "uncertain" : "failed", message: scrub(metaErrorMessage(product, response.status, error), secrets), status: response.status,
    ...(Number.isFinite(code) ? { code } : {}),
  };
}

/** Removes the account's secrets from a message (Meta never echoes them, but a message is shown to people and kept on drafts). */
export function scrub(message: string, secrets: MetaSecrets): string {
  let text = message;
  for (const secret of [secrets.accessToken, secrets.appSecret]) if (secret && secret.length >= 6) text = text.split(secret).join("…");
  return text;
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** What Meta's well-known error codes mean for the person sending (WhatsApp Cloud API error codes; Graph API codes for both products). */
const KNOWN: Readonly<Record<number, string>> = {
  4: "Meta's rate limit for this app was reached: try again in a few minutes",
  80007: "Meta's rate limit for this account was reached: try again in a few minutes",
  130429: "WhatsApp's sending rate for this number was reached: try again in a few minutes",
  131026: "WhatsApp could not deliver it to this number: it may not be on WhatsApp, use an old app version, or not have accepted WhatsApp's latest terms",
  131030: "This number is not on the test number's list of allowed recipients in the Meta app",
  131031: "Meta has restricted this WhatsApp Business account: check WhatsApp Manager",
  131042: "There is a payment problem on the WhatsApp Business account: fix the payment method in Meta Business settings",
  131047: "More than 24 hours have passed since the customer last replied: send an approved template instead",
  131048: "WhatsApp is limiting messages from this number because people flagged earlier ones: send fewer messages to people who haven't replied",
  131049: "WhatsApp held it back to protect engagement with this person: don't send them another marketing message for now",
  131051: "WhatsApp doesn't support that kind of message",
  131056: "Too many messages to this person in a short time: wait a little before sending again",
  131062: "WhatsApp can't send to this kind of recipient id",
  132000: "The template's values don't match it: fill in every value the template asks for",
  132001: "That template doesn't exist in this language or isn't approved yet",
  132005: "The template's text is too long once the values are filled in",
  132007: "The template breaks a WhatsApp policy: pick another",
  132012: "A template value has the wrong format",
  132015: "WhatsApp paused that template for low quality: pick another",
  132016: "WhatsApp switched that template off for low quality: pick another",
  133010: "This phone number is not registered on the WhatsApp Cloud API yet: finish its setup in WhatsApp Manager",
  368: "Meta has temporarily blocked this account for a policy issue: check Meta Business Support",
  551: "This person isn't available on Instagram right now",
};

/** One plain sentence for a Meta error (the `error` object of a failed Graph call, or a failed delivery's `errors[0]`). */
export function metaErrorMessage(product: MetaProduct, status: number, error: any): string {
  const wa = product === "whatsapp";
  if (!error || typeof error !== "object") return status >= 500 ? `${LABEL[product]} had a problem on its side (HTTP ${status})` : `${LABEL[product]} refused the request (HTTP ${status})`;
  const code = Number(error.code);
  const subcode = Number(error.error_subcode);
  const raw = String(error.message ?? error.title ?? "").trim();
  const theirs = clip(String(error.error_data?.details ?? "").trim() || raw, 200);
  if ([190, 102, 463, 467].includes(code)) return wa ? "Meta refused the access token: make a new permanent token for the system user" : "Instagram refused the access token: it has expired or was revoked. Make a new long-lived token and save it here";
  if (/appsecret_proof/i.test(raw)) return "Meta refused the app secret: copy it again from the Meta app (App settings > Basic)";
  if (code === 10 && subcode === 2534022) return "More than 24 hours have passed since they last wrote: answer from the Instagram app and mark it sent";
  if (code === 3 || code === 10 || (code >= 200 && code <= 299) || code === 131005) {
    return wa ? "Meta says the token is missing a permission: give the system user whatsapp_business_messaging and whatsapp_business_management on this WhatsApp Business account"
      : "Instagram says the token is missing a permission: it needs instagram_business_basic and instagram_business_manage_messages";
  }
  if (code === 100 && subcode === 33) return wa ? "Meta doesn't know that id, or the token can't see it: check the phone number id and the WhatsApp Business account id" : "Instagram doesn't know that id, or the token can't see it";
  if ([17, 32, 613].includes(code)) return KNOWN[4]!;
  const known = KNOWN[code];
  if (known) return known;
  const codeNote = Number.isFinite(code) && code > 0 ? ` (code ${code})` : "";
  if (status >= 500) return `${LABEL[product]} had a problem on its side${theirs ? `: ${theirs}` : ""}${codeNote}`;
  return `${wa ? "Meta" : "Instagram"} refused it${theirs ? `: ${theirs}` : ""}${codeNote}`;
}

/** Why a WhatsApp message Meta accepted was not delivered (a `failed` status), in plain words: known codes, else Meta's own title. */
export function deliveryErrorMessage(error: any): string {
  if (!error || typeof error !== "object") return "WhatsApp could not deliver it";
  const code = Number(error.code);
  const known = KNOWN[code];
  if (known) return known;
  const title = String(error.title ?? error.message ?? "").trim();
  const details = String(error.error_data?.details ?? "").trim();
  return clip(`WhatsApp could not deliver it${title ? `: ${title}` : ""}${details && details !== title ? ` (${details})` : ""}${Number.isFinite(code) && code > 0 ? ` (code ${code})` : ""}`, 300);
}
