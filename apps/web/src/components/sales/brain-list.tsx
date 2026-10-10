"use client";
import clsx from "clsx";
import type { BrainItem } from "@venture-studio/contracts";
import { ChevronDown, Plus } from "@/components/ui/icons";
import { Badge } from "@/components/studio/primitives";
import { KIND_HINT, KIND_LABEL, type BrainKind } from "./brain-form";
import { approvedTwin, isApproved, type KnowledgeFilter } from "./brain-model";
import { useSalesShell } from "./sales-context";

export type KnowledgeGroup = { kind: BrainKind; rows: BrainItem[]; counts: { approved: number; proposals: number }; open: boolean };

const shortDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

/** The left pane: five groups in a fixed order, approved items first, then proposals. Long groups (notes) start folded. */
export function BrainList({ groups, allItems, filter, selectedId, canWrite, onSelect, onToggle, onPropose }: {
  groups: KnowledgeGroup[]; allItems: readonly BrainItem[]; filter: KnowledgeFilter; selectedId: string; canWrite: boolean;
  onSelect: (item: BrainItem) => void; onToggle: (kind: BrainKind) => void; onPropose: (kind: BrainKind) => void;
}) {
  const { personName } = useSalesShell();
  return <div>{groups.map((group) => {
    const total = group.counts.approved + group.counts.proposals;
    return <section key={group.kind} aria-label={KIND_LABEL[group.kind]}>
      <h2 className="sticky top-0 z-10 border-b border-neutral-100 bg-white">
        <button type="button" aria-expanded={group.open} onClick={() => onToggle(group.kind)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600">
          <ChevronDown size={14} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", !group.open && "-rotate-90")} />
          <span className="min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-[.06em] text-neutral-600">{KIND_LABEL[group.kind]}</span>
          <span className="shrink-0 text-[11px] font-medium text-neutral-400">{total === 0 ? "none" : [group.counts.approved ? `${group.counts.approved} approved` : "", group.counts.proposals ? `${group.counts.proposals} proposed` : ""].filter(Boolean).join(" · ")}</span>
        </button>
      </h2>
      {group.open && (group.rows.length === 0
        ? <div className="space-y-2 border-b border-neutral-100 px-4 py-3.5">
          <p className="text-xs leading-5 text-neutral-500">{total > 0 ? (filter === "approved" ? "Nothing approved yet. Switch to All to see the proposals." : "No proposals waiting.") : KIND_HINT[group.kind]}</p>
          {total === 0 && canWrite && <button type="button" onClick={() => onPropose(group.kind)} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Plus size={13} aria-hidden="true" />Propose one</button>}
        </div>
        : <ul>{group.rows.map((item) => {
          const active = item.id === selectedId;
          const twin = approvedTwin(item, allItems);
          const by = item.via === "claude" ? "Claude" : personName(item.proposedBy);
          return <li key={item.id}><button type="button" data-brain-id={item.id} aria-current={active ? "true" : undefined} onClick={() => onSelect(item)} className={clsx("block min-h-[60px] w-full border-b border-neutral-50 px-4 py-2.5 text-left transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:scale-[0.995]", active ? "bg-primary-50" : "hover:bg-neutral-50")}>
            <span className="flex items-start justify-between gap-2"><span className="min-w-0 text-[13px] font-bold leading-5 text-neutral-900 line-clamp-2 [overflow-wrap:anywhere]">{item.title}</span><span className="shrink-0 pt-0.5"><Badge tone={isApproved(item) ? "green" : "amber"}>{isApproved(item) ? "Approved" : "Proposed"}</Badge></span></span>
            <span className="mt-0.5 block truncate text-[11px] text-neutral-500">v{item.version}{twin ? ` · replaces v${twin.version}` : ""} · {shortDate.format(new Date(item.updatedAt))} · {by}</span>
          </button></li>;
        })}</ul>)}
    </section>;
  })}</div>;
}
