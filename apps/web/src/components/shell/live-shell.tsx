"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers3 } from "@/components/ui/icons";
import { AppShell } from "./app-shell";
import { StudioProvider } from "@/lib/studio-store";
import { connectedNotices, connectedShellData } from "@/lib/live-shell-data";
import { notificationSnapshotEvent } from "@/lib/notification-events";
import { StudioApiError, hasLiveAuthSession, listLiveMembers, listLiveNotifications, listLiveTasks, loadLiveSession } from "@/lib/studio-api";
import { useChatPushResponder } from "@/lib/chat-presence";
import { demoEnabled } from "@/lib/demo";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Snapshot = { session: Session; data: ReturnType<typeof connectedShellData> };

export function LiveShell({ children }: { children: React.ReactNode }) {
  useChatPushResponder();
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [hierarchyRevision, setHierarchyRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setHierarchyRevision((value) => value + 1);
    window.addEventListener("venture:hierarchy-changed", refresh);
    return () => window.removeEventListener("venture:hierarchy-changed", refresh);
  }, []);

  useEffect(() => {
    const onNotifications = (event: Event) => {
      const notices = connectedNotices((event as CustomEvent<Awaited<ReturnType<typeof listLiveNotifications>>>).detail);
      setSnapshot((current) => current ? { ...current, data: { ...current.data, notices } } : current);
    };
    window.addEventListener(notificationSnapshotEvent, onNotifications);
    return () => window.removeEventListener(notificationSnapshotEvent, onNotifications);
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      try {
        const session = await loadLiveSession();
        if (!active) return;
        setSnapshot({ session, data: connectedShellData(session) });
        setError("");
        const [tasks, notifications, members] = await Promise.allSettled([
          listLiveTasks(), listLiveNotifications(), listLiveMembers({ limit: 100 }),
        ]);
        if (!active) return;
        setSnapshot({ session, data: connectedShellData(
          session,
          tasks.status === "fulfilled" ? tasks.value.items : [],
          notifications.status === "fulfilled" ? notifications.value : [],
          members.status === "fulfilled" ? members.value.items : [],
        ) });
      } catch (cause) {
        if (!active) return;
        if (cause instanceof StudioApiError && cause.code === "UNAUTHENTICATED") {
          // No session: go to sign-in and come back. A session without an active membership would loop, so explain instead.
          const signedIn = await hasLiveAuthSession().catch(() => false);
          if (!active) return;
          if (!signedIn) { router.replace(`/sign-in/live?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`); return; }
          setSnapshot(null);
          setError("You're signed in, but this account doesn't have access to this workspace yet. Ask a workspace admin to invite you, or sign in with a different email.");
          return;
        }
        setSnapshot(null);
        setError(describeError(cause, "Could not open your workspace."));
      }
    });
    return () => { active = false; };
  }, [hierarchyRevision, router]);

  if (error) return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-danger-surface text-danger-text"><Layers3 size={20} /></span><h1 className="mt-4 text-xl font-bold text-neutral-900">Workspace unavailable</h1><p role="alert" className="mt-2 text-sm leading-6 text-neutral-500">{error}</p><div className="mt-5 flex flex-wrap gap-2"><Link href="/sign-in/live" className="min-h-10 rounded-xl bg-primary-700 px-4 py-2.5 text-xs font-semibold text-white">Sign in</Link>{demoEnabled && <Link href="/demo" className="min-h-10 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-xs font-semibold text-neutral-700">Explore demo</Link>}</div></section></main>;
  if (!snapshot) return <main className="grid min-h-dvh place-items-center bg-canvas text-sm font-medium text-neutral-500">Loading workspace…</main>;

  return <StudioProvider mode="connected" initialData={snapshot.data} initialUserId={snapshot.session.user.id} workspaceName={snapshot.session.hierarchy.workspace.name} role={snapshot.session.membership.role.replaceAll("_", " ")}><AppShell connected>{children}</AppShell></StudioProvider>;
}
