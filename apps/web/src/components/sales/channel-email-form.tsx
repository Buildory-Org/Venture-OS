"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { channelAccountInputSchema, EMAIL_PROVIDER_PRESETS, emailAccountSettingsSchema, type ChannelAccount } from "@venture-studio/contracts";
import { ChevronDown, CircleAlert } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createChannelAccount, getEmailPresets, updateChannelAccount, type ChannelAccountUpdate, type EmailPreset } from "@/lib/sales-channels-api";
import { emailSettingsOf } from "./channel-model";
import { firstProblem, hintClass, labelClass, SecretField, TextField, Toggle, VentureChoice } from "./channel-form-parts";
import { firstName } from "./sales-ui";

// Add or change one of the person's own mailboxes: a provider's ready-made server settings, the address, the app password (typed once,
// never shown again), whether replies are read from the inbox, and the ventures it sends for.

type Security = EmailPreset["smtp"]["security"];
type Server = { host: string; port: string; security: Security };
const CUSTOM = "custom";
const PROVIDER_SHORT: Record<string, string> = { gmail: "Gmail", outlook: "Outlook", zoho: "Zoho Mail", hostinger: "Hostinger mail", godaddy: "Titan mail", [CUSTOM]: "mailbox" };
const PASSWORD_HINT: Record<string, string> = {
  gmail: "Use an app password (Google Account > Security > 2-Step Verification > App passwords). Your usual Gmail password won't work.",
  outlook: "Your mailbox password, or an app password if you sign in with two steps.",
  zoho: "With two-step sign-in on, make an app password in Zoho (My Account > Security > App passwords).",
};
const SECURITY_LABEL: Record<Security, string> = { ssl: "SSL/TLS", starttls: "STARTTLS" };
const LABELS: Record<string, string> = {
  label: "The name for this mailbox", address: "Email address", senderName: "Sender name", username: "Login name", password: "App password", ventureIds: "Ventures",
  "smtp.host": "Sending server", "smtp.port": "Sending port", "imap.host": "Reading server", "imap.port": "Reading port",
  "settings.smtp.host": "Sending server", "settings.smtp.port": "Sending port", "settings.imap.host": "Reading server", "settings.imap.port": "Reading port",
};
const toServer = (server: EmailPreset["smtp"]): Server => ({ host: server.host, port: String(server.port), security: server.security });
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));

export function EmailAccountForm({ account, choices, initialVentures, initialDefaults, userName, onClose, onSaved }: {
  account?: ChannelAccount; choices: { id: string; name: string }[]; initialVentures: string[]; initialDefaults: string[]; userName: string; onClose: () => void; onSaved: (account: ChannelAccount) => void;
}) {
  const current = account ? emailSettingsOf(account) : null;
  const [presets, setPresets] = useState<Record<string, EmailPreset>>({ ...EMAIL_PROVIDER_PRESETS });
  useEffect(() => { let active = true; getEmailPresets().then((next) => { if (active) setPresets(next); }).catch(() => undefined); return () => { active = false; }; }, []);
  const initialProvider = current ? Object.entries(EMAIL_PROVIDER_PRESETS).find(([, preset]) => preset.smtp.host === current.smtp.host)?.[0] ?? CUSTOM : "gmail";
  // The starting values are taken once, when the form opens.
  const [initial] = useState(() => ({
    provider: initialProvider,
    label: account?.label ?? `${firstName(userName)}'s ${PROVIDER_SHORT[initialProvider]}`,
    address: current?.address ?? "", senderName: current?.senderName ?? userName, username: current && current.username !== current.address ? current.username : "",
    smtp: current ? toServer(current.smtp) : toServer(EMAIL_PROVIDER_PRESETS.gmail.smtp), imap: current ? toServer(current.imap) : toServer(EMAIL_PROVIDER_PRESETS.gmail.imap),
    syncInbox: current?.syncInbox ?? true, saveToSent: current?.saveToSent ?? EMAIL_PROVIDER_PRESETS.gmail.saveToSent,
    ventureIds: account?.ventureIds ?? initialVentures, defaultFor: account?.defaultFor ?? initialDefaults,
  }));
  const [form, setForm] = useState(initial);
  const [labelTouched, setLabelTouched] = useState(Boolean(account));
  const [password, setPassword] = useState("");
  const [serverOpen, setServerOpen] = useState(initialProvider === CUSTOM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => { setForm((now) => ({ ...now, [key]: value })); if (error) setError(""); };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || Boolean(password);

  function pickProvider(key: string) {
    const preset = presets[key];
    setForm((now) => ({
      ...now, provider: key,
      ...(preset ? { smtp: toServer(preset.smtp), imap: toServer(preset.imap), saveToSent: preset.saveToSent } : {}),
      ...(!labelTouched ? { label: `${firstName(userName)}'s ${PROVIDER_SHORT[key] ?? preset?.label ?? "mailbox"}` } : {}),
    }));
    if (key === CUSTOM) setServerOpen(true);
    if (error) setError("");
  }
  const setServer = (which: "smtp" | "imap", change: Partial<Server>) => set(which, { ...form[which], ...change });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const address = form.address.trim();
    const settings = {
      address, senderName: form.senderName.trim(), username: form.username.trim() || address,
      smtp: { host: form.smtp.host.trim(), port: Number(form.smtp.port), security: form.smtp.security }, imap: { host: form.imap.host.trim(), port: Number(form.imap.port), security: form.imap.security },
      syncInbox: form.syncInbox, saveToSent: form.saveToSent,
    };
    const checked = emailAccountSettingsSchema.safeParse(settings);
    if (!checked.success) { setError(firstProblem(checked.error, LABELS)); if (checked.error.issues.some((issue) => issue.path[0] === "smtp" || issue.path[0] === "imap" || issue.path[0] === "username")) setServerOpen(true); return; }
    if (!form.ventureIds.length) { setError("Pick at least one venture it sends for."); return; }
    setBusy(true); setError("");
    try {
      let saved: ChannelAccount;
      if (!account) {
        if (!password.trim()) { setError(`Enter the ${form.provider === "gmail" || form.provider === "outlook" || form.provider === "zoho" ? "app password" : "password"}.`); setBusy(false); return; }
        const input = channelAccountInputSchema.safeParse({ kind: "email", label: form.label.trim(), ventureIds: form.ventureIds, defaultFor: form.defaultFor.filter((id) => form.ventureIds.includes(id)), enabled: true, settings: checked.data, secrets: { password } });
        if (!input.success) { setError(firstProblem(input.error, LABELS)); setBusy(false); return; }
        saved = await createChannelAccount(input.data);
        toast({ title: "Mailbox saved", body: `${saved.label}. Press Test to check it can sign in.` });
      } else {
        const change: ChannelAccountUpdate = {};
        if (form.label.trim() !== account.label) change.label = form.label.trim();
        if (!sameSet(form.ventureIds, account.ventureIds)) change.ventureIds = form.ventureIds;
        const defaults = form.defaultFor.filter((id) => form.ventureIds.includes(id));
        if (!sameSet(defaults, account.defaultFor)) change.defaultFor = defaults;
        const before = current ? emailAccountSettingsSchema.safeParse(current) : null;
        if (!before?.success || JSON.stringify(checked.data) !== JSON.stringify(before.data)) change.settings = checked.data;
        if (password.trim()) change.secrets = { password };
        if (!Object.keys(change).length) { onClose(); return; }
        saved = await updateChannelAccount(account.id, change);
        toast({ title: "Mailbox updated", body: change.settings || change.secrets ? `${saved.label}. Test it again: the change needs a new check.` : saved.label });
      }
      setPassword("");
      onSaved(saved);
    } catch (cause) { setError(describeError(cause, "Could not save the mailbox. Try again.")); }
    finally { setBusy(false); }
  }

  const providers = [...Object.entries(presets).map(([key, preset]) => ({ key, label: preset.label })), { key: CUSTOM, label: "Another provider" }];
  const appPassword = ["gmail", "outlook", "zoho"].includes(form.provider);
  return <DetailDrawer title={account ? `Edit ${account.label}` : "Add a mailbox"} subtitle="Your own work email. You send as yourself; replies from leads come back to the Inbox." dirty={dirty} onClose={onClose}>
    <form onSubmit={submit} noValidate className="space-y-5" autoComplete="off">
      <fieldset>
        <legend className={labelClass}>Who provides this email?</legend>
        <div role="radiogroup" aria-label="Email provider" className="grid grid-cols-2 gap-2 sm:grid-cols-3">{providers.map((provider) => <button key={provider.key} type="button" role="radio" aria-checked={form.provider === provider.key} onClick={() => pickProvider(provider.key)} className={clsx("min-h-12 rounded-xl border px-3 py-2 text-left text-[13px] font-semibold leading-5 transition-[background-color,border-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]", form.provider === provider.key ? "border-primary-600 bg-primary-50 text-primary-900" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50")}>{provider.label}</button>)}</div>
      </fieldset>
      {form.provider === "outlook" && <p role="note" className="flex items-start gap-2 rounded-xl bg-warning-surface p-3 text-xs leading-5 text-warning-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /><span>Your admin may need to allow SMTP AUTH for this mailbox (Microsoft 365 admin center, Users, Mail, Email apps) before it can send.</span></p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="mail-address" label="Email address" type="email" inputMode="email" autoComplete="off" spellCheck={false} maxLength={320} required value={form.address} onChange={(event) => set("address", event.target.value)} placeholder="you@company.in" />
        <TextField id="mail-sender" label="Sender name" maxLength={120} required value={form.senderName} onChange={(event) => set("senderName", event.target.value)} hint="What leads see as the sender." />
      </div>
      <SecretField id="mail-password" label={appPassword ? "App password" : "Password"} saved={account?.secrets.password} value={password} onChange={(value) => { setPassword(value); if (error) setError(""); }} hint={PASSWORD_HINT[form.provider] ?? "The mailbox's password, or an app password if your provider gives you one."} />
      <TextField id="mail-label" label="Name for this mailbox" maxLength={120} required value={form.label} onChange={(event) => { setLabelTouched(true); set("label", event.target.value); }} hint="Shown when you pick where to send from." />
      <VentureChoice choices={choices} ventureIds={form.ventureIds} defaultFor={form.defaultFor} noun="mailbox" onChange={(next) => setForm((now) => ({ ...now, ...next }))} />
      <div className="grid gap-2">
        <Toggle checked={form.syncInbox} onChange={(value) => set("syncInbox", value)} label="Read replies from this inbox" hint="Every few minutes the app reads new mail and files replies from leads. It never deletes, moves or marks anything read. Mail from anyone else stays private." />
        <Toggle checked={form.saveToSent} onChange={(value) => set("saveToSent", value)} label="Save a copy in Sent" hint={form.provider === "gmail" || form.provider === "outlook" ? "Gmail and Outlook keep a copy by themselves, so leave this off." : "So messages sent from the app show up in your Sent folder too."} />
      </div>
      <div className="rounded-xl border border-neutral-200">
        <button type="button" aria-expanded={serverOpen} aria-controls="mail-servers" onClick={() => setServerOpen(!serverOpen)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-[13px] font-semibold text-neutral-700 transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
          <span className="min-w-0 flex-1">Server settings <span className="font-normal text-neutral-500">· {form.provider === CUSTOM ? "fill these in" : "filled in for you"}</span></span><ChevronDown size={15} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", serverOpen && "rotate-180")} />
        </button>
        {serverOpen && <div id="mail-servers" className="vso-fade-enter space-y-4 border-t border-neutral-100 p-3">
          <TextField id="mail-username" label="Login name" autoComplete="off" spellCheck={false} maxLength={320} value={form.username} onChange={(event) => set("username", event.target.value)} placeholder={form.address || "Usually your email address"} hint="Leave it empty to sign in with the email address." />
          <ServerFields id="smtp" title="Sending (SMTP)" server={form.smtp} onChange={(change) => setServer("smtp", change)} />
          <ServerFields id="imap" title="Reading replies (IMAP)" server={form.imap} onChange={(change) => setServer("imap", change)} />
        </div>}
      </div>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} idle={account ? "Save changes" : "Save mailbox"} /></button><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button></div>
      <p className={hintClass}>The password is stored encrypted and never shown again, not even to admins. Nothing is sent until you press Send on a draft.</p>
    </form>
  </DetailDrawer>;
}

function ServerFields({ id, title, server, onChange }: { id: string; title: string; server: Server; onChange: (change: Partial<Server>) => void }) {
  return <fieldset className="space-y-2">
    <legend className="text-xs font-bold text-neutral-700">{title}</legend>
    <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2 sm:grid-cols-[minmax(0,1fr)_96px_150px]">
      <div className="col-span-2 sm:col-span-1"><label htmlFor={`${id}-host`} className={labelClass}>Server</label><input id={`${id}-host`} autoComplete="off" spellCheck={false} maxLength={255} value={server.host} onChange={(event) => onChange({ host: event.target.value })} placeholder={id === "smtp" ? "smtp.example.com" : "imap.example.com"} className={inputClass} /></div>
      <div><label htmlFor={`${id}-port`} className={labelClass}>Port</label><input id={`${id}-port`} inputMode="numeric" maxLength={5} value={server.port} onChange={(event) => onChange({ port: event.target.value.replace(/\D/g, "") })} className={inputClass} /></div>
      <div><span className={labelClass}>Security</span><Select aria-label={`${title} security`} className={inputClass} value={server.security} onChange={(event) => onChange({ security: event.target.value as Security })}>{(Object.keys(SECURITY_LABEL) as Security[]).map((value) => <option key={value} value={value}>{SECURITY_LABEL[value]}</option>)}</Select></div>
    </div>
  </fieldset>;
}
