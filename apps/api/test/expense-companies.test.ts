import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { companyKey, companyName, expenseSettingsSchema, successEnvelope, websiteHost } from "@venture-studio/contracts";
import { assignExpenseCompanies, fetchLogo, iconLinks, imageInIco, logoFromImage } from "../src/expense-companies.js";
import type { FetchImpl, LookupImpl } from "../src/sales/finder/fetch.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Expense companies (expense-companies.ts, routes/expenses.ts): grouping by GSTIN, website or name; who sees a company; rename and merge;
// logos uploaded or fetched from a company's own website with the lead finder's safety checks (here on a stand-in network).

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const base = { date: "2026-10-01", amountPaise: 110_00, categoryId: "subscription", scope: { kind: "office" } } as const;
const png = (size: number) => sharp({ create: { width: size, height: size, channels: 4, background: { r: 30, g: 130, b: 80, alpha: 1 } } }).png().toBuffer();
/** A 32-bit bitmap picture as a .ico keeps it: its header, then rows of blue-green-red-alpha from the bottom up, then the mask. */
function bitmap(size: number) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let at = 0; at < pixels.length; at += 4) { pixels[at] = 200; pixels[at + 1] = 60; pixels[at + 2] = 30; pixels[at + 3] = 255; }
  return Buffer.concat([header, pixels, Buffer.alloc(Math.ceil(size / 32) * 4 * size)]);
}
/** A .ico holding one PNG picture. */
function ico(picture: Buffer, width: number) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header[6] = width >= 256 ? 0 : width; header[7] = width >= 256 ? 0 : width;
  header.writeUInt32LE(picture.length, 14); header.writeUInt32LE(22, 18);
  return Buffer.concat([header, picture]);
}

test("one company, however it's written: legal words, web endings, spaces and case don't matter; websites become host names", () => {
  assert.deepEqual(["GoDaddy.com, LLC", "GODADDY INDIA", "Go Daddy", "godaddy", "GoDaddy (buildory.dev)", "Anthropic [Claude Team]", "Café Coffee Day", "Cafe Coffee Day"].map(companyKey), ["godaddy", "godaddy", "godaddy", "godaddy", "godaddy", "anthropic", "cafecoffeeday", "cafecoffeeday"]);
  assert.deepEqual(["GoDaddy (buildory.dev)", "Anthropic (Claude Team)", "Contabo VPS", "(only a note)"].map(companyName), ["GoDaddy", "Anthropic", "Contabo VPS", "(only a note)"]);
  // Different names never fall together: other scripts keep their letters, and a note after a dash is part of the name.
  const apart = ["राम ट्रेडर्स", "श्याम ट्रेडर्स", "முருகன் ஸ்டோர்ஸ்", "Salary - Ramesh", "Salary - Priya", "EMI - HDFC", "EMI - ICICI", "—", "Unnamed"].map(companyKey);
  assert.equal(new Set(apart).size, apart.length, JSON.stringify(apart));
  assert.deepEqual(["Amazon Web Services India Private Limited", "Anthropic, PBC", "E2E Networks Limited", "The Coffee Company", "ltd"].map(companyKey), ["amazonwebservices", "anthropic", "e2enetworks", "coffee", "ltd"]);
  assert.deepEqual(["https://www.GoDaddy.com/in", "billing@godaddy.com", "e2enetworks.com/contact", "localhost", "http://10.0.0.1", "192.168.1.1", "not a site"].map(websiteHost), ["godaddy.com", "godaddy.com", "e2enetworks.com", null, null, null, null]);
});

test("logos: the icons a page names, best first and never SVG; a .ico's PNG; images become a 128 px WebP, anything else is refused", async () => {
  const html = `<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel='apple-touch-icon' href='/touch.png'><link rel="icon" href="/big.png" sizes="192x192">`;
  assert.deepEqual(iconLinks(html, "https://example.org/home"), ["https://example.org/touch.png", "https://example.org/big.png", "https://example.org/favicon-32.png"]);
  const picture = await png(64);
  assert.deepEqual(imageInIco(ico(picture, 64)), { png: picture });
  assert.equal(imageInIco(Buffer.from("not an icon")), null);
  // The older bitmap kind most favicon.ico files hold: read as pixels, colours the right way round.
  const fromBitmap = await logoFromImage(ico(bitmap(32), 32));
  const { data } = await sharp(fromBitmap!).raw().toBuffer({ resolveWithObject: true });
  assert.ok([30, 60, 200].every((value, index) => Math.abs(data[index]! - value) <= 8), `red, green, blue from blue, green, red: ${[...data.subarray(0, 3)]}`);
  const logo = await logoFromImage(await png(400));
  const meta = await sharp(logo!).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 128, 128]);
  assert.equal(await logoFromImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test("reading a hostile page for its icons stays quick (bounded patterns, the head only)", () => {
  for (const page of ["<link".repeat(100_000), `<link ${"a".repeat(200_000)}`, `<head>${"<link rel=icon href=".repeat(30_000)}`]) {
    const started = performance.now();
    iconLinks(page, "https://example.org/");
    assert.ok(performance.now() - started < 1_000, `${Math.round(performance.now() - started)} ms`);
  }
});

test("a website's logo is fetched only from public https addresses (private hosts and plain-http redirects refused), else from Google's favicon service", async () => {
  const touch = await png(180);
  const asked: string[] = [];
  const answer = (url: string, status: number, body?: Buffer | string, headers: Record<string, string> = {}) => ({ url, status, body, headers });
  let routes: ReturnType<typeof answer>[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    asked.push(url);
    const route = routes.find((one) => one.url === url);
    return route ? new Response(typeof route.body === "string" ? route.body : route.body ? new Uint8Array(route.body) : null, { status: route.status, headers: route.headers }) : new Response(null, { status: 404 });
  };
  const publicLookup: LookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];
  routes = [answer("https://example.org/", 200, '<html><head><link rel="apple-touch-icon" href="/touch.png"></head></html>', { "content-type": "text/html" }), answer("https://example.org/touch.png", 200, touch, { "content-type": "image/png" })];
  assert.equal((await sharp((await fetchLogo("example.org", { fetchImpl, lookupImpl: publicLookup }))!).metadata()).format, "webp");
  // A host that resolves to a private address is never asked.
  asked.length = 0;
  assert.equal(await fetchLogo("internal.example", { fetchImpl, lookupImpl: async () => [{ address: "10.0.0.5", family: 4 }] }), null);
  assert.equal(asked.length, 0);
  // A redirect to plain http is not followed; the next places to look still are, and a .ico's PNG is used.
  asked.length = 0;
  routes = [answer("https://example.org/", 302, undefined, { location: "http://example.org/" }), answer("https://example.org/favicon.ico", 200, ico(await png(48), 48), { "content-type": "image/x-icon" })];
  assert.ok(await fetchLogo("example.org", { fetchImpl, lookupImpl: publicLookup }));
  assert.ok(!asked.some((url) => url.startsWith("http:")), "never asked over plain http");
  // A site that refuses automated requests (GoDaddy does): its logo comes from Google's favicon service, through its redirect.
  asked.length = 0;
  const google = "https://www.google.com/s2/favicons?domain=example.org&sz=128";
  routes = [answer("https://example.org/", 403, "Forbidden"), answer(google, 302, undefined, { location: "https://t1.gstatic.com/faviconV2?url=https://example.org&size=128" }), answer("https://t1.gstatic.com/faviconV2?url=https://example.org&size=128", 200, touch, { "content-type": "image/png" })];
  assert.equal((await sharp((await fetchLogo("example.org", { fetchImpl, lookupImpl: publicLookup }))!).metadata()).format, "webp");
  assert.deepEqual(asked, ["https://example.org/", "https://example.org/apple-touch-icon.png", "https://example.org/favicon.ico", google, "https://t1.gstatic.com/faviconV2?url=https://example.org&size=128"], "its own site first, then Google");
  // Google answers 404 for a domain it has no icon for: no logo (never its generic globe).
  routes = [answer("https://example.org/", 403, "Forbidden"), answer(google, 404, touch, { "content-type": "image/png" })];
  assert.equal(await fetchLogo("example.org", { fetchImpl, lookupImpl: publicLookup }), null);
});

test("companies: grouped by name, GSTIN or website; hidden with restricted expenses; renamed, merged, given logos by the right people", { skip }, async () => {
  const uploads = await mkdtemp(join(tmpdir(), "vso-companies-"));
  try {
    await withSalesApp(async ({ api, db, origin }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
      const add = async (paidTo: string, handle = "boss", extra: Record<string, unknown> = {}) => { const made = await call("POST", "/expenses", handle, { ...base, paidTo, ...extra }); assert.equal(made.status, 201, made.text); return made.body.data; };
      const companies = async (handle: string) => successEnvelope(expenseSettingsSchema).parse((await call("GET", "/expenses/settings", handle)).body).data.companies;
      const named = async (handle: string, name: string) => (await companies(handle)).find((company) => company.name === name);
      const logo = (handle: string, id: string, bytes: Buffer, method = "POST") => fetch(`${origin}/v1/expenses/companies/${id}/logo`, { method, headers: { "content-type": "image/png", "x-dev-user-id": `user-${handle}` }, ...(method === "POST" ? { body: new Uint8Array(bytes) } : {}) });
      await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "edit", restricted: false });
      await call("PUT", "/expenses/settings/access/user-member2", "boss", { level: "view", restricted: false });

      // Spellings of one company group together; another company is another group.
      const first = await add("GoDaddy.com, LLC");
      const second = await add("GODADDY INDIA");
      await add("Anthropic");
      assert.equal(first.companyId, second.companyId);
      assert.deepEqual((await companies("boss")).map((company) => [company.name, company.expenses]), [["Anthropic", 1], ["GoDaddy.com, LLC", 2]]);

      // A company paid only in a restricted category (a salary: a person's name) is hidden from people who can't see those expenses.
      const salary = await add("Rahul Sharma", "boss", { categoryId: "salary" });
      assert.ok(await named("boss", "Rahul Sharma"));
      assert.equal(await named("member2", "Rahul Sharma"), undefined);
      assert.equal((await logo("member2", salary.companyId, Buffer.alloc(0), "GET")).status, 404);

      // Rename: the new name is matched from then on; a name another company has is refused (merge instead).
      assert.equal((await call("PATCH", `/expenses/companies/${first.companyId}`, "member", { name: "GoDaddy" })).status, 403, "managers rename");
      assert.equal((await call("PATCH", `/expenses/companies/${first.companyId}`, "boss", { name: "GoDaddy" })).status, 200);
      assert.equal((await call("PATCH", `/expenses/companies/${first.companyId}`, "boss", { name: "Anthropic PBC" })).status, 409);
      assert.equal((await call("PATCH", `/expenses/companies/${first.companyId}`, "boss", { website: "not a site" })).status, 400);
      assert.equal((await call("PATCH", `/expenses/companies/${first.companyId}`, "boss", { website: "https://www.GoDaddy.com/in" })).status, 200);
      assert.deepEqual([(await named("boss", "GoDaddy"))?.website, (await add("Go Daddy")).companyId], ["godaddy.com", first.companyId]);

      // Merge: "AWS" into "Amazon Web Services": its expenses and spellings move, and "AWS" finds Amazon from then on.
      const aws = await add("AWS");
      const amazon = await add("Amazon Web Services");
      assert.notEqual(aws.companyId, amazon.companyId);
      assert.equal((await call("POST", `/expenses/companies/${aws.companyId}/merge`, "member", { into: amazon.companyId })).status, 403);
      assert.equal((await call("POST", `/expenses/companies/${aws.companyId}/merge`, "boss", { into: amazon.companyId })).status, 200);
      assert.equal((await db.collection("expenses").findOne({ _id: aws.id }))?.companyId, amazon.companyId);
      assert.equal((await add("AWS")).companyId, amazon.companyId);
      assert.equal((await named("boss", "Amazon Web Services"))?.expenses, 3);
      assert.equal(await named("boss", "AWS"), undefined);

      // Logos: anyone who adds expenses gives a company its first logo; changing or removing one is for managers. Kept as 128 px WebP.
      const anthropic = (await named("boss", "Anthropic"))!;
      assert.equal((await logo("member2", anthropic.id, await png(300))).status, 403, "viewers don't upload");
      assert.equal((await logo("member", anthropic.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415);
      assert.equal((await logo("member", anthropic.id, await png(300))).status, 200);
      assert.equal((await logo("member", anthropic.id, await png(300))).status, 403, "only managers change a logo");
      assert.equal((await logo("boss", anthropic.id, await png(300))).status, 200);
      const served = await logo("member2", anthropic.id, Buffer.alloc(0), "GET");
      assert.deepEqual([served.status, served.headers.get("content-type"), (await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width], [200, "image/webp", 128]);
      assert.ok((await named("member2", "Anthropic"))?.logo);
      assert.equal((await logo("member", anthropic.id, Buffer.alloc(0), "DELETE")).status, 403);
      assert.equal((await logo("boss", anthropic.id, Buffer.alloc(0), "DELETE")).status, 200);
      assert.equal((await logo("boss", anthropic.id, Buffer.alloc(0), "GET")).status, 404);

      // A receipt's GSTIN groups two names as one company; a new company's website from the form is kept.
      const receipt = async (gstin: string, website: string) => {
        const id = `receipt-${Math.random().toString(36).slice(2)}`;
        await db.collection("expense_receipts").insertOne({ _id: id, workspaceId: "workspace-a", ownerId: "user-boss", objectKey: `x/${id}`, storage: "local", contentType: "image/webp", size: 1, data: { merchantTaxId: gstin, website }, orphanedAt: new Date(), createdAt: new Date() } as never);
        return id;
      };
      const cafe = await add("TWC Koramangala", "boss", { receiptId: await receipt("29AAHCT1234F1Z9", "thirdwavecoffee.in") });
      assert.equal((await add("Third Wave Coffee Roasters", "boss", { receiptId: await receipt("29AAHCT1234F1Z9", "") })).companyId, cafe.companyId);
      assert.deepEqual([(await named("boss", "TWC Koramangala"))?.gstin, (await named("boss", "TWC Koramangala"))?.website], ["29AAHCT1234F1Z9", "thirdwavecoffee.in"]);
      // A shared mail or payment domain never groups or names a company; a known name wins over a receipt's GSTIN.
      const tailor = await add("Sharma Tailors", "boss", { companyWebsite: "sharmatailors@gmail.com" });
      const printer = await add("Gupta Printers", "boss", { companyWebsite: "guptaprinters@gmail.com" });
      assert.notEqual(tailor.companyId, printer.companyId);
      assert.equal((await db.collection("expense_companies").findOne({ _id: tailor.companyId }))?.website, null);
      assert.equal((await add("Anthropic", "boss", { receiptId: await receipt("29AAHCT1234F1Z9", "") })).companyId, anthropic.id, "the name wins");
      assert.equal((await db.collection("expense_companies").findOne({ _id: anthropic.id as never }))?.gstin ?? null, null, "and keeps the GSTIN with the company that has it");
      const contabo = await add("Contabo GmbH", "member", { companyWebsite: "contabo.com" });
      assert.equal((await db.collection("expense_companies").findOne({ _id: contabo.companyId }))?.website, "contabo.com");
      assert.equal((await db.collection("expenses").findOne({ _id: contabo.id }))?.companyWebsite, undefined, "the website stays with the company");

      // A manager without restricted access never learns a hidden company's name, nor spellings only restricted expenses used.
      await add("Priya Nair", "boss", { categoryId: "salary" });
      await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "manage", restricted: false });
      const refused = await call("PATCH", `/expenses/companies/${anthropic.id}`, "member", { name: "Priya Nair" });
      assert.deepEqual([refused.status, refused.text.includes("Priya")], [409, false]);
      assert.ok((await companies("member")).every((company) => !company.keys.includes("priyanair") && !company.keys.includes("rahulsharma")));

      // Expenses saved before companies existed are grouped once, by their "Paid to"; running it again changes nothing.
      for (const [id, paidTo] of [["old-1", "Hostinger Ltd."], ["old-2", "HOSTINGER"]]) await db.collection("expenses").insertOne({ _id: id, workspaceId: "workspace-a", ...base, paidTo, groupId: null, repeat: "none", endMonth: null, note: "", receiptId: null, startMonth: "2026-10", createdBy: "user-boss", updatedBy: "user-boss", createdAt: new Date(), updatedAt: new Date() } as never);
      assert.equal(await assignExpenseCompanies(db), 2);
      const [one, two] = await Promise.all(["old-1", "old-2"].map((id) => db.collection("expenses").findOne({ _id: id as never })));
      assert.ok(one?.companyId && one.companyId === two?.companyId);
      assert.equal(await assignExpenseCompanies(db), 0);
    }, "expense_companies", { LOCAL_UPLOAD_DIR: uploads, COMPANY_LOGO_FETCH: "off" });
  } finally {
    await rm(uploads, { recursive: true, force: true });
  }
});
