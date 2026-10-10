"use client";
import { useEffect, useRef, useState } from "react";
import { Search, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, PanelHead, RefreshButton } from "@/components/studio/primitives";
import { listFindRuns, listPlays, type FindRun } from "@/lib/sales-api";
import { FindEngineStrip } from "@/components/sales/find-engine";
import { FindEnrichCard } from "@/components/sales/find-enrich";
import { FindPlanForm, templateOf, type FindTemplate } from "@/components/sales/find-plan-form";
import { FindRunList, isLiveRun } from "@/components/sales/find-run-list";
import { isLearner, useQueryParam, useSalesLoad } from "@/components/sales/draft-shared";
import { useNow } from "@/components/sales/inbox-sla";
import { useSalesShell } from "@/components/sales/sales-context";

/** Find leads: two ways to fill the pipeline (search for new companies, or fill in contacts of the ones we have), and what the office PC is doing about them. */
export function FindScreen() {
  const { session, ventureId } = useSalesShell();
  const [playParam] = useQueryParam("play");
  const writer = !isLearner(session);
  const now = useNow(15_000);
  // The engine is one worker for the whole workspace, so its status reads every venture's runs; the list shows the picked venture's.
  const everyRun = useSalesLoad("runs|", () => listFindRuns({}));
  const venturesRun = useSalesLoad(`runs|${ventureId}`, () => ventureId ? listFindRuns({ ventureId }) : Promise.resolve([] as FindRun[]));
  const plays = useSalesLoad(`find-screen-plays|${ventureId}`, () => playParam ? listPlays(ventureId ? { ventureId } : {}) : Promise.resolve([]));
  const [reuse, setReuse] = useState<{ key: number; template: FindTemplate } | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const list = ventureId ? venturesRun : everyRun;
  const loaded = list.data !== null;
  const shown = list.data ?? [];

  // A link from a play ("Find leads for this play") opens the form for that play, with its audience filled in.
  const play = playParam ? (plays.data ?? []).find((item) => item.id === playParam) : undefined;
  const waitingForPlay = Boolean(playParam) && plays.data === null && !plays.error;
  const template: FindTemplate | undefined = reuse?.template ?? (play ? { request: play.audience, places: [], categories: [], searches: [], limit: 50, ventureId: play.ventureId, playId: play.id } : undefined);

  // While a run is waiting or running, look again every 10 seconds (only while this tab is open on screen).
  const live = [...(everyRun.data ?? []), ...(venturesRun.data ?? [])].some(isLiveRun);
  const reloadAll = everyRun.reload;
  const reloadVenture = venturesRun.reload;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") { reloadAll(); reloadVenture(); } }, 10_000);
    return () => window.clearInterval(timer);
  }, [live, reloadAll, reloadVenture]);

  const reload = () => { everyRun.reload(); venturesRun.reload(); };
  const changed = (run: FindRun) => { const put = (rows: FindRun[]) => [run, ...rows.filter((item) => item.id !== run.id)]; everyRun.mutate(put); venturesRun.mutate(put); };
  function reusePlan(run: FindRun) { setReuse({ key: (reuse?.key ?? 0) + 1, template: templateOf(run) }); top.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }

  return <div ref={top} className="scroll-mt-4">
    {everyRun.data && <FindEngineStrip runs={everyRun.data} now={now} />}

    {writer
      ? <div className="grid items-stretch gap-4 lg:grid-cols-2">
        {waitingForPlay ? <Panel className="space-y-3 p-5"><span className="vso-skeleton block h-4 w-1/3" /><span className="vso-skeleton block h-24 rounded-xl" /></Panel>
          : <FindPlanForm key={reuse ? `reuse-${reuse.key}` : play ? `play-${play.id}` : "new"} template={template} onCreated={(run) => { changed(run); reload(); }} />}
        <FindEnrichCard runs={shown} onQueued={reload} />
      </div>
      : <Panel><EmptyState variant="card" tone="neutral" icon={Search} title="Searches are planned by people who can write" body="You can read past runs below. A contributor or venture head plans and queues new ones." /></Panel>}

    <Panel className="mt-4">
      <PanelHead title="Runs" aside={<RefreshButton busy={list.busy && loaded} onClick={reload} className="!min-h-9 !w-9" />} />
      {list.error && !loaded ? <EmptyState variant="error" title="Could not load the runs" body={list.error} action={{ label: list.busy ? "Trying again…" : "Try again", onClick: list.reload, disabled: list.busy }} />
        : !loaded ? <div role="status" aria-label="Loading runs" className="space-y-3 p-4">{[0, 1].map((index) => <div key={index} className="space-y-2"><span className="vso-skeleton block h-4 w-1/4" /><span className="vso-skeleton block h-3 w-4/5" /><span className="vso-skeleton block h-3 w-1/2" /></div>)}</div>
          : shown.length === 0 ? <EmptyState variant="card" tone="blue" icon={Sparkles} title="No runs yet" body={writer ? "Find new leads: describe the buyer and queue it. Fill in contacts: queue the leads that have no phone or email. Each run shows here with what it found." : "Runs planned by the team show up here with what they found."} />
            : <FindRunList runs={shown} now={now} canEdit={writer} onReuse={reusePlan} onChanged={(run) => { changed(run); }} />}
    </Panel>
    <p className="mt-3 text-xs leading-5 text-neutral-500"><b className="font-semibold text-neutral-700">House rules.</b> Public company pages only, no logged-in sites, contacts only from the company&apos;s own website. Nobody on the do-not-contact list is added or looked up.</p>
  </div>;
}
