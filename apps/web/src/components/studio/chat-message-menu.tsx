"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ChatMenuAction = { label: string; onSelect: () => void; disabled?: boolean };

export function ChatMessageMenu({ children, actions, label = "Message actions" }: { children: ReactNode; actions: ChatMenuAction[]; label?: string }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  function clearHold() { if (hold.current) clearTimeout(hold.current); hold.current = null; }
  function open(x: number, y: number) {
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - 190)), y: Math.max(8, Math.min(y, window.innerHeight - 196)) });
  }
  function close() { setPosition(null); trigger.current?.focus(); }

  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("keydown", onKeyDown); };
  }, [position]);
  useEffect(() => () => clearHold(), []);

  return <>
    <div ref={trigger} role="button" tabIndex={0} aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(position)} className="inline-block max-w-full cursor-context-menu rounded-2xl align-bottom focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-500)]" onClick={(event) => { if (!position) { const box = event.currentTarget.getBoundingClientRect(); open(box.left + box.width / 2, box.bottom + 4); } }} onContextMenu={(event) => { event.preventDefault(); open(event.clientX, event.clientY); }} onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key === "Enter" || event.key === " ") { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); open(box.left + box.width / 2, box.bottom + 4); } }} onPointerDown={(event) => { if (event.pointerType !== "touch") return; pointer.current = { x: event.clientX, y: event.clientY }; clearHold(); hold.current = setTimeout(() => open(event.clientX, event.clientY), 500); }} onPointerMove={(event) => { if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 8) clearHold(); }} onPointerUp={clearHold} onPointerCancel={clearHold}>{children}</div>
    {position && createPortal(<div ref={menu} role="menu" aria-label={label} className="fixed z-[90] min-w-44 rounded-xl border border-[var(--color-neutral-200)] bg-white p-1.5 text-left shadow-[0_14px_35px_rgba(0,0,0,.2)] vso-enter-popover" style={{ left: position.x, top: position.y }}>{actions.map((action) => <button key={action.label} type="button" role="menuitem" disabled={action.disabled} onClick={() => { setPosition(null); action.onSelect(); trigger.current?.focus(); }} className="block min-h-9 w-full rounded-lg px-3 text-left text-xs font-medium text-[var(--color-neutral-700)] hover:bg-[var(--color-primary-50)] focus-visible:bg-[var(--color-primary-50)] disabled:opacity-40">{action.label}</button>)}</div>, document.body)}
  </>;
}
