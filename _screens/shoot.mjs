// Demo screenshots against the demo web app (3100) / demo API (4100), data in vso_demo.
// Uses the Playwright that is already installed under ~/.claude/skills/gstack (nothing is installed).
//   node _screens/shoot.mjs [--only 01,22] [--scale 1.5]
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const gstack = createRequire(join(homedir(), ".claude/skills/gstack/node_modules/"));
const { chromium } = gstack("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const root = createRequire(join(here, "../package.json"));
const { MongoClient } = root("mongodb");
const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, a) => (v.startsWith("--") ? [...p, [v.slice(2), a[i + 1]]] : p), []));
const base = "http://localhost:3100"; const api = "http://localhost:4100";
const h = { "x-dev-user-id": "user-divyansh" };
const get = async (p) => (await (await fetch(`${api}/v1${p}`, { headers: h })).json()).data;
const leads = (await get("/sales/leads?limit=50")).items; const lead = (name) => leads.find((l) => l.companyName.startsWith(name))?.id;
const task = (key) => `demo-task-${key}`;

// The weekly "Top performers" edition shows once per person: reset it so it can be captured first, then dismissed for the other shots.
const mongo = new MongoClient("mongodb://127.0.0.1:27017/?directConnection=true"); await mongo.connect();
await mongo.db("vso_demo").collection("leaderboard_seen").deleteMany({});
await mongo.close();
const weekly = await get("/leaderboard/weekly/status");
const markSeen = () => fetch(`${api}/v1/leaderboard/weekly/${weekly.id}/seen`, { method: "POST", headers: h });

const click = async (page, text, opts = {}) => { await page.getByText(text, { exact: false }).first().click(opts); await page.waitForTimeout(900); };
// Scroll whatever scrolls (the drawer) so the first element whose text starts with `text` sits near the top.
const scrollTo = async (page, text) => { await page.evaluate((t) => { const el = [...document.querySelectorAll("h2,h3,h4,p,span,div")].find((e) => e.children.length < 4 && (e.textContent || "").trim().startsWith("Claude " + t)); if (el) { let n = el.parentElement; while (n && n.scrollHeight <= n.clientHeight + 4) n = n.parentElement; if (n) n.scrollTop = el.getBoundingClientRect().top - n.getBoundingClientRect().top + n.scrollTop - 150; } }, text); await page.waitForTimeout(700); };
const PAGES = [
  ["07b-weekly-edition", "/today/live", { after: markSeen }],
  ["01-today", "/today/live", {}],
  ["02-dashboard", "/dashboard/live", { height: 1250 }],
  ["03-ventures-overview", "/ventures/live?venture=venture-buildory", {}],
  ["04-task-board", "/board/live", { height: 1150 }],
  ["05-tasks-list", "/tasks/live", {}],
  ["06-task-card-review", `/tasks/live?task=${task("o3")}`, { height: 1150 }],
  ["06b-task-card-evidence", `/tasks/live?task=${task("o3")}&tab=evidence`, { height: 1150 }],
  ["06c-task-card-details", `/tasks/live?task=${task("o5")}`, { height: 1150 }],
  ["07-leaderboard", "/leaderboard/live", { height: 1250 }],
  ["08-knowledge-library", "/knowledge/live", { height: 1100 }],
  ["08b-knowledge-doc", "/knowledge/live?doc=demo-doc-dc", {}],
  ["09-decisions", "/decisions/live", { before: (p) => click(p, "Sell Dealer Commerce") }],
  ["10-classes", "/classes/live", { before: (p) => click(p, "Writing a first message") }],
  ["10b-channels-buildory", "/channels/live", {}],
  ["20-sales-overview", "/sales/live", { height: 1250, before: async (p) => { const r = p.getByRole("radio", { name: "Everyone" }); const t = p.getByRole("tab", { name: "Everyone" }); const b = p.getByRole("button", { name: "Everyone" }); for (const l of [r, t, b]) { if (await l.count()) { await l.first().click(); break; } } await p.waitForTimeout(1500); } }],
  ["21-sales-leads", "/sales/live/leads", { height: 1250 }],
  ["22-sales-lead-detail", `/sales/live/leads?lead=${lead("Shree Ganesh")}`, { height: 1250 }],
  ["22b-sales-lead-verdict", `/sales/live/leads?lead=${lead("Shree Ganesh")}`, { height: 1500, before: async (p) => { await click(p, "Read evidence"); await scrollTo(p, "says"); } }],
  ["22c-sales-lead-hold", `/sales/live/leads?lead=${lead("Nashik")}`, { height: 1500, before: async (p) => { await click(p, "Read evidence"); await scrollTo(p, "says"); } }],
  ["23-sales-review-approve", "/sales/live/review", { height: 1100, before: (p) => click(p, "Shree Ganesh Pumps") }],
  ["24-sales-pipeline", "/sales/live/pipeline", { width: 1980, height: 1050 }],
  ["25-sales-offers", "/sales/live/brain?venture=venture-buildory", {}],
  ["25b-sales-offer-detail", "/sales/live/brain?venture=venture-buildory", { height: 1400, before: (p) => click(p, "Dealer Commerce") }],
  ["26-sales-inbox", "/sales/live/inbox?venture=venture-buildory", { before: (p) => click(p, "Narmada Tiles") }],
  ["27-sales-plays", "/sales/live/plays?venture=venture-buildory", {}],
];
const only = args.only ? args.only.split(",") : null;
const scale = Number(args.scale ?? 1.5);
if (only && !only.some((o) => "07b-weekly-edition".startsWith(o))) await markSeen(); // a partial run skips the overlay shot, so dismiss the overlay up front
const browser = await chromium.launch({ headless: true });
for (const [name, path, opt] of PAGES) {
  if (only && !only.some((o) => name.startsWith(o))) continue;
  // A fresh browser context per shot, so a venture picked on one page does not leak into the next.
  const ctx = await browser.newContext({ viewport: { width: opt.width ?? 1600, height: opt.height ?? 1000 }, deviceScaleFactor: scale, reducedMotion: "reduce", colorScheme: "light", timezoneId: "Asia/Kolkata" });
  await ctx.addCookies([{ name: "venture_studio_theme", value: "light", url: base }]);
  await ctx.addInitScript(() => { try { localStorage.setItem("vso-dev-user-id", "user-divyansh"); } catch {} });
  const page = await ctx.newPage(); const issues = [];
  page.on("console", (m) => { if (m.type() === "error") issues.push(m.text().slice(0, 160)); });
  page.on("response", (r) => { if (r.url().includes("/v1/") && r.status() >= 400) issues.push(`${r.status()} ${r.url().replace(base, "")}`); });
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 90_000 });
    await page.waitForFunction(() => !document.querySelector(".vso-skeleton, [aria-busy='true'], [role='status'][aria-label^='Loading']"), null, { timeout: 15_000 }).catch(() => issues.push("still loading"));
    await page.waitForTimeout(1500);
    if (opt.before) await opt.before(page).catch((e) => issues.push("before failed: " + String(e).slice(0, 100)));
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(here, `${name}.png`), fullPage: false });
    if (opt.after) await opt.after();
    console.log(name, issues.length ? "ISSUES: " + issues.join(" | ") : "ok");
  } catch (e) { console.log(name, "FAILED", String(e).slice(0, 150)); }
  await ctx.close();
  await new Promise((r) => setTimeout(r, 4500));
}
await browser.close();
