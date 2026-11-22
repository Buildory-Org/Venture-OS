"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { getSalesOverview, type SalesOverview } from "@/lib/sales-api";
import { getAutopilot } from "@/lib/sales-autopilot-api";
import { autopilotDoes } from "@/components/sales/use-autopilot";

/** The numbers the Sales sidebar shows beside its items: `today` is the Today header's number, `review` what a person does in Review. */
export type SalesNavCounts = { today: number; review: number; replies: number; callsDue: number };
export const SALES_CHANGED_EVENT = "vso:sales-changed";

type Counts = SalesOverview["counts"];
/**
 * What a person must act on in Review: messages to approve, ready to send, and sent back with changes. Drafts still waiting for the
 * check count too, unless the app checks them itself (`appReviews`): then they are the app's work, not the person's.
 * `toReview` holds the drafts in review, the ones that need changes and the ones to approve, so this also works on a server that does
 * not split them yet.
 */
export const reviewWaiting = (counts: Counts, appReviews: boolean) => Math.max(0, counts.toReview - (appReviews ? counts.inReview : 0)) + counts.readyToSend;
/** Everything that waits for a person on Today: the sidebar's Today badge and the number in the Today header. */
export const todayWaiting = (counts: Counts, appReviews: boolean) => counts.replies + counts.callsDue + counts.followUpsDue + counts.needsYou + counts.wonToHandOver + reviewWaiting(counts, appReviews);

const MIN_GAP_MS = 8_000;
const EVERY_MS = 60_000;

/**
 * One light Overview fetch (owner=me) while Sales mode is on: on entering, on navigation (not more often than every 8 s),
 * after a change anywhere in Sales (the layout fires SALES_CHANGED_EVENT), and every minute while the tab is visible.
 * It never blocks the sidebar: until it arrives, or if it fails, items simply show no counts.
 */
export function useSalesNavCounts(enabled: boolean, ventureId: string): SalesNavCounts | null {
  const pathname = usePathname();
  const [state, setState] = useState<{ key: string; counts: SalesNavCounts } | null>(null);
  const key = ventureId;
  const lastLoad = useRef(0);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = (force: boolean, first = false) => {
      // Background refreshes wait while the tab is hidden; the first load always runs (embedded views can report "hidden").
      if (!first && document.visibilityState === "hidden") return;
      const now = Date.now();
      // A new venture scope always loads at once; the gap only spaces out refreshes of the same scope.
      if (!force && lastKey.current === key && now - lastLoad.current < MIN_GAP_MS) return;
      lastLoad.current = now; lastKey.current = key;
      // The venture's autopilot decides whether drafts in review are the person's work; without a venture, or on a server without
      // the autopilot, they are.
      const autopilot = ventureId ? getAutopilot(ventureId).catch(() => null) : Promise.resolve(null);
      Promise.all([getSalesOverview({ ...(ventureId ? { ventureId } : {}), owner: "me" }), autopilot]).then(([{ counts }, status]) => {
        const appReviews = autopilotDoes(status, "review");
        if (active) setState({ key, counts: { today: todayWaiting(counts, appReviews), review: reviewWaiting(counts, appReviews), replies: counts.replies, callsDue: counts.callsDue } });
      }).catch(() => { /* No counts is fine; the sidebar still works. */ });
    };
    load(false, true);
    const onChange = () => load(true);
    const timer = window.setInterval(() => load(true), EVERY_MS);
    // A tab that was hidden when the numbers were due catches up as soon as it is shown again.
    const onVisible = () => { if (document.visibilityState === "visible") load(false); };
    window.addEventListener(SALES_CHANGED_EVENT, onChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(SALES_CHANGED_EVENT, onChange); document.removeEventListener("visibilitychange", onVisible); };
  // pathname: refresh on navigation.
  }, [enabled, ventureId, key, pathname]);

  return enabled && state?.key === key ? state.counts : null;
}
