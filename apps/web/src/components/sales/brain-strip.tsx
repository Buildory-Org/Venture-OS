"use client";
import { useState } from "react";
import clsx from "clsx";
import type { BrainItem } from "@venture-studio/contracts";
import { ChevronDown, CircleAlert, Plus, Sparkles } from "@/components/ui/icons";
import { Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { KIND_LABEL, type BrainKind } from "./brain-form";
import { countsOfKind, CRITICAL_KINDS, KINDS, statusText } from "./brain-model";

/** What Claude actually uses, kind by kind, and a quiet hint when the target profile or message rules are not approved yet. */
export function BrainStrip({ items, ventureName, canWrite, onPick, onReview, onPropose }: {
  items: readonly BrainItem[]; ventureName: string; canWrite: boolean; onPick: (kind: BrainKind) => void; onReview: (kind: BrainKind) => void; onPropose: (kind?: BrainKind) => void;
}) {
  // On a phone the five status lines fold away behind one button so the list stays near the top.
  const [expanded, setExpanded] = useState(false);
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, countsOfKind(items, kind)])) as Record<BrainKind, ReturnType<typeof countsOfKind>>;
  const missing = CRITICAL_KINDS.filter((kind) => counts[kind].approved === 0);
  const withProposals = missing.filter((kind) => counts[kind].proposals > 0);
  const missingNames = missing.map((kind) => KIND_LABEL[kind].toLowerCase());
  return <Panel className="mb-4 p-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-sm font-bold text-neutral-900"><Sparkles size={15} className="text-primary-700" aria-hidden="true" />What Claude uses for {ventureName}</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-neutral-500 max-sm:hidden">Only approved items count. Claude proposes changes when you talk the business through with it, and a venture head approves them here.</p>
      </div>
      {canWrite && <button type="button" onClick={() => onPropose()} className={clsx(primaryClass, "max-sm:w-full")}><Plus size={15} />Propose a change</button>}
    </div>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-1 text-xs font-semibold text-neutral-600 transition-colors duration-150 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 sm:hidden">{expanded ? "Hide status by kind" : "Show status by kind"}<ChevronDown size={14} aria-hidden="true" className={clsx("transition-transform duration-150", expanded && "rotate-180")} /></button>
    <ul className={clsx("mt-3 flex flex-wrap gap-2 max-sm:mt-0 max-sm:flex-col max-sm:gap-1.5", !expanded && "max-sm:hidden")}>{KINDS.map((kind) => {
      const count = counts[kind];
      const tone = count.approved > 0 ? "bg-success-surface text-success-text" : count.proposals > 0 ? "bg-warning-surface text-warning-text" : "bg-neutral-100 text-neutral-600";
      return <li key={kind} className="max-sm:w-full"><button type="button" onClick={() => onPick(kind)} className={clsx("inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1 text-left text-xs max-sm:min-h-9 max-sm:w-full transition-[filter,transform] duration-150 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]", tone)}><span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /><b className="font-bold">{KIND_LABEL[kind]}:</b> {statusText(count)}</button></li>;
    })}</ul>
    {missing.length > 0 && <div role="note" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs leading-5 text-warning-text">
      <CircleAlert size={15} className="shrink-0 max-sm:mt-0.5 max-sm:self-start" aria-hidden="true" />
      <p className="min-w-0 flex-[1_1_14rem] max-sm:basis-[calc(100%-2rem)]">No approved {missingNames.join(" or ")} yet. Claude {missing.length === 2 ? "judges leads and checks drafts" : missing[0] === "target_profile" ? "judges leads" : "checks drafts"} without {missing.length === 2 ? "them" : "it"} until one is approved.</p>
      {withProposals.length > 0
        ? <button type="button" onClick={() => onReview(withProposals[0]!)} className={clsx(secondaryClass, "!min-h-8 !rounded-lg !px-3 !text-xs")}>Review proposals</button>
        : canWrite && <button type="button" onClick={() => onPropose(missing[0])} className={clsx(secondaryClass, "!min-h-8 !rounded-lg !px-3 !text-xs")}>Propose one</button>}
    </div>}
  </Panel>;
}
