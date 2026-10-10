import { useSyncExternalStore } from "react";
import type { BrainItem, Play } from "@venture-studio/contracts";
import { listLiveMembers, listLivePats, listLivePipelines } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";
import { listBrain, listPlays } from "@/lib/sales-api";
import { loadSettingsOrNull, type SalesSettingsView } from "./setup-api";

// What it takes to make a venture sales-ready, checked against the live data. Used by the setup screen and by SetupBanner.

type Pipeline = Awaited<ReturnType<typeof listLivePipelines>>[number];
type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
type Pat = Awaited<ReturnType<typeof listLivePats>>[number];

/** One source: its data, or why it could not be read. */
export type Source<T> = { data: T; error?: undefined } | { data: null; error: string };

export type SetupData = {
  ventureId: string;
  at: number;
  pipelines: Source<Pipeline[]>;
  brain: Source<BrainItem[]>;
  plays: Source<Play[]>;
  members: Source<Member[]>;
  /** `data: null` without an error means this API has no settings route. */
  settings: Source<SalesSettingsView | null>;
  keys: Source<Pat[]>;
};

export type SetupKey = "pipeline" | "offer" | "target_profile" | "message_rules" | "play" | "team" | "settings" | "connect";
export type SetupItem = { key: SetupKey; title: string; why: string; done: boolean; unknown: boolean; summary: string };
export const SETUP_TOTAL = 8;

async function source<T>(load: () => Promise<T>): Promise<Source<T>> {
  try { return { data: await load() }; } catch (cause) { return { data: null, error: describeError(cause, "Could not check this.") }; }
}

/** Reads everything the checklist needs, in parallel. A source that fails does not stop the others. */
export async function loadSetupData(ventureId: string): Promise<SetupData> {
  const [pipelines, brain, plays, members, settings, keys] = await Promise.all([
    source(async () => (await listLivePipelines()).filter((pipeline) => pipeline.ventureId === ventureId)),
    source(() => listBrain({ ventureId })),
    source(() => listPlays({ ventureId })),
    source(async () => (await listLiveMembers({ ventureId, limit: 100 })).items),
    source(() => loadSettingsOrNull(ventureId)),
    source(() => listLivePats()),
  ]);
  const data: SetupData = { ventureId, at: Date.now(), pipelines, brain, plays, members, settings, keys };
  remember(data);
  return data;
}

// ---- A small cache, so the banner does not ask again on every page --------------------------------------------------

const TTL_MS = 5 * 60_000;
const cache = new Map<string, SetupData>();
const listeners = new Set<() => void>();
function remember(data: SetupData) { cache.set(data.ventureId, data); listeners.forEach((listener) => listener()); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** The last checks for a venture and whether they are still fresh (under 5 minutes old). */
export const cachedSetup = (ventureId: string) => cache.get(ventureId);
export const isFresh = (data: SetupData | undefined) => !!data && Date.now() - data.at < TTL_MS;
export const forgetSetup = (ventureId: string) => { cache.delete(ventureId); listeners.forEach((listener) => listener()); };
/** Re-renders with the latest cached checks for a venture (null until the first load). */
export function useCachedSetup(ventureId: string): SetupData | null {
  return useSyncExternalStore(subscribe, () => cache.get(ventureId) ?? null, () => null);
}

// ---- The checks -----------------------------------------------------------------------------------------------------

const isActiveKey = (pat: Pat, now: number) => !pat.revokedAt && (!pat.expiresAt || new Date(pat.expiresAt).getTime() > now) && pat.scopes.some((scope) => scope.startsWith("sales:"));
export const approvedOf = (items: readonly BrainItem[] | null, kind: BrainItem["kind"]) => (items ?? []).filter((item) => item.kind === kind && item.status === "approved");
export const proposalsOf = (items: readonly BrainItem[] | null, kind: BrainItem["kind"]) => (items ?? []).filter((item) => item.kind === kind && item.status === "draft");
/** People who can write in the venture (everyone but learners). */
export const sellersOf = (members: readonly Member[] | null) => (members ?? []).filter((member) => member.role !== "learner");

export const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** [1,2,3,4,5,6] reads "Mon–Sat"; anything else is listed. */
export function daysLabel(days: readonly number[]) {
  const sorted = [...days].sort((a, b) => a - b);
  const consecutive = sorted.length > 2 && sorted.every((day, index) => index === 0 || day === sorted[index - 1]! + 1);
  return consecutive ? `${DAY_NAMES[sorted[0]!]}–${DAY_NAMES[sorted.at(-1)!]}` : sorted.map((day) => DAY_NAMES[day]).join(", ");
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function evaluateSetup(data: SetupData, now = Date.now()): SetupItem[] {
  const brainItem = (key: "offer" | "target_profile" | "message_rules", title: string, why: string): SetupItem => {
    if (data.brain.error !== undefined) return { key, title, why, done: false, unknown: true, summary: "Could not check." };
    const approved = approvedOf(data.brain.data, key);
    const proposals = proposalsOf(data.brain.data, key);
    return { key, title, why, done: approved.length > 0, unknown: false, summary: approved.length ? approved.map((item) => item.title).join(" · ") : proposals.length ? `None approved yet (${count(proposals.length, "proposal")} waiting)` : "Nothing written yet." };
  };
  // An archived pipeline no longer takes leads, so it does not count.
  const pipeline = data.pipelines.data?.find((entry) => entry.status !== "archived");
  const sellers = sellersOf(data.members.data);
  const teammates = sellers.filter((member) => member.role !== "admin");
  const key = data.keys.data?.find((pat) => isActiveKey(pat, now));
  return [
    { key: "pipeline", title: "A pipeline", why: "Leads live in a pipeline: it holds the venture's offer and the stages deals move through.", done: Boolean(pipeline), unknown: data.pipelines.error !== undefined, summary: data.pipelines.error !== undefined ? "Could not check." : pipeline ? `${pipeline.name} · offer: ${pipeline.offerName}` : "No pipeline yet." },
    brainItem("offer", "An approved offer", "Claude judges every lead's fit and writes every message from it."),
    brainItem("target_profile", "An approved target profile", "Claude judges every lead against who we sell to, and against the hard no's."),
    brainItem("message_rules", "Approved message rules", "Claude writes and checks every draft against how we write: length, tone, follow-up, replies."),
    { key: "play", title: "A first play", why: "A play is one short campaign: who, which steps, when to stop. Drafts and calls follow it.", done: (data.plays.data?.length ?? 0) > 0, unknown: data.plays.error !== undefined, summary: data.plays.error !== undefined ? "Could not check." : data.plays.data?.length ? data.plays.data.map((play) => play.name).slice(0, 3).join(" · ") : "No play yet." },
    { key: "team", title: "Teammates with access", why: "Leads need an owner who calls, reads replies and sends messages.", done: teammates.length > 0, unknown: data.members.error !== undefined, summary: data.members.error !== undefined ? "Could not check." : sellers.length ? `${count(sellers.length, "person", "people")} can sell here: ${sellers.map((member) => member.name).slice(0, 4).join(", ")}${sellers.length > 4 ? "…" : ""}` : "Nobody can sell here yet." },
    { key: "settings", title: "Working days and daily limits", why: "When follow-ups fall due, how fast a reply must be answered, and how many messages a person sends a day.", done: Boolean(data.settings.data?.updatedAt), unknown: data.settings.error !== undefined, summary: data.settings.error !== undefined ? "Could not check." : data.settings.data ? (data.settings.data.updatedAt ? `${daysLabel(data.settings.data.workingDays)}: follow up after ${count(data.settings.data.followUpAfterWorkingDays, "working day")}, reply within ${data.settings.data.replySlaHours}h, ${data.settings.data.dailyCaps.email} emails and ${data.settings.data.dailyCaps.whatsapp} WhatsApp a day.` : "Defaults in use: Mon–Sat, follow-up after 4 working days, 20 emails and 20 WhatsApp a day.") : "Defaults in use: Mon–Sat, follow-up after 4 working days, 20 emails and 20 WhatsApp a day." },
    { key: "connect", title: "Claude connected", why: "Claude researches leads, judges fit and writes drafts through the Dealflow Sales connector, using your own subscription.", done: Boolean(key), unknown: data.keys.error !== undefined, summary: data.keys.error !== undefined ? "Could not check." : key ? `Dealflow Sales connector · key “${key.name}”${key.lastUsedAt ? " in use" : ""}` : "No Dealflow Sales key yet." },
  ];
}

/** A venture is sales-ready when leads have a pipeline and Claude has an approved offer to sell. */
export function readiness(data: SetupData) {
  const items = evaluateSetup(data);
  const get = (key: SetupKey) => items.find((item) => item.key === key)!;
  return { items, done: items.filter((item) => item.done).length, ready: get("pipeline").done && get("offer").done, known: !get("pipeline").unknown && !get("offer").unknown };
}
