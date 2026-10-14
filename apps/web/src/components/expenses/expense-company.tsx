"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { ExpenseCompany } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, inputClass, Notice, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { companyLogoUrl, mergeCompany, refreshSoon, removeCompanyLogo, updateCompany, uploadCompanyLogo } from "@/lib/expenses-api";

// Companies in the expense tracker (docs/expenses.md#companies): a logo (or the company's initial) wherever an expense shows, and
// Settings → Companies to rename, set a website or logo, and merge two spellings into one.

/** Each logo is fetched once per page (its URL carries its version, so a changed logo is a new one). */
const logos = new Map<string, Promise<string | null>>();
function useCompanyLogo(company: Pick<ExpenseCompany, "id" | "logo"> | undefined) {
  const key = company?.logo ? `${company.id}:${company.logo}` : "";
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key || !company) return;
    let live = true;
    if (!logos.has(key)) logos.set(key, companyLogoUrl(company.id, company.logo!).catch(() => null));
    void logos.get(key)!.then((url) => { if (live) setLoaded({ key, url }); });
    return () => { live = false; };
  }, [key, company]);
  return loaded?.key === key ? loaded.url : null;
}

/** The company's logo on a white tile, or its initial on a coloured circle (as before logos). */
export function CompanyAvatar({ company, name, size = 36, background, className }: { company?: Pick<ExpenseCompany, "id" | "logo" | "name">; name: string; size?: number; background?: string; className?: string }) {
  const url = useCompanyLogo(company);
  const style = { width: size, height: size };
  // eslint-disable-next-line @next/next/no-img-element -- an authorized blob link can't use Next image optimization
  if (url) return <img src={url} alt="" aria-hidden="true" style={style} className={clsx("shrink-0 rounded-full bg-white object-contain p-1 ring-1 ring-black/5", className)} />;
  return <span aria-hidden="true" style={{ ...style, background: background ?? "var(--expense-neutral)", fontSize: Math.round(size * 0.4) }} className={clsx("grid shrink-0 place-items-center rounded-full font-bold text-white", className)}>{(company?.name ?? name).trim().charAt(0).toUpperCase() || "?"}</span>;
}

const linkButton = "min-h-8 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 hover:text-primary-800 disabled:opacity-50";

/** Settings → Companies (managers): every company with an expense they can see. */
export function CompaniesPanel({ companies, onChanged }: { companies: ExpenseCompany[]; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string; field: "name" | "website"; value: string } | null>(null);
  const [merging, setMerging] = useState<{ id: string; into: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const uploadFor = useRef("");
  const shown = useMemo(() => companies.filter((company) => !query.trim() || `${company.name} ${company.website ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())), [companies, query]);
  async function run(id: string, work: () => Promise<unknown>, done: string) {
    setBusy(id); setError("");
    try { await work(); toast({ title: done }); onChanged(); return true; }
    catch (cause) { setError(describeError(cause, "Could not save the company. Try again.")); return false; }
    finally { setBusy(""); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const value = editing.value.trim();
    if (editing.field === "name" && !value) return;
    let fetching = false;
    if (await run(editing.id, async () => { fetching = (await updateCompany(editing.id, editing.field === "name" ? { name: value } : { website: value || null })).fetching; }, editing.field === "name" ? "Company renamed" : value ? "Website saved: looking for its logo" : "Website removed")) {
      setEditing(null);
      if (fetching) refreshSoon(onChanged);
    }
  }
  /** Looks for the logo on the company's website again (after none was found, or for a company saved before logos). */
  async function findLogo(company: ExpenseCompany) {
    let fetching = false;
    if (await run(company.id, async () => { fetching = (await updateCompany(company.id, { website: company.website })).fetching; }, `Looking for ${company.name}'s logo`) && fetching) refreshSoon(onChanged);
  }
  return <Panel className="flex flex-col">
    <PanelHead title="Companies" aside={<span className="text-xs font-semibold text-neutral-500">{companies.length}</span>} />
    <p className="px-4 pt-3 text-xs leading-5 text-neutral-500 sm:px-5">Expenses are grouped by who they were paid to: the same name, GSTIN or website (&ldquo;GoDaddy.com, LLC&rdquo; and &ldquo;GODADDY INDIA&rdquo; are one). Merge any the grouping missed. Give a company its website and its logo is found for you (from the site, else Google&apos;s favicon service), or upload one.</p>
    {companies.length > 8 && <div className="px-4 pt-3 sm:px-5"><input aria-label="Find a company" className={clsx(inputClass, "!min-h-9 !text-sm")} placeholder="Find a company" value={query} onChange={(event) => setQuery(event.target.value)} /></div>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mx-4 mt-3 sm:mx-5" />
    {shown.length === 0 ? <p className="px-4 py-4 text-sm text-neutral-500 sm:px-5">{companies.length ? "No company matches." : "Companies appear here as expenses are added."}</p>
      : <ul className="divide-y divide-neutral-100 px-2 py-1 sm:px-3">{shown.map((company) => <li key={company.id} className={clsx("grid gap-2 px-2 py-2.5", busy === company.id && "opacity-60")}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <CompanyAvatar company={company} name={company.name} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-neutral-900">{company.name}</span>
            <span className="block truncate text-xs text-neutral-500">{[company.website, company.gstin && `GSTIN ${company.gstin}`, `${company.expenses} ${company.expenses === 1 ? "expense" : "expenses"}`].filter(Boolean).join(" · ")}</span>
            {company.logoStatus === "fetching" && <span role="status" className="mt-0.5 flex items-center gap-1.5 text-xs text-primary-700"><span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border-2 border-primary-200 border-t-primary-700" />Finding the logo on {company.website}…</span>}
            {company.logoStatus === "none" && company.website && <span className="mt-0.5 block text-xs text-warning-text">No logo found on {company.website}: upload one.</span>}
          </span>
          <span className="flex shrink-0 flex-wrap items-center gap-0.5">
            <button type="button" disabled={busy !== ""} onClick={() => setEditing({ id: company.id, field: "name", value: company.name })} className={linkButton}>Rename</button>
            <button type="button" disabled={busy !== ""} onClick={() => setEditing({ id: company.id, field: "website", value: company.website ?? "" })} className={linkButton}>Website</button>
            {company.website && !company.logo && company.logoStatus !== "fetching" && <button type="button" disabled={busy !== ""} onClick={() => void findLogo(company)} className={linkButton}>Find logo</button>}
            <button type="button" disabled={busy !== ""} onClick={() => { uploadFor.current = company.id; upload.current?.click(); }} className={linkButton}>{company.logo ? "New logo" : "Upload logo"}</button>
            {company.logo && <button type="button" disabled={busy !== ""} onClick={() => void run(company.id, () => removeCompanyLogo(company.id), "Logo removed")} className={clsx(linkButton, "!text-neutral-600 hover:!bg-neutral-100")}>Remove logo</button>}
            {companies.length > 1 && <button type="button" disabled={busy !== ""} onClick={() => setMerging({ id: company.id, into: "" })} className={clsx(linkButton, "!text-neutral-600 hover:!bg-neutral-100")}>Merge…</button>}
          </span>
        </div>
        {editing?.id === company.id && <form onSubmit={save} className="flex flex-wrap items-center gap-2 pl-11">
          <input aria-label={editing.field === "name" ? `New name for ${company.name}` : `Website of ${company.name}`} autoFocus maxLength={editing.field === "name" ? 120 : 300} placeholder={editing.field === "name" ? "Name" : "godaddy.com"}
            className={clsx(inputClass, "!min-h-8 min-w-0 !w-auto flex-1 basis-40 !text-sm")} value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(null); } }} />
          <button disabled={busy !== ""} className={clsx(primaryClass, "!min-h-8 !px-3 !text-xs")}><ActionLabel busy={busy === company.id} idle="Save" /></button>
          <button type="button" onClick={() => setEditing(null)} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>Cancel</button>
        </form>}
        {merging?.id === company.id && <div role="group" aria-label={`Merge ${company.name}`} className="flex flex-wrap items-center gap-2 pl-11">
          <span className="text-xs text-neutral-600">Merge into</span>
          <Select aria-label="Merge into" className="min-h-8 rounded-lg border border-neutral-200 bg-white pl-2.5 text-xs font-semibold text-neutral-700" value={merging.into} onChange={(event) => setMerging({ ...merging, into: event.target.value })}>
            <option value="">Pick a company</option>{companies.filter((other) => other.id !== company.id).map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
          </Select>
          <button type="button" disabled={busy !== "" || !merging.into} onClick={async () => { if (await run(company.id, () => mergeCompany(company.id, merging.into), `${company.name} merged`)) setMerging(null); }} className={clsx(primaryClass, "!min-h-8 !px-3 !text-xs")}><ActionLabel busy={busy === company.id} busyText="Merging…" idle="Merge" /></button>
          <button type="button" onClick={() => setMerging(null)} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>Cancel</button>
          <span className="basis-full text-xs leading-5 text-neutral-500">Its expenses and spellings move across; it&apos;s matched to the other from then on.</span>
        </div>}
      </li>)}</ul>}
    <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; const id = uploadFor.current; event.target.value = ""; if (file && id) void run(id, () => uploadCompanyLogo(id, file), "Logo saved"); }} />
  </Panel>;
}
