import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { FULL, mcpTool, STUDIO, withSalesApp } from "./mcp-sales-harness.js";
import { INTERNAL_KEY_HEADER, INTERNAL_SCOPES_HEADER, INTERNAL_USER_HEADER, internalHeaders, internalScopes } from "../src/internal-auth.js";

// Expenses through Claude (mcp/tools-expenses.ts, the expense routes' gate, the inbox): only keys with Expenses ticked, reading with
// expenses:read and changing with expenses:write; the access list applies; salaries and EMIs never, whatever the person sees in the
// app. Exchange rates come from a stand-in on this machine (€1 = ₹100, $1.25: so $1 = ₹80).

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const EXPENSE_TOOLS = ["expense_options", "expense_report", "list_expenses", "list_subscriptions", "add_expenses", "update_expense", "change_expense_price", "delete_expense"];

test("expenses through Claude: the tick, the access list, never salaries; reports, lists, subscriptions; adding, changing, repricing, deleting", { skip }, async () => {
  const source = createServer((req, res) => {
    const match = /^\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(req.url ?? "");
    if (!match) { res.writeHead(404); res.end(); return; }
    const rates: Record<string, Record<string, number>> = {};
    for (let day = match[1]!; day <= match[2]!; day = nextDay(day)) if (![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) rates[day] = { INR: 100, USD: 1.25 };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ amount: 1, base: "EUR", rates }));
  }).listen(0);
  await once(source, "listening");
  try {
    await withSalesApp(async ({ api, db, origin, tokenFor }) => {
      const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
      const add = async (body: Record<string, unknown>) => { const result = await call("POST", "/expenses", "boss", { scope: { kind: "office" }, ...body }); assert.equal(result.status, 201, result.text); return result.body.data; };
      // In the app: hosting and a salary in October, a dollar subscription for Alpha since August.
      const hosting = await add({ date: "2026-10-05", amountPaise: 1_100_00, categoryId: "hosting", paidTo: "Contabo" });
      const salary = await add({ date: "2026-10-01", amountPaise: 50_000_00, categoryId: "salary", paidTo: "Ramesh" });
      const claudeSub = await add({ date: "2026-08-03", foreign: { currency: "USD", amountMinor: 2_000 }, categoryId: "ai-tools", paidTo: "Anthropic", repeat: "monthly", scope: { kind: "venture", ventureId: "venture-a" } });
      assert.equal(claudeSub.amountPaise, 1_600_00);

      // The tick decides which tools a key has.
      const toolsOf = async (token: string) => ((await (await fetch(`${origin}${STUDIO}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).json()) as any).result.tools.map((item: any) => item.name as string);
      const plain = await tokenFor("boss");
      const reader = await tokenFor("boss", [...FULL.filter((scope) => scope.endsWith(":read")), "expenses:read"]);
      const writer = await tokenFor("boss", [...FULL, "expenses:read", "expenses:write"]);
      assert.deepEqual((await toolsOf(plain)).filter((name: string) => EXPENSE_TOOLS.includes(name)), [], "no tick, no expense tools");
      assert.deepEqual((await toolsOf(reader)).filter((name: string) => EXPENSE_TOOLS.includes(name)).sort(), ["expense_options", "expense_report", "list_expenses", "list_subscriptions"]);
      assert.deepEqual((await toolsOf(writer)).filter((name: string) => EXPENSE_TOOLS.includes(name)).sort(), [...EXPENSE_TOOLS].sort());
      // The API itself refuses an internal call whose key lacks the tick, and never shows salaries to one that has it.
      assert.equal((await fetch(`${origin}/v1/expenses`, { headers: internalHeaders("user-boss", ["tasks:read"]) })).status, 403);
      const viaClaude = (await read(await fetch(`${origin}/v1/expenses`, { headers: internalHeaders("user-boss", ["expenses:read"]) }))).body.data;
      assert.deepEqual(viaClaude.items.map((item: any) => item.paidTo).sort(), ["Anthropic", "Contabo"]);
      assert.equal(viaClaude.hiddenRestricted, true);
      assert.equal((await fetch(`${origin}/v1/expenses/${salary.id}`, { headers: internalHeaders("user-boss", ["expenses:read"]) })).status, 404);
      assert.equal((await fetch(`${origin}/v1/expenses`, { method: "POST", headers: { ...internalHeaders("user-boss", ["expenses:read"]), "content-type": "application/json" }, body: JSON.stringify({ date: "2026-10-01", amountPaise: 100, categoryId: "hosting", paidTo: "X", scope: { kind: "office" } }) })).status, 403, "writing needs expenses:write");
      // The scopes header counts only with this process's internal key: without it, or with a wrong one, there are no scopes (and no user).
      assert.deepEqual([...internalScopes({ [INTERNAL_USER_HEADER]: "user-boss", [INTERNAL_SCOPES_HEADER]: "expenses:read" })], []);
      assert.deepEqual([...internalScopes({ [INTERNAL_USER_HEADER]: "user-boss", [INTERNAL_KEY_HEADER]: "not-the-key", [INTERNAL_SCOPES_HEADER]: "expenses:read" })], []);
      assert.deepEqual([...internalScopes(internalHeaders("user-boss", ["expenses:read"]))], ["expenses:read"]);
      const forged: Record<string, string>[] = [{ [INTERNAL_USER_HEADER]: "user-boss", [INTERNAL_SCOPES_HEADER]: "expenses:read" }, { [INTERNAL_USER_HEADER]: "user-boss", [INTERNAL_KEY_HEADER]: "not-the-key", [INTERNAL_SCOPES_HEADER]: "expenses:read" }];
      for (const headers of forged) {
        assert.equal((await fetch(`${origin}/v1/expenses`, { headers })).status, 401, "a forged scopes header is no way in");
      }
      // A receipt on a salary is not found through Claude (it is in the app); receipt files and the access list stay in the app.
      await db.collection("expense_receipts").insertOne({ _id: "receipt-salary", workspaceId: "workspace-a", ownerId: "user-boss", expenseId: salary.id, objectKey: "workspace-a/expense-receipts/receipt-salary", storage: "local", contentType: "image/webp", size: 1, createdAt: new Date() } as never);
      assert.equal((await call("GET", "/expenses/receipts/receipt-salary", "boss")).status, 200);
      assert.equal((await fetch(`${origin}/v1/expenses/receipts/receipt-salary`, { headers: internalHeaders("user-boss", ["expenses:read"]) })).status, 404);
      assert.equal((await fetch(`${origin}/v1/expenses/receipts/receipt-salary/file`, { headers: internalHeaders("user-boss", ["expenses:read"]) })).status, 403);
      assert.ok((await call("GET", "/expenses/settings", "boss")).body.data.access, "the app shows a manager the access list");
      assert.equal((await read(await fetch(`${origin}/v1/expenses/settings`, { headers: internalHeaders("user-boss", ["expenses:read", "expenses:write"]) }))).body.data.access, undefined, "never to Claude");

      const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => { const result = await mcpTool(origin, token, name, args, STUDIO); return result; };
      const ok = async (token: string, name: string, args: Record<string, unknown> = {}) => { const result = await tool(token, name, args); assert.equal(result.isError, false, `${name}: ${result.text}`); return result.data; };

      const options = await ok(reader, "expense_options");
      assert.equal(options.access, "manage");
      assert.deepEqual(options.categories.map((item: any) => item.id).sort(), ["ai-tools", "domain", "hosting", "subscription"], "no salary or EMI");
      assert.ok(options.chargeTo.includes("Alpha") && options.chargeTo.includes("Office"));
      assert.match(options.restricted, /never shown/);
      assert.deepEqual(options.companies.map((item: any) => item.name).sort(), ["Anthropic", "Contabo"], "a company paid only through salaries stays out");

      const october = await ok(reader, "expense_report", { month: "2026-10" });
      assert.deepEqual([october.total, october.payments, october.repeating, october.oneTime], ["₹2,700", 2, "₹1,600", "₹1,100"], JSON.stringify(october));
      assert.deepEqual(october.byWhere.map((item: any) => [item.where, item.amount]), [["Alpha", "₹1,600"], ["Office", "₹1,100"]]);
      assert.equal(october.vsMonthBefore, "+69% (₹1,600 in Sept 2026)");
      const inDollars = await ok(reader, "expense_report", { month: "2026-10", currency: "USD" });
      assert.deepEqual([inDollars.currency, inDollars.total], ["USD", "$33.75"], "the subscription exactly $20, the hosting ₹1,100 at $1 = ₹80");
      const quarter = await ok(reader, "expense_report", { month: "2026-10", months: 3 });
      assert.deepEqual(quarter.perMonth.map((item: any) => item.total), ["₹1,600", "₹1,600", "₹2,700"]);

      const listed = await ok(reader, "list_expenses", { month: "2026-10" });
      assert.deepEqual(listed.expenses.map((item: any) => [item.paidTo, item.amount]), [["Contabo", "₹1,100"], ["Anthropic", "₹1,600"]]);
      assert.equal((await ok(reader, "list_expenses", { month: "2026-10", search: "conta" })).expenses.length, 1);
      const one = await ok(reader, "list_expenses", { expenseId: claudeSub.id });
      assert.deepEqual([one.amount, one.repeats, one.chargedTo], ["$20", "monthly", "Alpha"]);
      assert.match(String((await tool(reader, "list_expenses", { expenseId: salary.id })).text), /not found/i, "a salary is never found through Claude");

      const subscriptions = await ok(reader, "list_subscriptions", { currency: "USD" });
      assert.deepEqual([subscriptions.running, subscriptions.perMonth, subscriptions.subscriptions[0].paid], [1, "$20", "$20"]);

      // Adding: two saved (one starting a group), a salary refused by name; the same requestId replays.
      const batch = { expenses: [
        { paidTo: "GoDaddy", amount: 1_499, category: "Domain", chargedTo: "Office", date: "2026-10-10", note: "buildory.dev" },
        { paidTo: "OpenAI", amount: 20, currency: "USD", category: "ai-tools", chargedTo: "Alpha", repeat: "monthly", date: "2026-10-12", group: "AI subscriptions", newGroup: true },
        { paidTo: "Ramesh", amount: 50_000, category: "Salary", chargedTo: "Office" },
      ], requestId: "add-expenses-0001" };
      const added = await ok(writer, "add_expenses", batch);
      assert.deepEqual(added.added.map((item: any) => [item.paidTo, item.amount]), [["GoDaddy", "₹1,499"], ["OpenAI", "$20"]]);
      assert.match(added.added[1].countsAs, /^₹1,600 at the 12 Oct 2026 rate; later payments at their own day's rate$/);
      assert.deepEqual(added.failed.map((item: any) => item.item), [3]);
      assert.match(added.failed[0].error, /No category "Salary"/);
      assert.equal((await ok(writer, "add_expenses", batch)).replayed, true);
      assert.equal(await db.collection("expenses").countDocuments({ paidTo: "OpenAI" }), 1);
      assert.equal((await db.collection("expense_settings").findOne({ _id: "workspace-a" as never }))?.groups.some((group: any) => group.name === "AI subscriptions"), true);

      // Changing: stop a subscription after November; a new price from December; delete only when confirmed.
      const stopped = await ok(writer, "update_expense", { expenseId: claudeSub.id, expectedUpdatedAt: one.updatedAt, lastMonth: "2026-11", requestId: "update-0001-stop" });
      assert.equal(stopped.updated.lastMonth, "2026-11");
      assert.deepEqual(stopped.changed, ["lastMonth"]);
      assert.equal((await ok(writer, "update_expense", { expenseId: claudeSub.id, expectedUpdatedAt: one.updatedAt, lastMonth: "2026-11", requestId: "update-0001-stop" })).replayed, true, "a retry replays, though the version moved on");
      assert.match(String((await tool(writer, "update_expense", { expenseId: claudeSub.id, expectedUpdatedAt: one.updatedAt, note: "x", requestId: "update-0003-stale" })).text), /changed since you read it/);
      assert.match(String((await tool(writer, "update_expense", { expenseId: hosting.id, lastMonth: "2026-12", requestId: "update-0004-once" })).text), /Only a repeating expense has a last month/);
      assert.match(String((await tool(writer, "update_expense", { expenseId: hosting.id, category: "salary", requestId: "update-0005-salary" })).text), /No category "salary"/, "never into a salary");
      assert.match(String((await tool(writer, "update_expense", { expenseId: hosting.id, paidTo: "Contabo", requestId: "update-0006-same" })).text), /Nothing to change/);
      const euro = await ok(writer, "update_expense", { expenseId: hosting.id, amount: 11, currency: "USD", requestId: "update-0002-currency" });
      assert.deepEqual([euro.updated.amount, euro.updated.countsAs], ["$11", "₹880 at the 5 Oct 2026 rate"]);
      // The bank's figure counts exactly, and goes with a new amount (it was for the old one).
      const charged = await ok(writer, "update_expense", { expenseId: hosting.id, chargedInr: 900, requestId: "update-0007-charged" });
      assert.deepEqual([charged.updated.countsAs, charged.changed], ["₹900 (what the bank charged)", ["chargedInr"]]);
      const twelve = await ok(writer, "update_expense", { expenseId: hosting.id, amount: 12, requestId: "update-0008-twelve" });
      assert.deepEqual([twelve.updated.countsAs, twelve.changed], ["₹960 at the 5 Oct 2026 rate", ["amount", "chargedInr"]]);
      const openai = (await db.collection("expenses").findOne({ paidTo: "OpenAI" }))!;
      const repriced = await ok(writer, "change_expense_price", { expenseId: String(openai._id), fromMonth: "2026-12", amount: 25, requestId: "price-0001-openai" });
      assert.deepEqual([repriced.before.lastMonth, repriced.from.amount, repriced.from.date], ["2026-11", "$25", "2026-12-12"]);
      assert.match(String((await tool(writer, "change_expense_price", { expenseId: salary.id, fromMonth: "2026-12", amount: 60_000, requestId: "price-0002-salary" })).text), /not found/i);
      // Deleting: only confirmed, and only the version the person was shown; a retry replays.
      assert.equal((await tool(writer, "delete_expense", { expenseId: hosting.id, expectedUpdatedAt: twelve.updated.updatedAt, confirm: false, requestId: "delete-0001-host" })).isError, true);
      assert.match(String((await tool(writer, "delete_expense", { expenseId: hosting.id, expectedUpdatedAt: euro.updated.updatedAt, confirm: true, requestId: "delete-0003-old" })).text), /changed since you read it \(now \$12 to Contabo\)/);
      const deleted = await ok(writer, "delete_expense", { expenseId: hosting.id, expectedUpdatedAt: twelve.updated.updatedAt, confirm: true, requestId: "delete-0002-host" });
      assert.equal(deleted.deleted, "Contabo");
      assert.equal((await ok(writer, "delete_expense", { expenseId: hosting.id, expectedUpdatedAt: twelve.updated.updatedAt, confirm: true, requestId: "delete-0002-host" })).replayed, true);
      assert.equal(await db.collection("expenses").countDocuments({ _id: hosting.id }), 0);
      assert.equal(await db.collection("audit_events").countDocuments({ action: "expense.delete", channel: "mcp" }), 1, "audited as made through Claude");

      // The access list applies: a member who only views can read through Claude but not change; someone without access sees nothing.
      assert.equal((await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "view", restricted: false })).status, 200);
      const member = await tokenFor("member", [...FULL, "expenses:read", "expenses:write"]);
      assert.deepEqual((await ok(member, "list_expenses", { month: "2026-10" })).expenses.map((item: any) => item.paidTo).sort(), ["Anthropic", "GoDaddy", "OpenAI"]);
      assert.match(String((await tool(member, "add_expenses", { expenses: [{ paidTo: "X", amount: 10, category: "hosting", chargedTo: "Office" }], requestId: "member-add-0001" })).text), /can view expenses but not change/);
      const outsider = await tokenFor("outsider", [...FULL, "expenses:read"]);
      assert.match(String((await tool(outsider, "list_expenses", {})).text), /not found/i);

      // Upcoming payments in "what's new": with the tick, not salaries'; without it, none.
      const now = new Date();
      const notice = (id: string, expenseId: string) => ({ _id: id, outboxId: id, workspaceId: "workspace-a", userId: "user-boss", type: "expense_due", title: "Payment due", body: `${id} due`, resourceType: "expense", resourceId: expenseId, reminderId: `r-${id}`, createdAt: now });
      await db.collection("notifications").insertMany([notice("due-openai", String(openai._id)), notice("due-salary", salary.id)] as never[]);
      const news = JSON.stringify((await mcpTool(origin, reader, "whats_new", {}, STUDIO)).data);
      assert.match(news, /due-openai due/);
      assert.doesNotMatch(news, /due-salary/);
      assert.doesNotMatch(JSON.stringify((await mcpTool(origin, plain, "whats_new", {}, STUDIO)).data), /Payment due/);
      // Claude's "mark all read" leaves the salary's notice alone.
      await ok(writer, "mark_notifications_read", { all: true });
      assert.equal((await db.collection("notifications").findOne({ _id: "due-salary" as never }))?.readAt, undefined);
      assert.ok((await db.collection("notifications").findOne({ _id: "due-openai" as never }))?.readAt);

      // Tags: who it was for, spelled like the tag in use, filtered and totalled by, searched, listed, and replaced.
      const tagged = await ok(writer, "add_expenses", { expenses: [
        { paidTo: "Zara", amount: 2_500, category: "subscription", chargedTo: "Office", date: "2026-10-08", tags: ["Rahul", "Clothes"] },
        { paidTo: "Bata", amount: 1_200, category: "subscription", chargedTo: "Office", date: "2026-10-09", tags: ["rahul"] },
      ], requestId: "add-expenses-tags" });
      assert.deepEqual(tagged.added.map((item: any) => item.tags), [["Rahul", "Clothes"], ["Rahul"]], "rahul joins Rahul");
      const forRahul = await ok(reader, "expense_report", { month: "2026-10", tag: "RAHUL" });
      assert.deepEqual([forRahul.total, forRahul.payments], ["₹3,700", 2]);
      assert.deepEqual((await ok(reader, "expense_report", { month: "2026-10" })).byTag.map((item: any) => [item.tag, item.amount]), [["Rahul", "₹3,700"], ["Clothes", "₹2,500"]]);
      assert.match(String((await tool(reader, "expense_report", { month: "2026-10", tag: "Nobody" })).text), /No expense has the tag "Nobody"/);
      assert.deepEqual((await ok(reader, "list_expenses", { month: "2026-10", search: "cloth" })).expenses.map((item: any) => [item.paidTo, item.tags]), [["Zara", ["Rahul", "Clothes"]]]);
      // A tag used only on a salary is never known through Claude: not listed, not totalled, not a filter.
      assert.equal((await call("PATCH", `/expenses/${salary.id}`, "boss", { tags: ["Ramesh"] })).status, 200);
      assert.deepEqual((await ok(reader, "expense_options")).tags, [{ tag: "Rahul", expenses: 2 }, { tag: "Clothes", expenses: 1 }]);
      assert.match(String((await tool(reader, "expense_report", { month: "2026-10", tag: "Ramesh" })).text), /No expense has the tag "Ramesh"/);
      assert.match(String((await tool(reader, "list_expenses", { month: "2026-10", tag: "#" })).text), /Give a tag/, "a tag that is nothing once tidied isn't ignored");
      const retagged = await ok(writer, "update_expense", { expenseId: tagged.added[1].expenseId, tags: ["Rahul", "Shoes"], requestId: "update-tags-0001" });
      assert.deepEqual([retagged.updated.tags, retagged.changed], [["Rahul", "Shoes"], ["tags"]]);
      assert.match(String((await tool(writer, "update_expense", { expenseId: tagged.added[1].expenseId, tags: ["rahul", " Shoes", "RAHUL"], requestId: "update-tags-0002" })).text), /Nothing to change/, "the same tags, however written, are no change");

      // Two ventures whose names differ only in case stay apart in a report, and charging "Alpha" asks which.
      await db.collection("ventures").updateOne({ _id: "venture-b" as never }, { $set: { name: "ALPHA" } });
      await add({ date: "2026-10-20", amountPaise: 500_00, categoryId: "hosting", paidTo: "Hetzner", scope: { kind: "venture", ventureId: "venture-b" } });
      const twins = await ok(reader, "expense_report", { month: "2026-10" });
      assert.deepEqual(twins.byWhere.map((item: any) => item.where).sort(), ["ALPHA (venture-b)", "Alpha (venture-a)", "Office"]);
      assert.match(String((await tool(writer, "add_expenses", { expenses: [{ paidTo: "X", amount: 10, category: "hosting", chargedTo: "Alpha" }], requestId: "add-expenses-twin" })).text), /More than one venture is called "Alpha": give its id instead \((venture-a, venture-b|venture-b, venture-a)\)/);
      await db.collection("ventures").updateOne({ _id: "venture-b" as never }, { $set: { name: "Beta" } });

      // Undoing a price change never reopens an expense moved into salaries since, nor says there was one.
      const copy = String((await db.collection("expenses").findOne({ continuesId: String(openai._id) }))!._id);
      assert.equal((await ok(reader, "list_expenses", { expenseId: copy })).priceChangeOf, String(openai._id));
      assert.equal((await call("PATCH", `/expenses/${openai._id}`, "boss", { categoryId: "salary" })).status, 200);
      const copyNow = await ok(reader, "list_expenses", { expenseId: copy });
      assert.equal(copyNow.priceChangeOf, undefined);
      const undone = await ok(writer, "delete_expense", { expenseId: copy, expectedUpdatedAt: copyNow.updatedAt, confirm: true, requestId: "delete-0004-copy" });
      assert.equal(undone.priceChangeUndone, undefined);
      assert.equal((await db.collection("expenses").findOne({ _id: openai._id }))?.endMonth, "2026-11", "the salary is left as it was");
    }, "mcp-expenses", { EXCHANGE_RATES_URL: `http://127.0.0.1:${(source.address() as { port: number }).port}/v1` });
  } finally { source.close(); }
});
