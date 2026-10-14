"use client";
import { useEffect, useState } from "react";
import { expenseAccessAtLeast } from "@venture-studio/contracts";
import { getExpenseAccess } from "@/lib/expenses-api";

// Whether the sidebar shows Expenses: the person's own access level, asked once per page load (the API still checks every request).
let asked: Promise<boolean> | null = null;
export function useExpenseAccess(connected: boolean): boolean {
  const [canView, setCanView] = useState(false);
  useEffect(() => {
    if (!connected) return;
    let active = true;
    asked ??= getExpenseAccess().then((access) => expenseAccessAtLeast(access.level, "view")).catch(() => { asked = null; return false; });
    void asked.then((value) => { if (active) setCanView(value); });
    return () => { active = false; };
  }, [connected]);
  return canView;
}
