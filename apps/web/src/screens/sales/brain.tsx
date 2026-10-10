"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { BrainItem } from "@venture-studio/contracts";
import { BookOpenText, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, secondaryClass } from "@/components/studio/primitives";
import { useStudio } from "@/lib/studio-store";
import { listBrain } from "@/lib/sales-api";
import { BrainForm, KIND_HINT, type BrainFormTarget, type BrainKind } from "@/components/sales/brain-form";
import { BrainList, type KnowledgeGroup } from "@/components/sales/brain-list";
import { approvedTwin, countsOfKind, defaultItem, isApproved, isProposal, itemsOfKind, KINDS, liveItems, proposalsFor, sameTitle, type KnowledgeFilter } from "@/components/sales/brain-model";
import { BrainReader } from "@/components/sales/brain-reader";
import { BrainStrip } from "@/components/sales/brain-strip";
import { canHead, isLearner, kbdClass, Segmented, typingTarget, useIsDesktop, useQueryParam, useSalesLoad } from "@/components/sales/draft-shared";
import { useSalesShell } from "@/components/sales/sales-context";

/** Sales knowledge (route /sales/live/brain): what Claude knows about one venture's offer, buyers and rules. Two panes like Review: items on the left, one item on the right. */
export function BrainScreen() {
  const { session, ventureId, ventureName } = useSalesShell();
  const { setActiveVentureId } = useStudio();
  const desktop = useIsDesktop();
  const [selectedId, setSelectedId] = useQueryParam("item");
  const [filter, setFilter] = useState<KnowledgeFilter>("all");
  const [open, setOpen] = useState<Partial<Record<BrainKind, boolean>>>({});
  const [form, setForm] = useState<BrainFormTarget | null>(null);
  const brain = useSalesLoad(`brain|${ventureId}`, () => ventureId ? listBrain({ ventureId }) : Promise.resolve([] as BrainItem[]));
  const loaded = brain.data !== null;
  const canApprove = canHead(session, ventureId);
  const canWrite = !isLearner(session) && !!ventureId;
  const items = useMemo(() => liveItems(brain.data ?? []), [brain.data]);

  const groups: KnowledgeGroup[] = useMemo(() => KINDS.map((kind) => {
    const rows = itemsOfKind(items, kind, filter);
    return { kind, rows, counts: countsOfKind(items, kind), open: open[kind] ?? !(kind === "notes" && rows.length > 4) };
  }), [items, filter, open]);
  const visibleRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const flat = useMemo(() => groups.filter((group) => group.open).flatMap((group) => group.rows), [groups]);
  const selected = visibleRows.find((item) => item.id === selectedId) ?? (desktop && !selectedId ? defaultItem(visibleRows) : undefined);

  const removed = useRef("");
  // A link to an item that is gone (discarded, or replaced by a newer approval) lets go.
  useEffect(() => {
    if (!loaded || !selectedId || selectedId === removed.current || visibleRows.some((item) => item.id === selectedId)) return;
    queueMicrotask(() => setSelectedId("", { replace: true }));
  }, [loaded, selectedId, visibleRows, setSelectedId]);
  // On a laptop the approved offer (or the first item) is open by default; remember it in the link so a new proposal arriving does not switch the one you are reading.
  useEffect(() => {
    const first = defaultItem(visibleRows);
    if (desktop && !selectedId && first) queueMicrotask(() => setSelectedId(first.id, { replace: true }));
  }, [desktop, selectedId, visibleRows, setSelectedId]);
  // Whatever gets selected (a link, j/k, the status strip), its group is open and its row is on screen.
  const latestGroups = useRef(groups);
  useEffect(() => { latestGroups.current = groups; });
  const selectedKind = selected?.kind;
  useEffect(() => {
    if (selectedKind && latestGroups.current.find((group) => group.kind === selectedKind)?.open === false) queueMicrotask(() => setOpen((current) => ({ ...current, [selectedKind]: true })));
  }, [selectedKind, selectedId]);
  useEffect(() => {
    if (selected) document.querySelector(`[data-brain-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return;
      const index = flat.findIndex((item) => item.id === selected?.id);
      if (event.key === "j" || event.key === "k") {
        const next = flat[Math.min(flat.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
        if (next) { event.preventDefault(); setSelectedId(next.id, { replace: true }); }
      } else if (event.key === "Escape" && selectedId && !desktop) setSelectedId("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selected, selectedId, desktop, setSelectedId]);

  // On a phone the list and the reader take turns: open the reader at its top.
  const reader = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!desktop && selectedId) reader.current?.scrollIntoView({ block: "start" }); }, [desktop, selectedId]);

  function select(item: BrainItem) {
    if (filter !== "all" && !visibleRows.some((row) => row.id === item.id)) setFilter("all");
    setSelectedId(item.id, { replace: desktop });
  }
  function pickFilter(next: KnowledgeFilter) {
    setFilter(next);
    const stillThere = selected && itemsOfKind(items, selected.kind, next).some((item) => item.id === selected.id);
    if (selectedId && !stillThere) setSelectedId("", { replace: true });
  }
  function pickKind(kind: BrainKind) {
    setFilter("all"); setOpen((current) => ({ ...current, [kind]: true }));
    const first = itemsOfKind(items, kind)[0];
    if (first) setSelectedId(first.id, { replace: desktop });
  }
  function reviewProposals(kind: BrainKind) {
    setFilter("proposals"); setOpen((current) => ({ ...current, [kind]: true }));
    const first = itemsOfKind(items, kind, "proposals")[0];
    if (first) setSelectedId(first.id, { replace: desktop });
  }

  function saved(item: BrainItem) {
    brain.mutate((list) => list.some((entry) => entry.id === item.id) ? list.map((entry) => entry.id === item.id ? item : entry) : [item, ...list]);
    setFilter("all"); setOpen((current) => ({ ...current, [item.kind]: true }));
    setSelectedId(item.id, { replace: true });
  }
  // Approving archives the version that was approved before under the same title.
  function approved(item: BrainItem) { brain.mutate((list) => list.map((entry) => entry.id === item.id ? item : sameTitle(entry, item) && isApproved(entry) ? { ...entry, status: "archived" as const } : entry)); }
  function archived(item: BrainItem) {
    const index = flat.findIndex((row) => row.id === item.id);
    const next = flat[index + 1] ?? flat[index - 1];
    removed.current = item.id;
    brain.mutate((list) => list.map((entry) => entry.id === item.id ? item : entry));
    setSelectedId(next && desktop ? next.id : "", { replace: true });
  }

  if (!ventureId) {
    const ventures = session?.hierarchy.ventures.filter((venture) => session.membership.role === "admin" || session.membership.ventureIds.includes(venture.id)) ?? [];
    return <Panel><EmptyState variant="card" tone="blue" icon={BookOpenText} title="Pick a venture to see its sales knowledge" body="Each venture has its own offer, buyers and message rules. Choose one in the sidebar, or open one here.">
      {ventures.map((venture) => <button key={venture.id} type="button" onClick={() => setActiveVentureId(venture.id)} className={secondaryClass}>{venture.name}</button>)}
    </EmptyState></Panel>;
  }
  if (brain.error && !loaded) return <Panel><EmptyState variant="error" title="Could not load the sales knowledge" body={brain.error} action={{ label: brain.busy ? "Trying again…" : "Try again", onClick: brain.reload, disabled: brain.busy }} /></Panel>;
  if (!loaded) return <div role="status" aria-label="Loading the sales knowledge" className="space-y-4"><Panel className="space-y-3 p-4"><span className="vso-skeleton block h-4 w-1/3" /><span className="vso-skeleton block h-3 w-2/3" /><span className="vso-skeleton block h-8 w-full" /></Panel><div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]"><Panel className="space-y-3 p-4">{[0, 1, 2, 3, 4].map((index) => <span key={index} className="vso-skeleton block h-10 rounded-lg" />)}</Panel><Panel className="space-y-4 p-6 max-lg:hidden"><span className="vso-skeleton block h-6 w-1/2" /><span className="vso-skeleton block h-40 rounded-2xl" /></Panel></div></div>;

  const readerOnly = !!selected && !desktop;
  const proposalCount = items.filter(isProposal).length;
  const approvedCount = items.filter(isApproved).length;
  const filterBar = <div className="mb-4 flex flex-wrap items-center gap-2">
    <Segmented label="Which items" value={filter} onChange={pickFilter} options={[{ value: "all", label: `All · ${items.length}` }, { value: "approved", label: `Approved · ${approvedCount}` }, { value: "proposals", label: `Proposals · ${proposalCount}` }]} />
    <span className="ml-auto flex items-center gap-1.5 text-[11px] text-neutral-400 max-lg:hidden"><kbd className={kbdClass}>j</kbd><kbd className={kbdClass}>k</kbd>move</span>
  </div>;

  return <>
    {!readerOnly && <BrainStrip items={items} ventureName={ventureName(ventureId)} canWrite={canWrite} onPick={pickKind} onReview={reviewProposals} onPropose={(kind) => setForm({ mode: "propose", ...(kind ? { kind } : {}) })} />}
    {!readerOnly && filterBar}
    {brain.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{brain.error}</p>}
    <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className={clsx("thin-scroll overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto", readerOnly && "hidden")}>
        <BrainList groups={groups} allItems={items} filter={filter} selectedId={selected?.id ?? ""} canWrite={canWrite} onSelect={select} onToggle={(kind) => setOpen((current) => ({ ...current, [kind]: !(groups.find((group) => group.kind === kind)?.open) }))} onPropose={(kind) => setForm({ mode: "propose", kind })} />
      </Panel>
      <div ref={reader} className={clsx("min-w-0 scroll-mt-4", !selected && !desktop && "hidden")}><Panel className="overflow-hidden">
        {selected
          ? <BrainReader key={selected.id} item={selected} twin={approvedTwin(selected, items)} proposals={proposalsFor(selected, items)} canApprove={canApprove} canWrite={canWrite} onBack={() => setSelectedId("")} onSelect={select} onEdit={(item) => setForm({ mode: "edit", item })} onPropose={setForm} onApproved={approved} onArchived={archived} />
          : <EmptyState variant="select" icon={Sparkles} title={items.length ? "Pick an item to read" : "Nothing here yet"} body={items.length ? "Its text, who proposed or approved it, and what you can do next show up here." : `${KIND_HINT.offer} Ask Claude to propose it, or write it yourself with Propose a change.`} />}
      </Panel></div>
    </div>
    {form && <BrainForm ventureId={ventureId} target={form} onClose={() => setForm(null)} onSaved={saved} />}
  </>;
}

