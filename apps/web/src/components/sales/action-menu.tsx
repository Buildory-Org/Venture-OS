"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { MoreHorizontal, type Icon } from "@/components/ui/icons";
import { secondaryClass } from "@/components/studio/primitives";

export type MenuAction = { key: string; label: string; icon?: Icon; onSelect: () => void; danger?: boolean; disabled?: boolean; shortcut?: string };

const MENU_WIDTH = 232;

/**
 * "More": the secondary actions of a screen behind one button. The menu sits on top of the page (it is never clipped by a card), opens
 * under the button or above it when there is no room, and works from the keyboard: arrows, Home and End move, Escape and Tab close it
 * and return focus to the button.
 */
export function ActionMenu({ items, label = "More actions", buttonLabel = "More", className }: { items: MenuAction[]; label?: string; buttonLabel?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; side: "top" | "bottom" } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const position = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const height = menu.current?.offsetHeight ?? 44 * items.length + 12;
    const below = window.innerHeight - box.bottom;
    const side = below < height + 12 && box.top > below ? "top" : "bottom";
    const left = Math.max(8, Math.min(box.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    setPlace({ left, top: side === "bottom" ? box.bottom + 6 : box.top - height - 6, side });
  }, [items.length]);

  const close = useCallback((refocus: boolean) => { setOpen(false); setPlace(null); if (refocus) trigger.current?.focus(); }, []);

  // Measure once the menu is on the page (its height decides whether it fits below), then keep it next to the button.
  useLayoutEffect(() => { if (open) position(); }, [open, position]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { const target = event.target as Node; if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close(false); };
    const onMove = () => position();
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => { window.removeEventListener("pointerdown", onPointer); window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true); };
  }, [open, position, close]);
  useEffect(() => { if (open && place) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus(); }, [open, place]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (event.target === trigger.current && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setOpen(true); }
      return;
    }
    // Keys pressed in the menu stay in the menu: Escape must not also close the draft on a phone, j and k must not move the list.
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    // The menu sits at the end of the page (a portal), so Tab from it would leave the page: close it and come back to More instead.
    if (event.key === "Tab") { event.preventDefault(); close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  if (!items.length) return null;
  return <div className={clsx("relative shrink-0", className)} onKeyDown={onKeyDown}>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={buttonLabel === "More" ? label : undefined}
      onClick={() => (open ? close(false) : setOpen(true))} className={clsx(secondaryClass, "!min-h-11 !gap-1.5 !px-3 sm:!min-h-10", open && "!bg-neutral-50")}>
      <MoreHorizontal size={18} aria-hidden="true" /><span className="max-sm:sr-only">{buttonLabel}</span>
    </button>
    {open && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={label} data-side={place?.side} data-align="right"
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999, width: MENU_WIDTH }}
      className={clsx("fixed z-[80] rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-[0_14px_35px_rgba(0,0,0,.18)]", place && "vso-enter-popover")}>
      {items.map((item) => {
        const ItemIcon = item.icon;
        return <button key={item.key} type="button" role="menuitem" disabled={item.disabled} onClick={() => { close(true); item.onSelect(); }}
          className={clsx("flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13px] font-semibold transition-colors duration-100 focus-visible:outline-none disabled:opacity-40 sm:min-h-10",
            item.danger ? "text-danger-text hover:bg-danger-surface focus-visible:bg-danger-surface" : "text-neutral-700 hover:bg-neutral-100 focus-visible:bg-neutral-100")}>
          {ItemIcon && <ItemIcon size={16} aria-hidden="true" className={clsx("shrink-0", item.danger ? "text-danger-text" : "text-neutral-400")} />}
          <span className="min-w-0 flex-1">{item.label}</span>
          {item.shortcut && <kbd className="rounded border border-neutral-200 px-1.5 font-mono text-[10px] font-medium text-neutral-400 max-lg:hidden">{item.shortcut}</kbd>}
        </button>;
      })}
    </div>, document.body)}
  </div>;
}
