"use client";
import { useState } from "react";
import clsx from "clsx";
import type { ChannelAccount, ChannelKind } from "@venture-studio/contracts";
import { ChevronDown, Plus, Users, type Icon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, secondaryClass } from "@/components/studio/primitives";
import { useStudio } from "@/lib/studio-store";
import { isRouteMissing, listChannelAccounts } from "@/lib/sales-channels-api";
import { canHead, useSalesLoad, writableVentures } from "@/components/sales/draft-shared";
import { Plug } from "@/components/sales/lead-icons";
import { ChannelCard } from "@/components/sales/channel-card";
import { EmailAccountForm } from "@/components/sales/channel-email-form";
import { LinkedinAccountForm } from "@/components/sales/channel-linkedin-form";
import { MetaAccountForm } from "@/components/sales/channel-meta-form";
import { isPersonalKind, KIND_NAME } from "@/components/sales/channel-model";
import { useSalesShell } from "@/components/sales/sales-context";
import { FilterChip } from "@/components/sales/sales-ui";

type Loaded = { available: boolean; accounts: ChannelAccount[] };
type Editing = { kind: ChannelKind; account?: ChannelAccount; ventureIds: string[]; defaultFor: string[] };
const byUse = (a: ChannelAccount, b: ChannelAccount) => Number(b.enabled) - Number(a.enabled) || b.defaultFor.length - a.defaultFor.length || a.label.localeCompare(b.label);

/**
 * Sales > Channels (route /sales/live/channels): the accounts Sales sends and receives through. "My connections" holds the person's own
 * mailboxes and LinkedIn profiles; "Venture numbers and accounts" holds each venture's WhatsApp number and Instagram account, which a
 * venture head connects and the whole venture sends through. The venture picked at the top (the same one as the sidebar's) filters both.
 */
export function ChannelsScreen() {
  const { session, ventureId, ventureName } = useSalesShell();
  const { setActiveVentureId } = useStudio();
  const load = useSalesLoad<Loaded>("sales-channels", async () => {
    try { return { available: true, accounts: await listChannelAccounts() }; }
    catch (cause) { if (isRouteMissing(cause)) return { available: false, accounts: [] }; throw cause; }
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const userId = session?.user.id ?? "";
  const myVentures = session ? session.hierarchy.ventures.filter((venture) => session.membership.role === "admin" || session.membership.ventureIds.includes(venture.id)) : [];
  // A mailbox or LinkedIn profile can serve the ventures the person writes in; a WhatsApp number or Instagram account those they head.
  const personalChoices = writableVentures(session).map(({ id, name }) => ({ id, name }));
  const ventureChoices = myVentures.filter((venture) => canHead(session, venture.id)).map(({ id, name }) => ({ id, name }));
  const shown = (account: ChannelAccount) => !ventureId || account.ventureIds.includes(ventureId);
  const accounts = (load.data?.accounts ?? []).filter(shown).sort(byUse);
  const mine = (kind: ChannelKind) => accounts.filter((account) => account.kind === kind && account.ownerUserId === userId);
  const team = accounts.filter((account) => isPersonalKind(account.kind) && account.ownerUserId !== userId);
  const shared = (kind: ChannelKind) => accounts.filter((account) => account.kind === kind);

  function openAdd(kind: ChannelKind) {
    const choices = isPersonalKind(kind) ? personalChoices : ventureChoices;
    const start = ventureId && choices.some((venture) => venture.id === ventureId) ? [ventureId] : choices.length === 1 ? [choices[0]!.id] : [];
    // The first account of its kind in a venture becomes its default there.
    const scope = (load.data?.accounts ?? []).filter((account) => account.kind === kind && (!isPersonalKind(kind) || account.ownerUserId === userId));
    setEditing({ kind, ventureIds: start, defaultFor: start.filter((id) => !scope.some((account) => account.defaultFor.includes(id))) });
  }
  const openEdit = (account: ChannelAccount) => setEditing({ kind: account.kind, account, ventureIds: account.ventureIds, defaultFor: account.defaultFor });
  const saved = () => { setEditing(null); load.reload(); };

  const filterRow = myVentures.length > 1 && <div role="group" aria-label="Venture" className="mb-4 flex flex-wrap items-center gap-2">
    <FilterChip active={!ventureId} onClick={() => setActiveVentureId("")}>All ventures</FilterChip>
    {myVentures.map((venture) => <FilterChip key={venture.id} active={ventureId === venture.id} onClick={() => setActiveVentureId(venture.id)}>{venture.name}</FilterChip>)}
  </div>;

  if (load.error && !load.data) return <>{filterRow}<Panel><EmptyState variant="error" title="Could not read the connections" body={load.error} action={{ label: load.busy ? "Trying again…" : "Try again", onClick: load.reload, disabled: load.busy }} /></Panel></>;
  if (!load.data) return <>{filterRow}<div role="status" aria-label="Loading the connections" className="space-y-4">{[0, 1].map((index) => <Panel key={index} className="space-y-3 p-5"><span className="vso-skeleton block h-5 w-48" /><span className="vso-skeleton block h-3 w-2/3" /><div className="grid items-start gap-3 lg:grid-cols-2"><span className="vso-skeleton block h-36 rounded-2xl" /><span className="vso-skeleton block h-36 rounded-2xl max-lg:hidden" /></div></Panel>)}</div></>;
  if (!load.data.available) return <Panel><EmptyState variant="card" tone="blue" icon={Plug} title="Channels aren't on this server yet" body="Once the server is updated, you connect your mailbox and the venture's WhatsApp here and send drafts with one click. Until then, send from your own mail app or phone and mark drafts sent in Review." action={{ label: "Open Review", href: "/sales/live/review" }} /></Panel>;

  const forVenture = ventureId ? ` for ${ventureName(ventureId)}` : "";
  const learner = personalChoices.length === 0;
  return <>
    {filterRow}
    <Panel className="p-4 sm:p-5">
      <SectionHead icon={Plug} title="My connections" line="Your own work mailbox and LinkedIn profile. You send as yourself, and only you can use them." />
      <KindGroup kind="email" accounts={mine("email")} userId={userId} onAdd={learner ? undefined : () => openAdd("email")} onEdit={openEdit} onChanged={load.reload}
        empty={learner ? "Learners can read but not connect a mailbox." : `No mailbox${forVenture} yet. Connect your work email to send drafts with one click; replies from leads come back to the Inbox by themselves.`} />
      <KindGroup kind="linkedin" accounts={mine("linkedin")} userId={userId} onAdd={learner ? undefined : () => openAdd("linkedin")} onEdit={openEdit} onChanged={load.reload}
        empty="Optional. You send LinkedIn messages by hand; with your profile here, the app records which profile they went from." />
      {team.length > 0 && <div className="mt-5 border-t border-neutral-100 pt-4">
        <button type="button" aria-expanded={teamOpen} aria-controls="team-connections" onClick={() => setTeamOpen(!teamOpen)} className="flex min-h-10 w-full items-center gap-2 rounded-xl text-left text-[13px] font-bold text-neutral-800 transition-colors duration-150 hover:text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
          <span className="min-w-0 flex-1">Your team&apos;s mailboxes and profiles <span className="tnum ml-1 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">{team.length}</span></span><ChevronDown size={15} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", teamOpen && "rotate-180")} />
        </button>
        {teamOpen && <ul id="team-connections" className="vso-fade-enter mt-3 grid items-start gap-3 lg:grid-cols-2">{team.map((account) => <ChannelCard key={account.id} account={account} mine={false} onEdit={openEdit} onChanged={load.reload} />)}</ul>}
        {!teamOpen && <p className="mt-1 text-xs text-neutral-500">Who connected what, and whether it works. Never their passwords.</p>}
      </div>}
    </Panel>

    <Panel className="mt-4 p-4 sm:p-5">
      <SectionHead icon={Users} title="Venture numbers and accounts" line={ventureChoices.length ? "Each venture's WhatsApp number and Instagram account, shared by everyone who sells for it." : "Each venture's WhatsApp number and Instagram account, shared by everyone who sells for it. A venture head connects them."} />
      <KindGroup kind="whatsapp" accounts={shared("whatsapp")} userId={userId} onAdd={ventureChoices.length ? () => openAdd("whatsapp") : undefined} onEdit={openEdit} onChanged={load.reload}
        empty={ventureChoices.length ? `No WhatsApp number${forVenture} yet. Connect the venture's WhatsApp Business number to message leads who said yes to WhatsApp and get their replies here.` : `No WhatsApp number${forVenture} yet. A venture head connects it.`} />
      <KindGroup kind="instagram" accounts={shared("instagram")} userId={userId} onAdd={ventureChoices.length ? () => openAdd("instagram") : undefined} onEdit={openEdit} onChanged={load.reload}
        empty={ventureChoices.length ? "Optional. Connect the venture's Instagram account to answer people who write to it, from the Inbox." : `No Instagram account${forVenture} yet. A venture head connects it.`} />
    </Panel>

    {editing?.kind === "email" && <EmailAccountForm {...(editing.account ? { account: editing.account } : {})} choices={personalChoices} initialVentures={editing.ventureIds} initialDefaults={editing.defaultFor} userName={session?.user.name ?? ""} onClose={() => setEditing(null)} onSaved={saved} />}
    {editing?.kind === "linkedin" && <LinkedinAccountForm {...(editing.account ? { account: editing.account } : {})} choices={personalChoices} initialVentures={editing.ventureIds} initialDefaults={editing.defaultFor} userName={session?.user.name ?? ""} onClose={() => setEditing(null)} onSaved={saved} />}
    {(editing?.kind === "whatsapp" || editing?.kind === "instagram") && <MetaAccountForm kind={editing.kind} {...(editing.account ? { account: editing.account } : {})} choices={ventureChoices} initialVentures={editing.ventureIds} initialDefaults={editing.defaultFor} ventureName={ventureName} onClose={() => setEditing(null)} onSaved={saved} />}
  </>;
}

function SectionHead({ icon: HeadIcon, title, line }: { icon: Icon; title: string; line: string }) {
  return <div className="flex items-start gap-3">
    <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-50 text-primary-700"><HeadIcon size={15} /></span>
    <div className="min-w-0"><h2 className="text-base font-extrabold tracking-[-.01em] text-neutral-900">{title}</h2><p className="mt-0.5 max-w-2xl text-xs leading-5 text-neutral-500">{line}</p></div>
  </div>;
}

function KindGroup({ kind, accounts, userId, empty, onAdd, onEdit, onChanged }: { kind: ChannelKind; accounts: ChannelAccount[]; userId: string; empty: string; onAdd: (() => void) | undefined; onEdit: (account: ChannelAccount) => void; onChanged: () => void }) {
  const name = KIND_NAME[kind];
  return <section aria-label={name.many} className="mt-5">
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
      <h3 className="text-[13px] font-bold text-neutral-800">{name.many}{accounts.length > 0 && <span className="tnum ml-1.5 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">{accounts.length}</span>}</h3>
      {onAdd && <button type="button" onClick={onAdd} className={secondaryClass}><Plus size={15} aria-hidden="true" />{name.add}</button>}
    </div>
    {accounts.length
      ? <ul className="mt-2 grid items-start gap-3 lg:grid-cols-2">{accounts.map((account) => <ChannelCard key={account.id} account={account} mine={account.ownerUserId === userId} onEdit={onEdit} onChanged={onChanged} />)}</ul>
      : <p className="mt-2 rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-500">{empty}</p>}
  </section>;
}
