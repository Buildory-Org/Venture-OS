// The approved WhatsApp message templates of a venture's number (docs/sales-channels.md section 4): a person picks one to send outside the
// 24-hour window and fills in its values. Read from the WhatsApp Business account's message_templates, kept 10 minutes per account, and
// only the ones this app can really send: an approved template whose only values are in its body text. Templates that need a picture,
// video or document header, a value in the header or in a button link, a code button, or are login codes (AUTHENTICATION) are left out.
import type { WhatsappTemplate } from "@venture-studio/contracts";
import type { AppDocument } from "../../../db.js";
import { graphCall, type MetaSecrets } from "./graph.js";

const CACHE_MS = 10 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const FIELDS = "name,language,status,category,components,parameter_format";

/** A template as the API returns it, plus the names of its values when it uses named ones ({{first_name}}), in the order they appear. */
export type ParsedTemplate = WhatsappTemplate & { parameterNames?: string[] };
type Cached = { at: number; templates: ParsedTemplate[] };
const cache = new Map<string, Cached>();

const cacheKey = (account: AppDocument) => `${String(account.workspaceId)}:${String(account._id)}:${String(account.settings?.businessAccountId ?? "")}`;

/** Forgets the cached templates (one account, or all): after a token or WhatsApp Business account change, and in tests. */
export function forgetTemplates(accountId?: string): void {
  if (!accountId) { cache.clear(); return; }
  for (const key of cache.keys()) if (key.split(":")[1] === accountId) cache.delete(key);
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const SENDABLE_BUTTONS = new Set(["QUICK_REPLY", "PHONE_NUMBER", "URL", "VOICE_CALL", "FLOW"]);

/** The placeholders of a text, each once, in the order they first appear. */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]!))];
}

/** Meta's template rows → the templates this app can send, sorted by name and language. */
export function parseTemplates(rows: unknown): ParsedTemplate[] {
  if (!Array.isArray(rows)) return [];
  const parsed: ParsedTemplate[] = [];
  for (const row of rows as any[]) {
    if (!row || typeof row !== "object" || typeof row.name !== "string" || typeof row.language !== "string") continue;
    if (String(row.status ?? "").toUpperCase() !== "APPROVED" || String(row.category ?? "").toUpperCase() === "AUTHENTICATION") continue;
    const components: any[] = Array.isArray(row.components) ? row.components : [];
    let body: string | undefined;
    let sendable = true;
    for (const component of components) {
      const type = String(component?.type ?? "").toUpperCase();
      if (type === "BODY") body = typeof component.text === "string" ? component.text : "";
      else if (type === "HEADER") sendable &&= String(component.format ?? "TEXT").toUpperCase() === "TEXT" && placeholders(String(component.text ?? "")).length === 0;
      else if (type === "FOOTER") continue;
      else if (type === "BUTTONS") sendable &&= (Array.isArray(component.buttons) ? component.buttons : []).every((button: any) => SENDABLE_BUTTONS.has(String(button?.type ?? "").toUpperCase()) && !String(button?.url ?? "").includes("{{"));
      else sendable = false; // carousels, limited-time offers and the like need values this app doesn't collect
    }
    if (!sendable || body === undefined) continue;
    const names = placeholders(body);
    const named = String(row.parameter_format ?? "").toUpperCase() === "NAMED" || names.some((name) => !/^\d+$/.test(name));
    parsed.push({
      name: row.name, language: row.language, status: "APPROVED", ...(typeof row.category === "string" ? { category: row.category } : {}), body, variableCount: names.length,
      ...(named && names.length ? { parameterNames: names } : {}),
    });
  }
  return parsed.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/** The account's sendable approved templates (cached 10 minutes), or Meta's refusal in plain words. Never throws. */
export async function listTemplates(account: AppDocument, secrets: MetaSecrets, signal?: AbortSignal): Promise<{ ok: true; templates: ParsedTemplate[] } | { ok: false; error: string }> {
  const key = cacheKey(account);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, templates: hit.templates };
  const waba = String(account.settings?.businessAccountId ?? "");
  if (!/^\d{5,30}$/.test(waba)) return { ok: false, error: "This WhatsApp account has no valid WhatsApp Business account id: fix it in Sales > Channels" };
  const rows: unknown[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await graphCall<any>("whatsapp", secrets, "GET", `${waba}/message_templates`, { query: { status: "APPROVED", fields: FIELDS, limit: String(PAGE_SIZE), ...(after ? { after } : {}) }, signal });
    if (!answer.ok) return { ok: false, error: answer.message };
    if (Array.isArray(answer.data?.data)) rows.push(...answer.data.data);
    after = typeof answer.data?.paging?.cursors?.after === "string" && answer.data?.paging?.next ? answer.data.paging.cursors.after : undefined;
    if (!after) break;
  }
  const templates = parseTemplates(rows);
  cache.set(key, { at: Date.now(), templates });
  return { ok: true, templates };
}

/** The value names of a template that uses named values (sent as `parameter_name`), or undefined for numbered ones or when it can't be read. */
export async function templateParameterNames(account: AppDocument, secrets: MetaSecrets, name: string, language: string, signal?: AbortSignal): Promise<string[] | undefined> {
  const listed = await listTemplates(account, secrets, signal);
  if (!listed.ok) return undefined;
  return listed.templates.find((template) => template.name === name && template.language === language)?.parameterNames;
}
