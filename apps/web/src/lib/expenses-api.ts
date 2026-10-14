import { z } from "zod";
import {
  expenseAccessSchema, expenseCategorySchema, expenseGroupSchema, expenseListSchema, expenseMemberAccessSchema, expenseReceiptSchema, expenseSchema, expenseSettingsSchema, successEnvelope,
  type ExpenseAccess, type ExpenseCategory, type ExpenseGroup, type ExpenseInput,
} from "@venture-studio/contracts";
import { localDevUserId } from "@/lib/dev-identity";
import { request, StudioApiError } from "@/lib/studio-api";

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
/** `expectedUpdatedAt` is the version the person edited: a change saved meanwhile refuses the edit (409) instead of being undone. */
export async function updateExpense(expenseId: string, change: Partial<ExpenseInput> & { expectedUpdatedAt?: string }) { return successEnvelope(expenseSchema).parse(await request(`/v1/expenses/${id(expenseId)}`, send("PATCH", change))).data; }
export async function deleteExpense(expenseId: string, expectedUpdatedAt?: string) { await request(`/v1/expenses/${id(expenseId)}${expectedUpdatedAt ? `?expectedUpdatedAt=${id(expectedUpdatedAt)}` : ""}`, send("DELETE")); }
/** A new amount from a month on: the expense stops the month before and a copy carries on. */
export async function changeExpenseFrom(expenseId: string, input: { fromMonth: string; amountPaise: number; expectedUpdatedAt?: string }) {
  return successEnvelope(z.object({ stopped: expenseSchema, continued: expenseSchema })).parse(await request(`/v1/expenses/${id(expenseId)}/change`, send("POST", input))).data;
}
export async function createCategory(input: { name: string; color: ExpenseCategory["color"]; restricted: boolean }) { return successEnvelope(expenseCategorySchema).parse(await request("/v1/expenses/settings/categories", send("POST", input))).data; }
export async function updateCategory(categoryId: string, change: Partial<Omit<ExpenseCategory, "id">>) { return successEnvelope(expenseCategorySchema).parse(await request(`/v1/expenses/settings/categories/${id(categoryId)}`, send("PATCH", change))).data; }
export async function createGroup(input: { name: string; color: ExpenseGroup["color"]; note: string }) { return successEnvelope(expenseGroupSchema).parse(await request("/v1/expenses/settings/groups", send("POST", input))).data; }
export async function updateGroup(groupId: string, change: Partial<Omit<ExpenseGroup, "id">>) { return successEnvelope(expenseGroupSchema).parse(await request(`/v1/expenses/settings/groups/${id(groupId)}`, send("PATCH", change))).data; }
/** A photo or PDF of a receipt, sent as it is: the server keeps a small copy and reads it (a few seconds). */
export async function uploadReceipt(file: File) { return successEnvelope(expenseReceiptSchema).parse(await request("/v1/expenses/receipts", { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } })).data; }
export async function getReceipt(receiptId: string) { return successEnvelope(expenseReceiptSchema).parse(await request(`/v1/expenses/receipts/${id(receiptId)}`)).data; }
/** The kept copy as a local link (revoke it when done). */
export async function receiptFileUrl(receiptId: string) {
  const devUserId = localDevUserId();
  const response = await fetch(`/v1/expenses/receipts/${id(receiptId)}/file`, { credentials: "same-origin", cache: "no-store", headers: devUserId ? { "x-dev-user-id": devUserId } : undefined });
  if (!response.ok) throw new StudioApiError(`The receipt returned HTTP ${response.status}.`, `HTTP_${response.status}`);
  return URL.createObjectURL(await response.blob());
}
export async function setExpenseAccess(userId: string, access: ExpenseAccess) { return successEnvelope(expenseMemberAccessSchema.omit({ name: true, role: true })).parse(await request(`/v1/expenses/settings/access/${id(userId)}`, send("PUT", access))).data; }
