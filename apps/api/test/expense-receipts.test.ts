import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { expenseReceiptSchema, successEnvelope } from "@venture-studio/contracts";
import { cleanLayout, cleanReceipt, copyReceipt, prepareReceipt, readReceipt, RECEIPT_MODEL, receiptCopyFormat, receiptReadFormat } from "../src/expense-receipts.js";
import { internalHeaders } from "../src/internal-auth.js";
import { DEFAULT_EXPENSE_CATEGORIES } from "../src/routes/expenses.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Expense receipts (routes/expenses.ts, expense-receipts.ts): the kept copy, what Claude Haiku reads off it (answered here by a stand-in,
// so no real call is made), who may upload, see and attach one, letting go of it, and deleting the ones attached to nothing.

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const base = { date: "2026-10-01", amountPaise: 28_580, categoryId: "ai-tools", paidTo: "Sushi Yasuda", scope: { kind: "office" } } as const;

/** What the stand-in Claude reads off every receipt, as the receipt schema has it (the category by name). */
const READ = {
  kind: "receipt", merchant: "Sushi Yasuda", merchantAddress: "204 East 43rd Street, New York", merchantPhone: "(212) 972-1001", merchantTaxId: "", number: "3528", website: "sushiyasuda.com",
  date: "2026-10-01", time: "1:19 PM", billedTo: "", currency: "INR",
  items: [{ name: "Edamame", quantity: 1, unitPrice: 9, amount: 9 }, { name: "A la Carte Sushi", quantity: 1, unitPrice: 243, amount: 243 }],
  subtotal: 262.5, discount: null, taxes: [{ label: "Sales Tax", ratePercent: 8.875, amount: 23.3 }], tip: null, roundOff: null, total: 285.8,
  paymentMethod: "card", cardLast4: "1111", footer: "Paid with card 4111 1111 1111 1111. Thank you", category: "AI tools",
  title: "", store: "Midtown", cashier: "", totalQuantity: null, taxTreatment: "added",
};
/** What the stand-in writes out as the full copy: a card number to cut, an empty line to drop, a table, a QR code. */
const COPY = { layout: [
  { kind: "heading", text: "Sushi Yasuda", cells: [], centered: true },
  { kind: "pair", text: "Card", cells: ["4111 1111 1111 1111"], centered: false },
  { kind: "text", text: "  ", cells: [], centered: false },
  { kind: "head", text: "", cells: ["Item", "Qty", "Amount"], centered: false },
  { kind: "row", text: "", cells: ["Edamame", "1", "9.00"], centered: false },
  { kind: "rule", text: "", cells: [], centered: false },
  { kind: "code", text: "Scan & Pay", cells: ["QR code"], centered: true },
] };
const isCopy = (body: any) => typeof body?.system === "string" && body.system.startsWith("You copy");

/** A small valid PDF with `pages` blank pages (the sandboxed PDF reader counts them). */
function pdf(pages: number) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pages} >>`, ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>")];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** Answers Anthropic's Messages API with `reply`, passes this test's own server through, and refuses any other host. */
function standInClaude() {
  const seen: any[] = [];
  const answer = (read: object) => Response.json({ id: "msg_1", type: "message", role: "assistant", model: RECEIPT_MODEL, content: [{ type: "text", text: JSON.stringify(read) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1800, output_tokens: 400 } });
  const state = { answer, reply: (body: any): Response => answer(isCopy(body) ? COPY : READ) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.anthropic.com") { const body = JSON.parse(String(init?.body ?? "{}")); seen.push(body); return state.reply(body); }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`no real network in tests (${url.hostname})`);
    return realFetch(input, init);
  }) as typeof fetch;
  // The last request for a receipt's details (each reading also asks for its full copy, at the same time).
  return { seen, state, details: () => [...seen].reverse().find((body) => !isCopy(body)), copies: () => seen.filter(isCopy), restore: () => { globalThis.fetch = realFetch; } };
}

test("what is read is tidied: card numbers cut to four digits, a date only when real, the category matched by name", () => {
  const clean = cleanReceipt({ ...READ, date: "06/05/13", cardLast4: "4111 1111", currency: "rs", total: 285.799999, merchant: "  Sushi \n Yasuda " } as never, DEFAULT_EXPENSE_CATEGORIES);
  assert.deepEqual([clean.footer, clean.date, clean.cardLast4, clean.currency, clean.total, clean.merchant, clean.categoryId, clean.number], ["Paid with card •••• 1111. Thank you", null, null, null, 285.8, "Sushi Yasuda", "ai-tools", "3528"]);
  assert.equal(cleanReceipt({ ...READ, category: "Groceries" } as never, DEFAULT_EXPENSE_CATEGORIES).categoryId, null, "a name not in the list picks nothing");
  // Card numbers however they are spaced, in any free-text field; bank accounts where they have no business; date ranges left alone.
  for (const card of ["4111  1111\n1111 1111", "4111\u00a01111 1111 1111", "4111 - 1111 - 1111 - 1111", "4111.1111.1111.1111", "4111/1111/1111/1111", "4111111111111111", "3782 822463 10005"]) {
    const clean = cleanReceipt({ ...READ, footer: `card ${card} thanks`, merchantPhone: card, items: [{ name: `Refund to ${card}`, quantity: 1, unitPrice: null, amount: 1 }] } as never, DEFAULT_EXPENSE_CATEGORIES);
    for (const field of [clean.footer, clean.merchantPhone, clean.items[0]!.name]) assert.doesNotMatch(field ?? "", /\d{4}\D{0,3}\d{4}\D{0,3}\d{4}|822463/, `${JSON.stringify(card)} is masked in ${field}`);
  }
  const loose = cleanReceipt({ ...READ, billedTo: "Buildory, A/c 123456789012", footer: "Plan 01/10/2026 - 31/10/2026, call 080 4567 1200", items: [{ name: "Pro plan 01/10/2026 - 31/10/2026", quantity: 1, unitPrice: null, amount: 1 }] } as never, DEFAULT_EXPENSE_CATEGORIES);
  assert.deepEqual([loose.billedTo, loose.footer, loose.items[0]!.name], ["Buildory, A/c •••• 9012", "Plan 01/10/2026 - 31/10/2026, call 080 4567 1200", "Pro plan 01/10/2026 - 31/10/2026"]);
  // Taxes included in the prices, added on top, or not said; the store kept, an empty title none.
  assert.deepEqual(["included", "added", "unclear"].map((taxTreatment) => cleanReceipt({ ...READ, taxTreatment } as never, DEFAULT_EXPENSE_CATEGORIES).taxIncluded), [true, false, null]);
  assert.deepEqual([clean.store, clean.title, clean.totalQuantity, clean.layout], ["Midtown", null, null, []]);
});

test("the full copy is tidied: card numbers by their checksum, UPI IDs anywhere, account numbers where accounts are meant; empty lines dropped; a long copy cut", () => {
  const line = (kind: string, text: string, cells: string[] = []) => ({ kind, text, cells, centered: false }) as never;
  const clean = cleanLayout([
    line("pair", "Card", ["4111 1111 1111 1111"]),
    line("pair", "Ack No", ["112410034567891"]),
    line("text", "A/c No 123456789012 IFSC SBIN0001234"),
    line("text", "Call 9876543210 for delivery"),
    line("pair", "UPI", ["9876543210@ybl"]),
    line("text", "Pay to 9876543210@okaxis"),
    line("text", "Aadhaar 1234 5678 9012"),
    line("head", "", ["Bank", "A/c No", "IFSC"]), line("row", "", ["SBI", "123456789012", "SBIN0001234"]),
    line("head", "", ["Item", "Amount"]), line("row", "", ["Order 123456789012", "10"]),
    line("text", "", ["stray"]), line("heading", "   "),
    line("code", "Scan & Pay", ["qr"]),
    line("row", "", Array.from({ length: 16 }, (_, index) => String(index))),
  ]);
  assert.deepEqual(clean.slice(0, 13).map((one) => [one.text, one.cells]), [
    ["Card", ["•••• 1111"]], ["Ack No", ["112410034567891"]], ["A/c No •••• 9012 IFSC SBIN0001234", []], ["Call 9876543210 for delivery", []],
    ["UPI", ["•••• 3210@ybl"]], ["Pay to •••• 3210@okaxis", []], ["Aadhaar •••• 9012", []],
    ["", ["Bank", "A/c No", "IFSC"]], ["", ["SBI", "•••• 9012", "SBIN0001234"]], ["", ["Item", "Amount"]], ["", ["Order 123456789012", "10"]],
    ["Scan & Pay", ["QR code"]], ["", Array.from({ length: 14 }, (_, index) => String(index))],
  ]);
  assert.equal(clean.length, 13, "a text line with only cells and a blank heading are dropped");
  const long = cleanLayout(Array.from({ length: 205 }, (_, index) => line("text", `Line ${index}`)));
  assert.deepEqual([long.length, long.at(-1)?.text], [201, "The rest of this receipt is on the original."]);
});

test("the answer format stays within the structured-output limits: at most 16 fields that may be null", () => {
  let unions = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (Array.isArray(value.anyOf) || Array.isArray(value.type)) unions++;
    Object.values(value).forEach(walk);
  };
  walk(receiptReadFormat.schema);
  assert.ok(unions <= 16, `${unions} fields may be null`);
  unions = 0;
  walk(receiptCopyFormat.schema);
  assert.equal(unions, 0, "the full copy's lines have no field that may be null");
  // Text that isn't printed comes back empty and is kept as null.
  const clean = cleanReceipt({ ...READ, merchantTaxId: "", billedTo: "", cardLast4: "", currency: "", date: "", category: "" } as never, DEFAULT_EXPENSE_CATEGORIES);
  assert.deepEqual([clean.merchantTaxId, clean.billedTo, clean.cardLast4, clean.currency, clean.date, clean.categoryId], [null, null, null, null, null, null]);
});

test("a photo is kept as a WebP of about 4 megapixels at most: a phone photo shrinks, a tall receipt keeps its width, a small one stays as it is", async () => {
  const photo = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#7d7468", noise: { type: "gaussian", mean: 110, sigma: 12 } } }).jpeg({ quality: 90 }).toBuffer();
  const kept = async (width: number, height: number) => {
    const original = await photo(width, height);
    const { bytes, contentType } = await prepareReceipt(original);
    const meta = await sharp(bytes).metadata();
    return { contentType, format: meta.format, width: meta.width!, height: meta.height!, smaller: bytes.length < original.length };
  };
  const phone = await kept(3000, 4000);
  assert.deepEqual([phone.contentType, phone.format, phone.smaller], ["image/webp", "webp", true]);
  assert.ok(phone.width * phone.height <= 4_000_000 && phone.width * phone.height > 3_900_000 && Math.abs(phone.width / phone.height - 0.75) < 0.01, `12 MP becomes about 4 MP, same shape: ${phone.width}x${phone.height}`);
  const tall = await kept(1100, 4200);
  assert.ok(tall.width >= 1000 && tall.height >= 3800, `a tall receipt keeps nearly all its width: ${tall.width}x${tall.height}`);
  assert.deepEqual([(await kept(1200, 1600)).width, (await kept(1200, 1600)).height], [1200, 1600], "within the budget: never enlarged or shrunk");
});

test("with no key set, a receipt is kept but not read (nor copied)", async () => {
  // Asking again won't help until a key is set (lasting).
  assert.deepEqual(await readReceipt(undefined, { bytes: Buffer.from("x"), contentType: "image/webp" }, []), { error: "Reading receipts isn't set up yet: type the details in.", lasting: true });
  assert.deepEqual(await copyReceipt(undefined, { bytes: Buffer.from("x"), contentType: "image/webp" }), { error: "Reading receipts isn't set up yet: type the details in.", lasting: true });
});

test("receipts: kept small, read by Haiku, seen and attached only by the right people, let go and cleaned up", { skip }, async () => {
  const uploads = await mkdtemp(join(tmpdir(), "vso-receipts-"));
  const claude = standInClaude();
  try {
    await withSalesApp(async ({ api, db, origin }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
      const upload = async (handle: string, bytes: Buffer, type = "image/png") => read(await fetch(`${origin}/v1/expenses/receipts`, { method: "POST", headers: { "content-type": type, "x-dev-user-id": `user-${handle}` }, body: new Uint8Array(bytes) }));
      const photo = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#f5f1e8" } }).jpeg().toBuffer();
      /** A receipt once its full copy is no longer being written (it is saved a moment after the answer). */
      const copiedReceipt = async (id: string, handle = "boss") => {
        for (let tries = 0; ; tries++) {
          const got = (await call("GET", `/expenses/receipts/${id}`, handle)).body.data;
          if (got.copy !== "writing" || tries > 100) return got;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "edit", restricted: false });
      await call("PUT", "/expenses/settings/access/user-member2", "boss", { level: "view", restricted: false });

      // The boss (restricted access) uploads a photo: kept as a WebP (this one is within the size budget, so at its own size), read, the category matched.
      const first = await upload("boss", photo, "image/jpeg");
      assert.equal(first.status, 201, first.text);
      const receipt = successEnvelope(expenseReceiptSchema).parse(first.body).data;
      assert.deepEqual([receipt.contentType, receipt.data?.number, receipt.data?.total, receipt.data?.categoryId, receipt.data?.footer, receipt.expenseId], ["image/webp", "3528", 285.8, "ai-tools", "Paid with card •••• 1111. Thank you", undefined]);
      const sent = claude.details();
      assert.deepEqual([sent.model, sent.thinking, sent.output_config.effort, sent.output_config.format.type, sent.messages[0].content[0].type, sent.messages[0].content[0].source.media_type], [RECEIPT_MODEL, { type: "adaptive" }, "low", "json_schema", "image", "image/webp"]);
      assert.match(sent.messages[0].content[1].text, /Salary/, "the boss may file it under a restricted category");
      assert.deepEqual([receipt.data?.taxIncluded, receipt.data?.store], [false, "Midtown"]);
      // The full copy was asked for at the same time (no categories with it), and is saved on the receipt when it comes: tidied like
      // the details (the card cut to four digits, the empty line dropped), its table and QR code kept.
      const copyAsked = claude.copies().at(-1);
      assert.deepEqual([copyAsked.model, copyAsked.output_config.format.type, copyAsked.messages[0].content.length], [RECEIPT_MODEL, "json_schema", 1]);
      const copied = await copiedReceipt(receipt.id);
      assert.equal(copied.copy, undefined);
      assert.deepEqual(copied.data.layout.map((line: any) => [line.kind, line.text, line.cells]), [
        ["heading", "Sushi Yasuda", []], ["pair", "Card", ["•••• 1111"]], ["head", "", ["Item", "Qty", "Amount"]], ["row", "", ["Edamame", "1", "9.00"]], ["rule", "", []], ["code", "Scan & Pay", ["QR code"]],
      ]);
      const kept = await fetch(`${origin}/v1/expenses/receipts/${receipt.id}/file`, { headers: { "x-dev-user-id": "user-boss" } });
      assert.deepEqual([kept.status, kept.headers.get("content-type"), (await sharp(Buffer.from(await kept.arrayBuffer())).metadata()).width], [200, "image/webp", 2400]);

      // Not attached yet: only who uploaded it sees it. People who only view can't upload; a file that isn't a photo or PDF is refused.
      assert.equal((await call("GET", `/expenses/receipts/${receipt.id}`, "member")).status, 404);
      assert.equal((await upload("member2", photo)).status, 403);
      // Only image and PDF bodies are read; anything that isn't really a photo (an SVG, junk bytes) is refused.
      assert.equal((await upload("member", Buffer.from("not a receipt"), "text/plain")).status, 400);
      assert.equal((await upload("member", Buffer.from("not a receipt"), "image/png")).status, 415);
      assert.equal((await upload("member", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), "image/svg+xml")).status, 415);
      const members = await upload("member", photo);
      assert.equal(members.status, 201, members.text);
      assert.doesNotMatch(claude.details().messages[0].content[1].text, /Salary|Personal EMI/, "restricted category names stay out for people who can't see them");
      // A PDF is kept as it came and sent as a document; a long one, or one that won't open, is kept but not read.
      const pdfReceipt = await upload("boss", pdf(1), "application/pdf");
      assert.deepEqual([pdfReceipt.status, pdfReceipt.body.data.contentType, claude.details().messages[0].content[0].type, claude.copies().at(-1).messages[0].content[0].type], [201, "application/pdf", "document", "document"], pdfReceipt.text);
      const calls = claude.seen.length;
      const long = await upload("boss", pdf(6), "application/pdf");
      assert.deepEqual([long.status, long.body.data.data, long.body.data.error, claude.seen.length], [201, null, "This PDF has 6 pages: only receipts of up to 5 pages are read. Type the details in.", calls]);
      assert.match((await upload("boss", Buffer.from("%PDF-1.4\nbroken"), "application/pdf")).body.data.error, /Couldn't open this PDF/);
      const pdf1 = pdfReceipt.body.data;

      // Attaching: the uploader's own receipt; nobody else's, and not one another expense holds.
      const expense = await call("POST", "/expenses", "boss", { ...base, receiptId: receipt.id });
      assert.equal(expense.status, 201, expense.text);
      assert.equal(expense.body.data.receiptId, receipt.id);
      assert.equal((await call("POST", "/expenses", "member", { ...base, receiptId: receipt.id })).status, 400, "already attached elsewhere");
      const before = await db.collection("expenses").countDocuments();
      assert.equal((await call("POST", "/expenses", "member", { ...base, receiptId: pdf1.id })).status, 400, "someone else's receipt");
      assert.equal(await db.collection("expenses").countDocuments(), before, "a refused receipt saves nothing");
      // Attached: whoever sees the expense sees the receipt, and its copy.
      assert.equal((await call("GET", `/expenses/receipts/${receipt.id}`, "member2")).body.data.expenseId, expense.body.data.id);
      assert.equal((await fetch(`${origin}/v1/expenses/receipts/${receipt.id}/file`, { headers: { "x-dev-user-id": "user-member2" } })).status, 200);
      // A receipt on a restricted expense stays hidden with it.
      const salary = await call("POST", "/expenses", "boss", { ...base, categoryId: "salary", paidTo: "Team salary", receiptId: pdf1.id });
      assert.equal(salary.status, 201, salary.text);
      for (const path of [`/expenses/receipts/${pdf1.id}`, `/expenses/receipts/${pdf1.id}/file`]) assert.equal((await call("GET", path, "member2")).status, 404, path);
      // A restricted category it suggested is never shown to someone who can't see that category.
      claude.state.reply = () => claude.state.answer({ ...READ, category: "Salary" });
      const suggested = (await upload("boss", photo)).body.data;
      claude.state.reply = (body: any) => claude.state.answer(isCopy(body) ? COPY : READ);
      assert.equal(suggested.data.categoryId, "salary");
      assert.equal((await call("POST", "/expenses", "boss", { ...base, paidTo: "Snacks", receiptId: suggested.id })).status, 201);
      assert.deepEqual([(await call("GET", `/expenses/receipts/${suggested.id}`, "member2")).body.data.data.categoryId, (await call("GET", `/expenses/receipts/${suggested.id}`, "boss")).body.data.data.categoryId], [null, "salary"]);

      // Another receipt replaces it (the old one is let go); none lets go of it; deleting the expense lets go of its receipt.
      const second = (await upload("boss", photo)).body.data;
      const replaced = await call("PATCH", `/expenses/${expense.body.data.id}`, "boss", { receiptId: second.id });
      assert.equal(replaced.body.data.receiptId, second.id, replaced.text);
      const old = await db.collection("expense_receipts").findOne({ _id: receipt.id as never });
      assert.ok(old && old.expenseId === undefined && old.ownerId === undefined && old.orphanedAt instanceof Date, "the replaced receipt is let go");
      assert.equal((await call("GET", `/expenses/receipts/${receipt.id}`, "boss")).status, 404, "once let go, not even its uploader sees it");
      assert.equal((await call("POST", "/expenses", "boss", { ...base, receiptId: receipt.id })).status, 400, "nor attaches it again");
      assert.equal((await call("PATCH", `/expenses/${expense.body.data.id}`, "boss", { receiptId: null })).body.data.receiptId, null);
      assert.ok((await db.collection("expense_receipts").findOne({ _id: second.id as never }))?.orphanedAt instanceof Date);
      assert.equal((await call("DELETE", `/expenses/${salary.body.data.id}`, "boss")).status, 200);
      assert.ok((await db.collection("expense_receipts").findOne({ _id: pdf1.id as never }))?.orphanedAt instanceof Date, "deleting the expense lets go of its receipt");
      // A new amount from a month on doesn't take the receipt along.
      const third = (await upload("boss", photo)).body.data;
      const monthly = (await call("POST", "/expenses", "boss", { ...base, repeat: "monthly", receiptId: third.id })).body.data;
      const changed = await call("POST", `/expenses/${monthly.id}/change`, "boss", { fromMonth: "2026-12", amountPaise: 30_000 });
      assert.deepEqual([changed.status, changed.body.data.stopped.receiptId, changed.body.data.continued.receiptId], [201, third.id, undefined], changed.text);

      // A copy that can't be written (an answer that doesn't fit its format) leaves the details, and shows as failed.
      claude.state.reply = (body: any) => (isCopy(body) ? claude.state.answer({ layout: "not a list" }) : claude.state.answer(READ));
      const noCopy = (await upload("boss", photo)).body.data;
      const noCopyNow = await copiedReceipt(noCopy.id);
      assert.deepEqual([noCopyNow.data.total, noCopyNow.copy, noCopyNow.data.layout], [285.8, "failed", []]);
      claude.state.reply = (body: any) => claude.state.answer(isCopy(body) ? COPY : READ);
      // A receipt that couldn't be read has no copy being written either.
      assert.equal(long.body.data.copy, undefined);
      // Reading a PDF too long to read again won't help: said plainly, not "try again".
      const tooLong = await call("POST", `/expenses/receipts/${long.body.data.id}/read`, "boss");
      assert.deepEqual([tooLong.status, tooLong.body.error.message], [400, "This PDF has 6 pages: only receipts of up to 5 pages are read."]);

      // Read again: its details and full copy read anew from the kept file, by someone who may change it; never by someone who only
      // views, nor through Claude. A failed read leaves the one before.
      await db.collection("expense_receipts").updateOne({ _id: third.id as never }, { $unset: { layout: "", copyState: "", copyStartedAt: "" }, $set: { "data.store": null } });
      assert.deepEqual((await copiedReceipt(third.id)).data.layout, [], "read before the full copy existed");
      const again = await call("POST", `/expenses/receipts/${third.id}/read`, "boss");
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.data.data.store, "Midtown");
      assert.equal((await copiedReceipt(third.id)).data.layout.length, 6);
      assert.equal((await call("POST", `/expenses/receipts/${third.id}/read`, "member2")).status, 403, "viewers don't read receipts again");
      assert.equal((await fetch(`${origin}/v1/expenses/receipts/${third.id}/read`, { method: "POST", headers: internalHeaders("user-boss", ["expenses:read", "expenses:write"]) })).status, 403, "nor does Claude");
      claude.state.reply = () => new Response("{}", { status: 500 });
      const failed = await call("POST", `/expenses/receipts/${third.id}/read`, "boss");
      assert.deepEqual([failed.status, failed.body.error.message], [503, "Couldn't read this receipt. Try again in a moment."]);
      const kept3 = await copiedReceipt(third.id);
      assert.deepEqual([kept3.data.store, kept3.data.layout.length], ["Midtown", 6], "the reading before stays");
      claude.state.reply = (body: any) => claude.state.answer(isCopy(body) ? COPY : READ);
      assert.ok(await db.collection("audit_events").findOne({ action: "expense.receipt.read", objectId: third.id }));
      // A copy still "being written" long after it was asked for never will be: it shows as failed (Read again tries anew).
      await db.collection("expense_receipts").updateOne({ _id: third.id as never }, { $unset: { layout: "" }, $set: { copyState: "writing", copyStartedAt: new Date(Date.now() - 5 * 60_000) } });
      assert.equal((await call("GET", `/expenses/receipts/${third.id}`, "boss")).body.data.copy, "failed");

      // When the reader fails or its key is refused, the receipt is still kept, with a sentence saying why.
      claude.state.reply = () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
      const refused = await upload("boss", photo);
      assert.deepEqual([refused.status, refused.body.data.data, refused.body.data.error], [201, null, "The receipt reader's key was refused: an admin needs to check it. Type the details in."]);
      claude.state.reply = () => new Response("{}", { status: 500 });
      assert.equal((await upload("boss", photo)).body.data.error, "Couldn't read this receipt: type the details in.");

      // Receipts attached to nothing for a day are deleted (doc and copy) when the list is next opened (or a receipt added); attached ones stay.
      await db.collection("expense_receipts").updateOne({ _id: receipt.id as never }, { $set: { orphanedAt: new Date(Date.now() - 2 * 86_400_000) } });
      await call("GET", "/expenses", "member2");
      for (let tries = 0; tries < 50 && await db.collection("expense_receipts").findOne({ _id: receipt.id as never }); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await db.collection("expense_receipts").findOne({ _id: receipt.id as never }), null);
      assert.equal((await call("GET", `/expenses/receipts/${receipt.id}/file`, "boss")).status, 404);
      assert.ok(await db.collection("expense_receipts").findOne({ _id: third.id as never }), "the attached one stays");

      // The audit trail says a receipt came in and whether it was read; never what it said.
      const audits = await db.collection("audit_events").find({ action: "expense.receipt.upload" }).toArray();
      // (Field names, not a search for "285": ids and timestamps can contain those digits by chance.)
      assert.ok(audits.length >= 6, `${audits.length} uploads audited`);
      for (const entry of audits) {
        assert.deepEqual(Object.keys(entry.metadata ?? {}).sort(), ["contentType", "read"]);
        assert.doesNotMatch(JSON.stringify(entry), /Sushi|Edamame/);
      }
    }, "expense_receipts", { ANTHROPIC_API_KEY: "sk-ant-test-stand-in", LOCAL_UPLOAD_DIR: uploads, COMPANY_LOGO_FETCH: "off" });
  } finally {
    claude.restore();
    await rm(uploads, { recursive: true, force: true });
  }
});
