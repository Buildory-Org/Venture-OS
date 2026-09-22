"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sparkles,
  TimerReset,
} from "lucide-react";
import clsx from "clsx";

const searchItems = [
  { label: "Finalize onboarding experiment", meta: "Task · Builder group" },
  { label: "# product", meta: "Channel · Northstar Labs" },
  { label: "Lattice Health", meta: "Venture" },
  { label: "Maya Chen", meta: "Member" },
];

type TopbarProps = {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMobileNav: () => void;
  focusOpen: boolean;
  onToggleFocus: () => void;
};

const iconButton = "grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[color,background-color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]";

export function Topbar({ collapsed, onToggleSidebar, onOpenMobileNav, focusOpen, onToggleFocus }: TopbarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = searchItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <header className="relative z-20 flex h-16 shrink-0 items-center gap-2 bg-white px-3 sm:px-5">
      <button type="button" onClick={onOpenMobileNav} className={clsx(iconButton, "lg:hidden")} aria-label="Open navigation">
        <Menu size={19} strokeWidth={1.8} />
      </button>
      <button type="button" onClick={onToggleSidebar} className={clsx(iconButton, "hidden lg:grid")} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
        {collapsed ? <PanelLeftOpen size={19} strokeWidth={1.8} /> : <PanelLeftClose size={19} strokeWidth={1.8} />}
      </button>

      <button type="button" className="ml-0.5 hidden min-h-10 items-center gap-2 rounded-xl bg-neutral-100 px-3.5 text-sm font-bold text-neutral-700 transition-[background-color,transform] duration-150 hover:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96] sm:flex">
        Northstar Labs
        <ChevronDown size={15} className="text-neutral-400" />
      </button>

      <div className="mx-auto w-full max-w-xl px-1 sm:px-4">
        <button
          type="button"
          onClick={() => {
            setSearchOpen(true);
            requestAnimationFrame(() => searchRef.current?.focus());
          }}
          className="flex h-10 w-full items-center gap-2.5 rounded-xl bg-neutral-100 px-3.5 text-sm text-neutral-400 transition-[background-color,transform] duration-150 hover:bg-neutral-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]"
        >
          <Search size={16} strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-left">Search work, people, channels…</span>
          <kbd className="hidden rounded-md bg-white px-2 py-0.5 font-mono text-[11px] font-medium text-neutral-500 shadow-sm lg:block">⌘ K</kbd>
        </button>
      </div>

      <button
        type="button"
        onClick={onToggleFocus}
        aria-pressed={focusOpen}
        className={clsx(
          "hidden h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-bold transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96] sm:flex",
          focusOpen ? "bg-primary-100 text-primary-800" : "bg-primary-50 text-primary-700 hover:bg-primary-100"
        )}
      >
        <TimerReset size={16} strokeWidth={2} />
        Focus
      </button>
      <button
        type="button"
        onClick={onToggleFocus}
        aria-label="Open focus mode"
        aria-pressed={focusOpen}
        className={clsx(iconButton, "text-primary-700 sm:hidden", focusOpen && "bg-primary-100")}
      >
        <TimerReset size={18} strokeWidth={1.9} />
      </button>
      <button type="button" className={iconButton} aria-label="Notifications, 3 unread">
        <Bell size={19} strokeWidth={1.8} />
        <span className="absolute ml-4 mt-[-18px] h-2 w-2 rounded-full bg-danger ring-2 ring-white" />
      </button>
      <button type="button" aria-label="Open assistant" className={clsx(iconButton, "hidden text-ai hover:bg-ai-surface sm:grid")}>
        <Sparkles size={18} strokeWidth={1.8} />
      </button>

      {searchOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/20 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={(event) => event.target === event.currentTarget && setSearchOpen(false)}>
          <section role="dialog" aria-modal="true" aria-label="Search workspace" className="w-full max-w-xl overflow-hidden rounded-2xl bg-white p-2 shadow-e4 ring-1 ring-black/5">
            <div className="flex items-center gap-3 px-3">
              <Search size={18} className="text-neutral-400" />
              <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Northstar Labs" className="h-12 min-w-0 flex-1 bg-transparent text-base font-medium text-neutral-900 outline-none placeholder:text-neutral-400" />
              <kbd className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-[11px] text-neutral-500">Esc</kbd>
            </div>
            <div className="border-t border-neutral-100 p-1.5">
              {results.map((result) => (
                <button key={result.label} type="button" onClick={() => setSearchOpen(false)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-neutral-100 text-neutral-500"><Search size={14} /></span>
                  <span><span className="block text-sm font-bold text-neutral-800">{result.label}</span><span className="block text-xs text-neutral-400">{result.meta}</span></span>
                </button>
              ))}
              {results.length === 0 && <p className="px-3 py-8 text-center text-sm text-neutral-500">No results in this workspace.</p>}
            </div>
          </section>
        </div>
      )}
    </header>
  );
}
