"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { OPEN_DRAFT_STATUSES } from "@venture-studio/contracts";
import { Check, Clock3, Inbox, Info, RotateCcw, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { toast } from "@/components/ui/toast";
import { Notice, Panel } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { getDraft, listPlays, listReviewDrafts, type ReviewDraft } from "@/lib/sales-api";
import { isRouteMissing } from "@/lib/sales-channels-api";
import { batchDrafts, type DraftBatchResult } from "@/lib/sales-autopilot-api";
import { DraftVersions, type DraftChange } from "@/components/sales/draft-reader";
import { isOpenDraft, isVersioned, sortVersions, versionRank } from "@/components/sales/draft-plan";
import { AskClaude } from "@/components/sales/ask-claude";
import { approvalOf, canApprove, kbdClass, typingTarget, useIsDesktop, useQueryParam, useSalesLoad, useVentureSettings } from "@/components/sales/draft-shared";
import { canHead, canWorkLead, CHANNEL_LABELS, plural } from "@/components/sales/sales-ui";
import { useSalesShell } from "@/components/sales/sales-context";
import { useSalesOverview } from "@/components/sales/overview-context";
import { useAutopilot } from "@/components/sales/use-autopilot";
import { BATCH_MAX, batchLeftovers, batchToast, ReviewBatchBar, RowCheck, type BatchSection } from "@/components/sales/review-batch";
import { ACTION_SECTIONS, NoCheck, QUIET_SECTIONS, queuedTitle, ReviewRow, rowOf, SECTION_EMPTY, SECTION_TITLE, SectionHead, STUCK_LINE, type LeadRow, type SectionKey } from "@/components/sales/review-sections";

const OPEN_STATUSES = OPEN_DRAFT_STATUSES.join(",");
/** Whether this person may tick a row: yes, no with the reason (a lock with it), or no without a lock (sent by hand). Null: no checkbox. */
type Pickable = { ok: true } | { ok: false; why: string; quiet?: boolean } | null;
type ListNotice = { tone: "info" | "error"; text: string };

/**
 * Review: a mail-style split view. One row per lead on the left, grouped by what the person does (Approve, Send, Fix, then quietly what
 * is being checked and what the app sends today); that lead's versions, the check and what to do next on the right. Approve and Send
 * rows can be ticked and approved or sent together.
 */
export function ReviewScreen() {
  const { session, ventureId, ventureName, refresh } = useSalesShell();
  // Mine or Everyone: the same choice, control and default as Today (kept by the Sales layout for every work page).
  const { scope, setScope } = useSalesOverview();
  const mine = scope === "me";
  const desktop = useIsDesktop();
  const [filter, setFilter] = useState<"open" | "sent">("open");
  const [selectedId, setSelectedId] = useQueryParam("draft");
  const [editNonce, setEditNonce] = useState(0);
  const [unfolded, setUnfolded] = useState<ReadonlySet<SectionKey>>(new Set());
  const [picked, setPicked] = useState<{ section: BatchSection; ids: ReadonlySet<string> } | null>(null);
  const [notice, setNotice] = useState<ListNotice | null>(null);
  const [routeMissing, setRouteMissing] = useState(false);
  const [takingBack, setTakingBack] = useState("");
  const foldId = useId();

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

  // The app: does it check drafts itself (then "Being checked" is one quiet line, with no chat to open), and can it send approved emails
  // from the queue (then Approve and Send rows can be ticked)? A server without the autopilot or the batch route works as before.
  const autopilot = useAutopilot(ventureId || drafts.data?.[0]?.ventureId || null);
  const appChecks = Boolean(ventureId) && autopilot.does("review");
  const appWrites = Boolean(ventureId) && autopilot.does("write");
  const batchOn = Boolean(autopilot.status) && !routeMissing && filter === "open";
  const canQueue = batchOn && autopilot.canQueue;

  const groups = useMemo(() => {
    const byLead = new Map<string, ReviewDraft[]>();
    for (const draft of drafts.data ?? []) byLead.set(draft.leadId, [...(byLead.get(draft.leadId) ?? []), draft]);
    if (filter === "sent") {
      const rows: LeadRow[] = [...byLead.entries()].map(([leadId, list]) => {
        const versions = sortVersions(list);
        const best = [...versions].sort((a, b) => (b.sentAt ?? b.updatedAt).localeCompare(a.sentAt ?? a.updatedAt))[0]!;
        return { leadId, versions, best, section: "sent" as const };
      });
      return [{ key: "sent" as SectionKey, title: SECTION_TITLE.sent, rows: rows.sort((a, b) => (b.best.sentAt ?? b.best.updatedAt).localeCompare(a.best.sentAt ?? a.best.updatedAt)) }];
    }
    const rows = [...byLead.entries()].map(([leadId, list]) => rowOf(leadId, list, (draft) => approvalFor(draft).needed));
    // The oldest first in each section (it has waited longest); queued ones in the order they go.
    const order = (key: SectionKey) => (a: LeadRow, b: LeadRow) => key === "queued" ? (a.best.sendQueue?.notBefore ?? "").localeCompare(b.best.sendQueue?.notBefore ?? "") : a.best.createdAt.localeCompare(b.best.createdAt);
    return [...ACTION_SECTIONS, ...QUIET_SECTIONS].map((key) => {
      const list = rows.filter((row) => row.section === key).sort(order(key));
      return { key: key as SectionKey, title: key === "queued" ? queuedTitle(list) : SECTION_TITLE[key], rows: list };
    });
  }, [drafts.data, filter, approvalFor]);
  const allRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const listed = useMemo(() => drafts.data ?? [], [drafts.data]);
  const chosen = listed.find((draft) => draft.id === selectedId) ?? linked ?? undefined;
  // Quiet sections are folded, except the one holding the message that is open (a link to it, or j/k into it).
  const chosenSection = chosen ? allRows.find((row) => row.versions.some((draft) => draft.id === chosen.id))?.section : undefined;
  const isOpenSection = useCallback((key: SectionKey) => !(QUIET_SECTIONS as readonly SectionKey[]).includes(key) || unfolded.has(key) || chosenSection === key, [unfolded, chosenSection]);
  const flat = useMemo(() => groups.filter((group) => isOpenSection(group.key)).flatMap((group) => group.rows), [groups, isOpenSection]);
  const selected = chosen ?? (desktop && !selectedId ? flat[0]?.best : undefined);
  const selectedRow = selected ? allRows.find((row) => row.leadId === selected.leadId && row.versions.some((draft) => draft.id === selected.id)) : undefined;
  const versions = selectedRow?.versions ?? (selected ? [selected] : []);

  // ---- Ticking rows: Approve rows this person may approve, Send rows that are emails they may send (when the app sends from the queue).
  const pickOf = useCallback((row: LeadRow): Pickable => {
    if (!batchOn) return null;
    const draft = row.best;
    if (row.section === "approve") {
      const approval = approvalFor(draft);
      if (canApprove(session, draft, approval.reason)) return { ok: true };
      return { ok: false, why: approval.reason === "every_message" ? "Only the lead's owner or a venture head approves this message" : "Only a venture head approves a play's first batch" };
    }
    if (row.section !== "send" || !canQueue) return null;
    if (draft.channel !== "email") return { ok: false, quiet: true, why: `${CHANNEL_LABELS[draft.channel] ?? "This message"} is sent by hand: open it to send` };
    if (!canWorkLead(session, draft.lead)) return { ok: false, why: "Only the lead's owner or a venture head sends this message" };
    if (draft.lead.doNotContact) return { ok: false, why: "On the do-not-contact list: nothing can be sent" };
    if (draft.delivery?.state === "sending" || draft.delivery?.state === "uncertain") return { ok: false, why: "Its last send isn't settled yet: open it" };
    return { ok: true };
  }, [batchOn, canQueue, approvalFor, session]);
  // The ticked rows that are still in their section and may still be ticked (a reload can move them).
  const pickedRows = useMemo(() => picked ? allRows.filter((row) => row.section === picked.section && picked.ids.has(row.best.id) && pickOf(row)?.ok) : [], [picked, allRows, pickOf]);
  const toggle = useCallback((row: LeadRow) => {
    if (row.section !== "approve" && row.section !== "send") return;
    const section = row.section;
    setPicked((current) => {
      const ids = new Set(current?.section === section ? current.ids : []);
      if (ids.has(row.best.id)) ids.delete(row.best.id); else if (ids.size < BATCH_MAX) ids.add(row.best.id);
      return ids.size ? { section, ids } : null;
    });
  }, []);
  function toggleAll(section: BatchSection, rows: LeadRow[]) {
    const ok = rows.filter((row) => pickOf(row)?.ok).map((row) => row.best.id);
    const all = picked?.section === section && ok.every((id) => picked.ids.has(id));
    setPicked(all ? null : { section, ids: new Set(ok.slice(0, BATCH_MAX)) });
  }
  const clearPicked = useCallback(() => setPicked(null), []);
  function batchDone(result: DraftBatchResult, action: "approve" | "approve_and_send" | "send", list: ReviewDraft[]) {
    batchToast(result, action);
    const left = batchLeftovers(result, list, action);
    setNotice(left ? { tone: "info", text: left } : null);
    setPicked(null);
    refresh();
  }
  function batchMissing() {
    setRouteMissing(true); setPicked(null);
    setNotice({ tone: "info", text: "This server can't approve or send several messages at once yet. Open each one to approve and send it." });
  }
  async function takeBack(draft: ReviewDraft) {
    setTakingBack(draft.id);
    try {
      const result = await batchDrafts({ action: "unqueue", drafts: [{ id: draft.id, expectedUpdatedAt: draft.updatedAt }] });
      if (result.unqueued) toast({ title: "Taken back", body: `${draft.lead.companyName}. It stays ready to send.` });
      else setNotice({ tone: "error", text: batchLeftovers(result, [draft], "unqueue") || "It could not be taken back. It may have gone already." });
      refresh();
    } catch (cause) {
      if (isRouteMissing(cause)) batchMissing();
      else setNotice({ tone: "error", text: describeError(cause, "It could not be taken back. Try again.") });
    } finally { setTakingBack(""); }
  }

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
      else if (event.key === "x") {
        // Ticks the row that has focus, else the one that is open.
        const focused = event.target instanceof HTMLElement ? event.target.closest("[data-lead-row]")?.getAttribute("data-lead-row") : null;
        const row = flat.find((item) => item.leadId === (focused ?? selected?.leadId));
        if (row && pickOf(row)?.ok) { event.preventDefault(); toggle(row); }
      }
      else if (event.key === "Escape" && selectedId && !desktop) setSelectedId("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selected, selectedId, desktop, setSelectedId, pickOf, toggle]);

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
  function pickFilter(next: "open" | "sent") { setFilter(next); setPicked(null); if (selectedId) setSelectedId("", { replace: true }); }
  const fold = (key: SectionKey) => setUnfolded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const writer = Boolean(session) && session?.membership.role !== "learner";

  const toolbar = <div className="mb-4 flex flex-wrap items-center gap-2">
    <SlidingTabs fitContent label="Which drafts" className="!p-0.5 bg-neutral-100 shadow-none" active={filter} onChange={(key) => pickFilter(key as "open" | "sent")} tabs={[{ key: "open", label: "To do" }, { key: "sent", label: "Sent" }]} />
    {session && <SlidingTabs fitContent label="Whose drafts" className="!p-0.5 bg-neutral-100 shadow-none" active={scope} onChange={(key) => { setScope(key as "me" | "all"); setPicked(null); }} tabs={[{ key: "me", label: "Mine" }, { key: "all", label: "Everyone" }]} />}
    <span className="ml-auto flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-[11px] text-neutral-400 max-lg:hidden"><kbd className={kbdClass}>j</kbd><kbd className={kbdClass}>k</kbd>move{writer && <><kbd className={kbdClass}>e</kbd>edit</>}{batchOn && writer && <><kbd className={kbdClass}>x</kbd>select</>}</span>
    </span>
  </div>;

  if (drafts.error && !loaded) return <>{toolbar}<Panel><EmptyState variant="error" title="Could not load the drafts" body={drafts.error} action={{ label: drafts.busy ? "Trying again…" : "Try again", onClick: drafts.reload, disabled: drafts.busy }} /></Panel></>;
  if (!loaded) return <>{toolbar}<div role="status" aria-label="Loading drafts" className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]"><Panel className="space-y-3 p-4">{[0, 1, 2, 3, 4].map((index) => <div key={index} className="flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-xl" /><span className="grid min-w-0 flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${74 - (index % 3) * 12}%` }} /><span className="vso-skeleton h-2.5 w-2/3" /></span></div>)}</Panel><Panel className="space-y-4 p-5 max-lg:hidden"><span className="vso-skeleton block h-5 w-1/3" /><span className="vso-skeleton block h-40 rounded-2xl" /><span className="vso-skeleton block h-10 w-1/2" /></Panel></div></>;
  if (allRows.length === 0 && !selected) return <>{toolbar}<Notice tone={notice?.tone ?? "info"} message={notice?.text ?? ""} onDismiss={() => setNotice(null)} className="pb-3" /><Panel>{filter === "open"
    ? <EmptyState variant="card" tone="green" icon={Check} title={mine ? "Nothing of yours to do" : "Nothing to approve or send"} body={mine ? "None of the messages on your leads need you right now." : appWrites ? "The app writes first messages for your recommended leads each working day. They appear here when they pass the check, one row per lead." : "When Claude writes messages for your leads they land here, one row per lead, once they pass the check."} action={mine ? { label: "Show everyone's messages", onClick: () => setScope("all") } : undefined}>
      {writer && !appWrites && <AskClaude prompt="write first messages for my recommended leads" className="mt-1 w-full max-w-lg text-left" />}
    </EmptyState>
    : <EmptyState variant="card" tone="blue" icon={Inbox} title="Nothing sent yet" body="Messages you send, or mark as sent, show up here, so you can see what went out." />}</Panel></>;

  const row = (item: LeadRow, slot: boolean) => {
    const pick = slot ? pickOf(item) : null;
    const checked = Boolean(picked?.section === item.section && picked.ids.has(item.best.id));
    const check = !slot ? undefined : pick?.ok ? <RowCheck checked={checked} label={`Select ${item.best.lead.companyName}`} onChange={() => toggle(item)} /> : <NoCheck why={pick && !pick.ok ? pick.why : ""} quiet={!pick || Boolean(pick.quiet)} />;
    const queue = item.section === "queued" ? item.best.sendQueue : undefined;
    const mayTakeBack = queue && (queue.by === session?.user.id || canHead(session, item.best.ventureId));
    const aside = mayTakeBack ? <button type="button" onClick={() => void takeBack(item.best)} disabled={takingBack === item.best.id} aria-label={`Take back the message to ${item.best.lead.companyName}`} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-neutral-600 transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:opacity-50"><RotateCcw size={13} aria-hidden="true" />{takingBack === item.best.id ? "Taking back…" : "Take back"}</button> : undefined;
    return <ReviewRow key={item.leadId} row={item} active={selectedRow?.leadId === item.leadId} approvalNeeded={approvalFor(item.best).needed} venture={ventureId ? "" : ventureName(item.best.ventureId)} check={check} aside={aside} onOpen={() => setSelectedId(item.best.id, { replace: desktop })} />;
  };
  // Rows this person can't tick get a reason under the heading too, not only on the lock.
  const lockedLine = (rows: LeadRow[]) => {
    const locked = rows.map(pickOf).filter((pick): pick is { ok: false; why: string } => Boolean(pick && !pick.ok && !pick.quiet));
    if (!locked.length) return null;
    const reasons = [...new Set(locked.map((pick) => pick.why))];
    return <p className="flex items-start gap-1.5 border-b border-neutral-50 px-4 py-2 text-[11px] leading-4 text-neutral-500"><Info size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-neutral-400" /><span>{locked.length === rows.length ? "You can read these." : `You can't tick ${locked.length} of these.`} {reasons.length === 1 ? `${reasons[0]}.` : "Open one to see why."}</span></p>;
  };

  return <>
    {!(selected && !desktop) && toolbar}
    {drafts.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{drafts.error}</p>}
    <Notice tone={notice?.tone ?? "info"} message={notice?.text ?? ""} onDismiss={() => setNotice(null)} className={clsx("pb-3", selected && !desktop && "hidden")} />
    <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Panel className={clsx("thin-scroll overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto", selected && !desktop && "hidden")}>
        {groups.map((group) => {
          if (group.key === "sent") return <div key={group.key}><SectionHead title={group.title} count={group.rows.length} /><ul>{group.rows.map((item) => row(item, false))}</ul></div>;
          const quiet = (QUIET_SECTIONS as readonly SectionKey[]).includes(group.key);
          if (quiet && !group.rows.length) return null;
          const open = isOpenSection(group.key);
          const listId = `${foldId}-${group.key}`;
          if (quiet) {
            // What the app (or Claude in another chat) is still checking, and what the app sends: quiet, folded until asked for.
            const appLine = group.key === "checking" && appChecks;
            return <div key={group.key}>
              {appLine
                ? <div className="flex min-h-10 items-center gap-2 border-b border-neutral-100 bg-white px-4 py-2 text-xs text-neutral-500"><Clock3 size={14} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="min-w-0 flex-1">The app is checking {plural(group.rows.length, "message")}. They appear here when they pass.</span><button type="button" aria-expanded={open} aria-controls={listId} onClick={() => fold(group.key)} className="min-h-8 shrink-0 rounded-lg px-2 text-[11px] font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{open ? "Hide" : "Show"}</button></div>
                : <SectionHead quiet title={group.title} count={group.rows.length} fold={{ open, controls: listId, onToggle: () => fold(group.key) }} />}
              {group.key === "checking" && !appChecks && writer && <div className="border-b border-neutral-50 px-4 py-2.5"><AskClaude prompt="review drafts" note="in a new chat" /></div>}
              {open && <ul id={listId}>{group.rows.map((item) => row(item, false))}</ul>}
            </div>;
          }
          if (group.key === "stuck") {
            // Drafts the app stopped checking after its tries: back to a person, with the chat prompt, even while the app checks the rest.
            if (!group.rows.length) return null;
            return <div key={group.key}>
              <SectionHead title={group.title} count={group.rows.length} />
              <div className="space-y-2 border-b border-neutral-50 px-4 py-2.5">
                <p className="flex items-start gap-1.5 text-xs leading-5 text-neutral-600"><Info size={13} aria-hidden="true" className="mt-1 shrink-0 text-warning-text" /><span>{STUCK_LINE}</span></p>
                {writer && <AskClaude prompt="review drafts" note="in a new chat" />}
              </div>
              <ul>{group.rows.map((item) => row(item, false))}</ul>
            </div>;
          }
          const section = group.key as BatchSection | "fix";
          const slot = section !== "fix" && group.rows.some((item) => pickOf(item) !== null);
          const okRows = group.rows.filter((item) => pickOf(item)?.ok);
          const allPicked = okRows.length > 0 && picked?.section === section && okRows.every((item) => picked.ids.has(item.best.id));
          return <div key={group.key}>
            <SectionHead title={group.title} count={group.rows.length} select={section !== "fix" && okRows.length > 1 ? { all: allPicked, label: `${allPicked ? "Select none" : "Select all"} in ${group.title}`, onToggle: () => toggleAll(section, group.rows) } : undefined} />
            {group.rows.length === 0 ? <p className="border-b border-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-400">{SECTION_EMPTY[group.key as "approve" | "send" | "fix"]}</p> : <>
              {slot && lockedLine(group.rows)}
              <ul>{group.rows.map((item) => row(item, slot))}</ul>
            </>}
          </div>;
        })}
        {pickedRows.length > 0 && picked && <>
          <ReviewBatchBar section={picked.section} drafts={pickedRows.map((item) => item.best)} canQueue={canQueue} onClear={clearPicked} onDone={batchDone} onRouteMissing={batchMissing} />
          <div aria-hidden="true" className="h-40 sm:h-28 lg:hidden" />
        </>}
      </Panel>
      <div ref={reader} className={clsx("min-w-0 scroll-mt-4", !selected && !desktop && "hidden")}><Panel>
        {selected && selected === linked && ventureId && selected.ventureId !== ventureId && <p className="flex items-center gap-2 rounded-t-2xl border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold text-neutral-600 sm:px-5"><Info size={14} className="shrink-0 text-neutral-400" aria-hidden="true" />From {ventureName(selected.ventureId)}</p>}
        {selected ? <DraftVersions key={selected.leadId} versions={versions} selected={selected} onSelect={(id) => setSelectedId(id, { replace: true })} approvalFor={approvalFor} playFor={playFor} settingsFor={settingsFor} allowMissing={filter === "open" && selected !== linked} editNonce={editNonce} onBack={() => setSelectedId("")} onChanged={changed} />
          : <EmptyState variant="select" icon={Sparkles} title="Pick a lead to read" body="Its versions, the check and what to do next show up here." />}
      </Panel></div>
    </div>
  </>;
}
