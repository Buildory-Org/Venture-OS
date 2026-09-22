"use client";

import {
  Bell,
  ChevronDown,
  Columns3,
  FileText,
  Hash,
  Home,
  Layers3,
  ListTodo,
  Plus,
  Settings,
  Users,
  X,
} from "lucide-react";
import clsx from "clsx";

const navItems = [
  { label: "Overview", icon: Home, active: true },
  { label: "My work", icon: ListTodo, badge: 7 },
  { label: "Board", icon: Columns3 },
  { label: "Inbox", icon: Bell, badge: 3 },
];

const ventures = [
  { name: "Northstar Labs", initials: "NL", stage: "Validate", tone: "bg-primary-600", active: true },
  { name: "Lattice Health", initials: "LH", stage: "Discover", tone: "bg-emerald-600" },
  { name: "Fieldnote", initials: "FN", stage: "Explore", tone: "bg-amber-500" },
];

const channels = [
  { label: "general" },
  { label: "product", unread: true },
  { label: "go-to-market" },
];

type SidebarProps = {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

const pressable = "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

export function Sidebar({ collapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onCloseMobile}
        className={clsx(
          "fixed inset-0 z-30 bg-neutral-900/20 backdrop-blur-[2px] transition-opacity duration-150 lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <aside
        aria-label="Workspace navigation"
        className={clsx(
          "absolute inset-y-0 left-0 z-40 flex w-[292px] shrink-0 flex-col border-r border-neutral-100 bg-white shadow-e3 transition-[width,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] lg:relative lg:z-0 lg:translate-x-0 lg:shadow-none",
          collapsed ? "lg:w-[76px]" : "lg:w-[248px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm">
            <Layers3 size={16} strokeWidth={2.2} />
          </span>
          <div className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}>
            <p className="truncate text-sm font-extrabold tracking-tight text-neutral-900">Venture Studio</p>
            <p className="truncate text-[11px] font-semibold text-neutral-400">Meridian workspace</p>
          </div>
          <button type="button" onClick={onCloseMobile} aria-label="Close navigation" className={clsx("grid h-10 w-10 place-items-center rounded-xl text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800 lg:hidden", pressable)}>
            <X size={17} />
          </button>
        </div>

        <nav className="thin-scroll flex-1 overflow-y-auto px-3 pb-3">
          <button
            type="button"
            title={collapsed ? "Meridian Studio" : undefined}
            className={clsx("mb-4 flex min-h-11 w-full items-center gap-2.5 rounded-xl bg-neutral-50 px-3 text-left hover:bg-neutral-100", pressable)}
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-[10px] font-extrabold text-neutral-700 shadow-sm">MS</span>
            <span className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}>
              <span className="block truncate text-xs font-bold text-neutral-800">Meridian Studio</span>
              <span className="block truncate text-[10px] font-medium text-neutral-400">3 ventures · 18 people</span>
            </span>
            <ChevronDown size={14} className={clsx("text-neutral-400", collapsed && "lg:hidden")} />
          </button>

          <div className={clsx("grid gap-2", collapsed ? "lg:grid-cols-1" : "grid-cols-2")}>
            <button type="button" className={clsx("flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-neutral-900 px-3 text-xs font-bold text-white hover:bg-neutral-800", pressable)}>
              <Plus size={14} strokeWidth={2.4} />
              <span className={clsx(collapsed && "lg:hidden")}>Task</span>
            </button>
            <button type="button" className={clsx("flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-primary-50 px-3 text-xs font-bold text-primary-700 hover:bg-primary-100", pressable)}>
              <FileText size={14} strokeWidth={2} />
              <span className={clsx(collapsed && "lg:hidden")}>Note</span>
            </button>
          </div>

          <p className={clsx("mb-2 mt-6 px-3 text-[10px] font-extrabold uppercase tracking-[0.1em] text-neutral-400", collapsed && "lg:text-center")}>
            <span className="lg:hidden">Work</span>
            <span className="hidden lg:inline">{collapsed ? "•••" : "Work"}</span>
          </p>
          <div className="space-y-1">
            {navItems.map(({ label, icon: Icon, active, badge }) => (
              <button
                key={label}
                type="button"
                title={collapsed ? label : undefined}
                className={clsx(
                  "relative flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] font-bold",
                  pressable,
                  active ? "bg-neutral-900 text-white shadow-sm" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                )}
              >
                <Icon size={17} strokeWidth={active ? 2.1 : 1.8} />
                <span className={clsx("flex-1 text-left", collapsed && "lg:hidden")}>{label}</span>
                {badge && <span className={clsx("rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-extrabold text-neutral-600 tnum", active && "bg-white/15 text-white", collapsed && "lg:absolute lg:right-1 lg:top-1 lg:h-2 lg:w-2 lg:p-0 lg:text-transparent")}>{badge}</span>}
              </button>
            ))}
          </div>

          <div className="mt-6 border-t border-neutral-100 pt-5">
            <div className={clsx("mb-2 flex items-center justify-between px-3", collapsed && "lg:justify-center")}>
              <p className={clsx("text-[10px] font-extrabold uppercase tracking-[0.1em] text-neutral-400", collapsed && "lg:hidden")}>Ventures</p>
              <button type="button" aria-label="Add venture" className={clsx("grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800", pressable)}><Plus size={14} /></button>
            </div>
            <div className="space-y-1">
              {ventures.map((venture) => (
                <button
                  key={venture.name}
                  type="button"
                  title={collapsed ? venture.name : undefined}
                  className={clsx("flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left", pressable, venture.active ? "bg-primary-50" : "hover:bg-neutral-50")}
                >
                  <span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[10px] font-extrabold text-white", venture.tone)}>{venture.initials}</span>
                  <span className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}><span className="block truncate text-xs font-extrabold text-neutral-800">{venture.name}</span><span className="block truncate text-[10px] font-medium text-neutral-400">{venture.stage}</span></span>
                  {venture.active && <span className={clsx("h-1.5 w-1.5 rounded-full bg-primary-600", collapsed && "lg:hidden")} aria-label="Active venture" />}
                </button>
              ))}
            </div>
          </div>

          <div className={clsx("mt-5 rounded-xl bg-neutral-50 p-2", collapsed && "lg:hidden")}>
            <div className="mb-1 flex items-center gap-2 px-2 py-1.5"><Users size={14} className="text-neutral-400" /><p className="flex-1 text-[11px] font-extrabold uppercase tracking-[0.08em] text-neutral-500">Builder group</p><span className="text-[10px] font-bold text-neutral-400">8</span></div>
            {channels.map((channel) => (
              <button key={channel.label} type="button" className={clsx("flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-xs font-semibold text-neutral-500 hover:bg-white hover:text-neutral-900", pressable)}>
                <Hash size={14} /><span className="flex-1 text-left">{channel.label}</span>{channel.unread && <span className="h-1.5 w-1.5 rounded-full bg-primary-600" aria-label="Unread messages" />}
              </button>
            ))}
          </div>
        </nav>

        <div className="border-t border-neutral-100 p-3">
          <div className={clsx("mb-2 flex items-center gap-2 rounded-xl bg-success-surface px-3 py-2", collapsed && "lg:justify-center lg:px-1")}>
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
            <span className={clsx("text-[10px] font-bold text-success-text", collapsed && "lg:hidden")}>Studio synced · 10:42</span>
          </div>
          <button type="button" className={clsx("flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left hover:bg-neutral-100", pressable)}>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-extrabold text-white">AM</span>
            <span className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}><span className="block truncate text-xs font-extrabold text-neutral-800">Alex Morgan</span><span className="block truncate text-[10px] font-medium text-neutral-400">Studio lead</span></span>
            <Settings size={15} className={clsx("text-neutral-400", collapsed && "lg:hidden")} />
          </button>
        </div>
      </aside>
    </>
  );
}
