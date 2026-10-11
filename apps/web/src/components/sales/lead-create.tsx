"use client";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { ContactRoute } from "@venture-studio/contracts";
import { ChevronDown } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { createLead } from "@/lib/sales-api";
import { createLivePipeline, listLivePipelines } from "@/lib/studio-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { isDialable, isManager, isPlainEmail } from "@/components/sales/sales-ui";
import { CHANNEL_LABEL, ChannelTile } from "@/components/sales/draft-shared";
import { offerIsUsable, sortOffers, useVentureOffers } from "@/components/sales/offer-model";

type Pipeline = Awaited<ReturnType<typeof listLivePipelines>>[number];

const INSTAGRAM = /^(@[A-Za-z0-9._]{1,30}|https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._]{1,30}\/?)$/i;
/** One box takes a phone number, an email address or an Instagram @handle: a leading @ (or an instagram.com link) is Instagram, an @ inside is an email. Null when something is none of them. */
function routesOf(values: string[]): ContactRoute[] | null {
  const routes: ContactRoute[] = [];
  for (const raw of values.map((value) => value.trim()).filter(Boolean)) {
    if (INSTAGRAM.test(raw)) routes.push({ kind: "instagram", value: raw, publishedByCompany: true });
    else if (raw.includes("@")) { if (!isPlainEmail(raw)) return null; routes.push({ kind: "email", value: raw, publishedByCompany: true }); }
    else { if (!isDialable(raw)) return null; routes.push({ kind: "phone", value: raw, publishedByCompany: true }); }
  }
  return routes;
}

/**
 * What a new lead starts with when it comes from somewhere else (a new WhatsApp or Instagram conversation): the ventures it may go to (one
 * fixes the destination, several are the choices), the contact's name, the routes they wrote from and where it came from.
 */
export type LeadPrefill = { ventureIds?: string[]; contactName?: string; routes?: ContactRoute[]; source?: string };

/** Add one lead by hand. Inside a venture the destination is fixed and shown; in All ventures it asks. */
export function LeadCreate({ prefill, onClose, onCreated }: { prefill?: LeadPrefill; onClose: () => void; onCreated: (leadId: string) => void }) {
  const { session, ventureId: shellVentureId, ventureName, refresh } = useSalesShell();
  const allowed = prefill?.ventureIds?.length ? prefill.ventureIds : null;
  const ventures = useMemo(() => (session?.hierarchy.ventures ?? []).filter((venture) => (session?.membership.role === "admin" || session?.membership.ventureIds.includes(venture.id)) && (!allowed || allowed.includes(venture.id))), [session, allowed]);
  // A prefill with one venture fixes it; with several, the venture picked in the sidebar is used when it is one of them, else the person picks.
  const ventureId = allowed ? (allowed.length === 1 ? allowed[0]! : allowed.includes(shellVentureId) ? shellVentureId : "") : shellVentureId;
  const fixedRoutes = prefill?.routes ?? [];
  const [pickedVenture, setPickedVenture] = useState("");
  const destination = ventureId || pickedVenture;
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [pipelineId, setPipelineId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [company, setCompany] = useState("");
  const [contact, setContact] = useState(prefill?.contactName ?? "");
  const [city, setCity] = useState("");
  const [reach, setReach] = useState("");
  const [reachMore, setReachMore] = useState("");
  const [more, setMore] = useState(Boolean(prefill?.contactName));
  const [website, setWebsite] = useState("");
  const [signal, setSignal] = useState("");
  const [source, setSource] = useState(prefill?.source ?? "");
  const [pipelineName, setPipelineName] = useState("");
  const [offerName, setOfferName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [offerPick, setOfferPick] = useState("");

  useEffect(() => {
    let active = true;
    listLivePipelines().then((all) => { if (active) { setPipelines(all); setLoadError(""); } })
      .catch((cause: unknown) => { if (active) setLoadError(describeError(cause, "Could not load the pipelines.")); });
    return () => { active = false; };
  }, [attempt]);

  const options = (pipelines ?? []).filter((pipeline) => pipeline.ventureId === destination && pipeline.status !== "archived");
  const chosen = options.find((pipeline) => pipeline.id === pipelineId) ?? options[0];
  const canMakePipeline = !!session && !!destination && isManager(session, destination);
  // With several offers the person picks one (or decides later); with one usable offer the server gives the lead that one.
  const offers = sortOffers((useVentureOffers(destination || undefined) ?? []).filter((offer) => offer.state !== "archived"));
  const usable = offers.filter(offerIsUsable);
  const offerId = offers.some((offer) => offer.id === offerPick) ? offerPick : "";
  const dirty = !!(company || contact !== (prefill?.contactName ?? "") || city || reach || reachMore || website || signal || source !== (prefill?.source ?? ""));

  async function addPipeline(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { const created = await createLivePipeline({ ventureId: destination, name: pipelineName.trim(), offerName: offerName.trim(), status: "active" }); setPipelines((current) => [...(current ?? []), created]); setPipelineId(created.id); setPipelineName(""); setOfferName(""); }
    catch (cause) { setError(describeError(cause, "Could not create the pipeline.")); }
    finally { setBusy(false); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !chosen) return;
    const typed = routesOf([reach, reachMore]);
    if (!typed) { setError("Use one phone number, one email address or one Instagram @handle in each contact box."); if (reachMore.trim() && !routesOf([reachMore])) setMore(true); return; }
    const routes = [...fixedRoutes, ...typed];
    setBusy(true); setError("");
    try {
      const lead = await createLead({
        pipelineId: chosen.id, companyName: company.trim(), contactName: contact.trim(), ownerId: session.user.id, stage: "identified",
        ...(city.trim() ? { city: city.trim() } : {}), ...(website.trim() ? { website: website.trim() } : {}), ...(source.trim() ? { source: source.trim() } : {}),
        ...(signal.trim() ? { observedSignal: signal.trim() } : {}), ...(offerId ? { offerId } : {}), contactRoutes: routes,
      });
      toast(lead.doNotContact
        ? { tone: "info", title: "Lead added, but do not contact", body: `${lead.companyName} is on the do-not-contact list, so every contact route is off.` }
        : { title: "Lead added", body: lead.companyName });
      refresh(); onCreated(lead.id);
    } catch (cause) { setError(describeError(cause, "Could not add the lead.")); setBusy(false); }
  }

  return <DetailDrawer title="Add a lead" subtitle="You will own it. It starts as Identified." onClose={onClose} dirty={dirty}>
    <form onSubmit={save} className="grid grid-cols-1 gap-4">
      {ventureId
        ? <div aria-label="Lead destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Destination venture · {allowed ? "the venture they wrote to" : "fixed to the current venture"}</span><span className="mt-1 block text-sm font-bold text-neutral-800">{ventureName(ventureId)}</span></div>
        : <Field label="Venture"><Select required aria-label="Venture" className={inputClass} value={pickedVenture} onChange={(event) => { setPickedVenture(event.target.value); setPipelineId(""); }}><option value="">Choose a venture</option>{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}

      {loadError && !pipelines && <Notice tone="error" message={loadError} />}
      {destination && pipelines && options.length > 1 && <Field label="Pipeline"><Select aria-label="Pipeline" className={inputClass} value={chosen?.id ?? ""} onChange={(event) => setPipelineId(event.target.value)}>{options.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name} · {pipeline.offerName}</option>)}</Select></Field>}
      {destination && pipelines && options.length === 0 && (canMakePipeline
        ? <div className="grid grid-cols-1 gap-3 rounded-xl border border-dashed border-neutral-300 p-3"><p className="text-sm font-semibold text-neutral-800">{ventureName(destination)} has no pipeline yet. Create the first one.</p><Field label="Pipeline name"><input maxLength={120} className={inputClass} value={pipelineName} onChange={(event) => setPipelineName(event.target.value)} placeholder="Dealer commerce" /></Field><Field label="What you sell"><input maxLength={200} className={inputClass} value={offerName} onChange={(event) => setOfferName(event.target.value)} placeholder="Dealer ordering setup" /></Field><button type="button" disabled={busy || !pipelineName.trim() || !offerName.trim()} onClick={addPipeline} className={primaryClass}><ActionLabel busy={busy} busyText="Creating…" idle="Create pipeline" /></button></div>
        : <p className="rounded-xl bg-warning-surface p-3 text-sm font-semibold text-warning-text">{ventureName(destination)} has no pipeline yet. A venture head or the owner can set one up.</p>)}

      {destination && offers.length > 1 && <Field label="For which offer?"><Select aria-label="Offer" className={inputClass} value={offerId} onChange={(event) => setOfferPick(event.target.value)}><option value="">{usable.length === 1 ? `${usable[0]!.name} (the only active one)` : "Decide later"}</option>{offers.map((offer) => <option key={offer.id} value={offer.id}>{offer.name}{offerIsUsable(offer) ? "" : offer.approved ? " · paused" : " · draft"}</option>)}</Select></Field>}

      <Field label="Company"><input required maxLength={200} className={inputClass} value={company} onChange={(event) => setCompany(event.target.value)} autoFocus /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Website"><input maxLength={500} className={inputClass} value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="example.com" /></Field>
        <Field label="City"><input maxLength={120} className={inputClass} value={city} onChange={(event) => setCity(event.target.value)} /></Field>
      </div>
      {fixedRoutes.length > 0 && <div aria-label="From the conversation" className="grid gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="text-xs font-semibold text-neutral-500">From the conversation · saved on the lead</span>{fixedRoutes.map((route) => <span key={`${route.kind}-${route.value}`} className="flex min-w-0 items-center gap-2 text-sm font-semibold text-neutral-800"><ChannelTile channel={route.kind} size={28} /><span className="min-w-0 [overflow-wrap:anywhere]">{route.value}</span><span className="text-xs font-medium text-neutral-500">{CHANNEL_LABEL[route.kind] ?? route.kind}</span></span>)}</div>}
      <Field label={fixedRoutes.length ? "Phone, email or Instagram (optional)" : "Phone, email or Instagram"}><input maxLength={320} inputMode="email" autoComplete="off" className={inputClass} value={reach} onChange={(event) => setReach(event.target.value)} placeholder="A published business number, email or @handle" /></Field>

      <div>
        <button type="button" aria-expanded={more} aria-controls="lead-more-details" onClick={() => setMore(!more)} className="-ml-2 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]">
          <ChevronDown size={15} className={clsx("transition-transform duration-200", more && "rotate-180")} />{more ? "Fewer details" : "More details"}
        </button>
        <div id="lead-more-details" data-open={more} className="vso-collapse"><div>
          <div inert={!more} className="-mx-1 grid grid-cols-1 gap-4 px-1 pb-1 pt-2">
            <Field label="Contact person"><input maxLength={200} className={inputClass} value={contact} onChange={(event) => setContact(event.target.value)} /></Field>
            <Field label="Another phone, email or Instagram"><input maxLength={320} autoComplete="off" className={inputClass} value={reachMore} onChange={(event) => setReachMore(event.target.value)} placeholder="Optional" /></Field>
            <Field label="What we saw"><textarea maxLength={2000} rows={3} className={`${inputClass} py-2.5`} value={signal} onChange={(event) => setSignal(event.target.value)} placeholder="The line or fact that made this company worth a look." /></Field>
            <Field label="Where it came from"><input maxLength={500} className={inputClass} value={source} onChange={(event) => setSource(event.target.value)} placeholder="Link or note" /></Field>
          </div>
        </div></div>
      </div>
      <p className="text-xs leading-5 text-neutral-500">{fixedRoutes.length ? "They wrote to the venture first, so the number or handle they wrote from is kept. Anything else: " : ""}Use business contact details the company published. Nothing is sent from here.</p>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <button disabled={busy || !chosen || !company.trim()} className={primaryClass}><ActionLabel busy={busy} busyText="Adding…" idle="Add lead" /></button>
    </form>
    {loadError && !pipelines && <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-3 text-xs font-semibold text-primary-700">Try again</button>}
  </DetailDrawer>;
}
