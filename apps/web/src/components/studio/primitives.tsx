"use client";

import { useEffect, useId, useRef } from "react";
import clsx from "clsx";

export const inputClass = "min-h-11 min-w-0 w-full max-w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-neutral-400 focus:border-primary-400 focus:ring-2 focus:ring-primary-100";
export const primaryClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 text-sm font-bold text-white transition-[background-color,transform] duration-150 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";
export const secondaryClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 text-sm font-bold text-neutral-700 shadow-sm transition-[background-color,transform] duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

export function PageFrame({ children }: { children: React.ReactNode }) { return <div className="mx-auto min-w-0 w-full max-w-[1580px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6">{children}</div>; }
export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <header className="mb-5 flex min-w-0 flex-wrap items-end justify-between gap-4"><div className="min-w-0 w-full sm:w-auto sm:flex-1"><p className="mb-1 text-xs font-extrabold uppercase tracking-[.1em] text-primary-600">{eyebrow}</p><h1 className="text-[clamp(1.6rem,3vw,2rem)] font-extrabold tracking-[-.04em] text-neutral-900">{title}</h1><p className="mt-1 break-words text-sm font-medium leading-6 text-neutral-500">{description}</p></div>{action}</header>; }
export function Panel({ children, className }: { children: React.ReactNode; className?: string }) { return <section className={clsx("min-w-0 rounded-2xl border border-neutral-100 bg-white shadow-card", className)}>{children}</section>; }
export function PanelHead({ title, aside }: { title: string; aside?: React.ReactNode }) { return <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4"><h2 className="text-sm font-extrabold text-neutral-900">{title}</h2>{aside}</div>; }
export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "blue" | "green" | "amber" | "red" | "purple" }) { const tones = { neutral: "bg-neutral-100 text-neutral-600", blue: "bg-primary-50 text-primary-700", green: "bg-success-surface text-success-text", amber: "bg-warning-surface text-warning-text", red: "bg-danger-surface text-danger-text", purple: "bg-ai-surface text-ai-text" }; return <span className={clsx("inline-flex items-center rounded-md px-2 py-1 text-[11px] font-extrabold", tones[tone])}>{children}</span>; }
export function Empty({ title, body }: { title: string; body: string }) { return <div className="px-5 py-12 text-center"><p className="text-sm font-extrabold text-neutral-800">{title}</p><p className="mt-1 text-sm text-neutral-500">{body}</p></div>; }
export function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1.5 block text-xs font-extrabold text-neutral-600">{label}</span>{children}</label>; }
export function DetailDrawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  const drawer = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !drawer.current) return;
      const focusable = [...drawer.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); drawer.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !drawer.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !drawer.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="fixed inset-0 z-50 flex justify-end bg-neutral-900/25 backdrop-blur-[1px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside ref={drawer} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="vso-enter-right flex h-full w-full max-w-[640px] flex-col bg-white shadow-e4"><header className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4"><div><h2 id={titleId} className="text-lg font-extrabold text-neutral-900">{title}</h2>{subtitle && <p className="mt-1 text-xs text-neutral-500">{subtitle}</p>}</div><button ref={close} type="button" onClick={onClose} aria-label="Close detail" className="min-h-10 rounded-xl px-3 text-sm font-bold text-neutral-500 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Close</button></header><div className="thin-scroll flex-1 overflow-y-auto p-5">{children}</div></aside></div>;
}
