import { randomBytes, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import type { ClientSession } from "mongodb";
import {
  addMonths, expenseAccessAtLeast, expenseAccessInputSchema, expenseCategoryInputSchema, expenseCategoryUpdateSchema, expenseChangeSchema, expenseGroupInputSchema,
  expenseGroupUpdateSchema, expenseInputSchema, expenseUpdateSchema, idSchema, monthOf, occurrenceIn,
  type ExpenseAccess, type ExpenseAccessLevel, type ExpenseCategory, type ExpenseGroup, type ExpenseInput,
} from "@venture-studio/contracts";
import { audit } from "../audit.js";
import { atomic, type AppDb, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";

// The expense tracker (docs/expenses.md). Its own access list decides who sees, adds or manages expenses: nobody but admins until a
// manager adds them, and restricted categories (salary, EMI) only for the people allowed to see them. The admins there are when the
// tracker is first opened get Manage with restricted access; admins made later get Manage only, until someone with restricted access
// lets them see it. Claude connections never reach these routes. Every change is audited without amounts.

const SETTINGS = "expense_settings";
const EXPENSES = "expenses";
const MAX_CATEGORIES = 60;
const MAX_GROUPS = 100;
const MAX_LISTED = 20_000;
const ok = (data: unknown) => ({ ok: true, data });

/** The categories a workspace starts with. Salary and Personal EMI are restricted. */
export const DEFAULT_EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { id: "subscription", name: "Subscription", color: "blue", restricted: false, archived: false },
  { id: "domain", name: "Domain", color: "purple", restricted: false, archived: false },
  { id: "ai-tools", name: "AI tools", color: "green", restricted: false, archived: false },
  { id: "hosting", name: "Hosting", color: "amber", restricted: false, archived: false },
  { id: "personal-emi", name: "Personal EMI", color: "red", restricted: true, archived: false },
  { id: "salary", name: "Salary", color: "neutral", restricted: true, archived: false },
];

type Settings = { categories: ExpenseCategory[]; groups: ExpenseGroup[]; access: Record<string, ExpenseAccess> };
type Membership = NonNullable<Request["actor"]>["membership"];

async function loadSettings(db: AppDb, workspaceId: string, session?: ClientSession): Promise<Settings> {
  const doc = await db.collection(SETTINGS).findOne({ _id: workspaceId as never }, { session });
  return {
    categories: Array.isArray(doc?.categories) ? doc.categories as ExpenseCategory[] : DEFAULT_EXPENSE_CATEGORIES,
    groups: Array.isArray(doc?.groups) ? doc.groups as ExpenseGroup[] : [],
    access: doc?.access && typeof doc.access === "object" ? doc.access as Record<string, ExpenseAccess> : {},
  };
}
/** A person's access: what a manager set for them, else admins manage (without restricted categories) and everyone else has none. */
export function accessOf(settings: Settings, userId: string, role: string): ExpenseAccess & { custom: boolean } {
  const set = settings.access[userId];
  if (set) return { level: set.level, restricted: set.restricted, custom: true };
  return role === "admin" ? { level: "manage", restricted: false, custom: false } : { level: "none", restricted: false, custom: false };
}

/**
 * The tracker's settings document, made on first use with the admins of that moment holding Manage with restricted access (so an admin
 * made later never sees salaries unless someone who does lets them). Two first uses at once: one insert wins, the other is ignored.
 */
async function ensureSettings(db: AppDb, workspaceId: string): Promise<void> {
  if (await db.collection(SETTINGS).findOne({ _id: workspaceId as never }, { projection: { _id: 1 } })) return;
  const admins = await db.collection("memberships").find({ workspaceId, status: "active", role: "admin" }).project({ userId: 1 }).toArray();
  const now = new Date();
  try {
    await db.collection(SETTINGS).insertOne({ _id: workspaceId as never, categories: DEFAULT_EXPENSE_CATEGORIES, groups: [], access: Object.fromEntries(admins.map((item) => [String(item.userId), { level: "manage", restricted: true }])), createdAt: now, updatedAt: now });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}
/**
 * When no active member keeps Manage with restricted access (they left the workspace), the admin asking takes it back, recorded in the
 * access list so the list shows what is true. Returns their access, changed or not.
 */
async function reclaimIfOrphaned(db: AppDb, workspaceId: string, settings: Settings, actor: NonNullable<Request["actor"]>): Promise<ExpenseAccess & { custom: boolean }> {
  const mine = accessOf(settings, actor.id, actor.membership.role);
  if (actor.membership.role !== "admin" || (mine.level === "manage" && mine.restricted) || (await keepersOf(db, workspaceId, settings)).keepers.length) return mine;
  await db.collection(SETTINGS).updateOne({ _id: workspaceId as never }, { $set: { [`access.${actor.id}`]: { level: "manage", restricted: true }, updatedAt: new Date() } });
  await audit(db, { workspaceId, actorId: actor.id, channel: "api", action: "expense.access.reclaim", objectType: "expense_access", objectId: actor.id, result: "success" });
  settings.access = { ...settings.access, [actor.id]: { level: "manage", restricted: true } };
  return { level: "manage", restricted: true, custom: true };
}

/** The active members who keep Manage with restricted access. */
async function keepersOf(db: AppDb, workspaceId: string, settings: Settings, session?: ClientSession) {
  const memberships = await db.collection("memberships").find({ workspaceId, status: "active" }, { session }).project({ userId: 1, role: 1 }).toArray();
  return { memberships, keepers: memberships.filter((item) => { const resolved = accessOf(settings, String(item.userId), String(item.role)); return resolved.level === "manage" && resolved.restricted; }) };
}
const restrictedIds = (settings: Settings) => settings.categories.filter((category) => category.restricted).map((category) => category.id);
const shortId = () => randomBytes(5).toString("hex");
const scopeKeyOf = (scope: unknown) => { const value = scope as { kind?: string; ventureId?: string } | null; return value?.kind === "venture" ? `venture:${value.ventureId}` : String(value?.kind ?? ""); };
const visibleCategories = (settings: Settings, me: ExpenseAccess) => settings.categories.filter((category) => me.restricted || !category.restricted);
/** Refuses an edit made from an older copy of the expense than the one saved now. */
function sameVersion(current: AppDocument, expected: string | undefined) {
  if (expected && (!(current.updatedAt instanceof Date) || current.updatedAt.toISOString() !== new Date(expected).toISOString())) throw new AppError(409, "CONFLICT", "Someone changed this expense meanwhile: reload it and try again");
}
const json = (doc: AppDocument) => { const { startMonth: _startMonth, ...rest } = doc; return jsonValue(rest); };

export function expenseRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  /** The signed-in person, their settings and access; refused below `needed` (as not found when they have no access at all). */
  async function gate(req: Request, needed: ExpenseAccessLevel, session?: ClientSession) {
    if (req.interfaceChannel !== "api") throw new AppError(403, "FORBIDDEN", "Expenses are not available to Claude connections");
    const actor = req.actor!;
    const workspaceId = actor.membership.workspaceId;
    await ensureSettings(db, workspaceId);
    const settings = await loadSettings(db, workspaceId, session);
    // Nobody left who keeps Manage with restricted access (they left the workspace): an admin takes it back, so it is never locked.
    const me = await reclaimIfOrphaned(db, workspaceId, settings, actor);
    if (!expenseAccessAtLeast(me.level, needed)) {
      await audit(db, { workspaceId, actorId: actor.id, channel: "api", action: `expense.${needed}`, objectType: "expense", result: "denied" });
      if (me.level === "none") throw new AppError(404, "NOT_FOUND", "Not found");
      throw new AppError(403, "FORBIDDEN", needed === "manage" ? "Only people who manage expenses can change categories, groups and access" : "You can view expenses but not change them");
    }
    const record = (action: string, objectType: string, objectId: string, metadata?: Record<string, string | number | boolean | null>, s?: ClientSession) =>
      audit(db, { workspaceId, actorId: actor.id, channel: "api", action, objectType, objectId, result: "success", ...(metadata ? { metadata } : {}) }, s);
    return { actor, workspaceId, settings, me, record };
  }

  /** An expense the person may see (one in a restricted category only with restricted access), or not found. */
  async function visibleExpense(workspaceId: string, id: string, settings: Settings, me: ExpenseAccess, session?: ClientSession) {
    const doc = await db.collection(EXPENSES).findOne({ _id: id as never, workspaceId }, { session });
    if (!doc || (!me.restricted && restrictedIds(settings).includes(String(doc.categoryId)))) throw new AppError(404, "NOT_FOUND", "Expense not found");
    return doc;
  }

  /** Checks an expense's category, group, venture and end month against the settings and what the person may see. Kept values (an archived category, a deleted venture) pass. */
  async function checkInput(workspaceId: string, input: ExpenseInput, settings: Settings, me: ExpenseAccess, unchanged: { categoryId?: string; groupId?: string | null; scope?: string } = {}) {
    const category = settings.categories.find((item) => item.id === input.categoryId);
    if (!category || (!me.restricted && category.restricted)) throw new AppError(400, "BAD_REQUEST", "Pick one of the categories");
    if (category.archived && input.categoryId !== unchanged.categoryId) throw new AppError(400, "BAD_REQUEST", `The category ${category.name} is archived`);
    if (input.groupId) {
      const group = settings.groups.find((item) => item.id === input.groupId);
      if (!group) throw new AppError(400, "BAD_REQUEST", "Pick one of the groups");
      if (group.archived && input.groupId !== unchanged.groupId) throw new AppError(400, "BAD_REQUEST", `The group ${group.name} is archived`);
    }
    if (input.scope.kind === "venture" && unchanged.scope !== `venture:${input.scope.ventureId}` && !await db.collection("ventures").findOne({ _id: input.scope.ventureId as never, workspaceId }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "That venture is not in this workspace");
    if (input.repeat === "none" && input.endMonth) throw new AppError(400, "BAD_REQUEST", "Only a repeating expense has a last month");
    if (input.endMonth && input.endMonth < monthOf(input.date)) throw new AppError(400, "BAD_REQUEST", "The last month can't be before the first payment");
  }

  // My access, for the sidebar: anyone signed in may ask; it never says more than their own level.
  router.get("/expenses/access", async (req, res) => {
    if (req.interfaceChannel !== "api") throw new AppError(403, "FORBIDDEN", "Expenses are not available to Claude connections");
    const actor = req.actor!;
    await ensureSettings(db, actor.membership.workspaceId);
    const { level, restricted } = await reclaimIfOrphaned(db, actor.membership.workspaceId, await loadSettings(db, actor.membership.workspaceId), actor);
    res.json(ok({ level, restricted }));
  });

  router.get("/expenses/settings", async (req, res) => {
    const { workspaceId, settings, me } = await gate(req, "view");
    const hidden = !me.restricted && restrictedIds(settings).length > 0;
    let access: unknown;
    if (me.level === "manage") {
      const memberships = await db.collection("memberships").find({ workspaceId, status: "active" }).project({ userId: 1, role: 1 }).toArray();
      const users = new Map((await db.collection("users").find({ _id: { $in: memberships.map((item) => item.userId) as never[] } }).project({ name: 1 }).toArray()).map((user) => [String(user._id), String(user.name ?? "")]));
      access = memberships.map((item) => ({ userId: String(item.userId), name: users.get(String(item.userId)) || "Unnamed member", role: String(item.role), ...accessOf(settings, String(item.userId), String(item.role)) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json(ok({
      me: { level: me.level, restricted: me.restricted }, hiddenRestricted: hidden,
      categories: settings.categories.filter((category) => me.restricted || !category.restricted), groups: settings.groups, ...(access ? { access } : {}),
    }));
  });

  // ---- Expenses ----------------------------------------------------------------------------------------------------------------

  // Every expense the person may see (restricted categories left out without restricted access), newest first. The screens work out
  // months, totals and repeats from these (occurrenceIn in the contracts), so every total follows the same rule.
  router.get("/expenses", async (req, res) => {
    const { workspaceId, settings, me } = await gate(req, "view");
    const hide = me.restricted ? [] : restrictedIds(settings);
    const items = await db.collection(EXPENSES).find({ workspaceId, ...(hide.length ? { categoryId: { $nin: hide } } : {}) }).sort({ date: -1, _id: 1 }).limit(MAX_LISTED + 1).toArray();
    res.json(ok({ items: items.slice(0, MAX_LISTED).map(json), hiddenRestricted: hide.length > 0, truncated: items.length > MAX_LISTED }));
  });

  router.post("/expenses", async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "edit");
    const input = expenseInputSchema.parse(req.body ?? {});
    await checkInput(workspaceId, input, settings, me);
    const now = new Date();
    const doc = { _id: randomUUID(), workspaceId, ...input, startMonth: monthOf(input.date), createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      await db.collection(EXPENSES).insertOne(doc as never, { session });
      await record("expense.create", "expense", doc._id, { categoryId: input.categoryId, repeat: input.repeat }, session);
    });
    res.status(201).json(ok(json(doc)));
  });

  router.patch("/expenses/:id", async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "edit");
    const id = idSchema.parse(req.params.id);
    const { expectedUpdatedAt, ...change } = expenseUpdateSchema.parse(req.body ?? {});
    const current = await visibleExpense(workspaceId, id, settings, me);
    sameVersion(current, expectedUpdatedAt);
    const merged = expenseInputSchema.parse({ date: current.date, amountPaise: current.amountPaise, categoryId: current.categoryId, groupId: current.groupId ?? null, paidTo: current.paidTo, scope: current.scope, repeat: current.repeat, endMonth: current.endMonth ?? null, note: current.note ?? "", ...change });
    if (merged.repeat === "none") merged.endMonth = null;
    await checkInput(workspaceId, merged, settings, me, { categoryId: String(current.categoryId), groupId: (current.groupId as string | null) ?? null, scope: scopeKeyOf(current.scope) });
    const now = new Date();
    await atomic(database, async (session) => {
      // A new date sets a new repeat day, so the copy's kept day goes.
      const changed = await db.collection(EXPENSES).updateOne({ _id: id as never, workspaceId, updatedAt: current.updatedAt }, { $set: { ...merged, startMonth: monthOf(merged.date), updatedBy: actor.id, updatedAt: now }, ...(change.date !== undefined && change.date !== current.date ? { $unset: { anchorDay: "" } } : {}) }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Someone changed this expense meanwhile: reload it and try again");
      await record("expense.update", "expense", id, { fields: Object.keys(change).sort().join(",") }, session);
    });
    res.json(ok(json((await db.collection(EXPENSES).findOne({ _id: id as never }))!)));
  });

  // Deleting removes an expense for good. Deleting the copy a price change made undoes the change: the expense it continued carries on
  // as before (its last month goes back to the copy's).
  router.delete("/expenses/:id", async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "edit");
    const id = idSchema.parse(req.params.id);
    const expected = typeof req.query.expectedUpdatedAt === "string" ? req.query.expectedUpdatedAt : undefined;
    const current = await visibleExpense(workspaceId, id, settings, me);
    sameVersion(current, expected);
    let reopened: string | undefined;
    await atomic(database, async (session) => {
      const removed = await db.collection(EXPENSES).deleteOne({ _id: id as never, workspaceId, updatedAt: current.updatedAt }, { session });
      if (!removed.deletedCount) throw new AppError(409, "CONFLICT", "Someone changed this expense meanwhile: reload it and try again");
      if (typeof current.continuesId === "string") {
        const before = await db.collection(EXPENSES).updateOne({ _id: current.continuesId as never, workspaceId, endMonth: addMonths(monthOf(String(current.date)), -1) }, { $set: { endMonth: current.endMonth ?? null, updatedBy: actor.id, updatedAt: new Date() } }, { session });
        if (before.modifiedCount) reopened = current.continuesId;
      }
      await record("expense.delete", "expense", id, { categoryId: String(current.categoryId), repeat: String(current.repeat), ...(reopened ? { reopened } : {}) }, session);
    });
    res.json(ok({ id, deleted: true, ...(reopened ? { reopened } : {}) }));
  });

  // A new amount from a month on: the expense stops the month before, and a copy with the new amount starts that month (on the day it
  // would have been paid), so every earlier month keeps what was actually paid.
  router.post("/expenses/:id/change", async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "edit");
    const id = idSchema.parse(req.params.id);
    const { expectedUpdatedAt, ...input } = expenseChangeSchema.parse(req.body ?? {});
    const current = await visibleExpense(workspaceId, id, settings, me);
    sameVersion(current, expectedUpdatedAt);
    if (current.repeat === "none") throw new AppError(400, "BAD_REQUEST", "Only a repeating expense changes from a month on: edit this one instead");
    // The copy repeats on the same day of the month as the expense (the 31st stays the 31st after a 30-day month).
    const anchorDay = typeof current.anchorDay === "number" ? current.anchorDay : Number(String(current.date).slice(8, 10));
    const day = occurrenceIn({ date: String(current.date), repeat: current.repeat as "monthly" | "yearly", endMonth: (current.endMonth as string | null) ?? null, anchorDay }, input.fromMonth);
    if (!day) throw new AppError(400, "BAD_REQUEST", "Pick a month this expense is paid in");
    if (input.fromMonth <= monthOf(String(current.date))) throw new AppError(400, "BAD_REQUEST", "That is its first month: edit the expense instead");
    const now = new Date();
    const next = { ...Object.fromEntries(Object.entries(current).filter(([key]) => !["_id", "createdAt", "createdBy", "continuesId", "anchorDay"].includes(key))), _id: randomUUID(), date: day, startMonth: input.fromMonth, amountPaise: input.amountPaise,
      ...(Number(day.slice(8, 10)) !== anchorDay ? { anchorDay } : {}),
      ...(input.paidTo !== undefined ? { paidTo: input.paidTo } : {}), ...(input.note !== undefined ? { note: input.note } : {}), continuesId: id, createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      const stopped = await db.collection(EXPENSES).updateOne({ _id: id as never, workspaceId, updatedAt: current.updatedAt }, { $set: { endMonth: addMonths(input.fromMonth, -1), updatedBy: actor.id, updatedAt: now } }, { session });
      if (!stopped.matchedCount) throw new AppError(409, "CONFLICT", "Someone changed this expense meanwhile: reload it and try again");
      await db.collection(EXPENSES).insertOne(next as never, { session });
      await record("expense.change", "expense", id, { fromMonth: input.fromMonth, continuedBy: next._id }, session);
    });
    res.status(201).json(ok({ stopped: json((await db.collection(EXPENSES).findOne({ _id: id as never }))!), continued: json(next as AppDocument) }));
  });

  // ---- Categories, groups and access (managers) --------------------------------------------------------------------------------

  /** Writes the settings document whole (created from the defaults on the first change), inside the caller's transaction. */
  const saveSettings = (workspaceId: string, settings: Settings, session?: ClientSession) =>
    db.collection(SETTINGS).updateOne({ _id: workspaceId as never }, { $set: { categories: settings.categories, groups: settings.groups, access: settings.access, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true, session });
  const sameName = (list: { id: string; name: string }[], name: string, except?: string) => list.some((item) => item.id !== except && item.name.trim().toLowerCase() === name.trim().toLowerCase());

  router.post("/expenses/settings/categories", async (req, res) => {
    const input = expenseCategoryInputSchema.parse(req.body ?? {});
    const created = await atomic(database, async (session) => {
      const { workspaceId, settings, me, record } = await gate(req, "manage", session);
      if (input.restricted && !me.restricted) throw new AppError(403, "FORBIDDEN", "Only people who see restricted categories can make one");
      if (sameName(settings.categories, input.name)) throw new AppError(409, "CONFLICT", sameName(visibleCategories(settings, me), input.name) ? `There is already a category called ${input.name}` : "That name can't be used: pick another");
      if (settings.categories.length >= MAX_CATEGORIES) throw new AppError(409, "CONFLICT", `At most ${MAX_CATEGORIES} categories: archive one you no longer use`);
      const category: ExpenseCategory = { id: shortId(), ...input, archived: false };
      await saveSettings(workspaceId, { ...settings, categories: [...settings.categories, category] }, session);
      await record("expense.category.create", "expense_category", category.id, { restricted: category.restricted }, session);
      return category;
    });
    res.status(201).json(ok(created));
  });

  router.patch("/expenses/settings/categories/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const change = expenseCategoryUpdateSchema.parse(req.body ?? {});
    const updated = await atomic(database, async (session) => {
      const { workspaceId, settings, me, record } = await gate(req, "manage", session);
      const current = settings.categories.find((item) => item.id === id);
      if (!current || (current.restricted && !me.restricted)) throw new AppError(404, "NOT_FOUND", "Category not found");
      if (change.restricted !== undefined && change.restricted !== current.restricted && !me.restricted) throw new AppError(403, "FORBIDDEN", "Only people who see restricted categories can change that");
      if (change.name && sameName(settings.categories, change.name, id)) throw new AppError(409, "CONFLICT", sameName(visibleCategories(settings, me), change.name, id) ? `There is already a category called ${change.name}` : "That name can't be used: pick another");
      const category = { ...current, ...change };
      await saveSettings(workspaceId, { ...settings, categories: settings.categories.map((item) => item.id === id ? category : item) }, session);
      await record("expense.category.update", "expense_category", id, { fields: Object.keys(change).sort().join(",") }, session);
      return category;
    });
    res.json(ok(updated));
  });

  // Anyone who adds expenses may start a group while adding one (renaming and archiving stay with managers).
  router.post("/expenses/settings/groups", async (req, res) => {
    const input = expenseGroupInputSchema.parse(req.body ?? {});
    const created = await atomic(database, async (session) => {
      const { workspaceId, settings, record } = await gate(req, "edit", session);
      if (sameName(settings.groups, input.name)) throw new AppError(409, "CONFLICT", `There is already a group called ${input.name}`);
      if (settings.groups.length >= MAX_GROUPS) throw new AppError(409, "CONFLICT", `At most ${MAX_GROUPS} groups: archive one you no longer use`);
      const group: ExpenseGroup = { id: shortId(), ...input, archived: false };
      await saveSettings(workspaceId, { ...settings, groups: [...settings.groups, group] }, session);
      await record("expense.group.create", "expense_group", group.id, undefined, session);
      return group;
    });
    res.status(201).json(ok(created));
  });

  router.patch("/expenses/settings/groups/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const change = expenseGroupUpdateSchema.parse(req.body ?? {});
    const updated = await atomic(database, async (session) => {
      const { workspaceId, settings, record } = await gate(req, "manage", session);
      const current = settings.groups.find((item) => item.id === id);
      if (!current) throw new AppError(404, "NOT_FOUND", "Group not found");
      if (change.name && sameName(settings.groups, change.name, id)) throw new AppError(409, "CONFLICT", `There is already a group called ${change.name}`);
      const group = { ...current, ...change };
      await saveSettings(workspaceId, { ...settings, groups: settings.groups.map((item) => item.id === id ? group : item) }, session);
      await record("expense.group.update", "expense_group", id, { fields: Object.keys(change).sort().join(",") }, session);
      return group;
    });
    res.json(ok(updated));
  });

  // One person's access. Someone must always keep Manage with restricted access, so the tracker can't be locked or its salaries lost.
  router.put("/expenses/settings/access/:userId", async (req, res) => {
    const userId = idSchema.parse(req.params.userId);
    const input = expenseAccessInputSchema.parse(req.body ?? {});
    const result = await atomic(database, async (session) => {
      const { workspaceId, settings, me, record } = await gate(req, "manage", session);
      const member = await db.collection("memberships").findOne({ workspaceId, userId, status: "active" }, { projection: { role: 1 }, session });
      if (!member) throw new AppError(404, "NOT_FOUND", "That person is not an active member");
      if (input.restricted && !me.restricted) throw new AppError(403, "FORBIDDEN", "Only people who see restricted categories can let others see them");
      const before = accessOf(settings, userId, String(member.role));
      if (!me.restricted && before.restricted && !input.restricted) throw new AppError(403, "FORBIDDEN", "Only people who see restricted categories can change who sees them");
      // Entries of people no longer in the workspace go, so a returning member starts from the default.
      const { memberships } = await keepersOf(db, workspaceId, settings, session);
      const active = new Set(memberships.map((item) => String(item.userId)));
      const access = { ...Object.fromEntries(Object.entries(settings.access).filter(([key]) => active.has(key))), [userId]: { level: input.level, restricted: input.restricted } };
      if (!(await keepersOf(db, workspaceId, { ...settings, access }, session)).keepers.length) throw new AppError(409, "CONFLICT", "Someone must keep Manage with restricted access: give it to another person first");
      await saveSettings(workspaceId, { ...settings, access }, session);
      await record("expense.access.set", "expense_access", userId, { level: input.level, restricted: input.restricted }, session);
      return { userId, level: input.level, restricted: input.restricted, custom: true };
    });
    res.json(ok(result));
  });

  return router;
}
