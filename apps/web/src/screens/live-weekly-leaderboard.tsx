"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import type { LeaderboardEntry, LeaderboardWeekly } from "@venture-studio/contracts";
import { getWeeklyLeaderboard, markWeeklyLeaderboardSeen } from "@/lib/studio-api";
import { useStudio } from "@/lib/studio-store";
import { describeError } from "@/lib/errors";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowRight, Trophy } from "@/components/ui/icons";
import { PageFrame, SkeletonRows } from "@/components/studio/primitives";
import { dateRange, LeaderboardPersonDialog, METALS, ordinal, percent } from "@/components/studio/leaderboard-parts";

/** Only a page inside the app may follow the edition, never another site, however the address is disguised. */
function safeNext(value: string | null) {
  const fallback = "/dashboard/live";
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith("/leaderboard/weekly")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}

/** A top-three card: score, how it was earned, the person, and the trophy. The winner's card stands taller. */
function TopCard({ entry, place, delay, onOpen }: { entry: LeaderboardEntry; place: 1 | 2 | 3; delay: number; onOpen: () => void }) {
  const stats: [string, string][] = [[percent(entry.onTime, entry.tasksDue), "On time"], [percent(entry.firstTimeRight, entry.delivered), "First time"], [String(entry.delivered), "Delivered"]];
  return <button type="button" onClick={onOpen} aria-haspopup="dialog" aria-label={`${ordinal(place)} place: ${entry.name}, score ${entry.score}`} style={{ "--rise-delay": `${delay}ms` } as React.CSSProperties}
    className={clsx("vso-podium-rise group relative flex w-full min-w-0 flex-col overflow-hidden rounded-3xl p-5 text-left shadow-[0_18px_50px_rgba(0,0,0,.35)] transition-transform duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 active:scale-[0.98] sm:p-6",
      METALS[place - 1], place === 1 ? "min-h-[300px] sm:min-h-[340px] md:-mt-6" : "min-h-[280px] sm:min-h-[300px]")}>
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[11px] font-bold uppercase tracking-[.14em] opacity-70">Score</p><p className="mt-1 text-5xl font-extrabold leading-none tracking-[-.05em] tnum sm:text-6xl">{entry.score}</p></div>
      <span className="shrink-0 rounded-full bg-white/50 p-1 shadow-sm"><ChatAvatar id={entry.userId} name={entry.name} size={place === 1 ? 64 : 54} /></span>
    </div>
    <div className="mt-4 flex gap-4">{stats.map(([value, label]) => <div key={label}><p className="text-sm font-extrabold tnum">{value}</p><p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</p></div>)}</div>
    <Trophy aria-hidden="true" size={150} strokeWidth={1.2} className="pointer-events-none absolute -bottom-6 -right-6 opacity-25 transition-transform duration-300 group-hover:-rotate-6" />
    <span aria-hidden="true" className="pointer-events-none absolute bottom-16 right-6 text-3xl font-extrabold italic tracking-[-.03em] opacity-40">{ordinal(place)}</span>
    <p className="relative mt-auto max-w-[75%] pt-6 text-2xl font-extrabold uppercase leading-[1.05] tracking-[-.02em] [overflow-wrap:anywhere] sm:text-[1.65rem]">{entry.name}</p>
  </button>;
}

export function LiveWeeklyLeaderboardScreen() {
  const { currentUserId } = useStudio();
  const params = useSearchParams();
  const router = useRouter();
  const [learners, setLearners] = useState(false);
  const [edition, setEdition] = useState<LeaderboardWeekly | null>(null);
  const [selected, setSelected] = useState<LeaderboardEntry | null>(null);
  const [error, setError] = useState("");
  const marked = useRef("");

  useEffect(() => {
    let active = true;
    getWeeklyLeaderboard(learners).then((data) => {
      if (!active) return;
      setEdition(data); setError("");
      // Seen once it's on screen, so the app doesn't bring the person here again this week.
      if (!data.seen && marked.current !== data.id) { marked.current = data.id; void markWeeklyLeaderboardSeen(data.id).catch(() => { marked.current = ""; }); }
    }, (cause: unknown) => { if (active) setError(describeError(cause, "Could not load this week's top performers.")); });
    return () => { active = false; };
  }, [learners]);

  const ranked = edition?.board.people.filter((entry) => entry.rank) ?? [];
  const top = ranked.slice(0, 3);
  const rest = ranked.slice(3, 10);
  const yours = ranked.find((entry) => entry.userId === currentUserId);
  // On wide screens 2nd, 1st, 3rd, like a podium; on phones in order.
  const cards: [LeaderboardEntry, 1 | 2 | 3, number][] = [];
  for (const [entry, place, delay] of [[top[1], 2, 120], [top[0], 1, 0], [top[2], 3, 220]] as const) if (entry) cards.push([entry, place, delay]);
  const topReviewer = edition?.board.reviewers[0];

  return <PageFrame>
    <section className="vso-weekly relative overflow-hidden rounded-[28px] px-4 pb-8 pt-6 sm:px-8 sm:pb-10 lg:px-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-white/70"><Trophy size={16} />Venture Studio</p>
        <div role="group" aria-label="Who's on the board" className="flex rounded-full bg-white/10 p-1 text-xs font-bold">
          {[[false, "Team"], [true, "With learners"]].map(([value, label]) => <button key={String(value)} type="button" aria-pressed={learners === value} onClick={() => setLearners(value as boolean)} className={clsx("min-h-8 rounded-full px-3 transition-colors duration-150", learners === value ? "bg-[#f6cb52] text-[#3a2604]" : "text-white/70 hover:text-white")}>{label as string}</button>)}
        </div>
      </div>
      <header className="mx-auto mt-8 max-w-2xl text-center">
        <p className="text-sm font-extrabold uppercase tracking-[.2em] text-[#f6cb52]">{edition ? dateRange(edition.weekStart, edition.weekEnd) : "This week"}</p>
        <h1 className="vso-weekly-title mt-2 text-4xl font-black uppercase leading-[.95] tracking-[-.04em] [overflow-wrap:anywhere] sm:text-5xl xl:text-7xl">Top performers</h1>
        <p className="mt-2 text-lg font-extrabold uppercase tracking-[.12em] text-[#e09a1f] sm:text-xl">of the week</p>
        {yours && <p className="mt-4 text-sm font-semibold text-white/80">You finished {ordinal(yours.rank!)} last week{yours.rank! <= 3 ? ". Well done!" : "."}</p>}
        {error && edition && <p role="alert" className="mx-auto mt-4 max-w-md rounded-xl bg-white/10 px-4 py-2 text-sm text-white/90">{error}</p>}
      </header>

      {error && !edition ? <div className="mt-8 rounded-2xl bg-white p-2"><EmptyState variant="error" title="Could not load the top performers" body={error} /></div>
      : !edition ? <div className="mt-8 rounded-2xl bg-white/10 p-4"><SkeletonRows rows={4} label="Loading the top performers" /></div>
      : !ranked.length ? <div className="mx-auto mt-10 max-w-md text-center"><p className="text-lg font-bold">A quiet week</p><p className="mt-2 text-sm leading-6 text-white/70">No one had enough tasks due last week to be ranked. People are ranked from three tasks due.</p></div>
      : <>
        <div className="mx-auto mt-10 grid max-w-5xl gap-4 md:mt-14 md:grid-cols-3 md:items-end">
          {cards.map(([entry, place, delay]) => <div key={entry.userId} className={clsx(place === 1 ? "order-first md:order-none" : place === 2 ? "order-2 md:order-none" : "order-3")}><TopCard entry={entry} place={place} delay={delay} onOpen={() => setSelected(entry)} /></div>)}
        </div>
        {rest.length > 0 && <ol className="vso-stagger-in mx-auto mt-6 max-w-5xl space-y-2.5">{rest.map((entry) => <li key={entry.userId}>
          <button type="button" aria-haspopup="dialog" onClick={() => setSelected(entry)} className={clsx("vso-weekly-row flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-[background-color,transform] duration-150 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[0.99] sm:gap-4 sm:px-5", entry.userId === currentUserId && "ring-1 ring-[#f6cb52]/60")}>
            <span className="vso-medal-silver grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-extrabold">{ordinal(entry.rank!)}</span>
            <ChatAvatar id={entry.userId} name={entry.name} size={40} />
            <span className="min-w-0 flex-1 truncate text-base font-bold">{entry.name}{entry.userId === currentUserId && <span className="ml-2 text-xs font-semibold text-[#f6cb52]">You</span>}</span>
            <span className="hidden items-center gap-7 md:flex">{[[percent(entry.onTime, entry.tasksDue), "On time"], [percent(entry.firstTimeRight, entry.delivered), "First time"], [String(entry.delivered), "Delivered"]].map(([value, label]) => <span key={label} className="w-16 text-center"><span className="block text-sm font-bold tnum">{value}</span><span className="block text-[10px] font-semibold uppercase tracking-wide text-white/50">{label}</span></span>)}</span>
            <span className="w-14 shrink-0 text-right"><span className="block text-xl font-extrabold tracking-[-.03em] tnum">{entry.score}</span><span className="block text-[10px] font-semibold uppercase tracking-wide text-white/50">Score</span></span>
          </button>
        </li>)}</ol>}
        {(edition.board.mostDelivered || topReviewer) && <div className="mx-auto mt-6 grid max-w-5xl gap-2.5 sm:grid-cols-2">
          {edition.board.mostDelivered && <div className="vso-weekly-row flex items-center gap-3 rounded-2xl px-4 py-3"><ChatAvatar id={edition.board.mostDelivered.userId} name={edition.board.mostDelivered.name} size={36} /><p className="min-w-0 text-sm"><span className="block text-[10px] font-bold uppercase tracking-[.14em] text-[#f6cb52]">Most delivered</span><span className="font-semibold">{edition.board.mostDelivered.name}</span><span className="text-white/60"> · {edition.board.mostDelivered.delivered} tasks</span></p></div>}
          {topReviewer && <div className="vso-weekly-row flex items-center gap-3 rounded-2xl px-4 py-3"><ChatAvatar id={topReviewer.userId} name={topReviewer.name} size={36} /><p className="min-w-0 text-sm"><span className="block text-[10px] font-bold uppercase tracking-[.14em] text-[#f6cb52]">Top reviewer</span><span className="font-semibold">{topReviewer.name}</span><span className="text-white/60"> · {topReviewer.reviews} reviews</span></p></div>}
        </div>}
      </>}

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => router.push(safeNext(params.get("next")))} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#f6cb52] px-5 text-sm font-bold text-[#3a2604] transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.97]">Continue to Venture Studio<ArrowRight size={16} /></button>
        <Link href="/leaderboard/live?period=last_week" className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold text-white/80 transition-colors duration-150 hover:bg-white/10 hover:text-white">See the full leaderboard</Link>
      </div>
    </section>
    {selected && edition && <LeaderboardPersonDialog key={selected.userId} entry={selected} period="last_week" learners={learners} week={edition.id} onClose={() => setSelected(null)} />}
  </PageFrame>;
}
