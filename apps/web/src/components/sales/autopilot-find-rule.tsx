"use client";
import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { CircleAlert } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { saveAutopilot, type AutopilotStatus } from "@/lib/sales-autopilot-api";
import { ActionLabel, Badge, inputClass, Notice, Panel, primaryClass } from "@/components/studio/primitives";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { ChipsField } from "./chips-field";
import { offerHref, offerIsUsable, sortOffers, useVentureOffers } from "./offer-model";
import { autopilotSettingsHref, sentence } from "./autopilot-strip";
import { useSalesShell } from "./sales-context";

// The standing find rule on Find leads (docs/sales-autopilot.md §2 `find`): each working day, the app looks for up to N new companies for
// one offer, as the person the autopilot works as. Heads and admins change it; everyone else reads it. It runs only while the venture's
// autopilot is on.

type Find = AutopilotStatus["settings"]["find"];

function RuleSkeleton() {
  return <Panel className="mb-4 space-y-3 p-4 sm:p-5"><div role="status" aria-label="Loading the daily search" className="space-y-3"><span className="vso-skeleton block h-4 w-40" /><span className="vso-skeleton block h-11 w-full rounded-xl" /><span className="vso-skeleton block h-11 w-2/3 rounded-xl" /></div></Panel>;
}

/** The daily search card. Hidden without a venture or on a server without the autopilot. */
export function AutopilotFindRule({ status, loading, onSaved }: { status: AutopilotStatus | null; loading: boolean; onSaved: (next: AutopilotStatus) => void }) {
  const { ventureId } = useSalesShell();
  if (!ventureId) return null;
  if (loading) return <RuleSkeleton />;
  if (!status) return null;
  // A fresh form after each save (the saved rule comes back in the status).
  return <RuleForm key={JSON.stringify(status.settings.find)} ventureId={ventureId} status={status} onSaved={onSaved} />;
}

function RuleForm({ ventureId, status, onSaved }: { ventureId: string; status: AutopilotStatus; onSaved: (next: AutopilotStatus) => void }) {
  const { refreshKey } = useSalesShell();
  const saved = status.settings.find;
  const [enabled, setEnabled] = useState(saved.enabled);
  const [perDay, setPerDay] = useState(String(saved.perDay));
  const [offerPick, setOfferPick] = useState(saved.offerId ?? "");
  const [request, setRequest] = useState(saved.request);
  const [places, setPlaces] = useState<string[]>(saved.places);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const offers = useVentureOffers(ventureId, refreshKey);
  const usable = sortOffers((offers ?? []).filter(offerIsUsable));
  // The only usable offer is picked for the person; a saved offer that is no longer usable still shows, so the rule reads true.
  const offerId = offerPick || (usable.length === 1 ? usable[0]!.id : "");
  const offerName = (offers ?? []).find((offer) => offer.id === offerId)?.name;
  const edit = status.canChange;
  const count = Number(perDay);
  const next: Find = { enabled, perDay: count, request: request.trim(), places, ...(offerId ? { offerId } : {}) };
  const dirty = enabled !== saved.enabled || count !== saved.perDay || (offerId || undefined) !== saved.offerId || request.trim() !== saved.request || places.join("\n") !== saved.places.join("\n");
  const findBlockers = [...new Map(status.blockers.filter((blocker) => blocker.step === "find" || !blocker.step).map((blocker) => [blocker.text, blocker])).values()];

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!Number.isInteger(count) || count < 1 || count > 50) { setError("Up to how many a day: a whole number from 1 to 50."); return; }
    if (enabled && !offerId) { setError("Pick the offer to search for."); return; }
    setBusy(true); setError("");
    try {
      const result = await saveAutopilot(ventureId, { ...status.settings, find: next });
      toast({ title: enabled ? "Daily search saved" : "Daily search off", body: enabled ? (status.settings.enabled ? "It runs on the next working day." : "It runs once the venture's autopilot is on.") : "The app won't look for new companies by itself." });
      onSaved(result);
    } catch (cause) { setError(describeError(cause, "Could not save the daily search. Try again.")); }
    finally { setBusy(false); }
  }

  const where = saved.places.length ? `, in ${sentence(saved.places)}` : "";
  const readLine = `Find up to ${saved.perDay} new ${saved.perDay === 1 ? "company" : "companies"} a day${offerName ? ` for ${offerName}` : ""}${saved.request ? ` — ${saved.request}` : ""}${where}.`;
  const inline = "inline-flex min-h-10 items-center rounded-xl border border-neutral-200 bg-white px-3 text-sm font-semibold text-neutral-800 outline-none transition-[border-color,box-shadow] duration-150 focus:border-primary-400 focus:ring-2 focus:ring-primary-100";

  return <Panel className="mb-4 p-4 sm:p-5">
    <form onSubmit={save} aria-labelledby="find-rule-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="find-rule-title" className="text-[15px] font-extrabold tracking-[-.01em] text-neutral-900">Every working day</h2>
          <p className="mt-1 text-xs leading-5 text-neutral-500">The app looks for new companies by itself, judges each one and writes to the good ones. They show up in Review.</p>
        </div>
        {edit
          ? <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-[13px] font-semibold text-neutral-700"><span>{enabled ? "On" : "Off"}</span><input type="checkbox" role="switch" aria-label="Run the daily search" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="vso-toggle" /></label>
          : <Badge tone={saved.enabled ? "green" : "neutral"}>{saved.enabled ? "On" : "Off"}</Badge>}
      </div>

      {edit ? <div className={clsx("mt-4 space-y-4 transition-opacity duration-150", !enabled && "opacity-60")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm font-medium leading-10 text-neutral-700">
          <span>Find up to</span>
          <input type="number" inputMode="numeric" min={1} max={50} aria-label="Companies a day" value={perDay} onChange={(event) => setPerDay(event.target.value)} className={clsx(inline, "w-20 tnum")} />
          <span>new companies a day for</span>
          {offers === null ? <span className="vso-skeleton inline-block h-10 w-44 rounded-xl" />
            : usable.length > 1 || (offerId && !usable.some((offer) => offer.id === offerId))
              ? <Select aria-label="Offer" className={clsx(inputClass, "!w-auto min-w-44 max-w-full")} value={offerId} onChange={(event) => setOfferPick(event.target.value)}><option value="">Pick an offer</option>{usable.map((offer) => <option key={offer.id} value={offer.id}>{offer.name}</option>)}{offerId && !usable.some((offer) => offer.id === offerId) && <option value={offerId}>{offerName ?? "An offer that is no longer active"}</option>}</Select>
              : usable.length === 1 ? <b className="font-bold text-neutral-900 [overflow-wrap:anywhere]">{usable[0]!.name}</b>
                : <span className="text-xs leading-5 text-neutral-500">no approved offer yet. <WorkspaceLink href={offerHref(ventureId)} className="font-semibold text-primary-700 hover:underline">Set one up in Offers</WorkspaceLink></span>}
        </div>
        <div>
          <label htmlFor="find-rule-request" className="mb-1.5 block text-xs font-semibold text-neutral-600">Who, in a few words <span className="font-normal text-neutral-400">· optional, the offer already says who it is for</span></label>
          <input id="find-rule-request" maxLength={500} value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Hardware dealers that sell pumps" className={inputClass} />
        </div>
        <ChipsField label="In" hint="cities or states, optional" placeholder="Raipur, Indore, Madhya Pradesh" items={places} onChange={setPlaces} max={30} maxLength={120} />
      </div>
        : <p className="mt-3 text-sm font-semibold leading-6 text-neutral-800 [overflow-wrap:anywhere]">{readLine}</p>}

      {!status.settings.enabled && <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-neutral-50 px-3 py-2.5 text-xs leading-5 text-neutral-600"><span>The rule runs only while the venture&apos;s autopilot is on, and it is off.</span><Link href={autopilotSettingsHref(ventureId)} className="font-semibold text-primary-700 hover:underline">Sales settings</Link></p>}
      {status.settings.enabled && saved.enabled && findBlockers.map((blocker) => <p key={blocker.text} className="mt-3 flex items-start gap-1.5 rounded-xl bg-warning-surface px-3 py-2.5 text-xs font-medium leading-5 text-warning-text"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />{blocker.text}</p>)}

      {edit && <>
        <Notice tone="error" message={error} onDismiss={() => setError("")} className="pt-4" />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy || !dirty} className={primaryClass}><ActionLabel busy={busy} idle="Save" /></button>
          {!dirty && <span className="text-xs text-neutral-500">{saved.enabled ? "Saved. Companies already in Dealflow and anyone on the do-not-contact list are skipped." : "Switch it on, then save."}</span>}
        </div>
      </>}
      {!edit && <p className="mt-3 text-xs text-neutral-500">A venture head or admin changes the daily search.</p>}
    </form>
  </Panel>;
}
