"use client";

import { useEffect, useState } from "react";
import { listLiveMembers } from "@/lib/studio-api";
import { inputClass, secondaryClass } from "@/components/studio/primitives";

type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];

export function LiveMemberPicker({ label, value, onChange, ventureId, groupId, excludeIds = [], optional = false }: {
  label: string;
  value: string;
  onChange: (id: string, member?: Member) => void;
  ventureId?: string;
  groupId?: string;
  excludeIds?: string[];
  optional?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      listLiveMembers({ ventureId, groupId, ...(query ? { q: query } : {}), limit: 50 }).then((page) => {
        if (active) { setMembers(page.items); setCursor(page.nextCursor); setError(""); setBusy(false); }
      }).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load members."); setBusy(false); } });
    });
    return () => { active = false; };
  }, [ventureId, groupId, query]);

  async function more() {
    if (!cursor) return;
    setBusy(true); setError("");
    try {
      const page = await listLiveMembers({ ventureId, groupId, ...(query ? { q: query } : {}), cursor, limit: 50 });
      setMembers((items) => [...items, ...page.items]); setCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load more members."); }
    finally { setBusy(false); }
  }

  function search() {
    const next = draft.trim();
    if (next && next.length < 2) { setError("Search at least two characters."); return; }
    setQuery(next);
  }

  const visible = members.filter((member) => !excludeIds.includes(member.id));
  return <div className="min-w-0"><label className="block"><span className="mb-1.5 block text-xs font-extrabold text-neutral-600">{label}</span><select required={!optional} className={inputClass} value={value} onChange={(event) => onChange(event.target.value, visible.find((member) => member.id === event.target.value))}><option value="">{optional ? "None" : "Choose a member"}</option>{value && !visible.some((member) => member.id === value) && <option value={value}>Current member · {value}</option>}{visible.map((member) => <option key={member.id} value={member.id}>{member.name}{member.handle ? ` · @${member.handle}` : ""}</option>)}</select></label><div className="mt-2 flex gap-2"><label className="sr-only" htmlFor={`${label.replaceAll(" ", "-")}-member-search`}>Search {label.toLowerCase()}</label><input id={`${label.replaceAll(" ", "-")}-member-search`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }} className={inputClass} placeholder="Search name or handle" /><button type="button" onClick={search} className={secondaryClass}>Search</button></div>{cursor && <button type="button" disabled={busy} onClick={more} className="mt-2 text-xs font-bold text-primary-700 underline">Load more members</button>}{error && <p role="alert" className="mt-1 text-xs text-danger-text">{error}</p>}</div>;
}
