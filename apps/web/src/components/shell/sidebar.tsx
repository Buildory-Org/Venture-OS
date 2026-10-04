"use client";

import { WorkspaceLink as Link } from "./workspace-link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Bell, BookOpenText, CalendarDays, ChevronDown, Columns3, FileQuestion, FolderOpen, Hash, Home, LayoutDashboard, Layers3, ListTodo, MessageSquareText, Plus, Scale, Settings, TrendingUp, Users, X } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";
import { Select } from "@/components/ui/select";
import { CreateVentureDrawer } from "@/components/studio/create-venture-drawer";

const sections = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Today", href: "/today", icon: Home },
  { label: "Ventures", href: "/ventures", icon: Layers3 },
  { label: "Tasks", href: "/tasks", icon: ListTodo },
  { label: "Board", href: "/board", icon: Columns3 },
  { label: "Channels", href: "/channels", icon: Hash },
  { label: "Messages", href: "/messages", icon: MessageSquareText },
  { label: "Notifications", href: "/notifications", icon: Bell },
  { label: "Knowledge", href: "/knowledge", icon: BookOpenText },
  { label: "Decisions", href: "/decisions", icon: Scale },
  { label: "Classes", href: "/classes", icon: CalendarDays },
  { label: "Timeline", href: "/timeline", icon: TrendingUp },
  { label: "Requests", href: "/requests", icon: FileQuestion },
  { label: "Sales", href: "/sales", icon: FolderOpen },
];
const press = "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";
// Scope-menu entry that opens venture creation instead of changing the scope.
const NEW_VENTURE = "__new-venture__";
type Props = { collapsed: boolean; mobileOpen: boolean; immersive: boolean; onCloseMobile: () => void; onOpenChat: (href: string, event: MouseEvent<HTMLAnchorElement>) => void };

export function Sidebar({ collapsed, mobileOpen, immersive, onCloseMobile, onOpenChat }: Props) {
  const { data, currentUserId, mode, workspaceName, role, activeVentureId, setActiveVentureId } = useStudio();
  const rawPath = usePathname().replace(/^\/demo(?=\/|$)/, "") || "/dashboard";
  const path = rawPath.replace(/\/live$/, "");
  const [ventureMenu, setVentureMenu] = useState<{ path: string; open: boolean } | null>(null);
  const ventureMenuOpen = ventureMenu?.path === path ? ventureMenu.open : path === "/ventures";
  const currentUser = data.people.find((person) => person.id === currentUserId) ?? data.people[0];
  const quickGroup = data.groups.find((group) => !activeVentureId || group.ventureId === activeVentureId);
  const unread = data.notices.filter((notice) => !notice.read).length;
  const router = useRouter();
  const canCreateVenture = mode === "connected" && role === "admin";
  const [creatingVenture, setCreatingVenture] = useState(false);
  // A new venture is unknown to the scope until the shell reloads; hand it over then, unless the member picked another scope meanwhile.
  const [pendingScope, setPendingScope] = useState<{ ventureId: string; from: string } | null>(null);
  useEffect(() => {
    if (!pendingScope) return;
    if (activeVentureId !== pendingScope.from) { queueMicrotask(() => setPendingScope(null)); return; }
    if (!data.ventures.some((venture) => venture.id === pendingScope.ventureId)) return;
    setActiveVentureId(pendingScope.ventureId);
    queueMicrotask(() => setPendingScope(null));
  }, [activeVentureId, data.ventures, pendingScope, setActiveVentureId]);
  return <>
    {mobileOpen && !immersive && <button type="button" aria-label="Close navigation" onClick={onCloseMobile} className="fixed inset-0 z-30 bg-neutral-900/20 backdrop-blur-[2px] lg:hidden" />}
    <aside aria-label="Workspace navigation" aria-hidden={immersive} inert={immersive} className={clsx("vso-shell-sidebar absolute inset-y-0 left-0 z-40 flex w-[292px] shrink-0 flex-col border-r border-neutral-100 bg-white shadow-e3 transition-[width,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] lg:relative lg:z-0 lg:translate-x-0 lg:shadow-none", collapsed ? "lg:w-[76px]" : "lg:w-[248px]", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm"><Layers3 size={16} /></span><div className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}><p className="truncate text-sm font-semibold tracking-tight text-neutral-900">Venture Studio</p><p className="truncate text-[11px] font-semibold text-neutral-400">{workspaceName} workspace</p></div><button type="button" onClick={onCloseMobile} aria-label="Close navigation" className={clsx("grid h-10 w-10 place-items-center rounded-xl text-neutral-400 hover:bg-neutral-100 lg:hidden", press)}><X size={17} /></button></div>
      <nav className="thin-scroll flex-1 overflow-y-auto px-3 pb-3" aria-label="Main navigation">
        <div className={clsx("mb-4 flex min-h-11 items-center gap-2 rounded-xl bg-neutral-50 px-2", collapsed && "lg:justify-center lg:px-1")}><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-[10px] font-semibold text-neutral-700 shadow-sm">{(data.ventures.find((venture) => venture.id === activeVentureId)?.short ?? workspaceName.slice(0, 2)).toUpperCase()}</span><span className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}><Select aria-label="Active venture scope" value={activeVentureId} onChange={(event) => event.target.value === NEW_VENTURE ? setCreatingVenture(true) : setActiveVentureId(event.target.value)} className="!min-h-9 !w-full !border-0 !bg-transparent !px-1 !text-xs !shadow-none"><option value="">All ventures</option>{data.ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}{canCreateVenture && <option value={NEW_VENTURE}><span className="flex items-center gap-1.5 text-primary-700"><Plus size={14} aria-hidden="true" />New venture</span></option>}</Select></span></div>
        <p className={clsx("mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.1em] text-neutral-400", collapsed && "lg:text-center")}><span className="lg:hidden">Workspace</span><span className="hidden lg:inline">{collapsed ? "•••" : "Workspace"}</span></p>
        <div className="space-y-0.5">{sections.map(({ label, href, icon: Icon }) => {
          const active = path === href;
          if (href === "/ventures") return <div key={href}>
            <div className={clsx("relative flex items-center rounded-xl", active ? "bg-primary-700 text-white shadow-sm" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900")}>
              <Link href={href} onClick={() => { setVentureMenu({ path: href, open: true }); onCloseMobile(); }} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined} className={clsx("flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 text-[13px] font-semibold", press)}><Icon size={17} strokeWidth={active ? 2.1 : 1.8} /><span className={clsx("flex-1 truncate", collapsed && "lg:hidden")}>{label}</span></Link>
              <button type="button" aria-label="Toggle venture spaces" aria-expanded={ventureMenuOpen} onClick={() => setVentureMenu({ path, open: !ventureMenuOpen })} className={clsx("mr-1 grid h-9 w-9 place-items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", collapsed && "lg:hidden")}><ChevronDown size={15} className={clsx("transition-transform duration-150", ventureMenuOpen && "rotate-180")} /></button>
            </div>
            <div aria-label="Venture spaces" aria-hidden={!ventureMenuOpen} inert={!ventureMenuOpen} className={clsx("vso-venture-menu ml-5 border-l border-neutral-200 pl-2", ventureMenuOpen && "is-open", collapsed && "lg:hidden")}><div className="space-y-0.5 py-1">{data.ventures.map((venture, index) => <Link key={venture.id} href={`/ventures?venture=${venture.id}`} onClick={() => { setActiveVentureId(venture.id); onCloseMobile(); }} style={{ "--venture-index": index } as React.CSSProperties} className={clsx("vso-venture-entry flex min-h-10 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-neutral-600 hover:bg-primary-50 hover:text-primary-800", press)}><span className={clsx("grid h-6 w-6 shrink-0 place-items-center rounded-md text-[9px] font-semibold text-white", venture.color)}>{venture.short}</span><span className="truncate">{venture.name}</span></Link>)}</div></div>
          </div>;
          return <Link key={href} href={href} onClick={(event) => { onCloseMobile(); if (href === "/channels" || href === "/messages") onOpenChat(href, event); }} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined} className={clsx("relative flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-[13px] font-semibold", press, active ? "bg-primary-700 text-white shadow-sm" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900")}><Icon size={17} strokeWidth={active ? 2.1 : 1.8} /><span className={clsx("flex-1 truncate", collapsed && "lg:hidden")}>{label}</span>{href === "/notifications" && unread > 0 && <span className={clsx("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", active ? "bg-white/15 text-white" : "bg-primary-50 text-primary-700", collapsed && "lg:absolute lg:right-1 lg:top-1 lg:h-2 lg:w-2 lg:p-0 lg:text-transparent")}>{unread}</span>}</Link>;
        })}</div>
        {quickGroup && <div className={clsx("mt-4 rounded-xl bg-neutral-50 p-2", collapsed && "lg:hidden")}><div className="mb-1 flex items-center gap-2 px-2 py-1"><Users size={14} className="text-neutral-400" /><p className="truncate text-[10px] font-semibold uppercase tracking-[.08em] text-neutral-500">{data.ventures.find((item) => item.id === quickGroup.ventureId)?.name} · {quickGroup.name}</p></div>{data.channels.filter((channel) => channel.groupId === quickGroup.id).map((channel) => <Link key={channel.id} href={`/channels?channel=${channel.id}`} onClick={(event) => { onCloseMobile(); onOpenChat(`/channels?channel=${channel.id}`, event); }} className={clsx("flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-neutral-500 hover:bg-white", press)}><Hash size={14} /><span className="flex-1">{channel.name}</span>{channel.unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-primary-600" />}</Link>)}</div>}
      </nav>
      <div className="border-t border-neutral-100 p-3">{mode === "demo" && <Link href="/settings" onClick={onCloseMobile} className={clsx("mb-1 flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 text-xs font-semibold text-neutral-500 hover:bg-neutral-100", press)}><Settings size={16} /><span className={clsx(collapsed && "lg:hidden")}>Settings</span></Link>}<Link href="/admin" onClick={onCloseMobile} className={clsx("mb-1 flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 text-xs font-semibold text-neutral-500 hover:bg-neutral-100", press)}><Users size={16} /><span className={clsx(collapsed && "lg:hidden")}>People & access</span></Link><div className={clsx("flex min-h-11 items-center gap-2.5 rounded-xl bg-neutral-50 px-2.5", collapsed && "lg:justify-center lg:px-1")}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-semibold text-white">{currentUser.initials}</span><span className={clsx("min-w-0", collapsed && "lg:hidden")}><span className="block truncate text-xs font-semibold text-neutral-800">{currentUser.name}</span><span className="block truncate text-[10px] font-medium text-neutral-400">{role}</span></span></div></div>
    </aside>
    {creatingVenture && <CreateVentureDrawer workspaceName={workspaceName} ownerId={currentUserId} onClose={() => setCreatingVenture(false)} onCreated={(venture) => { setCreatingVenture(false); setPendingScope({ ventureId: venture.id, from: activeVentureId }); onCloseMobile(); router.push(`/ventures/live?venture=${encodeURIComponent(venture.id)}`); }} />}
  </>;
}
