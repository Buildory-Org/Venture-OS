"use client";
import { describeError } from "@/lib/errors";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "@/components/ui/icons";
import { inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";

type Status = { available: boolean; complete: boolean; configured: boolean; emailDeliveryReady: boolean };

export function SignupForm({ status }: { status: Status | null }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), name: name.trim(), callbackURL: `${window.location.origin}/signup/complete` }) });
      if (!response.ok) throw new Error(`Could not send a verification link (HTTP ${response.status}).`);
      setSent(true);
    } catch (cause) { setError(describeError(cause, "Could not request a verification link.")); }
    finally { setBusy(false); }
  }

  return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-50 text-primary-700"><MailCheck size={22} /></span><h1 className="mt-5 text-2xl font-bold text-neutral-900">Create the first admin account</h1><p className="mt-2 text-sm leading-6 text-neutral-500">This one-time setup is only for the owner email configured on the server. Verify that address to activate the workspace; then you can invite other people.</p>
    {!status ? <p role="alert" className="mt-5 rounded-xl bg-warning-surface p-4 text-sm text-warning-text">The API is unavailable. Start the backend and reload this page.</p> : !status.configured ? <p role="alert" className="mt-5 rounded-xl bg-warning-surface p-4 text-sm text-warning-text">Setup is not configured. Set BOOTSTRAP_ADMIN_EMAIL to your email and use a MongoDB replica set, then restart the API.</p> : !status.emailDeliveryReady ? <p role="alert" className="mt-5 rounded-xl bg-warning-surface p-4 text-sm text-warning-text">Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM in the server environment, then restart the API.</p> : sent ? <p role="status" className="mt-5 rounded-xl bg-success-surface p-4 text-sm text-success-text">If this is the configured owner address, check {email.trim()} for a verification link. Open it on this computer to finish setup.</p> : <form onSubmit={submit} className="mt-5 space-y-3"><label className="block"><span className="mb-1.5 block text-xs font-semibold text-neutral-600">Owner email</span><input required type="email" autoComplete="email" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="block"><span className="mb-1.5 block text-xs font-semibold text-neutral-600">Your name</span><input required minLength={1} maxLength={120} autoComplete="name" className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></label>{error && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-sm text-danger-text">{error}</p>}<button disabled={busy} className={`${primaryClass} w-full`}>{busy ? "Sending…" : "Email me a verification link"}</button></form>}
    <Link href="/sign-in/live" className={`${secondaryClass} mt-4 w-full`}>Already a member? Sign in</Link>
  </section></main>;
}
