import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { expenseReceiptSchema, successEnvelope } from "@venture-studio/contracts";
import { cleanReceipt, readReceipt, RECEIPT_MODEL } from "../src/expense-receipts.js";
import { DEFAULT_EXPENSE_CATEGORIES } from "../src/routes/expenses.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// Expense receipts (routes/expenses.ts, expense-receipts.ts): the kept copy, what Claude Haiku reads off it (answered here by a stand-in,
// so no real call is made), who may upload, see and attach one, letting go of it, and deleting the ones attached to nothing.

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const base = { date: "2026-10-01", amountPaise: 28_580, categoryId: "ai-tools", paidTo: "Sushi Yasuda", scope: { kind: "office" } } as const;

/** What the stand-in Claude reads off every receipt, as the receipt schema has it (the category by name). */
const READ = {
  kind: "receipt", merchant: "Sushi Yasuda", merchantAddress: "204 East 43rd Street, New York", merchantPhone: "(212) 972-1001", merchantTaxId: null, number: "3528",
  date: "2026-10-01", time: "1:19 PM", billedTo: null, currency: "INR",
  items: [{ name: "Edamame", quantity: 1, unitPrice: 9, amount: 9 }, { name: "A la Carte Sushi", quantity: 1, unitPrice: 243, amount: 243 }],
  subtotal: 262.5, discount: null, taxes: [{ label: "Sales Tax", ratePercent: 8.875, amount: 23.3 }], tip: null, total: 285.8,
  paymentMethod: "card", cardLast4: "1111", footer: "Paid with card 4111 1111 1111 1111. Thank you", category: "AI tools",
};

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
  const state = { answer, reply: (): Response => answer(READ) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.anthropic.com") { seen.push(JSON.parse(String(init?.body ?? "{}"))); return state.reply(); }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`no real network in tests (${url.hostname})`);
    return realFetch(input, init);
  }) as typeof fetch;
  return { seen, state, restore: () => { globalThis.fetch = realFetch; } };
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
});

test("with no key set, a receipt is kept but not read", async () => {
  assert.deepEqual(await readReceipt(undefined, { bytes: Buffer.from("x"), contentType: "image/webp" }, []), { error: "Reading receipts isn't set up yet: type the details in." });
});

test("receipts: kept small, read by Haiku, seen and attached only by the right people, let go and cleaned up", { skip }, async () => {
  const uploads = await mkdtemp(join(tmpdir(), "vso-receipts-"));
  const claude = standInClaude();
  try {
    await withSalesApp(async ({ api, db, origin }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
      const upload = async (handle: string, bytes: Buffer, type = "image/png") => read(await fetch(`${origin}/v1/expenses/receipts`, { method: "POST", headers: { "content-type": type, "x-dev-user-id": `user-${handle}` }, body: new Uint8Array(bytes) }));
      const photo = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#f5f1e8" } }).jpeg().toBuffer();
      await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "edit", restricted: false });
      await call("PUT", "/expenses/settings/access/user-member2", "boss", { level: "view", restricted: false });

      // The boss (restricted access) uploads a photo: kept as a WebP at most 1600px wide, read, the category matched.
      const first = await upload("boss", photo, "image/jpeg");
      assert.equal(first.status, 201, first.text);
      const receipt = successEnvelope(expenseReceiptSchema).parse(first.body).data;
      assert.deepEqual([receipt.contentType, receipt.data?.number, receipt.data?.total, receipt.data?.categoryId, receipt.data?.footer, receipt.expenseId], ["image/webp", "3528", 285.8, "ai-tools", "Paid with card •••• 1111. Thank you", undefined]);
      const sent = claude.seen.at(-1);
      assert.deepEqual([sent.model, sent.thinking, sent.output_config.format.type, sent.messages[0].content[0].type, sent.messages[0].content[0].source.media_type], [RECEIPT_MODEL, { type: "disabled" }, "json_schema", "image", "image/webp"]);
      assert.match(sent.messages[0].content[1].text, /Salary/, "the boss may file it under a restricted category");
      const kept = await fetch(`${origin}/v1/expenses/receipts/${receipt.id}/file`, { headers: { "x-dev-user-id": "user-boss" } });
      assert.deepEqual([kept.status, kept.headers.get("content-type"), (await sharp(Buffer.from(await kept.arrayBuffer())).metadata()).width], [200, "image/webp", 1600]);

      // Not attached yet: only who uploaded it sees it. People who only view can't upload; a file that isn't a photo or PDF is refused.
      assert.equal((await call("GET", `/expenses/receipts/${receipt.id}`, "member")).status, 404);
      assert.equal((await upload("member2", photo)).status, 403);
      // Only image and PDF bodies are read; anything that isn't really a photo (an SVG, junk bytes) is refused.
      assert.equal((await upload("member", Buffer.from("not a receipt"), "text/plain")).status, 400);
      assert.equal((await upload("member", Buffer.from("not a receipt"), "image/png")).status, 415);
      assert.equal((await upload("member", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), "image/svg+xml")).status, 415);
      const members = await upload("member", photo);
      assert.equal(members.status, 201, members.text);
      assert.doesNotMatch(claude.seen.at(-1).messages[0].content[1].text, /Salary|Personal EMI/, "restricted category names stay out for people who can't see them");
      // A PDF is kept as it came and sent as a document; a long one, or one that won't open, is kept but not read.
      const pdfReceipt = await upload("boss", pdf(1), "application/pdf");
      assert.deepEqual([pdfReceipt.status, pdfReceipt.body.data.contentType, claude.seen.at(-1).messages[0].content[0].type], [201, "application/pdf", "document"], pdfReceipt.text);
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
      claude.state.reply = () => claude.state.answer(READ);
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
      assert.ok(audits.length >= 6 && audits.every((entry) => !JSON.stringify(entry).includes("285") && !JSON.stringify(entry).includes("Sushi")));
    }, "expense_receipts", { ANTHROPIC_API_KEY: "sk-ant-test-stand-in", LOCAL_UPLOAD_DIR: uploads });
  } finally {
    claude.restore();
    await rm(uploads, { recursive: true, force: true });
  }
});
