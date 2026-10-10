"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { LeaderboardEntry, LeaderboardWeekly } from "@venture-studio/contracts";
import { getWeeklyLeaderboard, markWeeklyLeaderboardSeen } from "@/lib/studio-api";
import { useStudio } from "@/lib/studio-store";
import { describeError } from "@/lib/errors";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowRight, Trophy } from "@/components/ui/icons";
import { PageFrame, SkeletonRows } from "@/components/studio/primitives";
import { dateRange, LeaderboardPersonDialog, LearnersToggle, ordinal, PosterHighlights, PosterPodium, PosterRow } from "@/components/studio/leaderboard-parts";

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

/** The Saturday edition: the overall standings as the week closed, with each person's move that week; the same for everyone. */
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
  const yours = ranked.find((entry) => entry.userId === currentUserId);
  const minimum = edition?.minimumTasks ?? 2;

  return <PageFrame>
    <section className="vso-weekly relative overflow-hidden rounded-[28px] px-4 pb-8 pt-6 sm:px-8 sm:pb-10 lg:px-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-white/70"><Trophy size={16} />Venture Studio</p>
        <LearnersToggle value={learners} onChange={setLearners} />
      </div>
      <header className="mx-auto mt-8 max-w-2xl text-center">
        <p className="text-sm font-extrabold uppercase tracking-[.2em] text-[#f6cb52]">{edition ? `Week of ${dateRange(edition.weekStart, edition.weekEnd)}` : "This week"}</p>
        <h1 className="vso-weekly-title mt-2 text-4xl font-black uppercase leading-[.95] tracking-[-.04em] [overflow-wrap:anywhere] sm:text-5xl xl:text-7xl">Top performers</h1>
        <p className="mt-2 text-lg font-extrabold uppercase tracking-[.12em] text-[#e09a1f] sm:text-xl">of the week</p>
        <p className="mt-3 text-sm font-semibold text-white/70">The overall standings as the week closed, from every task to date, and who moved this week.</p>
        {yours && <p className="mt-3 text-sm font-semibold text-white/80">You&apos;re {ordinal(yours.rank!)} overall{yours.rank! <= 3 ? ". Well done!" : "."}</p>}
        {error && edition && <p role="alert" className="mx-auto mt-4 max-w-md rounded-xl bg-white/10 px-4 py-2 text-sm text-white/90">{error}</p>}
      </header>

      {error && !edition ? <div className="mt-8 rounded-2xl bg-white p-2"><EmptyState variant="error" title="Could not load the top performers" body={error} /></div>
      : !edition ? <div className="mt-8 rounded-2xl bg-white/10 p-4"><SkeletonRows rows={4} label="Loading the top performers" /></div>
      : !ranked.length ? <div className="mx-auto mt-10 max-w-md text-center"><p className="text-lg font-bold">No one ranked yet</p><p className="mt-2 text-sm leading-6 text-white/70">People are ranked once they have {minimum} tasks handed in or due. Finished work counts as soon as it&apos;s handed in.</p></div>
      : <div className="mt-10 space-y-6 md:mt-14">
        <PosterPodium ranked={ranked} currentUserId={currentUserId} onOpen={setSelected} />
        {ranked.length > 3 && <ol className="vso-stagger-in mx-auto max-w-5xl space-y-2.5">{ranked.slice(3, 10).map((entry) => <li key={entry.userId}><PosterRow entry={entry} you={entry.userId === currentUserId} minimumTasks={minimum} trend onOpen={() => setSelected(entry)} /></li>)}</ol>}
        <PosterHighlights board={edition.board} />
      </div>}

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => router.push(safeNext(params.get("next")))} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#f6cb52] px-5 text-sm font-bold text-[#3a2604] transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.97]">Continue to Venture Studio<ArrowRight size={16} /></button>
        <Link href="/leaderboard/live" className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold text-white/80 transition-colors duration-150 hover:bg-white/10 hover:text-white">See the full leaderboard</Link>
      </div>
    </section>
    {selected && edition && <LeaderboardPersonDialog key={selected.userId} entry={selected} period="all" learners={learners} week={edition.id} minimumTasks={minimum} onClose={() => setSelected(null)} />}
  </PageFrame>;
}
