"use client";
import { useState } from "react";
import clsx from "clsx";
import { EXPENSE_COLORS, type ExpenseAccessLevel } from "@venture-studio/contracts";
import { LockKeyhole, Plus } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, inputClass, Notice, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createCategory, createGroup, setExpenseAccess, updateCategory, updateGroup, type ExpenseCategory, type ExpenseGroup, type ExpenseSettings } from "@/lib/expenses-api";

type Color = (typeof EXPENSE_COLORS)[number];
const COLOR_NAME: Record<Color, string> = { green: "Green", blue: "Blue", amber: "Amber", red: "Red", purple: "Purple", neutral: "Grey" };
const LEVELS: { level: ExpenseAccessLevel; label: string; hint: string }[] = [
  { level: "none", label: "No access", hint: "Doesn't see expenses" },
  { level: "view", label: "View", hint: "Sees expenses, changes nothing" },
  { level: "edit", label: "Edit", hint: "Adds, edits and deletes expenses" },
  { level: "manage", label: "Manage", hint: "Edit, plus categories, groups and access" },
];

/** Categories, groups and who may do what. Managers only (the API refuses everyone else). */
export function ExpenseSettingsPanel({ settings, onChanged }: { settings: ExpenseSettings; onChanged: () => void }) {
  return <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
    <AccessPanel settings={settings} onChanged={onChanged} />
    <div className="grid grid-cols-1 content-start gap-4">
      <ListPanel kind="category" title="Categories" items={settings.categories} canRestrict={settings.me.restricted} onChanged={onChanged} />
      <ListPanel kind="group" title="Groups" items={settings.groups} canRestrict={false} onChanged={onChanged} />
    </div>
  </div>;
}

function AccessPanel({ settings, onChanged }: { settings: ExpenseSettings; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function save(userId: string, level: ExpenseAccessLevel, restricted: boolean, name: string) {
    setBusy(userId); setError("");
    try { await setExpenseAccess(userId, { level, restricted }); toast({ title: "Access saved", body: `${name}: ${LEVELS.find((item) => item.level === level)!.label}${restricted ? ", sees restricted" : ""}` }); onChanged(); }
    catch (cause) { setError(describeError(cause, "Could not save the access. Try again.")); }
    finally { setBusy(""); }
  }
  return <Panel>
    <PanelHead title="Who can see and change expenses" />
    <div className="px-4 pt-3 sm:px-5"><p className="text-xs leading-5 text-neutral-500">Admins manage by default; everyone else sees nothing until you give them access. &ldquo;Restricted&rdquo; lets someone see restricted categories such as salaries. Someone must always keep Manage with restricted.</p></div>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mx-4 mt-3 sm:mx-5" />
    <ul className="mt-2 divide-y divide-neutral-100">{(settings.access ?? []).map((person) => <li key={person.userId} className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5">
      <div className="min-w-0"><p className="truncate text-sm font-bold text-neutral-900">{person.name}</p><p className="text-xs text-neutral-500">{person.role.replace("_", " ")}{person.custom ? "" : " · default for the role"}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={`${person.name}'s access`} disabled={busy !== ""} className={clsx(inputClass, "!min-h-9 !w-36")} value={person.level} onChange={(event) => void save(person.userId, event.target.value as ExpenseAccessLevel, event.target.value === "none" ? false : person.restricted, person.name)}>{LEVELS.map((item) => <option key={item.level} value={item.level}>{item.label}</option>)}</Select>
        <label className={clsx("inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-semibold", person.level === "none" || !settings.me.restricted ? "text-neutral-400" : "text-neutral-700")}>
          <input type="checkbox" className="h-4 w-4 accent-primary-700" disabled={busy !== "" || person.level === "none" || !settings.me.restricted} checked={person.restricted} onChange={(event) => void save(person.userId, person.level, event.target.checked, person.name)} />
          <LockKeyhole size={13} aria-hidden="true" />Restricted
        </label>
      </div>
    </li>)}</ul>
    <dl className="grid grid-cols-1 gap-1.5 border-t border-neutral-100 px-4 py-3 text-xs sm:px-5">{LEVELS.map((item) => <div key={item.level} className="flex gap-2"><dt className="w-20 shrink-0 font-semibold text-neutral-700">{item.label}</dt><dd className="text-neutral-500">{item.hint}</dd></div>)}</dl>
  </Panel>;
}

type Item = (ExpenseCategory | ExpenseGroup) & { restricted?: boolean };
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
  const change = (id: string, patch: Partial<Item>) => run(id, () => (kind === "category" ? updateCategory(id, patch) : updateGroup(id, patch)), `${title.slice(0, -1).replace(/ie$/, "y")} saved`);
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const saved = await run("add", () => (kind === "category" ? createCategory({ name: name.trim(), color, restricted }) : createGroup({ name: name.trim(), color, note: "" })), `${name.trim()} added`);
    if (saved) { setName(""); setRestricted(false); setColor("neutral"); }
  }
  return <Panel>
    <PanelHead title={title} aside={archivedCount > 0 ? <button type="button" onClick={() => setShowArchived(!showArchived)} className="text-xs font-semibold text-primary-700 hover:text-primary-800">{showArchived ? "Hide" : "Show"} {archivedCount} archived</button> : undefined} />
    {kind === "group" && <p className="px-4 pt-3 text-xs leading-5 text-neutral-500 sm:px-5">Bundle related expenses, like &ldquo;AI subscriptions&rdquo; or &ldquo;Domains&rdquo;, to see what each bundle costs a month and a year.</p>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mx-4 mt-3 sm:mx-5" />
    {shown.length === 0 ? <p className="px-4 py-3 text-sm text-neutral-500 sm:px-5">No {kind === "category" ? "categories" : "groups"} yet.</p> : <ul className="divide-y divide-neutral-100">{shown.map((item) => <li key={item.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-5">
      {editing?.id === item.id
        ? <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2" onSubmit={async (event) => { event.preventDefault(); if (editing.name.trim() && await change(item.id, { name: editing.name.trim() })) setEditing(null); }}>
            <input aria-label={`New name for ${item.name}`} autoFocus maxLength={60} className={clsx(inputClass, "!min-h-9 min-w-0 flex-1")} value={editing.name} onChange={(event) => setEditing({ id: item.id, name: event.target.value })} />
            <button disabled={busy !== ""} className={clsx(primaryClass, "!min-h-9 !px-3 !text-xs")}>Save</button>
            <button type="button" onClick={() => setEditing(null)} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}>Cancel</button>
          </form>
        : <>
            <span className="flex min-w-0 flex-1 items-center gap-2"><Badge tone={item.color}>{item.name}</Badge>{item.restricted && <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><LockKeyhole size={12} aria-hidden="true" />Restricted</span>}{item.archived && <span className="text-xs text-neutral-400">Archived</span>}</span>
            <Select aria-label={`Colour of ${item.name}`} disabled={busy !== ""} className={clsx(inputClass, "!min-h-9 !w-28 !text-xs")} value={item.color} onChange={(event) => void change(item.id, { color: event.target.value as Color })}>{EXPENSE_COLORS.map((one) => <option key={one} value={one}>{COLOR_NAME[one]}</option>)}</Select>
            <button type="button" onClick={() => setEditing({ id: item.id, name: item.name })} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 hover:text-primary-800">Rename</button>
            {kind === "category" && canRestrict && <button type="button" disabled={busy !== ""} onClick={() => void change(item.id, { restricted: !item.restricted })} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 hover:text-primary-800">{item.restricted ? "Unrestrict" : "Restrict"}</button>}
            <button type="button" disabled={busy !== ""} onClick={() => void change(item.id, { archived: !item.archived })} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-neutral-600 hover:text-neutral-900">{item.archived ? "Restore" : "Archive"}</button>
          </>}
    </li>)}</ul>}
    <form onSubmit={add} className="flex flex-wrap items-end gap-2 border-t border-neutral-100 px-4 py-3 sm:px-5">
      <label className="min-w-0 flex-1 basis-40"><span className="mb-1.5 block text-xs font-semibold text-neutral-600">New {word}</span><input maxLength={60} className={clsx(inputClass, "!min-h-10")} value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "category" ? "Travel" : "AI subscriptions"} /></label>
      <Select aria-label={`Colour of the new ${word}`} className={clsx(inputClass, "!min-h-10 !w-28 !text-xs")} value={color} onChange={(event) => setColor(event.target.value as Color)}>{EXPENSE_COLORS.map((one) => <option key={one} value={one}>{COLOR_NAME[one]}</option>)}</Select>
      {kind === "category" && canRestrict && <label className="inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-neutral-700"><input type="checkbox" className="h-4 w-4 accent-primary-700" checked={restricted} onChange={(event) => setRestricted(event.target.checked)} />Restricted</label>}
      <button disabled={busy !== "" || !name.trim()} className={clsx(primaryClass, "!min-h-10 !px-3 !text-xs")}><Plus size={14} /><ActionLabel busy={busy === "add"} busyText="Adding…" idle="Add" /></button>
    </form>
  </Panel>;
}
