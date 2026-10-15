"use client";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { EXPENSE_CURRENCIES, expenseConverter, formatMoneyIn, type ExpenseCurrency, type ExpenseRates } from "@venture-studio/contracts";
import { getExpenseRates, type Expense } from "@/lib/expenses-api";
import { todayLocal } from "./expense-shared";

// Money on the expense screens (docs/expenses.md#currencies): every total, chart and list in the currency picked at the top of the page,
// rupees unless changed (remembered on this device). In rupees, an expense counts as saved: the bank's figure or the amount at the
// rate of the day it was paid; a repeating one in another currency at each payment's day's rate. In another currency, each payment
// converts at its own day's rate, and one paid in that very currency shows exactly what was paid. Rates are the European Central Bank's
// daily reference rates, which the API keeps.

type Row = { expense: Expense; day: string };
export type Money = {
  /** The currency amounts are shown in. */
  currency: ExpenseCurrency;
  /** Digits after its point (2; none for yen). */
  digits: number;
  /** One payment in the shown currency, in its smallest unit (paise, cents). */
  value: (expense: Expense, day: string) => number;
  sum: (rows: Row[]) => number;
  /** What a repeating expense costs a month (a yearly one a twelfth), at the rate of `day`. */
  monthly: (expense: Expense, day: string) => number;
  /** "₹1,23,456.50", "$1,234.50", "¥1,500". */
  format: (minor: number) => string;
  /** "₹12.4K", "₹1.2L", "₹3.4Cr"; "$12.4K", "€1.2M". */
  compact: (minor: number) => string;
  /** "1234.50" (a spreadsheet's number). */
  plain: (minor: number) => string;
  /** The amount with its decimals apart, to dim them: ["₹1,700", ".00"]; ["¥1,500", ""] for a currency without them. */
  split: (minor: number) => [string, string];
  /** What an expense in another currency was paid in, when the shown currency differs ("€6.49"); empty otherwise. */
  original: (expense: Expense) => string;
};

const formats = new Map<string, Intl.NumberFormat>();
function numberFormat(currency: string, digits: number, fraction: boolean, compact = false) {
  const key = `${currency}:${digits}:${fraction}:${compact}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", compact
      ? { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 }
      : { style: "currency", currency, minimumFractionDigits: fraction ? digits : 0, maximumFractionDigits: digits });
    formats.set(key, format);
  }
  return format;
}
/** An amount in a currency's smallest unit, formatted ("€6.49"; whole amounts without ".00"). */
export const formatMoney = formatMoneyIn;
/** "₹" for INR, "$" for USD, "CHF" where there is no sign. */
export function currencySign(currency: string) {
  return numberFormat(currency, 0, false).formatToParts(0).find((part) => part.type === "currency")?.value ?? currency;
}
function compactRupees(paise: number) {
  const value = paise / 100;
  const trim = (number: number) => (number >= 100 ? number.toFixed(0) : number.toFixed(1).replace(/\.0$/, ""));
  if (value >= 1e7) return `₹${trim(value / 1e7)}Cr`;
  if (value >= 1e5) return `₹${trim(value / 1e5)}L`;
  if (value >= 1e3) return `₹${trim(value / 1e3)}K`;
  return `₹${Math.round(value)}`;
}

/** The money view for the shown currency (rupees when its rates couldn't be had): the shared converter, with this page's formats. */
export function moneyFor(shown: ExpenseCurrency, rates: ExpenseRates | null): Money {
  const { currency, digits, value } = expenseConverter(shown, rates, todayLocal());
  const usable = currency as ExpenseCurrency;
  return {
    currency: usable, digits, value,
    sum: (rows) => rows.reduce((total, row) => total + value(row.expense, row.day), 0),
    monthly: (expense, day) => expense.repeat === "monthly" ? value(expense, day) : expense.repeat === "yearly" ? Math.round(value(expense, day) / 12) : 0,
    format: (minor) => formatMoney(minor, usable),
    compact: (minor) => usable === "INR" ? compactRupees(minor) : numberFormat(usable, digits, false, true).format(minor / 10 ** digits),
    plain: (minor) => (minor / 10 ** digits).toFixed(digits),
    split: (minor) => {
      const text = numberFormat(usable, digits, true).format(minor / 10 ** digits);
      const point = digits ? text.lastIndexOf(".") : -1;
      return point >= 0 ? [text.slice(0, point), text.slice(point)] : [text, ""];
    },
    original: (expense) => expense.foreign && expense.foreign.currency !== usable ? formatMoney(expense.foreign.amountMinor, expense.foreign.currency) : "",
  };
}

// The shown currency, per device.
const SHOWN_KEY = "vso-expense-currency";
const shownListeners = new Set<() => void>();
const readShown = (): ExpenseCurrency => {
  try { const saved = window.localStorage.getItem(SHOWN_KEY); return (EXPENSE_CURRENCIES as readonly string[]).includes(saved ?? "") ? saved as ExpenseCurrency : "INR"; } catch { return "INR"; }
};
export function setShownCurrency(currency: ExpenseCurrency) {
  try { window.localStorage.setItem(SHOWN_KEY, currency); } catch { /* It still applies for this visit. */ }
  shownListeners.forEach((listener) => listener());
}
let shownOverride: ExpenseCurrency | null = null;
const subscribeShown = (listener: () => void) => { shownListeners.add(listener); return () => { shownListeners.delete(listener); }; };
const shownSnapshot = () => shownOverride ?? readShown();
export function useShownCurrency(): [ExpenseCurrency, (currency: ExpenseCurrency) => void] {
  const shown = useSyncExternalStore(subscribeShown, shownSnapshot, () => "INR" as ExpenseCurrency);
  return [shown, (currency) => { shownOverride = currency; setShownCurrency(currency); }];
}

/** The days and currencies an expense list needs rates for: none when everything is in rupees and shown in rupees. */
function rateNeeds(expenses: Expense[], shown: ExpenseCurrency) {
  const currencies = new Set<string>();
  for (const expense of expenses) if (expense.foreign && expense.repeat !== "none" && !expense.chargedPaise) currencies.add(expense.foreign.currency);
  if (shown !== "INR") currencies.add(shown);
  if (!currencies.size) return null;
  const today = todayLocal();
  // At most about three years back (older payments use the oldest rate kept).
  const floor = new Date(Date.parse(`${today}T00:00:00Z`) - 1_090 * 86_400_000).toISOString().slice(0, 10);
  const earliest = expenses.reduce((first, expense) => (expense.date < first ? expense.date : first), today);
  return { from: earliest < floor ? floor : earliest, to: today, currencies: [...currencies].sort() };
}

/**
 * The rates the screens need, loaded for each set of days and currencies and again on every reload (Refresh). `failed` when the shown
 * currency had to fall back to rupees; `estimated` when repeating payments in another currency are at their first payment's rupees
 * because the rates couldn't be had.
 */
export function useExpenseMoney(expenses: Expense[] | undefined, shown: ExpenseCurrency) {
  const needs = useMemo(() => (expenses ? rateNeeds(expenses, shown) : null), [expenses, shown]);
  const key = needs ? `${needs.from}|${needs.to}|${needs.currencies.join(",")}` : "";
  const [loaded, setLoaded] = useState<{ key: string; rates: ExpenseRates | null }>({ key: "", rates: null });
  useEffect(() => {
    if (!needs) return;
    let active = true;
    getExpenseRates(needs.from, needs.to, needs.currencies).then((rates) => { if (active) setLoaded({ key, rates }); }, () => { if (active) setLoaded({ key, rates: null }); });
    return () => { active = false; };
    // The key holds everything `needs` says; a new list (a reload) asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, expenses]);
  const rates = loaded.key === key ? loaded.rates : null;
  const money = useMemo(() => moneyFor(shown, rates), [shown, rates]);
  const waiting = Boolean(needs) && loaded.key !== key;
  const repeating = needs?.currencies.filter((currency) => currency !== shown) ?? [];
  const estimated = !waiting && repeating.some((currency) => !rates?.days.some((day) => day.rupees[currency]));
  return { money, waiting, failed: !waiting && shown !== money.currency, estimated };
}

const MoneyContext = createContext<Money>(moneyFor("INR", null));
export const MoneyProvider = MoneyContext.Provider;
export const useMoney = () => useContext(MoneyContext);
