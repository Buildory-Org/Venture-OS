"use client";
import { useState } from "react";
import { channelAccountInputSchema, instagramAccountSettingsSchema, whatsappAccountSettingsSchema, type ChannelAccount } from "@venture-studio/contracts";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createChannelAccount, updateChannelAccount, type ChannelAccountUpdate } from "@/lib/sales-channels-api";
import { instagramSettingsOf, whatsappSettingsOf } from "./channel-model";
import { firstProblem, hintClass, HowToConnect, SecretField, TextField, VentureChoice } from "./channel-form-parts";

// Add or change a venture's WhatsApp Business number or Instagram professional account (Meta). A venture head (of every venture it serves)
// or an admin connects it; everyone selling for those ventures sends through it. Meta's own field names are kept, each with where to find it.

type Kind = "whatsapp" | "instagram";
const LABELS: Record<string, string> = {
  label: "The name for this account", phoneNumberId: "Phone number id", businessAccountId: "WhatsApp Business account id", instagramAccountId: "Instagram account id",
  accessToken: "Access token", appSecret: "App secret", ventureIds: "Ventures",
};
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));

export function MetaAccountForm({ kind, account, choices, initialVentures, initialDefaults, ventureName, onClose, onSaved }: {
  kind: Kind; account?: ChannelAccount; choices: { id: string; name: string }[]; initialVentures: string[]; initialDefaults: string[]; ventureName: (id: string) => string; onClose: () => void; onSaved: (account: ChannelAccount) => void;
}) {
  const whatsapp = account ? whatsappSettingsOf(account) : null;
  const instagram = account ? instagramSettingsOf(account) : null;
  const noun = kind === "whatsapp" ? "WhatsApp number" : "Instagram account";
  const suggested = (ventureIds: string[]) => ventureIds.length === 1 ? `${ventureName(ventureIds[0]!)} ${kind === "whatsapp" ? "WhatsApp" : "Instagram"}` : kind === "whatsapp" ? "WhatsApp number" : "Instagram account";
  // The starting values are taken once, when the form opens.
  const [initial] = useState(() => ({
    label: account?.label ?? suggested(initialVentures), phoneNumberId: whatsapp?.phoneNumberId ?? "", businessAccountId: whatsapp?.businessAccountId ?? "", instagramAccountId: instagram?.instagramAccountId ?? "",
    ventureIds: account?.ventureIds ?? initialVentures, defaultFor: account?.defaultFor ?? initialDefaults,
  }));
  const [form, setForm] = useState(initial);
  const [labelTouched, setLabelTouched] = useState(Boolean(account));
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => { setForm((now) => ({ ...now, [key]: value })); if (error) setError(""); };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || Boolean(token || secret);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const ids = kind === "whatsapp" ? whatsappAccountSettingsSchema.safeParse({ phoneNumberId: form.phoneNumberId, businessAccountId: form.businessAccountId }) : instagramAccountSettingsSchema.safeParse({ instagramAccountId: form.instagramAccountId });
    if (!ids.success) { setError(firstProblem(ids.error, LABELS)); return; }
    if (!form.ventureIds.length) { setError("Pick at least one venture it is for."); return; }
    const defaults = form.defaultFor.filter((id) => form.ventureIds.includes(id));
    setBusy(true); setError("");
    try {
      let saved: ChannelAccount;
      if (!account) {
        if (!token.trim() || !secret.trim()) { setError(!token.trim() ? "Paste the access token." : "Paste the app secret."); setBusy(false); return; }
        const input = channelAccountInputSchema.safeParse({ kind, label: form.label.trim(), ventureIds: form.ventureIds, defaultFor: defaults, enabled: true, settings: ids.data, secrets: { accessToken: token, appSecret: secret } });
        if (!input.success) { setError(firstProblem(input.error, LABELS)); setBusy(false); return; }
        saved = await createChannelAccount(input.data);
        toast({ title: `${kind === "whatsapp" ? "WhatsApp number" : "Instagram account"} saved`, body: `${saved.label}. Press Test, then paste the webhook details into the Meta app.` });
      } else {
        const change: ChannelAccountUpdate = {};
        if (form.label.trim() !== account.label) change.label = form.label.trim();
        if (!sameSet(form.ventureIds, account.ventureIds)) change.ventureIds = form.ventureIds;
        if (!sameSet(defaults, account.defaultFor)) change.defaultFor = defaults;
        // A changed id makes the number or username Meta reported stale: it comes back with the next test.
        if (kind === "whatsapp" && (form.phoneNumberId.trim() !== whatsapp?.phoneNumberId || form.businessAccountId.trim() !== whatsapp?.businessAccountId)) change.settings = ids.data;
        if (kind === "instagram" && form.instagramAccountId.trim() !== instagram?.instagramAccountId) change.settings = ids.data;
        if (token.trim() || secret.trim()) change.secrets = { ...(token.trim() ? { accessToken: token } : {}), ...(secret.trim() ? { appSecret: secret } : {}) };
        if (!Object.keys(change).length) { onClose(); return; }
        saved = await updateChannelAccount(account.id, change);
        toast({ title: `${saved.label} updated`, body: change.settings || change.secrets ? "Test it again: the change needs a new check." : "Saved." });
      }
      setToken(""); setSecret("");
      onSaved(saved);
    } catch (cause) { setError(describeError(cause, "Could not save it. Try again.")); }
    finally { setBusy(false); }
  }

  return <DetailDrawer title={account ? `Edit ${account.label}` : kind === "whatsapp" ? "Add a WhatsApp number" : "Add an Instagram account"} subtitle={kind === "whatsapp" ? "The venture's WhatsApp Business number. Everyone selling for the venture sends through it, to leads who said yes to WhatsApp." : "The venture's professional Instagram account. The app answers people who wrote to it in the last 24 hours."} dirty={dirty} onClose={onClose}>
    <form onSubmit={submit} noValidate className="space-y-5" autoComplete="off">
      <HowToConnect kind={kind} defaultOpen={!account} />
      {kind === "whatsapp" ? <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="wa-phone-id" label="Phone number id" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={30} value={form.phoneNumberId} onChange={(event) => set("phoneNumberId", event.target.value.trim())} hint="Meta app > WhatsApp > API setup, under the phone number. Not the phone number itself." />
        <TextField id="wa-business-id" label="WhatsApp Business account id" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={30} value={form.businessAccountId} onChange={(event) => set("businessAccountId", event.target.value.trim())} hint="Same page, above the phone number id." />
      </div> : <TextField id="ig-account-id" label="Instagram account id" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={30} value={form.instagramAccountId} onChange={(event) => set("instagramAccountId", event.target.value.trim())} hint="Meta app > Instagram > API setup with Instagram login, next to the connected account." />}
      <SecretField id={`${kind}-token`} label="Access token" saved={account?.secrets.accessToken} value={token} onChange={(value) => { setToken(value); if (error) setError(""); }} hint={kind === "whatsapp" ? "A permanent token from a system user (Business settings > System users > Generate new token)." : "The long-lived token generated on the same setup page."} />
      <SecretField id={`${kind}-secret`} label="App secret" saved={account?.secrets.appSecret} value={secret} onChange={(value) => { setSecret(value); if (error) setError(""); }} hint={kind === "whatsapp" ? "Meta app > App settings > Basic > App secret. It proves messages really come from Meta." : "The Instagram app secret on the same setup page. It proves messages really come from Meta."} />
      <TextField id={`${kind}-label`} label="Name for this account" maxLength={120} required value={form.label} onChange={(event) => { setLabelTouched(true); set("label", event.target.value); }} hint="Shown to the team when they send and on new conversations." />
      <VentureChoice choices={choices} ventureIds={form.ventureIds} defaultFor={form.defaultFor} noun={noun} onChange={(next) => setForm((now) => ({ ...now, ...next, ...(!labelTouched && !account ? { label: suggested(next.ventureIds) } : {}) }))} />
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} idle={account ? "Save changes" : `Save ${kind === "whatsapp" ? "number" : "account"}`} /></button><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button></div>
      <p className={hintClass}>The token and app secret are stored encrypted and never shown again, not even to admins. The webhook details appear on the card once it is saved.</p>
    </form>
  </DetailDrawer>;
}
