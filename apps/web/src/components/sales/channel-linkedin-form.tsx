"use client";
import { useState } from "react";
import { channelAccountInputSchema, linkedinAccountSettingsSchema, type ChannelAccount } from "@venture-studio/contracts";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createChannelAccount, updateChannelAccount, type ChannelAccountUpdate } from "@/lib/sales-channels-api";
import { linkedinSettingsOf } from "./channel-model";
import { firstProblem, hintClass, TextField, VentureChoice } from "./channel-form-parts";
import { firstName } from "./sales-ui";

// Add or change one of the person's LinkedIn profiles. LinkedIn has no messaging API for this: the person sends by hand from their own
// profile, marks the draft sent, and the app records which profile it went from and counts it against the daily limit.

const LABELS: Record<string, string> = { label: "The name for this profile", profileUrl: "Profile link", name: "Name on the profile", ventureIds: "Ventures" };
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));
/** "linkedin.com/in/someone" as people paste it, made into the full https link the API expects. */
const fullLink = (value: string) => { const text = value.trim(); return !text || /^https?:\/\//i.test(text) ? text.replace(/^http:/i, "https:") : `https://${text}`; };

export function LinkedinAccountForm({ account, choices, initialVentures, initialDefaults, userName, onClose, onSaved }: {
  account?: ChannelAccount; choices: { id: string; name: string }[]; initialVentures: string[]; initialDefaults: string[]; userName: string; onClose: () => void; onSaved: (account: ChannelAccount) => void;
}) {
  const current = account ? linkedinSettingsOf(account) : null;
  const [initial] = useState(() => ({ label: account?.label ?? `${firstName(userName)}'s LinkedIn`, profileUrl: current?.profileUrl ?? "", name: current?.name ?? userName, ventureIds: account?.ventureIds ?? initialVentures, defaultFor: account?.defaultFor ?? initialDefaults }));
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => { setForm((now) => ({ ...now, [key]: value })); if (error) setError(""); };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const settings = linkedinAccountSettingsSchema.safeParse({ profileUrl: fullLink(form.profileUrl), ...(form.name.trim() ? { name: form.name.trim() } : {}) });
    if (!settings.success) { setError(firstProblem(settings.error, LABELS)); return; }
    if (!form.ventureIds.length) { setError("Pick at least one venture you use it for."); return; }
    const defaults = form.defaultFor.filter((id) => form.ventureIds.includes(id));
    setBusy(true); setError("");
    try {
      let saved: ChannelAccount;
      if (!account) {
        const input = channelAccountInputSchema.safeParse({ kind: "linkedin", label: form.label.trim(), ventureIds: form.ventureIds, defaultFor: defaults, enabled: true, settings: settings.data });
        if (!input.success) { setError(firstProblem(input.error, LABELS)); setBusy(false); return; }
        saved = await createChannelAccount(input.data);
        toast({ title: "LinkedIn profile saved", body: saved.label });
      } else {
        const change: ChannelAccountUpdate = {};
        if (form.label.trim() !== account.label) change.label = form.label.trim();
        if (!sameSet(form.ventureIds, account.ventureIds)) change.ventureIds = form.ventureIds;
        if (!sameSet(defaults, account.defaultFor)) change.defaultFor = defaults;
        if (settings.data.profileUrl !== current?.profileUrl || (settings.data.name ?? "") !== (current?.name ?? "")) change.settings = settings.data;
        if (!Object.keys(change).length) { onClose(); return; }
        saved = await updateChannelAccount(account.id, change);
        toast({ title: "LinkedIn profile updated", body: saved.label });
      }
      onSaved(saved);
    } catch (cause) { setError(describeError(cause, "Could not save the profile. Try again.")); }
    finally { setBusy(false); }
  }

  return <DetailDrawer title={account ? `Edit ${account.label}` : "Add a LinkedIn profile"} subtitle="You send LinkedIn messages by hand. The app opens the lead's profile, copies the message and counts what you mark sent." dirty={dirty} onClose={onClose}>
    <form onSubmit={submit} noValidate className="space-y-5" autoComplete="off">
      <TextField id="li-profile" label="Your profile link" inputMode="url" autoCapitalize="off" spellCheck={false} maxLength={300} required value={form.profileUrl} onChange={(event) => set("profileUrl", event.target.value)} placeholder="https://www.linkedin.com/in/your-name" hint="Open your LinkedIn profile and copy the address from the browser." />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="li-name" label="Name on the profile" maxLength={120} value={form.name} onChange={(event) => set("name", event.target.value)} />
        <TextField id="li-label" label="Name for this profile" maxLength={120} required value={form.label} onChange={(event) => set("label", event.target.value)} hint="Shown when you mark a LinkedIn message sent." />
      </div>
      <VentureChoice choices={choices} ventureIds={form.ventureIds} defaultFor={form.defaultFor} noun="LinkedIn profile" onChange={(next) => setForm((now) => ({ ...now, ...next }))} />
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} idle={account ? "Save changes" : "Save profile"} /></button><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button></div>
      <p className={hintClass}>No password and no automation: the app never signs in to LinkedIn or sends anything for you.</p>
    </form>
  </DetailDrawer>;
}
