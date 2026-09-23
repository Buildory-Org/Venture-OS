"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Bell, BookOpenText, Columns3, Focus, Hash, LayoutDashboard, Layers3, ListTodo, Menu, MessageSquareText, Scale, TrendingUp, Users, X } from "@/components/ui/icons";
import clsx from "clsx";
import { loadLiveSession } from "@/lib/studio-api";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { LiveNotificationPulse } from "@/components/shell/live-notification-pulse";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
const pages = [
  { href: "/dashboard/live", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks/live", label: "Tasks", icon: ListTodo },
  { href: "/board/live", label: "Board", icon: Columns3 },
  { href: "/channels/live", label: "Channels", icon: Hash },
  { href: "/messages/live", label: "Direct messages", icon: MessageSquareText },
  { href: "/notifications/live", label: "Notifications", icon: Bell },
  { href: "/focus/live", label: "Focus", icon: Focus },
  { href: "/knowledge/live", label: "Knowledge", icon: BookOpenText },
  { href: "/planning/live", label: "Planning", icon: Scale },
  { href: "/sales/live", label: "Sales", icon: TrendingUp },
  { href: "/admin/live", label: "People & access", icon: Users },
];

function NavContent({ session, path, onNavigate }: { session: Session; path: string; onNavigate?: () => void }) {
  const initial = session.hierarchy.workspace.name.slice(0, 2).toUpperCase();
  return <>
    <Link href="/dashboard/live" onClick={onNavigate} className="flex h-16 items-center gap-2.5 px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm"><Layers3 size={16} /></span><span className="min-w-0"><span className="block truncate text-sm font-extrabold tracking-tight text-neutral-900">Venture Studio</span><span className="block truncate text-[11px] font-semibold text-neutral-400">Connected workspace</span></span></Link>
    <nav aria-label="Connected workspace navigation" className="thin-scroll flex-1 overflow-y-auto px-3 pb-3">
      <div className="mb-4 flex min-h-11 items-center gap-2 rounded-xl bg-neutral-50 px-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-[10px] font-extrabold text-neutral-700 shadow-sm">{initial}</span><span className="min-w-0"><span className="block truncate text-xs font-bold text-neutral-800">{session.hierarchy.workspace.name}</span><span className="block truncate text-[10px] font-medium text-neutral-400">{session.hierarchy.ventures.length} ventures</span></span></div>
      <p className="mb-2 px-3 text-[10px] font-extrabold uppercase tracking-[.1em] text-neutral-400">Workspace</p>
      <div className="space-y-0.5">{pages.map(({ href, label, icon: Icon }) => { const active = path === href; return <Link key={href} href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={clsx("flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", active ? "bg-neutral-900 text-white shadow-sm" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900")}><Icon size={17} strokeWidth={active ? 2.1 : 1.8} /><span className="truncate">{label}</span></Link>; })}</div>
      <div className="mt-5 border-t border-neutral-100 pt-4"><p className="mb-2 px-3 text-[10px] font-extrabold uppercase tracking-[.1em] text-neutral-400">Venture spaces</p>{session.hierarchy.ventures.map((venture) => <div key={venture.id} className="mb-2 rounded-xl bg-neutral-50 px-3 py-2.5"><p className="truncate text-xs font-extrabold text-neutral-800">{venture.name}</p><p className="mt-0.5 text-[10px] font-medium text-neutral-400">{venture.groups.length} groups · {venture.groups.reduce((count, group) => count + group.channels.length, 0)} channels</p></div>)}</div>
    </nav>
    <div className="border-t border-neutral-100 p-3"><Link href="/demo" onClick={onNavigate} className="mb-2 flex min-h-10 items-center gap-2 rounded-xl px-2.5 text-xs font-bold text-neutral-500 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Explore demo <ArrowUpRight size={13} /></Link><div className="flex min-h-11 items-center gap-2.5 rounded-xl bg-neutral-50 px-2.5"><ChatAvatar id={session.user.id} name={session.user.name} size={32} /><span className="min-w-0"><span className="block truncate text-xs font-extrabold text-neutral-800">{session.user.name}</span><span className="block truncate text-[10px] font-medium capitalize text-neutral-400">{session.membership.role.replaceAll("_", " ")}</span></span></div></div>
  </>;
}

export function LiveShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => { if (active) { setSession(value); setError(""); } }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not open your workspace."); }));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMobileOpen(false); menuRef.current?.focus(); }
      if (event.key !== "Tab") return;
      const items = drawerRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  if (error) return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-danger-surface text-danger-text"><Layers3 size={20} /></span><h1 className="mt-4 text-xl font-extrabold text-neutral-900">Workspace unavailable</h1><p role="alert" className="mt-2 text-sm leading-6 text-neutral-500">{error}</p><div className="mt-5 flex flex-wrap gap-2"><Link href="/sign-in/live" className="min-h-10 rounded-xl bg-neutral-900 px-4 py-2.5 text-xs font-bold text-white">Sign in</Link><Link href="/demo" className="min-h-10 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-xs font-bold text-neutral-700">Explore demo</Link></div></section></main>;
  if (!session) return <main className="grid min-h-dvh place-items-center bg-canvas text-sm font-medium text-neutral-500">Loading workspace…</main>;

  return <div className="flex h-dvh overflow-hidden bg-white">
    <aside aria-label="Workspace sidebar" className="hidden w-[248px] shrink-0 flex-col border-r border-neutral-100 bg-white lg:flex"><NavContent session={session} path={path} /></aside>
    {mobileOpen && <div className="fixed inset-0 z-40 lg:hidden"><button type="button" aria-label="Close navigation overlay" className="absolute inset-0 bg-neutral-900/25" onClick={() => { setMobileOpen(false); menuRef.current?.focus(); }} /><aside ref={drawerRef} role="dialog" aria-modal="true" aria-label="Mobile workspace sidebar" className="vso-enter-left relative flex h-full w-[min(292px,88vw)] flex-col bg-white shadow-e4"><button ref={closeRef} type="button" aria-label="Close navigation" onClick={() => { setMobileOpen(false); menuRef.current?.focus(); }} className="absolute right-2 top-2 z-10 grid h-10 w-10 place-items-center rounded-xl text-neutral-500 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={18} /></button><NavContent session={session} path={path} onNavigate={() => setMobileOpen(false)} /></aside></div>}
    <div className="flex min-w-0 flex-1 flex-col"><header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-neutral-100 bg-white px-3 sm:px-5"><div className="flex min-w-0 items-center gap-2"><button ref={menuRef} type="button" aria-label="Open navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 lg:hidden"><Menu size={18} /></button><span className="truncate text-sm font-extrabold text-neutral-900">{pages.find((page) => page.href === path)?.label ?? "Workspace"}</span></div><div className="flex items-center gap-2"><LiveNotificationPulse key={session.user.id} userId={session.user.id} /><Link href="/focus/live" className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-neutral-200 px-3 text-xs font-bold text-neutral-700 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Focus size={15} />Focus</Link></div></header><main id="main-content" className="min-w-0 flex-1 overflow-y-auto rounded-tl-[22px] bg-canvas">{children}</main></div>
  </div>;
}
