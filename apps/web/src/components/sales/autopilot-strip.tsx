"use client";
import Link from "next/link";
import clsx from "clsx";
import { ArrowRight, CircleAlert, Sparkles } from "@/components/ui/icons";
import { AUTOPILOT_MAX_TRIES } from "@venture-studio/contracts";
import type { AutopilotDay, AutopilotStatus } from "@/lib/sales-autopilot-api";
import type { SalesOverview } from "@/lib/sales-api";
import { primaryClass } from "@/components/studio/primitives";
import { reviewWaiting } from "@/components/shell/use-sales-nav-counts";
import { number, plural } from "./sales-ui";

// The autopilot on Today (docs/sales-autopilot.md §7): what the app did by itself since the person last looked, what waits for them,
// and one button to the Review queue. Off: one quiet line. No venture, or a server without the autopilot: nothing at all.

/** Where the autopilot is set up. */
export const autopilotSettingsHref = (ventureId: string) => `/sales/live/setup?venture=${encodeURIComponent(ventureId)}`;

/** "a, b and c". */
export const sentence = (parts: readonly string[]) => parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";
const capital = (text: string) => text ? text[0]!.toUpperCase() + text.slice(1) : text;

const COUNTED: (keyof AutopilotDay)[] = ["found", "judged", "written", "passed", "needChanges", "followUps", "repliesSorted", "replyDrafts", "queued", "sent"];
export const didAnything = (day: AutopilotDay | undefined) => !!day && COUNTED.some((key) => Number(day[key]) > 0);
/** Two days added up (for "since yesterday"). */
export function addDays(a: AutopilotDay, b?: AutopilotDay): AutopilotDay {
  if (!b) return a;
  const out = { ...a };
  for (const key of Object.keys(a) as (keyof AutopilotDay)[]) if (key !== "day") (out[key] as number) = (a[key] as number) + (b[key] as number);
  return out;
}

/** "found 10 companies, judged 10 (6 worth contacting), wrote 6 first emails and 1 follow-up. 5 passed the check". Empty when it did nothing. */
export function didLine(day: AutopilotDay): string {
  const wrote = [day.written > 0 && plural(day.written, "first email"), day.followUps > 0 && plural(day.followUps, "follow-up")].filter((part): part is string => !!part);
  const acts = [
    day.found > 0 && `found ${plural(day.found, "company", "companies")}`,
    day.judged > 0 && `judged ${number(day.judged)}${day.recommended > 0 ? ` (${number(day.recommended)} worth contacting)` : ""}`,
    wrote.length > 0 && `wrote ${wrote.join(" and ")}`,
    day.repliesSorted > 0 && `sorted ${plural(day.repliesSorted, "reply", "replies")}${day.replyDrafts > 0 ? ` (${plural(day.replyDrafts, "answer")} drafted)` : ""}`,
    day.sent > 0 && `sent ${plural(day.sent, "email")}`,
  ].filter((part): part is string => !!part);
  const checks = [day.passed > 0 && `${number(day.passed)} passed the check`, day.needChanges > 0 && `${number(day.needChanges)} ${day.needChanges === 1 ? "needs" : "need"} changes`].filter((part): part is string => !!part);
  if (!acts.length && !checks.length) return "";
  if (!acts.length) return `checked messages: ${checks.join(", ")}`;
  return `${acts.join(", ")}${checks.length ? `. ${capital(checks.join(", "))}` : ""}`;
}

const dayFormat = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);
/** "10:40 am" today, else "Mon 10:40 am". */
export function sendTime(iso: string, now = new Date()) {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? timeFormat.format(at) : `${new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(at)} ${timeFormat.format(at)}`;
}

/** "Since yesterday the app found …" over the previous active day and today, or "Today the app …". Empty when it did nothing. */
export function sinceLine(status: AutopilotStatus): string {
  const { today, previous } = status;
  const before = didAnything(previous) ? previous : undefined;
  if (!before && !didAnything(today)) return "";
  const label = !before ? "Today" : (dateOf(today.day).getTime() - dateOf(before.day).getTime()) / 86_400_000 === 1 ? "Since yesterday" : `Since ${dayFormat.format(dateOf(before.day))}`;
  return `${label} the app ${didLine(addDays(today, before))}.`;
}

/** What waits for the person in Review, in their counts: "5 wait for your approval, 2 are ready to send." */
export function waitingLine(counts: SalesOverview["counts"], appReviews: boolean): string {
  const parts = [
    counts.toApprove > 0 && `${number(counts.toApprove)} ${counts.toApprove === 1 ? "waits" : "wait"} for your approval`,
    counts.readyToSend > 0 && `${number(counts.readyToSend)} ${counts.readyToSend === 1 ? "is" : "are"} ready to send`,
    counts.needsChanges > 0 && `${number(counts.needsChanges)} ${counts.needsChanges === 1 ? "needs" : "need"} changes`,
  ].filter((part): part is string => !!part);
  // The first part names what is counted: "1 message waits for your approval, 2 are ready to send."
  if (parts.length) parts[0] = parts[0]!.replace(/^(\S+) /, (_, count: string) => `${count} ${count === "1" ? "message" : "messages"} `);
  const review = reviewWaiting(counts, appReviews);
  // A server that does not split the review count yet: say it in one number.
  if (!parts.length && review > 0) parts.push(`${plural(review, "message")} ${review === 1 ? "waits" : "wait"} for you in Review`);
  return parts.length ? `${capital(sentence(parts))}.` : "Nothing waits for you in Review.";
}

/** Items the autopilot gave up on after AUTOPILOT_MAX_TRIES (they wait for a person or a Claude chat). */
export const stuckTotal = (status: AutopilotStatus) => status.stuck.judge + status.stuck.write + status.stuck.review + status.stuck.replies;
/** "The app tried 3 times and stopped on 2 leads and 1 message. Ask Claude to finish them, or do them yourself." Empty when nothing is stuck. */
export function stuckLine(status: AutopilotStatus): string {
  const { judge, write, review, replies } = status.stuck;
  const leads = judge + write;
  const parts = [leads > 0 && plural(leads, "lead"), review > 0 && plural(review, "message"), replies > 0 && plural(replies, "reply", "replies")].filter((part): part is string => !!part);
  return parts.length ? `The app tried ${AUTOPILOT_MAX_TRIES} times and stopped on ${sentence(parts)}. Ask Claude to finish them, or do them yourself.` : "";
}
/** The same work by kind: "2 leads to judge, 1 first email, 1 check, 1 reply". */
export function stuckKinds(status: AutopilotStatus): string {
  const { judge, write, review, replies } = status.stuck;
  return [judge > 0 && `${plural(judge, "lead")} to judge`, write > 0 && plural(write, "first email"), review > 0 && plural(review, "check"), replies > 0 && plural(replies, "reply", "replies")].filter((part): part is string => !!part).join(", ");
}

/** The step blocker to show first: one that stops everything, else the first one. */
export const firstBlocker = (status: AutopilotStatus) => status.blockers.find((blocker) => !blocker.step) ?? status.blockers[0];

function StripSkeleton() {
  return <div role="status" aria-label="Loading the autopilot" className="mb-4 flex min-h-[52px] items-center gap-3 rounded-2xl border border-neutral-100 bg-white px-4 shadow-card">
    <span className="vso-skeleton h-8 w-8 shrink-0 rounded-xl" /><span className="grid flex-1 gap-2"><span className="vso-skeleton h-3 w-3/5" /><span className="vso-skeleton h-2.5 w-2/5" /></span>
  </div>;
}

/** The autopilot strip at the top of Today. */
export function AutopilotStrip({ ventureId, status, loading, counts, appReviews }: { ventureId: string; status: AutopilotStatus | null; loading: boolean; counts: SalesOverview["counts"]; appReviews: boolean }) {
  if (!ventureId) return null;
  if (loading) return <StripSkeleton />;
  if (!status) return null;
  const settingsHref = autopilotSettingsHref(ventureId);
  const quietLink = "inline-flex min-h-8 items-center gap-1 rounded-lg px-1 text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";

  if (!status.settings.enabled) return <div className="mb-3 flex min-w-0 items-start gap-2 px-1 text-xs leading-6 text-neutral-500">
    <Sparkles size={13} aria-hidden="true" className="mt-[5px] shrink-0 text-neutral-400" />
    <p className="min-w-0">Autopilot is off: the app can judge leads, write and check messages by itself.{status.canChange && <>{" "}<Link href={settingsHref} className={clsx(quietLink, "-my-1 align-middle")}>Set it up<ArrowRight size={12} aria-hidden="true" /></Link></>}</p>
  </div>;

  const blocker = firstBlocker(status);
  if (status.state === "blocked" || (blocker && !blocker.step)) return <div role="status" className="mb-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs font-medium leading-5 text-warning-text">
    <CircleAlert size={15} aria-hidden="true" className="shrink-0" />
    <p className="min-w-0 flex-1 [overflow-wrap:anywhere]"><b className="font-bold">The autopilot is stopped.</b> {blocker?.text ?? status.lastError ?? "It can't run right now."}</p>
    <Link href={settingsHref} className="font-bold underline underline-offset-2 hover:opacity-80">Sales settings</Link>
  </div>;

  const working = status.state === "working";
  const did = sinceLine(status);
  const review = reviewWaiting(counts, appReviews);
  const queued = status.waiting.queued;
  // What waits for the person leads; what the app did by itself is the quiet line under it.
  const lines = [
    waitingLine(counts, appReviews),
    did || (working ? "" : "The autopilot is on. Nothing new for it to do yet."),
    queued > 0 ? `${plural(queued, "approved email")} ${queued === 1 ? "goes" : "go"} out ${status.waiting.nextSendAt ? `from ${sendTime(status.waiting.nextSendAt)}` : "soon"}, a few minutes apart.` : "",
  ].filter(Boolean);
  return <section aria-label="Autopilot" className="mb-4 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-neutral-100 bg-white p-4 shadow-card sm:px-5">
    <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ai-surface text-ai-text"><Sparkles size={17} /></span>
    <div className="min-w-0 flex-1 basis-64">
      {working && <p className="mb-0.5 inline-flex items-center gap-1.5 text-xs font-semibold text-success-text"><span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-current" />Working now</p>}
      <p className="text-sm font-semibold leading-6 text-neutral-800 [overflow-wrap:anywhere]">{lines[0]}</p>
      {lines.slice(1).map((line) => <p key={line} className="text-[13px] leading-5 text-neutral-500 [overflow-wrap:anywhere]">{line}</p>)}
      {stuckTotal(status) > 0 && <p className="mt-1 flex items-start gap-1.5 text-xs font-medium leading-5 text-warning-text"><CircleAlert size={13} aria-hidden="true" className="mt-1 shrink-0" />{stuckLine(status)}</p>}
      {blocker &&<p className="mt-1 flex items-start gap-1.5 text-xs font-medium leading-5 text-warning-text"><CircleAlert size={13} aria-hidden="true" className="mt-1 shrink-0" />{blocker.text}</p>}
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full">
      {review > 0 && <Link href="/sales/live/review" className={clsx(primaryClass, "max-sm:flex-1")}>Review {plural(review, "message")}</Link>}
      <Link href={settingsHref} className={quietLink}>Settings</Link>
    </div>
  </section>;
}
