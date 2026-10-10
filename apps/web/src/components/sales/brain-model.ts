import { BRAIN_KINDS, type BrainItem } from "@venture-studio/contracts";
import type { BrainKind } from "./brain-form";

// Pure helpers for the Sales knowledge page: which items exist per kind, which proposal replaces which approved item.

export const KINDS: readonly BrainKind[] = BRAIN_KINDS;
/** The two kinds Claude leans on hardest: it judges every lead against the target profile and checks every draft against the message rules. */
export const CRITICAL_KINDS: readonly BrainKind[] = ["target_profile", "message_rules"];

export type KnowledgeFilter = "all" | "approved" | "proposals";

export const isApproved = (item: BrainItem) => item.status === "approved";
export const isProposal = (item: BrainItem) => item.status === "draft";
export const sameTitle = (a: BrainItem, b: BrainItem) => a.kind === b.kind && a.title.trim().toLowerCase() === b.title.trim().toLowerCase();

/** Items still in play (archived ones are history). */
export const liveItems = (items: readonly BrainItem[]) => items.filter((item) => item.status !== "archived");

/** One kind, approved first (by title), then proposals (newest change first). */
export function itemsOfKind(items: readonly BrainItem[], kind: BrainKind, filter: KnowledgeFilter = "all"): BrainItem[] {
  const ofKind = liveItems(items).filter((item) => item.kind === kind);
  const approved = filter === "proposals" ? [] : ofKind.filter(isApproved).sort((a, b) => a.title.localeCompare(b.title));
  const proposals = filter === "approved" ? [] : ofKind.filter(isProposal).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...approved, ...proposals];
}

export function countsOfKind(items: readonly BrainItem[], kind: BrainKind) {
  const ofKind = liveItems(items).filter((item) => item.kind === kind);
  return { approved: ofKind.filter(isApproved).length, proposals: ofKind.filter(isProposal).length };
}

/** The approved item a proposal would replace (same kind and title). */
export const approvedTwin = (item: BrainItem, items: readonly BrainItem[]) => isProposal(item) ? liveItems(items).find((other) => isApproved(other) && sameTitle(other, item)) : undefined;
/** Proposals waiting to replace an approved item. */
export const proposalsFor = (item: BrainItem, items: readonly BrainItem[]) => isApproved(item) ? liveItems(items).filter((other) => isProposal(other) && sameTitle(other, item)) : [];

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** "approved", "3 approved, 2 proposals", "none approved (4 proposals)", "none". */
export function statusText({ approved, proposals }: { approved: number; proposals: number }) {
  if (approved > 0) return proposals > 0 ? `${approved} approved, ${plural(proposals, "proposal")}` : approved === 1 ? "approved" : `${approved} approved`;
  return proposals > 0 ? `none approved (${plural(proposals, "proposal")})` : "none";
}

/** Where to start: the approved offer, else the first approved item, else the first item. */
export function defaultItem(items: readonly BrainItem[]): BrainItem | undefined {
  const live = liveItems(items);
  return itemsOfKind(live, "offer", "approved")[0] ?? live.filter(isApproved)[0] ?? KINDS.map((kind) => itemsOfKind(live, kind)[0]).find(Boolean);
}
