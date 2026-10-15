// Review's send and receive screens, clicked through and photographed (Playwright, gstack's bundled copy). Seeds clearly labelled QA leads
// and drafts through the API (tag "qa"), never sends anything (every send through an account is blocked in the browser; the one Send pressed
// goes to a fake mailbox and is answered in the browser), and soft-deletes the leads at the end so `apps/api/scripts/clean-sales-dev.ts --qa`
// removes them for good.
//
//   node tooling/sales-qa/send-flow.mjs [--base http://localhost:3000] [--api http://localhost:4000] [--keep]
//
// What it covers: a lead with an email and a WhatsApp version (opted in), an email-only lead seen by someone without a mailbox (the hand
// flow: open the mail app, "Did you send it?", mark it sent), WhatsApp not opted in (locked), a draft Claude asked to change, one waiting
// for review with the WhatsApp tab missing, the More menu (keyboard), the venture's WhatsApp number connected (the channel list is
// stubbed in the browser only: nothing is created or sent), the lead drawer's drafts, and the "Ask Claude" lines on Review, Inbox,
// Overview and Find. Also: a draft changed since it was opened (409 DRAFT_CHANGED: edited through the API, then marked sent by hand; and a
// send through a fake mailbox answered with it in the browser), a version whose send is unconfirmed holding the other version, a version
// reopened after a bounce, keyboard focus (More and Tab, the confirms), the version tabs' aria. Desktop 1440x900, phone 375x812, light and dark.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(homedir(), ".claude/skills/gstack/node_modules/"));
const { chromium } = require("playwright");
const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback;
const base = arg("base", "http://localhost:3000"), apiBase = arg("api", "http://localhost:4000"), keep = argv.includes("--keep");
const out = join(process.env.QA_OUT ?? join(homedir(), "AppData/Local/Temp/claude/vso-qa"), `send-flow-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(out, { recursive: true });
const run = Date.now().toString(36), ME = "user-divyansh", HEAD = "user-adarsh";
let failed = 0, passed = 0;
const shots = [];
const consoleErrors = [];
const blockedSends = [], fakedSends = [];
const FAKE_MAILBOX = "qa-fake-mailbox@example.invalid";
const CHANGED_SINCE = "This draft changed since you opened it. Read it again before sending.";
// While a check expects the API's 409 (DRAFT_CHANGED), that answer is not an error.
let allowConflict = false;

async function api(user, method, path, body) {
  // A server that restarts mid-run (the API reloads on every change) fails the call, never the clean-up after it.
  const response = await fetch(`${apiBase}/v1${path}`, { method, headers: { "x-dev-user-id": user, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).catch((error) => { console.log(`  (api ${method} ${path} -> ${error.message})`); return null; });
  if (!response) return undefined;
  const json = await response.json().catch(() => null);
  if (!response.ok) console.log(`  (api ${method} ${path} -> ${response.status} ${json?.error?.message ?? ""})`);
  return json?.data;
}
function check(name, ok, detail = "") { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`); return ok; }
async function shot(page, name) { const path = join(out, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`); await page.screenshot({ path, fullPage: false }); shots.push(path); }

// ---- Seed ----------------------------------------------------------------------------------------------------------------------------
const created = [];
async function lead(name, routes, extra = {}) {
  const item = await api(ME, "POST", "/sales/leads", { pipelineId: "pipeline-buildory", companyName: `QA ${name} ${run}`, ownerId: ME, city: "Raipur", category: "QA test record", stage: "approved_for_contact", contactRoutes: routes, tags: ["qa"], observedSignal: "QA: their site lists bulk rates for contractors.", ...extra });
  if (!item?.id) throw new Error(`could not create the QA lead "${name}" (is the API up?)`);
  created.push(item.id);
  return item;
}
const draft = (leadId, body) => api(ME, "POST", `/sales/leads/${leadId}/drafts`, body);
const review = (draftId, result, issues = [], notes = "") => api(HEAD, "POST", `/sales/drafts/${draftId}/review`, { result, issues, notes });
const email = (tag) => ({ kind: "email", value: `qa-${tag}-${run}@example.invalid` });
const phone = (n) => ({ kind: "phone", value: `+91 90000 000${n}` });

const both = await lead("Two Versions", [email("two"), phone("11")]);
await api(ME, "POST", `/sales/leads/${both.id}/whatsapp-opt-in`, { how: "yes_on_call" });
const bothEmail = await draft(both.id, { channel: "email", purpose: "first_touch", subject: "Bulk rates at QA Two Versions", body: "Hello,\n\nI saw that your site lists bulk rates for contractors. When those rates change, how do your regular buyers get the right price?\n\nWe build one place for the catalog, each buyer's rate and the order status, set up around how you work.\n\nWorth a 20-minute call?\n\nDivyansh\nBuildory" });
await review(bothEmail.id, "pass", [], "QA: opens with the signal, one call to action.");
const bothWa = await draft(both.id, { channel: "whatsapp", purpose: "first_touch", body: "Hi, Divyansh from Buildory. Saw your bulk rates for contractors. How do regular buyers get the right price when rates change? We set up one place for catalog, rates and order status. Open to a quick call this week?" });
await review(bothWa.id, "pass");

const emailOnly = await lead("Email Only", [email("only")]);
const emailOnlyDraft = await draft(emailOnly.id, { channel: "email", purpose: "first_touch", subject: "A question about your orders", body: "Hello,\n\nQuick question about how your team tracks orders from regular buyers.\n\nWorth a short call?\n\nDivyansh" });
await review(emailOnlyDraft.id, "pass");

const locked = await lead("WhatsApp Locked", [phone("12")]);
const lockedDraft = await draft(locked.id, { channel: "whatsapp", purpose: "first_touch", body: "Hi, Divyansh from Buildory here. A quick question about your order tracking. Open to a call?" });
await review(lockedDraft.id, "pass");

const changes = await lead("Needs Changes", [email("changes"), phone("13")]);
const changesDraft = await draft(changes.id, { channel: "email", purpose: "first_touch", subject: "We are the best", body: "Hello,\n\nWe are the best system builders in India and we can double your sales. Call me or reply or book on my calendar.\n\nDivyansh" });
await review(changesDraft.id, "fail", ["Claims to be the best and to double sales: not something we can show.", "Three calls to action: keep one."], "Open with what we saw on their site instead.");

const waiting = await lead("In Review", [email("waiting"), phone("14")]);
await api(ME, "POST", `/sales/leads/${waiting.id}/whatsapp-opt-in`, { how: "yes_by_email" });
const waitingDraft = await draft(waiting.id, { channel: "email", purpose: "first_touch", subject: "Your contractor rates", body: "Hello,\n\nSaw your contractor rates. How do buyers get the right one?\n\nDivyansh" });

const replied = await lead("Inbox Reply", [email("reply")]);
await api(ME, "POST", `/sales/leads/${replied.id}/activities`, { kind: "email", direction: "in", body: "QA: please send the details and the price." });

// A ready draft that someone edits while a venture head has it open (409 DRAFT_CHANGED when the head marks it sent).
const changing = await lead("Changed Meanwhile", [email("changing")]);
const changingDraft = await draft(changing.id, { channel: "email", purpose: "first_touch", subject: "Your order tracking", body: "Hello,\n\nHow does your team track orders from regular buyers today?\n\nWorth a short call?\n\nDivyansh" });
await review(changingDraft.id, "pass");
console.log(`seeded 7 QA leads (run ${run})`);

// ---- Browser -----------------------------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true });
const fakeMailbox = { id: "qa-fake-mailbox", workspaceId: "workspace-studio", kind: "email", label: "QA fake mailbox", ownerUserId: ME, ventureIds: ["venture-buildory"], defaultFor: ["venture-buildory"], enabled: true, status: "connected",
  settings: { address: FAKE_MAILBOX, senderName: "QA", username: FAKE_MAILBOX, smtp: { host: "smtp.example.invalid", port: 465, security: "ssl" }, imap: { host: "imap.example.invalid", port: 993, security: "ssl" }, syncInbox: true, saveToSent: true },
  secrets: { password: { set: true } }, createdBy: ME, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canManage: true };
/** Changes a JSON answer from the API in this browser only (`change` gets the envelope's data and returns the new one). */
async function rewrite(context, match, change) {
  await context.route(match, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body?.ok) body.data = change(body.data);
    return route.fulfill({ response, json: body });
  });
}
const pathIs = (path) => (url) => url.pathname === path;
async function open({ width = 1440, height = 900, dark = false, phone: isPhone = false, as = ME, stubWhatsapp = false, emptyReview = false, onlyFakeMailbox = false, sendAnswersChanged = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: isPhone, hasTouch: isPhone, deviceScaleFactor: isPhone ? 2 : 1, reducedMotion: "reduce", colorScheme: dark ? "dark" : "light" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await context.addCookies([{ name: "venture_studio_theme", value: dark ? "dark" : "light", url: base }]);
  await context.addInitScript((user) => { try { window.localStorage.setItem("vso-dev-user-id", user); } catch {} }, as);
  // Nothing is ever sent: a send through an account never leaves this browser. With `sendAnswersChanged` it is answered here with the API's
  // 409 DRAFT_CHANGED (the draft changed since it was opened), and its body is kept to check what the screen sent.
  await context.route(/\/v1\/sales\/drafts\/[^/?]+\/send(\?.*)?$/, (route) => {
    if (!sendAnswersChanged) { blockedSends.push(route.request().url()); return route.abort(); }
    fakedSends.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "DRAFT_CHANGED", message: "This draft changed since you opened it: read it again before sending", requestId: "qa-fake" } }) });
  });
  // The only account this browser knows: a fake mailbox (the real ones are never offered).
  if (onlyFakeMailbox) await context.route(/\/v1\/sales\/channels(\?.*)?$/, (route) => route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [fakeMailbox] }) }) : route.continue());
  if (stubWhatsapp) {
    // The venture's WhatsApp number, connected: added to the channel list in this browser only. Nothing is created on the server.
    await context.route(/\/v1\/sales\/channels(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.data = [...(body.data ?? []), { id: "qa-stub-whatsapp", workspaceId: "workspace-studio", kind: "whatsapp", label: "Buildory WhatsApp (QA stub)", ventureIds: ["venture-buildory"], defaultFor: ["venture-buildory"], enabled: true, status: "connected", settings: { phoneNumberId: "000000000000000", businessAccountId: "000000000000000", displayNumber: "+91 90000 00000" }, secrets: {}, createdBy: ME, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canManage: true }];
      return route.fulfill({ response, json: body });
    });
  }
  if (emptyReview) await context.route(/\/v1\/sales\/drafts\?/, (route) => route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: [] }) }) : route.continue());
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error" && !(allowConflict && /409/.test(message.text()))) consoleErrors.push(`${page.url().replace(base, "")}: ${message.text().slice(0, 240)}`); });
  page.on("pageerror", (error) => consoleErrors.push(`${page.url().replace(base, "")}: ${error.message.slice(0, 240)}`));
  page.on("response", (response) => { if (allowConflict && response.status() === 409 && /\/drafts\/[^/]+\/(send|sent)$/.test(new URL(response.url()).pathname)) return; if ((response.url().includes("/v1/") && response.status() >= 400) || response.status() >= 500) consoleErrors.push(`${page.url().replace(base, "")}: HTTP ${response.status()} ${response.request().method()} ${response.url().replace(base, "").replace(apiBase, "")}`); });
  page.on("request", (request) => { if (request.url().includes("/v1/")) { const key = new URL(page.url()).pathname; requestsPerPage[key] = (requestsPerPage[key] ?? 0) + 1; } });
  return { context, page };
}
async function go(page, path) {
  await page.goto(base + path, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector(".vso-skeleton, [role='status'][aria-label^='Loading']"), null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
}
const visible = (locator) => locator.locator("visible=true").first();
const pause = () => { console.log("  (waiting a minute: the API allows 300 reads a minute per person)"); return new Promise((resolve) => setTimeout(resolve, 61_000)); };
const requestsPerPage = {};
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Whether focus sits on the More button of the reader. */
const focusOnMore = (page) => page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup") === "menu");

try {
  // 1. Desktop, light: two versions, the person's own mailbox connected.
  {
    const { context, page } = await open();
    await go(page, `/sales/live/review?draft=${bothEmail.id}`);
    const tabs = page.getByRole("tablist", { name: /Versions for/ });
    check("versions show as tabs (Email, WhatsApp)", await tabs.getByRole("tab").count() === 2);
    check("one first message note shows", await visible(page.getByText(/sending one version closes the others/)).isVisible().catch(() => false));
    check("email with a mailbox: Send from <address>", await visible(page.getByRole("button", { name: /^Send from .+@/ })).isVisible().catch(() => false));
    check("says how it is recorded (mailbox)", await visible(page.getByText(/Goes from your mailbox/)).isVisible().catch(() => false));
    check("Claude's review is one strip", await visible(page.getByText("Passed Claude's review")).isVisible().catch(() => false));
    check("list has one row for the lead", await page.locator(`[data-lead-row="${both.id}"]`).count() === 1);
    await shot(page, "review-desktop-email-mailbox");
    await visible(page.getByRole("button", { name: /^Read notes|^Details/ })).click(); await page.waitForTimeout(300);
    await shot(page, "review-desktop-notes-open");

    // The More menu, from the keyboard.
    const more = visible(page.getByRole("button", { name: /^More/ }));
    await more.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    const menu = page.getByRole("menu");
    check("More opens a menu", await menu.isVisible().catch(() => false));
    check("menu holds Edit, Copy text, I sent it myself, Veto, Discard", (await menu.getByRole("menuitem").allInnerTexts()).join("|").replace(/\n/g, " ").match(/Edit.*Copy text.*I sent it myself.*Veto.*Discard/) !== null);
    check("focus moves into the menu", await page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"));
    await page.keyboard.press("ArrowDown"); await page.waitForTimeout(100);
    await shot(page, "review-desktop-more-menu");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    check("Escape closes the menu and returns focus", !(await menu.isVisible().catch(() => false)) && await focusOnMore(page));
    await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    await page.keyboard.press("Tab"); await page.waitForTimeout(250);
    check("keyboard: Tab out of the menu closes it and focus returns to More", !(await menu.isVisible().catch(() => false)) && await focusOnMore(page), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
    await page.keyboard.press("Shift+Tab"); await page.waitForTimeout(100);
    await page.keyboard.press("Tab"); await page.waitForTimeout(100);
    check("keyboard: the page's tab order goes on from More", await focusOnMore(page));

    // The version tabs name the panel they show; the panel is labelled by the selected tab.
    check("version tabs: aria-controls points at the tab panel, labelled by the selected tab", await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[role="tablist"][aria-label^="Versions for"] [role="tab"]')];
      const panelId = tabs[0]?.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
      return tabs.length > 1 && tabs.every((tab) => tab.id && tab.getAttribute("aria-controls") === panelId) && panel?.getAttribute("role") === "tabpanel" && panel.getAttribute("aria-labelledby") === selected?.id;
    }));

    // The confirms take focus when they open and give it back when they close. None of them is answered.
    const openFromMore = async (item) => { await more.click(); await page.waitForTimeout(300); await page.getByRole("menuitem", { name: item }).click(); await page.waitForTimeout(450); };
    await openFromMore("I sent it myself");
    check("Did you send it?: focus moves to its first button", await page.evaluate(() => /Yes, mark it sent/.test(document.activeElement?.textContent ?? "") && !!document.activeElement?.closest('[role="alertdialog"]')));
    await shot(page, "review-desktop-did-you-send-it-focus");
    await visible(page.getByRole("button", { name: "Not yet" })).click(); await page.waitForTimeout(300);
    check("Did you send it?: Not yet closes it and focus returns to More", await page.getByText("Did you send it?").count() === 0 && await focusOnMore(page));
    await openFromMore("Discard");
    check("discard confirm: focus moves to its first button", await page.evaluate(() => document.activeElement?.textContent?.trim() === "Discard" && !!document.activeElement?.closest('[role="alertdialog"]')));
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    check("discard confirm: Escape closes it, focus returns to More, the draft stays open", await page.getByRole("alertdialog", { name: "Confirm discard" }).count() === 0 && await focusOnMore(page) && page.url().includes(bothEmail.id));
    await openFromMore("Veto");
    check("veto confirm: focus moves to the reason box", await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement?.closest("form")));
    await visible(page.getByRole("form", { name: "Veto this draft" }).getByRole("button", { name: "Cancel" })).click(); await page.waitForTimeout(300);
    check("veto confirm: Cancel closes it and focus returns to More", await page.getByRole("form", { name: "Veto this draft" }).count() === 0 && await focusOnMore(page));

    // The WhatsApp version, no number connected: open WhatsApp by hand.
    await page.getByRole("tab", { name: /WhatsApp/ }).click(); await page.waitForTimeout(700);
    check("WhatsApp tab opens its version (URL follows)", page.url().includes(bothWa.id));
    check("WhatsApp without a connected number: Open WhatsApp", await visible(page.getByRole("link", { name: /Open WhatsApp/ })).isVisible().catch(() => false));
    check("says the app records it only when confirmed", await visible(page.getByText(/recorded only when you confirm/)).isVisible().catch(() => false));
    await shot(page, "review-desktop-whatsapp-by-hand");

    // Locked, needs changes, waiting for review, the missing WhatsApp tab.
    await go(page, `/sales/live/review?draft=${lockedDraft.id}`);
    check("WhatsApp not opted in: locked callout with Call instead", await visible(page.getByText("WhatsApp stays locked until they opt in")).isVisible().catch(() => false) && await visible(page.getByRole("link", { name: /Call instead/ })).isVisible().catch(() => false));
    await shot(page, "review-desktop-whatsapp-locked");
    await go(page, `/sales/live/review?draft=${changesDraft.id}`);
    check("needs changes: strip open with the points, Edit is the main action", await visible(page.getByText(/Three calls to action/)).isVisible().catch(() => false) && await visible(page.getByRole("button", { name: "Edit the message" })).isVisible().catch(() => false));
    check("needs changes: Ask Claude to fix", await visible(page.getByText("fix the drafts that need changes")).isVisible().catch(() => false));
    await shot(page, "review-desktop-needs-changes");
    await page.getByRole("tab", { name: /WhatsApp/ }).click(); await page.waitForTimeout(500);
    check("missing WhatsApp tab (not opted in) explains opt-in", await visible(page.getByText("No WhatsApp version yet")).isVisible().catch(() => false) && await visible(page.getByText(/They opt in when they message/)).isVisible().catch(() => false));
    await shot(page, "review-desktop-whatsapp-missing-not-opted-in");
    await go(page, `/sales/live/review?draft=${waitingDraft.id}`);
    check("waiting for review: Ask Claude to review in a new chat", await visible(page.getByText("review drafts", { exact: true })).isVisible().catch(() => false));
    await shot(page, "review-desktop-in-review");
    await page.getByRole("tab", { name: /WhatsApp/ }).click(); await page.waitForTimeout(500);
    check("missing WhatsApp tab: Ask Claude for a WhatsApp version", await visible(page.getByText(`write a WhatsApp version for QA In Review ${run}`)).isVisible().catch(() => false));
    await visible(page.getByRole("button", { name: /Copy the prompt: write a WhatsApp version/ })).click(); await page.waitForTimeout(400);
    check("Copy prompt copies it", (await page.evaluate(() => navigator.clipboard.readText()).catch(() => "")) === `write a WhatsApp version for QA In Review ${run}`);
    await shot(page, "review-desktop-whatsapp-missing-opted-in");

    // The lead drawer: its drafts with the same next step, linking to the right version.
    await go(page, `/sales/live/leads?lead=${both.id}&tab=drafts`);
    const drawer = page.getByRole("dialog");
    check("drawer drafts: Send from the mailbox for the email version", await visible(drawer.getByText(/^Send from .+@/)).isVisible().catch(() => false));
    check("drawer drafts: Open WhatsApp for the WhatsApp version", await visible(drawer.getByText("Open WhatsApp")).isVisible().catch(() => false));
    check("drawer: Ask Claude to research and judge (no verdict yet)", await visible(drawer.getByText(`research and judge QA Two Versions ${run}`)).isVisible().catch(() => false));
    await drawer.getByRole("tablist", { name: "Lead sections" }).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500);
    await shot(page, "drawer-desktop-drafts");
    await drawer.locator(`a[href*="draft=${bothWa.id}"]`).first().click(); await page.waitForTimeout(1500);
    check("drawer link opens that version in Review", page.url().includes(`draft=${bothWa.id}`) && await page.getByRole("tab", { name: /WhatsApp/, selected: true }).count() === 1);

    // Ask Claude on Inbox, Overview and Find. Pages now load more per visit (expenses, focus, celebrations), so wait out the read limit first.
    await pause();
    await go(page, "/sales/live/inbox");
    check("Inbox: Ask Claude to draft replies", await visible(page.getByText("draft replies to my inbox")).isVisible().catch(() => false));
    await shot(page, "inbox-desktop-ask-claude");
    await go(page, "/sales/live");
    check("Overview: Ask Claude to run my morning", await visible(page.getByText("run my morning")).isVisible().catch(() => false));
    await shot(page, "overview-desktop-ask-claude");
    await go(page, "/sales/live/find");
    check("Find: the example prompt goes from finding to ready drafts", await visible(page.getByText("find 10 hardware dealers in Raipur and take them to ready drafts")).isVisible().catch(() => false));
    await shot(page, "find-desktop-ask-claude");
    await context.close();
  }

  // 2. Desktop, dark.
  await pause();
  {
    const { context, page } = await open({ dark: true });
    await go(page, `/sales/live/review?draft=${bothEmail.id}`);
    await shot(page, "review-desktop-dark");
    await go(page, `/sales/live/review?draft=${changesDraft.id}`);
    await shot(page, "review-desktop-dark-needs-changes");
    await context.close();
  }

  // 3. The venture's WhatsApp number connected (stubbed in the browser): the main button sends through it. Not pressed.
  {
    const { context, page } = await open({ stubWhatsapp: true });
    await go(page, `/sales/live/review?draft=${bothWa.id}`);
    check("WhatsApp connected: send from the venture's WhatsApp", await visible(page.getByRole("button", { name: /Send from the venture's WhatsApp/ })).isVisible().catch(() => false));
    check("outside 24 hours: says a template goes instead", await visible(page.getByText(/only takes an approved template/)).isVisible().catch(() => false));
    check("says replies arrive in the Inbox automatically", await visible(page.getByText(/through the venture's WhatsApp; replies arrive in Sales > Inbox automatically/)).isVisible().catch(() => false));
    await shot(page, "review-desktop-whatsapp-connected");
    await context.close();
  }

  // 4. Someone without a mailbox (a venture head): copy and open the mail app, "Did you send it?", mark it sent.
  {
    const { context, page } = await open({ as: HEAD });
    await go(page, `/sales/live/review?draft=${emailOnlyDraft.id}`);
    check("email without a mailbox: Copy and open mail app", await visible(page.getByRole("link", { name: /Copy and open mail app/ })).isVisible().catch(() => false));
    check("connect-your-mailbox card links to Channels", await visible(page.getByRole("link", { name: /Connect a mailbox/ })).getAttribute("href").then((href) => href?.includes("/sales/live/channels")).catch(() => false));
    check("email only, no phone: no WhatsApp tab", await page.getByRole("tab").count() === 1);
    await shot(page, "review-desktop-email-no-mailbox");
    // The mail app link: keep the browser from leaving for a mailto: handler, then click it as a person would.
    await page.evaluate(() => document.addEventListener("click", (event) => { const link = event.target instanceof Element ? event.target.closest("a[href^='mailto:']") : null; if (link) event.preventDefault(); }, true));
    await visible(page.getByRole("link", { name: /Copy and open mail app/ })).click(); await page.waitForTimeout(600);
    check("after the hand send: Did you send it?", await visible(page.getByText("Did you send it?")).isVisible().catch(() => false));
    check("the message was copied", (await page.evaluate(() => navigator.clipboard.readText()).catch(() => "")).includes("A question about your orders"));
    await shot(page, "review-desktop-did-you-send-it");
    await visible(page.getByRole("button", { name: /Yes, mark it sent/ })).click(); await page.waitForTimeout(1800);
    const after = await api(ME, "GET", `/sales/leads/${emailOnly.id}`);
    check("marked sent by hand (manual)", after?.drafts?.find((d) => d.id === emailOnlyDraft.id)?.status === "sent" && after?.drafts?.find((d) => d.id === emailOnlyDraft.id)?.sentVia === "manual");
    await context.close();
  }

  // 4b. A draft changed since it was opened: the head has it open, its owner edits it through the API (it goes back to review), the head
  // then marks it sent by hand. The API refuses (409 DRAFT_CHANGED); the screen says so, reads it again and records nothing.
  {
    const { context, page } = await open({ as: HEAD });
    await go(page, `/sales/live/review?draft=${changingDraft.id}`);
    await page.evaluate(() => document.addEventListener("click", (event) => { const link = event.target instanceof Element ? event.target.closest("a[href^='mailto:']") : null; if (link) event.preventDefault(); }, true));
    const edited = await api(ME, "PATCH", `/sales/drafts/${changingDraft.id}`, { body: "Hello,\n\nHow does your team track orders from regular buyers today? (QA: edited in another tab.)\n\nWorth a short call?\n\nDivyansh" });
    check("seed: the owner's edit sends it back to review", edited?.status === "in_review", edited?.status);
    await visible(page.getByRole("link", { name: /Copy and open mail app/ })).click(); await page.waitForTimeout(600);
    allowConflict = true;
    await visible(page.getByRole("button", { name: /Yes, mark it sent/ })).click(); await page.waitForTimeout(2200);
    allowConflict = false;
    check("DRAFT_CHANGED: says it changed and to read it again, in the send row", await visible(page.getByRole("region", { name: "Send" }).getByText(CHANGED_SINCE)).isVisible().catch(() => false));
    check("DRAFT_CHANGED: the draft is read again (back in review, with the edit)", await visible(page.getByText(/It can be sent once Claude's review passes/)).isVisible().catch(() => false) && await visible(page.getByText(/edited in another tab/)).isVisible().catch(() => false));
    check("the review strip waits for a new review (the old one was of the old text)", await visible(page.getByText("Waiting for Claude's review")).isVisible().catch(() => false) && await visible(page.getByText(/edited after its last review/)).isVisible().catch(() => false) && await page.getByText("Passed Claude's review").count() === 0);
    check("DRAFT_CHANGED: nothing recorded, no automatic retry", (await api(ME, "GET", `/sales/leads/${changing.id}`))?.drafts?.find((d) => d.id === changingDraft.id)?.status === "in_review");
    await shot(page, "review-desktop-draft-changed-by-hand");
    await context.close();
  }

  // 4c. The same through an account: a fake mailbox only (the real one is never offered) and the send answered in this browser with 409
  // DRAFT_CHANGED. The send names the version on screen; the screen says it changed and reads it again. Also: the WhatsApp version reopened
  // after a bounce (the list is changed in this browser only).
  await pause();
  {
    const { context, page } = await open({ onlyFakeMailbox: true, sendAnswersChanged: true });
    await rewrite(context, /\/v1\/sales\/drafts\?/, (list) => list.map((item) => item.id === bothWa.id ? { ...item, reopenedAt: new Date().toISOString(), reopenedBecause: "bounced" } : item));
    await go(page, `/sales/live/review?draft=${bothEmail.id}`);
    const seenAt = (await api(ME, "GET", `/sales/leads/${both.id}`))?.drafts?.find((d) => d.id === bothEmail.id)?.updatedAt;
    check("the send confirm and To line name the address the send uses", await visible(page.getByText(new RegExp(`To qa-two-${run}@example\\.invalid`))).isVisible().catch(() => false));
    await visible(page.getByRole("button", { name: `Send from ${FAKE_MAILBOX}` })).click(); await page.waitForTimeout(400);
    check("send confirm names the recipient", await visible(page.getByText(new RegExp(`Send this email to qa-two-${run}@example\\.invalid from`))).isVisible().catch(() => false));
    allowConflict = true;
    await visible(page.getByRole("button", { name: "Send now" })).click(); await page.waitForTimeout(2000);
    allowConflict = false;
    check("the send names the version on screen (expectedUpdatedAt)", fakedSends.length === 1 && Boolean(seenAt) && fakedSends[0]?.expectedUpdatedAt === seenAt, JSON.stringify(fakedSends[0] ?? null));
    check("DRAFT_CHANGED on a send: says it changed and to read it again, in the send row", await visible(page.getByRole("region", { name: "Send" }).getByText(CHANGED_SINCE)).isVisible().catch(() => false));
    check("DRAFT_CHANGED on a send: not repeated by itself", fakedSends.length === 1);
    await shot(page, "review-desktop-draft-changed-send");
    await page.getByRole("tab", { name: /WhatsApp/ }).click(); await page.waitForTimeout(700);
    check("reopened version: shows normally with Reopened: the email bounced", await visible(page.getByText("Reopened: the email bounced")).isVisible().catch(() => false) && await visible(page.getByRole("link", { name: /Open WhatsApp/ })).isVisible().catch(() => false));
    await shot(page, "review-desktop-reopened-version");
    await context.close();
  }

  // 4d. A version whose send isn't confirmed holds the other one: the email version waits for a person to say whether it went out (changed
  // in this browser only), so the WhatsApp version's main button is disabled and says which one to settle.
  {
    const { context, page } = await open({ onlyFakeMailbox: true });
    await rewrite(context, /\/v1\/sales\/drafts\?/, (list) => list.map((item) => item.id === bothEmail.id ? { ...item, delivery: { state: "uncertain", at: new Date().toISOString(), accountId: "qa-fake-mailbox", error: "QA: the mailbox didn't answer in time" } } : item));
    await go(page, `/sales/live/review?draft=${bothWa.id}`);
    const held = visible(page.getByRole("button", { name: /Open WhatsApp/ }));
    check("held version: the other version's main button is disabled", await held.isDisabled().catch(() => false) && await page.getByRole("link", { name: /Open WhatsApp/ }).count() === 0);
    check("held version: a line names the one to settle", await visible(page.getByText("The email version's send isn't confirmed yet: settle it first.")).isVisible().catch(() => false));
    await visible(page.getByRole("button", { name: /^More/ })).click(); await page.waitForTimeout(300);
    check("held version: no I sent it myself on the other version", await page.getByRole("menuitem", { name: "I sent it myself" }).count() === 0);
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    await shot(page, "review-desktop-held-other-version");
    await page.getByRole("tab", { name: /Email/ }).click(); await page.waitForTimeout(700);
    check("held version: the email version asks whether it went out", await visible(page.getByText("We couldn't confirm it went out")).isVisible().catch(() => false));
    await shot(page, "review-desktop-held-version");
    await context.close();
  }

  // 5. Phone, 375 x 812, light and dark. The API allows 300 reads a minute per person: let the minute pass first.
  await pause();
  for (const dark of [false, true]) {
    const { context, page } = await open({ width: 375, height: 812, phone: true, dark });
    const tag = dark ? "phone-dark" : "phone";
    await go(page, "/sales/live/review");
    check(`${tag}: list fits the screen`, await overflowX(page) <= 1, `overflow ${await overflowX(page)}px`);
    await shot(page, `review-${tag}-list`);
    await visible(page.locator(`[data-lead-row="${both.id}"]`)).click(); await page.waitForTimeout(1200);
    check(`${tag}: reader fits the screen`, await overflowX(page) <= 1, `overflow ${await overflowX(page)}px`);
    await shot(page, `review-${tag}-reader`);
    const main = visible(page.getByRole("button", { name: /^Send from/ }));
    const box = await main.boundingBox().catch(() => null);
    // The screen less the page gutters, the reader's padding and the More button beside it.
    check(`${tag}: main button takes the row beside More`, !!box && box.width >= 375 - 64 - 56, box ? `${Math.round(box.width)}px` : "not found");
    await main.scrollIntoViewIfNeeded();
    await shot(page, `review-${tag}-actions`);
    await visible(page.getByRole("button", { name: /^More/ })).click(); await page.waitForTimeout(400);
    const menuBox = await page.getByRole("menu").boundingBox().catch(() => null);
    check(`${tag}: More menu opens inside the screen`, !!menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 375 && menuBox.y >= 0 && menuBox.y + menuBox.height <= 812, JSON.stringify(menuBox));
    await shot(page, `review-${tag}-more-menu`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    check(`${tag}: Escape in the menu keeps the draft open`, page.url().includes("draft="));
    await page.getByRole("tab", { name: /WhatsApp/ }).click(); await page.waitForTimeout(700);
    await shot(page, `review-${tag}-whatsapp`);
    if (!dark) {
      await go(page, `/sales/live/review?draft=${waitingDraft.id}`);
      await page.getByRole("tab", { name: /WhatsApp/ }).click(); await page.waitForTimeout(600);
      check(`${tag}: missing WhatsApp tab fits`, await overflowX(page) <= 1);
      await shot(page, `review-${tag}-whatsapp-missing`);
      await go(page, `/sales/live/leads?lead=${both.id}&tab=drafts`);
      await page.getByRole("dialog").getByRole("tablist", { name: "Lead sections" }).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500);
      await shot(page, `drawer-${tag}-drafts`);
    }
    await context.close();
  }

  // 6. Review with nothing to do: the Ask Claude line (the list is emptied in this browser only).
  await pause();
  {
    const { context, page } = await open({ emptyReview: true });
    await go(page, "/sales/live/review");
    check("empty Review: Ask Claude to write first messages", await visible(page.getByText("write first messages for my recommended leads")).isVisible().catch(() => false));
    await shot(page, "review-desktop-empty");
    await context.close();
  }

  // 7. Sending one version closes the other (the API does it): mark the email sent by hand, then the WhatsApp version reads as closed.
  {
    const { context, page } = await open();
    await go(page, `/sales/live/review?draft=${bothEmail.id}`);
    await visible(page.getByRole("button", { name: /^More/ })).click(); await page.waitForTimeout(300);
    await page.getByRole("menuitem", { name: "I sent it myself" }).click(); await page.waitForTimeout(400);
    await visible(page.getByRole("button", { name: /Yes, mark it sent/ })).click(); await page.waitForTimeout(2000);
    const detail = await api(ME, "GET", `/sales/leads/${both.id}`);
    const wa = detail?.drafts?.find((d) => d.id === bothWa.id);
    check("email marked sent; the WhatsApp version closed with it", detail?.drafts?.find((d) => d.id === bothEmail.id)?.status === "sent" && wa?.status === "discarded" && wa?.closedReason === "sent_on_other_channel", `${wa?.status} ${wa?.closedReason ?? ""}`);
    check("the lead left the To do list", await page.locator(`[data-lead-row="${both.id}"]`).count() === 0);
    await go(page, `/sales/live/review?draft=${bothWa.id}`);
    check("the closed version says another version went out", await visible(page.getByText("Closed: another version went out")).isVisible().catch(() => false));
    await shot(page, "review-desktop-closed-version");
    await go(page, `/sales/live/leads?lead=${both.id}&tab=drafts`);
    await page.getByRole("dialog").getByRole("tablist", { name: "Lead sections" }).scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500);
    check("drawer: the closed version reads Closed: another version went out", await visible(page.getByRole("dialog").getByText("Closed: another version went out")).isVisible().catch(() => false));
    await shot(page, "drawer-desktop-after-send");
    await context.close();
  }

  // 8. The email bounced (changed in this browser only): the sent version says the WhatsApp version is open again, with a link to it.
  {
    const { context, page } = await open();
    await rewrite(context, pathIs(`/v1/sales/drafts/${bothEmail.id}`), (data) => { const item = data?.draft ?? data; const changed = { ...item, delivery: { state: "bounced", at: new Date().toISOString(), error: "QA: mailbox not found" } }; return data?.draft ? { ...data, draft: changed } : changed; });
    await rewrite(context, pathIs(`/v1/sales/leads/${both.id}`), (data) => ({ ...data, drafts: data.drafts.map((item) => item.id === bothWa.id ? { ...item, status: "ready", closedReason: undefined, sentVersion: undefined, discardedAt: undefined, discardedReason: undefined, reopenedAt: new Date().toISOString(), reopenedBecause: "bounced" } : item.id === bothEmail.id ? { ...item, delivery: { state: "bounced", at: new Date().toISOString() } } : item) }));
    await go(page, `/sales/live/review?draft=${bothEmail.id}`);
    check("bounced: the sent version says the WhatsApp version is open again", await visible(page.getByText(/The WhatsApp version is open again/)).isVisible().catch(() => false) && await visible(page.getByRole("link", { name: /Open the WhatsApp version/ })).isVisible().catch(() => false));
    await shot(page, "review-desktop-bounced-other-open");
    await context.close();
  }
} catch (error) {
  check("click-through ran to the end", false, error.message.split("\n")[0]);
} finally {
  await browser.close();
  if (!keep) for (const id of created) await api(ME, "DELETE", `/sales/leads/${id}`);
}
console.log(`API requests by page: ${JSON.stringify(requestsPerPage)}`);
check("nothing was sent through an account (every send blocked or answered in the browser)", blockedSends.length === 0, blockedSends.join(", "));
const relevant = consoleErrors.filter((line) => !/favicon|Download the React DevTools/i.test(line));
check("no console or page errors", relevant.length === 0, relevant.slice(0, 5).join(" | "));
console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"} (${passed} passed) · ${shots.length} screenshots: ${out}${keep ? "" : "\nQA leads soft-deleted; remove them for good with clean-sales-dev.ts --qa"}`);
process.exit(failed ? 1 : 0);
