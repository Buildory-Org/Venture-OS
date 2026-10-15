"use client";

import { useCallback, useEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/**
 * Swipe a row left or right to remove it, or hold it to open more. Works with a finger, a pen or a mouse; a press that starts on a
 * button, link or field is left to that control. The row follows the pointer (a little resistance once it is past the point of
 * removal), and goes when dragged past a third of its width or flicked; otherwise it springs back. Holding still for half a second
 * opens instead (with a light tap on phones that have one). Vertical drags scroll the page as usual.
 *
 * The row moves by its own style, never through React state, so a drag never re-renders the list.
 */
const HOLD_MS = 500;
const MOVE_SLOP = 8;
const FLICK = 0.5; // px per ms
const CONTROLS = "button, a, input, select, textarea, label, [role='combobox'], [role='button'], [role='option'], [role='listbox'], [data-no-swipe]";

type Drag = { id: number; x: number; y: number; at: number; dx: number; axis: "x" | "y" | null; held: boolean; timer: number; cue: number };

export function useSwipeRow<T extends HTMLElement>({ onRemove, onHold, disabled = false }: { onRemove: () => void; onHold?: () => void; disabled?: boolean }) {
  const ref = useRef<T>(null);
  const drag = useRef<Drag | null>(null);
  const removing = useRef(false);
  const removeTimer = useRef(0);
  const callbacks = useRef({ onRemove, onHold });
  useEffect(() => { callbacks.current = { onRemove, onHold }; }, [onRemove, onHold]);

  const settle = useCallback((transition: string) => {
    const row = ref.current;
    if (!row) return;
    row.style.transition = transition;
    row.style.transform = "";
    row.style.opacity = "";
    delete row.dataset.pressing;
  }, []);

  const end = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    window.clearTimeout(current.cue);
    drag.current = null;
    document.body.style.userSelect = "";
    delete ref.current?.dataset.pressing;
    return current;
  }, []);

  useEffect(() => () => { end(); window.clearTimeout(removeTimer.current); }, [end]);

  /** Puts a removed row back (after Undo). */
  const reset = useCallback(() => { removing.current = false; settle("none"); }, [settle]);

  const onPointerDown = useCallback((event: React.PointerEvent<T>) => {
    // A press elsewhere still clears a drag left over (a hold that opened a popup took the release).
    if (drag.current) end();
    if (disabled || removing.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    // Menus open in a layer of their own, but their presses still reach the row through React: they aren't the row's.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest(CONTROLS)) return;
    const start: Drag = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), dx: 0, axis: null, held: false, timer: 0, cue: 0 };
    if (callbacks.current.onHold) {
      // A slight press-in shows the hold is being felt; it opens at half a second.
      start.cue = window.setTimeout(() => { if (ref.current) ref.current.dataset.pressing = "true"; }, 150);
      start.timer = window.setTimeout(() => {
        if (drag.current !== start || start.axis) return;
        start.held = true;
        // The popup it opens takes the release, so the hold is over now.
        end();
        navigator.vibrate?.(10);
        callbacks.current.onHold?.();
      }, HOLD_MS);
    }
    drag.current = start;
  }, [disabled, end]);

  const onPointerMove = useCallback((event: React.PointerEvent<T>) => {
    const current = drag.current;
    const row = ref.current;
    if (!current || !row || event.pointerId !== current.id || current.held) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.axis) {
      if (Math.abs(dx) < MOVE_SLOP && Math.abs(dy) < MOVE_SLOP) return;
      window.clearTimeout(current.timer);
      window.clearTimeout(current.cue);
      delete row.dataset.pressing;
      current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (current.axis === "y") return;
      // A sideways drag is a swipe: keep the pointer, and don't select text on the way.
      try { row.setPointerCapture(event.pointerId); } catch { /* Still follows while over the row. */ }
      window.getSelection()?.removeAllRanges();
      document.body.style.userSelect = "none";
    }
    if (current.axis !== "x") return;
    const width = row.offsetWidth || 1;
    const past = Math.max(0, Math.abs(dx) - width * 0.5);
    // Past half its width the row slows down, like pulling against a spring.
    const shown = Math.sign(dx) * (Math.min(Math.abs(dx), width * 0.5) + past * 0.35);
    current.dx = dx;
    row.style.transition = "none";
    row.style.transform = `translateX(${shown}px)`;
    row.style.opacity = String(1 - Math.min(Math.abs(shown) / width, 1) * 0.7);
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<T>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.id) return;
    end();
    const row = ref.current;
    if (!row || current.axis !== "x") return;
    const width = row.offsetWidth || 1;
    const speed = Math.abs(current.dx) / Math.max(1, performance.now() - current.at);
    if (Math.abs(current.dx) > width / 3 || (speed > FLICK && Math.abs(current.dx) > 40)) {
      removing.current = true;
      const duration = prefersReducedMotion() ? 0 : 200;
      row.style.transition = `transform ${duration}ms cubic-bezier(0.23, 1, 0.32, 1), opacity ${duration}ms ease-out`;
      row.style.transform = `translateX(${Math.sign(current.dx) * width * 1.1}px)`;
      row.style.opacity = "0";
      removeTimer.current = window.setTimeout(() => callbacks.current.onRemove(), duration);
    } else settle("transform 200ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms ease-out");
  }, [end, settle]);

  const onPointerCancel = useCallback(() => {
    const current = end();
    if (current?.axis === "x") settle("transform 200ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms ease-out");
  }, [end, settle]);

  // A hold opens on release without also clicking what was under the finger; a swipe never clicks either.
  const onClickCapture = useCallback((event: React.MouseEvent<T>) => {
    if (removing.current) { event.preventDefault(); event.stopPropagation(); }
  }, []);
  const onContextMenu = useCallback((event: React.MouseEvent<T>) => {
    // Phones open a menu on a long touch; the hold opens the history instead.
    if (callbacks.current.onHold && !(event.target instanceof Element && event.target.closest(CONTROLS)) && (event.nativeEvent as PointerEvent).pointerType !== "mouse") event.preventDefault();
  }, []);

  return { ref, reset, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onContextMenu } };
}
