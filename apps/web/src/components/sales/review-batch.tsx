"use client";
import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { Check, Send, X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import type { ReviewDraft } from "@/lib/sales-api";
import { isRouteMissing } from "@/lib/sales-channels-api";
import { batchDrafts, type DraftBatchResult } from "@/lib/sales-autopilot-api";
import { accountLine, usableAccounts, useChannelAccounts } from "./channel-model";
import { useSalesShell } from "./sales-context";
import { goesAt, number, plural } from "./sales-ui";

// Approving and sending several Review messages at once (docs/sales-autopilot.md section 5): the bar under the list while rows are
// ticked, one confirmation that says exactly what happens, then one toast and, for anything skipped, a notice that stays until dismissed.

/** The API takes at most 50 drafts in one batch. */
export const BATCH_MAX = 50;
export type BatchSection = "approve" | "send";
type BatchAction = "approve" | "approve_and_send" | "send";

/** A row checkbox with a 40px hit area, as on Leads; clicking it never opens the message. */
export function RowCheck({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <label onClick={(event) => event.stopPropagation()} className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors duration-150 hover:bg-neutral-100">
    <input type="checkbox" checked={checked} aria-label={label} onChange={onChange} className="h-4 w-4 cursor-pointer accent-[var(--color-primary-700)]" />
  </label>;
}

/** "at 11:40 am", "between 11:40 am and 11:52 am", "between 6:50 pm and tomorrow at 10:00 am". */
function sendWindow(first?: string, last?: string) {
  if (!first) return "";
  if (!last || last === first) return goesAt(first);
  const bare = (text: string) => text.replace(/^at /, "");
  return `between ${bare(goesAt(first))} and ${bare(goesAt(last))}`;
}

/** Skipped drafts and approved ones that could not be queued, one line each with the company and the reason. */
export function batchLeftovers(result: DraftBatchResult, drafts: readonly ReviewDraft[], action: BatchAction | "unqueue"): string {
  const name = (id: string) => drafts.find((draft) => draft.id === id)?.lead.companyName ?? "A message";
  const lines = result.results
    .filter((item) => item.outcome === "skipped" || (action !== "approve" && item.outcome === "approved" && item.reason))
    .map((item) => `${name(item.id)}: ${item.outcome === "approved" ? "approved, not sent. " : ""}${item.reason ?? "it could not be done"}`);
  if (!lines.length) return "";
  const skipped = result.results.filter((item) => item.outcome === "skipped").length;
  const head = skipped ? `${plural(skipped, "message")} skipped` : "Approved, but not sent";
  return `${head}. ${lines.map((line) => /[.!?]$/.test(line) ? line : `${line}.`).join(" ")}`;
}

/** One toast that says what happened: how many approved, how many queued and when they go. */
export function batchToast(result: DraftBatchResult, action: BatchAction) {
  const approved = result.results.filter((item) => item.outcome === "approved" || item.outcome === "approved_and_queued").length;
  const queued = result.results.filter((item) => item.outcome === "queued" || item.outcome === "approved_and_queued").length;
  const when = sendWindow(result.firstSendAt, result.lastSendAt);
  const goes = queued ? `${plural(queued, "email")} ${queued === 1 ? "goes" : "go"} ${when}`.trim() : "";
  const title = action === "send" ? (queued ? `Sending ${plural(queued, "email")}` : "Nothing was sent")
    : approved ? `Approved ${plural(approved, "message")}` : "Nothing was approved";
  const body = [action === "send" ? (queued ? `They go ${when}.` : "") : goes ? `${goes}.` : "", result.skipped ? `${plural(result.skipped, "message")} skipped: see the list.` : ""].filter(Boolean).join(" ");
  toast({ tone: approved || queued ? (result.skipped ? "info" : "success") : "error", title, ...(body ? { body } : {}), duration: result.skipped ? 8000 : 5000 });
}

/**
 * The bar under the Review list while rows are ticked. Approve: "Approve and send N" (when the app can send from the queue and at least one
 * ticked message is an email) and "Approve N". Send: "Send N". Each asks once, naming the mailbox, the spacing and what stays by hand.
 * On a laptop it sticks to the bottom of the list; on a phone it is a bottom sheet.
 */
export function ReviewBatchBar({ section, drafts, canQueue, onClear, onDone, onRouteMissing }: {
  section: BatchSection; drafts: ReviewDraft[]; canQueue: boolean; onClear: () => void;
  onDone: (result: DraftBatchResult, action: BatchAction, drafts: ReviewDraft[]) => void; onRouteMissing: () => void;
}) {
  const { session, ventureName } = useSalesShell();
  const { accounts } = useChannelAccounts(canQueue);
  const [confirm, setConfirm] = useState<BatchAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const questionId = useId();
  const box = useRef<HTMLDivElement>(null);
  const emails = drafts.filter((draft) => draft.channel === "email");
  const byHand = drafts.length - emails.length;
  const count = number(drafts.length);

  useEffect(() => { if (confirm) box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true }); }, [confirm]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || busy) return;
      if (confirm) { event.preventDefault(); setConfirm(null); } else onClear();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirm, busy, onClear]);

  // The mailbox each venture's emails go from: the person's default for that venture.
  const ventures = [...new Set(emails.map((draft) => draft.ventureId))];
  const boxes = ventures.map((ventureId) => ({ ventureId, account: usableAccounts(accounts, ventureId, "email", session?.user.id)[0] }));
  const lines = [...new Set(boxes.filter((item) => item.account).map((item) => accountLine(item.account!)))];
  const missing = accounts ? boxes.filter((item) => !item.account) : [];
  const from = lines.length === 1 ? lines[0] : lines.length > 1 ? "your mailbox for each venture" : "your mailbox";

  async function run(action: BatchAction) {
    const list = action === "send" ? emails : drafts;
    setBusy(true); setError("");
    try {
      const result = await batchDrafts({ action, drafts: list.slice(0, BATCH_MAX).map((draft) => ({ id: draft.id, expectedUpdatedAt: draft.updatedAt })) });
      setConfirm(null);
      onDone(result, action, list);
    } catch (cause) {
      if (isRouteMissing(cause)) { onRouteMissing(); return; }
      setError(describeError(cause, "That did not work. Nothing changed. Try again."));
    } finally { setBusy(false); }
  }

  const emailCount = plural(emails.length, "email");
  const spacing = `${emails.length === 1 ? "It goes" : "They go"} from ${from}, a few minutes apart, inside today's sending limit. Any over the limit go on the next working day. You can take ${emails.length === 1 ? "it" : "any"} back until it goes.`;
  const handLine = byHand ? ` ${plural(byHand, "message")} ${byHand === 1 ? "isn't an email" : "aren't emails"}: ${byHand === 1 ? "it is" : "they are"} approved and ${byHand === 1 ? "stays" : "stay"} for you to send by hand.` : "";
  const noBoxFor = missing.length ? `You have no mailbox connected for ${missing.map((item) => ventureName(item.ventureId)).join(", ")}: ` : "";
  const question: Record<BatchAction, { title: string; body: string; go: string; busy: string }> = {
    approve_and_send: { title: `Approve ${count} and send ${emailCount}?`, body: `${spacing}${handLine}${noBoxFor ? ` ${noBoxFor}those emails are approved but not sent.` : ""}`, go: `Approve and send ${count}`, busy: "Approving…" },
    approve: { title: `Approve ${plural(drafts.length, "message")}?`, body: "They move to Send. Nothing goes out yet.", go: `Approve ${count}`, busy: "Approving…" },
    send: { title: `Send ${emailCount}?`, body: `${spacing}${noBoxFor ? ` ${noBoxFor}those emails stay here.` : ""}`, go: `Send ${number(emails.length)}`, busy: "Queueing…" },
  };
  const over = drafts.length > BATCH_MAX ? `Only the first ${BATCH_MAX} go in one batch.` : "";

  return <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 sm:bottom-5 sm:flex sm:justify-center sm:px-4 lg:sticky lg:inset-auto lg:bottom-0 lg:z-20 lg:block lg:px-0">
    <div ref={box} role="region" aria-label={section === "approve" ? "Approve the selected messages" : "Send the selected messages"} className="vso-fade-enter pointer-events-auto w-full rounded-t-2xl border border-neutral-200 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-e4 sm:w-auto sm:min-w-[22rem] sm:max-w-full sm:rounded-2xl lg:w-full lg:min-w-0 lg:rounded-none lg:border-x-0 lg:border-b-0 lg:shadow-none">
      {confirm ? <div role="alertdialog" aria-labelledby={questionId} className="vso-fade-enter space-y-2">
        <p id={questionId} className="text-sm font-bold text-neutral-900">{question[confirm].title}</p>
        <p className="text-xs leading-5 text-neutral-600">{question[confirm].body}{over ? ` ${over}` : ""}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" data-autofocus onClick={() => void run(confirm)} disabled={busy} className={clsx(primaryClass, "max-sm:flex-1")}><ActionLabel busy={busy} busyText={question[confirm].busy} idle={<>{confirm === "approve" ? <Check size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}{question[confirm].go}</>} /></button>
          <button type="button" onClick={() => setConfirm(null)} disabled={busy} className={clsx(secondaryClass, "max-sm:flex-1")}>Not yet</button>
        </div>
      </div> : <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="tnum text-[13px] font-bold text-neutral-900" aria-live="polite">{count} selected{byHand && section === "approve" && canQueue ? <span className="font-medium text-neutral-500"> · {number(byHand)} by hand</span> : null}</p>
          <button type="button" onClick={onClear} aria-label="Clear the selection" className="grid h-9 w-9 place-items-center rounded-xl text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={16} aria-hidden="true" /></button>
        </div>
        <div className="flex flex-wrap gap-2">
          {section === "approve" && canQueue && emails.length > 0 && <button type="button" onClick={() => { setConfirm("approve_and_send"); setError(""); }} className={clsx(primaryClass, "flex-1 whitespace-nowrap")}><Send size={16} aria-hidden="true" />Approve and send {count}</button>}
          {section === "approve" && <button type="button" onClick={() => { setConfirm("approve"); setError(""); }} className={clsx(canQueue && emails.length > 0 ? secondaryClass : primaryClass, "flex-1 whitespace-nowrap")}><Check size={16} aria-hidden="true" />Approve {count}</button>}
          {section === "send" && <button type="button" onClick={() => { setConfirm("send"); setError(""); }} disabled={!emails.length} className={clsx(primaryClass, "flex-1 whitespace-nowrap")}><Send size={16} aria-hidden="true" />Send {number(emails.length)}</button>}
        </div>
      </div>}
      <Notice tone="error" message={error} onDismiss={() => setError("")} className="pt-2" />
    </div>
  </div>;
}
