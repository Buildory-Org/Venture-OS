"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Leaderboard, LeaderboardEntry, LeaderboardPeriod } from "@venture-studio/contracts";
import { getLeaderboard, getWeeklyLeaderboardStatus } from "@/lib/studio-api";
import { useStudio } from "@/lib/studio-store";
import { describeError } from "@/lib/errors";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { Crown, Trophy } from "@/components/ui/icons";
import { filterControl, HeaderActions, Notice, PageFrame, PageTitle, Panel, RefreshButton, SkeletonRows } from "@/components/studio/primitives";
import { dateRange, LeaderboardPersonDialog, METALS, ordinal, percent, PERIOD_LABELS, ROLE_LABELS, TrendMark } from "@/components/studio/leaderboard-parts";

const PERIODS: LeaderboardPeriod[] = ["week", "last_week", "month", "30d"];
const isPeriod = (value: string | null): value is LeaderboardPeriod => PERIODS.includes(value as LeaderboardPeriod);

/** One place on the podium: 2nd, 1st, and 3rd stand side by side, the winner tallest. */
function PodiumSpot({ entry, place, onOpen, you }: { entry: LeaderboardEntry; place: 1 | 2 | 3; onOpen: () => void; you: boolean }) {
  const metal = METALS[place - 1];
  return <button type="button" onClick={onOpen} aria-haspopup="dialog" aria-label={`${ordinal(place)} place: ${entry.name}${you ? " (you)" : ""}, score ${entry.score}`} style={{ "--rise-delay": `${place === 1 ? 0 : place === 2 ? 90 : 160}ms` } as React.CSSProperties}
    className="vso-podium-rise group flex min-w-0 flex-1 flex-col items-center rounded-2xl pt-2 text-center transition-transform duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]">
    <span className="relative">
      {place === 1 && <Crown size={24} aria-hidden="true" className="absolute -top-7 left-1/2 -translate-x-1/2 text-[#d99a1e]" />}
      <span className={clsx("block rounded-full p-[3px] shadow-card transition-transform duration-200 group-hover:-translate-y-0.5", metal)}><ChatAvatar id={entry.userId} name={entry.name} size={place === 1 ? 76 : 60} /></span>
      <span aria-hidden="true" className={clsx("absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full text-xs font-extrabold ring-[3px] ring-[var(--color-primary-50)]", metal)}>{place}</span>
    </span>
    <span className="mt-3 max-w-full truncate px-1 text-sm font-bold text-neutral-900">{entry.name}{you && <span className="font-semibold text-primary-700"> (you)</span>}</span>
    <span className="mt-1.5 inline-flex items-baseline gap-1 rounded-full bg-white px-3 py-1 shadow-card"><span className="text-base font-extrabold tracking-[-.02em] text-neutral-900 tnum">{entry.score}</span><span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">score</span></span>
    <span className="mt-1 text-[11px] font-semibold text-neutral-500 tnum">{percent(entry.onTime, entry.tasksDue)} on time · {entry.delivered} done</span>
    <span aria-hidden="true" className={clsx("vso-podium-step mt-3 flex w-full justify-center rounded-t-2xl pt-2 text-4xl font-extrabold text-primary-700/60", place === 1 ? "h-32 sm:h-36" : place === 2 ? "h-24 sm:h-28" : "h-16 sm:h-20")}>{place}</span>
  </button>;
}

export function LiveLeaderboardScreen() {
  const { activeVentureId: ventureId, currentUserId, data } = useStudio();
  // The board follows the venture switcher; say which venture it's showing.
  const scope = ventureId ? data.ventures.find((venture) => venture.id === ventureId)?.name ?? "This venture" : "All ventures";
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const period: LeaderboardPeriod = isPeriod(params.get("period")) ? params.get("period") as LeaderboardPeriod : "30d";
  const learners = params.get("learners") === "true";
  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(patch)) { if (value) next.set(name, value); else next.delete(name); }
    const search = next.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  };
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [weekly, setWeekly] = useState<{ weekStart: string; weekEnd: string; ranked: number } | null>(null);
  const [selected, setSelected] = useState<LeaderboardEntry | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      getLeaderboard({ period, ventureId: ventureId || undefined, learners }).then((data) => { if (active) { setBoard(data); setError(""); setBusy(false); } }, (cause: unknown) => { if (active) { setError(describeError(cause, "Could not load the leaderboard.")); setBusy(false); } });
    });
    return () => { active = false; };
  }, [period, ventureId, learners, revision]);
  useEffect(() => { getWeeklyLeaderboardStatus().then((status) => setWeekly(status.ranked ? status : null), () => setWeekly(null)); }, []);

  const ranked = board?.people.filter((entry) => entry.rank) ?? [];
  const waiting = board?.people.filter((entry) => !entry.rank) ?? [];
  const podium = ([[ranked[1], 2], [ranked[0], 1], [ranked[2], 3]] as const).filter((spot): spot is readonly [LeaderboardEntry, 1 | 2 | 3] => Boolean(spot[0]));
  const rest = ranked.slice(3);

  const row = (entry: LeaderboardEntry) => {
    const you = entry.userId === currentUserId;
    return <button key={entry.userId} type="button" aria-haspopup="dialog" onClick={() => setSelected(entry)} className={clsx("group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:bg-neutral-100 sm:px-5", you && "bg-primary-50/60")}>
      <span className="w-7 shrink-0 text-center text-sm font-extrabold text-neutral-400 tnum">{entry.rank ?? "–"}</span>
      <ChatAvatar id={entry.userId} name={entry.name} size={38} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-neutral-800">{entry.name}{you && <span className="ml-1.5 rounded-md bg-primary-100 px-1.5 py-0.5 text-[10px] font-bold text-primary-800">You</span>}</span>
        <span className="block truncate text-xs text-neutral-400">{ROLE_LABELS[entry.role]} · {entry.rank ? `${entry.tasksDue} task${entry.tasksDue === 1 ? "" : "s"} due` : `${entry.tasksDue} of ${board?.minimumTasks ?? 3} tasks due to be ranked`}</span>
      </span>
      <span className="hidden shrink-0 items-center gap-6 md:flex">
        {[["On time", percent(entry.onTime, entry.tasksDue)], ["First time", percent(entry.firstTimeRight, entry.delivered)], ["Delivered", String(entry.delivered)]].map(([label, value]) => <span key={label} className="w-16 text-center"><span className="block text-sm font-bold text-neutral-800 tnum">{value}</span><span className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{label}</span></span>)}
      </span>
      <TrendMark entry={entry} className="hidden shrink-0 sm:inline-flex" />
      {entry.rank ? <span className="w-12 shrink-0 text-right text-base font-extrabold tracking-[-.02em] text-neutral-900 tnum">{entry.score}</span> : <span title="Scored once they have enough tasks due" className="w-12 shrink-0 text-right text-base font-bold text-neutral-300">–</span>}
    </button>;
  };

  return <PageFrame>
    <PageTitle title="Leaderboard" description="Who delivers what they're given, on time and right first time. Scores are fair whatever the workload." action={<HeaderActions><RefreshButton busy={busy && !!board} onClick={() => setRevision((value) => value + 1)} />{weekly && <Link href={`/leaderboard/weekly/live?next=${encodeURIComponent(`${pathname}${params.toString() ? `?${params}` : ""}`)}`} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary-700 px-4 text-sm font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 active:scale-[0.97]"><Trophy size={17} />Top performers</Link>}</HeaderActions>} />
    <Notice tone="error" message={board ? error : ""} onDismiss={() => setError("")} className="pb-4" />
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1"><SlidingTabs label="Period" className="bg-neutral-100 shadow-none" active={period} onChange={(key) => setParams({ period: key === "30d" ? null : key })} tabs={PERIODS.map((key) => ({ key, label: PERIOD_LABELS[key] }))} /></div>
      <button type="button" aria-pressed={learners} onClick={() => setParams({ learners: learners ? null : "true" })} className={clsx(filterControl(learners), "inline-flex items-center gap-2")}>
        <span aria-hidden="true" className={clsx("relative h-4 w-7 rounded-full transition-colors duration-150", learners ? "bg-primary-600" : "bg-neutral-300")}><span className={clsx("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform duration-150", learners ? "translate-x-3.5" : "translate-x-0.5")} /></span>
        Include learners
      </button>
    </div>
    {!board && busy ? <Panel><SkeletonRows rows={6} label="Loading the leaderboard" /></Panel>
    : !board ? <Panel><EmptyState variant="error" title="Could not load the leaderboard" body={error} action={{ label: "Try again", onClick: () => setRevision((value) => value + 1) }} /></Panel>
    : <div className={clsx("grid min-w-0 gap-4 transition-opacity duration-200 lg:grid-cols-[minmax(0,1fr)_300px]", busy && "opacity-60")}>
      <div className="min-w-0 space-y-4">
        <Panel className="vso-podium overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 pt-5"><h2 className="text-sm font-bold text-neutral-900">Top performers</h2><span className="text-xs font-semibold text-neutral-500 tnum">{scope} · {PERIOD_LABELS[period]} · {dateRange(board.period.from, board.period.to)}</span></div>
          {podium.length ? <div key={`${period}-${learners}-${ventureId}`} className="mx-auto mt-6 flex max-w-xl items-end gap-2 px-3 sm:gap-4 sm:px-6">{podium.map(([entry, place]) => <PodiumSpot key={entry.userId} entry={entry} place={place} you={entry.userId === currentUserId} onOpen={() => setSelected(entry)} />)}</div>
          : <EmptyState variant="filtered" icon={Trophy} title="No one ranked yet" body={`People are ranked once they have ${board.minimumTasks} tasks due in the period. Try a longer period.`} />}
        </Panel>
        {(rest.length > 0 || waiting.length > 0) && <Panel className="overflow-hidden">
          {rest.length > 0 && <div className="vso-stagger-in divide-y divide-neutral-100">{rest.map(row)}</div>}
          {waiting.length > 0 && <>
            <h3 className={clsx("bg-neutral-50/70 px-5 py-2 text-[11px] font-bold uppercase tracking-wide text-neutral-500", rest.length && "border-t border-neutral-100")}>Not ranked yet <span className="font-semibold normal-case tracking-normal text-neutral-400">· fewer than {board.minimumTasks} tasks due</span></h3>
            <div className="divide-y divide-neutral-100">{waiting.map(row)}</div>
          </>}
        </Panel>}
      </div>
      <aside className="min-w-0 space-y-4">
        {board.mostDelivered && <Panel className="p-5">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">Most delivered</h2>
          <div className="mt-3 flex items-center gap-3"><ChatAvatar id={board.mostDelivered.userId} name={board.mostDelivered.name} size={44} /><div className="min-w-0"><p className="truncate text-sm font-bold text-neutral-900">{board.mostDelivered.name}</p><p className="text-xs text-neutral-500 tnum">{board.mostDelivered.delivered} tasks delivered</p></div></div>
        </Panel>}
        <Panel className="p-5">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">Top reviewers</h2>
          {board.reviewers.length ? <ul className="mt-3 space-y-3">{board.reviewers.map((item, index) => <li key={item.userId} className="flex items-center gap-3"><span className="w-4 text-xs font-extrabold text-neutral-400 tnum">{index + 1}</span><ChatAvatar id={item.userId} name={item.name} size={34} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-neutral-800">{item.name}</p><p className="text-xs text-neutral-500 tnum">{item.reviews} review{item.reviews === 1 ? "" : "s"} · usually within {item.medianHours < 1 ? "an hour" : item.medianHours < 48 ? `${Math.round(item.medianHours)}h` : `${Math.round(item.medianHours / 24)} days`}</p></div></li>)}</ul>
          : <p className="mt-2 text-xs leading-5 text-neutral-500">No evidence reviewed in this period yet.</p>}
        </Panel>
        <Panel className="p-5">
          <h2 className="text-[11px] font-bold uppercase tracking-wide text-neutral-400">How scores work</h2>
          <ul className="mt-3 space-y-2.5 text-xs leading-5 text-neutral-600">
            <li><strong className="text-neutral-800">70% on time.</strong> Each task due earns full credit on time, less the later it comes in, and nothing if it isn&apos;t delivered. Bigger tasks count for more.</li>
            <li><strong className="text-neutral-800">30% right first time.</strong> Evidence accepted without being sent back.</li>
            <li><strong className="text-neutral-800">Fair whatever the workload.</strong> Everyone&apos;s rates are evened out toward the team&apos;s, so a handful of tasks can&apos;t decide a rank. You&apos;re ranked from {board.minimumTasks} tasks due.</li>
            <li><strong className="text-neutral-800">Not your fault, not counted.</strong> The clock stops when evidence is sent, not when it&apos;s reviewed. Blocked time and too-short deadlines move the due date back. Cancelled and parked tasks don&apos;t count.</li>
          </ul>
        </Panel>
      </aside>
    </div>}
    {selected && board && <LeaderboardPersonDialog key={selected.userId} entry={selected} period={period} ventureId={ventureId || undefined} learners={learners} onClose={() => setSelected(null)} />}
  </PageFrame>;
}
