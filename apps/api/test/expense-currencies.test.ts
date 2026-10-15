import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { currencyDigits, expenseInputSchema, expenseRatesSchema, expenseSchema, successEnvelope } from "@venture-studio/contracts";
import { withSalesApp } from "./mcp-sales-harness.js";

// Expenses in another currency (routes/expenses.ts, exchange-rates.ts): the rupee amount from the bank's figure or the day's reference
// rate (the Friday before a weekend), repeating ones and price changes in their own currency, the rates the screens convert with, each
// day fetched once, and what happens when the rates can't be had. The rates come from a stand-in for the source, on this machine.

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const base = { amountPaise: undefined, categoryId: "ai-tools", paidTo: "Contabo", scope: { kind: "office" } } as const;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

test("an expense in another currency: the amount in it, the bank's rupees only with a one-time one, never INR as the other currency", () => {
  const ok = (value: unknown) => expenseInputSchema.safeParse({ date: "2026-10-13", categoryId: "ai-tools", paidTo: "Contabo", scope: { kind: "office" }, ...(value as object) }).success;
  assert.equal(ok({ foreign: { currency: "EUR", amountMinor: 649 } }), true, "no rupee amount needed");
  assert.equal(ok({ foreign: { currency: "EUR", amountMinor: 649 }, chargedPaise: 68_000 }), true);
  assert.equal(ok({}), false, "an amount is needed");
  assert.equal(ok({ amountPaise: 1_000, chargedPaise: 1_000 }), false, "the bank's rupees go with another currency");
  assert.equal(ok({ foreign: { currency: "USD", amountMinor: 2_000 }, chargedPaise: 170_000, repeat: "monthly" }), false, "a repeating one converts at each payment's rate");
  assert.equal(ok({ foreign: { currency: "INR", amountMinor: 649 } }), false);
  assert.equal(ok({ foreign: { currency: "AED", amountMinor: 649 } }), false, "only currencies with a daily reference rate");
  assert.deepEqual([currencyDigits("USD"), currencyDigits("JPY"), currencyDigits("INR")], [2, 0, 2]);
});

test("prices: the day's rate (the Friday before a weekend), the bank's figure as given, yen without cents; rates fetched once and served to the screens", { skip }, async () => {
  // The stand-in: €1 = ₹100, $1.25, £0.80, ¥160 on every working day (so $1 = ₹80, £1 = ₹125, ¥1 = ₹0.625); it can be made to fail.
  const asked: string[] = [];
  let failing = false;
  const source = createServer((req, res) => {
    const match = /^\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(req.url ?? "");
    asked.push(req.url ?? "");
    if (failing || !match) { res.writeHead(failing ? 500 : 404); res.end(); return; }
    const rates: Record<string, Record<string, number>> = {};
    for (let day = match[1]!; day <= match[2]!; day = nextDay(day)) if (![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) rates[day] = { INR: 100, USD: 1.25, GBP: 0.8, JPY: 160 };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ amount: 1, base: "EUR", rates }));
  }).listen(0);
  await once(source, "listening");
  const port = (source.address() as { port: number }).port;
  try {
    await withSalesApp(async ({ api }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
      const add = async (body: Record<string, unknown>) => { const result = await call("POST", "/expenses", "boss", { ...base, ...body }); assert.equal(result.status, 201, result.text); return expenseSchema.parse(result.body.data); };

      // €6.49 on a Tuesday: at that day's rate.
      const euro = await add({ date: "2026-10-13", foreign: { currency: "EUR", amountMinor: 649 } });
      assert.deepEqual([euro.amountPaise, euro.rate, euro.rateDate, euro.foreign], [64_900, 100, "2026-10-13", { currency: "EUR", amountMinor: 649 }]);
      // On a Sunday: the Friday before's rate.
      const sunday = await add({ date: "2026-10-11", foreign: { currency: "GBP", amountMinor: 1_000 } });
      assert.deepEqual([sunday.amountPaise, sunday.rateDate], [1_250_00, "2026-10-09"]);
      // Yen have no cents; a repeating dollar subscription is priced at its first payment's rate.
      assert.equal((await add({ date: "2026-10-12", foreign: { currency: "JPY", amountMinor: 1_000 } })).amountPaise, 625_00);
      const dollars = await add({ date: "2026-08-20", repeat: "monthly", paidTo: "Anthropic", foreign: { currency: "USD", amountMinor: 2_000 } });
      assert.deepEqual([dollars.amountPaise, dollars.rate], [1_600_00, 80]);
      // What the bank charged counts exactly, and needs no rate.
      const before = asked.length;
      const charged = await add({ date: "2026-06-03", foreign: { currency: "USD", amountMinor: 2_000 }, chargedPaise: 1_734_56 });
      assert.deepEqual([charged.amountPaise, charged.rate, charged.chargedPaise, asked.length], [1_734_56, null, 1_734_56, before]);
      // A rupee expense is as typed.
      const rupees = await add({ date: "2026-10-13", amountPaise: 170_000 });
      assert.deepEqual([rupees.amountPaise, rupees.foreign ?? null, rupees.rate ?? null], [170_000, null, null]);

      // The screens' rates: each working day in the span and the one before it, as rupees a unit; served from what is kept.
      const rates = await call("GET", "/expenses/rates?from=2026-10-12&to=2026-10-14&currencies=usd,EUR", "boss");
      assert.equal(rates.status, 200, rates.text);
      const parsed = successEnvelope(expenseRatesSchema).parse(rates.body).data;
      assert.deepEqual(parsed.days.map((day) => day.day), ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]);
      assert.deepEqual(parsed.days[0]!.rupees, { USD: 80, EUR: 100 });
      const kept = asked.length;
      await call("GET", "/expenses/rates?from=2026-10-12&to=2026-10-13&currencies=USD", "boss");
      await add({ date: "2026-10-12", foreign: { currency: "USD", amountMinor: 100 } });
      assert.equal(asked.length, kept, "days already kept aren't asked for again");
      assert.equal((await call("GET", "/expenses/rates?from=2026-10-12&to=2026-10-13&currencies=AED", "boss")).status, 400);
      assert.equal((await call("GET", "/expenses/rates?from=2026-10-12&to=2026-10-13&currencies=USD", "outsider")).status, 404, "only people with access to expenses");

      // Edits: a new note keeps the rate; a new day prices it again; back to rupees drops the rate.
      const noted = await call("PATCH", `/expenses/${euro.id}`, "boss", { note: "VPS", expectedUpdatedAt: euro.updatedAt });
      assert.deepEqual([noted.body.data.amountPaise, noted.body.data.rateDate], [64_900, "2026-10-13"]);
      const moved = await call("PATCH", `/expenses/${euro.id}`, "boss", { date: "2026-10-10", expectedUpdatedAt: noted.body.data.updatedAt });
      assert.equal(moved.body.data.rateDate, "2026-10-09");
      const inRupees = await call("PATCH", `/expenses/${euro.id}`, "boss", { foreign: null, amountPaise: 67_000, expectedUpdatedAt: moved.body.data.updatedAt });
      assert.deepEqual([inRupees.body.data.amountPaise, inRupees.body.data.foreign, inRupees.body.data.rate], [67_000, null, null]);
      assert.equal((await call("PATCH", `/expenses/${dollars.id}`, "boss", { chargedPaise: 170_000, expectedUpdatedAt: dollars.updatedAt })).status, 400, "no bank figure on a repeating one");

      // A new price from a month on is in the subscription's own currency.
      assert.equal((await call("POST", `/expenses/${dollars.id}/change`, "boss", { fromMonth: "2026-09", amountPaise: 200_000, expectedUpdatedAt: dollars.updatedAt })).status, 400);
      const changed = await call("POST", `/expenses/${dollars.id}/change`, "boss", { fromMonth: "2026-09", amountMinor: 2_500, expectedUpdatedAt: dollars.updatedAt });
      assert.equal(changed.status, 201, changed.text);
      assert.deepEqual([changed.body.data.continued.foreign, changed.body.data.continued.amountPaise, changed.body.data.continued.date, changed.body.data.stopped.endMonth], [{ currency: "USD", amountMinor: 2_500 }, 2_000_00, "2026-09-20", "2026-08"]);

      // The source down: a day not kept can't be priced (the bank's figure still can); the screens get what is kept; it isn't asked
      // again for a while.
      failing = true;
      const refused = await call("POST", "/expenses", "boss", { ...base, date: "2026-03-10", foreign: { currency: "USD", amountMinor: 999 } });
      assert.deepEqual([refused.status, refused.body.error.code], [503, "INTEGRATION_UNAVAILABLE"]);
      assert.match(refused.body.error.message, /USD rate for 2026-03-10.*what the bank charged in rupees/);
      const atFailure = asked.length;
      assert.equal((await call("POST", "/expenses", "boss", { ...base, date: "2026-03-10", foreign: { currency: "USD", amountMinor: 999 }, chargedPaise: 85_000 })).status, 201);
      const fallback = successEnvelope(expenseRatesSchema).parse((await call("GET", "/expenses/rates?from=2026-03-01&to=2026-10-13&currencies=USD", "boss")).body).data;
      assert.equal(fallback.unavailable, false, "the kept days are still there");
      assert.equal(fallback.days.some((day) => day.day < "2026-08-01"), false, "nothing invented for the days it couldn't get");
      assert.equal(asked.length, atFailure, "not asked again right after failing");
      const nothing = successEnvelope(expenseRatesSchema).parse((await call("GET", "/expenses/rates?from=2025-01-01&to=2025-01-31&currencies=USD", "boss")).body).data;
      assert.deepEqual([nothing.unavailable, nothing.days.length], [true, 0]);
    }, "currencies", { EXCHANGE_RATES_URL: `http://127.0.0.1:${port}/v1` });
  } finally { source.close(); }
});

test("rates: never an old one for a new expense, none published is said plainly, far spans fetched alone, long ones a year at a time", { skip }, async () => {
  // The stand-in has no yen rate before 2026, like a currency the source began publishing later.
  const asked: string[] = [];
  let failing = false;
  const source = createServer((req, res) => {
    const match = /^\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(req.url ?? "");
    asked.push(match ? `${match[1]}..${match[2]}` : req.url ?? "");
    if (failing || !match) { res.writeHead(failing ? 500 : 404); res.end(); return; }
    const rates: Record<string, Record<string, number>> = {};
    for (let day = match[1]!; day <= match[2]!; day = nextDay(day)) if (![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) rates[day] = { INR: 100, USD: 1.25, ...(day >= "2026-01-01" ? { JPY: 160 } : {}) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ amount: 1, base: "EUR", rates }));
  }).listen(0);
  await once(source, "listening");
  const port = (source.address() as { port: number }).port;
  const span = (text: string) => { const [a, b] = text.split(".."); return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000; };
  try {
    await withSalesApp(async ({ api }) => {
      const call = async (method: string, path: string, body?: unknown) => read(await api(method, path, "boss", body));
      // The screens' span first: the last weeks kept.
      assert.equal((await call("GET", "/expenses/rates?from=2026-10-01&to=2026-10-13&currencies=USD")).status, 200);
      // No yen rate published that day: a plain refusal, not "try again".
      const noYen = await call("POST", "/expenses", { ...base, date: "2025-12-10", foreign: { currency: "JPY", amountMinor: 1_000 } });
      assert.deepEqual([noYen.status, noYen.body.error.code], [400, "BAD_REQUEST"]);
      assert.match(noYen.body.error.message, /no published JPY rate for 2025-12-10/);
      // A span far from the kept days is fetched on its own, and only that span.
      asked.length = 0;
      assert.equal((await call("GET", "/expenses/rates?from=2020-01-06&to=2020-01-10&currencies=USD")).status, 200);
      assert.deepEqual(asked, ["2019-12-27..2020-01-10"]);
      asked.length = 0;
      assert.equal((await call("GET", "/expenses/rates?from=2020-01-06&to=2020-01-10&currencies=USD")).status, 200);
      assert.deepEqual(asked, [], "kept now");
      // A long span next to the kept days: fetched a year at most at a time.
      assert.equal((await call("GET", "/expenses/rates?from=2024-01-01&to=2026-10-13&currencies=USD")).status, 200);
      assert.ok(asked.length >= 2 && asked.every((text) => span(text) <= 366), JSON.stringify(asked));
      // The source down, and nothing kept within ten days before the day (only 2020 and the last years): no old rate, a refusal.
      failing = true;
      const old = await call("POST", "/expenses", { ...base, date: "2023-06-15", foreign: { currency: "USD", amountMinor: 500 } });
      assert.deepEqual([old.status, old.body.error?.code], [503, "INTEGRATION_UNAVAILABLE"], old.text);
    }, "currency-review", { EXCHANGE_RATES_URL: `http://127.0.0.1:${port}/v1` });
  } finally { source.close(); }
});
