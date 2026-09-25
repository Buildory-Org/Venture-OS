"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { FocusDock } from "./ai-dock";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { workspaceHref } from "./workspace-link";

export function AppShell({ children, connected = false }: { children: React.ReactNode; connected?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusInstant, setFocusInstant] = useState(false);
  const [revealedChatPath, setRevealedChatPath] = useState<string | null>(null);
  const [departurePath, setDeparturePath] = useState<string | null>(null);
  const departureTimer = useRef<number | null>(null);
  const lastEscape = useRef(0);
  const isChat = /^\/(?:demo\/)?(?:channels|messages)(?:\/live)?$/.test(pathname);
  const immersive = isChat && revealedChatPath !== pathname;
  const departing = departurePath === pathname;

  useEffect(() => () => {
    if (departureTimer.current !== null) window.clearTimeout(departureTimer.current);
  }, []);

  useEffect(() => {
    lastEscape.current = 0;
    queueMicrotask(() => setDeparturePath(null));
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "/") {
        event.preventDefault();
        if (connected) { router.push("/focus/live"); return; }
        setFocusInstant(true);
        setFocusOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setFocusInstant(true);
        setFocusOpen(false);
        setMobileOpen(false);
        const mobileChat = isChat && window.matchMedia("(max-width: 1023px)").matches;
        if (mobileChat && mobileOpen) { lastEscape.current = 0; return; }
        if (isChat && (immersive || mobileChat) && !event.repeat && !event.defaultPrevented) {
          // Let the first Escape dismiss any chat dialog before counting a pair.
          if (document.querySelector('[role="dialog"][aria-modal="true"], [role="combobox"][aria-expanded="true"]')) {
            lastEscape.current = 0;
            return;
          }
          const now = Date.now();
          if (now - lastEscape.current < 650) {
            lastEscape.current = 0;
            setRevealedChatPath(pathname);
            if (mobileChat) setMobileOpen(true);
          } else lastEscape.current = now;
        }
      }
    };
    const onFocusRequest = () => {
      if (connected) { router.push("/focus/live"); return; }
      setFocusInstant(false);
      setFocusOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("venture:focus-sprint", onFocusRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("venture:focus-sprint", onFocusRequest);
    };
  }, [connected, immersive, isChat, mobileOpen, pathname, router]);

  const openChat = (href: string, event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.detail === 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const destination = workspaceHref(href, connected ? "connected" : "demo");
    if (departureTimer.current !== null) window.clearTimeout(departureTimer.current);
    setDeparturePath(pathname);
    const finish = () => {
      departureTimer.current = null;
      if (destination.split("?")[0] === pathname) {
        setRevealedChatPath(null);
        setDeparturePath(null);
      } else router.push(destination);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else departureTimer.current = window.setTimeout(finish, 220);
  };

  const toggleFocus = () => {
    setFocusInstant(false);
    setFocusOpen((value) => !value);
  };

  return (
    <div className={clsx("vso-shell flex h-dvh overflow-hidden bg-white", isChat && "vso-shell-chat")} data-chat-motion={departing ? "leaving" : immersive ? "immersive" : "idle"}>
      <div className={clsx("vso-shell-sidebar-slot w-0 shrink-0 lg:overflow-hidden", immersive ? "lg:!w-0" : collapsed ? "lg:w-[76px]" : "lg:w-[248px]")}>
        <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} immersive={immersive} onCloseMobile={() => setMobileOpen(false)} onOpenChat={openChat} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="vso-shell-topbar relative z-20 h-14 shrink-0" aria-hidden={isChat} inert={isChat}>
        {!isChat && <Topbar
          collapsed={collapsed}
          onToggleSidebar={() => setCollapsed((value) => !value)}
          onOpenMobileNav={() => setMobileOpen(true)}
          focusOpen={focusOpen}
          onToggleFocus={toggleFocus}
        />}
        </div>
        <main id="main-content" className={clsx("min-h-0 min-w-0 flex-1 overflow-y-auto bg-canvas", !isChat && "rounded-tl-[22px]")}>
          {!connected && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary-100 bg-primary-50 px-4 py-2 text-xs font-semibold text-primary-900 sm:px-6">
            <span>Demo prototype · Sample records only. Changes here do not reach the connected workspace.</span>
            <Link href="/dashboard/live" className="rounded-lg px-2 py-1 font-extrabold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Open connected workspace</Link>
          </div>}
          {children}
        </main>
      </div>
      {!connected && <FocusDock open={focusOpen} instant={focusInstant} onClose={() => setFocusOpen(false)} />}
    </div>
  );
}
