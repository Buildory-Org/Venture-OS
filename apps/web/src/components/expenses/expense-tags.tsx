"use client";
import { useId, useRef, useState } from "react";
import clsx from "clsx";
import { expenseTagKey, expenseTagText, LONG_NUMBER, MAX_EXPENSE_TAGS } from "@venture-studio/contracts";
import { Hash, X } from "@/components/ui/icons";

// Tags on an expense: words of one's own to filter and total by, such as who it was for ("Rahul"), an event or a project.

export type KnownTag = { key: string; tag: string; expenses: number };

/**
 * The tags with what was typed added (several when it holds commas), each once, spelled like a tag used before when it matches one; or
 * why it can't be added.
 */
export function withTyped(tags: string[], text: string, known: KnownTag[]): { tags: string[]; problem: string } {
  const next = [...tags];
  for (const part of text.split(",")) {
    const typed = expenseTagText(part);
    if (!typed) continue;
    if (typed.length > 30) return { tags, problem: "A tag is at most 30 characters." };
    if (LONG_NUMBER.test(typed)) return { tags, problem: "Tags can't hold account, card or phone numbers." };
    const key = expenseTagKey(typed);
    if (next.some((tag) => expenseTagKey(tag) === key)) continue;
    if (next.length >= MAX_EXPENSE_TAGS) return { tags: next, problem: `At most ${MAX_EXPENSE_TAGS} tags.` };
    next.push(known.find((tag) => tag.key === key)?.tag ?? typed);
  }
  return { tags: next, problem: "" };
}

/** One tag as a small chip ("# Rahul"); `onRemove` adds its remove button. */
export function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  return <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-neutral-100 py-1 pl-1.5 pr-2 text-[11px] font-semibold text-neutral-700">
    <Hash size={11} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="truncate">{tag}</span>
    {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove the tag ${tag}`} className="-my-1 -mr-1.5 ml-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-500 transition-colors duration-150 hover:bg-neutral-200 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={12} aria-hidden="true" /></button>}
  </span>;
}

/**
 * The tags field: chips for the tags given, and a box to type more (Enter or a comma adds one, Backspace in an empty box takes the last
 * back). Tags used before are offered as you type (or, with nothing typed, the most used ones), and a typed tag that matches one of
 * them takes its spelling, so "rahul" joins "Rahul". Text still in the box counts too: `pending` lets the form save it, and leaving the
 * field adds it (moving within it, such as Tab to a suggestion, doesn't).
 */
export function TagInput({ tags, onChange, known, pending, onPending, readOnly }: {
  tags: string[]; onChange: (tags: string[]) => void; known: KnownTag[]; pending: string; onPending: (text: string) => void; readOnly?: boolean;
}) {
  const labelId = useId();
  const hintId = useId();
  const field = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [problem, setProblem] = useState("");
  const chosen = new Set(tags.map(expenseTagKey));
  const full = tags.length >= MAX_EXPENSE_TAGS;
  /** Adds what was typed; what can't be a tag stays in the box, with why. */
  function add(text: string) {
    const result = withTyped(tags, text, known);
    setProblem(result.problem);
    onChange(result.tags);
    if (!result.problem) onPending("");
  }
  /** Focus leaving the whole field adds what is still typed. */
  function left(event: React.FocusEvent) {
    if (field.current?.contains(event.relatedTarget as Node | null)) return;
    setFocused(false);
    if (pending.trim()) add(pending);
  }
  const typed = expenseTagKey(pending);
  const offered = (typed ? known.filter((tag) => tag.key.includes(typed)) : [...known].sort((a, b) => b.expenses - a.expenses)).filter((tag) => !chosen.has(tag.key)).slice(0, 6);

  return <div ref={field} role="group" aria-labelledby={labelId} onFocus={() => setFocused(true)} onBlur={left}>
    <span id={labelId} className="mb-1.5 block text-xs font-semibold text-neutral-600">Tags (optional)</span>
    {readOnly
      ? tags.length ? <ul className="flex flex-wrap gap-1.5">{tags.map((tag) => <li key={tag}><TagChip tag={tag} /></li>)}</ul> : <p className="text-sm text-neutral-500">No tags</p>
      : <>
        {/* A click on the empty part of the box types into it. */}
        <div onClick={(event) => { if (event.target === event.currentTarget) box.current?.focus(); }} className={clsx("flex min-h-11 w-full cursor-text flex-wrap items-center gap-1.5 rounded-xl border bg-white px-2 py-1.5 transition-[border-color,box-shadow] duration-150", focused ? "border-primary-400 ring-2 ring-primary-100" : "border-neutral-200")}>
          {tags.length > 0 && <ul className="flex max-w-full flex-wrap gap-1.5" aria-label="Tags on this expense">{tags.map((tag) => <li key={tag} className="max-w-full"><TagChip tag={tag} onRemove={() => { onChange(tags.filter((one) => one !== tag)); box.current?.focus(); }} /></li>)}</ul>}
          <input ref={box} aria-labelledby={labelId} aria-describedby={hintId} maxLength={60} value={pending} placeholder={full ? `${MAX_EXPENSE_TAGS} tags at most` : tags.length ? "Add another" : "Who or what it was for, e.g. Rahul"}
            className="min-h-8 min-w-[9rem] flex-1 bg-transparent px-1 text-sm font-medium text-neutral-800 outline-none placeholder:text-neutral-400"
            onChange={(event) => { setProblem(""); onPending(event.target.value); if (event.target.value.includes(",")) add(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); if (pending.trim()) add(pending); }
              else if (event.key === "Backspace" && !pending && tags.length) { event.preventDefault(); onPending(tags.at(-1)!); onChange(tags.slice(0, -1)); }
            }} />
        </div>
        <p id={hintId} aria-live="polite" className={clsx("mt-1.5 text-xs leading-5", problem ? "font-semibold text-danger-text" : "text-neutral-500")}>{problem || "Press Enter after each tag. Filter and total by them on the Expenses and Office tabs."}</p>
        {(focused || typed) && offered.length > 0 && <div role="group" aria-label="Tags used before" className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span aria-hidden="true" className="text-[11px] font-semibold text-neutral-500">Used before:</span>
          {/* A press keeps the focus where it was (the list stays), adds the tag, and puts the focus back in the box. */}
          {offered.map((tag) => <button key={tag.key} type="button" aria-label={`Add the tag ${tag.tag}, on ${tag.expenses} ${tag.expenses === 1 ? "expense" : "expenses"}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => { add(tag.tag); box.current?.focus(); }}
            className="inline-flex min-h-7 items-center gap-1 rounded-full border border-neutral-200 px-2.5 text-[11px] font-semibold text-neutral-700 transition-colors duration-150 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
            <Hash size={10} aria-hidden="true" className="text-neutral-400" />{tag.tag}<span className="tabular-nums text-neutral-400">{tag.expenses}</span>
          </button>)}
        </div>}
      </>}
  </div>;
}
