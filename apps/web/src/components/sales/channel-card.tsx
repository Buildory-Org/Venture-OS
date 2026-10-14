"use client";
import { useId, useState } from "react";
import clsx from "clsx";
import type { ChannelAccount, ChannelAccountTest } from "@venture-studio/contracts";
import { Check, ChevronDown, CircleAlert, Edit } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { deleteChannelAccount, testChannelAccount, updateChannelAccount } from "@/lib/sales-channels-api";
import { ChannelTile } from "./draft-shared";
import { Trash } from "./draft-icons";
import { accountLine, emailSettingsOf, isPersonalKind, KIND_NAME, META_STEPS, statusOf } from "./channel-model";
import { CopyRow } from "./channel-form-parts";
import { useSalesShell } from "./sales-context";
import { timeAgo } from "./sales-ui";

const SECRET_WORD: Record<string, string> = { password: "password", accessToken: "access token", appSecret: "app secret" };
const compact = "max-sm:!px-3";
const dangerClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger active:scale-[0.97] disabled:opacity-50";

/**
 * One connected account: what it is, its status, the ventures it sends for (and where it is the default), and what its manager can do:
 * test it, change it, switch it off, remove it, and for WhatsApp and Instagram copy the webhook details into the Meta app. A teammate's
 * mailbox shows to heads without any secret; an admin may only switch it off or remove it.
 */
export function ChannelCard({ account, mine, onEdit, onChanged }: { account: ChannelAccount; mine: boolean; onEdit: (account: ChannelAccount) => void; onChanged: () => void }) {
  const { ventureName, personName } = useSalesShell();
  const personal = isPersonalKind(account.kind);
  // The owner changes a mailbox or LinkedIn profile; an admin may only switch it off or remove it. A venture account: its managers.
  const owner = personal ? mine : account.canManage;
  const [busy, setBusy] = useState<"test" | "switch" | "remove" | "default" | null>(null);
  const [result, setResult] = useState<ChannelAccountTest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  // LinkedIn has nothing to connect (messages go by hand), so it has no test and no connection status.
  const linkedin = account.kind === "linkedin";
  const status = linkedin && account.enabled ? { tone: "neutral" as const, text: "Sent by hand" } : statusOf(account);
  const unreadable = Object.entries(account.secrets).filter(([, secret]) => !secret.set).map(([name]) => SECRET_WORD[name] ?? name);
  const email = emailSettingsOf(account);
  const meta = account.kind === "whatsapp" || account.kind === "instagram" ? account.kind : null;
  const note = account.status === "needs_attention" ? account.statusNote || account.lastError : "";

  async function run(name: NonNullable<typeof busy>, action: () => Promise<void>) {
    setBusy(name); setError("");
    try { await action(); }
    catch (cause) { setError(describeError(cause, "That did not work. Try again.")); }
    finally { setBusy(null); }
  }
  const test = () => run("test", async () => { setResult(null); const outcome = await testChannelAccount(account.id); setResult(outcome); onChanged(); });
  const toggle = () => run("switch", async () => { await updateChannelAccount(account.id, { enabled: !account.enabled }); toast({ title: account.enabled ? "Switched off" : "Switched on", body: account.enabled ? `${account.label}. Nothing is sent or read through it until it is switched on again.` : account.label }); onChanged(); });
  const remove = () => run("remove", async () => { await deleteChannelAccount(account.id); toast({ title: "Removed", body: `${account.label}. Messages already sent keep their history.` }); onChanged(); });
  const setDefault = (ventureId: string) => run("default", async () => {
    const on = account.defaultFor.includes(ventureId);
    await updateChannelAccount(account.id, { defaultFor: on ? account.defaultFor.filter((id) => id !== ventureId) : [...account.defaultFor, ventureId] });
    toast({ title: on ? "No longer the default" : "Default set", body: `${account.label} · ${ventureName(ventureId)}` });
    onChanged();
  });

  const facts = [
    account.lastCheckedAt ? `Tested ${timeAgo(account.lastCheckedAt)}` : "",
    email ? (email.syncInbox ? `Reads replies${account.lastSyncAt ? ` · checked ${timeAgo(account.lastSyncAt)}` : ""}` : "Doesn't read replies") : "",
    email?.saveToSent ? "Saves a copy in Sent" : "",
  ].filter(Boolean);

  return <li className={clsx("min-w-0 rounded-2xl border bg-white p-4 transition-colors duration-150", account.enabled ? "border-neutral-200" : "border-dashed border-neutral-200 bg-neutral-50")}>
    <div className="flex items-start gap-3">
      <ChannelTile channel={account.kind} size={40} className={clsx(!account.enabled && "opacity-60")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <div className="min-w-0"><h4 className="text-sm font-bold text-neutral-900 [overflow-wrap:anywhere]">{account.label}</h4><p className="mt-0.5 text-xs text-neutral-500 [overflow-wrap:anywhere]">{accountLine(account)}</p></div>
          <Badge tone={status.tone}>{status.text}</Badge>
        </div>
        {personal && !mine && account.ownerUserId && <p className="mt-1 text-xs text-neutral-500">{KIND_NAME[account.kind].one} of <b className="font-semibold text-neutral-700">{personName(account.ownerUserId)}</b></p>}
      </div>
    </div>

    {note && !result && <p className="mt-3 flex items-start gap-2 rounded-xl bg-danger-surface p-3 text-xs font-semibold leading-5 text-danger-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{note}</span></p>}
    {owner && unreadable.length > 0 && <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-surface p-3 text-xs font-semibold leading-5 text-warning-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span>The saved {unreadable.join(" and ")} can&apos;t be read any more. Choose Edit and enter {unreadable.length > 1 ? "them" : "it"} again.</span></p>}
    {account.status === "not_tested" && owner && account.enabled && !linkedin && <p className="mt-3 text-xs leading-5 text-neutral-500">Not checked yet. Press Test: it {email ? "signs in to the mailbox" : "checks it with Meta"} without sending anything.</p>}

    <div className="mt-3">
      <span className="block text-[11px] font-semibold text-neutral-500">{owner && account.ventureIds.length > 0 ? "Sends for · tap a venture to make this its default" : "Sends for"}</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">{account.ventureIds.map((ventureId) => {
        const isDefault = account.defaultFor.includes(ventureId);
        const text = <>{isDefault && <Check size={12} aria-hidden="true" />}{ventureName(ventureId)}{isDefault && <span className="font-medium opacity-80">· default</span>}</>;
        return owner
          ? <button key={ventureId} type="button" aria-pressed={isDefault} aria-label={isDefault ? `Default in ${ventureName(ventureId)}. Tap to unset.` : `Make it the default in ${ventureName(ventureId)}`} disabled={busy !== null} onClick={() => setDefault(ventureId)} className={clsx("inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold transition-[background-color,border-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] disabled:opacity-60", isDefault ? "border-primary-300 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50")}>{text}</button>
          : <span key={ventureId} className={clsx("inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-xs font-semibold", isDefault ? "bg-primary-50 text-primary-800" : "bg-neutral-100 text-neutral-600")}>{text}</span>;
      })}</div>
    </div>
    {facts.length > 0 && <p className="mt-2 text-[11px] font-medium text-neutral-400">{facts.join(" · ")}</p>}

    {(owner || account.canManage) && <div className="mt-3 flex flex-wrap items-center gap-2">
      {owner && !linkedin && <button type="button" onClick={test} disabled={busy !== null || !account.enabled} className={clsx(account.status === "connected" || !account.enabled ? secondaryClass : primaryClass, compact)}><ActionLabel busy={busy === "test"} busyText="Testing…" idle="Test" /></button>}
      {owner && <button type="button" onClick={() => onEdit(account)} disabled={busy !== null} className={clsx(secondaryClass, compact)}><Edit size={15} aria-hidden="true" className="max-sm:hidden" />Edit</button>}
      {account.canManage && <button type="button" onClick={toggle} disabled={busy !== null} className={clsx(secondaryClass, compact)}><ActionLabel busy={busy === "switch"} busyText="Saving…" idle={account.enabled ? "Switch off" : "Switch on"} /></button>}
      {account.canManage && <button type="button" onClick={() => { setConfirming(true); setError(""); }} disabled={busy !== null} aria-label={`Remove ${account.label}`} className={clsx(secondaryClass, "!px-3 !text-danger-text")}><Trash size={15} aria-hidden="true" /><span className="max-sm:sr-only">Remove</span></button>}
    </div>}

    <div role="status" aria-live="polite">
      {result && <div className="mt-3 space-y-2">
        <p className={clsx("flex items-start gap-2 rounded-xl p-3 text-xs font-semibold leading-5", result.ok ? "bg-success-surface text-success-text" : "bg-danger-surface text-danger-text")}>{result.ok ? <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />}<span className="min-w-0 [overflow-wrap:anywhere]">{result.message || (result.ok ? "It works." : "The test failed.")}</span></p>
        {result.checks.length > 0 && <ul aria-label="What was checked" className="space-y-1.5 px-1">{result.checks.map((check) => <li key={check.name} className="flex items-start gap-2 text-xs leading-5 text-neutral-700">{check.ok ? <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-success-text" /> : <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-danger-text" />}<span className="min-w-0 [overflow-wrap:anywhere]"><b className="font-semibold text-neutral-800">{check.name}</b>{check.detail ? `: ${check.detail}` : ""}<span className="sr-only">{check.ok ? " (passed)" : " (failed)"}</span></span></li>)}</ul>}
      </div>}
    </div>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mt-3" />

    {confirming && <div role="alertdialog" aria-label={`Remove ${account.label}?`} className="vso-fade-enter mt-3 rounded-xl border border-danger-surface bg-danger-surface p-3">
      <p className="text-sm font-bold text-danger-text">Remove {account.label}?</p>
      <p className="mt-1 text-xs leading-5 text-danger-text opacity-90">{personal ? "Nothing more is sent or read through it." : "Nobody can send through it any more and new messages to it stop arriving here."} Messages already sent keep their history. You can connect it again later.</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={remove} disabled={busy === "remove"} className={dangerClass}><ActionLabel busy={busy === "remove"} busyText="Removing…" idle="Remove" /></button><button type="button" onClick={() => setConfirming(false)} className={secondaryClass}>Keep it</button></div>
    </div>}

    {meta && account.canManage && <MetaSetup kind={meta} webhook={account.webhook} defaultOpen={account.status !== "connected"} />}
  </li>;
}

/** The Meta side of a WhatsApp number or Instagram account: the webhook details to paste and the steps. Folded away once it is connected. */
function MetaSetup({ kind, webhook, defaultOpen }: { kind: "whatsapp" | "instagram"; webhook: ChannelAccount["webhook"]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return <div className="mt-4 border-t border-neutral-100 pt-2">
    <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)} className="flex min-h-10 w-full items-center gap-2 rounded-lg text-left text-xs font-semibold text-neutral-700 transition-colors duration-150 hover:text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
      <span className="min-w-0 flex-1">Connect it in the Meta app <span className="font-normal text-neutral-500">· webhook details and steps</span></span><ChevronDown size={15} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", open && "rotate-180")} />
    </button>
    {open && <div id={panelId} className="vso-fade-enter mt-2 space-y-3">
      {webhook && <><CopyRow label="Callback URL" value={webhook.url} /><CopyRow label="Verify token" value={webhook.verifyToken} /></>}
      {webhook && !webhook.url.startsWith("https://") && <p className="rounded-xl bg-warning-surface p-3 text-xs leading-5 text-warning-text">Meta only calls public https addresses. This server&apos;s address is not one, so replies and ticks won&apos;t arrive here until it runs on its public address.</p>}
      <ol className="list-decimal space-y-2 rounded-xl bg-neutral-50 p-3 pl-8 text-xs leading-5 text-neutral-600 marker:font-semibold marker:text-neutral-400">{META_STEPS[kind].map((step) => <li key={step} className="pl-1">{step}</li>)}</ol>
    </div>}
  </div>;
}
