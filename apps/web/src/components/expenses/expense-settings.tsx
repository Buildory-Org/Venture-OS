"use client";
import { useState } from "react";
import clsx from "clsx";
import { EXPENSE_COLORS, type ExpenseAccessLevel } from "@venture-studio/contracts";
import { LockKeyhole, Plus } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, inputClass, Notice, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { CompaniesPanel } from "./expense-company";
import { createCategory, createGroup, setExpenseAccess, updateCategory, updateGroup, type ExpenseCategory, type ExpenseGroup, type ExpenseMemberAccess, type ExpenseSettings } from "@/lib/expenses-api";

type Color = (typeof EXPENSE_COLORS)[number];
const COLOR_NAME: Record<Color, string> = { green: "Green", blue: "Blue", amber: "Amber", red: "Red", purple: "Purple", neutral: "Grey" };
const LEVELS: { level: ExpenseAccessLevel; label: string; hint: string }[] = [
  { level: "none", label: "None", hint: "doesn't see expenses" },
  { level: "view", label: "View", hint: "sees expenses and totals" },
  { level: "edit", label: "Edit", hint: "adds, edits and deletes" },
  { level: "manage", label: "Manage", hint: "also runs these settings" },
];
/** A small select that sizes to its text (the shared input style fills the row). */
const compactSelect = "min-h-8 rounded-lg border border-neutral-200 bg-white pl-2.5 text-xs font-semibold text-neutral-700 outline-none transition-[border-color] duration-150 hover:border-neutral-300";
const linkButton = "min-h-8 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 hover:text-primary-800 disabled:opacity-50";

/** Categories, groups and who may do what. Managers only (the API refuses everyone else). */
export function ExpenseSettingsPanel({ settings, onChanged }: { settings: ExpenseSettings; onChanged: () => void }) {
  return <div className="grid grid-cols-1 gap-4">
    <AccessPanel settings={settings} onChanged={onChanged} />
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ListPanel kind="category" title="Categories" items={settings.categories} canRestrict={settings.me.restricted} onChanged={onChanged} />
      <ListPanel kind="group" title="Groups" items={settings.groups} canRestrict={false} onChanged={onChanged} />
    </div>
    <CompaniesPanel companies={settings.companies} onChanged={onChanged} />
  </div>;
}

/** One row per person: the level as a four-way switch, and whether they see restricted categories. */
function AccessPanel({ settings, onChanged }: { settings: ExpenseSettings; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const people = [...(settings.access ?? [])].sort((a, b) => LEVELS.findIndex((item) => item.level === b.level) - LEVELS.findIndex((item) => item.level === a.level) || a.name.localeCompare(b.name));
  const withAccess = people.filter((person) => person.level !== "none").length;
  async function save(person: ExpenseMemberAccess, level: ExpenseAccessLevel, restricted: boolean) {
    if (level === person.level && restricted === person.restricted) return;
    setBusy(person.userId); setError("");
    try { await setExpenseAccess(person.userId, { level, restricted: level === "none" ? false : restricted }); toast({ title: "Access saved", body: `${person.name}: ${LEVELS.find((item) => item.level === level)!.label}${level !== "none" && restricted ? " · sees salaries & EMI" : ""}` }); onChanged(); }
    catch (cause) { setError(describeError(cause, "Could not save the access. Try again.")); }
    finally { setBusy(""); }
  }
  return <Panel>
    <PanelHead title="Who can see and change expenses" aside={<span className="tnum text-xs font-semibold text-neutral-500">{withAccess} of {people.length} have access</span>} />
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mx-4 mt-3 sm:mx-5" />
    <div role="table" aria-label="Expense access" className="px-2 py-1 sm:px-3">
      <div role="row" className="hidden grid-cols-[minmax(0,1fr)_15rem_9rem] items-center gap-4 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 md:grid">
        <span role="columnheader">Person</span><span role="columnheader">Access</span><span role="columnheader">Salaries &amp; EMI</span>
      </div>
      {people.map((person) => {
        const saving = busy === person.userId;
        const canRestrict = settings.me.restricted && person.level !== "none";
        return <div role="row" key={person.userId} className={clsx("grid grid-cols-1 items-center gap-2 rounded-xl px-2 py-2.5 md:grid-cols-[minmax(0,1fr)_15rem_9rem] md:gap-4", saving && "opacity-60")}>
          <div role="cell" className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-bold text-neutral-900">{person.name}</span>
            <span className="shrink-0 text-xs text-neutral-500">{person.role.replace("_", " ")}{person.custom ? "" : " · default"}</span>
          </div>
          <div role="cell">
            <div role="radiogroup" aria-label={`${person.name}'s access`} className="inline-flex rounded-lg bg-neutral-100 p-0.5">
              {LEVELS.map((item) => <button key={item.level} type="button" role="radio" aria-checked={person.level === item.level} disabled={busy !== ""} title={item.hint}
                onClick={() => void save(person, item.level, person.restricted)}
                className={clsx("min-h-8 rounded-md px-3 text-xs font-semibold transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600",
                  person.level === item.level ? (item.level === "none" ? "bg-white text-neutral-700 shadow-sm" : "bg-primary-700 text-white shadow-sm") : "text-neutral-500 hover:text-neutral-800")}>{item.label}</button>)}
            </div>
          </div>
          <div role="cell">
            <button type="button" role="switch" aria-checked={person.level !== "none" && person.restricted} aria-label={`${person.name} sees salaries and EMI`} disabled={busy !== "" || !canRestrict}
              title={!settings.me.restricted ? "Only people who see salaries and EMI can change this" : person.level === "none" ? "Give access first" : undefined}
              onClick={() => void save(person, person.level, !person.restricted)}
              className="inline-flex min-h-8 items-center gap-2 rounded-lg pr-1 text-xs font-semibold text-neutral-700 disabled:cursor-not-allowed disabled:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
              {/* The knob is pinned to the left (the button centres its text, which would otherwise start it mid-track) and stays white
                  in the dark theme, like the app's other switches; dimmed when this person can't change it. */}
              <span aria-hidden="true" className={clsx("relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150", person.level !== "none" && person.restricted ? "bg-primary-700" : "bg-[#a3a3a3]", !canRestrict && "opacity-50")}>
                <span className={clsx("absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#fff] shadow-sm transition-transform duration-150", person.level !== "none" && person.restricted ? "translate-x-4" : "translate-x-0")} />
              </span>
              <LockKeyhole size={13} aria-hidden="true" className="md:hidden" /><span className="md:hidden">Salaries &amp; EMI</span><span className="hidden md:inline">{person.level !== "none" && person.restricted ? "Sees them" : "Hidden"}</span>
            </button>
          </div>
        </div>;
      })}
    </div>
    <p className="border-t border-neutral-100 px-4 py-3 text-xs leading-5 text-neutral-500 sm:px-5">
      {LEVELS.filter((item) => item.level !== "none").map((item, index) => <span key={item.level}>{index ? " · " : ""}<strong className="font-semibold text-neutral-700">{item.label}</strong> {item.hint}</span>)}. Someone must always keep Manage with salaries &amp; EMI.
    </p>
  </Panel>;
}

type Item = (ExpenseCategory | ExpenseGroup) & { restricted?: boolean };
/** Categories or groups: one line each (name, colour, actions), and a line to add one. */
function ListPanel({ kind, title, items, canRestrict, onChanged }: { kind: "category" | "group"; title: string; items: Item[]; canRestrict: boolean; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<Color>("neutral");
  const [restricted, setRestricted] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const word = kind === "category" ? "category" : "group";
  const shown = items.filter((item) => showArchived || !item.archived);
  const archivedCount = items.filter((item) => item.archived).length;
  async function run(key: string, work: () => Promise<unknown>, done: string) {
    setBusy(key); setError("");
    try { await work(); toast({ title: done }); onChanged(); return true; }
    catch (cause) { setError(describeError(cause, `Could not save the ${word}. Try again.`)); return false; }
    finally { setBusy(""); }
  }
  const change = (id: string, patch: Partial<Item>) => run(id, () => (kind === "category" ? updateCategory(id, patch) : updateGroup(id, patch)), `${kind === "category" ? "Category" : "Group"} saved`);
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const saved = await run("add", () => (kind === "category" ? createCategory({ name: name.trim(), color, restricted }) : createGroup({ name: name.trim(), color, note: "" })), `${name.trim()} added`);
    if (saved) { setName(""); setRestricted(false); setColor("neutral"); }
  }
  return <Panel className="flex flex-col">
    <PanelHead title={title} aside={archivedCount > 0 ? <button type="button" onClick={() => setShowArchived(!showArchived)} className={linkButton}>{showArchived ? "Hide" : "Show"} {archivedCount} archived</button> : undefined} />
    {kind === "group" && <p className="px-4 pt-3 text-xs leading-5 text-neutral-500 sm:px-5">Bundle related expenses (&ldquo;AI subscriptions&rdquo;, &ldquo;Domains&rdquo;) to see what each costs a month and a year.</p>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mx-4 mt-3 sm:mx-5" />
    {shown.length === 0 ? <p className="px-4 py-4 text-sm text-neutral-500 sm:px-5">No {kind === "category" ? "categories" : "groups"} yet.</p> : <ul className="flex-1 divide-y divide-neutral-100 px-2 py-1 sm:px-3">{shown.map((item) => <li key={item.id} className={clsx("flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5", busy === item.id && "opacity-60", item.archived && "opacity-70")}>
      {editing?.id === item.id
        ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={async (event) => { event.preventDefault(); if (editing.name.trim() && await change(item.id, { name: editing.name.trim() })) setEditing(null); }}>
            <input aria-label={`New name for ${item.name}`} autoFocus maxLength={60} className={clsx(inputClass, "!min-h-8 min-w-0 flex-1 !text-sm")} value={editing.name} onChange={(event) => setEditing({ id: item.id, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(null); } }} />
            <button disabled={busy !== ""} className={clsx(primaryClass, "!min-h-8 !px-3 !text-xs")}>Save</button>
            <button type="button" onClick={() => setEditing(null)} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>Cancel</button>
          </form>
        : <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <Badge tone={item.color}>{item.name}</Badge>
              {item.restricted && <LockKeyhole size={13} aria-label="Restricted" className="shrink-0 text-neutral-500" />}
              {item.archived && <span className="text-xs text-neutral-400">archived</span>}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              <Select aria-label={`Colour of ${item.name}`} disabled={busy !== ""} className={clsx(compactSelect, "w-24")} value={item.color} onChange={(event) => void change(item.id, { color: event.target.value as Color })}>{EXPENSE_COLORS.map((one) => <option key={one} value={one}>{COLOR_NAME[one]}</option>)}</Select>
              <button type="button" disabled={busy !== ""} onClick={() => setEditing({ id: item.id, name: item.name })} className={linkButton}>Rename</button>
              {kind === "category" && canRestrict && <button type="button" disabled={busy !== ""} onClick={() => void change(item.id, { restricted: !item.restricted })} className={clsx(linkButton, "w-[5.25rem]")}>{item.restricted ? "Unrestrict" : "Restrict"}</button>}
              <button type="button" disabled={busy !== ""} onClick={() => void change(item.id, { archived: !item.archived })} className={clsx(linkButton, "w-[4.25rem] !text-neutral-600 hover:!bg-neutral-100")}>{item.archived ? "Restore" : "Archive"}</button>
            </span>
          </>}
    </li>)}</ul>}
    <form onSubmit={add} className="flex flex-wrap items-center gap-2 border-t border-neutral-100 px-4 py-3 sm:px-5">
      <input aria-label={`New ${word}`} maxLength={60} className={clsx(inputClass, "!min-h-9 min-w-0 !w-auto flex-1 basis-36 !text-sm")} value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "category" ? "New category, e.g. Travel" : "New group, e.g. AI subscriptions"} />
      <Select aria-label={`Colour of the new ${word}`} className={clsx(compactSelect, "w-24")} value={color} onChange={(event) => setColor(event.target.value as Color)}>{EXPENSE_COLORS.map((one) => <option key={one} value={one}>{COLOR_NAME[one]}</option>)}</Select>
      {kind === "category" && canRestrict && <label className="inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-neutral-700"><input type="checkbox" className="h-4 w-4 accent-primary-700" checked={restricted} onChange={(event) => setRestricted(event.target.checked)} /><LockKeyhole size={13} aria-hidden="true" />Restricted</label>}
      <button disabled={busy !== "" || !name.trim()} className={clsx(primaryClass, "!min-h-9 !px-3 !text-xs")}><Plus size={14} /><ActionLabel busy={busy === "add"} busyText="Adding…" idle="Add" /></button>
    </form>
  </Panel>;
}

