"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, Archive, ArrowLeft, Download, Edit, Eye, Forward, Inbox, Mail, Paperclip, Reply, ReplyAll, RotateCcw, Search, Send, Star, Trash, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Plug } from "@/components/sales/lead-icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { Panel, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { typingTarget, useIsDesktop, useQueryParam } from "@/components/sales/draft-shared";
import { useSalesShell } from "@/components/sales/sales-context";
import { useUrlParams } from "@/components/sales/sales-ui";
import { MailChips, MailCompose, MailFrame, personLabel, sizeLabel, type ComposeStart } from "@/components/sales/mail-parts";
import { describeError } from "@/lib/errors";
import { downloadAttachment, flagMail, listMail, listMailAccounts, listMailFolders, moveMail, readMail, type MailAccount, type MailFolder, type MailMessage, type MailRow } from "@/lib/sales-mail-api";

// Mail (docs/sales-channels.md section 3a): the person's own connected mailbox, read live from their mail server like a webmail. Folders on
// the left, the messages in the middle, the open message on the right (on a phone they take turns). Only the mailbox's owner sees it.

/** How often the open folder and the folder counts are read again while the page is open and shown. */
const REFRESH_MS = 60_000;

const shortDate = (value: string | undefined, now: Date) => {
  if (!value) return "";
  const date = new Date(value);
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
};
const fullDate = (value: string | undefined) => (value ? new Date(value).toLocaleString([], { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const ROLE_ICON = { inbox: Inbox, sent: Send, drafts: Edit, junk: AlertTriangle, trash: Trash, archive: Archive, other: Mail } as const;

type ListState = { key: string; items: MailRow[]; nextBefore?: number | undefined; total: number };

export function MailScreen() {
  const { ventureId, openLead, refreshKey } = useSalesShell();
  const desktop = useIsDesktop();
  // Folders get their own column only on a wide screen; below it they are a dropdown, so the open message keeps its room.
  const wide = useIsDesktop("(min-width: 1280px)");
  const [boxParam] = useQueryParam("box");
  const [folderParam] = useQueryParam("folder");
  const [uidParam, setUidParam] = useQueryParam("uid");
  // Several parts of the address change at once (a folder and the open message): one change, so the second never undoes the first.
  const { update: setParams } = useUrlParams();
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState("");
  const [folders, setFolders] = useState<{ accountId: string; items: MailFolder[] } | null>(null);
  const [foldersError, setFoldersError] = useState("");
  const [list, setList] = useState<ListState | null>(null);
  const [listError, setListError] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [message, setMessage] = useState<{ key: string; data: MailMessage } | null>(null);
  const [messageError, setMessageError] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [compose, setCompose] = useState<ComposeStart | null>(null);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let active = true;
    listMailAccounts().then((rows) => { if (active) setAccounts(rows); }).catch((cause: unknown) => { if (active) setAccountsError(describeError(cause, "Could not load your mailboxes.")); });
    return () => { active = false; };
  }, []);

  const account = useMemo(() => {
    if (!accounts?.length) return undefined;
    return accounts.find((entry) => entry.id === boxParam)
      ?? (ventureId ? accounts.find((entry) => entry.defaultFor.includes(ventureId)) ?? accounts.find((entry) => entry.ventureIds.includes(ventureId)) : undefined)
      ?? accounts.find((entry) => entry.status === "connected") ?? accounts[0];
  }, [accounts, boxParam, ventureId]);
  const accountId = account?.id ?? "";
  const folderList = folders?.accountId === accountId ? folders.items : null;
  const inboxPath = folderList?.find((entry) => entry.role === "inbox")?.path ?? "INBOX";
  const folder = folderParam || inboxPath;
  const current = folderList?.find((entry) => entry.path === folder);
  const listKey = `${accountId}|${folder}|${search}`;
  const shownList = list?.key === listKey ? list : null;
  const uid = Number(uidParam) || 0;
  const messageKey = `${accountId}|${folder}|${uid}`;
  const shownMessage = message?.key === messageKey ? message.data : null;

  const rows = useMemo(() => shownList?.items ?? [], [shownList]);
  const rowsRef = useRef<MailRow[]>([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  // Folders, and the open folder's first page, now and every minute while the page is shown.
  const loadFolders = useCallback(async () => {
    if (!accountId) return;
    try { const items = await listMailFolders(accountId); setFolders({ accountId, items }); setFoldersError(""); }
    catch (cause) { setFoldersError(describeError(cause, "Could not read your folders.")); }
  }, [accountId]);
  const loadList = useCallback(async (before?: number) => {
    if (!accountId) return;
    const key = `${accountId}|${folder}|${search}`;
    setListBusy(true);
    try {
      const page = await listMail(accountId, { folder, ...(before ? { before } : {}), ...(search ? { q: search } : {}) });
      setList((previous) => {
        const same = previous?.key === key;
        // An older page goes under the list (the total stays the first page's); a fresh first page keeps the older pages already loaded.
        if (before) return { key, items: same ? [...previous.items, ...page.items] : page.items, nextBefore: page.nextBefore, total: same ? previous.total : page.total };
        const oldest = page.items.at(-1)?.uid;
        const kept = same && oldest !== undefined && previous.items.length > page.items.length ? previous.items.filter((row) => row.uid < oldest) : [];
        return { key, items: [...page.items, ...kept], nextBefore: kept.length ? previous!.nextBefore : page.nextBefore, total: page.total };
      });
      setListError("");
    } catch (cause) {
      setListError(describeError(cause, "Could not read this folder."));
    } finally { setListBusy(false); }
  }, [accountId, folder, search]);
  // The page's refresh button (refreshKey) and the minute timer (tick) both read the mailbox again.
  useEffect(() => { queueMicrotask(() => { void loadFolders(); }); }, [loadFolders, tick, refreshKey]);
  useEffect(() => { queueMicrotask(() => { void loadList(); }); }, [loadList, tick, refreshKey]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") { setTick((value) => value + 1); setNow(new Date()); } }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  // The open message (opening it marks it read).
  useEffect(() => {
    if (!accountId || !uid) return;
    let active = true;
    const key = `${accountId}|${folder}|${uid}`;
    queueMicrotask(() => setMessageError(""));
    readMail(accountId, folder, uid).then((data) => {
      if (!active) return;
      setMessage({ key, data });
      // Opening it marked it read on the server: the list and the folder's count follow.
      const wasUnread = rowsRef.current.some((row) => row.uid === uid && !row.seen);
      setList((previous) => previous ? { ...previous, items: previous.items.map((row) => row.uid === uid && row.folder === folder ? { ...row, seen: true } : row) } : previous);
      if (wasUnread) setFolders((previous) => previous && previous.accountId === accountId ? { ...previous, items: previous.items.map((entry) => entry.path === folder ? { ...entry, unread: Math.max(0, entry.unread - 1) } : entry) } : previous);
    }).catch((cause: unknown) => { if (active) setMessageError(describeError(cause, "Could not open this message.")); });
    return () => { active = false; };
  }, [accountId, folder, uid]);

  const open = (row: MailRow) => setUidParam(String(row.uid), { replace: desktop && Boolean(uid) });
  const pickFolder = (path: string) => { setParams({ folder: path === inboxPath ? null : path, uid: null }, "push"); setQuery(""); setSearch(""); };

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target) || compose) return;
      const index = rows.findIndex((row) => row.uid === uid);
      if (event.key === "j" || event.key === "k") {
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
        if (next) { event.preventDefault(); setUidParam(String(next.uid), { replace: true }); }
      } else if (event.key === "c") { event.preventDefault(); setCompose({ mode: "new" }); }
      else if (event.key === "Escape" && uid && !desktop) setUidParam("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, uid, compose, desktop, setUidParam]);

  async function act(row: MailRow, what: "unread" | "star" | "unstar" | "trash" | "junk" | "inbox" | "archive") {
    try {
      if (what === "unread") await flagMail(accountId, folder, row.uid, { seen: false });
      else if (what === "star" || what === "unstar") await flagMail(accountId, folder, row.uid, { flagged: what === "star" });
      else await moveMail(accountId, folder, row.uid, what);
      if (what === "star" || what === "unstar") {
        setList((previous) => previous ? { ...previous, items: previous.items.map((entry) => entry.uid === row.uid ? { ...entry, flagged: what === "star" } : entry) } : previous);
        setMessage((previous) => previous ? { ...previous, data: { ...previous.data, flagged: what === "star" } } : previous);
        return;
      }
      const index = rows.findIndex((entry) => entry.uid === row.uid);
      const next = rows[index + 1] ?? rows[index - 1];
      if (what === "unread") setList((previous) => previous ? { ...previous, items: previous.items.map((entry) => entry.uid === row.uid ? { ...entry, seen: false } : entry) } : previous);
      else {
        setList((previous) => previous ? { ...previous, items: previous.items.filter((entry) => entry.uid !== row.uid) } : previous);
        toast({ title: { trash: "Moved to Trash", junk: "Moved to Spam", inbox: "Moved to Inbox", archive: "Archived" }[what] });
      }
      setUidParam(what === "unread" || !desktop || !next || next.uid === row.uid ? "" : String(next.uid), { replace: true });
      void loadFolders();
    } catch (cause) {
      toast({ tone: "error", title: "That didn't work", body: describeError(cause, "Try again.") });
    }
  }

  if (accountsError) return <Panel><EmptyState variant="error" title="Could not open Mail" body={accountsError} action={{ label: "Try again", onClick: () => window.location.reload() }} /></Panel>;
  if (!accounts) return <MailSkeleton />;
  if (!account) return <Panel><EmptyState variant="card" tone="green" icon={Plug} title="Connect your mailbox first" body="Mail shows the mailbox you connected in Channels: everything you sent and received, read straight from your mail server. Only you see it." action={{ label: "Open Channels", href: "/sales/live/channels" }} /></Panel>;

  const readerOpen = Boolean(uid);
  const unreadLabel = (entry: MailFolder) => (entry.role === "drafts" || entry.role === "sent" || entry.role === "trash" ? entry.total : entry.unread);
  // Laptop: mailbox, search and Write on one line. Phone: the folder and Write, then the search under them.
  const toolbar = <div className="mb-3 flex flex-wrap items-center gap-2">
    {accounts.length > 1 && <div className="w-full lg:w-64"><Select aria-label="Mailbox" className={inputClass} value={account.id} onChange={(event) => { setParams({ box: event.target.value, folder: null, uid: null }, "push"); setQuery(""); setSearch(""); }}>{accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.address}</option>)}</Select></div>}
    {!wide && folderList && <div className="min-w-0 flex-1 lg:w-56 lg:flex-none"><Select aria-label="Folder" className={inputClass} value={folder} onChange={(event) => pickFolder(event.target.value)}>{folderList.map((entry) => <option key={entry.path} value={entry.path}>{entry.name}{unreadLabel(entry) && entry.role !== "sent" && entry.role !== "trash" ? ` (${unreadLabel(entry)})` : ""}</option>)}</Select></div>}
    <form role="search" className="relative order-last w-full lg:order-none lg:w-auto lg:max-w-md lg:flex-1" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); setUidParam("", { replace: true }); }}>
      <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
      <input type="search" aria-label={`Search ${current?.name ?? "this folder"}`} placeholder={`Search ${current?.name ?? "this folder"}`} value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setSearch(""); }} className={clsx(inputClass, "!pl-9")} />
    </form>
    <button type="button" title="Write a new email (c)" onClick={() => setCompose({ mode: "new" })} className={clsx(primaryClass, "lg:ml-auto")}><Edit size={16} aria-hidden="true" />Write</button>
  </div>;

  const banner = account.status === "needs_attention"
    ? <p className="mb-3 flex items-start gap-2 rounded-xl bg-warning-surface p-3 text-sm font-semibold text-warning-text"><AlertTriangle size={16} className="mt-0.5 shrink-0" />Your mail server refused this mailbox&apos;s password. <Link href="/sales/live/channels" className="underline">Enter it again in Channels</Link>.</p>
    : null;

  const folderPane = <>
    {accounts.length === 1 && <p className="truncate px-4 pb-1 pt-4 text-[11px] font-semibold text-neutral-500" title={account.address}>{account.address}</p>}
    {foldersError && !folderList ? <p className="p-4 text-sm text-danger-text">{foldersError}</p> : !folderList ? <div className="space-y-2 p-3">{[0, 1, 2, 3, 4].map((index) => <span key={index} className="vso-skeleton block h-8 rounded-lg" />)}</div>
      : <nav aria-label="Folders" className="p-2"><ul className="grid gap-0.5">{folderList.map((entry) => {
        const Icon = ROLE_ICON[entry.role];
        const active = entry.path === folder;
        const count = entry.role === "inbox" || entry.role === "junk" || entry.role === "other" || entry.role === "archive" ? entry.unread : entry.role === "drafts" ? entry.total : 0;
        return <li key={entry.path}><button type="button" aria-current={active ? "page" : undefined} onClick={() => pickFolder(entry.path)} style={{ paddingLeft: `${12 + entry.depth * 14}px` }} className={clsx("flex min-h-9 w-full items-center gap-2.5 rounded-xl pr-3 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", active ? "bg-white font-bold text-primary-800 shadow-[0_1px_2px_rgba(15,23,42,.06)]" : "font-medium text-neutral-700 hover:bg-white/70")}>
          <Icon size={16} aria-hidden="true" className={active ? "text-primary-700" : "text-neutral-400"} /><span className="min-w-0 flex-1 truncate">{entry.name}</span>{count > 0 && <span className={clsx("tnum text-xs font-bold", active ? "text-primary-700" : "text-neutral-500")}>{count}</span>}
        </button></li>;
      })}</ul></nav>}
  </>;

  const sentFolder = current?.role === "sent" || current?.role === "drafts";
  const listPane = <>
    <h2 className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white px-4 py-3 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500"><span className="truncate">{search ? `“${search}” in ${current?.name ?? "folder"}` : current?.name ?? "Messages"}</span>{shownList && <span className="tnum rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{shownList.total}</span>}</h2>
    {listError && !shownList ? <EmptyState variant="error" title="Could not read this folder" body={listError} action={{ label: "Try again", onClick: () => void loadList() }} />
      : !shownList ? <div role="status" aria-label="Loading messages" className="space-y-4 p-4">{[0, 1, 2, 3, 4].map((index) => <div key={index} className="grid gap-2"><span className="vso-skeleton h-3 w-1/2" /><span className="vso-skeleton h-2.5 w-4/5" /></div>)}</div>
      : rows.length === 0 ? <p className="px-4 py-10 text-center text-sm text-neutral-500">{search ? "Nothing matches. Try other words, or clear the search." : `${current?.name ?? "This folder"} is empty.`}</p>
      : <ul>{rows.map((row) => {
        const active = row.uid === uid;
        const who = sentFolder ? `To: ${row.to.map(personLabel).join(", ") || "(no one)"}` : personLabel(row.from[0]) || "(unknown sender)";
        return <li key={row.uid}><button type="button" aria-current={active ? "true" : undefined} onClick={() => open(row)} className={clsx("relative flex w-full items-start gap-2.5 border-b border-neutral-100 px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600", active ? "bg-primary-50" : "hover:bg-neutral-50")}>
          {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-primary-600" />}
          <span aria-hidden="true" className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", row.seen ? "bg-transparent" : "bg-primary-600")} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2"><span className={clsx("truncate text-[13px] text-neutral-900", row.seen ? "font-semibold" : "font-extrabold")}>{who}</span><span className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-400">{row.flagged && <Star size={12} className="text-warning-text" aria-label="Starred" />}{row.hasAttachments && <Paperclip size={12} aria-label="Has attachments" />}<time dateTime={row.date} className="tnum">{shortDate(row.date, now)}</time></span></span>
            <span className={clsx("mt-0.5 block truncate text-xs", row.seen ? "text-neutral-500" : "font-semibold text-neutral-800")}>{row.subject || "(no subject)"}</span>
            {(row.lead || row.track) && <span className="mt-1.5 block"><MailChips row={row} /></span>}
          </span>
        </button></li>;
      })}</ul>}
    {shownList?.nextBefore && <div className="p-3"><button type="button" disabled={listBusy} onClick={() => void loadList(shownList.nextBefore)} className={clsx(secondaryClass, "w-full justify-center")}>{listBusy ? "Loading…" : "Older messages"}</button></div>}
  </>;

  const selectedRow = rows.find((row) => row.uid === uid);
  const readerPane = !readerOpen ? <div className="grid h-full place-items-center p-6"><EmptyState variant="select" icon={Mail} title="Pick a message to read" body="Your mail, straight from your mail server. Replies you send here go from your own address and are noted on the lead." /></div>
    : messageError && !shownMessage ? <div className="p-4"><BackButton onBack={() => setUidParam("")} desktop={desktop} /><EmptyState variant="error" title="Could not open this message" body={messageError} action={{ label: "Back to the list", onClick: () => setUidParam("") }} /></div>
    : !shownMessage ? <div role="status" aria-label="Opening the message" className="space-y-4 p-5"><span className="vso-skeleton block h-6 w-2/3" /><span className="vso-skeleton block h-4 w-1/3" /><span className="vso-skeleton block h-64 rounded-2xl" /></div>
    : <MailReader key={messageKey} message={shownMessage} folder={folder} role={current?.role ?? "other"} accountId={accountId} desktop={desktop} onBack={() => setUidParam("")} onLead={openLead} onAct={(what) => void act(selectedRow ?? shownMessage, what)} onCompose={(mode) => setCompose({ mode, source: { folder, message: shownMessage } })} hasArchive={Boolean(folderList?.some((entry) => entry.role === "archive"))} />;

  const window_ = "overflow-hidden rounded-2xl border border-neutral-100 bg-white shadow-card";
  return <>
    {!(readerOpen && !desktop) && toolbar}
    {banner}
    {/* On a laptop one mail window the height of the screen: folders, messages and the open message side by side, each scrolling on its
        own. On a phone the list and the message take turns. */}
    {desktop
      ? <div className={clsx(window_, "grid min-h-[520px]", wide ? "grid-cols-[208px_340px_minmax(0,1fr)]" : "grid-cols-[300px_minmax(0,1fr)]", banner ? "h-[calc(100dvh-19.75rem)]" : "h-[calc(100dvh-16.25rem)]")}>
        {wide && <aside className="thin-scroll min-h-0 overflow-y-auto border-r border-neutral-100 bg-neutral-50">{folderPane}</aside>}
        <section aria-label="Messages" className="thin-scroll min-h-0 overflow-y-auto border-r border-neutral-100">{listPane}</section>
        <section aria-label="Message" className="flex min-h-0 min-w-0 flex-col">{readerPane}</section>
      </div>
      : <div className={window_}>{readerOpen ? readerPane : listPane}</div>}
    {compose && <MailCompose account={account} start={compose} onClose={() => setCompose(null)} onSent={() => { setCompose(null); window.setTimeout(() => setTick((value) => value + 1), 1_500); }} />}
  </>;
}

function BackButton({ onBack, desktop }: { onBack: () => void; desktop: boolean }) {
  if (desktop) return null;
  return <button type="button" onClick={onBack} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-100"><ArrowLeft size={15} />Back</button>;
}

function MailReader({ message, folder, role, accountId, desktop, onBack, onLead, onAct, onCompose, hasArchive }: {
  message: MailMessage; folder: string; role: MailFolder["role"]; accountId: string; desktop: boolean; onBack: () => void; onLead: (leadId: string) => void;
  onAct: (what: "unread" | "star" | "unstar" | "trash" | "junk" | "inbox" | "archive") => void; onCompose: (mode: "reply" | "reply_all" | "forward") => void; hasArchive: boolean;
}) {
  const [pictures, setPictures] = useState(false);
  const [plain, setPlain] = useState(!message.html);
  const [downloading, setDownloading] = useState("");
  const others = message.to.length + message.cc.length > 1;
  const files = message.attachments.filter((file) => !file.inline);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!desktop) top.current?.scrollIntoView({ block: "start" }); }, [desktop]);
  const tool = "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";

  async function save(part: string, filename: string) {
    setDownloading(part);
    try { await downloadAttachment(accountId, folder, message.uid, part, filename); }
    catch (cause) { toast({ tone: "error", title: "Couldn't download it", body: describeError(cause, "Try again.") }); }
    finally { setDownloading(""); }
  }

  const fill = desktop ? "h-full" : "";
  return <article ref={top} className={clsx("scroll-mt-4", desktop && "flex h-full min-h-0 flex-col")}>
    {/* The actions stay at the top of the message. */}
    <div className="@container thin-scroll flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-neutral-100 px-2 py-1.5">
      <BackButton onBack={onBack} desktop={desktop} />
      {/* On a phone Reply and Forward sit at the bottom of the message instead. */}
      {desktop && <>
        <button type="button" onClick={() => onCompose("reply")} className={tool}><Reply size={15} />Reply</button>
        {others && <button type="button" onClick={() => onCompose("reply_all")} title="Reply all" className={tool}><ReplyAll size={15} /><span className="@max-[30rem]:sr-only">Reply all</span></button>}
        <button type="button" onClick={() => onCompose("forward")} title="Forward" className={tool}><Forward size={15} /><span className="@max-[30rem]:sr-only">Forward</span></button>
        <span className="mx-1 h-5 w-px shrink-0 bg-neutral-200" aria-hidden="true" />
      </>}
      {!desktop && <span className="flex-1" aria-hidden="true" />}
      <button type="button" onClick={() => onAct(message.flagged ? "unstar" : "star")} aria-pressed={message.flagged} title={message.flagged ? "Starred" : "Star"} className={tool}><Star size={15} className={message.flagged ? "text-warning-text" : ""} /><span className="@max-[44rem]:sr-only">{message.flagged ? "Starred" : "Star"}</span></button>
      <button type="button" onClick={() => onAct("unread")} title="Mark unread" className={tool}><Mail size={15} /><span className="@max-[44rem]:sr-only">Unread</span></button>
      {hasArchive && role !== "archive" && <button type="button" onClick={() => onAct("archive")} title="Archive" className={tool}><Archive size={15} /><span className="@max-[44rem]:sr-only">Archive</span></button>}
      {role === "junk" ? <button type="button" onClick={() => onAct("inbox")} title="Not spam" className={tool}><RotateCcw size={15} /><span className="@max-[44rem]:sr-only">Not spam</span></button>
        : role !== "sent" && role !== "drafts" && <button type="button" onClick={() => onAct("junk")} title="Spam" className={tool}><AlertTriangle size={15} /><span className="@max-[44rem]:sr-only">Spam</span></button>}
      {role === "trash" ? <button type="button" onClick={() => onAct("inbox")} title="Back to Inbox" className={tool}><RotateCcw size={15} /><span className="@max-[44rem]:sr-only">Back to Inbox</span></button>
        : <button type="button" onClick={() => onAct("trash")} title="Delete" className={clsx(tool, "hover:!text-danger-text")}><Trash size={15} /><span className="@max-[44rem]:sr-only">Delete</span></button>}
    </div>
    <div className="shrink-0 px-5 pb-3 pt-4">
      <h2 className="text-lg font-extrabold leading-7 tracking-[-.01em] text-neutral-900 [overflow-wrap:anywhere]">{message.subject || "(no subject)"}</h2>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-[13px] leading-5">
        <p className="min-w-0 [overflow-wrap:anywhere]"><span className="font-semibold text-neutral-900">{message.from[0]?.name || message.from[0]?.address || "(unknown)"}</span>{message.from[0]?.name && <span className="text-neutral-500"> &lt;{message.from[0].address}&gt;</span>}</p>
        <time dateTime={message.date} className="shrink-0 text-xs text-neutral-500">{fullDate(message.date)}</time>
      </div>
      <p className="mt-0.5 text-xs leading-5 text-neutral-500 [overflow-wrap:anywhere]">To {message.to.map((entry) => entry.name ? `${entry.name} <${entry.address}>` : entry.address).join(", ") || "(no one)"}{message.cc.length > 0 && <>, Cc {message.cc.map((entry) => entry.address).join(", ")}</>}</p>
      {(message.lead || message.track) && <div className="mt-2"><MailChips row={message} onLead={onLead} /></div>}
      {message.track?.state === "bounced" && <p className="mt-3 rounded-xl bg-danger-surface p-3 text-sm text-danger-text">This email bounced: it never reached {message.track.companyName}. Sales won&apos;t email that address again.</p>}
      {message.truncated && <p className="mt-3 rounded-xl bg-neutral-50 p-3 text-xs text-neutral-600">This message is very large: only its first part is shown. Attachments up to 25 MB still download from the list below.</p>}
      {message.html && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {!plain && message.remoteImages && !pictures && <span className="flex items-start gap-2 rounded-xl bg-neutral-50 px-3 py-1.5 text-xs leading-5 text-neutral-600"><Eye size={14} className="mt-[3px] shrink-0" /><span>Pictures are hidden, so the sender can&apos;t tell you opened it. <button type="button" onClick={() => setPictures(true)} className="font-semibold text-primary-700 hover:underline">Show pictures</button></span></span>}
        <button type="button" onClick={() => setPlain((value) => !value)} className="text-xs font-semibold text-primary-700 hover:underline">{plain ? "Show the formatted message" : "Show as plain text"}</button>
      </div>}
    </div>
    {/* The message fills the rest of the window and scrolls inside it. */}
    <div className={clsx("px-5 pb-4", desktop && "min-h-[200px] flex-1")}>
      {message.html && !plain ? <MailFrame html={message.html} pictures={pictures} className={desktop ? "h-full" : "h-[70dvh] min-h-[320px]"} />
        : <div className={clsx("thin-scroll whitespace-pre-wrap rounded-xl border border-neutral-100 bg-white p-4 text-sm leading-6 text-neutral-800 [overflow-wrap:anywhere]", fill, desktop && "overflow-y-auto")}>{message.text || "(no text)"}</div>}
    </div>
    {files.length > 0 && <div className={clsx("shrink-0 border-t border-neutral-100 px-5 py-3", desktop && "thin-scroll max-h-36 overflow-y-auto")}>
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500">{files.length === 1 ? "1 attachment" : `${files.length} attachments`}</h3>
      <ul className="grid gap-1.5 sm:grid-cols-2">{files.map((file) => <li key={file.part}><button type="button" onClick={() => void save(file.part, file.filename)} disabled={downloading === file.part} className="flex w-full items-center gap-2.5 rounded-xl border border-neutral-100 px-3 py-2.5 text-left text-sm transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
        <Paperclip size={15} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="min-w-0 flex-1 truncate font-medium text-neutral-800">{file.filename}</span><span className="tnum shrink-0 text-xs text-neutral-500">{sizeLabel(file.size)}</span>{downloading === file.part ? <span className="text-xs text-neutral-500">…</span> : <Download size={15} aria-hidden="true" className="shrink-0 text-neutral-500" />}
      </button></li>)}</ul>
    </div>}
    {!desktop && <div className="flex flex-wrap gap-2 border-t border-neutral-100 px-4 py-3">
      <button type="button" onClick={() => onCompose("reply")} className={clsx(primaryClass, "flex-1")}><Reply size={16} aria-hidden="true" />Reply</button>
      {others && <button type="button" onClick={() => onCompose("reply_all")} aria-label="Reply all" className={secondaryClass}><ReplyAll size={15} aria-hidden="true" /></button>}
      <button type="button" onClick={() => onCompose("forward")} className={secondaryClass}><Forward size={15} aria-hidden="true" />Forward</button>
      <button type="button" onClick={onBack} className={secondaryClass}><X size={15} aria-hidden="true" />Close</button>
    </div>}
  </article>;
}

function MailSkeleton() {
  return <div role="status" aria-label="Loading your mail" className="grid h-[calc(100dvh-16.25rem)] min-h-[520px] overflow-hidden rounded-2xl border border-neutral-100 bg-white shadow-card lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[208px_340px_minmax(0,1fr)]">
    <div className="space-y-2 border-r border-neutral-100 bg-neutral-50 p-3 max-xl:hidden">{[0, 1, 2, 3, 4].map((index) => <span key={index} className="vso-skeleton block h-8 rounded-lg" />)}</div>
    <div className="space-y-4 border-r border-neutral-100 p-4">{[0, 1, 2, 3].map((index) => <div key={index} className="grid gap-2"><span className="vso-skeleton h-3 w-1/2" /><span className="vso-skeleton h-2.5 w-4/5" /></div>)}</div>
    <div className="space-y-4 p-5 max-lg:hidden"><span className="vso-skeleton block h-5 w-1/3" /><span className="vso-skeleton block h-40 rounded-2xl" /></div>
  </div>;
}
