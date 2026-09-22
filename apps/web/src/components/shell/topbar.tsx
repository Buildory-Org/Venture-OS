"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiMagicIcon,
  ArrowDown01Icon,
  Notification02Icon,
  PlusSignIcon,
  Search01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { Menu, PanelLeftOpen, TimerReset } from "lucide-react";
import clsx from "clsx";

const results = [
  { title: "Finalize onboarding decision", meta: "Task · Northstar Labs" },
  { title: "# product", meta: "Channel · Builder group" },
  { title: "Maya Chen", meta: "Member · Product lead" },
  { title: "Weekly venture review", meta: "Note · Updated 2h ago" },
];

type TopbarProps = {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMobileNav: () => void;
  focusOpen: boolean;
  onToggleFocus: () => void;
};

const iconButton = "relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

export function Topbar({ collapsed, onToggleSidebar, onOpenMobileNav, focusOpen, onToggleFocus }: TopbarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = results.filter((result) => result.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 bg-white px-3 sm:px-4">
      <button type="button" onClick={onOpenMobileNav} className={clsx(iconButton, "lg:hidden")} aria-label="Open navigation"><Menu size={18} strokeWidth={1.9} /></button>
      <button type="button" onClick={onToggleSidebar} className={clsx(iconButton, "hidden lg:grid")} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
        {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.8} /> : <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.8} />}
      </button>

      <div className="hidden min-w-0 items-center gap-2 px-1 sm:flex">
        <span className="truncate text-xs font-bold text-neutral-400">Meridian Studio</span>
        <span className="text-neutral-300">/</span>
        <button type="button" className="flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-extrabold text-neutral-800 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]">
          Northstar Labs <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.8} className="text-neutral-400" />
        </button>
      </div>

      <div className="mx-auto w-full max-w-[520px] px-1 sm:px-3">
        <button type="button" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }} className="flex h-10 w-full items-center gap-2.5 rounded-xl bg-neutral-100 px-3.5 text-[13px] text-neutral-400 transition-[background-color,transform] duration-150 hover:bg-neutral-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]">
          <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-left">Search tasks, messages, notes…</span>
          <kbd className="hidden rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neutral-400 shadow-sm md:block">Ctrl K</kbd>
        </button>
      </div>

      <button type="button" className="hidden h-10 items-center gap-1.5 rounded-xl bg-neutral-900 px-3.5 text-xs font-extrabold text-white transition-[background-color,transform] duration-150 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 active:scale-[0.97] md:flex">
        <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2.2} /> New
      </button>
      <button type="button" onClick={onToggleFocus} aria-label="Toggle focus sprint" aria-pressed={focusOpen} className={clsx(iconButton, focusOpen ? "bg-primary-100 text-primary-700" : "text-primary-600 hover:bg-primary-50")}><TimerReset size={18} strokeWidth={1.9} /></button>
      <button type="button" aria-label="Notifications, 3 unread" className={iconButton}>
        <HugeiconsIcon icon={Notification02Icon} size={18} strokeWidth={1.8} />
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-white" />
      </button>
      <button type="button" aria-label="Open studio assistant" className={clsx(iconButton, "hidden text-ai hover:bg-ai-surface sm:grid")}><HugeiconsIcon icon={AiMagicIcon} size={18} strokeWidth={1.8} /></button>
      <button type="button" aria-label="Open account menu" className="hidden min-h-10 items-center gap-2 rounded-xl px-1.5 pr-2.5 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] xl:flex">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-extrabold text-white">AM</span>
        <span className="text-left"><span className="block text-xs font-extrabold text-neutral-800">Alex Morgan</span><span className="block text-[10px] font-semibold text-neutral-400">Studio lead</span></span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.8} className="text-neutral-400" />
      </button>

      {searchOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/20 px-4 pt-[11vh] backdrop-blur-[2px]" onMouseDown={(event) => event.target === event.currentTarget && setSearchOpen(false)}>
          <section role="dialog" aria-modal="true" aria-label="Search workspace" className="w-full max-w-[560px] overflow-hidden rounded-2xl bg-white p-2 shadow-e4 ring-1 ring-neutral-900/5">
            <div className="flex items-center gap-3 px-3">
              <HugeiconsIcon icon={Search01Icon} size={18} strokeWidth={1.8} className="text-neutral-400" />
              <input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Meridian Studio" className="h-12 min-w-0 flex-1 bg-transparent text-sm font-semibold text-neutral-900 outline-none placeholder:text-neutral-400" />
              <kbd className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-[10px] font-semibold text-neutral-500">Esc</kbd>
            </div>
            <div className="border-t border-neutral-100 p-1.5">
              {filtered.map((result) => (
                <button key={result.title} type="button" onClick={() => setSearchOpen(false)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors duration-100 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-50 text-primary-600"><HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.8} /></span>
                  <span><span className="block text-xs font-extrabold text-neutral-800">{result.title}</span><span className="block text-[11px] font-medium text-neutral-400">{result.meta}</span></span>
                </button>
              ))}
              {filtered.length === 0 && <p className="px-3 py-8 text-center text-sm font-medium text-neutral-400">No results in this workspace.</p>}
            </div>
          </section>
        </div>
      )}
    </header>
  );
}
