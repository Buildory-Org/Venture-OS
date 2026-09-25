"use client";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "@/components/ui/icons";
import { primaryClass, secondaryClass } from "@/components/studio/primitives";

export function CompleteSignupClient() {
  const [state, setState] = useState<"ready" | "claiming" | "done" | "error">("ready");
  const [error, setError] = useState("");

  async function claim() {
    setState("claiming"); setError("");
    try {
      const response = await fetch("/v1/setup/first-admin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `Setup failed (HTTP ${response.status}).`);
      setState("done");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not finish setup."); setState("error"); }
  }

  return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-50 text-primary-700"><MailCheck size={22} /></span><h1 className="mt-5 text-2xl font-bold text-neutral-900">Finish workspace setup</h1>{state === "done" ? <><p role="status" className="mt-3 text-sm text-success-text">Your admin account is ready. First-admin signup is now closed.</p><Link href="/dashboard/live" className={`${primaryClass} mt-5 w-full`}>Open workspace</Link></> : <><p className="mt-3 text-sm leading-6 text-neutral-500">After opening the verification link for the configured owner email, complete the one-time admin setup.</p>{state === "claiming" && <p role="status" className="mt-3 text-sm text-neutral-500">Creating admin access…</p>}{error && <p role="alert" className="mt-3 text-sm text-danger-text">{error}</p>}<button type="button" disabled={state === "claiming"} onClick={claim} className={`${primaryClass} mt-5 w-full`}>Complete admin setup</button><Link href="/sign-in/live" className={`${secondaryClass} mt-3 w-full`}>Sign in first</Link></>}</section></main>;
}
