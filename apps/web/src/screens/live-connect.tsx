"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { PAT_READ_SCOPES, PAT_WRITE_SCOPES } from "@venture-studio/contracts";
import { Check, Copy, KeyRound } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Badge, Empty, Field, inputClass, Notice, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { createLivePat, listLivePats, revokeLivePat } from "@/lib/studio-api";

type Pat = Awaited<ReturnType<typeof listLivePats>>[number];
const READ = [...PAT_READ_SCOPES]; const UPDATE = [...PAT_READ_SCOPES, ...PAT_WRITE_SCOPES];
const date = (value?: string) => value ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value)) : "—";
const canUpdate = (pat: Pat) => pat.scopes.some((scope) => scope.endsWith(":write"));

/** A command or snippet with a copy button. */
function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return <div>
    <p className="mb-1.5 text-xs font-semibold text-neutral-600">{label}</p>
    <div className="flex items-start gap-2 rounded-xl bg-neutral-900 p-3 text-neutral-100">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-5">{text}</code>
      <button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }, () => toast({ tone: "error", title: "Copy failed", body: "Select the text and copy it yourself." })); }} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-300 transition-colors duration-150 hover:bg-white/10 hover:text-white">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
    </div>
  </div>;
}

/** Each person connects Claude Code (or another MCP client) with their own token; it sees exactly what they see in the app. */
export function LiveConnectScreen() {
  const [items, setItems] = useState<Pat[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("My laptop");
  const [access, setAccess] = useState<"read" | "update">("update");
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState("");
  const [revision, setRevision] = useState(0);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  useEffect(() => {
    let active = true;
    // Revoked and expired tokens no longer do anything, so only live ones are listed.
    listLivePats().then((value) => { const now = Date.now(); if (active) { setItems(value.filter((pat) => !pat.revokedAt && (!pat.expiresAt || new Date(pat.expiresAt).getTime() > now))); setError(""); } }, (cause: unknown) => { if (active) setError(describeError(cause, "Could not load your connections.")); });
    return () => { active = false; };
  }, [revision]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await createLivePat({ name: name.trim() || "Claude", scopes: access === "update" ? UPDATE : READ, expiresInDays: Number(days) });
      setCreated({ token: result.token, name: result.pat.name }); setRevision((value) => value + 1);
    } catch (cause) { setError(describeError(cause, "Could not create the token.")); }
    finally { setBusy(false); }
  }

  async function revoke(pat: Pat) {
    setRevoking(pat.id);
    try { await revokeLivePat(pat.id); toast({ title: `${pat.name} disconnected`, body: "That token stopped working immediately." }); setRevision((value) => value + 1); }
    catch (cause) { toast({ tone: "error", title: "Could not revoke", body: describeError(cause, "Try again.") }); }
    finally { setRevoking(""); }
  }

  const active = items ?? [];
  const command = created ? `claude mcp add --transport http venture-studio ${origin}/mcp --header "Authorization: Bearer ${created.token}"` : "";

  return <PageFrame>
    <PageTitle title="Connect Claude" description="Let Claude Code read your tasks, reviews, and knowledge, and make small updates when you ask. It sees exactly what you see here." />
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="pb-4" />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Panel>
        <PanelHead title={created ? "Your token is ready" : "New connection"} />
        {created ? <div className="space-y-4 p-5">
          <p className="rounded-xl bg-warning-surface p-3 text-sm leading-6 text-warning-text">Copy it now: this token is shown only once. Anyone with it can act as you through Claude, so don&apos;t share or commit it.</p>
          <Snippet label="1. Run this in a terminal" text={command} />
          <Snippet label="2. Optional: check every hour in Claude Code" text="/loop 1h Use the venture-studio whats_new tool with the cursor from last time. Tell me only if something changed." />
          <p className="text-xs leading-5 text-neutral-500">Try asking Claude: &ldquo;What&apos;s on my plate today?&rdquo; or run <span className="font-mono">/mcp__venture-studio__today</span>. In Claude Desktop, a scheduled task with the same hourly prompt shows a desktop notification.</p>
          <button type="button" onClick={() => { setCreated(null); setName("My laptop"); }} className={secondaryClass}>Done</button>
        </div> : <form onSubmit={create} className="space-y-4 p-5">
          <Field label="Name"><input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} className={inputClass} placeholder="Work laptop" /></Field>
          <fieldset><legend className="mb-1.5 text-xs font-semibold text-neutral-600">Access</legend><div className="grid gap-2 sm:grid-cols-2">
            {([["update", "Read and update", "Check work and also change task status, comment, add evidence, and set reminders."], ["read", "Read only", "Check tasks, reviews, knowledge, decisions, and channels. Changes nothing."]] as const).map(([value, title, body]) => <label key={value} className={clsx("cursor-pointer rounded-xl border p-3 transition-colors duration-150", access === value ? "border-primary-400 bg-primary-50" : "border-neutral-200 hover:bg-neutral-50")}>
              <span className="flex items-center gap-2 text-sm font-semibold text-neutral-800"><input type="radio" name="access" checked={access === value} onChange={() => setAccess(value)} />{title}</span>
              <span className="mt-1 block text-xs leading-5 text-neutral-500">{body}</span>
            </label>)}
          </div></fieldset>
          <Field label="Expires after"><Select aria-label="Expires after" className={inputClass} value={days} onChange={(event) => setDays(event.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="366">1 year</option></Select></Field>
          <button disabled={busy} className={primaryClass}><KeyRound size={15} /><ActionLabel busy={busy} busyText="Creating…" idle="Create token" /></button>
        </form>}
      </Panel>
      <Panel>
        <PanelHead title="Your connections" aside={<Badge tone="blue">{active.length}</Badge>} />
        {!items ? <SkeletonRows rows={3} label="Loading connections" /> : !active.length ? <Empty title="No connections yet" body="Create a token to connect Claude Code on your computer." /> : <div className="divide-y divide-neutral-100">{active.map((pat) => <div key={pat.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-neutral-800">{pat.name} <span className="font-mono text-xs font-normal text-neutral-400">{pat.prefix}…</span></p>
            <p className="mt-0.5 text-xs text-neutral-500">{canUpdate(pat) ? "Read and update" : "Read only"} · last used {pat.lastUsedAt ? date(pat.lastUsedAt) : "never"} · expires {date(pat.expiresAt)}</p>
          </div>
          <button type="button" disabled={revoking === pat.id} onClick={() => revoke(pat)} className="min-h-9 rounded-lg px-3 text-sm font-semibold text-[#b42318] transition-colors duration-150 hover:bg-[#fef3f2] disabled:opacity-50">{revoking === pat.id ? "Revoking…" : "Revoke"}</button>
        </div>)}</div>}
      </Panel>
    </div>
  </PageFrame>;
}
