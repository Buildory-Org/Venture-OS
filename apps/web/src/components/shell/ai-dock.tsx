"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiMagicIcon, Cancel01Icon, SentIcon } from "@hugeicons/core-free-icons";
import clsx from "clsx";

const initialMessages = [
  {
    role: "ai" as const,
    text: "Good morning Rajesh. Sales are up 8% vs last month. Watch Sharma Traders — 45 days late, ₹1.2L pending. Payroll run is due in 2 days. Cash position is OK for ~6 weeks.",
    time: "10:42",
  },
  { role: "user" as const, text: "What changed vs August?", time: "10:44" },
  {
    role: "ai" as const,
    text: "Collections improved +₹3.4L, driven by Gupta & Sons settling 2 invoices. Expenses fell ₹0.9L — mostly logistics. Pending payments rose 12% to ₹4.2L; Sharma Traders is the biggest contributor.",
    time: "10:44",
  },
];

const canned =
  "Here's what I found: collections improved +₹3.4L this week, driven by Gupta & Sons settling 2 invoices. Pending payments rose 12% to ₹4.2L — Sharma Traders is the biggest contributor.";

export function AiDock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");

  const send = () => {
    const t = input.trim();
    if (!t) return;
    setMessages((m) => [
      ...m,
      { role: "user" as const, text: t, time: "now" },
      { role: "ai" as const, text: canned, time: "now" },
    ]);
    setInput("");
  };

  return (
    <aside
      aria-hidden={!open}
      className={clsx(
        "absolute bottom-0 right-0 top-14 z-50 flex w-[370px] max-w-[92vw] flex-col bg-white",
        "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        open ? "translate-x-0" : "translate-x-full"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3.5">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-ai-surface">
          <HugeiconsIcon icon={AiMagicIcon} size={15} strokeWidth={1.75} className="text-ai" />
        </span>
        <div className="flex-1">
          <p className="text-[13px] font-bold text-neutral-900">AI Assistant</p>
          <p className="text-[10px] font-medium text-neutral-400">
            Context: CEO Dashboard
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AI assistant"
          className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 transition-[color,background-color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.5} />
        </button>
      </div>

      {/* Messages */}
      <div className="thin-scroll flex-1 space-y-4 overflow-y-auto bg-neutral-50/50 p-4">
        {messages.map((m, i) =>
          m.role === "ai" ? (
            <div key={i} className="flex gap-2.5">
              <span className="mt-0.5 grid h-6.5 w-6.5 shrink-0 place-items-center rounded-lg bg-ai-surface">
                <HugeiconsIcon icon={AiMagicIcon} size={12} strokeWidth={1.75} className="text-ai" />
              </span>
              <div className="rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5">
                <p className="text-[12.5px] leading-5.5 text-neutral-700">
                  {m.text}
                </p>
                <p className="mt-1.5 text-[10px] font-medium text-ai-text/60 tnum">
                  {m.time} · sources: finance, CRM
                </p>
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-end">
              <div className="rounded-2xl rounded-tr-md bg-neutral-900 px-3.5 py-2.5">
                <p className="text-[12.5px] leading-5.5 text-white">{m.text}</p>
              </div>
            </div>
          )
        )}
      </div>

      {/* Composer */}
      <div className="p-3.5">
        <div className="flex items-center gap-2 rounded-full bg-neutral-100 px-4 py-1.5 transition-[background-color] duration-150 focus-within:bg-white focus-within:ring-2 focus-within:ring-primary-600/25">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Ask about your business…"
            className="flex-1 bg-transparent py-1 text-[13px] text-neutral-800 placeholder:text-neutral-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            aria-label="Send"
            className="grid h-8 w-8 place-items-center rounded-full bg-primary-600 text-white transition-[background-color,transform] duration-150 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"
          >
            <HugeiconsIcon icon={SentIcon} size={14} strokeWidth={1.75} />
          </button>
        </div>
        <p className="mt-2 text-center text-[10px] text-neutral-400">
          AI answers are advisory — verify before acting. Ctrl+/ to toggle.
        </p>
      </div>
    </aside>
  );
}
