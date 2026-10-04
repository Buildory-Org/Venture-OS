"use client";

import { useEffect, useRef, useState } from "react";
import type { Message } from "@venture-studio/contracts";

type Sound = "sent" | "received";
let audio: AudioContext | null = null;

export function prepareChatAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch { /* Audio is optional when the browser or device disallows it. */ }
}

export function playChatSound(kind: Sound) {
  if (!audio || audio.state !== "running") return;
  try {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const now = audio.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(kind === "sent" ? 630 : 440, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === "sent" ? 880 : 660, now + 0.085);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.14);
  } catch { /* A failed cue must never interrupt sending or receiving. */ }
}

/** Existing history is quiet; only messages added after the first load animate. */
export function useChatMessageArrival(conversationId: string, messages: Message[], userId: string | undefined, loaded: boolean) {
  const seen = useRef<{ conversationId: string; ids: Set<string>; latestAt: number; initialized: boolean }>({ conversationId: "", ids: new Set(), latestAt: 0, initialized: false });
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  useEffect(() => {
    window.addEventListener("pointerdown", prepareChatAudio, { once: true });
    window.addEventListener("keydown", prepareChatAudio, { once: true });
    return () => { window.removeEventListener("pointerdown", prepareChatAudio); window.removeEventListener("keydown", prepareChatAudio); };
  }, []);
  useEffect(() => {
    if (seen.current.conversationId !== conversationId) {
      seen.current = { conversationId, ids: new Set(), latestAt: 0, initialized: false };
      queueMicrotask(() => setArrived(new Set()));
    }
    if (!conversationId || !loaded) return;
    if (!seen.current.initialized) {
      seen.current.ids = new Set(messages.map((message) => message.id));
      seen.current.latestAt = Math.max(0, ...messages.map((message) => Date.parse(message.createdAt) || 0));
      seen.current.initialized = true;
      return;
    }
    const fresh = messages.filter((message) => !seen.current.ids.has(message.id) && (Date.parse(message.createdAt) || 0) >= seen.current.latestAt);
    for (const message of messages) seen.current.ids.add(message.id);
    seen.current.latestAt = Math.max(seen.current.latestAt, ...messages.map((message) => Date.parse(message.createdAt) || 0));
    if (!fresh.length) return;
    queueMicrotask(() => setArrived((current) => new Set([...current, ...fresh.map((message) => message.id)])));
    if (fresh.some((message) => message.authorId !== userId) && document.visibilityState === "visible" && document.hasFocus()) {
      playChatSound("received");
    }
  }, [conversationId, loaded, messages, userId]);
  return arrived;
}

export function ChatSendIcon({ size = 17 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3 3.5 10.4a.9.9 0 0 0 .07 1.69l6.57 2.19 2.19 6.57a.9.9 0 0 0 1.69.07L21 3Z" /><path d="m10.1 14.3 6.2-6.2" /></svg>;
}
