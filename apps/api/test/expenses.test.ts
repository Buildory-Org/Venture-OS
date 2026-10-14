import assert from "node:assert/strict";
import test from "node:test";
import { addMonths, expenseInputSchema, expenseListSchema, expenseSettingsSchema, formatRupees, monthlyEquivalentPaise, monthsBetween, nextOccurrence, occurrenceIn, successEnvelope } from "@venture-studio/contracts";
import { withSalesApp } from "./mcp-sales-harness.js";

// The expense tracker (routes/expenses.ts): months and repeats, the access list (none, view, edit, manage, and restricted categories),
// the guard that someone always keeps Manage with restricted access, input checks (no long numbers), a new amount from a month on, and
// an audit trail without amounts. Runs on a throwaway database.

const skip = !process.env.TEST_MONGODB_URI;
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const base = { date: "2026-01-31", amountPaise: 170_000, categoryId: "ai-tools", paidTo: "Anthropic", scope: { kind: "office" } } as const;

test("months and repeats: monthly on its day (the last day in a short month), yearly in its month, stopped after the last month", () => {
  const monthly = { date: "2026-01-31", repeat: "monthly" as const, endMonth: null };
  assert.deepEqual(["2025-12", "2026-01", "2026-02", "2026-04", "2027-02"].map((month) => occurrenceIn(monthly, month)), [null, "2026-01-31", "2026-02-28", "2026-04-30", "2027-02-28"]);
  assert.equal(occurrenceIn({ ...monthly, endMonth: "2026-03" }, "2026-04"), null);
  assert.equal(occurrenceIn({ ...monthly, endMonth: "2026-03" }, "2026-03"), "2026-03-31");
  const yearly = { date: "2024-02-29", repeat: "yearly" as const, endMonth: null };
  assert.deepEqual(["2024-02", "2025-01", "2025-02", "2028-02"].map((month) => occurrenceIn(yearly, month)), ["2024-02-29", null, "2025-02-28", "2028-02-29"]);
  assert.deepEqual([occurrenceIn({ date: "2026-05-04", repeat: "none", endMonth: null }, "2026-05"), occurrenceIn({ date: "2026-05-04", repeat: "none", endMonth: null }, "2026-06")], ["2026-05-04", null]);
  assert.equal(nextOccurrence(monthly, "2026-10-14"), "2026-10-31");
  assert.equal(nextOccurrence({ ...monthly, endMonth: "2026-09" }, "2026-10-14"), null);
  assert.equal(nextOccurrence({ date: "2025-11-20", repeat: "yearly", endMonth: null }, "2026-10-14"), "2026-11-20");
  assert.deepEqual([addMonths("2026-12", 1), addMonths("2026-01", -1), monthsBetween("2026-11", "2027-02").length], ["2027-01", "2025-12", 4]);
  assert.deepEqual([monthlyEquivalentPaise({ amountPaise: 120_000, repeat: "yearly" }), monthlyEquivalentPaise({ amountPaise: 999, repeat: "none" })], [10_000, 0]);
  assert.deepEqual([formatRupees(12_345_650), formatRupees(170_000)], ["₹1,23,456.50", "₹1,700"]);
  // Labels never hold account, card or phone numbers.
  for (const note of ["A/c 123456789012", "card 4111 1111 1111 1111", "call 98270-12345"]) assert.equal(expenseInputSchema.safeParse({ ...base, note }).success, false, note);
  assert.equal(expenseInputSchema.safeParse({ ...base, note: "Invoice INV-2026-10 for 3 seats" }).success, true);
  assert.equal(expenseInputSchema.safeParse({ ...base, date: "2026-02-30" }).success, false, "not a real date");
});

test("access: admins manage by default, others see nothing until a manager adds them; view reads, edit changes, manage sets categories and access", { skip }, async () => {
  await withSalesApp(async ({ api, db }) => {
    const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
    assert.deepEqual((await call("GET", "/expenses/access", "boss")).body.data, { level: "manage", restricted: true });
    assert.deepEqual((await call("GET", "/expenses/access", "member")).body.data, { level: "none", restricted: false });
    for (const [method, path] of [["GET", "/expenses"], ["GET", "/expenses/settings"], ["POST", "/expenses"]] as const) assert.equal((await call(method, path, "member", method === "POST" ? base : undefined)).status, 404, `no access: ${method} ${path} is not found`);

    const settings = successEnvelope(expenseSettingsSchema).parse((await call("GET", "/expenses/settings", "boss")).body).data;
    assert.deepEqual(settings.categories.map((category) => [category.id, category.restricted]), [["subscription", false], ["domain", false], ["ai-tools", false], ["hosting", false], ["personal-emi", true], ["salary", true]]);
    assert.deepEqual(settings.access!.find((row) => row.userId === "user-member"), { userId: "user-member", name: "Person member", role: "contributor", level: "none", restricted: false, custom: false });

    // View: reads, can't change.
    assert.equal((await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "view", restricted: false })).status, 200);
    assert.equal((await call("GET", "/expenses", "member")).status, 200);
    const refused = await call("POST", "/expenses", "member", base);
    assert.deepEqual([refused.status, refused.body.error.message], [403, "You can view expenses but not change them"]);
    // Edit: adds, edits and deletes, but doesn't manage.
    await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "edit", restricted: false });
    const created = await call("POST", "/expenses", "member", { ...base, repeat: "monthly", groupId: null });
    assert.equal(created.status, 201, created.text);
    const edited = (await call("PATCH", `/expenses/${created.body.data.id}`, "member", { amountPaise: 180_000 })).body.data;
    assert.deepEqual([edited.amountPaise, edited.repeat, edited.paidTo, edited.updatedBy], [180_000, "monthly", "Anthropic", "user-member"], "an edit changes only what it sends");
    assert.equal((await call("POST", "/expenses/settings/categories", "member", { name: "Travel" })).status, 403);
    assert.equal((await call("PUT", "/expenses/settings/access/user-learner", "member", { level: "view", restricted: false })).status, 403);

    // Restricted categories: hidden from the list, the categories, totals and every change for people without restricted access.
    const salary = await call("POST", "/expenses", "boss", { ...base, categoryId: "salary", paidTo: "Team salary", amountPaise: 5_000_000, repeat: "monthly" });
    assert.equal(salary.status, 201, salary.text);
    const memberView = successEnvelope(expenseListSchema).parse((await call("GET", "/expenses", "member")).body).data;
    assert.deepEqual([memberView.items.map((item) => item.categoryId), memberView.hiddenRestricted], [["ai-tools"], true]);
    const memberSettings = (await call("GET", "/expenses/settings", "member")).body.data;
    assert.ok(!memberSettings.categories.some((category: any) => category.restricted) && memberSettings.hiddenRestricted && memberSettings.access === undefined);
    for (const [method, body] of [["PATCH", { amountPaise: 1 }], ["DELETE", undefined]] as const) assert.equal((await call(method, `/expenses/${salary.body.data.id}`, "member", body)).status, 404);
    assert.equal((await call("POST", "/expenses", "member", { ...base, categoryId: "salary" })).status, 400, "can't add to a category they can't see");
    assert.equal((await call("PATCH", `/expenses/${created.body.data.id}`, "member", { categoryId: "personal-emi" })).status, 400);
    assert.equal((await call("GET", "/expenses", "boss")).body.data.items.length, 2);
    await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "edit", restricted: true });
    assert.equal((await call("GET", "/expenses", "member")).body.data.items.length, 2);

    // Back to none: everything is not found again.
    await call("PUT", "/expenses/settings/access/user-member", "boss", { level: "none", restricted: false });
    assert.equal((await call("GET", "/expenses", "member")).status, 404);
    assert.equal((await call("PUT", "/expenses/settings/access/user-nobody", "boss", { level: "view", restricted: false })).status, 404, "only active members");

    // The audit trail names what changed, never an amount; refusals are recorded too.
    const events = await db.collection("audit_events").find({ action: /^expense\./ }).toArray();
    assert.ok(events.some((event) => event.action === "expense.create" && event.result === "success") && events.some((event) => event.result === "denied"));
    assert.ok(events.every((event) => !JSON.stringify(event.metadata).includes("5000000") && !JSON.stringify(event.metadata).includes("170000")));
  }, "expenses_access");
});

test("someone always keeps Manage with restricted access, and only people who see restricted items can share them", { skip }, async () => {
  await withSalesApp(async ({ api }) => {
    const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
    const locked = await call("PUT", "/expenses/settings/access/user-boss", "boss", { level: "view", restricted: true });
    assert.deepEqual([locked.status, locked.body.error.message], [409, "Someone must keep Manage with restricted access: give it to another person first"]);
    assert.equal((await call("PUT", "/expenses/settings/access/user-boss", "boss", { level: "manage", restricted: false })).status, 409, "the only one who sees restricted items keeps that");
    // A manager without restricted access manages, but can't see or hand out restricted items.
    assert.equal((await call("PUT", "/expenses/settings/access/user-lead", "boss", { level: "manage", restricted: false })).status, 200);
    assert.equal((await call("PUT", "/expenses/settings/access/user-member", "lead", { level: "view", restricted: true })).status, 403);
    assert.equal((await call("PUT", "/expenses/settings/access/user-boss", "lead", { level: "view", restricted: false })).status, 403, "can't take restricted access away either");
    assert.equal((await call("POST", "/expenses/settings/categories", "lead", { name: "Bonuses", restricted: true })).status, 403);
    assert.equal((await call("PATCH", "/expenses/settings/categories/salary", "lead", { name: "Pay" })).status, 404);
    // Once someone else keeps Manage with restricted access, the admin may step down.
    assert.equal((await call("PUT", "/expenses/settings/access/user-lead", "boss", { level: "manage", restricted: true })).status, 200);
    assert.equal((await call("PUT", "/expenses/settings/access/user-boss", "boss", { level: "view", restricted: false })).status, 200);
    assert.equal((await call("GET", "/expenses/settings", "boss")).body.data.access, undefined, "a viewer no longer sees the access list");
    assert.equal((await call("PUT", "/expenses/settings/access/user-lead", "lead", { level: "edit", restricted: true })).status, 409);
  }, "expenses_keepers");
});

test("expenses: categories and groups, input checks, a new amount from a month on, and edits that crossed are refused", { skip }, async () => {
  await withSalesApp(async ({ api, db }) => {
    const call = async (method: string, path: string, handle: string, body?: unknown) => read(await api(method, path, handle, body));
    // Categories and groups: unique names, archived ones kept for old expenses but not offered for new ones.
    const travel = await call("POST", "/expenses/settings/categories", "boss", { name: "Travel", color: "amber" });
    assert.equal(travel.status, 201, travel.text);
    assert.equal((await call("POST", "/expenses/settings/categories", "boss", { name: " travel " })).status, 409);
    const group = await call("POST", "/expenses/settings/groups", "boss", { name: "AI subscriptions", color: "green" });
    assert.equal(group.status, 201, group.text);
    const claude = await call("POST", "/expenses", "boss", { ...base, groupId: group.body.data.id, repeat: "monthly", scope: { kind: "venture", ventureId: "venture-a" } });
    assert.equal(claude.status, 201, claude.text);
    const archived = (await call("PATCH", `/expenses/settings/categories/${travel.body.data.id}`, "boss", { archived: true })).body.data;
    assert.deepEqual([archived.archived, archived.color, archived.restricted], [true, "amber", false], "archiving keeps the colour");
    assert.equal((await call("PATCH", "/expenses/settings/categories/salary", "boss", { name: "Salaries" })).body.data.restricted, true, "renaming keeps it restricted");
    await call("PATCH", `/expenses/settings/groups/${group.body.data.id}`, "boss", { archived: true });
    assert.equal((await call("POST", "/expenses", "boss", { ...base, categoryId: travel.body.data.id })).status, 400, "an archived category takes no new expenses");
    assert.equal((await call("POST", "/expenses", "boss", { ...base, groupId: group.body.data.id })).status, 400, "nor an archived group");
    assert.equal((await call("PATCH", `/expenses/${claude.body.data.id}`, "boss", { paidTo: "Anthropic PBC" })).status, 200, "an expense already in the archived group can still be edited");

    // Input checks.
    for (const [body, why] of [
      [{ ...base, amountPaise: 0 }, "a zero amount"], [{ ...base, note: "IFSC HDFC0001234 a/c 50100123456789" }, "an account number"],
      [{ ...base, repeat: "none", endMonth: "2026-05" }, "a last month on a one-time expense"], [{ ...base, repeat: "monthly", endMonth: "2025-12" }, "a last month before the first"],
      [{ ...base, scope: { kind: "venture", ventureId: "venture-zzz" } }, "a venture not in the workspace"], [{ ...base, categoryId: "nope" }, "an unknown category"],
    ] as const) assert.equal((await call("POST", "/expenses", "boss", body)).status, 400, why);

    // A new amount from April: January to March keep ₹1,700, April on is ₹1,900, on the day it falls in April.
    const changed = await call("POST", `/expenses/${claude.body.data.id}/change`, "boss", { fromMonth: "2026-04", amountPaise: 190_000 });
    assert.equal(changed.status, 201, changed.text);
    assert.deepEqual([changed.body.data.stopped.endMonth, changed.body.data.continued.date, changed.body.data.continued.amountPaise, changed.body.data.continued.continuesId, changed.body.data.continued.groupId], ["2026-03", "2026-04-30", 190_000, claude.body.data.id, group.body.data.id]);
    const all = (await call("GET", "/expenses", "boss")).body.data.items as any[];
    const paidIn = (month: string) => all.reduce((sum, item) => sum + (occurrenceIn(item, month) ? item.amountPaise : 0), 0);
    assert.deepEqual(["2026-02", "2026-03", "2026-04", "2026-09"].map(paidIn), [170_000, 170_000, 190_000, 190_000]);
    assert.equal((await call("POST", `/expenses/${claude.body.data.id}/change`, "boss", { fromMonth: "2026-06", amountPaise: 1 })).status, 400, "not a month it is paid in any more");
    const once = await call("POST", "/expenses", "boss", { ...base, date: "2026-03-02" });
    assert.equal((await call("POST", `/expenses/${once.body.data.id}/change`, "boss", { fromMonth: "2026-04", amountPaise: 1 })).status, 400, "a one-time expense is edited, not changed");

    // Deleting removes it for good (the audit keeps that it happened).
    assert.equal((await call("DELETE", `/expenses/${once.body.data.id}`, "boss")).status, 200);
    assert.equal(await db.collection("expenses").countDocuments({ _id: once.body.data.id }), 0);
    assert.equal((await call("DELETE", `/expenses/${once.body.data.id}`, "boss")).status, 404);
    assert.ok(await db.collection("audit_events").findOne({ action: "expense.delete", objectId: once.body.data.id }));
  }, "expenses_records");
});
