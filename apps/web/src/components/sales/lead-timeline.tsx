"use client";
import { useState } from "react";
import clsx from "clsx";
import type { Activity } from "@venture-studio/contracts";
import { CalendarDays, Mail, MessageCircle, Sparkles, Users, Video, type Icon } from "@/components/ui/icons";
import { Badge, secondaryClass } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { markActivityHandled } from "@/lib/sales-api";
import { absoluteDate, CALL_OUTCOME_LABELS, CHANNEL_LABELS, NotebookPen, Phone, REPLY_TYPE_LABELS, StageChip, timeAgo } from "@/components/sales/sales-ui";
import { Instagram } from "@/components/sales/draft-icons";
import { DeliveryTicks } from "@/components/sales/channel-delivery";
import { accountLabel, useChannelAccounts } from "@/components/sales/channel-model";

const KIND_ICON: Record<Activity["kind"], Icon> = { call: Phone, email: Mail, whatsapp: MessageCircle, linkedin: Users, instagram: Instagram, meeting: Video, note: NotebookPen };
const VIA_LABEL: Record<Activity["via"], string> = { app: "", claude: "", import: " (imported)", system: "" };
const SHOWN = 12;

export function activityHeading(activity: Activity): string {
  const channel = CHANNEL_LABELS[activity.kind] ?? activity.kind;
  if (activity.kind === "note") return "Note";
  if (activity.kind === "meeting") return "Meeting";
  if (activity.direction === "in") return `${channel} reply${activity.replyType ? `: ${REPLY_TYPE_LABELS[activity.replyType]}` : ""}`;
  if (activity.kind === "call") return `Call${activity.callOutcome ? `: ${CALL_OUTCOME_LABELS[activity.callOutcome]}` : ""}`;
  return `${channel} sent`;
}

function Clamped({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280;
  return <div className="mt-1.5"><p className={clsx("whitespace-pre-wrap text-sm leading-6 text-neutral-700 [overflow-wrap:anywhere]", long && !open && "line-clamp-4")}>{text}</p>{long && <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{open ? "Show less" : "Show more"}</button>}</div>;
}

/** What happened on a lead, newest first: calls, messages both ways, notes, and the stage changes they caused. */
export function LeadTimeline({ activities, canEdit, personName, onChanged }: { activities: Activity[]; canEdit: boolean; personName: (id: string) => string; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const [handling, setHandling] = useState("");
  const sorted = [...activities].sort((a, b) => b.at.localeCompare(a.at));
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  // Messages that went out or came in through a connected account name it ("via Divyansh's Gmail"); the labels come from the account list.
  const { accounts } = useChannelAccounts(activities.some((activity) => activity.message?.accountId));

  async function handled(activity: Activity) {
    setHandling(activity.id);
    try { await markActivityHandled(activity.id); onChanged(); }
    catch (cause) { toast({ tone: "error", title: "Could not mark it handled", body: describeError(cause, "Try again.") }); }
    finally { setHandling(""); }
  }

  if (!sorted.length) return <p className="rounded-xl bg-neutral-50 px-3 py-3 text-sm text-neutral-500">Nothing has happened on this lead yet. Calls, messages and notes will build up here.</p>;
  return <div>
    <ol className="relative grid gap-4 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-neutral-200">
      {shown.map((activity) => {
        // A message that arrived through a connected account (read from a mailbox, or sent to the venture's WhatsApp) is the lead's, not automation.
        const ActivityIcon = activity.via === "system" && !activity.message ? Sparkles : KIND_ICON[activity.kind];
        const inbound = activity.direction === "in";
        const waiting = inbound && !activity.handledAt;
        const via = accountLabel(accounts, activity.message?.accountId);
        const delivery = !inbound ? activity.message?.delivery : undefined;
        const who = activity.via === "system" ? (activity.message ? (inbound ? `Arrived${via ? ` in ${via}` : ""}` : `Sent${via ? ` from ${via}` : ""}`) : "Automatic") : `${personName(activity.actorId)}${VIA_LABEL[activity.via]}${via ? ` · via ${via}` : ""}`;
        return <li key={activity.id} className="relative flex gap-3">
          <span aria-hidden="true" className={clsx("relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white", inbound ? "bg-warning-surface text-warning-text" : "bg-neutral-100 text-neutral-600")}><ActivityIcon size={14} /></span>
          <div className="min-w-0 flex-1 pb-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><p className="text-sm font-semibold text-neutral-800">{activityHeading(activity)}</p>{activity.via === "claude" && <Badge tone="purple">Logged by Claude</Badge>}{waiting && <Badge tone="amber">In the inbox</Badge>}</div>
            <p className="mt-0.5 text-[11px] font-medium text-neutral-400" title={absoluteDate(activity.at)}>{who} · {timeAgo(activity.at)}</p>
            {activity.message?.subject && <p className="mt-1.5 text-[13px] font-semibold text-neutral-800 [overflow-wrap:anywhere]"><span className="sr-only">Subject: </span>{activity.message.subject}</p>}
            {activity.body && <Clamped text={activity.body} />}
            {delivery && <DeliveryTicks delivery={delivery} className="mt-1.5" />}
            {activity.stageTo && activity.stageFrom !== activity.stageTo && <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-neutral-400">{activity.stageFrom ? <><StageChip stage={activity.stageFrom} />to</> : "Moved to"}<StageChip stage={activity.stageTo} /></p>}
            {activity.nextAction && <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-neutral-500"><CalendarDays size={13} />Next: {activity.nextAction}</p>}
            {waiting && canEdit && <button type="button" disabled={handling === activity.id} onClick={() => void handled(activity)} className={clsx(secondaryClass, "mt-2 !min-h-9 !px-3 text-xs")}>{handling === activity.id ? "Marking…" : "Mark handled"}</button>}
          </div>
        </li>;
      })}
    </ol>
    {sorted.length > SHOWN && <button type="button" onClick={() => setAll(!all)} className="mt-3 text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{all ? "Show fewer" : `Show all ${sorted.length}`}</button>}
  </div>;
}
