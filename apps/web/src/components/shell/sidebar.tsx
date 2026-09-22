"use client";

import {
  Bell,
  ChevronDown,
  ClipboardCheck,
  Hash,
  Home,
  LayoutDashboard,
  MessageCircle,
  Plus,
  Rocket,
  Settings,
  X,
} from "lucide-react";
import clsx from "clsx";

const ventures = [
  { name: "Northstar Labs", initials: "NL", color: "bg-primary-600", active: true },
  { name: "Lattice Health", initials: "LH", color: "bg-emerald-600" },
  { name: "Fieldnote", initials: "FN", color: "bg-amber-500" },
];

const navigation = [
  { label: "Home", icon: Home, active: true },
  { label: "My work", icon: ClipboardCheck, badge: 7 },
  { label: "Kanban", icon: LayoutDashboard },
  { label: "Mentions", icon: Bell, badge: 3 },
];

const channels = [
  { label: "general", unread: false },
  { label: "product", unread: true },
  { label: "go-to-market", unread: false },
];

type SidebarProps = {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

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
          "absolute inset-y-0 left-0 z-40 flex shrink-0 flex-col bg-white shadow-e3 transition-[width,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] lg:relative lg:z-0 lg:translate-x-0 lg:shadow-none",
          collapsed ? "lg:w-[76px]" : "lg:w-[264px]",
          mobileOpen ? "w-[280px] translate-x-0" : "w-[280px] -translate-x-full"
        )}
      >
        <div className="flex h-16 shrink-0 items-center gap-2.5 px-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-neutral-900 text-white shadow-sm">
            <Rocket size={17} strokeWidth={2} />
          </div>
          <div className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}>
            <p className="truncate text-sm font-extrabold tracking-tight text-neutral-900">Venture Studio</p>
            <p className="truncate text-xs font-medium text-neutral-400">Operator workspace</p>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation"
            className="grid h-10 w-10 place-items-center rounded-xl text-neutral-500 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96] lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="thin-scroll flex-1 overflow-y-auto px-3 pb-4">
          <div className="mb-5">
            <p className={clsx("mb-2 px-3 text-[11px] font-bold uppercase tracking-[0.1em] text-neutral-400", collapsed && "lg:text-center")}>
              <span className="lg:hidden">Ventures</span>
              <span className="hidden lg:inline">{collapsed ? "•••" : "Ventures"}</span>
            </p>
            <div className="space-y-1">
              {ventures.map((venture) => (
                <button
                  key={venture.name}
                  type="button"
                  title={collapsed ? venture.name : undefined}
                  className={clsx(
                    "flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 text-left text-sm font-semibold transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]",
                    venture.active ? "bg-primary-50 text-primary-800" : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
                  )}
                >
                  <span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[11px] font-extrabold text-white", venture.color)}>{venture.initials}</span>
                  <span className={clsx("flex-1 truncate", collapsed && "lg:hidden")}>{venture.name}</span>
                  {venture.active && <ChevronDown size={15} className={clsx("text-primary-400", collapsed && "lg:hidden")} />}
                </button>
              ))}
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 text-sm font-semibold text-neutral-400 transition-[color,background-color,transform] duration-150 hover:bg-neutral-50 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-dashed border-neutral-300"><Plus size={15} /></span>
                <span className={clsx(collapsed && "lg:hidden")}>Add venture</span>
              </button>
            </div>
          </div>

          <div className="mb-5 border-t border-neutral-100 pt-5">
            <p className={clsx("mb-2 px-3 text-[11px] font-bold uppercase tracking-[0.1em] text-neutral-400", collapsed && "lg:text-center")}>
              <span className="lg:hidden">Workspace</span>
              <span className="hidden lg:inline">{collapsed ? "•••" : "Workspace"}</span>
            </p>
            <div className="space-y-1">
              {navigation.map(({ label, icon: Icon, active, badge }) => (
                <button
                  key={label}
                  type="button"
                  title={collapsed ? label : undefined}
                  className={clsx(
                    "relative flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]",
                    active ? "bg-neutral-900 text-white shadow-sm" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                  )}
                >
                  <Icon size={18} strokeWidth={active ? 2 : 1.7} className="shrink-0" />
                  <span className={clsx("flex-1 text-left", collapsed && "lg:hidden")}>{label}</span>
                  {badge && <span className={clsx("rounded-full px-2 py-0.5 text-xs font-bold tnum", active ? "bg-white/15" : "bg-neutral-100 text-neutral-600", collapsed && "lg:absolute lg:right-1 lg:top-1 lg:h-2 lg:w-2 lg:p-0 lg:text-transparent")}>{badge}</span>}
                </button>
              ))}
            </div>
          </div>

          <div className={clsx("border-t border-neutral-100 pt-5", collapsed && "lg:hidden")}>
            <div className="mb-2 flex items-center justify-between px-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-neutral-400">Builder group</p>
              <button type="button" aria-label="Add channel" className="grid h-9 w-9 place-items-center rounded-xl text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"><Plus size={15} /></button>
            </div>
            <div className="space-y-1">
              {channels.map((channel) => (
                <button key={channel.label} type="button" className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]">
                  <Hash size={16} strokeWidth={1.75} />
                  <span className="flex-1 text-left">{channel.label}</span>
                  {channel.unread && <span className="h-2 w-2 rounded-full bg-primary-600" aria-label="Unread messages" />}
                </button>
              ))}
            </div>
          </div>
        </nav>

        <div className="border-t border-neutral-100 p-3">
          <button type="button" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]">
            <Settings size={18} strokeWidth={1.7} />
            <span className={clsx("flex-1 text-left", collapsed && "lg:hidden")}>Settings</span>
          </button>
          <div className={clsx("mt-1 flex items-center gap-3 rounded-xl bg-neutral-50 px-3 py-2.5", collapsed && "lg:justify-center lg:px-1")}>
            <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-xs font-extrabold text-white">
              AM
              <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-success ring-2 ring-white" />
            </span>
            <div className={clsx("min-w-0 flex-1", collapsed && "lg:hidden")}>
              <p className="truncate text-sm font-bold text-neutral-800">Alex Morgan</p>
              <p className="truncate text-xs text-neutral-400">Studio lead</p>
            </div>
            <MessageCircle size={16} className={clsx("text-neutral-400", collapsed && "lg:hidden")} />
          </div>
        </div>
      </aside>
    </>
  );
}
