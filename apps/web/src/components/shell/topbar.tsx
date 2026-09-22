"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SidebarLeftIcon,
  Search01Icon,
  Notification02Icon,
  FlashIcon,
  AiMagicIcon,
  ArrowDown01Icon,
  PlusSignIcon,
  Building06Icon,
  UserIcon,
  Setting07Icon,
  Logout01Icon,
  Invoice01Icon,
  ShoppingCart01Icon,
  MoneyBag01Icon,
  UserAdd01Icon,
  CheckmarkCircle01Icon,
  Alert02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import clsx from "clsx";
import { Dropdown } from "@/components/ui/dropdown";
import { Drawer, drawerForms } from "@/components/ui/drawer";

const iconBtn =
  "relative grid h-9 w-9 place-items-center rounded-full text-neutral-500 " +
  "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] " +
  "hover:bg-neutral-100 hover:text-neutral-800 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 " +
  "active:scale-[0.96]";

const branches = ["Delhi HQ", "Jaipur", "Lucknow"];

const notifications = [
  { icon: Alert02Icon, tone: "text-danger", text: "GST filing due in 5 days", when: "2h" },
  { icon: CheckmarkCircle01Icon, tone: "text-success", text: "PO-116 marked received", when: "4h" },
  { icon: InformationCircleIcon, tone: "text-primary-600", text: "Payroll run due in 2 days", when: "1d" },
];

const searchLinks = [
  { label: "Invoices", href: "/sales?tab=invoices" },
  { label: "Customers", href: "/sales?tab=customers" },
  { label: "Purchase orders", href: "/purchase" },
  { label: "Stock", href: "/inventory" },
  { label: "Employees", href: "/hr" },
  { label: "Approvals", href: "/operations" },
  { label: "Documents", href: "/documents" },
  { label: "Ask AI", href: "/ai/chat" },
];

export function Topbar({
  collapsed,
  onToggleSidebar,
  aiOpen,
  onToggleAi,
}: {
  collapsed: boolean;
  onToggleSidebar: () => void;
  aiOpen: boolean;
  onToggleAi: () => void;
}) {
  const router = useRouter();
  const [branch, setBranch] = useState("Delhi HQ");
  const [form, setForm] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");

  const quickItems = [
    { label: "New Invoice", icon: Invoice01Icon, onClick: () => setForm("invoice") },
    { label: "New Order", icon: ShoppingCart01Icon, onClick: () => setForm("order") },
    { label: "New Expense", icon: MoneyBag01Icon, onClick: () => setForm("expense") },
    { label: "Add Employee", icon: UserAdd01Icon, onClick: () => setForm("employee") },
  ];

  const results = searchLinks.filter((l) =>
    l.label.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 bg-white px-4">
      {/* Left — toggle + brand + branch */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          className={iconBtn}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
        </button>

        <a href="/dashboard" className="flex items-center gap-2 rounded-lg px-1 py-1">
          <span className="grid h-7.5 w-7.5 place-items-center rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 p-1.5">
            <HugeiconsIcon icon={FlashIcon} size={15} strokeWidth={2.25} className="text-white" />
          </span>
          <span className="text-[15px] font-extrabold tracking-tight text-neutral-900">
            AIBOS
          </span>
        </a>

        {/* Branch switcher */}
        <Dropdown
          align="left"
          items={branches.map((b) => ({
            label: b,
            icon: Building06Icon,
            onClick: () => setBranch(b),
          }))}
          trigger={
            <button
              type="button"
              className="ml-1 hidden items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 text-[12px] font-semibold text-neutral-700 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] sm:flex"
            >
              <HugeiconsIcon icon={Building06Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
              {branch}
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
      </div>

      {/* Center — search palette */}
      <div className="relative flex flex-1 justify-center px-4">
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className="flex h-10 w-full max-w-md items-center gap-2.5 rounded-full bg-neutral-100 px-4 text-[13px] text-neutral-400 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]"
        >
          <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.75} />
          <span className="flex-1 text-left">Search invoices, customers, items…</span>
          <kbd className="hidden items-center gap-0.5 rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium text-neutral-500 sm:flex">
            Ctrl K
          </kbd>
        </button>

        {searchOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSearchOpen(false)} />
            <div className="animate-page-in absolute top-12 z-50 w-full max-w-md rounded-2xl bg-white p-2 ring-1 ring-neutral-900/5" style={{ animationDuration: "150ms" }}>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && results[0]) {
                    router.push(results[0].href);
                    setSearchOpen(false);
                  }
                  if (e.key === "Escape") setSearchOpen(false);
                }}
                placeholder="Type to jump anywhere…"
                className="h-10 w-full rounded-xl bg-neutral-100 px-3.5 text-[13px] font-medium text-neutral-800 placeholder:text-neutral-400 focus:outline-none"
              />
              <div className="mt-1.5">
                {results.map((r) => (
                  <button
                    key={r.href}
                    type="button"
                    onClick={() => {
                      router.push(r.href);
                      setSearchOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[12.5px] font-semibold text-neutral-700 transition-colors duration-100 hover:bg-neutral-100"
                  >
                    <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.5} className="text-neutral-300" />
                    {r.label}
                  </button>
                ))}
                {results.length === 0 && (
                  <p className="px-3 py-3 text-[12px] text-neutral-400">No matches for &ldquo;{q}&rdquo;</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-1.5">
        {/* + New — quick actions moved from sidebar */}
        <Dropdown
          align="right"
          items={quickItems}
          trigger={
            <button
              type="button"
              className="mr-1 flex h-9 items-center gap-1.5 rounded-full bg-neutral-900 px-3.5 text-[12px] font-bold text-white transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 active:scale-[0.96]"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
              New
              <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.75} className="text-white/60" />
            </button>
          }
        />

        <div className="mr-1 hidden items-center rounded-full bg-neutral-100 p-0.5 text-[11px] font-bold md:flex">
          <span className="rounded-full bg-neutral-900 px-2.5 py-1 text-white">EN</span>
          <span className="px-2.5 py-1 text-neutral-500">हिं</span>
        </div>

        {/* Notifications */}
        <Dropdown
          align="right"
          items={[
            ...notifications.map((n) => ({
              label: `${n.text} · ${n.when}`,
              icon: n.icon,
            })),
            "divider" as const,
            { label: "View all alerts", href: "/dashboard" },
          ]}
          trigger={
            <button type="button" className={iconBtn} aria-label="Notifications">
              <HugeiconsIcon icon={Notification02Icon} size={18} strokeWidth={1.75} />
              <span className="absolute right-1 top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-danger px-0.5 text-[9px] font-bold leading-none text-white tnum ring-2 ring-white">
                3
              </span>
            </button>
          }
        />

        {/* AI toggle */}
        <button
          type="button"
          onClick={onToggleAi}
          aria-label="Toggle AI assistant"
          aria-pressed={aiOpen}
          className={clsx(iconBtn, aiOpen ? "bg-ai-surface text-ai" : "text-ai hover:bg-ai-surface")}
        >
          <HugeiconsIcon icon={AiMagicIcon} size={18} strokeWidth={1.75} />
        </button>

        {/* User menu */}
        <Dropdown
          align="right"
          items={[
            { label: "Profile", icon: UserIcon, href: "/hr?tab=employees" },
            { label: "Settings", icon: Setting07Icon, href: "/admin" },
            "divider",
            { label: "Sign out", icon: Logout01Icon, href: "/logout", danger: true },
          ]}
          trigger={
            <button
              type="button"
              className="ml-1 flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2.5 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"
            >
              <span className="grid h-8.5 w-8.5 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-600 text-[12px] font-bold text-white">
                RK
              </span>
              <span className="hidden text-left leading-tight lg:block">
                <span className="block text-[12px] font-bold text-neutral-800">Rajesh Kumar</span>
                <span className="block text-[10px] font-medium text-neutral-400">Owner</span>
              </span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
      </div>

      {/* Quick-action create drawer */}
      <Drawer
        open={form !== null}
        onClose={() => setForm(null)}
        title={form ? drawerForms[form].title : ""}
        fields={form ? drawerForms[form].fields : []}
        submitLabel={form ? drawerForms[form].submitLabel : "Save"}
      />
    </header>
  );
}
