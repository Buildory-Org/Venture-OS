"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Hash, MessageCircle, Search } from "@/components/ui/icons";
import clsx from "clsx";
import type { ReactNode } from "react";

export function ChatAvatar({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  return <Image unoptimized src={`https://api.dicebear.com/10.x/adventurer/svg?seed=${encodeURIComponent(id)}`} alt={`${name}'s avatar`} width={size} height={size} className="shrink-0 rounded-full bg-[#fff1e6] ring-1 ring-black/5" style={{ width: size, height: size }} />;
}

export function ChatShell({ children }: { children: ReactNode }) {
  return <main className="flex h-dvh min-h-[420px] flex-col overflow-hidden bg-[#f5f5fa] text-[#252632]"><div className="flex h-full min-h-0 w-full flex-row overflow-hidden bg-white shadow-[0_12px_50px_rgba(33,36,69,.06)]">{children}</div></main>;
}

export function ChatNav({ mode }: { mode: "messages" | "channels" }) {
  return <div className="flex items-center gap-1"><Link href="/dashboard/live" aria-label="Back to dashboard" title="Dashboard" className="chat-icon"><ArrowLeft size={17} /></Link><div className="mx-1 h-5 w-px bg-black/10" /><Link href="/messages/live" aria-label="Direct messages" title="Direct messages" className={clsx("chat-icon", mode === "messages" && "chat-icon-active")}><MessageCircle size={17} /></Link><Link href="/channels/live" aria-label="Channels" title="Channels" className={clsx("chat-icon", mode === "channels" && "chat-icon-active")}><Hash size={17} /></Link></div>;
}

export function ChatSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="flex h-10 items-center gap-2 rounded-lg bg-[#f6f6f8] px-3 text-[#9a9ba4]"><Search size={15} /><span className="sr-only">{placeholder}</span><input className="min-w-0 flex-1 bg-transparent text-[12px] text-[#252632] outline-none placeholder:text-[#a3a4ad]" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

export function ChatEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center"><div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-[#fff3e9] text-[#f58229]"><MessageCircle size={23} /></div><p className="text-sm font-semibold text-[#343442]">{title}</p><p className="mt-1 max-w-xs text-xs leading-5 text-[#999aa4]">{detail}</p></div>;
}

export function ChatCredit() {
  return <p className="text-[10px] leading-4 text-[#a2a3ad]">Avatars: <a className="underline" href="https://www.dicebear.com/styles/adventurer/" target="_blank" rel="noreferrer">Adventurer by Lisa Wischofsky / DiceBear</a> · CC BY 4.0</p>;
}
