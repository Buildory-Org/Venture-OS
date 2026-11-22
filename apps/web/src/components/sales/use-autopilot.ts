"use client";

import { useCallback, useEffect, useState } from "react";
import type { AUTOPILOT_STEPS } from "@venture-studio/contracts";
import { getAutopilot, type AutopilotStatus } from "@/lib/sales-autopilot-api";
import { SALES_CHANGED_EVENT } from "@/components/shell/use-sales-nav-counts";

// The venture's autopilot as screens need it (docs/sales-autopilot.md): does the app do this step itself, so the screen should stop
// asking the person to carry it to a Claude chat? A server from before the autopilot (or a failed read) reads as "no autopilot".

export type AutopilotStep = (typeof AUTOPILOT_STEPS)[number];

/** Whether the app itself does a step for the venture right now: its autopilot is on, the step is on, and nothing blocks it. */
export function autopilotDoes(status: AutopilotStatus | null | undefined, step: AutopilotStep): boolean {
  if (!status || !status.settings.enabled || !status.server.on) return false;
  if (status.blockers.some((blocker) => !blocker.step || blocker.step === step)) return false;
  if (step === "find") return status.settings.find.enabled;
  if (step === "send") return status.settings.send !== "by_hand";
  return status.settings[step];
}

/** Whether approved emails can be handed to the app to send (the send queue runs on this server); it does not need the venture's autopilot on. */
export const canQueueSends = (status: AutopilotStatus | null | undefined): boolean => Boolean(status?.server.on);

/**
 * The venture's autopilot status: null while it loads, without a venture, or on a server without the autopilot. It is read again after
 * any change in Sales and when `reload()` is called.
 */
export function useAutopilot(ventureId: string | null | undefined) {
  const [state, setState] = useState<{ ventureId: string; status: AutopilotStatus | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ventureId) return;
    let active = true;
    getAutopilot(ventureId).then((status) => { if (active) setState({ ventureId, status }); }, () => { if (active) setState({ ventureId, status: null }); });
    return () => { active = false; };
  }, [ventureId, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener(SALES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(SALES_CHANGED_EVENT, reload);
  }, [reload]);
  const status = ventureId && state?.ventureId === ventureId ? state.status : null;
  const loading = Boolean(ventureId) && state?.ventureId !== ventureId;
  const does = useCallback((step: AutopilotStep) => autopilotDoes(status, step), [status]);
  /** Replace the status with a fresh one a save returned. */
  const set = useCallback((next: AutopilotStatus) => setState({ ventureId: next.ventureId, status: next }), []);
  return { status, loading, reload, does, set, canQueue: canQueueSends(status) };
}
