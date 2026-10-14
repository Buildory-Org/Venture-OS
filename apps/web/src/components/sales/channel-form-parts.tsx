"use client";
import { useState } from "react";
import clsx from "clsx";
import type { z } from "zod";
import { Check, ChevronDown, Copy, Info } from "@/components/ui/icons";
import { inputClass, secondaryClass } from "@/components/studio/primitives";
import { copyText } from "./draft-shared";
import { META_STEPS } from "./channel-model";

// Pieces shared by the account forms and cards on Sales > Channels.

export const labelClass = "mb-1.5 block text-xs font-semibold text-neutral-600";
export const hintClass = "mt-1.5 text-xs leading-5 text-neutral-500";
const chipClass = (active: boolean) => clsx("inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]", active ? "border-primary-600 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50");

/**
 * A password, token or app secret. Typed once and never shown again: an account that has one saved shows "Saved ••••1234" and a Replace
 * button; only a replacement is sent. The browser is told not to fill or keep it.
 */
export function SecretField({ id, label, hint, saved, value, onChange }: { id: string; label: string; hint?: React.ReactNode; saved?: { set: boolean; last4?: string | undefined; setAt?: string | undefined } | undefined; value: string; onChange: (value: string) => void }) {
  const [replacing, setReplacing] = useState(false);
  const showInput = !saved?.set || replacing;
  return <div>
    {showInput ? <label htmlFor={id} className={labelClass}>{replacing ? `New ${label.toLowerCase()}` : label}</label> : <span className={labelClass}>{label}</span>}
    {showInput
      ? <div className="flex gap-2">
        <input id={id} name={id} type="password" autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-1p-ignore data-lpignore="true" data-form-type="other" maxLength={4000} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass} />
        {replacing && <button type="button" onClick={() => { setReplacing(false); onChange(""); }} className={clsx(secondaryClass, "shrink-0 !min-h-11")}>Keep saved</button>}
      </div>
      : <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-neutral-50 py-1 pl-3 pr-1">
        {/* A token shows its last four characters to the people who manage it; a password only that it is saved, and when. */}
        <span className="text-sm font-semibold text-neutral-700">Saved{saved?.last4 ? <> <span className="font-mono tracking-wider">••••{saved.last4}</span></> : saved?.setAt ? <span className="font-normal text-neutral-500"> on {new Date(saved.setAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span> : null}</span>
        <button type="button" onClick={() => setReplacing(true)} className="min-h-9 rounded-lg px-3 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Replace</button>
      </div>}
    {saved && !saved.set && <p className="mt-1.5 text-xs font-semibold leading-5 text-warning-text">The saved one can&apos;t be read any more. Enter it again.</p>}
    {hint && <p className={hintClass}>{hint}</p>}
  </div>;
}

/** A plain field with its label and an optional hint under it. */
export function TextField({ id, label, hint, ...input }: { id: string; label: string; hint?: React.ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <div><label htmlFor={id} className={labelClass}>{label}</label><input id={id} name={id} className={inputClass} {...input} />{hint && <p className={hintClass}>{hint}</p>}</div>;
}

/** An on/off switch with a line saying what it does. */
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
    <span aria-hidden="true" className={clsx("mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150", checked ? "bg-primary-600" : "bg-neutral-300")}><span className={clsx("h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150", checked && "translate-x-4")} /></span>
    <span className="min-w-0"><span className="block text-[13px] font-semibold text-neutral-800">{label}</span>{hint && <span className="mt-0.5 block text-xs leading-5 text-neutral-500">{hint}</span>}</span>
  </button>;
}

/**
 * Which ventures an account serves and where it is the default. With one venture to choose from it is fixed and only the default is asked;
 * with several, the person picks them and then the defaults among them.
 */
export function VentureChoice({ choices, ventureIds, defaultFor, onChange, noun }: { choices: { id: string; name: string }[]; ventureIds: string[]; defaultFor: string[]; onChange: (next: { ventureIds: string[]; defaultFor: string[] }) => void; noun: string }) {
  const single = choices.length === 1 ? choices[0]! : null;
  const toggleVenture = (ventureId: string) => {
    const on = ventureIds.includes(ventureId);
    onChange({ ventureIds: on ? ventureIds.filter((item) => item !== ventureId) : [...ventureIds, ventureId], defaultFor: on ? defaultFor.filter((item) => item !== ventureId) : defaultFor });
  };
  const toggleDefault = (ventureId: string) => onChange({ ventureIds, defaultFor: defaultFor.includes(ventureId) ? defaultFor.filter((item) => item !== ventureId) : [...defaultFor, ventureId] });
  if (!choices.length) return <p className="rounded-xl bg-warning-surface p-3 text-xs font-semibold leading-5 text-warning-text">You have no venture to connect this for.</p>;
  if (single) return <div className="space-y-2">
    <span className={labelClass}>Venture</span>
    <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-neutral-800">{single.name}</p>
    <Toggle checked={defaultFor.includes(single.id)} onChange={() => toggleDefault(single.id)} label={`The default ${noun} in ${single.name}`} hint="Sending uses the default first. You can still pick another one each time." />
  </div>;
  const selected = choices.filter((venture) => ventureIds.includes(venture.id));
  return <div className="space-y-3">
    <div><span id="venture-choice" className={labelClass}>Ventures it sends for</span>
      <div role="group" aria-labelledby="venture-choice" className="flex flex-wrap gap-1.5">{choices.map((venture) => <button key={venture.id} type="button" aria-pressed={ventureIds.includes(venture.id)} onClick={() => toggleVenture(venture.id)} className={chipClass(ventureIds.includes(venture.id))}>{ventureIds.includes(venture.id) && <Check size={13} aria-hidden="true" />}{venture.name}</button>)}</div>
    </div>
    {selected.length > 0 && <div><span id="default-choice" className={labelClass}>The default {noun} in</span>
      <div role="group" aria-labelledby="default-choice" className="flex flex-wrap gap-1.5">{selected.map((venture) => <button key={venture.id} type="button" aria-pressed={defaultFor.includes(venture.id)} onClick={() => toggleDefault(venture.id)} className={chipClass(defaultFor.includes(venture.id))}>{defaultFor.includes(venture.id) && <Check size={13} aria-hidden="true" />}{venture.name}</button>)}</div>
      <p className={hintClass}>Sending uses the default first. You can still pick another one each time.</p>
    </div>}
  </div>;
}

/** The plain-words setup steps on Meta's side, folded away until asked for. */
export function HowToConnect({ kind, defaultOpen = false }: { kind: "whatsapp" | "instagram"; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `how-to-${kind}`;
  return <div className="rounded-xl border border-neutral-200 bg-neutral-50">
    <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-neutral-700 transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
      <Info size={14} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="min-w-0 flex-1">How to connect {kind === "whatsapp" ? "a WhatsApp number" : "an Instagram account"}</span><ChevronDown size={15} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", open && "rotate-180")} />
    </button>
    {open && <ol id={panelId} className="vso-fade-enter list-decimal space-y-2 px-3 pb-3 pl-8 text-xs leading-5 text-neutral-600 marker:font-semibold marker:text-neutral-400">{META_STEPS[kind].map((step) => <li key={step} className="pl-1">{step}</li>)}</ol>}
  </div>;
}

/** A value to paste somewhere else (the webhook URL, the verify token) with a Copy button. */
export function CopyRow({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0">
    <span className="block text-[11px] font-semibold text-neutral-500">{label}</span>
    <div className="mt-1 flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-100 px-2.5 py-2 font-mono text-xs text-neutral-800" title={value}>{value}</code>
      <button type="button" onClick={() => void copyText(value, `${label} copied`)} aria-label={`Copy the ${label.toLowerCase()}`} className={clsx(secondaryClass, "!min-h-9 shrink-0 !px-3 text-xs")}><Copy size={14} aria-hidden="true" />Copy</button>
    </div>
  </div>;
}

/** The first problem in a form, in plain words, naming the field it is about. */
export function firstProblem(error: z.ZodError, labels: Record<string, string>): string {
  const issue = error.issues[0];
  if (!issue) return "Check the form and try again.";
  const key = issue.path.map(String).filter((part) => !/^\d+$/.test(part)).at(-1) ?? "";
  const field = labels[issue.path.map(String).join(".")] ?? labels[key] ?? "This field";
  if (issue.code === "too_small") return issue.path.includes("ventureIds") ? "Pick at least one venture." : `${field} is needed.`;
  if (issue.code === "too_big") return `${field} is too long.`;
  if (issue.code === "invalid_format" && key === "address") return "The email address doesn't look right.";
  const custom = issue.message && !/^invalid|^expected/i.test(issue.message) ? issue.message : "";
  return custom ? `${field}: ${custom}.` : `${field} doesn't look right.`;
}
