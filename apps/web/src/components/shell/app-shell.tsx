"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { FocusDock } from "./ai-dock";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "/") {
        event.preventDefault();
        setFocusOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setFocusOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-white">
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          collapsed={collapsed}
          onToggleSidebar={() => setCollapsed((value) => !value)}
          onOpenMobileNav={() => setMobileOpen(true)}
          focusOpen={focusOpen}
          onToggleFocus={() => setFocusOpen((value) => !value)}
        />
        <main id="main-content" className="min-w-0 flex-1 overflow-y-auto rounded-tl-[24px] bg-canvas">
          {children}
        </main>
      </div>
      <FocusDock open={focusOpen} onClose={() => setFocusOpen(false)} />
    </div>
  );
}
