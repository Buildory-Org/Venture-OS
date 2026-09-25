"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "./icons";

const eventName = "venture-studio-theme-change";
const subscribe = (listener: () => void) => {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
};
const isDark = () => document.documentElement.dataset.theme === "dark";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);

  const toggle = () => {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(style);
    void document.body.offsetHeight; // Commit the new theme without crossfading the entire interface.
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { document.cookie = `venture_studio_theme=${next}; Path=/; SameSite=Lax; Max-Age=31536000`; } catch { /* Keep the current tab usable. */ }
    window.dispatchEvent(new Event(eventName));
    requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
  };

  return <button type="button" onClick={toggle} aria-label={dark ? "Use light theme" : "Use dark theme"}
    aria-pressed={dark} title={dark ? "Use light theme" : "Use dark theme"}
    className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[color,background-color,scale] duration-150 hover:bg-neutral-100 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96] ${className}`}>
    {dark ? <Sun size={18} /> : <Moon size={18} />}
  </button>;
}
