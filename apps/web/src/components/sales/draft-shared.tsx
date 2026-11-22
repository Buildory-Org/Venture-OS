"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import type { Play } from "@venture-studio/contracts";
import { Mail, MessageSquareText, type Icon } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { getCachedSalesSettings, type ReviewDraft, type SalesSettingsView } from "@/lib/sales-api";
import { SkeletonRows } from "@/components/studio/primitives";
import { Instagram, Linkedin, Phone, Whatsapp } from "./draft-icons";
import { useSalesShell, type SalesSession } from "./sales-context";
import { CALL_OUTCOME_LABELS, canHead, canWorkLead, REPLY_TYPE_LABELS } from "./sales-ui";

// Small helpers shared by the Review, Inbox, Plays, Find leads, Calls and Brain screens. Words, dates, links and permissions live in
// sales-ui.tsx; they are re-exported here under the names these screens have always used.

// ---- Loading ---------------------------------------------------------------------------------------------

/**
 * Loads data for a screen. It reloads when `key` changes (a different venture or filter), when the Sales shell
 * bumps `refreshKey` after a change, and when `reload()` is called. Old data stays on screen while it reloads.
 */
export function useSalesLoad<T>(key: string, load: () => Promise<T>) {
  const { refreshKey } = useSalesShell();
  const [result, setResult] = useState<{ key: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  useEffect(() => { loader.current = load; });
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setBusy(true); });
    loader.current().then((data) => {
      if (!active) return;
      setResult({ key, data }); setFailure(null); setBusy(false);
    }).catch((cause: unknown) => {
      if (!active) return;
      setFailure({ key, message: describeError(cause, "Check your connection and try again.") }); setBusy(false);
    });
    return () => { active = false; };
  }, [key, refreshKey, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  /** Change the loaded data in place (for instant feedback before the reload lands). */
  const mutate = useCallback((change: (data: T) => T) => setResult((current) => current ? { ...current, data: change(current.data) } : current), []);
  const data = result?.key === key ? result.data : null;
  const error = failure?.key === key ? failure.message : "";
  return { data, error, busy, reload, mutate };
}

/** True from the `lg` breakpoint up (split views); false on phones and small tablets. */
export function useIsDesktop(query = "(min-width: 1024px)") {
  return useSyncExternalStore(
    (notify) => { const list = window.matchMedia(query); list.addEventListener("change", notify); return () => list.removeEventListener("change", notify); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** One URL search param as state. Needs a Suspense boundary above (each page file provides one). */
export function useQueryParam(name: string): [string, (value: string, options?: { replace?: boolean }) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(name) ?? "";
  const set = useCallback((next: string, options: { replace?: boolean } = {}) => {
    const query = new URLSearchParams(params.toString());
    if (next) query.set(name, next); else query.delete(name);
    const url = query.size ? `${pathname}?${query}` : pathname;
    if (options.replace) router.replace(url, { scroll: false }); else router.push(url, { scroll: false });
  }, [params, router, pathname, name]);
  return [value, set];
}

/**
 * The sales settings of these ventures, by venture id (read through the five-minute cache in lib/sales-api). A venture whose settings
 * are not read yet, or could not be read, is missing: callers use the defaults for it.
 */
export function useVentureSettings(ventureIds: readonly string[]): Record<string, SalesSettingsView> {
  const key = [...new Set(ventureIds.filter(Boolean))].sort().join(",");
  const [state, setState] = useState<{ key: string; byId: Record<string, SalesSettingsView> }>({ key: "", byId: {} });
  useEffect(() => {
    let active = true;
    const ids = key ? key.split(",") : [];
    void Promise.all(ids.map((ventureId) => getCachedSalesSettings(ventureId))).then((rows) => {
      if (!active) return;
      setState({ key, byId: Object.fromEntries(rows.filter((row): row is SalesSettingsView => row !== null).map((row) => [row.ventureId, row])) });
    });
    return () => { active = false; };
  }, [key]);
  return state.key === key ? state.byId : EMPTY_SETTINGS;
}
const EMPTY_SETTINGS: Record<string, SalesSettingsView> = {};

// ---- Approval before sending ---------------------------------------------------------------------------------

export type ApprovalReason = "first_batch" | "every_message";
/**
 * Whether a person still has to approve this draft before it can be marked sent, and why. The API's `needsPersonApproval` and
 * `approvalReason` decide when it sends them; otherwise the same rule is worked out here from the venture's approval mode and the play
 * (every message where a person approves every message, except call openers; else a play's first batch that no person has read yet).
 */
export function approvalOf(draft: ReviewDraft, play: Play | undefined, settings: SalesSettingsView | undefined): { needed: boolean; reason: ApprovalReason | null } {
  const none = { needed: false, reason: null };
  if (draft.status !== "ready") return none;
  if (draft.needsPersonApproval !== undefined) {
    if (!draft.needsPersonApproval) return none;
    return { needed: true, reason: draft.approvalReason ?? (settings?.approvalMode === "person_approves_every_message" ? "every_message" : "first_batch") };
  }
  // Any approval lets a message go where every message is approved; a play's first batch needs a head's (or admin's) approval. A person's
  // own reply is approved by its author in either mode.
  if (settings?.approvalMode === "person_approves_every_message") return draft.channel === "call_opener" || draft.personApproval ? none : { needed: true, reason: "every_message" };
  const headApproved = Boolean(draft.personApproval) && (draft.personApproval?.byHead !== false || draft.personApproval?.own === true);
  return !headApproved && draft.playId && play && !play.firstBatchReviewed ? { needed: true, reason: "first_batch" } : none;
}
/** Who may approve: a venture head or admin for a play's first batch; also the lead's owner where every message is approved. */
export const canApprove = (session: SalesSession | null, draft: ReviewDraft, reason: ApprovalReason | null) => reason === "every_message" ? canWorkLead(session, draft.lead) : canHead(session, draft.ventureId);

/** Fallback for the page-level Suspense boundaries. */
export function SalesFallback() {
  return <div className="rounded-2xl border border-neutral-100 bg-white shadow-card"><SkeletonRows rows={5} label="Loading" /></div>;
}

// ---- People and permissions ------------------------------------------------------------------------------

export const isLearner = (session: SalesSession | null) => session?.membership.role === "learner";
/** Shown where a writer who does not own the lead would see the lead's actions. */
export const OWNER_ONLY_NOTE = "Only the lead's owner or a venture head can do this.";

/** Ventures this person can write in (all for admins), as picker options. */
export function writableVentures(session: SalesSession | null) {
  if (!session || session.membership.role === "learner") return [];
  return session.hierarchy.ventures.filter((venture) => session.membership.role === "admin" || session.membership.ventureIds.includes(venture.id));
}

// ---- Words -----------------------------------------------------------------------------------------------
// One word per thing: the maps live in sales-ui.tsx. These are the older names the draft screens (and Calls, Plays, Find…) import.

/** Keyed by any string (callers look up values read from the API). */
export const REPLY_LABEL: Record<string, string> = REPLY_TYPE_LABELS;
export const CALL_OUTCOME_LABEL: Record<string, string> = CALL_OUTCOME_LABELS;
export {
  CHANNEL_LABELS as CHANNEL_LABEL, PURPOSE_LABELS as PURPOSE_LABEL, OPT_IN_LABELS as OPT_IN_LABEL, ReplyTypeChip, stamp, ago, routeOf, canHead, canWriteIn,
  // The draft screens' own link and permission rules (they differ from sales-ui's telHref, waDigits, waHref and canEditLead).
  telLink as telHref, waLinkDigits as waDigits, waTextHref as waHref, canWorkLead as canEditLead,
} from "./sales-ui";
export const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
export const shortSession = (id?: string) => id ? id.slice(0, 6) : "";

// ---- Contact routes and links ----------------------------------------------------------------------------

/** One plain address: letters, digits and . _ + - around a single @. Anything that could add recipients, headers or a query gives "". */
export function plainEmail(value: string) {
  const email = value.trim();
  return email.length <= 254 && /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email) ? email : "";
}
/** A mailto link for one plain address, or "" (show the text without a link). */
export function mailtoHref(email: string, subject: string, body: string) {
  const to = plainEmail(email);
  return to ? `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}` : "";
}
export const safeHttp = (value: string) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
/** A link on linkedin.com (or one of its subdomains, such as in.linkedin.com), or "" for anything else. */
export function linkedinHref(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    return ["http:", "https:"].includes(url.protocol) && (host === "linkedin.com" || host.endsWith(".linkedin.com")) ? url.href : "";
  } catch { return ""; }
}
/** The instagram.com profile for an Instagram route (an @handle or an instagram.com link), or "" when it is neither. */
export function instagramHref(value: string) {
  const text = value.trim();
  const handle = /^@?([A-Za-z0-9._]{1,30})$/.exec(text)?.[1] ?? /^https:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?$/i.exec(text)?.[1];
  return handle ? `https://www.instagram.com/${handle}/` : "";
}

export async function copyText(text: string, label = "Copied to clipboard") {
  try { await navigator.clipboard.writeText(text); toast({ title: label }); return true; }
  catch { toast({ tone: "error", title: "Could not copy", body: "Your browser blocked clipboard access. Select the text and copy it by hand." }); return false; }
}

/** True while someone is typing or a dialog is open, so single-key shortcuts must not fire. */
export const typingTarget = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !!target.closest('[role="combobox"], [role="dialog"], [role="alertdialog"], [role="menu"]'));

// ---- Small visual pieces ---------------------------------------------------------------------------------

export const CHANNEL_ICON: Record<string, Icon> = { email: Mail, whatsapp: Whatsapp, call: Phone, call_opener: Phone, linkedin: Linkedin, instagram: Instagram, meeting: MessageSquareText, note: MessageSquareText };
/** Square icon tile for a channel. WhatsApp is green because that is how people recognise it. */
export function ChannelTile({ channel, size = 36, className }: { channel: string; size?: number; className?: string }) {
  const ChannelIcon = CHANNEL_ICON[channel] ?? Mail;
  return <span aria-hidden="true" style={{ width: size, height: size }} className={clsx("grid shrink-0 place-items-center rounded-xl", channel === "whatsapp" ? "bg-success-surface text-success-text" : "bg-neutral-100 text-neutral-500", className)}><ChannelIcon size={Math.round(size * 0.47)} /></span>;
}

/** A pill-style segmented control (2 to 4 options). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: { value: T; label: React.ReactNode }[]; label: string }) {
  return <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-xl border border-neutral-200 bg-neutral-50 p-0.5">
    {options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)} className={clsx("min-h-8 rounded-[10px] px-3 text-xs font-semibold transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", value === option.value ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800")}>{option.label}</button>)}
  </div>;
}

export const kbdClass = "rounded border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium text-neutral-500";
/** Small caps label used above blocks in side rails and drawers. */
export const kickerClass = "text-[11px] font-bold uppercase tracking-[.06em] text-neutral-400";
