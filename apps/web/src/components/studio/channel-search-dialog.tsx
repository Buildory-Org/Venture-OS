"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileText, MessageCircle, Search, X } from "@/components/ui/icons";
import { prepareLiveFileDownload, searchLiveGroupContent, type LiveChatSearchHit } from "@/lib/studio-api";

type Filter = "all" | "message" | "file";

export function ChannelSearchDialog({ groupId, groupName, channels, onClose, onOpenChannel }: {
  groupId: string;
  groupName: string;
  channels: { id: string; name: string }[];
  onClose: () => void;
  onOpenChannel: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [result, setResult] = useState<{ query: string; items: LiveChatSearchHit[]; error: string }>({ query: "", items: [], error: "" });
  const [expanded, setExpanded] = useState("");
  const [downloading, setDownloading] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const term = query.trim();

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (term.length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      searchLiveGroupContent(term, groupId).then((items) => {
        if (active) setResult({ query: term, items, error: "" });
      }).catch((cause: unknown) => {
        if (active) setResult({ query: term, items: [], error: cause instanceof Error ? cause.message : "Search failed." });
      });
    }, 220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [term, groupId]);

  async function download(file: LiveChatSearchHit) {
    setDownloading(file.id);
    try {
      const url = await prepareLiveFileDownload(file.id);
      const link = document.createElement("a");
      link.href = url; link.download = file.title; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setResult((current) => ({ ...current, error: cause instanceof Error ? cause.message : "Download failed." }));
    } finally { setDownloading(""); }
  }

  const ready = result.query === term;
  const items = ready ? result.items.filter((item) => filter === "all" || item.type === filter) : [];
  return createPortal(<div className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/40 px-3 pt-[8vh] backdrop-blur-[2px] sm:px-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={`Search ${groupName} messages and files`} className="w-full max-w-[600px] overflow-hidden rounded-2xl border border-[var(--color-neutral-200)] bg-white shadow-e4" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])');
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="flex h-14 items-center gap-3 px-4"><Search size={18} className="shrink-0 text-[var(--color-neutral-400)]" /><input ref={input} aria-label="Search messages and files" value={query} onChange={(event) => { setQuery(event.target.value); setExpanded(""); }} placeholder={`Search ${groupName} messages and files...`} className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-neutral-900)] outline-none placeholder:text-[var(--color-neutral-400)]" /><button type="button" aria-label="Close search" onClick={onClose} className="chat-icon !h-8 !w-8"><X size={16} /></button></div>
      <div className="flex gap-1 border-y border-[var(--color-neutral-100)] px-3 py-2" aria-label="Search result type">{([['all','All'],['message','Messages'],['file','Files']] as const).map(([value,label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`min-h-8 rounded-lg px-3 text-[11px] font-semibold ${filter === value ? 'bg-[var(--color-primary-100)] text-[var(--color-primary-700)]' : 'text-[var(--color-neutral-500)] hover:bg-[var(--color-neutral-100)]'}`}>{label}</button>)}</div>
      <div className="thin-scroll max-h-[min(62vh,520px)] min-h-40 overflow-y-auto p-2" aria-live="polite">
        {term.length < 2 ? <p className="px-4 py-9 text-center text-xs text-[var(--color-neutral-400)]">Type at least two characters to search this group.</p> : !ready ? <p className="px-4 py-9 text-center text-xs text-[var(--color-neutral-400)]">Searching…</p> : result.error ? <p role="alert" className="px-4 py-6 text-center text-xs text-red-700">{result.error}</p> : items.length === 0 ? <p className="px-4 py-9 text-center text-xs text-[var(--color-neutral-400)]">No matching {filter === 'all' ? 'messages or files' : filter === 'message' ? 'messages' : 'files'} in this group.</p> : items.map((item) => item.type === "file" ? <button key={item.id} type="button" disabled={downloading === item.id} onClick={() => void download(item)} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-[var(--color-primary-50)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-700)]"><FileText size={17} /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-[var(--color-neutral-800)]">{item.title}</span><span className="block text-[10px] text-[var(--color-neutral-400)]">{item.contentType}</span></span><Download size={16} className="shrink-0 text-[var(--color-neutral-400)]" /></button> : <div key={item.id} className="rounded-xl px-3 py-2 hover:bg-[var(--color-primary-50)]"><button type="button" aria-expanded={expanded === item.id} onClick={() => setExpanded((value) => value === item.id ? "" : item.id)} className="flex w-full items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-700)]"><MessageCircle size={17} /></span><span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-[var(--color-neutral-800)]">#{channels.find((channel) => channel.id === item.channelId)?.name ?? 'channel'}</span><span className={`mt-1 block break-words text-[11px] leading-5 text-[var(--color-neutral-600)] ${expanded === item.id ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{item.excerpt}</span></span></button>{expanded === item.id && item.channelId && <button type="button" onClick={() => { onOpenChannel(item.channelId!); onClose(); }} className="ml-12 mt-2 min-h-8 rounded-lg px-2 text-[11px] font-semibold text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]">Open channel</button>}</div>)}
      </div>
    </section>
  </div>, document.body);
}
