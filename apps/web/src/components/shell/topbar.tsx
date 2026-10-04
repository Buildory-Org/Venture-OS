"use client";

import { useEffect, useRef, useState } from "react";
import { WorkspaceLink as Link } from "./workspace-link";
import { usePathname } from "next/navigation";
import { Bell, Menu, PanelLeftClose, PanelLeftOpen, Plus, Search, Sparkles, TimerReset } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { LiveNotificationPulse } from "./live-notification-pulse";

type Props = { collapsed: boolean; onToggleSidebar: () => void; onOpenMobileNav: () => void; focusOpen: boolean; onToggleFocus: () => void };
const iconButton = "relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

export function Topbar({ collapsed, onToggleSidebar, onOpenMobileNav, focusOpen, onToggleFocus }: Props) {
  const path = usePathname();
  const { data, currentUserId, mode, workspaceName, role } = useStudio();
  const user = data.people.find((person) => person.id === currentUserId) ?? data.people[0];
  const unread = data.notices.filter((notice) => !notice.read).length;
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => input.current?.focus()); }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const items = [
    ...data.tasks.map((task) => ({ title: task.title, meta: "Task", href: `/tasks?task=${task.id}` })),
    ...data.knowledge.map((doc) => ({ title: doc.title, meta: `${doc.evidenceClass} · Knowledge`, href: `/knowledge?doc=${doc.id}` })),
    ...data.ventures.map((venture) => ({ title: venture.name, meta: "Venture", href: `/ventures?venture=${venture.id}` })),
    ...data.people.map((person) => ({ title: person.name, meta: "Member", href: "/messages" })),
  ].filter((item) => `${item.title} ${item.meta}`.toLowerCase().includes(query.toLowerCase())).slice(0,8);
  // The /demo rewrite resolves to the same page as the unprefixed route during SSR.
  const section = path.replace(/^\/demo(?=\/|$)/, "").split("/").filter(Boolean)[0] ?? "Today";
  return <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 bg-white px-3 sm:px-4">
    <button type="button" onClick={onOpenMobileNav} className={clsx(iconButton,"lg:hidden")} aria-label="Open navigation"><Menu size={18}/></button>
    <button type="button" onClick={onToggleSidebar} className={clsx(iconButton,"hidden lg:grid")} aria-label={collapsed?"Expand navigation":"Collapse navigation"}>{collapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}</button>
    <span className="hidden shrink-0 px-1 text-xs font-semibold capitalize text-neutral-800 lg:block">{section}</span>
    <div className="mx-auto min-w-0 max-w-[520px] flex-1 px-1 sm:px-3"><button type="button" onClick={()=>{setSearchOpen(true);requestAnimationFrame(()=>input.current?.focus());}} className="flex h-10 w-full items-center gap-2.5 rounded-xl bg-neutral-100 px-3.5 text-[13px] text-neutral-400 transition-[background-color,transform] duration-150 hover:bg-neutral-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]"><Search size={15}/><span className="min-w-0 flex-1 truncate text-left">{mode === "connected" ? "Search tasks, people, ventures…" : "Search tasks, knowledge, ventures…"}</span><kbd className="hidden rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neutral-400 shadow-sm md:block">Ctrl K</kbd></button></div>
    {(mode === "demo" || ["admin", "venture_head", "contributor"].includes(role)) && <Link href="/tasks?new=1" className="hidden h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-primary-700 px-3.5 text-xs font-semibold text-white hover:bg-primary-800 md:flex"><Plus size={14}/>New task</Link>}
    {mode === "demo" ? <button type="button" onClick={onToggleFocus} aria-label="Toggle focus sprint" aria-pressed={focusOpen} className={clsx(iconButton,focusOpen?"bg-primary-100 text-primary-700":"text-primary-600 hover:bg-primary-50")}><TimerReset size={18}/></button> : <Link href="/focus" aria-label="Open focus sprint" className={clsx(iconButton,"text-primary-600 hover:bg-primary-50")}><TimerReset size={18}/></Link>}
    <ThemeToggle />
    {mode === "connected" ? <LiveNotificationPulse userId={currentUserId} /> : <Link href="/notifications" aria-label={`Notifications, ${unread} unread`} className={iconButton}><Bell size={18}/>{unread>0&&<span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-white"/>}</Link>}
    <Link href="/knowledge" aria-label="Open studio knowledge and context packets" className={clsx(iconButton,"hidden text-ai hover:bg-ai-surface sm:grid")}><Sparkles size={18}/></Link>
    <Link href={mode === "demo" ? "/settings" : "/admin"} aria-label="Open account and settings" className="hidden min-h-10 shrink-0 items-center gap-2 rounded-xl px-1.5 pr-2.5 hover:bg-neutral-100 2xl:flex"><span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-semibold text-white">{user.initials}</span><span className="text-left"><span className="block text-xs font-semibold text-neutral-800">{user.name}</span><span className="block text-[10px] font-semibold text-neutral-400">{role}</span></span></Link>
    {searchOpen&&<div className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/20 px-4 pt-[11vh] backdrop-blur-[2px]" onMouseDown={(event)=>event.target===event.currentTarget&&setSearchOpen(false)}><section role="dialog" aria-modal="true" aria-label="Search workspace" className="w-full max-w-[560px] overflow-hidden rounded-2xl bg-white p-2 shadow-e4 ring-1 ring-neutral-900/5"><div className="flex items-center gap-3 px-3"><Search size={18} className="text-neutral-400"/><input ref={input} value={query} onChange={(event)=>setQuery(event.target.value)} placeholder={`Search ${workspaceName}`} className="h-12 min-w-0 flex-1 bg-transparent text-sm font-semibold text-neutral-900 outline-none placeholder:text-neutral-400"/><kbd className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-[10px] font-semibold text-neutral-500">Esc</kbd></div><div className="max-h-[60vh] overflow-y-auto border-t border-neutral-100 p-1.5">{items.map((item)=><Link key={`${item.meta}-${item.href}`} href={item.href} onClick={()=>setSearchOpen(false)} className="flex min-h-12 items-center gap-3 rounded-xl px-3 hover:bg-neutral-100"><span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-50 text-primary-600"><Search size={14}/></span><span><span className="block text-xs font-semibold text-neutral-800">{item.title}</span><span className="block text-[11px] font-medium text-neutral-400">{item.meta}</span></span></Link>)}{items.length===0&&<p className="px-3 py-8 text-center text-sm text-neutral-400">No matching records.</p>}</div></section></div>}
  </header>;
}
