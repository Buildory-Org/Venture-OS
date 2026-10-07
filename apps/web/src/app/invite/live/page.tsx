"use client";
import { describeError } from "@/lib/errors";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MailCheck } from "@/components/ui/icons";
import { acceptLiveInvitation, hasLiveAuthSession, signOutLive } from "@/lib/studio-api";
import { primaryClass, secondaryClass } from "@/components/studio/primitives";

function ConnectedInvite() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  // Unknown until checked, so neither choice flashes before the session check settles.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const invitePath = `/invite/live?token=${encodeURIComponent(token)}`;
  const signInUrl = `/sign-in/live?next=${encodeURIComponent(invitePath)}`;

  // Signed in already (maybe as someone else): offer a switch instead of sign-in, which would only bounce back here.
  useEffect(() => {
    let active = true;
    hasLiveAuthSession().then((value) => { if (active) setSignedIn(value); }, () => { if (active) setSignedIn(false); });
    return () => { active = false; };
  }, []);

  async function accept() {
    setBusy(true); setError("");
    try { await acceptLiveInvitation(token); setAccepted(true); }
    catch (cause) { setError(describeError(cause, "Could not accept the invitation.")); }
    finally { setBusy(false); }
  }

  return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-50 text-primary-700"><MailCheck size={22} /></span><h1 className="mt-5 text-2xl font-extrabold text-neutral-900">Join Venture Studio</h1><p className="mt-2 text-sm leading-6 text-neutral-500">Sign in with the invited email address, then accept your invitation. Invitations may expire or be limited to a specific workspace.</p>
    {accepted ? <div role="status" className="mt-5 rounded-xl bg-success-surface p-4 text-sm font-semibold text-success-text">Invitation accepted. Your workspace access is now active.</div> : token ? <><button disabled={busy} type="button" onClick={accept} className={`${primaryClass} mt-5 w-full`}>{busy ? "Checking invitation…" : "Accept invitation"}</button>{error && <p role="alert" className="mt-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}</> : <p role="alert" className="mt-5 rounded-xl bg-warning-surface p-3 text-sm font-semibold text-warning-text">This invitation link is incomplete. Ask the sender for a new link.</p>}
    <div className="mt-4 flex flex-wrap gap-2">{signedIn === true && <button type="button" disabled={signingOut} onClick={() => { setSigningOut(true); setError(""); signOutLive(invitePath).catch((cause) => { setSigningOut(false); setError(describeError(cause, "Could not sign out. Try again.")); }); }} className={secondaryClass}>{signingOut ? "Signing out…" : "Use a different account"}</button>}{signedIn === false && <Link href={signInUrl} className={secondaryClass}>Sign in first</Link>}<Link href="/dashboard/live" className={secondaryClass}>Go to dashboard</Link></div>
  </section></main>;
}

export default function Page() { return <Suspense fallback={<main className="min-h-dvh bg-canvas p-6">Loading invitation…</main>}><ConnectedInvite /></Suspense>; }
