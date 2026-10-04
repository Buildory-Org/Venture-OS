"use client";

import { WorkspaceLink as Link } from "./workspace-link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { prefersReducedMotion } from "@/lib/motion";
import { Bell, BookOpenText, CalendarDays, ChevronDown, Columns3, FileQuestion, FolderOpen, Hash, Home, LayoutDashboard, Layers3, ListTodo, MessageSquareText, Plus, Scale, Settings, TrendingUp, Users, X } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";
import { Select } from "@/components/ui/select";
import { CreateVentureDrawer } from "@/components/studio/create-venture-drawer";

const sections = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Today", href: "/today", icon: Home },
  { label: "Ventures", href: "/ventures", icon: Layers3 },
  { label: "Tasks", href: "/tasks", icon: ListTodo },
  { label: "Board", href: "/board", icon: Columns3 },
  { label: "Channels", href: "/channels", icon: Hash },
  { label: "Messages", href: "/messages", icon: MessageSquareText },
  { label: "Notifications", href: "/notifications", icon: Bell },
  { label: "Knowledge", href: "/knowledge", icon: BookOpenText },
  { label: "Decisions", href: "/decisions", icon: Scale },
  { label: "Classes", href: "/classes", icon: CalendarDays },
  { label: "Timeline", href: "/timeline", icon: TrendingUp },
  { label: "Requests", href: "/requests", icon: FileQuestion },
  { label: "Sales", href: "/sales", icon: FolderOpen },
];
const press = "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";
// Scope-menu entry that opens venture creation instead of changing the scope.
const NEW_VENTURE = "__new-venture__";
const desktopQuery = "(min-width: 1024px)";
const watchDesktop = (onChange: () => void) => { const query = window.matchMedia(desktopQuery); query.addEventListener("change", onChange); return () => query.removeEventListener("change", onChange); };
type Props = { collapsed: boolean; instant?: boolean; mobileOpen: boolean; immersive: boolean; onCloseMobile: () => void; onOpenChat: (href: string, event: MouseEvent<HTMLAnchorElement>) => void };
// Decision 1B: the active pill glides between items with a strong in-out curve.
const GLIDE = "transform 180ms cubic-bezier(0.77, 0, 0.175, 1), height 180ms cubic-bezier(0.77, 0, 0.175, 1)";
const plainClick = (event: MouseEvent<HTMLAnchorElement>) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export function Sidebar({ collapsed, instant = false, mobileOpen, immersive, onCloseMobile, onOpenChat }: Props) {
  const { data, currentUserId, mode, workspaceName, role, activeVentureId, setActiveVentureId } = useStudio();
  const rawPath = usePathname().replace(/^\/demo(?=\/|$)/, "") || "/dashboard";
  const path = rawPath.replace(/\/live$/, "");
  // A clicked item highlights at once; the route catches up a moment later.
  const [pending, setPending] = useState<{ from: string; href: string } | null>(null);
  const activePath = pending?.from === path ? pending.href : path;
  // A navigation that never lands (cancelled, failed) must not leave the pill on the wrong item.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(null), 5000);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const navList = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const placed = useRef<{ top: number; height: number } | null>(null);
  const [tip, setTip] = useState<{ label: string; top: number; left: number; instant: boolean } | null>(null);
  const tipTimer = useRef(0);
  const lastTipAt = useRef(0);
  const tipFor = useRef<HTMLElement | null>(null);
  const [ventureMenu, setVentureMenu] = useState<{ path: string; open: boolean } | null>(null);
  const ventureMenuOpen = ventureMenu?.path === path ? ventureMenu.open : path === "/ventures";
  const currentUser = data.people.find((person) => person.id === currentUserId) ?? data.people[0];
  const quickGroup = data.groups.find((group) => !activeVentureId || group.ventureId === activeVentureId);
  const unread = data.notices.filter((notice) => !notice.read).length;
  const router = useRouter();
  const canCreateVenture = mode === "connected" && role === "admin";
  // Only admins can use People & access in a connected workspace.
  const showAccess = mode === "demo" || role === "admin";
  // Below lg the closed drawer is off-canvas; keep it out of the tab order and the accessibility tree.
  const desktop = useSyncExternalStore(watchDesktop, () => window.matchMedia(desktopQuery).matches, () => true);
  const hidden = immersive || (!desktop && !mobileOpen);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (mobileOpen && !desktop && !immersive) closeButton.current?.focus(); }, [mobileOpen, desktop, immersive]);
  // Glide the pill to the active item; layout shifts (the venture list opening) move it without a glide.
  useLayoutEffect(() => {
    const list = navList.current, mark = pill.current;
    if (!list || !mark) return;
    const place = (glide: boolean) => {
      const target = list.querySelector<HTMLElement>("[data-nav-active]");
      if (!target) { mark.style.opacity = "0"; placed.current = null; return; }
      const next = { top: target.offsetTop, height: target.offsetHeight };
      if (placed.current && placed.current.top === next.top && placed.current.height === next.height) return;
      mark.style.transition = glide && placed.current && !prefersReducedMotion() ? GLIDE : "none";
      mark.style.transform = `translateY(${next.top}px)`;
      mark.style.height = `${next.height}px`;
      mark.style.opacity = "1";
      placed.current = next;
      list.dataset.ready = "true";
    };
    place(true);
    const observer = new ResizeObserver(() => place(false));
    observer.observe(list);
    return () => observer.disconnect();
  }, [activePath, collapsed]);
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);
  // Collapsed rail: items marked data-tip show their name — after a short pause for the first, then instantly along the rail.
  function showTip(target: HTMLElement, immediate: boolean) {
    if (!collapsed || !desktop || !target.dataset.tip) return;
    tipFor.current = target;
    const rect = target.getBoundingClientRect();
    const next = { label: target.dataset.tip, top: rect.top + rect.height / 2, left: rect.right + 10 };
    window.clearTimeout(tipTimer.current);
    if (immediate || Date.now() - lastTipAt.current < 400) setTip({ ...next, instant: true });
    else tipTimer.current = window.setTimeout(() => setTip({ ...next, instant: false }), 450);
  }
  function hideTip() {
    window.clearTimeout(tipTimer.current);
    if (tipFor.current) lastTipAt.current = Date.now();
    tipFor.current = null;
    setTip(null);
  }
  const tipTarget = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
  function onTipOver(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return;
    const target = tipTarget(event.target);
    if (target === tipFor.current) return;
    if (target) showTip(target, false); else if (tipFor.current) hideTip();
  }
  function onTipOut(event: PointerEvent<HTMLElement>) { if (tipFor.current && tipTarget(event.relatedTarget) !== tipFor.current) hideTip(); }
  function onTipFocus(event: FocusEvent<HTMLElement>) { const target = tipTarget(event.target); if (target?.matches(":focus-visible")) showTip(target, true); }
  const [creatingVenture, setCreatingVenture] = useState(false);
  // A new venture is unknown to the scope until the shell reloads; hand it over then, unless the member picked another scope meanwhile.
  const [pendingScope, setPendingScope] = useState<{ ventureId: string; from: string } | null>(null);
  useEffect(() => {
    if (!pendingScope) return;
    if (activeVentureId !== pendingScope.from) { queueMicrotask(() => setPendingScope(null)); return; }
    if (!data.ventures.some((venture) => venture.id === pendingScope.ventureId)) return;
    setActiveVentureId(pendingScope.ventureId);
    queueMicrotask(() => setPendingScope(null));
  }, [activeVentureId, data.ventures, pendingScope, setActiveVentureId]);
  return <>
    <button type="button" aria-label="Close navigation" aria-hidden={!(mobileOpen && !immersive)} tabIndex={mobileOpen && !immersive ? 0 : -1} onClick={onCloseMobile} className={clsx("fixed inset-0 z-30 bg-neutral-900/20 backdrop-blur-[2px] transition-opacity duration-200 ease-out lg:hidden", mobileOpen && !immersive ? "opacity-100" : "pointer-events-none opacity-0")} />
    <aside aria-label="Workspace navigation" aria-hidden={hidden} inert={hidden} data-instant={instant || undefined} onPointerOver={onTipOver} onPointerOut={onTipOut} onFocus={onTipFocus} onBlur={() => { if (tipFor.current) hideTip(); }} className={clsx(instant && "!transition-none", "vso-shell-sidebar absolute inset-y-0 left-0 z-40 flex w-[292px] shrink-0 flex-col border-r border-neutral-100 bg-white shadow-e3 transition-[width,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] lg:relative lg:z-0 lg:translate-x-0 lg:shadow-none", collapsed ? "lg:w-[76px]" : "lg:w-[248px]", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm"><Layers3 size={16} /></span><div className={clsx("vso-nav-label min-w-0 flex-1", collapsed && "lg:hidden")}><p className="truncate text-sm font-semibold tracking-tight text-neutral-900">Venture Studio</p><p className="truncate text-[11px] font-semibold text-neutral-400">{workspaceName} workspace</p></div><button ref={closeButton} type="button" onClick={onCloseMobile} aria-label="Close navigation" className={clsx("grid h-10 w-10 place-items-center rounded-xl text-neutral-400 hover:bg-neutral-100 lg:hidden", press)}><X size={17} /></button></div>
      <nav className="thin-scroll flex-1 overflow-y-auto px-3 pb-3" aria-label="Main navigation" onScroll={hideTip}>
        <div className={clsx("mb-4 flex min-h-11 items-center gap-2 rounded-xl bg-neutral-50 px-2", collapsed && "lg:justify-center lg:px-1")}><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-[10px] font-semibold text-neutral-700 shadow-sm">{(data.ventures.find((venture) => venture.id === activeVentureId)?.short ?? workspaceName.slice(0, 2)).toUpperCase()}</span><span className={clsx("vso-nav-label min-w-0 flex-1", collapsed && "lg:hidden")}><Select aria-label="Active venture scope" value={activeVentureId} onChange={(event) => event.target.value === NEW_VENTURE ? setCreatingVenture(true) : setActiveVentureId(event.target.value)} className="!min-h-9 !w-full !border-0 !bg-transparent !px-1 !text-xs !shadow-none"><option value="">All ventures</option>{data.ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}{canCreateVenture && <option value={NEW_VENTURE}><span className="flex items-center gap-1.5 text-primary-700"><Plus size={14} aria-hidden="true" />New venture</span></option>}</Select></span></div>
        <p className={clsx("mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.1em] text-neutral-400", collapsed && "lg:text-center")}><span className="lg:hidden">Workspace</span><span className="hidden lg:inline">{collapsed ? "•••" : "Workspace"}</span></p>
        <div ref={navList} className="vso-nav-list relative space-y-0.5"><span ref={pill} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 rounded-xl bg-primary-700 opacity-0 shadow-sm" />{sections.map(({ label, href, icon: Icon }) => {
          const active = activePath === href;
          const current = path === href;
          if (href === "/ventures") return <div key={href}>
            <div data-nav-active={active || undefined} className={clsx("relative flex items-center rounded-xl transition-colors duration-150", active ? "text-white" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900")}>
              <Link href={href} onClick={(event) => { if (plainClick(event)) setPending(current ? null : { from: path, href }); setVentureMenu({ path: href, open: true }); onCloseMobile(); }} data-tip={collapsed ? label : undefined} aria-label={collapsed ? label : undefined} aria-current={current ? "page" : undefined} className={clsx("flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 text-[13px] font-semibold", press)}><Icon size={17} strokeWidth={active ? 2.1 : 1.8} /><span className={clsx("vso-nav-label flex-1 truncate", collapsed && "lg:hidden")}>{label}</span></Link>
              <button type="button" aria-label="Toggle venture spaces" aria-expanded={ventureMenuOpen} onClick={() => setVentureMenu({ path, open: !ventureMenuOpen })} className={clsx("mr-1 grid h-9 w-9 place-items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", collapsed && "lg:hidden")}><ChevronDown size={15} className={clsx("transition-transform duration-150", ventureMenuOpen && "rotate-180")} /></button>
            </div>
            <div aria-label="Venture spaces" aria-hidden={!ventureMenuOpen} inert={!ventureMenuOpen} className={clsx("vso-venture-menu ml-5 border-l border-neutral-200 pl-2", ventureMenuOpen && "is-open", collapsed && "lg:hidden")}><div className="space-y-0.5 py-1">{data.ventures.map((venture, index) => <Link key={venture.id} href={`/ventures?venture=${venture.id}`} onClick={() => { setActiveVentureId(venture.id); onCloseMobile(); }} style={{ "--venture-index": index } as React.CSSProperties} className={clsx("vso-venture-entry flex min-h-10 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-neutral-600 hover:bg-primary-50 hover:text-primary-800", press)}><span className={clsx("grid h-6 w-6 shrink-0 place-items-center rounded-md text-[9px] font-semibold text-white", venture.color)}>{venture.short}</span><span className="truncate">{venture.name}</span></Link>)}</div></div>
          </div>;
          return <Link key={href} href={href} onClick={(event) => { if (plainClick(event)) setPending(current || href === "/channels" || href === "/messages" ? null : { from: path, href }); onCloseMobile(); if (href === "/channels" || href === "/messages") onOpenChat(href, event); }} data-tip={collapsed ? label : undefined} aria-label={collapsed ? label : undefined} data-nav-active={active || undefined} aria-current={current ? "page" : undefined} className={clsx("relative flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-[13px] font-semibold", press, active ? "text-white" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900")}><Icon size={17} strokeWidth={active ? 2.1 : 1.8} /><span className={clsx("vso-nav-label flex-1 truncate", collapsed && "lg:hidden")}>{label}</span>{href === "/notifications" && unread > 0 && <span className={clsx("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", active ? "bg-white/15 text-white" : "bg-primary-50 text-primary-700", collapsed && "lg:absolute lg:right-1 lg:top-1 lg:h-2 lg:w-2 lg:p-0 lg:text-transparent")}>{unread}</span>}</Link>;
        })}</div>
        {quickGroup && <div className={clsx("mt-4 rounded-xl bg-neutral-50 p-2", collapsed && "lg:hidden")}><div className="mb-1 flex items-center gap-2 px-2 py-1"><Users size={14} className="text-neutral-400" /><p className="truncate text-[10px] font-semibold uppercase tracking-[.08em] text-neutral-500">{data.ventures.find((item) => item.id === quickGroup.ventureId)?.name} · {quickGroup.name}</p></div>{data.channels.filter((channel) => channel.groupId === quickGroup.id).map((channel) => <Link key={channel.id} href={`/channels?channel=${channel.id}`} onClick={(event) => { onCloseMobile(); onOpenChat(`/channels?channel=${channel.id}`, event); }} className={clsx("flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-neutral-500 hover:bg-white", press)}><Hash size={14} /><span className="flex-1">{channel.name}</span>{channel.unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-primary-600" />}</Link>)}</div>}
      </nav>
      <div className="border-t border-neutral-100 p-3">{mode === "demo" && <Link href="/settings" onClick={onCloseMobile} className={clsx("mb-1 flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 text-xs font-semibold text-neutral-500 hover:bg-neutral-100", press)}><Settings size={16} /><span className={clsx(collapsed && "lg:hidden")}>Settings</span></Link>}{showAccess && <Link href="/admin" onClick={onCloseMobile} data-tip={collapsed ? "People & access" : undefined} aria-label={collapsed ? "People & access" : undefined} aria-current={path === "/admin" ? "page" : undefined} className={clsx("mb-1 flex min-h-9 items-center gap-2.5 rounded-xl px-2.5 text-xs font-semibold", press, path === "/admin" ? "bg-primary-700 text-white shadow-sm" : "text-neutral-500 hover:bg-neutral-100")}><Users size={16} /><span className={clsx("vso-nav-label", collapsed && "lg:hidden")}>People & access</span></Link>}<div className={clsx("flex min-h-11 items-center gap-2.5 rounded-xl bg-neutral-50 px-2.5", collapsed && "lg:justify-center lg:px-1")}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-semibold text-white">{currentUser.initials}</span><span className={clsx("vso-nav-label min-w-0", collapsed && "lg:hidden")}><span className="block truncate text-xs font-semibold text-neutral-800">{currentUser.name}</span><span className="block truncate text-[10px] font-medium text-neutral-400">{role}</span></span></div></div>
    </aside>
    {tip && collapsed && createPortal(<div role="tooltip" data-instant={tip.instant} className="vso-tooltip pointer-events-none fixed z-[95] -translate-y-1/2 whitespace-nowrap rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs font-semibold text-white shadow-e3" style={{ top: tip.top, left: tip.left }}>{tip.label}</div>, document.body)}
    {creatingVenture && <CreateVentureDrawer workspaceName={workspaceName} ownerId={currentUserId} onClose={() => setCreatingVenture(false)} onCreated={(venture) => { setCreatingVenture(false); setPendingScope({ ventureId: venture.id, from: activeVentureId }); onCloseMobile(); router.push(`/ventures/live?venture=${encodeURIComponent(venture.id)}`); }} />}
  </>;
}
