"use client";

import { ChevronDown, ChevronLeft, ChevronRight, Hash, Layers3, Plus } from "lucide-react";
import clsx from "clsx";
import { ChatAvatar, ChatNav, ChatSearch } from "./chat-ui";
import type { loadLiveSession } from "@/lib/studio-api";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type CreateKind = "venture" | "group" | "channel";

type Props = {
  session: Session | null;
  selectedVentureId: string;
  selectedGroupId: string;
  selectedChannelId: string;
  railExpanded: boolean;
  listOpen: boolean;
  search: string;
  realtime: string;
  canCreate: boolean;
  onVentureSelect: (id: string) => void;
  onGroupSelect: (id: string) => void;
  onChannelSelect: (id: string) => void;
  onToggleRail: () => void;
  onSearch: (value: string) => void;
  onCreate: (kind: CreateKind, parent?: string) => void;
};

export function ChannelNavigator(props: Props) {
  const { session, selectedVentureId, selectedGroupId, selectedChannelId, railExpanded, listOpen, search, realtime, canCreate, onVentureSelect, onGroupSelect, onChannelSelect, onToggleRail, onSearch, onCreate } = props;
  const venture = session?.hierarchy.ventures.find((item) => item.id === selectedVentureId);
  const group = venture?.groups.find((item) => item.id === selectedGroupId);
  const channels = group?.channels.filter((channel) => channel.name.toLowerCase().includes(search.trim().toLowerCase())) ?? [];

  return <aside role={listOpen ? "dialog" : undefined} aria-modal={listOpen ? true : undefined} aria-label="Channel navigation" className={clsx("chat-list shrink-0 flex-col border-r border-[#eeeef1] bg-white max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-[min(350px,94vw)] max-md:shadow-xl md:flex", railExpanded ? "md:w-[420px]" : "md:w-[330px]", listOpen ? "flex" : "hidden")}>
    <div className="flex h-[68px] shrink-0 items-center gap-1.5 border-b border-[#f0f0f2] px-2 sm:px-3">
      <ChatNav mode="channels" />
      <div className="relative min-w-0 flex-1"><label htmlFor="channel-venture" className="sr-only">Select venture</label><select id="channel-venture" value={selectedVentureId} onChange={(event) => onVentureSelect(event.target.value)} disabled={!session || session.hierarchy.ventures.length === 0} className="h-9 w-full appearance-none truncate rounded-lg bg-[#f6f6f8] pl-2.5 pr-6 text-[11px] font-bold text-[#393944] outline-none focus-visible:ring-2 focus-visible:ring-[#f58229]">{(!session || session.hierarchy.ventures.length === 0) && <option value="">{session ? "No ventures" : "Loading ventures…"}</option>}{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={13} className="pointer-events-none absolute right-2 top-3 text-[#94949f]" /></div>
      {canCreate && <button type="button" aria-label="Create venture" title="Create venture" onClick={() => onCreate("venture")} className="chat-icon"><Plus size={17} /></button>}
    </div>
    <div className="flex min-h-0 flex-1">
      <div className={clsx("thin-scroll flex shrink-0 flex-col overflow-y-auto border-r border-[#eeeef1] bg-[#f8f8fb] px-2 py-3 transition-[width] duration-150", railExpanded ? "w-[148px] md:w-[180px]" : "w-[58px] md:w-[66px]")}>
        <div className={clsx("mb-3 flex items-center", railExpanded ? "justify-between" : "justify-center")}>
          {railExpanded && <span className="truncate pl-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#9a9aa5]">Groups</span>}
          <button type="button" aria-label={railExpanded ? "Collapse group rail" : "Expand group rail"} aria-expanded={railExpanded} onClick={onToggleRail} className="chat-icon !h-9 !w-9">{railExpanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}</button>
        </div>
        {venture?.groups.map((item) => { const active = item.id === selectedGroupId; const short = item.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase(); return <button key={item.id} type="button" title={item.name} aria-label={`Open ${item.name} group`} aria-pressed={active} onClick={() => onGroupSelect(item.id)} className={clsx("mb-2 flex min-h-11 w-full items-center rounded-xl text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f58229]", railExpanded ? "gap-2 px-1.5" : "justify-center", active ? "bg-[#fff0e4] text-[#df741b]" : "text-[#686974] hover:bg-white")}><span className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-[11px] text-[11px] font-extrabold", active ? "bg-[#ff8b25] text-white" : "bg-white text-[#777884]")}>{short || <Layers3 size={17} />}</span>{railExpanded && <span className="min-w-0 truncate text-[11px] font-semibold">{item.name}</span>}</button>; })}
        {venture && venture.groups.length === 0 && <p className="px-1 text-center text-[10px] leading-4 text-[#a1a1ab]">{railExpanded ? "No groups in this venture yet." : "No groups"}</p>}
        {canCreate && venture && <button type="button" onClick={() => onCreate("group", venture.id)} title={`Create group in ${venture.name}`} aria-label={`Create group in ${venture.name}`} className={clsx("mt-1 flex min-h-10 items-center rounded-xl text-[#e4781f] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f58229]", railExpanded ? "gap-2 px-2 text-[11px] font-semibold" : "justify-center")}><Plus size={17} />{railExpanded && <span>Create group</span>}</button>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-[58px] items-center justify-between gap-1 px-3 pt-2"><div className="min-w-0"><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#a1a1aa]">Channels</p><h1 className="truncate text-[13px] font-bold text-[#343440]">{group?.name ?? (venture ? "Choose a group" : "Choose a venture")}</h1></div>{canCreate && group && <button type="button" aria-label={`Create channel in ${group.name}`} title={`Create channel in ${group.name}`} onClick={() => onCreate("channel", group.id)} className="chat-icon"><Plus size={17} /></button>}</div>
        <div className="px-3 pb-3"><ChatSearch value={search} onChange={onSearch} placeholder="Search this group..." /></div>
        <nav aria-label={group ? `Channels in ${group.name}` : "Channels"} className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {channels.map((channel) => <button key={channel.id} type="button" onClick={() => onChannelSelect(channel.id)} aria-pressed={channel.id === selectedChannelId} className={clsx("my-0.5 flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f58229]", selectedChannelId === channel.id ? "bg-[#fff2e8] font-semibold text-[#e4781f]" : "text-[#666773] hover:bg-[#faf8f7]")}><Hash size={14} className="shrink-0" /><span className="truncate">{channel.name}</span></button>)}
          {group && channels.length === 0 && <p className="px-2 py-5 text-[11px] leading-5 text-[#999aa4]">{search ? "No channels match this search in this group." : "No channels in this group yet."}</p>}
          {!session && <p className="px-2 py-5 text-[11px] text-[#999aa4]">Loading workspace…</p>}
        </nav>
      </div>
    </div>
    {session && <div className="flex items-center gap-2 border-t border-[#f0f0f2] px-3 py-3"><ChatAvatar id={session.user.id} name={session.user.name} size={30} /><span className="min-w-0 truncate text-[10px] font-semibold">{session.user.name}</span><span className="ml-auto text-[9px] text-[#9b9ca6]">{realtime === "live" ? "Live" : "Offline"}</span></div>}
  </aside>;
}
