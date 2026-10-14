"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRupees, occurrenceIn, type ExpenseScope } from "@venture-studio/contracts";
import { describeError } from "@/lib/errors";
import { StudioApiError } from "@/lib/studio-api";
import { getExpenseSettings, listExpenses, type Expense, type ExpenseCategory, type ExpenseGroup, type ExpenseSettings } from "@/lib/expenses-api";

// Shared by the expense tracker's tabs: labels, money, months and the data every tab reads.

export const rupees = formatRupees;
/** "1,700.50" typed by a person → paise; null when it isn't an amount. */
export function paiseOf(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const paise = Math.round(Number(clean) * 100);
  return paise > 0 ? paise : null;
}
/** Paise as the amount field shows it ("1700" or "1700.50"). */
export const amountText = (paise: number) => (paise % 100 ? (paise / 100).toFixed(2) : String(paise / 100));
/** Today on this device, YYYY-MM-DD. */
export const todayLocal = () => new Date().toLocaleDateString("en-CA");
export const thisMonth = () => todayLocal().slice(0, 7);
/** "Oct 2026". */
export const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
/** "14 Oct". */
export const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** Where an expense is charged, in words. */
export function scopeLabel(scope: ExpenseScope, ventureName: (id: string) => string): string {
  return scope.kind === "office" ? "Office" : scope.kind === "personal" ? "Personal" : ventureName(scope.ventureId);
}
/** A key for a "where" filter: "office", "personal" or "venture:<id>". */
export const scopeKey = (scope: ExpenseScope) => (scope.kind === "venture" ? `venture:${scope.ventureId}` : scope.kind);
export const REPEAT_LABEL = { none: "One-time", monthly: "Monthly", yearly: "Yearly" } as const;

/** The expenses paid in a month, each with the day it is paid. */
export function paidIn(expenses: Expense[], month: string): { expense: Expense; day: string }[] {
  return expenses.flatMap((expense) => { const day = occurrenceIn(expense, month); return day ? [{ expense, day }] : []; }).sort((a, b) => b.day.localeCompare(a.day) || a.expense.paidTo.localeCompare(b.expense.paidTo));
}
export const sumPaise = (rows: { expense: Expense }[]) => rows.reduce((total, row) => total + row.expense.amountPaise, 0);

/** Lookups by id, including archived categories and groups (old expenses keep theirs). */
export function lookups(settings: ExpenseSettings) {
  const categories = new Map<string, ExpenseCategory>(settings.categories.map((category) => [category.id, category]));
  const groups = new Map<string, ExpenseGroup>(settings.groups.map((group) => [group.id, group]));
  return { category: (id: string) => categories.get(id), group: (id: string | null) => (id ? groups.get(id) : undefined) };
}

/**
 * Saves rows as a CSV file (opens in Excel or Sheets), with a header row; quotes every cell. A text cell that starts like a formula
 * (=, +, -, @, tab) gets a leading apostrophe so a spreadsheet shows it as text instead of running it.
 */
export function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const cell = (value: string | number) => { const text = typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value); return `"${text.replace(/"/g, '""')}"`; };
  const text = [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export type ExpenseData = { settings: ExpenseSettings; expenses: Expense[]; hiddenRestricted: boolean; truncated: boolean };
/** The settings and expenses every tab reads, loaded together; `noAccess` when the API says the person has none. */
export function useExpenseData() {
  const [data, setData] = useState<ExpenseData | null>(null);
  const [error, setError] = useState("");
  const [noAccess, setNoAccess] = useState(false);
  const [busy, setBusy] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const call = ++latest.current;
    queueMicrotask(() => { if (call === latest.current) setBusy(true); });
    Promise.all([getExpenseSettings(), listExpenses()]).then(([settings, list]) => {
      if (call !== latest.current) return;
      setData({ settings, expenses: list.items, hiddenRestricted: list.hiddenRestricted, truncated: list.truncated }); setError(""); setNoAccess(false); setBusy(false);
    }).catch((cause: unknown) => {
      if (call !== latest.current) return;
      // No access reads as "not found" from the API.
      if (cause instanceof StudioApiError && (cause.code === "NOT_FOUND" || cause.code === "FORBIDDEN")) setNoAccess(true); else setError(describeError(cause, "Check your connection and try again."));
      setBusy(false);
    });
  }, [tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, noAccess, busy, reload };
}
