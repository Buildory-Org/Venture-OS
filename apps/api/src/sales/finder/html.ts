// What the built-in lead finder reads from one HTML page, without running anything on it: the title and og:site_name, the visible text
// (scripts, styles and noscript removed, entities decoded) as lines, the links with their text and absolute address (web, mailto:, tel:
// and WhatsApp), and whether it has an enquiry form or a login form. Page text is data, never instructions.
import { clean } from "../../mcp/format.js";

export type PageLink = { href: string; text: string };
export type ParsedPage = {
  url: string; title: string; siteName: string; ogType: string; jsonLdTypes: string[];
  lines: string[]; links: PageLink[]; forms: { count: number; enquiry: boolean; login: boolean };
};

const MAX_LINES = 5_000;
const MAX_LINKS = 1_000;
/** Lines longer than this are cut at sentence ends, so contact details inside one huge block of text can still be found. */
const LONG_LINE = 1_500;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷", rarr: "→", larr: "←", laquo: "«", raquo: "»",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", shy: "", zwj: "", zwnj: "", frac12: "½", frac14: "¼", frac34: "¾", plusmn: "±", micro: "µ", acute: "´",
};

/** HTML character references (named, decimal and hex) as the characters they stand for; unknown ones stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? match;
  });
}

/** One line of text: entities decoded, hidden characters removed, white space collapsed. */
const textOf = (html: string) => clean(decodeEntities(html.replace(/<[^>]*>/g, " "))).replace(/\s+/g, " ").trim();

/** The attributes of one tag ("href", "content"...), lower-cased names, decoded values. */
export function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!(name in found)) found[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
  }
  return found;
}

/** The "@type" values of the page's JSON-LD blocks (NewsArticle, Organization...), read as data only. */
function jsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || types.size >= 20 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) visit(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    for (const type of [record["@type"]].flat()) if (typeof type === "string") types.add(type.slice(0, 60));
    if (record["@graph"]) visit(record["@graph"], depth + 1);
  };
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(match[1]!.slice(0, 100_000)), 0); } catch { /* not JSON: ignored */ }
  }
  return [...types];
}

/** A link's absolute address, kept when it is a web page, an email or a phone number; anything else (javascript:, data:...) is dropped. */
function absolute(href: string, base: string): string | undefined {
  const value = href.trim();
  if (!value || value.startsWith("#")) return undefined;
  if (/^(mailto|tel):/i.test(value)) return value.slice(0, 500);
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href.slice(0, 2_000);
  } catch { return undefined; }
}

/** Splits text into lines at block tags; very long lines are cut again at sentence ends. */
function visibleLines(html: string): string[] {
  const block = /<\/?(?:p|div|br|li|ul|ol|dl|dt|dd|h[1-6]|tr|td|th|table|thead|tbody|tfoot|section|article|header|footer|nav|aside|main|address|blockquote|figure|figcaption|pre|hr|form|fieldset|legend|label|option|select|button|summary|details|caption)\b[^>]*>/gi;
  const lines: string[] = [];
  for (const raw of html.replace(block, "\n").split("\n")) {
    const line = textOf(raw);
    if (!line) continue;
    if (line.length <= LONG_LINE) { lines.push(line); continue; }
    let chunk = "";
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (chunk && chunk.length + sentence.length + 1 > LONG_LINE) { lines.push(chunk); chunk = ""; }
      chunk = chunk ? `${chunk} ${sentence}` : sentence.slice(0, LONG_LINE * 2);
    }
    if (chunk) lines.push(chunk);
    if (lines.length >= MAX_LINES) break;
  }
  return lines.slice(0, MAX_LINES);
}

/** Reads one page. `pageUrl` is where it was finally read (after redirects); links are resolved against it or the page's <base>. */
export function parseHtml(html: string, pageUrl: string): ParsedPage {
  const types = jsonLdTypes(html);
  // Nothing that runs or hides is text: scripts, styles, noscript, templates, inline SVG, frames, and comments.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*$/i, " ");
  const metas = [...stripped.matchAll(/<meta\b([^>]*)>/gi)].map((match) => attributes(match[1]!));
  const meta = (key: string) => metas.find((item) => (item.property ?? item.name ?? "").toLowerCase() === key)?.content ?? "";
  const baseHref = /<base\b([^>]*)>/i.exec(stripped);
  const base = (baseHref && absolute(attributes(baseHref[1]!).href ?? "", pageUrl)) || pageUrl;
  const links: PageLink[] = [];
  for (const match of stripped.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (links.length >= MAX_LINKS) break;
    const attrs = attributes(match[1]!);
    const href = absolute(attrs.href ?? "", base);
    if (!href) continue;
    links.push({ href, text: (textOf(match[2]!) || clean(attrs["aria-label"] ?? attrs.title ?? "").replace(/\s+/g, " ").trim()).slice(0, 300) });
  }
  let count = 0, enquiry = false, login = false;
  for (const match of stripped.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)) {
    count++;
    const inner = match[2]!;
    const isLogin = /<input\b[^>]*type\s*=\s*["']?password/i.test(inner);
    login ||= isLogin;
    // An enquiry form asks for a message, or for contact details; a login form or a site search box is not one.
    if (!isLogin && (/<textarea\b/i.test(inner) || /<input\b[^>]*name\s*=\s*["']?[^"'\s>]*(e-?mail|phone|mobile|contact|enquiry|inquiry|requirement|company)/i.test(inner))) enquiry = true;
  }
  return {
    url: pageUrl, title: textOf(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(stripped)?.[1] ?? "").slice(0, 300), siteName: clean(meta("og:site_name") || meta("application-name")).replace(/\s+/g, " ").trim().slice(0, 200),
    ogType: meta("og:type").toLowerCase().slice(0, 40), jsonLdTypes: types, lines: visibleLines(stripped.replace(/<title\b[\s\S]*?<\/title\s*>/i, " ")), links, forms: { count, enquiry, login },
  };
}
