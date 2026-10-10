"use client";
import { useId, useState } from "react";
import clsx from "clsx";
import { Plus, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Field, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createFindRun, listPlays, type FindRun } from "@/lib/sales-api";
import { kickerClass, useSalesLoad, writableVentures } from "./draft-shared";
import { useSalesShell } from "./sales-context";

export type FindTemplate = { request: string; places: string[]; categories: string[]; searches: string[]; limit: number; ventureId?: string; playId?: string };
export const templateOf = (run: FindRun): FindTemplate => ({ request: run.request, places: run.plan.places, categories: run.plan.categories, searches: run.plan.searches, limit: run.plan.limit, ventureId: run.ventureId, ...(run.playId ? { playId: run.playId } : {}) });

/** A list of short items typed one at a time: Enter or a comma adds one, and pasted lines or comma lists are split. */
function ChipsField({ label, hint, placeholder, items, onChange, max, maxLength }: { label: string; hint: string; placeholder: string; items: string[]; onChange: (items: string[]) => void; max: number; maxLength: number }) {
  const id = useId();
  const [text, setText] = useState("");
  function add(raw: string) {
    const parts = raw.split(/[,\n]/).map((part) => part.trim().slice(0, maxLength)).filter(Boolean);
    if (!parts.length) return;
    const next = [...items];
    for (const part of parts) if (next.length < max && !next.some((item) => item.toLowerCase() === part.toLowerCase())) next.push(part);
    onChange(next); setText("");
  }
  return <div>
    <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-neutral-600">{label} <span className="font-normal text-neutral-400">· {hint}</span></label>
    <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-neutral-200 bg-white px-2.5 py-2 transition-[border-color,box-shadow] duration-150 focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-100">
      {items.map((item) => <span key={item} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-primary-50 py-1 pl-2.5 pr-1 text-xs font-semibold text-primary-800"><span className="truncate">{item}</span><button type="button" aria-label={`Remove ${item}`} onClick={() => onChange(items.filter((other) => other !== item))} className="grid h-5 w-5 place-items-center rounded-md transition-colors duration-150 hover:bg-primary-100"><X size={11} /></button></span>)}
      <input id={id} value={text} disabled={items.length >= max} onChange={(event) => { const value = event.target.value; if (value.includes(",") || value.includes("\n")) add(value); else setText(value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(text); } else if (event.key === "Backspace" && !text && items.length) onChange(items.slice(0, -1)); }} onBlur={() => add(text)} onPaste={(event) => { const pasted = event.clipboardData.getData("text"); if (/[,\n]/.test(pasted)) { event.preventDefault(); add(pasted); } }} placeholder={items.length ? "" : placeholder} className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm font-medium text-neutral-800 outline-none placeholder:text-neutral-400" />
    </div>
  </div>;
}

/** Describe the audience, add optional places, categories and searches, then save the plan or queue it for the office PC. */
export function FindPlanForm({ template, onCreated }: { template?: FindTemplate | undefined; onCreated: (run: FindRun) => void }) {
  const { session, ventureId, ventureName, refresh } = useSalesShell();
  const ventures = writableVentures(session);
  const [request, setRequest] = useState(template?.request ?? "");
  const [places, setPlaces] = useState(template?.places ?? []);
  const [categories, setCategories] = useState(template?.categories ?? []);
  const [searches, setSearches] = useState(template?.searches ?? []);
  const [limit, setLimit] = useState(String(template?.limit ?? 50));
  const [venturePick, setVenturePick] = useState(template?.ventureId ?? "");
  const [playPick, setPlayPick] = useState(template?.playId ?? "");
  const [more, setMore] = useState(Boolean(template && (template.places.length || template.categories.length || template.searches.length)));
  const [busy, setBusy] = useState<"" | "save" | "queue">("");
  const [error, setError] = useState("");

  const targetVenture = ventureId || venturePick || (ventures.length === 1 ? ventures[0]!.id : "");
  const plays = useSalesLoad(`find-plays|${targetVenture}`, () => targetVenture ? listPlays({ ventureId: targetVenture }) : Promise.resolve([]));
  const playOptions = (plays.data ?? []).filter((play) => play.status !== "done");
  const play = playPick && playOptions.some((item) => item.id === playPick) ? playPick : "";

  async function submit(queue: boolean) {
    const count = Number(limit);
    if (request.trim().length < 3) { setError("Describe who you want to find, in a sentence."); return; }
    if (!targetVenture) { setError("Choose which venture this search is for."); return; }
    if (!Number.isInteger(count) || count < 1 || count > 500) { setError("The limit is a whole number from 1 to 500."); return; }
    setBusy(queue ? "queue" : "save"); setError("");
    try {
      const run = await createFindRun({ ventureId: targetVenture, ...(play ? { playId: play } : {}), request: request.trim(), plan: { places, categories, searches, limit: count } }, { queue });
      toast({ title: queue ? "Queued for the office PC" : "Plan saved", body: queue ? "It runs when the office PC is online." : "Queue it when you are happy with it." });
      setRequest(""); setPlaces([]); setCategories([]); setSearches([]); setMore(false);
      onCreated(run); refresh();
    } catch (cause) { setError(describeError(cause, "Could not save the search. Try again.")); }
    finally { setBusy(""); }
  }

  return <Panel className="h-full p-4 sm:p-5">
    <h2 className="text-[15px] font-extrabold tracking-[-.01em] text-neutral-900">Find new leads</h2>
    <p className="mt-1 text-xs leading-5 text-neutral-500">Describe the buyer. The office PC searches the public web, adds new companies, and Claude judges each one.</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit(true); }} className="mt-4 space-y-4">
      <div>
        <label htmlFor="find-request" className={clsx(kickerClass, "mb-2 block")}>Who do you want to find?</label>
        <textarea id="find-request" value={request} onChange={(event) => setRequest(event.target.value)} maxLength={2000} rows={3} placeholder="Pipe, pump and irrigation distributors in Chhattisgarh and Madhya Pradesh that sell through dealers. Skip national brands." className={clsx(inputClass, "py-3 leading-6")} />
        <p className="mt-1.5 text-xs leading-5 text-neutral-500">Say who, where, and what to skip. Claude can also plan it for you in a chat.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {ventureId
          ? <div aria-label="Search destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Venture · fixed to the one you picked</span><span className="mt-1 block text-sm font-bold text-neutral-800">{ventureName(ventureId)}</span></div>
          : <Field label="Venture"><Select className={inputClass} value={venturePick || (ventures.length === 1 ? ventures[0]!.id : "")} onChange={(event) => { setVenturePick(event.target.value); setPlayPick(""); }}><option value="">Choose a venture</option>{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}
        <Field label="For which play? (optional)"><Select className={inputClass} value={play} onChange={(event) => setPlayPick(event.target.value)}><option value="">Not for a play yet</option>{playOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
      </div>

      <div>
        <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1 text-sm font-semibold text-primary-700 transition-colors duration-150 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Plus size={14} className={clsx("transition-transform duration-150", more && "rotate-45")} />{more ? "Hide the search details" : "Add places, categories or exact searches"}</button>
        <div data-open={more} className="vso-collapse"><div><div className="space-y-4 pt-3">
          <ChipsField label="Places" hint="cities or states" placeholder="Raipur, Indore, Madhya Pradesh" items={places} onChange={setPlaces} max={30} maxLength={120} />
          <ChipsField label="Categories" hint="kinds of company" placeholder="Pump dealer, pipe distributor" items={categories} onChange={setCategories} max={30} maxLength={120} />
          <ChipsField label="Searches" hint="exact phrases to look for" placeholder="become a dealer pump Raipur" items={searches} onChange={setSearches} max={50} maxLength={300} />
        </div></div></div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36"><Field label="Up to how many?"><input type="number" inputMode="numeric" min={1} max={500} value={limit} onChange={(event) => setLimit(event.target.value)} className={inputClass} /></Field></div>
        <p className="min-w-0 flex-1 pb-2.5 text-xs leading-5 text-neutral-500">Companies already in Dealflow, and anyone on the do-not-contact list, are skipped.</p>
      </div>

      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy !== ""} className={primaryClass}><ActionLabel busy={busy === "queue"} busyText="Queuing…" idle="Queue for the office PC" /></button>
        <button type="button" disabled={busy !== ""} onClick={() => void submit(false)} className={secondaryClass}><ActionLabel busy={busy === "save"} idle="Save plan" /></button>
      </div>
      <p className="text-xs leading-5 text-neutral-500">Save keeps it as a plan to come back to. Queue hands it to the office PC.</p>
    </form>
  </Panel>;
}
