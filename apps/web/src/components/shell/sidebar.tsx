"use client";

import Link from "./demo-link";
import { usePathname } from "next/navigation";
import { Bell, BookOpenText, CalendarDays, ChevronDown, Columns3, FileQuestion, FolderOpen, Hash, Home, LayoutDashboard, Layers3, ListTodo, MessageSquareText, Scale, Settings, TrendingUp, Users, X } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";

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
type Props = { collapsed: boolean; mobileOpen: boolean; onCloseMobile: () => void };

export function Sidebar({ collapsed, mobileOpen, onCloseMobile }: Props) {
  const path = usePathname().replace(/^\/demo(?=\/|$)/, "") || "/dashboard";
  const { data, currentUserId } = useStudio();
  const currentUser = data.people.find((person) => person.id === currentUserId) ?? data.people[0];
  const unread = data.notices.filter((notice) => !notice.read).length;
  return <>
    <button type="button" aria-label="Close navigation" onClick={onCloseMobile} className={clsx("fixed inset-0 z-30 bg-neutral-900/20 backdrop-blur-[2px] transition-opacity duration-150 lg:hidden", mobileOpen ? "opacity-100" : "pointer-events-none opacity-0")} />
    <aside aria-label="Workspace navigation" className={clsx("absolute inset-y-0 left-0 z-40 flex w-[292px] shrink-0 flex-col border-r border-neutral-100 bg-white shadow-e3 transition-[width,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] lg:relative lg:z-0 lg:translate-x-0 lg:shadow-none", collapsed ? "lg:w-[76px]" : "lg:w-[248px]", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm"><Layers3 size={16} /></span><div className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}><p className="truncate text-sm font-extrabold tracking-tight text-neutral-900">Venture Studio</p><p className="truncate text-[11px] font-semibold text-neutral-400">Meridian workspace</p></div><button type="button" onClick={onCloseMobile} aria-label="Close navigation" className={clsx("grid h-10 w-10 place-items-center rounded-xl text-neutral-400 hover:bg-neutral-100 lg:hidden", press)}><X size={17} /></button></div>
      <nav className="thin-scroll flex-1 overflow-y-auto px-3 pb-3" aria-label="Main navigation">
        <div className={clsx("mb-4 flex min-h-11 items-center gap-2 rounded-xl bg-neutral-50 px-3", collapsed && "lg:justify-center lg:px-1")}><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-[10px] font-extrabold text-neutral-700 shadow-sm">MS</span><span className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}><span className="block truncate text-xs font-bold text-neutral-800">Meridian Studio</span><span className="block truncate text-[10px] font-medium text-neutral-400">{data.ventures.length} ventures · {data.people.length} people</span></span><ChevronDown size={14} className={clsx("text-neutral-400", collapsed && "lg:hidden")} /></div>
        <p className={clsx("mb-2 px-3 text-[10px] font-extrabold uppercase tracking-[.1em] text-neutral-400", collapsed && "lg:text-center")}><span className="lg:hidden">Workspace</span><span className="hidden lg:inline">{collapsed ? "•••" : "Workspace"}</span></p>
        <div className="space-y-0.5">{sections.map(({ label, href, icon: Icon }) => { const active = path === href; return <Link key={href} href={href} onClick={onCloseMobile} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined} className={clsx("relative flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-[13px] font-bold", press, active ? "bg-neutral-900 text-white shadow-sm" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900")}><Icon size={17} strokeWidth={active ? 2.1 : 1.8} /><span className={clsx("flex-1 truncate", collapsed && "lg:hidden")}>{label}</span>{href === "/notifications" && unread > 0 && <span className={clsx("rounded-md px-1.5 py-0.5 text-[10px] font-extrabold", active ? "bg-white/15 text-white" : "bg-primary-50 text-primary-700", collapsed && "lg:absolute lg:right-1 lg:top-1 lg:h-2 lg:w-2 lg:p-0 lg:text-transparent")}>{unread}</span>}</Link>; })}</div>
        <div className="mt-5 border-t border-neutral-100 pt-4"><p className={clsx("mb-2 px-3 text-[10px] font-extrabold uppercase tracking-[.1em] text-neutral-400", collapsed && "lg:text-center")}><span className="lg:hidden">Venture spaces</span><span className="hidden lg:inline">{collapsed ? "•••" : "Venture spaces"}</span></p>{data.ventures.map((venture) => <Link key={venture.id} href={`/ventures?venture=${venture.id}`} onClick={onCloseMobile} title={venture.name} className={clsx("mb-0.5 flex min-h-10 items-center gap-2.5 rounded-xl px-2.5 text-left hover:bg-neutral-50", press)}><span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[10px] font-extrabold text-white", venture.color)}>{venture.short}</span><span className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}><span className="block truncate text-xs font-extrabold text-neutral-800">{venture.name}</span><span className="block truncate text-[10px] font-medium text-neutral-400">{venture.stage}</span></span></Link>)}</div>
        <div className={clsx("mt-4 rounded-xl bg-neutral-50 p-2", collapsed && "lg:hidden")}><div className="mb-1 flex items-center gap-2 px-2 py-1"><Users size={14} className="text-neutral-400" /><p className="text-[10px] font-extrabold uppercase tracking-[.08em] text-neutral-500">Buildory · Core team</p></div>{data.channels.filter((channel) => channel.groupId === "buildory-core").map((channel) => <Link key={channel.id} href={`/channels?channel=${channel.id}`} onClick={onCloseMobile} className={clsx("flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-neutral-500 hover:bg-white", press)}><Hash size={14} /><span className="flex-1">{channel.name}</span>{channel.unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-primary-600" />}</Link>)}</div>
      </nav>
      <div className="border-t border-neutral-100 p-3"><Link href="/settings" onClick={onCloseMobile} className={clsx("mb-1 flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 text-xs font-bold text-neutral-500 hover:bg-neutral-100", press)}><Settings size={16} /><span className={clsx(collapsed && "lg:hidden")}>Settings</span></Link><Link href="/admin" onClick={onCloseMobile} className={clsx("mb-1 flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 text-xs font-bold text-neutral-500 hover:bg-neutral-100", press)}><Users size={16} /><span className={clsx(collapsed && "lg:hidden")}>People & access</span></Link><div className={clsx("flex min-h-11 items-center gap-2.5 rounded-xl bg-neutral-50 px-2.5", collapsed && "lg:justify-center lg:px-1")}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-extrabold text-white">{currentUser.initials}</span><span className={clsx("min-w-0", collapsed && "lg:hidden")}><span className="block truncate text-xs font-extrabold text-neutral-800">{currentUser.name}</span><span className="block truncate text-[10px] font-medium text-neutral-400">Demo identity</span></span></div></div>
    </aside>
  </>;
}
