"use client";
import { useEffect, useState } from "react";
import { expenseAccessAtLeast } from "@venture-studio/contracts";
import { getExpenseAccess } from "@/lib/expenses-api";

// Whether the sidebar shows Expenses: the person's own access level, asked when the page loads and again when they come back to the
// tab (at most once a minute), so a change a manager made shows without a reload. The API still checks every request.
export function useExpenseAccess(connected: boolean): boolean {
  const [canView, setCanView] = useState(false);
  useEffect(() => {
    if (!connected) return;
    let active = true;
    let askedAt = 0;
    const ask = () => {
      if (Date.now() - askedAt < 60_000) return;
      askedAt = Date.now();
      getExpenseAccess().then((access) => { if (active) setCanView(expenseAccessAtLeast(access.level, "view")); }).catch(() => { askedAt = 0; });
    };
    ask();
    const onFocus = () => { if (document.visibilityState === "visible") ask(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => { active = false; document.removeEventListener("visibilitychange", onFocus); };
  }, [connected]);
  return canView;
}
