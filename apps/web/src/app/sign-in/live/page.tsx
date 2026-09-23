"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Layers3, LockKeyhole, Mail } from "@/components/ui/icons";
import { inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";

function ConnectedSignIn() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const nextParam = params.get("next") ?? "/dashboard/live";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard/live";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}), callbackURL: `${window.location.origin}${next}` }) });
      if (!response.ok) throw new Error(`Sign-in request failed (HTTP ${response.status}).`);
      setSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not request a sign-in link."); }
    finally { setBusy(false); }
  }

  return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-600 text-white"><Layers3 size={21} /></span><p className="mt-5 text-xs font-extrabold uppercase tracking-[.1em] text-primary-600">Connected workspace</p><h1 className="mt-1 text-2xl font-extrabold tracking-tight text-neutral-900">Sign in to Venture Studio</h1><p className="mt-2 text-sm leading-6 text-neutral-500">Use your invited email address to request a one-time sign-in link.</p>
    {sent ? <div role="status" className="mt-5 rounded-xl bg-success-surface p-4 text-sm leading-6 text-success-text"><Mail size={17} className="mr-2 inline" />Sign-in link requested for {email.trim()}. If email delivery is enabled for this workspace, check your inbox. If nothing arrives, ask a workspace admin for help.</div> : <form onSubmit={submit} className="mt-5 space-y-3"><label className="block"><span className="mb-1.5 block text-xs font-extrabold text-neutral-600">Email</span><input required type="email" autoComplete="email" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="block"><span className="mb-1.5 block text-xs font-extrabold text-neutral-600">Name, if this is your first sign-in</span><input autoComplete="name" className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></label>{error && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-sm font-bold text-danger-text">{error}</p>}<button disabled={busy} className={`${primaryClass} w-full`}>{busy ? "Requesting…" : "Request sign-in link"}</button></form>}
    <div className="mt-4 flex flex-wrap gap-2"><Link href="/demo/sign-in" className={secondaryClass}>Explore demo</Link><Link href="/dashboard/live" className={secondaryClass}>Open workspace</Link></div><p className="mt-4 flex items-start gap-2 text-xs leading-5 text-neutral-400"><LockKeyhole size={14} className="mt-0.5 shrink-0" />Use an invited email to access your workspace. The demo only shows sample data.</p>
  </section></main>;
}

export default function Page() { return <Suspense fallback={<main className="min-h-dvh bg-canvas p-6">Loading sign-in…</main>}><ConnectedSignIn /></Suspense>; }
