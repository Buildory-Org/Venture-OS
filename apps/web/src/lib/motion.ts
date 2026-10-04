"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Plays an exit animation before closing. The component renders `data-state={state}` (CSS animates
 * `[data-state="closing"]`) and callers keep unmounting it in `onClose`, which runs once the exit finishes.
 */
export function useExitTransition(onClose: () => void, durationMs: number) {
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  const timer = useRef(0);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = useCallback(() => {
    if (timer.current) return;
    if (prefersReducedMotion()) { onCloseRef.current(); return; }
    setClosing(true);
    // Reset afterwards so a parent that keeps this mounted can open and close it again.
    timer.current = window.setTimeout(() => { timer.current = 0; onCloseRef.current(); setClosing(false); }, durationMs);
  }, [durationMs]);
  /** Abandons a running exit (e.g. the same panel is reopened before it finished closing). */
  const cancel = useCallback(() => {
    if (!timer.current) return;
    window.clearTimeout(timer.current); timer.current = 0; setClosing(false);
  }, []);
  return { state: closing ? "closing" : "open", close, cancel } as const;
}

/** Re-runs a CSS animation class on an element (e.g. `vso-flash` on a row that just changed). */
export function replayAnimation(element: Element | null | undefined, className: string) {
  if (!element || prefersReducedMotion()) return;
  element.classList.remove(className);
  void (element as HTMLElement).offsetWidth;
  element.classList.add(className);
  element.addEventListener("animationend", () => element.classList.remove(className), { once: true });
}

/** Briefly highlights the element with `data-flash-id={id}`, waiting up to 5s for it to render (a refetch may add it later). */
export function flashById(id: string, root: ParentNode & Node = document) {
  if (prefersReducedMotion()) return;
  const selector = `[data-flash-id="${CSS.escape(id)}"]`;
  const tryFlash = () => {
    const element = root.querySelector(selector);
    if (!element) return false;
    replayAnimation(element, "vso-flash");
    return true;
  };
  requestAnimationFrame(() => {
    if (tryFlash()) return;
    const observer = new MutationObserver(() => { if (tryFlash()) { observer.disconnect(); window.clearTimeout(stop); } });
    observer.observe(root, { childList: true, subtree: true });
    const stop = window.setTimeout(() => observer.disconnect(), 5000);
  });
}
