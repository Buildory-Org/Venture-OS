"use client";
import clsx from "clsx";
import { Copy, Sparkles } from "@/components/ui/icons";
import { copyText } from "./draft-shared";

/**
 * Where Claude can help next, as one line the person copies into Claude (the Dealflow Sales connector): "Ask Claude: review drafts" and a
 * Copy button. One per area, only where it is the obvious next step. `note` adds a short aside ("in a new chat"); `example` says the
 * words are an example to change.
 *
 * `appDoes`: the venture's autopilot does this step itself (docs/sales-autopilot.md), so there is nothing to carry to a chat. Pass the
 * quiet line to show instead ("The app judges new leads itself."), or `true` to show nothing. Leave it out (or false) while the
 * autopilot is off, blocked or unknown: the chip then shows as before.
 */
export function AskClaude({ prompt, note, example = false, appDoes, className }: { prompt: string; note?: string; example?: boolean; appDoes?: string | boolean; className?: string }) {
  if (appDoes === true) return null;
  if (appDoes) return <AppDoesLine text={appDoes} className={className} />;
  return <div className={clsx("flex min-w-0 items-center gap-2 rounded-xl border border-dashed border-neutral-200 bg-neutral-50 py-1 pl-3 pr-1 text-xs leading-5", className)}>
    <Sparkles size={14} aria-hidden="true" className="shrink-0 text-ai" />
    <p className="min-w-0 flex-1 py-1 text-neutral-500 [overflow-wrap:anywhere]">
      <span className="font-semibold">{example ? "Ask Claude, for example:" : "Ask Claude:"}</span>{" "}
      <q className="font-semibold text-neutral-800 [quotes:none]">{prompt}</q>
      {note && <span className="text-neutral-400"> · {note}</span>}
    </p>
    <button type="button" onClick={() => void copyText(prompt, "Copied. Paste it into Claude.")} aria-label={`Copy the prompt: ${prompt}`}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]">
      <Copy size={13} aria-hidden="true" />Copy
    </button>
  </div>;
}

/** A quiet line in place of an "Ask Claude" chip: the app does this step by itself. */
export function AppDoesLine({ text, className }: { text: string; className?: string }) {
  return <p className={clsx("flex min-w-0 items-center gap-2 text-xs leading-5 text-neutral-500", className)}>
    <Sparkles size={13} aria-hidden="true" className="shrink-0 text-ai" />
    <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
  </p>;
}
