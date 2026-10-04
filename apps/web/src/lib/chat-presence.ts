"use client";

import { useEffect } from "react";

type ChatKind = "direct" | "channel";
type Chat = { kind: ChatKind; id: string };
let activeChat: Chat | null = null;

export function isActiveChat(kind?: string, id?: string) {
  return Boolean(kind && id && activeChat?.kind === kind && activeChat.id === id && document.visibilityState === "visible" && document.hasFocus());
}

export function useActiveChatPresence(kind: ChatKind, id: string) {
  useEffect(() => {
    if (!id) return;
    const chat = { kind, id };
    activeChat = chat;
    return () => { if (activeChat === chat) activeChat = null; };
  }, [kind, id]);
}

export function useChatPushResponder() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const respond = (event: MessageEvent) => {
      if (event.data?.type !== "venture:chat-push-check" || !event.ports[0]) return;
      const chat = event.data.chat as Chat | undefined;
      event.ports[0].postMessage({ active: isActiveChat(chat?.kind, chat?.id) });
    };
    navigator.serviceWorker.addEventListener("message", respond);
    return () => navigator.serviceWorker.removeEventListener("message", respond);
  }, []);
}
