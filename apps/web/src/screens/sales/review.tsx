"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { OPEN_DRAFT_STATUSES } from "@venture-studio/contracts";
import { Check, Inbox, Info, Mail, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/studio/primitives";
import { getDraft, listPlays, listReviewDrafts, type ReviewDraft } from "@/lib/sales-api";
import { DraftVersions, type DraftChange } from "@/components/sales/draft-reader";
import { isOpenDraft, isVersioned, sortVersions, TONE_DOT, TONE_TEXT, versionRank, versionStatus } from "@/components/sales/draft-plan";
import { AskClaude } from "@/components/sales/ask-claude";
import { ago, approvalOf, CHANNEL_ICON, CHANNEL_LABEL, ChannelTile, kbdClass, PURPOSE_LABEL, Segmented, typingTarget, useIsDesktop, useQueryParam, useSalesLoad, useVentureSettings } from "@/components/sales/draft-shared";
import { useSalesShell } from "@/components/sales/sales-context";

const OPEN_STATUSES = OPEN_DRAFT_STATUSES.join(",");
const preview = (draft: ReviewDraft) => (draft.subject || draft.body).replace(/\s+/g, " ").trim();
type SectionKey = "review" | "approve" | "ready" | "changes" | "sent";
/** One lead in the list: its versions (an email and a WhatsApp version of the same message), and the one to act on first. */
type LeadRow = { leadId: string; versions: ReviewDraft[]; best: ReviewDraft; section: SectionKey };
const SECTIONS: { key: SectionKey; title: string }[] = [{ key: "review", title: "To review" }, { key: "approve", title: "To approve" }, { key: "ready", title: "Ready to send" }, { key: "changes", title: "Needs changes" }];

/** Review: a mail-style split view. One row per lead on the left; that lead's versions, Claude's review and what to do next on the right. */
export function ReviewScreen() {
  const { session, ventureId, ventureName } = useSalesShell();
  const desktop = useIsDesktop();
  const [filter, setFilter] = useState<"open" | "sent">("open");
  const [mine, setMine] = useState(false);
  const [selectedId, setSelectedId] = useQueryParam("draft");
  const [editNonce, setEditNonce] = useState(0);

  const status = filter === "open" ? OPEN_STATUSES : "sent";
  const drafts = useSalesLoad(`${ventureId}|${status}|${mine}`, () => listReviewDrafts({ ...(ventureId ? { ventureId } : {}), status, ...(mine ? { owner: "me" as const } : {}), limit: 100 }));
  const loaded = drafts.data !== null;

  // A link (?draft=) to a draft that is not in this list: another venture than the one picked, sent or closed, or past the first 100.
  // It is fetched on its own and opened. A draft that was in the list and left it (someone else sent it) just lets go.
  const [linkedDraft, setLinkedDraft] = useState<ReviewDraft | null>(null);
  const linked = linkedDraft && linkedDraft.id === selectedId ? linkedDraft : null;
  const plays = useSalesLoad(`plays|${ventureId}`, () => listPlays(ventureId ? { ventureId } : {}));
  const outsideVenture = linked && ventureId && linked.ventureId !== ventureId ? linked.ventureId : "";
  const linkedPlays = useSalesLoad(`plays-linked|${outsideVenture}`, () => outsideVenture ? listPlays({ ventureId: outsideVenture }) : Promise.resolve([]));
  const playById = useMemo(() => new Map([...(plays.data ?? []), ...(linkedPlays.data ?? [])].map((play) => [play.id, play])), [plays.data, linkedPlays.data]);
  // The venture's approval mode, only needed while the API does not say per draft whether a person must approve it.
  const settingsById = useVentureSettings([...(drafts.data ?? []), ...(linked ? [linked] : [])].filter((draft) => draft.status === "ready" && draft.needsPersonApproval === undefined).map((draft) => draft.ventureId));
  const approvalFor = useCallback((draft: ReviewDraft) => approvalOf(draft, draft.playId ? playById.get(draft.playId) : undefined, settingsById[draft.ventureId]), [playById, settingsById]);
  const playFor = useCallback((draft: ReviewDraft) => draft.playId ? playById.get(draft.playId) : undefined, [playById]);
  const settingsFor = useCallback((draft: ReviewDraft) => settingsById[draft.ventureId], [settingsById]);

  const groups = useMemo(() => {
    const byLead = new Map<string, ReviewDraft[]>();
    for (const draft of drafts.data ?? []) byLead.set(draft.leadId, [...(byLead.get(draft.leadId) ?? []), draft]);
    const rows: LeadRow[] = [...byLead.entries()].map(([leadId, list]) => {
      const versions = sortVersions(list);
      if (filter === "sent") {
        const best = [...versions].sort((a, b) => (b.sentAt ?? b.updatedAt).localeCompare(a.sentAt ?? a.updatedAt))[0]!;
        return { leadId, versions, best, section: "sent" as const };
      }
      // The version to act on first: ready, then to approve, in review, needs changes (the oldest first within each).
      const best = [...versions].sort((a, b) => versionRank(a, approvalFor(a).needed) - versionRank(b, approvalFor(b).needed) || a.createdAt.localeCompare(b.createdAt))[0]!;
      const section: SectionKey = best.status === "ready" ? (approvalFor(best).needed ? "approve" : "ready") : best.status === "needs_changes" ? "changes" : "review";
      return { leadId, versions, best, section };
    });
    if (filter === "sent") return [{ key: "sent" as SectionKey, title: "Sent", rows: rows.sort((a, b) => (b.best.sentAt ?? b.best.updatedAt).localeCompare(a.best.sentAt ?? a.best.updatedAt)) }];
    return SECTIONS.map((section) => ({ ...section, rows: rows.filter((row) => row.section === section.key).sort((a, b) => a.best.createdAt.localeCompare(b.best.createdAt)) })).filter((group) => group.rows.length > 0);
  }, [drafts.data, filter, approvalFor]);
  const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const listed = useMemo(() => drafts.data ?? [], [drafts.data]);
  const selected = listed.find((draft) => draft.id === selectedId) ?? linked ?? (desktop && !selectedId ? flat[0]?.best : undefined);
  const selectedRow = selected ? flat.find((row) => row.leadId === selected.leadId && row.versions.some((draft) => draft.id === selected.id)) : undefined;
  const versions = selectedRow?.versions ?? (selected ? [selected] : []);

  const removed = useRef("");
  const seen = useRef(new Set<string>());
  useEffect(() => { for (const draft of listed) seen.current.add(draft.id); }, [listed]);
  const wanted = useRef(selectedId);
  useEffect(() => { wanted.current = selectedId; }, [selectedId]);
  const lookedUp = useRef("");
  useEffect(() => {
    if (!loaded || !selectedId || linked || listed.some((draft) => draft.id === selectedId)) return;
    if (selectedId === removed.current || seen.current.has(selectedId)) { queueMicrotask(() => { if (wanted.current === selectedId) setSelectedId("", { replace: true }); }); return; }
    if (lookedUp.current === selectedId) return;
    lookedUp.current = selectedId;
    const id = selectedId;
    getDraft(id).then((found) => {
      if (wanted.current !== id) return;
      if (found) setLinkedDraft(found); else setSelectedId("", { replace: true });
    }).catch(() => { if (wanted.current === id) { lookedUp.current = ""; setSelectedId("", { replace: true }); } });
  }, [loaded, selectedId, linked, listed, setSelectedId]);
  // On a laptop the first lead is open by default; remember it in the link so a new draft arriving above it does not switch the one you are reading.
  useEffect(() => {
    const first = flat[0];
    if (desktop && !selectedId && first) queueMicrotask(() => setSelectedId(first.best.id, { replace: true }));
  }, [desktop, selectedId, flat, setSelectedId]);

  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-lead-row="${CSS.escape(selected.leadId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return;
      const index = flat.findIndex((row) => row.leadId === selected?.leadId);
      if (event.key === "j" || event.key === "k") {
        const next = flat[Math.min(flat.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
        if (next) { event.preventDefault(); setSelectedId(next.best.id, { replace: true }); }
      } else if (event.key === "e" && selected) { event.preventDefault(); setEditNonce((value) => value + 1); }
      else if (event.key === "Escape" && selectedId && !desktop) setSelectedId("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selected, selectedId, desktop, setSelectedId]);

  // On a phone the list and the reader take turns: open the reader at its top.
  const reader = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!desktop && selectedId) reader.current?.scrollIntoView({ block: "start" }); }, [desktop, selectedId]);

  function changed(given: DraftChange) {
    // A send refused because the draft changed since it was opened: the draft as it is now. Still open, it stays where it is (read again,
    // with the reader saying why); sent or closed meanwhile, it leaves the list like any other.
    if (given.kind === "reloaded" && isOpenDraft(given.draft)) {
      const fresh = (draft: ReviewDraft): ReviewDraft => ({ ...draft, ...given.draft });
      drafts.mutate((list) => list.map((draft) => draft.id === given.draft.id ? fresh(draft) : draft));
      setLinkedDraft((draft) => draft && draft.id === given.draft.id ? fresh(draft) : draft);
      return;
    }
    const change: DraftChange = given.kind === "reloaded" ? { kind: given.draft.status === "sent" ? "sent" : "closed", draft: given.draft } : given;
    // The answer to an edit or an approval is a plain draft: the row's approval fields no longer hold (the reload brings fresh ones).
    const merge = (draft: ReviewDraft): ReviewDraft => ({ ...draft, ...change.draft, needsPersonApproval: false, approvalReason: null });
    // A send that could not be confirmed (or one a person said didn't go) keeps the draft open with its new delivery state.
    if (change.kind === "edited" || change.kind === "approved" || change.kind === "delivery") {
      drafts.mutate((list) => list.map((draft) => draft.id === change.draft.id ? merge(draft) : draft));
      setLinkedDraft((draft) => draft && draft.id === change.draft.id ? merge(draft) : draft);
      return;
    }
    if (linked && linked.id === change.draft.id) { removed.current = change.draft.id; setLinkedDraft(null); setSelectedId(desktop && flat[0] ? flat[0].best.id : "", { replace: true }); return; }
    // Sent, vetoed or discarded: it leaves this list. Sending one version of a first message or follow-up closes the lead's other
    // versions of it (the API closes them; the reload confirms). Another version of the same lead opens next, else the next lead on a laptop, the list on a phone.
    const gone = (draft: ReviewDraft) => draft.id === change.draft.id || (filter === "open" && change.kind === "sent" && isVersioned(change.draft.purpose) && draft.leadId === change.draft.leadId && draft.purpose === change.draft.purpose);
    const index = flat.findIndex((row) => row.leadId === change.draft.leadId);
    const sameLead = flat[index]?.versions.filter((draft) => !gone(draft)) ?? [];
    const nextRow = flat[index + 1] ?? flat[index - 1];
    removed.current = change.draft.id;
    drafts.mutate((list) => list.filter((draft) => !gone(draft)));
    const next = sameLead.length ? [...sameLead].sort((a, b) => versionRank(a, approvalFor(a).needed) - versionRank(b, approvalFor(b).needed))[0] : nextRow && nextRow.leadId !== change.draft.leadId ? nextRow.best : undefined;
    setSelectedId(next && (desktop || sameLead.length) ? next.id : "", { replace: true });
  }
  function pickFilter(next: "open" | "sent") { setFilter(next); if (selectedId) setSelectedId("", { replace: true }); }

  const toolbar = <div className="mb-4 flex flex-wrap items-center gap-2">
    <Segmented label="Which drafts" value={filter} onChange={pickFilter} options={[{ value: "open", label: "To do" }, { value: "sent", label: "Sent" }]} />
    {session && <Segmented label="Whose drafts" value={mine ? "mine" : "all"} onChange={(value) => setMine(value === "mine")} options={[{ value: "all", label: "Everyone" }, { value: "mine", label: "Mine" }]} />}
    <span className="ml-auto flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-[11px] text-neutral-400 max-lg:hidden"><kbd className={kbdClass}>j</kbd><kbd className={kbdClass}>k</kbd>move{session?.membership.role !== "learner" && <><kbd className={kbdClass}>e</kbd>edit</>}</span>
    </span>
  </div>;

  if (drafts.error && !loaded) return <>{toolbar}<Panel><EmptyState variant="error" title="Could not load the drafts" body={drafts.error} action={{ label: drafts.busy ? "Trying again…" : "Try again", onClick: drafts.reload, disabled: drafts.busy }} /></Panel></>;
  if (!loaded) return <>{toolbar}<div role="status" aria-label="Loading drafts" className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]"><Panel className="space-y-3 p-4">{[0, 1, 2, 3, 4].map((index) => <div key={index} className="flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-xl" /><span className="grid min-w-0 flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${74 - (index % 3) * 12}%` }} /><span className="vso-skeleton h-2.5 w-2/3" /></span></div>)}</Panel><Panel className="space-y-4 p-5 max-lg:hidden"><span className="vso-skeleton block h-5 w-1/3" /><span className="vso-skeleton block h-40 rounded-2xl" /><span className="vso-skeleton block h-10 w-1/2" /></Panel></div></>;
  if (flat.length === 0 && !selected) return <>{toolbar}<Panel>{filter === "open"
    ? <EmptyState variant="card" tone="green" icon={Check} title={mine ? "Nothing of yours to review" : "Nothing waiting for review"} body={mine ? "None of the drafts on your leads need you right now." : "When Claude writes messages for your leads they land here, one row per lead."} action={mine ? { label: "Show everyone's drafts", onClick: () => setMine(false) } : undefined}>
      {!mine && session?.membership.role !== "learner" && <AskClaude prompt="write first messages for my recommended leads" className="mt-1 w-full max-w-lg text-left" />}
    </EmptyState>
    : <EmptyState variant="card" tone="blue" icon={Inbox} title="Nothing sent yet" body="Messages you send, or mark as sent, show up here, so you can see what went out." />}</Panel></>;

  return <>
    {!(selected && !desktop) && toolbar}
    {drafts.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{drafts.error}</p>}
    <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Panel className={clsx("thin-scroll overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto", selected && !desktop && "hidden")}>
        {groups.map((group) => <div key={group.key}>
          <h2 className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white px-4 py-2.5 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500"><span>{group.title}</span><span className="tnum rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{group.rows.length}</span></h2>
          <ul>{group.rows.map((row) => <ReviewRow key={row.leadId} row={row} active={selectedRow?.leadId === row.leadId} approvalNeeded={approvalFor(row.best).needed} venture={ventureId ? "" : ventureName(row.best.ventureId)} onOpen={() => setSelectedId(row.best.id, { replace: desktop })} />)}</ul>
        </div>)}
      </Panel>
      <div ref={reader} className={clsx("min-w-0 scroll-mt-4", !selected && !desktop && "hidden")}><Panel>
        {selected && selected === linked && ventureId && selected.ventureId !== ventureId && <p className="flex items-center gap-2 rounded-t-2xl border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold text-neutral-600 sm:px-5"><Info size={14} className="shrink-0 text-neutral-400" aria-hidden="true" />From {ventureName(selected.ventureId)}</p>}
        {selected ? <DraftVersions key={selected.leadId} versions={versions} selected={selected} onSelect={(id) => setSelectedId(id, { replace: true })} approvalFor={approvalFor} playFor={playFor} settingsFor={settingsFor} allowMissing={filter === "open" && selected !== linked} editNonce={editNonce} onBack={() => setSelectedId("")} onChanged={changed} />
          : <EmptyState variant="select" icon={Sparkles} title="Pick a lead to read" body="Its versions, Claude's review and what to do next show up here." />}
      </Panel></div>
    </div>
  </>;
}

/** A lead in the list: the company, the message to act on first, an icon for each version and that version's state. */
function ReviewRow({ row, active, approvalNeeded, venture, onOpen }: { row: LeadRow; active: boolean; approvalNeeded: boolean; venture: string; onOpen: () => void }) {
  const { best, versions } = row;
  const status = versionStatus(best, approvalNeeded);
  const channels = versions.map((draft) => CHANNEL_LABEL[draft.channel] ?? draft.channel).join(", ");
  return <li><button type="button" data-lead-row={row.leadId} aria-current={active ? "true" : undefined} onClick={onOpen} className={clsx("flex min-h-[76px] w-full items-center gap-3 border-b border-neutral-50 px-4 py-3 text-left transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:scale-[0.995]", active ? "bg-primary-50" : "hover:bg-neutral-50")}>
    <ChannelTile channel={best.channel} size={36} />
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[13px] font-bold text-neutral-900">{best.lead.companyName}</span><time dateTime={best.sentAt ?? best.createdAt} className="tnum shrink-0 text-[11px] text-neutral-400">{ago(best.sentAt ?? best.createdAt)}</time></span>
      <span className="mt-0.5 block truncate text-xs text-neutral-500">{PURPOSE_LABEL[best.purpose]} · {preview(best)}</span>
      <span className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] font-semibold">
        <span role="img" aria-label={`${versions.length === 1 ? "One version" : `${versions.length} versions`}: ${channels}`} className="flex shrink-0 items-center gap-1">{versions.map((draft) => { const VersionIcon = CHANNEL_ICON[draft.channel] ?? Mail; return <span key={draft.id} aria-hidden="true" className={clsx("grid h-5 w-5 place-items-center rounded-md", draft.id === best.id ? "bg-neutral-200/70 text-neutral-700" : "bg-neutral-100 text-neutral-400")}><VersionIcon size={12} /></span>; })}</span>
        <span className={clsx("inline-flex shrink-0 items-center gap-1", TONE_TEXT[status.tone])}><span aria-hidden="true" className={clsx("h-1.5 w-1.5 rounded-full", TONE_DOT[status.tone])} />{status.label === "To approve" ? "Approve first" : status.label}</span>
        {venture && <span className="truncate text-neutral-400">{venture}</span>}
      </span>
    </span>
  </button></li>;
}
