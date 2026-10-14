"use client";
import { useState } from "react";
import clsx from "clsx";
import { salesSearchKeyInputSchema } from "@venture-studio/contracts";
import { ArrowUpRight, Check, CircleAlert, Search } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { addSearchKey, getSearchKeys, MAX_SEARCH_KEYS, removeSearchKey, testSearchKey, type SalesSearchEngine, type SalesSearchKeyEntry, type SalesSearchKeys, type SalesSearchKeyStatus, type SalesSearchKeyTest } from "@/lib/sales-api";
import { useSalesLoad } from "./draft-shared";
import { absoluteDate, type Tone } from "./sales-ui";

// The company-search keys (TinyFish, Exa) behind Claude's search_companies and the lead finder, for the whole workspace. Admins only: the
// setup screen renders this for them, and the API refuses everyone else. Up to 10 keys per engine, tried in order: search moves on to the
// next key when one is used up or refused. A key is typed once and never shown again.

const ENGINES: { engine: SalesSearchEngine; name: string; purpose: string; site: string; host: string }[] = [
  { engine: "tinyfish", name: "TinyFish Search", purpose: "Free: 1,500 searches a day per key.", site: "https://tinyfish.ai", host: "tinyfish.ai" },
  { engine: "exa", name: "Exa", purpose: "About 1,200 searches a month per key on its free credit.", site: "https://exa.ai", host: "exa.ai" },
];

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const number = (value: number) => value.toLocaleString("en-IN");

/** The engine's chip: how many keys search can use, and where they come from. */
function chipOf(status: SalesSearchKeyStatus): { tone: Tone; text: string } {
  const usable = status.keys.filter((key) => !key.unreadable && key.source === status.source);
  if (status.source === "app") return { tone: "green", text: `${plural(usable.length, "key")} saved` };
  if (status.source === "server") return { tone: "blue", text: usable.length > 1 ? `${usable.length} keys on the server` : "Set on the server" };
  return status.keys.some((key) => key.unreadable) ? { tone: "red", text: "Unreadable, enter it again" } : { tone: "neutral", text: "Not set" };
}

/** What search does with this engine's keys now. */
function detailOf(status: SalesSearchKeyStatus): string {
  if (status.source === "app") return status.keys.filter((key) => !key.unreadable).length > 1 ? "Search uses these keys in order and moves to the next one when a key is used up or refused. They replace any key set on the server." : "Saved keys replace any key set on the server. Add another key and search moves to it when this one is used up or refused.";
  if (status.source === "server") return "Set in the server's settings. A key saved here takes their place.";
  if (status.keys.some((key) => key.unreadable)) return "The saved key can't be read any more (the server's secret changed). Remove it and paste it again.";
  return "Search with this engine is off until a key is added.";
}

/** One panel under the setup checklist: per engine its keys, each with what it used, Test and Remove, and a field to add one. */
export function SetupSearchKeys() {
  const keys = useSalesLoad<SalesSearchKeys>("sales-search-keys", getSearchKeys);
  return <Panel className="mt-4 p-4 sm:p-5">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-50 text-primary-700"><Search size={15} /></span>
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-neutral-900">Company search keys</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-neutral-500">Claude&apos;s company search and the lead finder look companies up on the web with these, for every venture. Add up to {MAX_SEARCH_KEYS} keys per engine: search moves to the next key when one is used up or refused. A key saved here is stored encrypted and never shown again. Only admins see this.</p>
      </div>
    </div>
    {keys.error && !keys.data && <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text"><span className="min-w-0 flex-1">Could not read the search keys: {keys.error}</span><button type="button" onClick={keys.reload} disabled={keys.busy} className={secondaryClass}>{keys.busy ? "Trying again…" : "Try again"}</button></div>}
    {!keys.data && !keys.error && <div role="status" aria-label="Reading the search keys" className="mt-4 grid gap-3 lg:grid-cols-2">{ENGINES.map((info) => <span key={info.engine} className="vso-skeleton block h-40 rounded-2xl" />)}</div>}
    {keys.data && <ul className="mt-4 grid gap-3 lg:grid-cols-2">{ENGINES.map((info) => <EngineCard key={info.engine} {...info} status={keys.data![info.engine]} onChange={(next) => keys.mutate(() => next)} />)}</ul>}
  </Panel>;
}

function EngineCard({ engine, name, purpose, site, host, status, onChange }: (typeof ENGINES)[number] & { status: SalesSearchKeyStatus; onChange: (next: SalesSearchKeys) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chip = chipOf(status);
  const saved = status.keys.filter((key) => key.source === "app");
  const full = saved.length >= MAX_SEARCH_KEYS;
  const inputId = `search-key-${engine}`;

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const valid = salesSearchKeyInputSchema.safeParse({ key: draft });
    if (!valid.success) { setError(valid.error.issues[0]?.message ?? "That doesn't look like a key."); return; }
    setBusy(true); setError("");
    try { onChange(await addSearchKey(engine, valid.data.key)); setDraft(""); toast({ title: `${name} key added`, body: "Search uses it from now on. Test it to check it works." }); }
    catch (cause) { setError(describeError(cause, "Could not add the key. Try again.")); }
    finally { setBusy(false); }
  }

  return <li className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="text-sm font-bold text-neutral-900">{name}</h3><p className="mt-0.5 text-xs leading-5 text-neutral-500">{purpose}</p></div>
      <Badge tone={chip.tone}>{chip.text}</Badge>
    </div>
    <p className="mt-2 text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">{detailOf(status)}</p>
    {status.keys.length > 0 && <ol className="mt-3 divide-y divide-neutral-100 rounded-xl border border-neutral-100">{status.keys.map((entry, index) => <KeyRow key={`${entry.source}-${entry.id}`} engine={engine} name={name} entry={entry} position={index + 1} onChange={onChange} />)}</ol>}
    <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold text-neutral-600">{full ? `${name} has ${MAX_SEARCH_KEYS} keys: remove one to add another` : saved.length ? `Add another ${name} key` : `Paste a ${name} key`}</label>
        <input id={inputId} name={inputId} type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" maxLength={400} disabled={full} value={draft} onChange={(event) => { setDraft(event.target.value); if (error) setError(""); }} placeholder="Key" className={inputClass} />
      </div>
      <button disabled={busy || full || !draft.trim()} className={clsx(primaryClass, "!min-h-11")}><ActionLabel busy={busy} idle="Add" /></button>
    </form>
    <a href={site} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-10 items-center gap-1 rounded-lg px-1 text-xs font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Get a key at {host}<ArrowUpRight size={13} aria-hidden="true" /></a>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mt-3" />
  </li>;
}

/** One key: which it is, what it used this period, its state, and Test and (for a saved key) Remove. */
function KeyRow({ engine, name, entry, position, onChange }: { engine: SalesSearchEngine; name: string; entry: SalesSearchKeyEntry; position: number; onChange: (next: SalesSearchKeys) => void }) {
  const [busy, setBusy] = useState<"test" | "remove" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SalesSearchKeyTest | null>(null);
  const [error, setError] = useState("");
  const saved = entry.source === "app";
  const label = saved ? `Key ${position} ••••${entry.last4 ?? ""}` : `Server key ${entry.id.replace(/^server-/, "")}`;
  const usage = `${number(entry.used)} of ${number(entry.limit)} ${entry.period === "day" ? "today" : "this month"}`;
  const who = entry.setAt ? `Added ${absoluteDate(entry.setAt)}${entry.setByName ? ` by ${entry.setByName}` : ""}` : "";

  async function test() {
    setBusy("test"); setError(""); setResult(null);
    // The test may have made a refused key usable again (or marked it refused): the list is read again.
    try { setResult(await testSearchKey(engine, entry.id)); void getSearchKeys().then(onChange).catch(() => undefined); }
    catch (cause) { setError(describeError(cause, "Could not run the test. Try again.")); }
    finally { setBusy(null); }
  }
  async function remove() {
    if (!confirming) { setConfirming(true); return; }
    setBusy("remove"); setError(""); setResult(null);
    try { onChange(await removeSearchKey(engine, entry.id)); toast({ title: `${name} key removed`, body: `Key ••••${entry.last4 ?? ""} is no longer used.` }); }
    catch (cause) { setError(describeError(cause, "Could not remove the key. Try again.")); setBusy(null); }
  }

  return <li className="space-y-2 p-3">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs font-bold text-neutral-900">{label}</span>
      {entry.unreadable ? <Badge tone="red">Unreadable, remove it and add it again</Badge> : entry.usedUp ? <Badge tone="amber">Used up or refused: skipped until it resets</Badge> : null}
      <span className="tnum text-xs text-neutral-500 sm:ml-auto">{usage}</span>
    </div>
    {who && <p className="text-xs text-neutral-500">{who}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {!entry.unreadable && <button type="button" onClick={test} disabled={busy !== null} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}><ActionLabel busy={busy === "test"} busyText="Testing…" idle="Test" /></button>}
      {saved && <button type="button" onClick={remove} disabled={busy !== null} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs", confirming && "!border-danger-text !text-danger-text")}><ActionLabel busy={busy === "remove"} busyText="Removing…" idle={confirming ? "Yes, remove it" : "Remove"} /></button>}
      {saved && confirming && busy === null && <button type="button" onClick={() => setConfirming(false)} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}>Keep it</button>}
    </div>
    <div role="status" aria-live="polite">
      {result && <p className={clsx("flex items-start gap-2 rounded-xl p-3 text-xs font-semibold leading-5", result.ok ? "bg-success-surface text-success-text" : "bg-danger-surface text-danger-text")}>{result.ok ? <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />}<span className="min-w-0 [overflow-wrap:anywhere]">{result.ok ? `It works: ${name} answered a test search.` : result.message ?? "The test search failed."}</span></p>}
    </div>
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
  </li>;
}
