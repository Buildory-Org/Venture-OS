"use client";
import clsx from "clsx";
import { ArrowUpRight } from "@/components/ui/icons";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import type { FindRun } from "@/lib/sales-api";

// The office PC engine, as the runs show it: which worker last reported, and how long ago.

/** A running run that has not reported for this long is probably stuck, or the PC is off. */
export const STALE_HEARTBEAT_MS = 5 * 60_000;

/** "40 s", "2 min", "3 h", "2 d". */
export function since(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${Math.max(1, seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

export type Engine =
  | { state: "online" | "stale"; workerId: string | undefined; at: string; running: number; queued: number }
  | { state: "idle"; workerId: string | undefined; at: string; running: 0; queued: number }
  | { state: "none"; queued: number };

const lastSeen = (run: FindRun) => run.heartbeatAt ?? run.finishedAt ?? run.claimedAt;

/** What the runs say about the office PC: the most recent heartbeat of a running run, else the last time any worker touched a run. */
export function engineOf(runs: readonly FindRun[], now: number): Engine {
  const queued = runs.filter((run) => run.status === "queued").length;
  const running = runs.filter((run) => run.status === "running");
  const live = running.filter((run) => run.heartbeatAt).sort((a, b) => b.heartbeatAt!.localeCompare(a.heartbeatAt!))[0];
  if (live?.heartbeatAt) return { state: now - new Date(live.heartbeatAt).getTime() <= STALE_HEARTBEAT_MS ? "online" : "stale", workerId: live.workerId, at: live.heartbeatAt, running: running.length, queued };
  const touched = runs.filter((run) => run.workerId && lastSeen(run)).sort((a, b) => lastSeen(b)!.localeCompare(lastSeen(a)!))[0];
  if (touched) return { state: "idle", workerId: touched.workerId, at: lastSeen(touched)!, running: 0, queued };
  return { state: "none", queued };
}

/** One line above the two ways to find leads: is a worker connected, and when did it last report. */
export function FindEngineStrip({ runs, now }: { runs: readonly FindRun[]; now: number }) {
  const engine = engineOf(runs, now);
  const worker = "workerId" in engine && engine.workerId ? ` (worker ${engine.workerId})` : "";
  const tone = engine.state === "online" ? "bg-success-surface text-success-text" : engine.state === "stale" ? "bg-warning-surface text-warning-text" : "bg-neutral-100 text-neutral-600";
  return <div role="status" className={clsx("mb-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3.5 py-2.5 text-xs leading-5", tone)}>
    <span aria-hidden="true" className={clsx("h-2 w-2 shrink-0 rounded-full bg-current", engine.state === "online" && "animate-pulse")} />
    <p className="min-w-0 flex-1 font-medium">
      {engine.state === "none"
        ? <><b className="font-bold">No worker connected yet</b> · <WorkspaceLink href="/connect/live" className="inline-flex items-center gap-0.5 font-bold underline underline-offset-2 hover:opacity-80">Set up the office PC<ArrowUpRight size={11} aria-hidden="true" /></WorkspaceLink><span className="ml-1 opacity-80">(make an Office PC engine key, then follow <code className="font-mono text-[11px]">docs/VSO_ENGINE_BRIDGE.md</code>)</span></>
        : engine.state === "idle"
          ? <><b className="font-bold">Office PC:</b> idle, last seen {since(engine.at, now)} ago{worker}</>
          : <><b className="font-bold">Office PC:</b> last heartbeat {since(engine.at, now)} ago{worker}{engine.state === "stale" ? ". It may have stopped, or lost its connection." : ""}</>}
    </p>
    {engine.queued > 0 && <span className="shrink-0 font-semibold">{engine.queued} {engine.queued === 1 ? "run" : "runs"} waiting</span>}
  </div>;
}
