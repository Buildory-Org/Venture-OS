"use client";

import {
  Banknote,
  FileText,
  LayoutDashboard,
  Package,
  Plus,
  Settings,
  ShoppingCart,
  Sparkles,
  Users,
  Wallet,
  CheckSquare,
  LifeBuoy,
  CircleCheck,
} from "lucide-react";
import clsx from "clsx";

const quickActions = [
  { label: "New Invoice", href: "/sales/invoices/new" },
  { label: "New Order", href: "/sales/orders/new" },
  { label: "New Expense", href: "/finance/expenses/new" },
  { label: "Add Employee", href: "/hr/employees/new" },
];

const modules = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/dashboard", active: true },
  { label: "Sales & CRM", icon: Wallet, href: "/sales" },
  { label: "Purchase", icon: ShoppingCart, href: "/purchase" },
  { label: "Inventory", icon: Package, href: "/inventory", badge: 8 },
  { label: "Finance", icon: Banknote, href: "/finance" },
  { label: "HR", icon: Users, href: "/hr" },
  { label: "Operations", icon: CheckSquare, href: "/operations", badge: 5 },
  { label: "Documents", icon: FileText, href: "/documents" },
  { label: "AI Assistant", icon: Sparkles, href: "/ai/chat", ai: true, tag: "NEW" },
  { label: "Admin", icon: Settings, href: "/admin" },
];

function Row({
  icon: Icon,
  label,
  href,
  active,
  badge,
  ai,
  tag,
  collapsed,
}: {
  icon?: React.ComponentType<{ size?: number | string; strokeWidth?: number }>;
  label: string;
  href: string;
  active?: boolean;
  badge?: number;
  ai?: boolean;
  tag?: string;
  collapsed: boolean;
}) {
  return (
    <a
      href={href}
      title={collapsed ? label : undefined}
      className={clsx(
        "group relative flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-semibold outline-none",
        "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "focus-visible:ring-2 focus-visible:ring-primary-600",
        "active:scale-[0.98]",
        active
          ? "bg-neutral-900 text-white shadow-sm"
          : ai
            ? "text-ai-text hover:bg-ai-surface"
            : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
      )}
    >
      {Icon && <Icon size={18} strokeWidth={active ? 2 : 1.75} />}
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      {!collapsed && badge && (
        <span className="rounded-full bg-danger-surface px-1.5 py-0.5 text-[10px] font-bold leading-none text-danger-text tnum">
          {badge}
        </span>
      )}
      {!collapsed && tag && (
        <span className="rounded-full bg-ai-surface px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-ai-text">
          {tag}
        </span>
      )}
      {collapsed && badge && (
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" />
      )}
    </a>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={clsx(
        "fixed inset-y-0 left-0 z-30 flex flex-col border-r border-neutral-200/70 bg-white pt-14",
        "transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <nav className="thin-scroll flex-1 overflow-y-auto px-3 py-4">
        {/* Quick actions */}
        {!collapsed && (
          <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.09em] text-neutral-400">
            Quick actions
          </p>
        )}
        <div className={clsx("grid gap-1.5", collapsed ? "grid-cols-1" : "grid-cols-2")}>
          {quickActions.map((q) => (
            <a
              key={q.label}
              href={q.href}
              title={q.label}
              className={clsx(
                "flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-neutral-600",
                "transition-[color,background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600",
                "active:scale-[0.96]",
                collapsed && "justify-center rounded-xl"
              )}
            >
              <Plus size={13} strokeWidth={2.25} className="text-primary-600" />
              {!collapsed && <span className="truncate">{q.label}</span>}
            </a>
          ))}
        </div>

        {/* Modules */}
        <p
          className={clsx(
            "px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.09em] text-neutral-400",
            collapsed ? "mt-6 text-center" : "mt-7"
          )}
        >
          {collapsed ? "···" : "Workspace"}
        </p>
        <div className="space-y-1">
          {modules.map((m) => (
            <Row key={m.label} {...m} collapsed={collapsed} />
          ))}
        </div>

        <p
          className={clsx(
            "px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.09em] text-neutral-400",
            collapsed ? "mt-6 text-center" : "mt-7"
          )}
        >
          {collapsed ? "···" : "Support"}
        </p>
        <div className="space-y-1">
          <Row icon={LifeBuoy} label="Help Desk" href="/help" collapsed={collapsed} />
          <Row icon={CircleCheck} label="System status" href="/status" collapsed={collapsed} />
        </div>
      </nav>

      {/* Sync status footer */}
      {!collapsed && (
        <div className="border-t border-neutral-100 p-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-neutral-50 px-3.5 py-2.5">
            <span className="h-2 w-2 rounded-full bg-success" />
            <p className="text-[11px] font-semibold text-neutral-500">
              Data synced · <span className="tnum">10:42 am</span>
            </p>
          </div>
        </div>
      )}
      {collapsed && <div className="h-3" />}
    </aside>
  );
}
