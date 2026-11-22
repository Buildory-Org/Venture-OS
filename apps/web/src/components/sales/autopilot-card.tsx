"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { AutopilotSendMode } from "@venture-studio/contracts";
import { CircleAlert, Play, Sparkles } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { runAutopilotNow, saveAutopilot, type AutopilotDay, type AutopilotStatus } from "@/lib/sales-autopilot-api";
import { ActionLabel, Badge, Field, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { didAnything, didLine, sendTime, stuckKinds, stuckLine, stuckTotal } from "./autopilot-strip";
import { number, plural } from "./sales-ui";

// The Autopilot card at the top of Sales settings (docs/sales-autopilot.md §2, §7): the venture's switch, who it works as, the steps Claude
// does on the server, how messages go out, the daily limit, what stops it, and what it did today. Heads and admins change it; everyone
// else reads it. A server without the autopilot shows no card.

type Settings = AutopilotStatus["settings"];
type StepKey = "judge" | "write" | "review" | "followUps" | "replies";
export type AutopilotWriter = { id: string; name: string };

const STEPS: { key: StepKey; title: string; line: string }[] = [
  { key: "judge", title: "Judge new leads", line: "Reads each new company's own site and says whether it fits the offer, quoting the page." },
  { key: "write", title: "Write first emails", line: "Writes the first email for each lead worth contacting." },
  { key: "review", title: "Check every draft", line: "A separate pass checks each message against the offer's rules before a person sees it." },
  { key: "followUps", title: "Write the one follow-up", line: "One follow-up when nobody replied, then it stops." },
  { key: "replies", title: "Sort replies and draft answers", line: "Sorts each reply and drafts an answer for a person to send. Opt-outs go on the do-not-contact list at once." },
];

const STATE_BADGE: Record<AutopilotStatus["state"], { label: string; tone: "neutral" | "green" | "amber" }> = {
  off: { label: "Off", tone: "neutral" }, blocked: { label: "Stopped", tone: "amber" }, idle: { label: "On", tone: "green" }, working: { label: "Working now", tone: "green" },
};

/** "Today: found 3, judged 5 … · 14 calls to Claude, 52,300 tokens". */
function todayLine(day: AutopilotDay): string {
  const did = didAnything(day) ? `Today the app ${didLine(day)}.` : "Nothing done today yet.";
  const tokens = day.inputTokens + day.outputTokens;
  return day.modelCalls > 0 ? `${did} Cost: ${plural(day.modelCalls, "call")} to Claude, ${number(tokens)} tokens.` : did;
}

function CardSkeleton() {
  return <Panel className="mb-4 p-4 sm:p-5"><div role="status" aria-label="Loading the autopilot" className="space-y-4">
    <div className="flex items-center justify-between gap-3"><span className="vso-skeleton block h-5 w-32" /><span className="vso-skeleton block h-6 w-10 rounded-full" /></div>
    <span className="vso-skeleton block h-3 w-3/4" /><span className="vso-skeleton block h-11 w-full rounded-xl" /><span className="vso-skeleton block h-40 w-full rounded-xl" />
  </div></Panel>;
}

/** The Autopilot card. It works as the person stored, or as the viewer: nobody can name someone else (the API refuses it too). */
export function AutopilotCard({ ventureId, status, loading, viewer, emailCap, onSaved }: {
  ventureId: string; status: AutopilotStatus | null; loading: boolean; viewer: AutopilotWriter; emailCap: number; onSaved: (next: AutopilotStatus) => void;
}) {
  if (loading) return <CardSkeleton />;
  if (!status) return null;
  return <CardForm key={JSON.stringify(status.settings)} ventureId={ventureId} status={status} viewer={viewer} emailCap={emailCap} onSaved={onSaved} />;
}

function CardForm({ ventureId, status, viewer, emailCap, onSaved }: { ventureId: string; status: AutopilotStatus; viewer: AutopilotWriter; emailCap: number; onSaved: (next: AutopilotStatus) => void }) {
  const saved = status.settings;
  const [form, setForm] = useState<Settings>(saved);
  const [limit, setLimit] = useState(String(saved.dailyLeadLimit));
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "run">("");
  const [error, setError] = useState("");
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmAuto) requestAnimationFrame(() => confirmButton.current?.focus()); }, [confirmAuto]);
  const edit = status.canChange;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((current) => ({ ...current, [key]: value }));

  // Who it works as (the API's rule): the person already stored, or the viewer. Nobody else can be named here, so nobody becomes the
  // automatic sender without saying so themself. With nobody stored yet, it is the viewer.
  const storedId = saved.runAsUserId;
  const storedName = status.runAs?.id === storedId ? status.runAs?.name : undefined;
  const runAsId = form.runAsUserId ?? viewer.id;
  const isMe = runAsId === viewer.id;
  const runAsName = isMe ? viewer.name : storedName;
  const theirMailbox = isMe ? "your mailbox" : runAsName ? `${runAsName}'s mailbox` : "the mailbox of the person it works as";
  const tookOver = !!storedId && storedId !== viewer.id && isMe;
  // "Automatic" is switched on only by the person whose mailbox sends; anyone who may edit can keep it on or step it down.
  const canPickAuto = isMe;
  const count = Number(limit);
  // Nobody stored and the autopilot off: nothing to name yet (it becomes the viewer when switched on).
  const next: Settings = { ...form, dailyLeadLimit: count, ...(form.runAsUserId || form.enabled ? { runAsUserId: runAsId } : {}) };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  // What the server takes back out of the send queue on save: emails queued automatically go when the sender changes, the venture is
  // switched off, or "Automatic" is left.
  const unqueues = status.waiting.queued > 0 && saved.enabled && saved.send === "automatic"
    && ((!!storedId && next.runAsUserId !== storedId) || !next.enabled || next.send !== "automatic");
  const general = status.blockers.find((blocker) => !blocker.step);
  // The server names a blocker per step; the same sentence once is enough. With the autopilot off on the server, only that sentence.
  const blockers = [...new Set(status.blockers.filter((blocker) => status.server.on || !blocker.step).map((blocker) => blocker.text))];
  const canRun = edit && saved.enabled && !dirty && status.server.on && status.state !== "blocked" && !general;
  const badge = STATE_BADGE[status.state];

  function toggleOn(on: boolean) {
    // Switching it on works as the viewer unless someone is stored already.
    setForm((current) => ({ ...current, enabled: on, ...(on && !current.runAsUserId ? { runAsUserId: viewer.id } : {}) }));
  }
  function takeOver() {
    // "Automatic" was set for the other person's mailbox: it does not carry over to the viewer's without their own explicit choice.
    setForm((current) => ({ ...current, runAsUserId: viewer.id, ...(current.send === "automatic" ? { send: "after_approval" as const } : {}) }));
    setConfirmAuto(false);
  }
  function giveBack() { setForm((current) => ({ ...current, runAsUserId: storedId, send: current.send === "after_approval" && saved.send === "automatic" ? "automatic" : current.send })); }
  function pickSend(mode: AutopilotSendMode) {
    if (mode === "automatic" && form.send !== "automatic") { if (canPickAuto) setConfirmAuto(true); return; }
    setConfirmAuto(false); set("send", mode);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!Number.isInteger(count) || count < 1 || count > 200) { setError("Leads a day: a whole number from 1 to 200."); return; }
    if (next.enabled && !next.runAsUserId) { setError("Pick who the app works as."); return; }
    setBusy("save"); setError("");
    try {
      const result = await saveAutopilot(ventureId, next);
      toast({ title: next.enabled ? (saved.enabled ? "Autopilot saved" : "Autopilot on") : "Autopilot off", body: next.enabled ? `${runAsName ? `It works as ${runAsName}. ` : ""}Its next pass starts within a minute.` : "The app no longer judges, writes or checks by itself." });
      onSaved(result);
    } catch (cause) { setError(describeError(cause, "Could not save the autopilot. Try again.")); }
    finally { setBusy(""); }
  }
  async function runNow() {
    setBusy("run"); setError("");
    try {
      const result = await runAutopilotNow(ventureId);
      if (result.started) toast({ title: "A pass starts now", body: "What it does shows on Today and in Review." });
      else toast({ tone: "error", title: "It can't run now", body: result.reason ?? "Try again in a minute." });
    } catch (cause) { setError(describeError(cause, "Could not start a pass. Try again.")); }
    finally { setBusy(""); }
  }

  const sends: { mode: AutopilotSendMode; title: string; line: string }[] = [
    { mode: "by_hand", title: "You send each message", line: "Nothing goes out until a person sends it from Review." },
    { mode: "after_approval", title: "You approve, the app sends", line: `Approved emails go from your mailbox, a few minutes apart, inside the daily limit of ${plural(emailCap, "email")} a person.` },
    { mode: "automatic", title: "Automatic after the first batch", line: `Once a head has approved a play's first batch, emails that pass the check go out from ${theirMailbox} without a tap.` },
  ];
  const off = !form.enabled;

  return <Panel className="mb-4">
    <form onSubmit={save} aria-labelledby="autopilot-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ai-surface text-ai-text"><Sparkles size={17} /></span>
          <div className="min-w-0">
            <h2 id="autopilot-title" className="flex flex-wrap items-center gap-2 text-[15px] font-extrabold tracking-[-.01em] text-neutral-900">Autopilot{status.state !== "off" && <Badge tone={badge.tone}>{badge.label}</Badge>}</h2>
            <p className="mt-1 max-w-xl text-xs leading-5 text-neutral-500">The app judges leads, writes and checks messages by itself, so you only read and approve. People approve what goes out.</p>
          </div>
        </div>
        <label className={clsx("flex min-h-10 items-center gap-2.5 text-[13px] font-semibold text-neutral-700", edit && "cursor-pointer")}><span>{form.enabled ? "On" : "Off"}</span><input type="checkbox" role="switch" aria-label="Autopilot for this venture" checked={form.enabled} disabled={!edit} onChange={(event) => toggleOn(event.target.checked)} className="vso-toggle" /></label>
      </div>

      <div className="space-y-5 px-4 py-4 sm:px-5">
        {!edit && <p className="rounded-xl bg-neutral-50 px-3 py-2.5 text-xs leading-5 text-neutral-600">A venture head or admin changes the autopilot. You can read how it is set.</p>}
        {blockers.length === 1 && <p role="status" className="flex items-start gap-2 rounded-xl bg-warning-surface px-3 py-2.5 text-xs font-medium leading-5 text-warning-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{blockers[0]}</span></p>}
        {blockers.length > 1 && <div className="rounded-xl bg-warning-surface px-3 py-2.5 text-xs font-medium leading-5 text-warning-text">
          <p className="flex items-center gap-2 font-bold"><CircleAlert size={14} aria-hidden="true" className="shrink-0" />{`${blockers.length} things stop it`}</p>
          <ul aria-label="What stops it" className="mt-1 list-disc space-y-0.5 pl-[2.1rem]">{blockers.map((text) => <li key={text} className="[overflow-wrap:anywhere]">{text}</li>)}</ul>
        </div>}
        {stuckTotal(status) > 0 && <p className="flex items-start gap-2 rounded-xl bg-warning-surface px-3 py-2.5 text-xs font-medium leading-5 text-warning-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{stuckLine(status)} <b className="font-semibold">Waiting: {stuckKinds(status)}.</b></span></p>}
        {status.lastError &&<p className="flex items-start gap-2 rounded-xl bg-danger-surface px-3 py-2.5 text-xs font-medium leading-5 text-danger-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">Its last pass stopped: {status.lastError}</span></p>}

        <div className={clsx("space-y-5 transition-opacity duration-150", off && "opacity-60")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-neutral-600">It works as</span>
              <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-1.5">
                <span className="min-w-0 flex-1 text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere]">{isMe ? `${viewer.name} (you)` : runAsName ?? "Someone on the team"}</span>
                {edit && !isMe && <button type="button" onClick={takeOver} className={clsx(secondaryClass, "!min-h-9 !px-3 !text-xs")}>Make it work as me</button>}
                {edit && tookOver && <button type="button" onClick={giveBack} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Keep {storedName ?? "them"}</button>}
              </div>
              <p className="mt-1.5 text-xs leading-5 text-neutral-500">{isMe
                ? (tookOver ? "When you save, new leads are yours and automatic emails would go from your mailbox." : "New leads are yours. Automatic emails would go from your mailbox.")
                : `New leads are ${runAsName ?? "theirs"}'s. Automatic emails would go from their mailbox.`}</p>
            </div>
            <div>
              <Field label="Leads it works on a day"><input type="number" inputMode="numeric" min={1} max={200} disabled={!edit} value={limit} onChange={(event) => setLimit(event.target.value)} className={inputClass} /></Field>
              <p className="mt-1.5 text-xs leading-5 text-neutral-500">Judging and writing count. This keeps what it costs in check.</p>
            </div>
          </div>

          <fieldset>
            <legend className="mb-1.5 text-xs font-semibold text-neutral-600">What it does</legend>
            <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200">{STEPS.map((step) => <li key={step.key}><label className={clsx("flex items-start gap-3 px-3 py-3", edit && "cursor-pointer")}>
              <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold text-neutral-800">{step.title}</span><span className="mt-0.5 block text-xs leading-5 text-neutral-500">{step.line}</span></span>
              <input type="checkbox" role="switch" aria-label={step.title} checked={form[step.key]} disabled={!edit} onChange={(event) => set(step.key, event.target.checked)} className="vso-toggle mt-0.5" />
            </label></li>)}</ul>
          </fieldset>

          <fieldset>
            <legend id="autopilot-send" className="mb-1.5 text-xs font-semibold text-neutral-600">How messages go out</legend>
            <div role="radiogroup" aria-labelledby="autopilot-send" className="grid gap-2 lg:grid-cols-3">{sends.map((option) => {
              const checked = form.send === option.mode;
              // Only the person whose mailbox sends switches "Automatic" on; when it is on already it stays picked and can be stepped down.
              const locked = option.mode === "automatic" && !checked && !canPickAuto;
              const usable = edit && !locked;
              return <label key={option.mode} className={clsx("relative block rounded-xl border p-3 transition-[background-color,border-color] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-600", checked ? "border-primary-600 bg-primary-50" : "border-neutral-200 bg-white", usable && !checked && "cursor-pointer hover:bg-neutral-50", !usable && "cursor-default", locked && "opacity-70")}>
                <input type="radio" name="autopilot-send" value={option.mode} checked={checked} disabled={!usable} aria-describedby={locked ? "autopilot-auto-locked" : undefined} onChange={() => pickSend(option.mode)} className="sr-only" />
                <span className={clsx("block text-[13px] font-bold", checked ? "text-primary-900" : "text-neutral-800")}>{option.title}</span>
                <span className={clsx("mt-0.5 block text-xs leading-5", checked ? "text-primary-800" : "text-neutral-500")}>{option.line}</span>
                {locked && edit && <span id="autopilot-auto-locked" className="mt-1.5 block text-xs font-semibold leading-5 text-neutral-600">Only {runAsName ?? "the person it works as"} can switch this on: the emails go from their mailbox.</span>}
              </label>;
            })}</div>
            {confirmAuto && <div role="alertdialog" aria-labelledby="autopilot-auto-q" aria-describedby="autopilot-auto-body" className="vso-fade-enter mt-3 rounded-2xl border border-warning-text/30 bg-warning-surface p-4">
              <p id="autopilot-auto-q" className="text-sm font-bold text-warning-text">Send emails without a person reading each one?</p>
              <p id="autopilot-auto-body" className="mt-1 text-xs leading-5 text-warning-text">Once a head has approved a play&apos;s first batch, every first email and follow-up for that play that passes the check goes out from {theirMailbox} without anyone reading it first. Up to {plural(emailCap, "email")} a day, on working days, a few minutes apart. Replies are never answered by themselves, and anyone on the do-not-contact list is never written to.</p>
              <div className="mt-3 flex flex-wrap gap-2"><button ref={confirmButton} type="button" onClick={() => { set("send", "automatic"); setConfirmAuto(false); }} className={clsx(primaryClass, "max-sm:flex-1")}>Yes, send automatically</button><button type="button" onClick={() => setConfirmAuto(false)} className={clsx(secondaryClass, "max-sm:flex-1")}>Keep it as it is</button></div>
            </div>}
          </fieldset>
        </div>

        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        <div className="space-y-3 border-t border-neutral-100 pt-4">
          <p className="text-xs leading-5 text-neutral-500">{todayLine(status.today)}{status.lastRunAt ? ` Last pass ${sendTime(status.lastRunAt)}.` : ""}{status.waiting.queued > 0 ? ` ${plural(status.waiting.queued, "email")} waiting to go out${status.waiting.nextSendAt ? `, the next at ${sendTime(status.waiting.nextSendAt)}` : ""}.` : ""}</p>
          {edit && <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={!!busy || !dirty || confirmAuto} className={primaryClass}><ActionLabel busy={busy === "save"} idle={!saved.enabled && form.enabled ? "Switch it on" : "Save"} /></button>
            {canRun && <button type="button" disabled={!!busy || status.state === "working"} onClick={() => void runNow()} className={secondaryClass}><Play size={14} aria-hidden="true" /><ActionLabel busy={busy === "run"} busyText="Starting…" idle={status.state === "working" ? "Working now" : "Run now"} /></button>}
            {dirty && <span className="text-xs text-neutral-500">Not saved yet.{unqueues ? " Emails queued automatically are taken back out of the queue." : ""}</span>}
          </div>}
        </div>
      </div>
    </form>
  </Panel>;
}
