"use client";

import { useEffect, useState } from "react";
import { StudioDashboard } from "./studio-dashboard";
import { TodayScreen } from "./studio-today";
import { connectedDashboardData } from "@/lib/live-shell-data";
import { listLiveClasses, listLiveDecisions, listLiveDocuments, listLiveFocusHistory, listLiveMembers, listLiveNotifications, listLiveOpportunities, listLiveOutcomes, listLiveTasks, loadLiveSession } from "@/lib/studio-api";

type Snapshot = ReturnType<typeof connectedDashboardData>;

export function ConnectedDashboard({ view = "dashboard" }: { view?: "dashboard" | "today" }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      try {
        const session = await loadLiveSession();
        const [tasks, notifications, members, outcomes, decisions, documents, opportunities, focusHistory, classes] = await Promise.all([
          listLiveTasks(), listLiveNotifications(), listLiveMembers({ limit: 100 }), listLiveOutcomes(),
          listLiveDecisions(), listLiveDocuments(), listLiveOpportunities(), listLiveFocusHistory(), listLiveClasses(),
        ]);
        if (!active) return;
        setData(connectedDashboardData(session, {
          tasks: tasks.items, notifications, members: members.items, outcomes, decisions,
          documents: documents.items, opportunities, focusHistory: focusHistory.items, classes,
        }));
        setError("");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "The dashboard could not load.");
      }
    });
    return () => { active = false; };
  }, []);

  if (error) return <div role="alert" className="m-6 rounded-2xl border border-danger-surface bg-white p-6 text-sm text-danger-text">{error}</div>;
  if (!data) return <div className="m-6 rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">Loading your dashboard…</div>;
  return view === "today" ? <TodayScreen snapshot={data} /> : <StudioDashboard snapshot={data} />;
}
