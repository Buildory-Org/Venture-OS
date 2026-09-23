"use client";

import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { getLivePushConfig, registerLivePushSubscription, unregisterLivePushSubscription } from "@/lib/studio-api";
import { primaryClass, secondaryClass } from "@/components/studio/primitives";

type State = "checking" | "unavailable" | "unsupported" | "denied" | "ready" | "enabled" | "error";
const workerPath = "/push-sw.js";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "Web Push could not be updated.";

function supported() {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function publicKeyBytes(key: string) {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function existingRegistration() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const script = registration?.active?.scriptURL ?? registration?.waiting?.scriptURL ?? registration?.installing?.scriptURL;
  return script && new URL(script).pathname === workerPath ? registration : null;
}

export function LiveWebPush({ preferenceEnabled }: { preferenceEnabled?: boolean }) {
  const [state, setState] = useState<State>("checking");
  const [publicKey, setPublicKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => getLivePushConfig().then(async (config) => {
      if (!active) return;
      if (!config.available || !config.publicKey) { setState("unavailable"); return; }
      setPublicKey(config.publicKey);
      if (!supported()) { setState("unsupported"); return; }
      const registration = await existingRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!active) return;
      setState(subscription ? "enabled" : Notification.permission === "denied" ? "denied" : "ready");
    }).catch((cause: unknown) => { if (active) { setError(errorText(cause)); setState("error"); } }));
    return () => { active = false; };
  }, [revision]);

  async function enable() {
    if (busy || state !== "ready" || !publicKey || !supported()) return;
    setBusy(true); setError("");
    let newlyCreated: PushSubscription | null = null;
    try {
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission !== "granted") { setState("denied"); return; }
      const other = await navigator.serviceWorker.getRegistration("/");
      const otherScript = other?.active?.scriptURL ?? other?.waiting?.scriptURL ?? other?.installing?.scriptURL;
      if (otherScript && new URL(otherScript).pathname !== workerPath) throw new Error("Another service worker already controls this site. Web Push was not enabled.");
      await navigator.serviceWorker.register(workerPath, { scope: "/" });
      const ready = await navigator.serviceWorker.ready;
      const current = await ready.pushManager.getSubscription();
      const subscription = current ?? await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(publicKey) });
      if (!current) newlyCreated = subscription;
      await registerLivePushSubscription(subscription);
      setState("enabled");
    } catch (cause) {
      if (newlyCreated) await newlyCreated.unsubscribe().catch(() => false);
      setError(errorText(cause));
      setState(Notification.permission === "denied" ? "denied" : "ready");
    } finally { setBusy(false); }
  }

  async function disable() {
    if (busy || state !== "enabled" || !supported()) return;
    setBusy(true); setError("");
    try {
      const registration = await existingRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await unregisterLivePushSubscription(subscription.endpoint);
        if (!await subscription.unsubscribe()) throw new Error("The server removed this browser, but the browser could not clear its local subscription. Try again from browser settings.");
      }
      setState(Notification.permission === "denied" ? "denied" : "ready");
    } catch (cause) { setError(errorText(cause)); setState("enabled"); }
    finally { setBusy(false); }
  }

  const message: Record<State, string> = {
    checking: "Checking whether this browser can receive push notifications…",
    unavailable: "Web Push is not configured on this server. In-app notifications still work while the site is open.",
    unsupported: "This browser or connection does not support Web Push. Use a supported browser on a secure origin.",
    denied: "Browser notifications are blocked. Change this site’s notification permission in browser settings before enabling push.",
    ready: "This browser is not subscribed. Enabling is optional and will ask for notification permission.",
    enabled: "This browser is subscribed for push notifications.",
    error: "Web Push could not be confirmed. You can retry from this browser.",
  };

  return <div className="space-y-3 p-4">
    <div className="flex items-start gap-2"><BellRing size={17} className="mt-0.5 shrink-0 text-primary-700" /><div><p className="text-sm font-bold text-neutral-800">Browser push on this device</p><p role="status" className="mt-1 text-xs leading-5 text-neutral-500">{message[state]}</p></div></div>
    {preferenceEnabled === false && <p className="text-xs leading-5 text-warning-text">The Web push delivery preference above is off. Save it as on to receive push messages after subscribing.</p>}
    {error && <p role="alert" className="rounded-lg bg-danger-surface p-2 text-xs text-danger-text">{error}</p>}
    {state === "ready" && <button type="button" disabled={busy || !publicKey || !supported()} onClick={enable} className={primaryClass}>{busy ? "Enabling…" : "Enable on this browser"}</button>}
    {state === "enabled" && <button type="button" disabled={busy} onClick={disable} className={secondaryClass}>{busy ? "Disabling…" : "Disable on this browser"}</button>}
    {state === "error" && <button type="button" onClick={() => { setError(""); setState("checking"); setRevision((value) => value + 1); }} className={secondaryClass}>Retry check</button>}
    <p className="text-xs leading-5 text-neutral-400">This controls only this browser. The Web push preference above also applies to delivery; neither setting sends a test notification.</p>
  </div>;
}
