"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Activity, ChannelAccount, Draft } from "@venture-studio/contracts";
import { CircleAlert, Send } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { errorCode, listWhatsappTemplates, reconcileDraftDelivery, sendDraftThrough, type SendResult, type WhatsappTemplate } from "@/lib/sales-channels-api";
import type { ReviewDraft } from "@/lib/sales-api";
import { CHANNEL_LABEL, kickerClass } from "./draft-shared";
import { accountLine, statusOf } from "./channel-model";
import { sendFromLabel } from "./draft-plan";
import { labelClass } from "./channel-form-parts";

// Sending a ready draft through a connected account, from the draft reader (docs/sales-channels.md section 2): pick the account (the
// venture's default first), confirm, send. WhatsApp outside the 24-hour window sends an approved template instead, with its values filled in.

const DAY_MS = 24 * 60 * 60_000;

/**
 * Whether the lead wrote to us on this channel in the last 24 hours (WhatsApp and Instagram only allow free text then): "open", "closed",
 * or "unknown" while their messages are not loaded. A message that came in through another of the venture's accounts does not count.
 */
export function replyWindow(activities: readonly Activity[] | null | undefined, kind: "whatsapp" | "instagram", accountId: string | undefined, now = Date.now()): "open" | "closed" | "unknown" {
  if (!activities) return "unknown";
  const last = activities.filter((activity) => activity.kind === kind && activity.direction === "in" && (!accountId || !activity.message?.accountId || activity.message.accountId === accountId)).map((activity) => Date.parse(activity.at)).sort((a, b) => b - a)[0];
  return last !== undefined && now - last < DAY_MS ? "open" : "closed";
}

// A template's values are numbered ({{1}}) or named ({{first_name}}). Numbered ones are sent in number order; named ones in the order they
// first appear, as the API reads them.
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
function slotsOf(template: WhatsappTemplate): string[] {
  const names = [...new Set([...template.body.matchAll(PLACEHOLDER)].map((match) => match[1]!))];
  const ordered = names.every((name) => /^\d+$/.test(name)) ? names.sort((a, b) => Number(a) - Number(b)) : names;
  return ordered.length === template.variableCount ? ordered : Array.from({ length: template.variableCount }, (_, index) => String(index + 1));
}
const slotLabel = (slot: string) => /^\d+$/.test(slot) ? `Value {{${slot}}}` : (slot.charAt(0).toUpperCase() + slot.slice(1)).replace(/_/g, " ");
/** A sensible first guess: the contact's name for {{1}} or a name field, the company for a company field. */
function guess(slot: string, index: number, names: { contact: string; company: string }) {
  if (/company|business|firm|shop|brand|org/i.test(slot)) return names.company;
  if (/name/i.test(slot) || (index === 0 && /^\d+$/.test(slot))) return names.contact || names.company;
  return "";
}
/** A provider's reason as a sentence (it may come without the full stop). */
const sentence = (text: string) => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
const fill = (body: string, slots: readonly string[], values: readonly string[]) => body.replace(PLACEHOLDER, (match, name: string) => values[slots.indexOf(name)]?.trim() || match);

/**
 * Send through a connected account: the main button ("Send from admin@buildory.dev", "Send from the venture's WhatsApp"), the account
 * picker when there are several, a confirm step and, for WhatsApp outside 24 hours, the template picker. `more` sits beside the button.
 * `startOpen`: the person already asked to send (the Inbox's "Save and send"), so the confirm (or the template picker) is open at once.
 * Every send names the version the person read (`expectedUpdatedAt`); a draft changed since is refused and `onStale` reads it again (the
 * reader says why). Nothing is retried by itself.
 */
export function SendBox({ draft, accounts, recipient, window, names, lastFailure, more, startOpen = false, onResult, onFailed, onStale }: {
  draft: ReviewDraft; accounts: ChannelAccount[]; recipient: string | undefined; window: "open" | "closed" | "unknown"; names: { contact: string; company: string }; lastFailure?: string | undefined;
  more?: React.ReactNode; startOpen?: boolean; onResult: (result: SendResult, account: ChannelAccount) => void; onFailed: () => void; onStale: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const account = accounts.find((item) => item.id === accountId) ?? accounts[0];
  const whatsapp = draft.channel === "whatsapp";
  const [stage, setStage] = useState<"idle" | "confirm" | "template">(() => !startOpen || lastFailure ? "idle" : whatsapp && window === "closed" ? "template" : "confirm");
  const [templateNote, setTemplateNote] = useState(() => startOpen && whatsapp && window === "closed" ? "They haven't written on WhatsApp in the last 24 hours, so WhatsApp only allows an approved template." : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState(lastFailure ?? "");
  // One request id per attempt, made when the confirm opens and kept for a retry after a lost answer, so a retry never sends twice. A
  // definite answer (sent, refused, failed) ends the attempt; the next press starts a new one.
  const requestId = useRef("");
  const needsTemplate = whatsapp && window === "closed";
  const status = account ? statusOf(account) : null;
  const channelWord = CHANNEL_LABEL[draft.channel]?.toLowerCase() ?? "message";
  // The confirm and the template picker open under the button: bring them into view (on a phone they would sit below the fold).
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (stage !== "idle") box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [stage]);

  function start() {
    setError(""); setFailure("");
    if (!requestId.current) requestId.current = crypto.randomUUID();
    if (needsTemplate) { setTemplateNote("They haven't written on WhatsApp in the last 24 hours, so WhatsApp only allows an approved template."); setStage("template"); }
    else setStage("confirm");
  }
  async function send(template?: { name: string; language: string; variables: string[] }) {
    if (!account) return;
    if (!requestId.current) requestId.current = crypto.randomUUID();
    setBusy(true); setError(""); setFailure("");
    try {
      const result = await sendDraftThrough(draft.id, { accountId: account.id, requestId: requestId.current, expectedUpdatedAt: draft.updatedAt, ...(template ? { template } : {}) });
      requestId.current = "";
      setStage("idle");
      onResult(result, account);
    } catch (cause) {
      const code = errorCode(cause);
      const message = describeError(cause, "It could not be sent. Try again.");
      if (code) requestId.current = "";
      if (code === "DRAFT_CHANGED") { setStage("idle"); onStale(); }
      else if (code === "TEMPLATE_REQUIRED") { setTemplateNote(message); setStage("template"); }
      else if (code === "SEND_FAILED") { setFailure(message); setStage("idle"); onFailed(); }
      else if (code) setError(message);
      else setError("The server didn't answer, so it's not clear whether it went. Press send again: the same request is repeated, never sent twice.");
    } finally { setBusy(false); }
  }

  if (!account) return null;
  return <div ref={box} className="scroll-mt-4 space-y-3">
    {accounts.length > 1 && stage === "idle" && <div className="max-w-md"><label htmlFor={`send-from-${draft.id}`} className={labelClass}>Send from</label><Select id={`send-from-${draft.id}`} className={clsx(inputClass, "!min-h-10")} value={account.id} onChange={(event) => { setAccountId(event.target.value); setStage("idle"); requestId.current = ""; }}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.label} · {accountLine(item)}{item.defaultFor.includes(draft.ventureId) ? " (default)" : ""}</option>)}</Select></div>}
    {status && account.status !== "connected" && <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-600"><Badge tone={status.tone}>{status.text}</Badge>{account.status === "needs_attention" ? "It failed its last check. Sending may not work until it is fixed in Channels." : "Not tested yet. It may not work until it is tested in Channels."}</p>}
    {stage === "idle" && <div className="flex items-center gap-2">
      <button type="button" onClick={start} title={`${account.label} · ${accountLine(account)}`} className={clsx(primaryClass, "!min-h-11 min-w-0 flex-1 py-2 sm:flex-initial")}><Send size={16} aria-hidden="true" className="shrink-0" /><span className="min-w-0 text-center leading-5 [overflow-wrap:anywhere]">{sendFromLabel(draft.channel, account)}</span></button>
      {more}
    </div>}
    {stage === "idle" && needsTemplate && <p className="text-xs leading-5 text-neutral-600">They haven&apos;t written on WhatsApp in the last 24 hours, so WhatsApp only takes an approved template: you pick one next, and it goes instead of this text.</p>}

    {stage === "confirm" && <div role="alertdialog" aria-label="Confirm sending" className="vso-fade-enter rounded-2xl border border-primary-200 bg-primary-50 p-3.5 sm:p-4">
      <p className="text-sm font-bold text-neutral-900 [overflow-wrap:anywhere]">Send this {channelWord} to {recipient || "them"} from {draft.channel === "email" ? accountLine(account) : account.label}?</p>
      <p className="mt-1 text-xs leading-5 text-neutral-600">It goes out now, exactly as written. {draft.channel === "email" ? "Replies come back to your inbox and to the Inbox here." : "Their replies come back to the Inbox here."}</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void send()} disabled={busy} className={clsx(primaryClass, "max-sm:flex-1")}><ActionLabel busy={busy} busyText="Sending…" idle={<><Send size={16} aria-hidden="true" />Send now</>} /></button><button type="button" onClick={() => { setStage("idle"); setError(""); }} disabled={busy} className={clsx(secondaryClass, "max-sm:flex-1")}>Not yet</button></div>
    </div>}
    {stage === "template" && <TemplatePicker account={account} note={templateNote} names={names} busy={busy} onSend={(template) => void send(template)} onCancel={() => { setStage("idle"); setError(""); }} />}

    {failure && <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-surface p-3 text-xs font-semibold leading-5 text-danger-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">It didn&apos;t send: {sentence(failure)} Nothing went out. Fix it and send again, or send it yourself (More, I sent it myself).</span></p>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
  </div>;
}

/** The number's approved templates: pick one, fill each value (a name starts as the contact's, a company as theirs), see it as it will arrive. */
function TemplatePicker({ account, note, names, busy, onSend, onCancel }: { account: ChannelAccount; note: string; names: { contact: string; company: string }; busy: boolean; onSend: (template: { name: string; language: string; variables: string[] }) => void; onCancel: () => void }) {
  const [templates, setTemplates] = useState<{ accountId: string; list: WhatsappTemplate[] | null; error: string } | null>(null);
  const [pick, setPick] = useState("");
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    listWhatsappTemplates(account.id)
      .then((list) => { if (active) setTemplates({ accountId: account.id, list, error: "" }); })
      .catch((cause: unknown) => { if (active) setTemplates({ accountId: account.id, list: null, error: describeError(cause, "Could not read the templates.") }); });
    return () => { active = false; };
  }, [account.id]);
  const current = templates?.accountId === account.id ? templates : null;
  const list = current?.list ?? [];
  const keyOf = (template: WhatsappTemplate) => `${template.name}|${template.language}`;
  const template = list.find((item) => keyOf(item) === pick) ?? list[0];
  const slots = template ? slotsOf(template) : [];
  const filled = slots.map((slot, index) => values[index] ?? guess(slot, index, names));
  const missing = filled.some((value) => !value.trim());

  return <div className="vso-fade-enter space-y-3 rounded-xl border border-primary-200 bg-white p-3.5">
    <p className="text-[13px] font-bold text-neutral-900">Send an approved template</p>
    {note && <p className="text-xs leading-5 text-neutral-600">{note}</p>}
    {!current && <span role="status" aria-label="Reading the templates" className="vso-skeleton block h-10 w-full rounded-xl" />}
    {current?.error && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-xs font-semibold text-danger-text">{current.error}</p>}
    {current?.list && list.length === 0 && <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">{account.label} has no approved templates yet. A venture head creates them in WhatsApp Manager, and Meta approves them. Until then, send it from your own phone and mark it sent.</p>}
    {list.length > 1 && <div><span className={labelClass}>Template</span><Select aria-label="Template" className={inputClass} value={template ? keyOf(template) : ""} onChange={(event) => { setPick(event.target.value); setValues([]); }}>{list.map((item) => <option key={keyOf(item)} value={keyOf(item)}>{item.name} · {item.language}{item.category ? ` · ${item.category.toLowerCase()}` : ""}</option>)}</Select></div>}
    {template && <>
      {slots.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{filled.map((value, index) => <div key={slots[index]}><label htmlFor={`template-value-${index}`} className={labelClass}>{slotLabel(slots[index]!)}</label><input id={`template-value-${index}`} maxLength={1000} value={value} onChange={(event) => setValues(filled.map((item, at) => at === index ? event.target.value : item))} className={inputClass} /></div>)}</div>}
      <div><span className={kickerClass}>How it arrives</span><div className="mt-1 rounded-2xl bg-neutral-50 p-3"><div className="ml-auto w-fit max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-primary-200 bg-primary-100 px-4 py-3 text-sm leading-6 text-neutral-900 [overflow-wrap:anywhere]">{fill(template.body, slots, filled)}</div></div></div>
    </>}
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={!template || missing || busy} onClick={() => template && onSend({ name: template.name, language: template.language, variables: filled.map((value) => value.trim()) })} className={primaryClass}><ActionLabel busy={busy} busyText="Sending…" idle={<><Send size={16} aria-hidden="true" />Send template</>} /></button>
      <button type="button" onClick={onCancel} disabled={busy} className={secondaryClass}>Cancel</button>
    </div>
    {template && missing && <p className="text-xs text-neutral-500">Fill in every value first.</p>}
  </div>;
}

/** A send the provider never confirmed: the person checks their Sent folder or WhatsApp and says which it was. */
export function DeliveryReconcile({ draftId, onDone }: { draftId: string; onDone: (outcome: "sent" | "not_sent", draft: Draft) => void }) {
  const [busy, setBusy] = useState<"sent" | "not_sent" | null>(null);
  const [error, setError] = useState("");
  async function answer(outcome: "sent" | "not_sent") {
    setBusy(outcome); setError("");
    try { const result = await reconcileDraftDelivery(draftId, { outcome }); onDone(outcome, result.draft); }
    catch (cause) { setError(describeError(cause, "Could not save that. Try again.")); }
    finally { setBusy(null); }
  }
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => void answer("sent")} disabled={busy !== null} className={primaryClass}><ActionLabel busy={busy === "sent"} busyText="Saving…" idle="It went out" /></button>
      <button type="button" onClick={() => void answer("not_sent")} disabled={busy !== null} className={secondaryClass}><ActionLabel busy={busy === "not_sent"} busyText="Saving…" idle="It didn't go" /></button>
    </div>
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
  </div>;
}

/** Which of the person's mailboxes or LinkedIn profiles a hand-sent message went from (optional: "Somewhere else" sends none). */
export function SentFromPicker({ accounts, value, onChange }: { accounts: ChannelAccount[]; value: string; onChange: (value: string) => void }) {
  if (!accounts.length) return null;
  return <div className="mt-3 max-w-sm"><span className={labelClass}>Sent from</span><Select aria-label="Sent from" className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}<option value="">Somewhere else</option></Select></div>;
}
