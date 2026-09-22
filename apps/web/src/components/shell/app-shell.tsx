"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { AiDock } from "./ai-dock";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setAiOpen((v) => !v);
      }
      if (e.key === "Escape") setAiOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-dvh">
      {/* rounded white app frame */}
      <div className="relative flex h-full flex-col overflow-hidden bg-white">
        <Topbar
          collapsed={collapsed}
          onToggleSidebar={() => setCollapsed((v) => !v)}
          aiOpen={aiOpen}
          onToggleAi={() => setAiOpen((v) => !v)}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={collapsed} />
          <main className="min-w-0 flex-1 overflow-y-auto rounded-tl-[24px] bg-canvas">
            {children}
          </main>
        </div>
        <div id="drawer-root" />
        <AiDock open={aiOpen} onClose={() => setAiOpen(false)} />
      </div>
    </div>
  );
}
