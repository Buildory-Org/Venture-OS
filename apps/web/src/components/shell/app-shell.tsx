"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FocusDock } from "./ai-dock";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusInstant, setFocusInstant] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "/") {
        event.preventDefault();
        setFocusInstant(true);
        setFocusOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setFocusInstant(true);
        setFocusOpen(false);
        setMobileOpen(false);
      }
    };
    const onFocusRequest = () => {
      setFocusInstant(false);
      setFocusOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("venture:focus-sprint", onFocusRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("venture:focus-sprint", onFocusRequest);
    };
  }, []);

  const toggleFocus = () => {
    setFocusInstant(false);
    setFocusOpen((value) => !value);
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-white">
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          collapsed={collapsed}
          onToggleSidebar={() => setCollapsed((value) => !value)}
          onOpenMobileNav={() => setMobileOpen(true)}
          focusOpen={focusOpen}
          onToggleFocus={toggleFocus}
        />
        <main id="main-content" className="min-w-0 flex-1 overflow-y-auto rounded-tl-[22px] bg-canvas">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-900 sm:px-6">
            <span>Demo prototype · Sample records only. Changes here do not reach the connected workspace.</span>
            <Link href="/dashboard/live" className="rounded-lg px-2 py-1 font-extrabold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Open connected workspace</Link>
          </div>
          {children}
        </main>
      </div>
      <FocusDock open={focusOpen} instant={focusInstant} onClose={() => setFocusOpen(false)} />
    </div>
  );
}
