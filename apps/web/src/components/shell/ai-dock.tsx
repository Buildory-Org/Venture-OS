"use client";

import { useState } from "react";
import { Check, Pause, Play, TimerReset, X } from "lucide-react";
import clsx from "clsx";

export function FocusDock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [running, setRunning] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Close focus mode"
        onClick={onClose}
        className={clsx("fixed inset-0 z-40 bg-neutral-900/15 backdrop-blur-[1px] transition-opacity duration-150", open ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <aside
        aria-hidden={!open}
        aria-label="Focus mode"
        className={clsx(
          "fixed bottom-0 right-0 top-0 z-50 flex w-[390px] max-w-[94vw] flex-col bg-white p-5 shadow-e4 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <header className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-50 text-primary-700"><TimerReset size={19} /></span>
          <div className="flex-1"><h2 className="text-base font-extrabold text-neutral-900">Focus mode</h2><p className="text-xs text-neutral-400">Northstar Labs · Builder group</p></div>
          <button type="button" onClick={onClose} aria-label="Close focus mode" className="grid h-10 w-10 place-items-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"><X size={18} /></button>
        </header>

        <div className="mt-8 rounded-2xl bg-neutral-900 p-5 text-white shadow-e3">
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-white/50">Current focus</p>
          <h3 className="mt-3 text-lg font-extrabold leading-6">Finalize onboarding experiment</h3>
          <p className="mt-2 text-sm leading-6 text-white/60">Prepare the decision brief before today’s growth review.</p>
          <div className="my-7 text-center font-mono text-5xl font-medium tracking-[-0.06em] tnum">24:38</div>
          <button type="button" onClick={() => setRunning((value) => !value)} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white text-sm font-extrabold text-neutral-900 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900 active:scale-[0.96]">
            {running ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
            {running ? "Pause session" : "Start 25-minute session"}
          </button>
        </div>

        <div className="mt-7">
          <div className="flex items-center justify-between"><h3 className="text-sm font-extrabold text-neutral-900">Session plan</h3><span className="font-mono text-xs font-medium text-neutral-400">1 / 3</span></div>
          <div className="mt-3 space-y-2">
            {["Review the latest activation data", "Write the recommendation", "Share in #product"].map((step, index) => (
              <div key={step} className="flex min-h-12 items-center gap-3 rounded-xl bg-neutral-50 px-3.5">
                <span className={clsx("grid h-6 w-6 place-items-center rounded-full border text-xs", index === 0 ? "border-primary-600 bg-primary-600 text-white" : "border-neutral-300 text-neutral-400")}>{index === 0 ? <Check size={13} strokeWidth={2.5} /> : index + 1}</span>
                <span className="text-sm font-semibold text-neutral-700">{step}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-auto rounded-xl bg-primary-50 px-4 py-3 text-center text-xs font-medium leading-5 text-primary-700">Press <kbd className="rounded bg-white px-1.5 py-0.5 font-mono">Ctrl /</kbd> anytime to toggle focus mode.</p>
      </aside>
    </>
  );
}
