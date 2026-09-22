"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { eventEnvelopeSchema } from "@venture-studio/contracts";
import { listLiveEvents } from "@/lib/studio-api";

export type RealtimeState = "connecting" | "live" | "unavailable";

export function useLiveRealtime(onEvent: () => void, channelId?: string) {
  const callback = useRef(onEvent);
  const [state, setState] = useState<RealtimeState>("connecting");

  useEffect(() => { callback.current = onEvent; }, [onEvent]);

  useEffect(() => {
    const localDevAuth = process.env.NODE_ENV === "development" && window.location.hostname === "localhost";
    const socket = io({
      path: "/socket.io",
      addTrailingSlash: false,
      transports: ["polling"],
      withCredentials: true,
      auth: async (done) => {
        if (!localDevAuth) { done({}); return; }
        try {
          const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
          const session = await response.json() as { user?: { id?: string } } | null;
          done(session?.user?.id ? {} : { devUserId: "user-divyansh" });
        } catch {
          done({ devUserId: "user-divyansh" });
        }
      },
    });
    let active = true;
    let lastEventId: string | undefined;
    let lastOrder = "";
    const seen = new Set<string>();
    queueMicrotask(() => { if (active) setState("connecting"); });

    function remember(event: { eventId: string; occurredAt: string }) {
      const order = `${event.occurredAt}:${event.eventId}`;
      if (order > lastOrder) { lastOrder = order; lastEventId = event.eventId; }
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    }

    async function catchUp() {
      try {
        const events = await listLiveEvents(lastEventId);
        if (!active) return;
        for (const event of events) {
          if (!remember(event)) continue;
          if (!channelId || event.channelId === channelId) callback.current();
        }
      } catch {
        if (active) { lastEventId = undefined; lastOrder = ""; callback.current(); }
      }
    }

    socket.on("connect", () => {
      if (!active) return;
      if (channelId) {
        socket.timeout(5000).emit("channel:join", channelId, (error: Error | null, result: { ok?: boolean }) => {
          if (!active) return;
          if (error || !result?.ok) { setState("unavailable"); return; }
          setState("live"); void catchUp();
        });
      } else { setState("live"); void catchUp(); }
    });
    socket.on("event", (value: unknown) => {
      if (!active) return;
      const parsed = eventEnvelopeSchema.safeParse(value);
      if (!parsed.success || !remember(parsed.data)) return;
      if (!channelId || parsed.data.channelId === channelId) callback.current();
    });
    socket.on("disconnect", () => { if (active) setState("connecting"); });
    socket.on("connect_error", () => { if (active) setState("unavailable"); });

    return () => { active = false; socket.disconnect(); };
  }, [channelId]);

  return state;
}
