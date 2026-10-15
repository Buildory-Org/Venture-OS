// The Inbox's receiving side, clicked through and photographed (Playwright, gstack's bundled copy): a lead replies, the person answers
// from the Inbox (their own reply is ready at once), the send step shows inline, it is marked sent by hand and the reply is handled.
// Also: Claude's reply (written and reviewed through the connector) sent from the Inbox, "Ask Claude to check it first", a reply that came
// to someone's phone logged with They replied in the lead drawer, and the empty Inbox. Also two answers to one message: one is marked sent,
// the other closes ("Closed: another reply went out"), and a reply written after the message was answered says so instead of offering a
// send. Desktop 1440x900, phone 375x812, dark.
//
// Never sends anything: the browser sees one fake mailbox only (the channel list is replaced in the test browser, so no real account is
// ever offered), any send through an account is blocked in the browser, and every send is "marked sent by hand". QA leads are tagged
// "qa" and soft-deleted at the end; `apps/api/scripts/clean-sales-dev.ts --qa` removes them for good.
//
//   node tooling/sales-qa/inbox-flow.mjs [--base http://localhost:3000] [--api http://localhost:4000] [--keep]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(homedir(), ".claude/skills/gstack/node_modules/"));
const { chromium } = require("playwright");
const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback;
const base = arg("base", "http://localhost:3000"), apiBase = arg("api", "http://localhost:4000"), keep = argv.includes("--keep");
const out = join(process.env.QA_OUT ?? join(homedir(), "AppData/Local/Temp/claude/vso-qa"), `inbox-flow-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(out, { recursive: true });
const run = Date.now().toString(36), ME = "user-divyansh", HEAD = "user-adarsh";
const FAKE_MAILBOX = "qa-fake-mailbox@example.invalid";
let failed = 0, passed = 0;
const shots = [];
const consoleErrors = [];

async function api(user, method, path, body, origin = apiBase) {
  // A server that restarts mid-run (the API reloads on every change) fails the call, never the clean-up after it.
  const response = await fetch(`${origin}/v1${path}`, { method, headers: { "x-dev-user-id": user, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).catch((error) => { console.log(`  (api ${method} ${path} -> ${error.message})`); return null; });
  if (!response) return undefined;
  const json = await response.json().catch(() => null);
  if (!response.ok) console.log(`  (api ${method} ${path} -> ${response.status} ${json?.error?.message ?? ""})`);
  return json?.data;
}
function check(name, ok, detail = "") { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`); return ok; }
async function shot(page, name) { const path = join(out, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`); await page.screenshot({ path, fullPage: false }); shots.push(path); }

// ---- Seed: leads that were written to and answered -----------------------------------------------------------------------------
const created = [];
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
async function lead(name, extra = {}) {
  const tag = name.toLowerCase().replace(/[^a-z]+/g, "-");
  const item = await api(ME, "POST", "/sales/leads", { pipelineId: "pipeline-buildory", companyName: `QA ${name} ${run}`, ownerId: ME, contactName: "Asha", city: "Raipur", category: "QA test record", stage: "approved_for_contact", contactRoutes: [{ kind: "email", value: `qa-${tag}-${run}@example.invalid` }], tags: ["qa"], ...extra });
  if (!item?.id) throw new Error(`could not create the QA lead "${name}" (is the API up?)`);
  created.push(item.id);
  return item;
}
/** Our first email (two days ago), then their answer now. */
async function conversation(item, replyType, words) {
  await api(ME, "POST", `/sales/leads/${item.id}/activities`, { kind: "email", direction: "out", at: twoDaysAgo, body: "Subject: Contractor rates at your store\n\nHello Asha,\n\nI saw the bulk rates for contractors on your site. When those change, how do regular buyers get the right price?\n\nWorth a 20-minute call?\n\nDivyansh, Buildory" });
  return (await api(ME, "POST", `/sales/leads/${item.id}/activities`, { kind: "email", direction: "in", body: words, ...(replyType ? { replyType } : {}) }))?.activity;
}

const own = await lead("Inbox Own Reply");
const ownIn = await conversation(own, "interested", "QA: Yes, this is a real problem for us. Can we talk this week?");
const claudeLead = await lead("Inbox Claude Reply");
const claudeIn = await conversation(claudeLead, "send_details", "QA: Please send the details first, then we can talk.");
const checkLead = await lead("Inbox Check First");
const checkIn = await conversation(checkLead, "price_first", "QA: What does it cost?");
const phoneLead = await lead("Inbox Phone Reply", { contactRoutes: [{ kind: "email", value: `qa-phone-${run}@example.invalid` }, { kind: "phone", value: "+91 90000 00021" }] });
await api(ME, "POST", `/sales/leads/${phoneLead.id}/activities`, { kind: "email", direction: "out", at: twoDaysAgo, body: "Subject: Contractor rates\n\nHello Asha, worth a short call?" });
const mobile = await lead("Inbox Phone Screen");
const mobileIn = await conversation(mobile, undefined, "QA: Sounds good. Send me a time.");
// Two answers to the same message, both written by a person (ready at once).
const twice = await lead("Inbox Two Answers");
const twiceIn = await conversation(twice, "interested", "QA: Interesting. Who do I talk to?");
if (![ownIn, claudeIn, checkIn, mobileIn, twiceIn].every((item) => item?.id)) throw new Error("could not log the QA replies");
const ownReply = (body) => api(ME, "POST", `/sales/leads/${twice.id}/drafts`, { channel: "email", purpose: "reply", inReplyTo: twiceIn.id, subject: "Re: Contractor rates at your store", body });
const answerA = await ownReply("Hello Asha,\n\nYou talk to me. Tuesday at 11 for 20 minutes?\n\nDivyansh (QA answer A)");
const answerB = await ownReply("Hello Asha,\n\nThat would be me. Would Wednesday at 4 suit you?\n\nDivyansh (QA answer B)");
check("seed: two answers to one message, both ready", answerA?.status === "ready" && answerB?.status === "ready", `${answerA?.status} ${answerB?.status}`);

// Claude's answer to the "details" reply, written in one connector session and reviewed in another (as a venture head's Claude).
let claudeDraftId = "", patId = "";
try {
  const pat = await api(HEAD, "POST", "/pats", { name: `QA inbox flow ${run}`, scopes: ["ventures:read", "sales:read", "sales:write"], expiresInDays: 1 }, base);
  patId = pat?.pat?.id ?? "";
  let rpcId = 0;
  const tool = async (name, args) => {
    const response = await fetch(`${base}/mcp/sales`, { method: "POST", headers: { authorization: `Bearer ${pat?.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }) });
    const text = await response.text();
    const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop() ?? "null");
    const content = json?.result?.content?.[0]?.text ?? "";
    try { return JSON.parse(content); } catch { return {}; }
  };
  const work = await tool("start_sales", { mode: "work", timezone: "Asia/Kolkata" });
  const saved = await tool("save_draft", { leadId: claudeLead.id, sessionId: work.sessionId, channel: "email", purpose: "reply", inReplyTo: claudeIn.id, subject: "Re: Contractor rates at your store", body: "Hello Asha,\n\nHappy to. In short: one place for your catalog, each buyer's rate and the order status, set up around how your team works today.\n\nWould Tuesday or Wednesday at 11 suit you for 20 minutes?\n\nDivyansh, Buildory" });
  claudeDraftId = saved.draftId ?? saved.id ?? "";
  const review = await tool("start_sales", { mode: "review", timezone: "Asia/Kolkata" });
  await tool("review_draft", { draftId: claudeDraftId, sessionId: review.sessionId, result: "pass", notes: "QA: answers the ask, one next step." });
} catch (error) { console.log(`  (connector: ${error.message})`); }
const claudeDraft = claudeDraftId ? (await api(ME, "GET", `/sales/leads/${claudeLead.id}`))?.drafts?.find((draft) => draft.id === claudeDraftId) : null;
check("seed: Claude's reply written and reviewed through the connector (ready)", claudeDraft?.status === "ready" && claudeDraft?.authorVia === "claude", `${claudeDraft?.status} ${claudeDraft?.authorVia}`);
console.log(`seeded 6 QA leads (run ${run})`);

// ---- Browser -----------------------------------------------------------------------------------------------------------------------
const fakeMailbox = { id: "qa-fake-mailbox", workspaceId: "workspace-studio", kind: "email", label: "QA fake mailbox", ownerUserId: ME, ventureIds: ["venture-buildory"], defaultFor: ["venture-buildory"], enabled: true, status: "connected",
  settings: { address: FAKE_MAILBOX, senderName: "QA", username: FAKE_MAILBOX, smtp: { host: "smtp.example.invalid", port: 465, security: "ssl" }, imap: { host: "imap.example.invalid", port: 993, security: "ssl" }, syncInbox: true, saveToSent: true },
  secrets: { password: { set: true } }, createdBy: ME, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canManage: true };
const blockedSends = [];
const browser = await chromium.launch({ headless: true });
async function open({ width = 1440, height = 900, dark = false, phone: isPhone = false, emptyInbox = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: isPhone, hasTouch: isPhone, deviceScaleFactor: isPhone ? 2 : 1, reducedMotion: "reduce", colorScheme: dark ? "dark" : "light" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await context.addCookies([{ name: "venture_studio_theme", value: dark ? "dark" : "light", url: base }]);
  await context.addInitScript((user) => { try { window.localStorage.setItem("vso-dev-user-id", user); } catch {} }, ME);
  // The only account this browser knows: a fake mailbox. Nothing on the server is created or changed.
  await context.route(/\/v1\/sales\/channels(\?.*)?$/, (route) => route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [fakeMailbox] }) }) : route.continue());
  // Belt and braces: a send through an account never leaves this browser.
  await context.route(/\/v1\/sales\/drafts\/[^/?]+\/send(\?.*)?$/, (route) => { blockedSends.push(route.request().url()); return route.abort(); });
  if (emptyInbox) await context.route(/\/v1\/sales\/inbox\?/, (route) => route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [] }) }) : route.continue());
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${page.url().replace(base, "")}: ${message.text().slice(0, 240)}`); });
  page.on("pageerror", (error) => consoleErrors.push(`${page.url().replace(base, "")}: ${error.message.slice(0, 240)}`));
  page.on("response", (response) => { if ((response.url().includes("/v1/") && response.status() >= 400) || response.status() >= 500) consoleErrors.push(`${page.url().replace(base, "")}: HTTP ${response.status()} ${response.request().method()} ${response.url().replace(base, "").replace(apiBase, "")}`); });
  return { context, page };
}
async function go(page, path) {
  await page.goto(base + path, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector(".vso-skeleton, [role='status'][aria-label^='Loading']"), null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
}
const visible = (locator) => locator.locator("visible=true").first();
const seen = (locator) => visible(locator).isVisible().catch(() => false);
const pause = () => { console.log("  (waiting a minute: the API allows 300 reads a minute per person)"); return new Promise((resolve) => setTimeout(resolve, 61_000)); };
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const detailOf = (leadId) => api(ME, "GET", `/sales/leads/${leadId}`);
/** Picks a choice in the app's own select (a combobox and a list of options). */
async function choose(page, name, option) {
  await visible(page.getByRole("combobox", { name })).click(); await page.waitForTimeout(250);
  await page.getByRole("option", { name: option, exact: true }).click(); await page.waitForTimeout(250);
}
/** "Did you send it?": it went from somewhere else (the fake mailbox is not a real account), then yes. */
async function markSentByHand(page, tag) {
  await visible(page.getByRole("button", { name: /^More/ })).click(); await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: "I sent it myself" }).click(); await page.waitForTimeout(500);
  check(`${tag}: "Did you send it?" asks before recording`, await seen(page.getByText("Did you send it?")));
  if (await page.getByRole("combobox", { name: "Sent from" }).count()) await choose(page, "Sent from", "Somewhere else");
  await shot(page, `${tag}-did-you-send-it`);
  await visible(page.getByRole("button", { name: /Yes, mark it sent/ })).click(); await page.waitForTimeout(2200);
}

try {
  // 1. Desktop, light: answer a warm reply from the Inbox, ready at once, marked sent by hand, handled.
  {
    const { context, page } = await open();
    await go(page, `/sales/live/inbox?reply=${ownIn.id}`);
    check("the reply is in the Inbox list", await page.locator(`[data-reply-id="${ownIn.id}"]`).count() === 1);
    check("the conversation shows their words and ours", await seen(page.getByText("QA: Yes, this is a real problem for us. Can we talk this week?")) && await seen(page.getByText(/I saw the bulk rates for contractors/)));
    const header = page.locator("article").first();
    check("reply type and reply-time chips show", await seen(header.getByText("Interested")) && await seen(header.getByText(/^(Waiting |Over \d+h|Clock starts )/)));
    check("Ask Claude to draft replies is still there", await seen(page.getByText("draft replies to my inbox")));
    await shot(page, "inbox-desktop-reply");

    await visible(page.getByRole("button", { name: "Write a reply" })).click(); await page.waitForTimeout(500);
    const composer = page.getByRole("form", { name: "Your reply" });
    check("composer opens with Reply by, the text box and two buttons", await composer.isVisible().catch(() => false) && await seen(composer.getByRole("button", { name: "Save and send" })) && await seen(composer.getByRole("button", { name: "Ask Claude to check it first" })));
    check("says where the reply goes out from (the mailbox)", await seen(composer.getByText(`Your reply goes out from ${FAKE_MAILBOX}.`)));
    check("subject starts as Re: our last email", await composer.getByRole("textbox", { name: "Subject" }).inputValue().catch(() => "") === "Re: Contractor rates at your store");
    check("WhatsApp is not offered, and says why", await seen(composer.getByText(/Not offered: WhatsApp \(they haven't said yes to WhatsApp yet\)/)));
    await visible(composer.getByRole("combobox", { name: "Reply by" })).click(); await page.waitForTimeout(250);
    check("channel picker: email on, WhatsApp off", await page.getByRole("option", { name: "Email", exact: true }).count() === 1 && await page.getByRole("option", { name: "WhatsApp (not available)" }).getAttribute("aria-disabled") === "true");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    await composer.getByRole("textbox", { name: "Your reply" }).fill("Hello Asha,\n\nGlad to hear it. Would Tuesday or Wednesday at 11 work for a 20-minute call?\n\nDivyansh");
    await shot(page, "inbox-desktop-composer");

    await composer.getByRole("button", { name: "Save and send" }).click(); await page.waitForTimeout(2200);
    const saved = (await detailOf(own.id))?.drafts?.find((draft) => draft.purpose === "reply");
    check("saved ready at once, as the person's own approved reply", saved?.status === "ready" && saved?.personApproval?.own === true && saved?.personApproval?.by === ME && !saved?.review, `${saved?.status} ${JSON.stringify(saved?.personApproval)}`);
    check("the reply names the message it answers", saved?.inReplyTo === ownIn.id);
    const card = page.getByRole("region", { name: "Your reply" });
    check("the reply card shows inline: written and approved by you", await seen(card.getByText("Written and approved by you")));
    check("Save and send opened the send step at once (confirm, from the mailbox)", await seen(page.getByRole("alertdialog", { name: "Confirm sending" })) && await seen(page.getByText(new RegExp(`Send this email to qa-inbox-own-reply-${run}@example.invalid from ${FAKE_MAILBOX.replace(/\./g, "\\.")}\\?`))));
    check("Open in Review stays as a small link", await visible(card.getByRole("link", { name: /Open in Review/ })).getAttribute("href").then((href) => href?.includes(`draft=${saved?.id}`)).catch(() => false));
    await shot(page, "inbox-desktop-ready-confirm");
    await visible(page.getByRole("button", { name: "Not yet" })).click(); await page.waitForTimeout(400);
    check("the same main action as Review: Send from the mailbox", await seen(page.getByRole("button", { name: `Send from ${FAKE_MAILBOX}` })));
    check("the how-it's-recorded line shows", await seen(page.getByText(/Goes from your mailbox, saved in your Sent folder; replies arrive in Sales > Inbox\./)));
    check("no second reply offered while this one is ready", await page.getByRole("button", { name: /Write (a|my own) reply/ }).count() === 0);
    await shot(page, "inbox-desktop-ready-send");

    await markSentByHand(page, "inbox-desktop");
    const after = await detailOf(own.id);
    const sent = after?.drafts?.find((draft) => draft.id === saved?.id);
    const handledIn = after?.activities?.find((activity) => activity.id === ownIn.id);
    check("marked sent by hand (manual), nothing sent", sent?.status === "sent" && sent?.sentVia === "manual" && blockedSends.length === 0, `${sent?.status} ${sent?.sentVia} blocked=${blockedSends.length}`);
    check("the reply is handled", Boolean(handledIn?.handledAt));
    check("it left the Needs a reply list", await page.locator(`[data-reply-id="${ownIn.id}"]`).count() === 0);
    check("the reader moved on to the next reply", !page.url().includes(ownIn.id) && /reply=/.test(page.url()));
    await shot(page, "inbox-desktop-after-sent");

    // Claude's reply, reviewed in another session: sent from the Inbox the same way, with Open in Review as a link.
    await go(page, `/sales/live/inbox?reply=${claudeIn.id}`);
    const claudeCard = page.getByRole("region", { name: "Claude's reply" });
    check("Claude's ready reply shows inline", await seen(claudeCard.getByText("Passed Claude's review")) && await seen(claudeCard.getByText(/one place for your catalog/)));
    check("Claude's reply: the main action is Send from the mailbox", await seen(claudeCard.getByRole("button", { name: `Send from ${FAKE_MAILBOX}` })));
    check("Claude's reply: no confirm opens by itself", await page.getByRole("alertdialog", { name: "Confirm sending" }).count() === 0);
    await visible(claudeCard).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300);
    await shot(page, "inbox-desktop-claude-reply");

    // "Ask Claude to check it first": saved for Claude's review in another chat.
    await go(page, `/sales/live/inbox?reply=${checkIn.id}`);
    await visible(page.getByRole("button", { name: "Write a reply" })).click(); await page.waitForTimeout(400);
    await page.getByRole("form", { name: "Your reply" }).getByRole("textbox", { name: "Your reply" }).fill("Hello Asha,\n\nIt depends on how many buyers and products you have: most stores land between two ranges we can show you on a short call. Tuesday at 11?\n\nDivyansh");
    await page.getByRole("button", { name: "Ask Claude to check it first" }).click(); await page.waitForTimeout(2000);
    const checked = (await detailOf(checkLead.id))?.drafts?.find((draft) => draft.purpose === "reply");
    check("Ask Claude to check it first: waits for Claude's review", checked?.status === "in_review" && !checked?.personApproval);
    check("the card says it waits for Claude's review, with the prompt for a new chat", await seen(page.getByText("Waiting for Claude's review")) && await seen(page.getByText("review drafts", { exact: true })));
    check("you can still write your own instead", await seen(page.getByRole("button", { name: "Write my own reply" })));
    await shot(page, "inbox-desktop-check-first");
    await context.close();
  }

  // 1b. Two answers to one message: one is marked sent by hand, the API closes the other ("Closed: another reply went out"). A reply written
  // after the message was answered says so in Review instead of offering a send.
  await pause();
  {
    const { context, page } = await open();
    await go(page, `/sales/live/inbox?reply=${twiceIn.id}`);
    check("two answers: both show as reply cards", await page.getByRole("region", { name: "Your reply" }).count() === 2);
    await markSentByHand(page, "inbox-desktop-two-answers");
    const after = await detailOf(twice.id);
    const [sentOne, otherOne] = [answerA, answerB].map((answer) => after?.drafts?.find((item) => item.id === answer?.id));
    const sent = [sentOne, otherOne].find((item) => item?.status === "sent");
    const other = [sentOne, otherOne].find((item) => item && item !== sent);
    check("two answers: one marked sent by hand", Boolean(sent) && sent.sentVia === "manual" && blockedSends.length === 0);
    if (other?.status === "discarded" && other?.closedReason === "other_reply_sent") {
      check("two answers: the API closed the other one (other_reply_sent)", true);
      await go(page, `/sales/live/inbox?reply=${twiceIn.id}`);
      check("Inbox: the closed answer reads Closed: another reply went out", await seen(page.getByText("Closed: another reply went out")));
      await visible(page.getByText("Closed: another reply went out")).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300);
      await shot(page, "inbox-desktop-closed-reply");
      await go(page, `/sales/live/review?draft=${other.id}`);
      check("Review: the closed answer's title is Closed: another reply went out", await seen(page.getByText("Closed: another reply went out")) && await seen(page.getByText(/Only one answer to a message goes out/)));
      await shot(page, "review-desktop-closed-reply");
    } else {
      console.log(`NOTE  the API left the other answer ${other?.status ?? "missing"} (no other_reply_sent yet): checking the "already answered" state on it instead`);
      await go(page, `/sales/live/review?draft=${other?.id}`);
      check("Review: the other open answer says the message was already answered", await seen(page.getByText("Their message was already answered")));
    }
    // A reply written after the message was answered: Review shows that instead of a send button.
    const late = await ownReply("Hello Asha,\n\nJust checking you got my note.\n\nDivyansh (QA late answer)");
    if (late?.id) {
      await go(page, `/sales/live/review?draft=${late.id}`);
      check("Review: a reply to an answered message says so", await seen(page.getByText("Their message was already answered")) && await seen(page.getByText("Already answered: nothing to send.")));
      check("Review: no send offered for it (no Send, no I sent it myself)", await page.getByRole("button", { name: /^Send from/ }).count() === 0 && await page.getByRole("link", { name: /Copy and open mail app/ }).count() === 0
        && await (async () => { await visible(page.getByRole("button", { name: /^More/ })).click(); await page.waitForTimeout(300); const none = await page.getByRole("menuitem", { name: "I sent it myself" }).count() === 0; await page.keyboard.press("Escape"); return none; })());
      await shot(page, "review-desktop-already-answered");
    } else console.log("NOTE  the API refused a reply to an answered message: nothing to check there");
    await context.close();
  }

  // 2. A reply that came to someone's phone: logged with They replied in the lead drawer, then it waits in the Inbox.
  await pause();
  {
    const { context, page } = await open();
    await go(page, `/sales/live/leads?lead=${phoneLead.id}`);
    const drawer = page.getByRole("dialog");
    const outsideLine = drawer.getByText(/Got a reply on your phone or in your own mail\? Log it with/);
    check("drawer: says how to log a reply from your phone or mail", await seen(outsideLine));
    await visible(outsideLine).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300);
    await shot(page, "drawer-desktop-outside-reply-line");
    await visible(drawer.getByRole("button", { name: "They replied" })).click(); await page.waitForTimeout(400);
    await choose(page, "They replied by", "WhatsApp");
    await choose(page, "What they said", "Interested");
    await drawer.getByRole("textbox", { name: /Their words/ }).fill("QA: replied on my phone. Call me tomorrow after 4.");
    await shot(page, "drawer-desktop-they-replied");
    await visible(drawer.getByRole("button", { name: /Log this reply/ })).click(); await page.waitForTimeout(1800);
    const logged = (await detailOf(phoneLead.id))?.activities?.find((activity) => activity.direction === "in");
    check("They replied logs an inbound reply (not handled)", logged?.kind === "whatsapp" && logged?.replyType === "interested" && !logged?.handledAt, JSON.stringify({ kind: logged?.kind, type: logged?.replyType }));
    await go(page, `/sales/live/inbox?reply=${logged?.id}`);
    check("the logged reply waits in the Inbox", await page.locator(`[data-reply-id="${logged?.id}"]`).count() === 1 && await seen(page.getByText("QA: replied on my phone. Call me tomorrow after 4.")));
    await shot(page, "inbox-desktop-logged-phone-reply");
    await context.close();
  }

  // 3. The empty Inbox (the list is emptied in this browser only): the line about replies outside the app.
  {
    const { context, page } = await open({ emptyInbox: true });
    await go(page, "/sales/live/inbox");
    check("empty Inbox: Got a reply on your phone or in your own mail?", await seen(page.getByText("Got a reply on your phone or in your own mail? Log it with They replied on the lead so it shows here.")));
    await shot(page, "inbox-desktop-empty");
    await context.close();
  }

  // 4. Phone, 375 x 812: open a reply, write, save and send, mark sent by hand, back to the list.
  await pause();
  {
    const { context, page } = await open({ width: 375, height: 812, phone: true });
    await go(page, "/sales/live/inbox");
    check("phone: list fits the screen", await overflowX(page) <= 1, `overflow ${await overflowX(page)}px`);
    await visible(page.locator(`[data-reply-id="${mobileIn.id}"]`)).click(); await page.waitForTimeout(1500);
    check("phone: reader fits the screen", await overflowX(page) <= 1, `overflow ${await overflowX(page)}px`);
    check("phone: the sort-it question shows for an unsorted reply", await seen(page.getByText("What kind of reply is this?")));
    await shot(page, "inbox-phone-reply");
    await visible(page.getByRole("button", { name: "Write a reply" })).click(); await page.waitForTimeout(500);
    await page.getByRole("form", { name: "Your reply" }).getByRole("textbox", { name: "Your reply" }).fill("Hello Asha, how about Tuesday at 11 for 20 minutes? Divyansh");
    check("phone: composer fits the screen", await overflowX(page) <= 1, `overflow ${await overflowX(page)}px`);
    await shot(page, "inbox-phone-composer");
    await page.getByRole("button", { name: "Save and send" }).click(); await page.waitForTimeout(2200);
    check("phone: the send step opens inline", await seen(page.getByRole("alertdialog", { name: "Confirm sending" })));
    await shot(page, "inbox-phone-confirm");
    await visible(page.getByRole("button", { name: "Not yet" })).click(); await page.waitForTimeout(400);
    const main = visible(page.getByRole("button", { name: `Send from ${FAKE_MAILBOX}` }));
    const box = await main.boundingBox().catch(() => null);
    check("phone: the main button takes the row beside More", !!box && box.width >= 375 - 96 - 56, box ? `${Math.round(box.width)}px` : "not found");
    await main.scrollIntoViewIfNeeded();
    await shot(page, "inbox-phone-ready-send");
    await markSentByHand(page, "inbox-phone");
    const after = await detailOf(mobile.id);
    check("phone: marked sent by hand and handled", after?.drafts?.find((draft) => draft.purpose === "reply")?.status === "sent" && Boolean(after?.activities?.find((activity) => activity.id === mobileIn.id)?.handledAt));
    check("phone: back on the list, without the handled reply", await page.locator(`[data-reply-id="${mobileIn.id}"]`).count() === 0 && await seen(page.getByRole("group", { name: "Which replies" }).or(page.getByText("Needs a reply", { exact: false }))));
    await shot(page, "inbox-phone-after-sent");
    await context.close();
  }

  // 5. Dark: Claude's ready reply, and writing your own over a reply that waits for Claude's check (desktop and phone).
  await pause();
  {
    const { context, page } = await open({ dark: true });
    await go(page, `/sales/live/inbox?reply=${claudeIn.id}`);
    await visible(page.getByRole("region", { name: "Claude's reply" })).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300);
    await shot(page, "inbox-desktop-dark-claude-reply");
    await go(page, `/sales/live/inbox?reply=${checkIn.id}`);
    await visible(page.getByRole("button", { name: "Write my own reply" })).click(); await page.waitForTimeout(500);
    check("dark: writing your own says it replaces the draft waiting for review", await seen(page.getByText("Saving this replaces the draft above that waits for a review.")));
    await shot(page, "inbox-desktop-dark-composer");
    await context.close();
  }
  {
    const { context, page } = await open({ width: 375, height: 812, phone: true, dark: true });
    await go(page, `/sales/live/inbox?reply=${claudeIn.id}`);
    check("phone dark: reader fits the screen", await overflowX(page) <= 1, `overflow ${await overflowX(page)}px`);
    await visible(page.getByRole("region", { name: "Claude's reply" })).scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, "inbox-phone-dark-claude-reply");
    await context.close();
  }
} catch (error) {
  check("click-through ran to the end", false, error.message.split("\n")[0]);
} finally {
  await browser.close();
  if (patId) await api(HEAD, "POST", `/pats/${patId}/revoke`, {}, base);
  if (!keep) for (const id of created) await api(ME, "DELETE", `/sales/leads/${id}`);
}
check("nothing was sent through an account", blockedSends.length === 0, blockedSends.join(", "));
const relevant = consoleErrors.filter((line) => !/favicon|Download the React DevTools/i.test(line));
check("no console or page errors", relevant.length === 0, relevant.slice(0, 5).join(" | "));
console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"} (${passed} passed) · ${shots.length} screenshots: ${out}${keep ? "" : "\nQA leads soft-deleted; remove them for good with clean-sales-dev.ts --qa"}`);
process.exit(failed ? 1 : 0);
