"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Layers3 } from "lucide-react";
import clsx from "clsx";
import { loadLiveSession } from "@/lib/studio-api";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
const pages = [
  { href: "/dashboard/live", label: "Dashboard" },
  { href: "/tasks/live", label: "Tasks" },
  { href: "/board/live", label: "Board" },
  { href: "/planning/live", label: "Planning" },
  { href: "/channels/live", label: "Channels" },
  { href: "/knowledge/live", label: "Knowledge" },
  { href: "/notifications/live", label: "Inbox" },
  { href: "/focus/live", label: "Focus" },
];

export function LiveShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => { if (active) { setSession(value); setError(""); } }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load the connected workspace."); }));
    return () => { active = false; };
  }, []);

  if (error) return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-danger-surface text-danger-text"><Layers3 size={20} /></span><h1 className="mt-4 text-xl font-extrabold text-neutral-900">Connected workspace unavailable</h1><p role="alert" className="mt-2 text-sm leading-6 text-neutral-500">{error}</p><div className="mt-5 flex flex-wrap gap-2"><Link href="/sign-in/live" className="min-h-10 rounded-xl bg-neutral-900 px-4 py-2.5 text-xs font-bold text-white">Sign in</Link><Link href="/dashboard" className="min-h-10 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-xs font-bold text-neutral-700">Demo dashboard</Link></div></section></main>;
  if (!session) return <main className="grid min-h-dvh place-items-center bg-canvas text-sm font-medium text-neutral-500">Loading connected workspace…</main>;

  return <div className="min-h-dvh bg-canvas"><header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/95 backdrop-blur"><div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-7"><Link href="/dashboard/live" className="flex min-w-0 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-600 text-white shadow-sm"><Layers3 size={17} /></span><span className="min-w-0"><span className="block truncate text-sm font-extrabold tracking-tight text-neutral-900">Venture Studio</span><span className="block truncate text-[11px] font-medium text-neutral-400">{session.hierarchy.workspace.name} · Connected</span></span></Link><div className="flex items-center gap-3"><span className="hidden text-right text-xs sm:block"><span className="block font-extrabold text-neutral-800">{session.user.name}</span><span className="block capitalize text-neutral-400">{session.membership.role.replaceAll("_", " ")}{process.env.NODE_ENV === "development" ? " · Local dev" : ""}</span></span><Link href="/dashboard" className="inline-flex min-h-9 items-center gap-1 rounded-xl border border-neutral-200 px-3 text-xs font-bold text-neutral-600 hover:bg-neutral-50">Demo UI<ArrowUpRight size={13} /></Link></div></div><nav aria-label="Connected workspace navigation" className="thin-scroll mx-auto flex max-w-[1600px] gap-1 overflow-x-auto px-4 pb-2 sm:px-6 lg:px-7">{pages.map((page) => <Link key={page.href} href={page.href} aria-current={path === page.href ? "page" : undefined} className={clsx("inline-flex min-h-9 shrink-0 items-center rounded-xl px-3 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", path === page.href ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900")}>{page.label}</Link>)}</nav></header><main id="main-content" className="min-w-0">{children}</main></div>;
}
