// The message rules Claude's drafts keep, wherever they are written: the connector's tools (mcp/tools-sales.ts) and the autopilot on the
// server (sales/autopilot). One copy, so neither can drift into a weaker form of the other.

/** Links in messages: none, except one wa.me line at the end of an email (the way to invite a WhatsApp reply without a cold first WhatsApp). */
const WA_LINK = /^(?:https:\/\/)?wa\.me\/\d{8,15}$/i;
const LINKISH = /(?:https?:\/\/|www\.)[^\s)>\]]+|\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|rb\.gy|cutt\.ly|lnkd\.in|calendly\.com|cal\.com)\/\S*|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|co|net|org|io|app|dev|me|shop|store|biz|info|ai)\/[^\s)>\]]*/gi;

/** Why a message's links break the rule, in plain words, or undefined when they don't. */
export function linkProblem(body: string, channel: string | undefined): string | undefined {
  const found = (body.match(LINKISH) ?? []).map((link) => link.replace(/[.,;:!?]+$/, ""));
  const other = found.filter((link) => !WA_LINK.test(link));
  if (other.length) return `The message contains a link (${other[0]}). Messages carry no links, except one wa.me line at the end of an email. Remove it and save again, or ask a person to edit the draft in the app.`;
  const wa = found.filter((link) => WA_LINK.test(link));
  if (!wa.length) return undefined;
  const lastLine = body.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (channel !== "email" || wa.length > 1 || !lastLine.includes(wa[0]!)) return "A wa.me link is allowed once, on the last line of an email (give the channel as email when revising). Nothing else carries a link.";
  return undefined;
}

// The autopilot's stricter check (the connector keeps linkProblem as it is): mail clients turn a bare domain into a link, so no
// domain-looking token at all, except the one wa.me line linkProblem allows. The text is NFKC-normalised first (a fullwidth dot is a dot).
// A token `label.ending` (ending of 2 to 24 letters) is a link when it has a strong sign (a path, a "www." prefix, an "@" before it) or its
// ending is a real one from the list below. Without a strong sign, `word.Word` where a capitalised word follows (a missing space between
// two sentences: "in Raipur.In March") is prose, not a link.
const ENDINGS = new Set(("com net org edu gov mil int info biz name pro mobi asia tel travel jobs coop aero museum cat xxx " +
  "io co ai me in uk us ca au nz de fr nl be ch at es it pt pl se no fi dk ie is ru ua by kz cn jp kr tw hk sg my id ph th vn la kh lk pk bd np mm ae sa qa om kw bh " +
  "il tr ir iq eg za ng ke gh tz ug zm zw ma dz tn ly sd et br ar cl pe uy py bo ec ve mx gt cr pa do cu jm tt lt lv ee cz sk hu ro bg gr rs hr si ba mk al md ge am az uz " +
  "tk ml ga cf gq zip mov bio blog studio shop store site online tech app dev xyz top click link club live work website space icu buzz fun page cloud digital " +
  "agency services solutions email today world life vip gg so sh im to cc tv ws fm ly gl io su eu one plus global group company business network systems media news " +
  "design art photo photography london nyc tokyo africa lat style zone city center academy school university college education training money finance bank loans " +
  "capital fund credit insure health care clinic doctor pharmacy fitness shopping deals sale discount market trade exchange crypto bet casino poker win game games " +
  "download stream video film movie music radio chat social love dating sex porn xyz rest bar cafe pizza menu wine beer house home land estate properties realty").split(" ").filter(Boolean));
const TOKEN = /(@)?((?:www\.)?)((?:[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?\.)+)(\p{L}{2,24})(?![\p{L}\p{N}_-])(\/[^\s]*)?/gu;
const WA_LAST_LINE = /^(?:https:\/\/)?wa\.me\/\d{8,15}$/i;

/** The domain-looking tokens in `text` that count as links (see above). */
function linkTokens(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const [whole, at, www, labels, ending, path] = match;
    const index = match.index ?? 0;
    // Part of a longer word or address already looked at ("a.b.c" inside a path, an email's local part before the @).
    if (index > 0 && /[\p{L}\p{N}_.\/-]/u.test(text[index - 1]!) && !at) continue;
    const strong = Boolean(at) || Boolean(www) || Boolean(path) || /@\S*$/.test(text.slice(Math.max(0, index - 64), index));
    if (strong) { found.push(whole!.replace(/^@/, "")); continue; }
    if (!ENDINGS.has(ending!.toLowerCase())) continue;
    // "Raipur.In March": a capitalised word right after the dot, then a space and more prose, is a missing space between sentences.
    const lastLabelEnd = labels!.slice(0, -1);
    const after = text.slice(index + whole!.length);
    if (/^\p{Lu}\p{Ll}*$/u.test(ending!) && /^\s+\p{L}/u.test(after) && !lastLabelEnd.includes(".")) continue;
    found.push(whole!);
  }
  return found;
}

/**
 * Why a message breaks the strict link rule, or undefined. `allowWaLastLine`: an email body, whose last line may be the one wa.me link
 * (checked by linkProblem); everything else (a subject, a WhatsApp message) carries no domain at all.
 */
export function strictLinkProblem(raw: string, allowWaLastLine: boolean): string | undefined {
  const text = raw.normalize("NFKC");
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  const last = lines.at(-1)?.trim() ?? "";
  const scanned = allowWaLastLine && WA_LAST_LINE.test(last) ? lines.slice(0, -1).join("\n") : text;
  const found = linkTokens(scanned);
  if (!found.length) return undefined;
  return `The message names a web address or an email address (${found[0]}): mail turns it into a link. Messages carry none, except one wa.me line at the end of an email.`;
}

/** A price or an amount in a message's text: first messages and follow-ups carry none (it is said on the call). */
export const PRICE_IN_TEXT = /(?:₹|\$|€|£)\s?\d|\b(?:rs\.?|inr|usd)\s?\d|\b\d[\d,.]*\s?(?:rupees|lakhs?|lacs?|crores?)\b/i;
