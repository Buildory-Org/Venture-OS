import { randomBytes, randomUUID } from "node:crypto";
import express, { Router, type Request } from "express";
import type { ClientSession } from "mongodb";
import {
  addMonths, expenseAccessAtLeast, expenseAccessInputSchema, expenseCategoryInputSchema, expenseCategoryUpdateSchema, expenseChangeSchema, expenseGroupInputSchema,
  expenseGroupUpdateSchema, expenseInputSchema, expenseUpdateSchema, idSchema, MAX_RECEIPT_BYTES, monthOf, occurrenceIn,
  type ExpenseAccess, type ExpenseAccessLevel, type ExpenseCategory, type ExpenseGroup, type ExpenseInput,
} from "@venture-studio/contracts";
import { companyKey, expenseCompanyMergeSchema, expenseCompanyUpdateSchema, MAX_LOGO_BYTES, websiteHost } from "@venture-studio/contracts";
import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { atomic, type AppDb, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { COMPANIES, fetchLogoInTurn, logoFromImage, logoVersion, resolveCompany } from "../expense-companies.js";
import { prepareReceipt, readReceipt } from "../expense-receipts.js";
import { jsonValue } from "../json.js";
import { overLimit } from "../middleware.js";
import type { LocalObjectStore, ObjectStore } from "../storage.js";
import { fileStoreFor } from "./files.js";

// The expense tracker (docs/expenses.md). Its own access list decides who sees, adds or manages expenses: nobody but admins until a
// manager adds them, and restricted categories (salary, EMI) only for the people allowed to see them. The admins there are when the
// tracker is first opened get Manage with restricted access; admins made later get Manage only, until someone with restricted access
// lets them see it. Claude connections never reach these routes. Every change is audited without amounts. A receipt is uploaded (and
// read) before its expense is saved, then attached; it is seen by whoever sees its expense, and until then only by who uploaded it.
// One that ends up attached to nothing (the form was closed, or its expense deleted or given another receipt) goes after a day.

const SETTINGS = "expense_settings";
const EXPENSES = "expenses";
const RECEIPTS = "expense_receipts";
const RECEIPTS_PER_HOUR = 40;
const LOGO_FETCHES_PER_HOUR = 30;
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

export function expenseRoutes(database: Database, config: AppConfig, store: ObjectStore, localStore: LocalObjectStore): Router {
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

  /** Attaches a receipt to an expense: one the person uploaded and nothing holds yet, or the one it already has. */
  async function claimReceipt(workspaceId: string, actorId: string, receiptId: string, expenseId: string, session?: ClientSession) {
    const claimed = await db.collection(RECEIPTS).updateOne({ _id: receiptId as never, workspaceId, $or: [{ expenseId }, { expenseId: { $exists: false }, ownerId: actorId }] }, { $set: { expenseId }, $unset: { orphanedAt: "" } }, { session });
    if (!claimed.matchedCount) throw new AppError(400, "BAD_REQUEST", "That receipt can't be attached any more: add it again");
  }
  /** Lets go of a receipt: nobody sees or attaches it again (not even who uploaded it), and it is deleted a day later. */
  const releaseReceipt = (workspaceId: string, receiptId: string, session?: ClientSession) =>
    db.collection(RECEIPTS).updateOne({ _id: receiptId as never, workspaceId }, { $unset: { expenseId: "", ownerId: "" }, $set: { orphanedAt: new Date() } }, { session });
  /** A receipt the person may see: its expense's, when they see that expense; one not attached yet, only to who uploaded it. */
  async function visibleReceipt(workspaceId: string, id: string, actorId: string, settings: Settings, me: ExpenseAccess) {
    const doc = await db.collection(RECEIPTS).findOne({ _id: id as never, workspaceId });
    if (!doc) throw new AppError(404, "NOT_FOUND", "Receipt not found");
    if (typeof doc.expenseId === "string") await visibleExpense(workspaceId, doc.expenseId, settings, me).catch(() => { throw new AppError(404, "NOT_FOUND", "Receipt not found"); });
    else if (doc.ownerId !== actorId || !expenseAccessAtLeast(me.level, "edit")) throw new AppError(404, "NOT_FOUND", "Receipt not found");
    return doc;
  }
  /** A receipt for the screens. The category it suggested is left out when the person can't see that category (a restricted one). */
  const receiptJson = (doc: AppDocument, settings: Settings, me: ExpenseAccess) => {
    const data = doc.data as { categoryId?: string | null } | null | undefined;
    const suggested = data?.categoryId && visibleCategories(settings, me).some((category) => category.id === data.categoryId) ? data.categoryId : null;
    return jsonValue({ id: doc._id, contentType: doc.contentType, size: doc.size, data: data ? { ...data, categoryId: suggested } : null, ...(doc.error ? { error: doc.error } : {}), ...(doc.expenseId ? { expenseId: doc.expenseId } : {}), createdAt: doc.createdAt });
  };
  /** Deletes receipts attached to nothing for a day, a few at a time (run when receipts are added and when the list is opened). */
  async function dropOrphanReceipts(workspaceId: string) {
    const old = await db.collection(RECEIPTS).find({ workspaceId, orphanedAt: { $lt: new Date(Date.now() - 86_400_000) } }).limit(20).toArray();
    for (const doc of old) {
      // Still unattached at this moment, or it was claimed meanwhile and stays.
      if (!(await db.collection(RECEIPTS).deleteOne({ _id: doc._id, orphanedAt: doc.orphanedAt })).deletedCount) continue;
      await fileStoreFor(doc, store, localStore)?.discard(String(doc.objectKey)).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "expense_receipt_cleanup_failed", receiptId: String(doc._id), message: error instanceof Error ? error.message : String(error) })));
    }
  }
  const sweepReceipts = (workspaceId: string) => void dropOrphanReceipts(workspaceId).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "expense_receipt_cleanup_failed", message: error instanceof Error ? error.message : String(error) })));

  // ---- Companies (helpers) ------------------------------------------------------------------------------------------------------

  const hiddenFor = (settings: Settings, me: ExpenseAccess) => (me.restricted ? [] : restrictedIds(settings));
  /**
   * The companies with an expense the person can see, with how many, by name. A company paid only in restricted categories stays hidden,
   * and the spellings shown are those of the expenses the person can see (not ones only restricted expenses used).
   */
  async function companiesFor(workspaceId: string, settings: Settings, me: ExpenseAccess) {
    const hide = hiddenFor(settings, me);
    const counts = await db.collection(EXPENSES).aggregate([{ $match: { workspaceId, companyId: { $exists: true }, ...(hide.length ? { categoryId: { $nin: hide } } : {}) } }, { $group: { _id: "$companyId", expenses: { $sum: 1 }, names: { $addToSet: "$paidTo" } } }]).toArray();
    const seen = new Map(counts.map((item) => [String(item._id), { expenses: Number(item.expenses), names: item.names as string[] }]));
    const companies = await db.collection(COMPANIES).find({ workspaceId, _id: { $in: [...seen.keys()] as never[] } }).toArray();
    return companies.map((company) => {
      const visible = seen.get(String(company._id))!;
      return { id: String(company._id), name: String(company.name), website: (company.website as string | null) ?? null, gstin: (company.gstin as string | null) ?? null, logo: (company.logo as { version?: string } | undefined)?.version ?? null, keys: [...new Set([companyKey(String(company.name)), ...visible.names.map(companyKey)])], expenses: visible.expenses };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  /** A company the person can see (it has an expense they can see), or not found. */
  async function visibleCompany(workspaceId: string, id: string, settings: Settings, me: ExpenseAccess) {
    const hide = hiddenFor(settings, me);
    const company = await db.collection(COMPANIES).findOne({ _id: id as never, workspaceId });
    if (!company || !await db.collection(EXPENSES).findOne({ workspaceId, companyId: id, ...(hide.length ? { categoryId: { $nin: hide } } : {}) }, { projection: { _id: 1 } })) throw new AppError(404, "NOT_FOUND", "Company not found");
    return company;
  }
  /** The company for an expense: its "Paid to", with the GSTIN and website from its receipt (one the person may use) or the form. */
  async function companyFor(workspaceId: string, actorId: string, paidTo: string, receiptId: string | null, website: string | undefined, expenseId?: string) {
    const receipt = receiptId ? await db.collection(RECEIPTS).findOne({ _id: receiptId as never, workspaceId, $or: [{ ownerId: actorId }, ...(expenseId ? [{ expenseId }] : [])] }) : null;
    const data = receipt?.data as { merchantTaxId?: string | null; website?: string | null } | null | undefined;
    return resolveCompany(db, workspaceId, paidTo, { gstin: data?.merchantTaxId, website: website || data?.website }, actorId);
  }
  /** Stores a logo (a 128 px WebP) as the company's, dropping the one it replaces; the new version, or null when it wasn't kept (the company is gone, or a website logo met an upload). */
  async function saveLogo(workspaceId: string, companyId: string, bytes: Buffer, source: "website" | "upload") {
    const version = logoVersion();
    const objectKey = `${workspaceId}/expense-companies/${companyId}/${version}.webp`;
    await store.put(objectKey, bytes, "image/webp");
    // A logo from the website never replaces an uploaded one (an upload can land while the website is still being read).
    const before = await db.collection(COMPANIES).findOneAndUpdate({ _id: companyId as never, workspaceId, ...(source === "website" ? { "logo.source": { $ne: "upload" } } : {}) }, { $set: { logo: { objectKey, storage: store.kind, version, source } } }, { returnDocument: "before" });
    const dropped = (before ? before.logo : { objectKey, storage: store.kind }) as AppDocument | undefined;
    if (dropped?.objectKey) await fileStoreFor(dropped, store, localStore)?.discard(String(dropped.objectKey)).catch(() => undefined);
    return before ? version : null;
  }
  /** Fetches the logo the company's website names, unless someone uploaded one (in the background; a few an hour per person). */
  async function logoFromWebsite(companyId: string, actorId: string) {
    if (config.COMPANY_LOGO_FETCH === "off" || await overLimit(db, `company-logo-fetch:${actorId}`, LOGO_FETCHES_PER_HOUR, 3_600_000)) return;
    const company = await db.collection(COMPANIES).findOne({ _id: companyId as never });
    if (!company?.website || (company.logo as { source?: string } | undefined)?.source === "upload") return;
    const bytes = await fetchLogoInTurn(String(company.website), { userAgent: `VentureStudioOS-logo/1.0 (+${config.APP_ORIGIN})` });
    await db.collection(COMPANIES).updateOne({ _id: companyId as never }, { $set: { logoCheckedAt: new Date() } });
    if (bytes) await saveLogo(String(company.workspaceId), companyId, bytes, "website");
  }
  /** Refuses a write to a company merged into another a moment ago (the person saves again and it goes to the one it was merged into). */
  async function companyStill(workspaceId: string, companyId: string, session?: ClientSession) {
    if (!await db.collection(COMPANIES).findOne({ _id: companyId as never, workspaceId }, { session, projection: { _id: 1 } })) throw new AppError(409, "CONFLICT", "That company was just merged into another: save again");
  }
  const fetchLogoLater = (companyId: string, actorId: string) => void logoFromWebsite(companyId, actorId).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "expense_company_logo_failed", companyId, message: error instanceof Error ? error.message : String(error) })));

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
      companies: await companiesFor(workspaceId, settings, me),
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
    sweepReceipts(workspaceId);
  });

  router.post("/expenses", async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "edit");
    const { companyWebsite, ...input } = expenseInputSchema.parse(req.body ?? {});
    await checkInput(workspaceId, input, settings, me);
    const now = new Date();
    const company = await companyFor(workspaceId, actor.id, input.paidTo, input.receiptId, companyWebsite);
    const doc = { _id: randomUUID(), workspaceId, ...input, companyId: company.id, startMonth: monthOf(input.date), createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      if (input.receiptId) await claimReceipt(workspaceId, actor.id, input.receiptId, doc._id, session);
      await companyStill(workspaceId, company.id, session);
      await db.collection(EXPENSES).insertOne(doc as never, { session });
      await record("expense.create", "expense", doc._id, { categoryId: input.categoryId, repeat: input.repeat, receipt: Boolean(input.receiptId) }, session);
    });
    if (company.websiteAdded) fetchLogoLater(company.id, actor.id);
    res.status(201).json(ok(json(doc)));
  });

  router.patch("/expenses/:id", async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "edit");
    const id = idSchema.parse(req.params.id);
    const { expectedUpdatedAt, companyWebsite, ...change } = expenseUpdateSchema.parse(req.body ?? {});
    const current = await visibleExpense(workspaceId, id, settings, me);
    sameVersion(current, expectedUpdatedAt);
    const merged = expenseInputSchema.parse({ date: current.date, amountPaise: current.amountPaise, categoryId: current.categoryId, groupId: current.groupId ?? null, paidTo: current.paidTo, scope: current.scope, repeat: current.repeat, endMonth: current.endMonth ?? null, note: current.note ?? "", receiptId: current.receiptId ?? null, ...change });
    if (merged.repeat === "none") merged.endMonth = null;
    await checkInput(workspaceId, merged, settings, me, { categoryId: String(current.categoryId), groupId: (current.groupId as string | null) ?? null, scope: scopeKeyOf(current.scope) });
    const now = new Date();
    // A new name, receipt or website may mean another company.
    const company = change.paidTo !== undefined || change.receiptId !== undefined || companyWebsite ? await companyFor(workspaceId, actor.id, merged.paidTo, merged.receiptId, companyWebsite, id) : null;
    await atomic(database, async (session) => {
      if (company) await companyStill(workspaceId, company.id, session);
      // A new date sets a new repeat day, so the copy's kept day goes.
      const changed = await db.collection(EXPENSES).updateOne({ _id: id as never, workspaceId, updatedAt: current.updatedAt }, { $set: { ...merged, ...(company ? { companyId: company.id } : {}), startMonth: monthOf(merged.date), updatedBy: actor.id, updatedAt: now }, ...(change.date !== undefined && change.date !== current.date ? { $unset: { anchorDay: "" } } : {}) }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Someone changed this expense meanwhile: reload it and try again");
      if (merged.receiptId !== (current.receiptId ?? null)) {
        if (typeof current.receiptId === "string") await releaseReceipt(workspaceId, current.receiptId, session);
        if (merged.receiptId) await claimReceipt(workspaceId, actor.id, merged.receiptId, id, session);
      }
      await record("expense.update", "expense", id, { fields: Object.keys(change).sort().join(",") }, session);
    });
    if (company?.websiteAdded) fetchLogoLater(company.id, actor.id);
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
      if (typeof current.receiptId === "string") await releaseReceipt(workspaceId, current.receiptId, session);
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
    // A new name from then on may be another company.
    const company = input.paidTo !== undefined && input.paidTo !== current.paidTo ? await companyFor(workspaceId, actor.id, input.paidTo, null, undefined) : null;
    const next = { ...Object.fromEntries(Object.entries(current).filter(([key]) => !["_id", "createdAt", "createdBy", "continuesId", "anchorDay", "receiptId"].includes(key))), _id: randomUUID(), date: day, startMonth: input.fromMonth, amountPaise: input.amountPaise,
      ...(Number(day.slice(8, 10)) !== anchorDay ? { anchorDay } : {}),
      ...(input.paidTo !== undefined ? { paidTo: input.paidTo } : {}), ...(company ? { companyId: company.id } : {}), ...(input.note !== undefined ? { note: input.note } : {}), continuesId: id, createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      const stopped = await db.collection(EXPENSES).updateOne({ _id: id as never, workspaceId, updatedAt: current.updatedAt }, { $set: { endMonth: addMonths(input.fromMonth, -1), updatedBy: actor.id, updatedAt: now } }, { session });
      if (!stopped.matchedCount) throw new AppError(409, "CONFLICT", "Someone changed this expense meanwhile: reload it and try again");
      if (company) await companyStill(workspaceId, company.id, session);
      await db.collection(EXPENSES).insertOne(next as never, { session });
      await record("expense.change", "expense", id, { fromMonth: input.fromMonth, continuedBy: next._id }, session);
    });
    res.status(201).json(ok({ stopped: json((await db.collection(EXPENSES).findOne({ _id: id as never }))!), continued: json(next as AppDocument) }));
  });

  // ---- Receipts ------------------------------------------------------------------------------------------------------------------

  // A photo or PDF of a receipt, sent as the request body: kept as a small copy and read with Claude Haiku (when a key is set), so the
  // form can fill itself in. Kept even when it can't be read. Anyone who adds expenses may upload, up to RECEIPTS_PER_HOUR an hour.
  // Only image and PDF bodies are read, so a plain cross-site form can't post one (those types need the browser's CORS check first).
  router.post("/expenses/receipts", express.raw({ type: ["image/*", "application/pdf", "application/octet-stream"], limit: MAX_RECEIPT_BYTES }), async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "edit");
    const wait = await overLimit(db, `expense-receipts:${actor.id}`, RECEIPTS_PER_HOUR, 3_600_000);
    if (wait) { res.setHeader("retry-after", wait); throw new AppError(429, "RATE_LIMITED", "That's a lot of receipts for one hour: type the details in, or try again later"); }
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(400, "BAD_REQUEST", "Attach a photo or PDF of the receipt");
    const file = await prepareReceipt(req.body);
    // Recorded (as attached to nothing) before the copy is stored, so a failure at any later step still leaves it for the clean-up.
    const id = randomUUID();
    const objectKey = `${workspaceId}/expense-receipts/${id}`;
    const now = new Date();
    await db.collection(RECEIPTS).insertOne({ _id: id, workspaceId, ownerId: actor.id, objectKey, storage: store.kind, contentType: file.contentType, size: file.bytes.length, orphanedAt: now, createdAt: now } as never);
    await store.put(objectKey, file.bytes, file.contentType);
    // A read the person no longer waits for (they closed the page) is stopped.
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(); });
    const read = await readReceipt(config.ANTHROPIC_API_KEY, file, visibleCategories(settings, me).filter((category) => !category.archived), gone.signal);
    const doc = await db.collection(RECEIPTS).findOneAndUpdate({ _id: id as never }, { $set: read }, { returnDocument: "after" });
    await record("expense.receipt.upload", "expense_receipt", id, { contentType: file.contentType, read: "data" in read });
    res.status(201).json(ok(receiptJson(doc!, settings, me)));
    sweepReceipts(workspaceId);
  });

  router.get("/expenses/receipts/:id", async (req, res) => {
    const { actor, workspaceId, settings, me } = await gate(req, "view");
    res.json(ok(receiptJson(await visibleReceipt(workspaceId, idSchema.parse(req.params.id), actor.id, settings, me), settings, me)));
  });

  // The kept copy itself (a WebP or the PDF), sent by the API so it never needs a public link.
  router.get("/expenses/receipts/:id/file", async (req, res) => {
    const { actor, workspaceId, settings, me } = await gate(req, "view");
    const doc = await visibleReceipt(workspaceId, idSchema.parse(req.params.id), actor.id, settings, me);
    const fileStore = fileStoreFor(doc, store, localStore);
    if (!fileStore) throw new AppError(503, "INTEGRATION_UNAVAILABLE", "The receipt's storage is not configured here");
    const bytes = await fileStore.read(String(doc.objectKey), MAX_RECEIPT_BYTES);
    res.set({ "Content-Type": String(doc.contentType), "Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", "Content-Disposition": `inline; filename="receipt.${doc.contentType === "application/pdf" ? "pdf" : "webp"}"` });
    res.send(bytes);
  });

  // ---- Companies ---------------------------------------------------------------------------------------------------------------

  // A company's logo, sent by the API (no public link); its URL carries the version, so it may be kept a day.
  router.get("/expenses/companies/:id/logo", async (req, res) => {
    const { workspaceId, settings, me } = await gate(req, "view");
    const company = await visibleCompany(workspaceId, idSchema.parse(req.params.id), settings, me);
    const logo = company.logo as AppDocument | undefined;
    const fileStore = logo ? fileStoreFor(logo, store, localStore) : undefined;
    if (!logo || !fileStore) throw new AppError(404, "NOT_FOUND", "This company has no logo");
    const bytes = await fileStore.read(String(logo.objectKey), MAX_LOGO_BYTES);
    res.set({ "Content-Type": "image/webp", "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" });
    res.send(bytes);
  });

  // An uploaded logo, kept as a 128 px WebP. Anyone who adds expenses may give a company its first logo (from the expense form);
  // changing one is for managers.
  router.post("/expenses/companies/:id/logo", express.raw({ type: ["image/*", "application/octet-stream"], limit: MAX_LOGO_BYTES }), async (req, res) => {
    const { workspaceId, settings, me, record } = await gate(req, "edit");
    const company = await visibleCompany(workspaceId, idSchema.parse(req.params.id), settings, me);
    if (company.logo && me.level !== "manage") throw new AppError(403, "FORBIDDEN", "Only people who manage expenses can change a company's logo");
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(400, "BAD_REQUEST", "Attach an image for the logo");
    const logo = await logoFromImage(req.body);
    if (!logo) throw new AppError(415, "BAD_REQUEST", "Use a PNG, JPG or WebP image for the logo");
    const version = await saveLogo(workspaceId, String(company._id), logo, "upload");
    await record("expense.company.logo", "expense_company", String(company._id), { source: "upload" });
    res.json(ok({ logo: version }));
  });

  router.delete("/expenses/companies/:id/logo", async (req, res) => {
    const { workspaceId, settings, me, record } = await gate(req, "manage");
    const company = await visibleCompany(workspaceId, idSchema.parse(req.params.id), settings, me);
    const before = await db.collection(COMPANIES).findOneAndUpdate({ _id: company._id, workspaceId }, { $unset: { logo: "" } }, { returnDocument: "before" });
    const dropped = before?.logo as AppDocument | undefined;
    if (dropped?.objectKey) await fileStoreFor(dropped, store, localStore)?.discard(String(dropped.objectKey)).catch(() => undefined);
    await record("expense.company.logo_remove", "expense_company", String(company._id));
    res.json(ok({ logo: null }));
  });

  // Rename (the new name is matched to it from then on) or set the website (its logo is fetched, unless one was uploaded).
  router.patch("/expenses/companies/:id", async (req, res) => {
    const { actor, workspaceId, settings, me, record } = await gate(req, "manage");
    const change = expenseCompanyUpdateSchema.parse(req.body ?? {});
    const company = await visibleCompany(workspaceId, idSchema.parse(req.params.id), settings, me);
    const set: Record<string, unknown> = {};
    let key: string | null = null;
    if (change.name !== undefined) {
      key = companyKey(change.name);
      const other = await db.collection(COMPANIES).findOne({ workspaceId, keys: key, _id: { $ne: company._id } });
      if (other) {
        const hide = hiddenFor(settings, me);
        const shown = await db.collection(EXPENSES).findOne({ workspaceId, companyId: String(other._id), ...(hide.length ? { categoryId: { $nin: hide } } : {}) }, { projection: { _id: 1 } });
        throw new AppError(409, "CONFLICT", shown ? `There is already a company called ${String(other.name)}: merge them instead` : "That name can't be used: pick another");
      }
      set.name = change.name;
    }
    if (change.website !== undefined) {
      const host = change.website ? websiteHost(change.website) : null;
      if (change.website && !host) throw new AppError(400, "BAD_REQUEST", "Enter a website like godaddy.com");
      set.website = host;
    }
    await db.collection(COMPANIES).updateOne({ _id: company._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(key ? { $addToSet: { keys: key } } : {}) })
      .catch((error: { code?: number }) => { throw error.code === 11000 ? new AppError(409, "CONFLICT", "That name can't be used: pick another") : error; });
    await record("expense.company.update", "expense_company", String(company._id), { fields: Object.keys(change).sort().join(",") });
    if (typeof set.website === "string" && set.website !== company.website) fetchLogoLater(String(company._id), actor.id);
    res.json(ok({ id: String(company._id) }));
  });

  // One company into another: its expenses, spellings, and the website, GSTIN or logo the other lacks move across.
  router.post("/expenses/companies/:id/merge", async (req, res) => {
    const { workspaceId, settings, me, record } = await gate(req, "manage");
    const { into } = expenseCompanyMergeSchema.parse(req.body ?? {});
    const source = await visibleCompany(workspaceId, idSchema.parse(req.params.id), settings, me);
    const target = await visibleCompany(workspaceId, into, settings, me);
    if (String(source._id) === String(target._id)) throw new AppError(400, "BAD_REQUEST", "Pick another company to merge into");
    const takeLogo = !target.logo && source.logo;
    await atomic(database, async (session) => {
      // Both must still be there (another merge may have just moved one): checked inside the transaction, so nothing is lost.
      const gone = new AppError(409, "CONFLICT", "One of these companies was just merged: reload and try again");
      if (!await db.collection(COMPANIES).findOne({ _id: target._id, workspaceId }, { session, projection: { _id: 1 } })) throw gone;
      await db.collection(EXPENSES).updateMany({ workspaceId, companyId: String(source._id) }, { $set: { companyId: String(target._id) } }, { session });
      // The spellings move only once the company they belonged to is gone (a key belongs to one company).
      if (!(await db.collection(COMPANIES).deleteOne({ _id: source._id, workspaceId }, { session })).deletedCount) throw gone;
      const set = { ...(!target.website && source.website ? { website: source.website } : {}), ...(!target.gstin && source.gstin ? { gstin: source.gstin } : {}), ...(takeLogo ? { logo: source.logo } : {}) };
      if (!(await db.collection(COMPANIES).updateOne({ _id: target._id, workspaceId }, { $addToSet: { keys: { $each: source.keys as string[] } }, ...(Object.keys(set).length ? { $set: set } : {}) }, { session })).matchedCount) throw gone;
      await record("expense.company.merge", "expense_company", String(target._id), { merged: String(source._id) }, session);
    });
    const dropped = !takeLogo ? source.logo as AppDocument | undefined : undefined;
    if (dropped?.objectKey) await fileStoreFor(dropped, store, localStore)?.discard(String(dropped.objectKey)).catch(() => undefined);
    res.json(ok({ id: String(target._id) }));
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
