"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRupees, occurrenceIn, type ExpenseScope } from "@venture-studio/contracts";
import { describeError } from "@/lib/errors";
import { StudioApiError } from "@/lib/studio-api";
import { getExpenseSettings, listExpenses, type Expense, type ExpenseCategory, type ExpenseGroup, type ExpenseSettings } from "@/lib/expenses-api";

// Shared by the expense tracker's tabs: labels, money, months and the data every tab reads.

export const rupees = formatRupees;
/**
 * "1,700.50", "1,23,456" or "€6.49" typed by a person → the currency's smallest unit (paise, cents; whole yen with no digits); null when
 * it isn't an amount. Commas only group thousands (the last group has three digits), so "6,49" (a decimal comma) is refused, not 649;
 * letters and minus signs are refused too.
 */
export function minorOf(text: string, digits = 2): number | null {
  const raw = text.trim().replace(/[\s\p{Sc}]/gu, "");
  if (!/^[\d.,]+$/.test(raw)) return null;
  const whole = raw.split(".")[0]!;
  if (whole.includes(",") && !/^\d{1,3}(,\d{2,3})*,\d{3}$/.test(whole)) return null;
  const clean = raw.replace(/,/g, "");
  if (!(digits ? new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`) : /^\d+$/).test(clean)) return null;
  const minor = Math.round(Number(clean) * 10 ** digits);
  return minor > 0 ? minor : null;
}
export const paiseOf = (text: string) => minorOf(text, 2);
/** An amount as the amount field shows it ("1700" or "1700.50"). */
export const minorText = (minor: number, digits = 2) => (minor % 10 ** digits ? (minor / 10 ** digits).toFixed(digits) : String(minor / 10 ** digits));
export const amountText = (paise: number) => minorText(paise, 2);
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

/** Lookups by id, including archived categories and groups (old expenses keep theirs). */
export function lookups(settings: ExpenseSettings) {
  const categories = new Map<string, ExpenseCategory>(settings.categories.map((category) => [category.id, category]));
  const groups = new Map<string, ExpenseGroup>(settings.groups.map((group) => [group.id, group]));
  const companies = new Map(settings.companies.map((company) => [company.id, company]));
  return { category: (id: string) => categories.get(id), group: (id: string | null) => (id ? groups.get(id) : undefined), company: (id: string | null | undefined) => (id ? companies.get(id) : undefined) };
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
