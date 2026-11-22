"use client";
import clsx from "clsx";
import { autopilotStopped } from "@venture-studio/contracts";
import { ChevronDown, LockKeyhole, Mail } from "@/components/ui/icons";
import type { ReviewDraft } from "@/lib/sales-api";
import { CHANNEL_ICON, ChannelTile } from "./draft-shared";
import { sortVersions, TONE_DOT, TONE_TEXT, versionRank } from "./draft-plan";
import { ago, CHANNEL_LABELS, draftState, goesAt, PURPOSE_LABELS, type Tone } from "./sales-ui";

// The Review list, grouped by what the person does (docs/sales-autopilot.md section 7): Approve, Send, Fix, then quietly what is still
// being checked and what the app sends today.

export type SectionKey = "approve" | "send" | "fix" | "stuck" | "checking" | "queued" | "sent";
/** One lead in the list: its versions (an email and a WhatsApp version of the same message), and the one to act on first. */
export type LeadRow = { leadId: string; versions: ReviewDraft[]; best: ReviewDraft; section: SectionKey };
/** The sections a person acts on, then the quiet ones (collapsed by default). */
export const ACTION_SECTIONS = ["approve", "send", "fix", "stuck"] as const satisfies readonly SectionKey[];
export const QUIET_SECTIONS = ["checking", "queued"] as const satisfies readonly SectionKey[];
export const SECTION_TITLE: Record<SectionKey, string> = { approve: "Approve", send: "Send", fix: "Fix", stuck: "Check these", checking: "Being checked", queued: "Sending today", sent: "Sent" };
/** The drafts the app stopped checking after its tries: a person asks Claude in a new chat, or reads and edits them. */
export const STUCK_LINE = "The app tried 3 times and couldn't check these. Ask Claude to check them, or read and edit them yourself.";
/** What an empty section says happens next. */
export const SECTION_EMPTY: Record<"approve" | "send" | "fix", string> = {
  approve: "Nothing to approve. New messages appear here when they pass the check.",
  send: "Nothing to send. Messages that passed the check, or that you approved, wait here.",
  fix: "Nothing to fix. Messages the check sends back appear here.",
};

const preview = (draft: ReviewDraft) => (draft.subject || draft.body).replace(/\s+/g, " ").trim();

/**
 * Puts one lead's open drafts in a section. A lead with a version in the send queue sits in "Sending today" (that version first); else the
 * version to act on first decides: ready (to approve, or to send), needs changes or not submitted (fix), being checked.
 */
export function rowOf(leadId: string, list: ReviewDraft[], needsApproval: (draft: ReviewDraft) => boolean): LeadRow {
  const versions = sortVersions(list);
  const queued = versions.filter((draft) => draft.status === "ready" && draft.sendQueue).sort((a, b) => a.sendQueue!.notBefore.localeCompare(b.sendQueue!.notBefore))[0];
  if (queued) return { leadId, versions, best: queued, section: "queued" };
  const best = [...versions].sort((a, b) => versionRank(a, needsApproval(a)) - versionRank(b, needsApproval(b)) || a.createdAt.localeCompare(b.createdAt))[0]!;
  const section: SectionKey = best.status === "ready" ? (needsApproval(best) ? "approve" : "send") : best.status === "in_review" ? (autopilotStopped(best) ? "stuck" : "checking") : "fix";
  return { leadId, versions, best, section };
}

/** The title of the queued section: "Sending today", or "Sending soon" when some go on a later day. */
export function queuedTitle(rows: readonly LeadRow[], now = new Date()) {
  const later = rows.some((row) => row.best.sendQueue && !goesAt(row.best.sendQueue.notBefore, now).startsWith("at "));
  return later ? "Sending soon" : SECTION_TITLE.queued;
}

/** A section's sticky heading: the title, how many, and "Select all" when its rows can be ticked. Quiet sections fold. */
export function SectionHead({ title, count, select, fold, quiet = false }: {
  title: string; count: number; quiet?: boolean;
  select?: { all: boolean; label: string; onToggle: () => void } | undefined;
  fold?: { open: boolean; controls: string; onToggle: () => void } | undefined;
}) {
  const head = clsx("text-[11px] font-bold uppercase tracking-[.06em]", quiet ? "text-neutral-400" : "text-neutral-500");
  const badge = <span className="tnum rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{count}</span>;
  return <h2 className="sticky top-0 z-10 flex min-h-10 items-center justify-between gap-2 border-b border-neutral-100 bg-white px-4 py-1.5">
    {fold
      ? <button type="button" aria-expanded={fold.open} aria-controls={fold.controls} onClick={fold.onToggle} className={clsx(head, "-mx-1 flex min-h-8 flex-1 items-center gap-1.5 rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600")}><ChevronDown size={14} aria-hidden="true" className={clsx("shrink-0 transition-transform duration-150", !fold.open && "-rotate-90")} />{title}</button>
      : <span className={head}>{title}</span>}
    <span className="flex items-center gap-1.5">
      {select && <button type="button" onClick={select.onToggle} aria-label={select.label} className="min-h-8 rounded-lg px-2 text-[11px] font-semibold normal-case tracking-normal text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{select.all ? "Select none" : "Select all"}</button>}
      {badge}
    </span>
  </h2>;
}

/**
 * Where a row's checkbox would be, when it can't be ticked: a lock that says why (also read out), or, for a message sent by hand
 * (`quiet`), an empty space that says so on hover and to a screen reader.
 */
export function NoCheck({ why, quiet = false }: { why: string; quiet?: boolean }) {
  if (!why) return <span aria-hidden="true" className="h-10 w-10 shrink-0" />;
  return <span role="img" aria-label={why} title={why} className="grid h-10 w-10 shrink-0 place-items-center text-neutral-300">{!quiet && <LockKeyhole size={14} aria-hidden="true" />}</span>;
}

/**
 * A lead in the list: the company, the message to act on first, an icon for each version and that version's state. `check` is the
 * checkbox slot (Approve and Send rows); `aside` sits at the right edge (Take back, on a queued row).
 */
export function ReviewRow({ row, active, approvalNeeded, venture, check, aside, onOpen }: {
  row: LeadRow; active: boolean; approvalNeeded: boolean; venture: string; check?: React.ReactNode; aside?: React.ReactNode; onOpen: () => void;
}) {
  const { best, versions } = row;
  const queue = best.status === "ready" && best.sendQueue && !best.delivery?.state ? best.sendQueue : undefined;
  const state = draftState(best, approvalNeeded);
  const status: { label: string; tone: Tone } = queue ? { label: `Goes ${goesAt(queue.notBefore)}`, tone: state.tone } : state;
  const channels = versions.map((draft) => CHANNEL_LABELS[draft.channel] ?? draft.channel).join(", ");
  return <li className={clsx("flex items-center border-b border-neutral-50 transition-colors duration-150", active ? "bg-primary-50" : "hover:bg-neutral-50", check !== undefined && "pl-1.5")}>
    {check}
    <button type="button" data-lead-row={row.leadId} aria-current={active ? "true" : undefined} onClick={onOpen} className={clsx("flex min-h-[76px] min-w-0 flex-1 items-center gap-3 py-3 pr-4 text-left transition-transform duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:scale-[0.995]", check !== undefined ? "pl-1" : "pl-4")}>
      <ChannelTile channel={best.channel} size={36} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[13px] font-bold text-neutral-900">{best.lead.companyName}</span><time dateTime={best.sentAt ?? best.createdAt} className="tnum shrink-0 text-[11px] text-neutral-400">{ago(best.sentAt ?? best.createdAt)}</time></span>
        <span className="mt-0.5 block truncate text-xs text-neutral-500">{PURPOSE_LABELS[best.purpose]} · {preview(best)}</span>
        <span className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] font-semibold">
          <span role="img" aria-label={`${versions.length === 1 ? "One version" : `${versions.length} versions`}: ${channels}`} className="flex shrink-0 items-center gap-1">{versions.map((draft) => { const VersionIcon = CHANNEL_ICON[draft.channel] ?? Mail; return <span key={draft.id} aria-hidden="true" className={clsx("grid h-5 w-5 place-items-center rounded-md", draft.id === best.id ? "bg-neutral-200/70 text-neutral-700" : "bg-neutral-100 text-neutral-400")}><VersionIcon size={12} /></span>; })}</span>
          <span className={clsx("inline-flex min-w-0 shrink-0 items-center gap-1", TONE_TEXT[status.tone])}><span aria-hidden="true" className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[status.tone])} />{status.label}</span>
          {venture && <span className="truncate text-neutral-400">{venture}</span>}
        </span>
      </span>
    </button>
    {aside && <span className="shrink-0 pr-3">{aside}</span>}
  </li>;
}
