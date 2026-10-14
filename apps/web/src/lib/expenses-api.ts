import { z } from "zod";
import {
  expenseAccessSchema, expenseCategorySchema, expenseGroupSchema, expenseListSchema, expenseMemberAccessSchema, expenseSchema, expenseSettingsSchema, successEnvelope,
  type ExpenseAccess, type ExpenseCategory, type ExpenseGroup, type ExpenseInput,
} from "@venture-studio/contracts";
import { request } from "@/lib/studio-api";

// Client for the expense tracker (/v1/expenses; docs/expenses.md). The API decides who may see or change what; these only call it.

export type Expense = z.infer<typeof expenseSchema>;
export type ExpenseSettings = z.infer<typeof expenseSettingsSchema>;
export type ExpenseMemberAccess = z.infer<typeof expenseMemberAccessSchema>;
export type { ExpenseAccess, ExpenseCategory, ExpenseGroup, ExpenseInput };

const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const id = encodeURIComponent;

/** My own access level, for the sidebar (anyone signed in may ask). */
export async function getExpenseAccess() { return successEnvelope(expenseAccessSchema).parse(await request("/v1/expenses/access")).data; }
export async function getExpenseSettings() { return successEnvelope(expenseSettingsSchema).parse(await request("/v1/expenses/settings")).data; }
export async function listExpenses() { return successEnvelope(expenseListSchema).parse(await request("/v1/expenses")).data; }
export async function createExpense(input: ExpenseInput) { return successEnvelope(expenseSchema).parse(await request("/v1/expenses", send("POST", input))).data; }
export async function updateExpense(expenseId: string, change: Partial<ExpenseInput>) { return successEnvelope(expenseSchema).parse(await request(`/v1/expenses/${id(expenseId)}`, send("PATCH", change))).data; }
export async function deleteExpense(expenseId: string) { await request(`/v1/expenses/${id(expenseId)}`, send("DELETE")); }
/** A new amount from a month on: the expense stops the month before and a copy carries on. */
export async function changeExpenseFrom(expenseId: string, input: { fromMonth: string; amountPaise: number }) {
  return successEnvelope(z.object({ stopped: expenseSchema, continued: expenseSchema })).parse(await request(`/v1/expenses/${id(expenseId)}/change`, send("POST", input))).data;
}
export async function createCategory(input: { name: string; color: ExpenseCategory["color"]; restricted: boolean }) { return successEnvelope(expenseCategorySchema).parse(await request("/v1/expenses/settings/categories", send("POST", input))).data; }
export async function updateCategory(categoryId: string, change: Partial<Omit<ExpenseCategory, "id">>) { return successEnvelope(expenseCategorySchema).parse(await request(`/v1/expenses/settings/categories/${id(categoryId)}`, send("PATCH", change))).data; }
export async function createGroup(input: { name: string; color: ExpenseGroup["color"]; note: string }) { return successEnvelope(expenseGroupSchema).parse(await request("/v1/expenses/settings/groups", send("POST", input))).data; }
export async function updateGroup(groupId: string, change: Partial<Omit<ExpenseGroup, "id">>) { return successEnvelope(expenseGroupSchema).parse(await request(`/v1/expenses/settings/groups/${id(groupId)}`, send("PATCH", change))).data; }
export async function setExpenseAccess(userId: string, access: ExpenseAccess) { return successEnvelope(expenseMemberAccessSchema.omit({ name: true, role: true })).parse(await request(`/v1/expenses/settings/access/${id(userId)}`, send("PUT", access))).data; }
