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
import { kbdClass, typingTarget, useIsDesktop, useQueryParam } from "@/components/sales/draft-shared";
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
  const toolbar = <div className="mb-4 flex flex-wrap items-center gap-2">
    {accounts.length > 1 && <div className="w-full sm:w-64"><Select aria-label="Mailbox" className={inputClass} value={account.id} onChange={(event) => { setParams({ box: event.target.value, folder: null, uid: null }, "push"); setQuery(""); setSearch(""); }}>{accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.address}</option>)}</Select></div>}
    {!desktop && folderList && <div className="min-w-0 flex-1 sm:w-56 sm:flex-none"><Select aria-label="Folder" className={inputClass} value={folder} onChange={(event) => pickFolder(event.target.value)}>{folderList.map((entry) => <option key={entry.path} value={entry.path}>{entry.name}{unreadLabel(entry) && entry.role !== "sent" && entry.role !== "trash" ? ` (${unreadLabel(entry)})` : ""}</option>)}</Select></div>}
    <form role="search" className="relative min-w-0 flex-1 sm:max-w-sm" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); setUidParam("", { replace: true }); }}>
      <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
      <input type="search" aria-label={`Search ${current?.name ?? "this folder"}`} placeholder={`Search ${current?.name ?? "this folder"}`} value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setSearch(""); }} className={clsx(inputClass, "!pl-9")} />
    </form>
    <span className="ml-auto flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-[11px] text-neutral-400 max-lg:hidden"><kbd className={kbdClass}>j</kbd><kbd className={kbdClass}>k</kbd>move<kbd className={clsx(kbdClass, "ml-1.5")}>c</kbd>write</span>
      <button type="button" onClick={() => setCompose({ mode: "new" })} className={primaryClass}><Edit size={16} aria-hidden="true" />Write</button>
    </span>
  </div>;

  const banner = account.status === "needs_attention"
    ? <p className="mb-3 flex items-start gap-2 rounded-xl bg-warning-surface p-3 text-sm font-semibold text-warning-text"><AlertTriangle size={16} className="mt-0.5 shrink-0" />Your mail server refused this mailbox&apos;s password. <Link href="/sales/live/channels" className="underline">Enter it again in Channels</Link>.</p>
    : null;

  const folderPane = <Panel className="thin-scroll overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto">
    <p className="truncate border-b border-neutral-100 px-4 py-3 text-xs font-semibold text-neutral-500" title={account.address}>{account.address}</p>
    {foldersError && !folderList ? <p className="p-4 text-sm text-danger-text">{foldersError}</p> : !folderList ? <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((index) => <span key={index} className="vso-skeleton block h-8 rounded-lg" />)}</div>
      : <nav aria-label="Folders" className="p-2"><ul className="grid gap-0.5">{folderList.map((entry) => {
        const Icon = ROLE_ICON[entry.role];
        const active = entry.path === folder;
        const count = entry.role === "inbox" || entry.role === "junk" || entry.role === "other" || entry.role === "archive" ? entry.unread : entry.role === "drafts" ? entry.total : 0;
        return <li key={entry.path}><button type="button" aria-current={active ? "page" : undefined} onClick={() => pickFolder(entry.path)} style={{ paddingLeft: `${12 + entry.depth * 14}px` }} className={clsx("flex min-h-9 w-full items-center gap-2.5 rounded-xl pr-3 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", active ? "bg-primary-50 font-bold text-primary-800" : "font-medium text-neutral-700 hover:bg-neutral-50")}>
          <Icon size={16} aria-hidden="true" className={active ? "text-primary-700" : "text-neutral-400"} /><span className="min-w-0 flex-1 truncate">{entry.name}</span>{count > 0 && <span className="tnum text-xs font-bold text-neutral-500">{count}</span>}
        </button></li>;
      })}</ul></nav>}
  </Panel>;

  const sentFolder = current?.role === "sent" || current?.role === "drafts";
  const listPane = <Panel className={clsx("thin-scroll overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto", readerOpen && !desktop && "hidden")}>
    <h2 className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white px-4 py-2.5 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500"><span className="truncate">{search ? `“${search}” in ${current?.name ?? "folder"}` : current?.name ?? "Messages"}</span>{shownList && <span className="tnum rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{shownList.total}</span>}</h2>
    {listError && !shownList ? <EmptyState variant="error" title="Could not read this folder" body={listError} action={{ label: "Try again", onClick: () => void loadList() }} />
      : !shownList ? <div role="status" aria-label="Loading messages" className="space-y-3 p-4">{[0, 1, 2, 3, 4].map((index) => <div key={index} className="grid gap-2"><span className="vso-skeleton h-3 w-1/2" /><span className="vso-skeleton h-2.5 w-4/5" /></div>)}</div>
      : rows.length === 0 ? <EmptyState variant="card" tone="green" icon={search ? Search : Inbox} title={search ? "Nothing matches" : "Nothing here"} body={search ? "Try other words, or clear the search." : `${current?.name ?? "This folder"} is empty.`} />
      : <ul>{rows.map((row) => {
        const active = row.uid === uid;
        const who = sentFolder ? `To: ${row.to.map(personLabel).join(", ") || "(no one)"}` : personLabel(row.from[0]) || "(unknown sender)";
        return <li key={row.uid}><button type="button" aria-current={active ? "true" : undefined} onClick={() => open(row)} className={clsx("flex w-full items-start gap-2.5 border-b border-neutral-50 px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600", active ? "bg-primary-50" : "hover:bg-neutral-50")}>
          <span aria-hidden="true" className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", row.seen ? "bg-transparent" : "bg-primary-600")} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2"><span className={clsx("truncate text-[13px] text-neutral-900", row.seen ? "font-semibold" : "font-extrabold")}>{who}</span><span className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-400">{row.flagged && <Star size={12} className="text-warning-text" aria-label="Starred" />}{row.hasAttachments && <Paperclip size={12} aria-label="Has attachments" />}<time dateTime={row.date} className="tnum">{shortDate(row.date, now)}</time></span></span>
            <span className={clsx("mt-0.5 block truncate text-xs", row.seen ? "text-neutral-500" : "font-semibold text-neutral-800")}>{row.subject || "(no subject)"}</span>
            {(row.lead || row.track) && <span className="mt-1.5 block"><MailChips row={row} /></span>}
          </span>
        </button></li>;
      })}</ul>}
    {shownList?.nextBefore && <div className="p-3"><button type="button" disabled={listBusy} onClick={() => void loadList(shownList.nextBefore)} className={clsx(secondaryClass, "w-full justify-center")}>{listBusy ? "Loading…" : "Older messages"}</button></div>}
  </Panel>;

  const selectedRow = rows.find((row) => row.uid === uid);
  const reader = <div className={clsx("min-w-0", !readerOpen && !desktop && "hidden")}><Panel className="overflow-hidden">
    {!readerOpen ? <EmptyState variant="select" icon={Mail} title="Pick a message to read" body="Your mail, straight from your mail server. Replies you send here go from your own address and are noted on the lead." />
      : messageError && !shownMessage ? <div className="p-4"><BackButton onBack={() => setUidParam("")} desktop={desktop} /><EmptyState variant="error" title="Could not open this message" body={messageError} action={{ label: "Back to the list", onClick: () => setUidParam("") }} /></div>
      : !shownMessage ? <div role="status" aria-label="Opening the message" className="space-y-4 p-5"><span className="vso-skeleton block h-6 w-2/3" /><span className="vso-skeleton block h-4 w-1/3" /><span className="vso-skeleton block h-64 rounded-2xl" /></div>
      : <MailReader key={messageKey} message={shownMessage} folder={folder} role={current?.role ?? "other"} accountId={accountId} desktop={desktop} onBack={() => setUidParam("")} onLead={openLead} onAct={(what) => void act(selectedRow ?? shownMessage, what)} onCompose={(mode) => setCompose({ mode, source: { folder, message: shownMessage } })} hasArchive={Boolean(folderList?.some((entry) => entry.role === "archive"))} />}
  </Panel></div>;

  return <>
    {!(readerOpen && !desktop) && toolbar}
    {banner}
    <div className="grid items-start gap-4 lg:grid-cols-[210px_340px_minmax(0,1fr)]">
      {desktop && folderPane}
      {listPane}
      {reader}
    </div>
    {compose && <MailCompose account={account} start={compose} onClose={() => setCompose(null)} onSent={() => { setCompose(null); window.setTimeout(() => setTick((value) => value + 1), 1_500); }} />}
  </>;
}

function BackButton({ onBack, desktop }: { onBack: () => void; desktop: boolean }) {
  if (desktop) return null;
  return <button type="button" onClick={onBack} className="mb-3 inline-flex min-h-10 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-100"><ArrowLeft size={15} />Back</button>;
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
  const iconButton = "inline-flex min-h-9 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";

  async function save(part: string, filename: string) {
    setDownloading(part);
    try { await downloadAttachment(accountId, folder, message.uid, part, filename); }
    catch (cause) { toast({ tone: "error", title: "Couldn't download it", body: describeError(cause, "Try again.") }); }
    finally { setDownloading(""); }
  }

  return <article ref={top} className="scroll-mt-4 p-4 sm:p-5">
    <BackButton onBack={onBack} desktop={desktop} />
    <div className="flex flex-wrap items-center gap-1 border-b border-neutral-100 pb-3">
      <button type="button" onClick={() => onCompose("reply")} className={iconButton}><Reply size={15} />Reply</button>
      {others && <button type="button" onClick={() => onCompose("reply_all")} className={iconButton}><ReplyAll size={15} />Reply all</button>}
      <button type="button" onClick={() => onCompose("forward")} className={iconButton}><Forward size={15} />Forward</button>
      <span className="mx-1 h-5 w-px bg-neutral-200" aria-hidden="true" />
      <button type="button" onClick={() => onAct(message.flagged ? "unstar" : "star")} aria-pressed={message.flagged} className={iconButton}><Star size={15} className={message.flagged ? "text-warning-text" : ""} />{message.flagged ? "Starred" : "Star"}</button>
      <button type="button" onClick={() => onAct("unread")} className={iconButton}><Mail size={15} />Unread</button>
      {hasArchive && role !== "archive" && <button type="button" onClick={() => onAct("archive")} className={iconButton}><Archive size={15} />Archive</button>}
      {role === "junk" ? <button type="button" onClick={() => onAct("inbox")} className={iconButton}><RotateCcw size={15} />Not spam</button>
        : role !== "sent" && role !== "drafts" && <button type="button" onClick={() => onAct("junk")} className={iconButton}><AlertTriangle size={15} />Spam</button>}
      {role === "trash" ? <button type="button" onClick={() => onAct("inbox")} className={iconButton}><RotateCcw size={15} />Back to Inbox</button>
        : <button type="button" onClick={() => onAct("trash")} className={clsx(iconButton, "hover:!text-danger-text")}><Trash size={15} />Delete</button>}
    </div>
    <h2 className="mt-4 text-lg font-extrabold leading-7 tracking-[-.01em] text-neutral-900 [overflow-wrap:anywhere]">{message.subject || "(no subject)"}</h2>
    <dl className="mt-3 grid gap-1 text-[13px] leading-5">
      <div className="flex gap-2"><dt className="w-10 shrink-0 text-neutral-400">From</dt><dd className="min-w-0 [overflow-wrap:anywhere]"><span className="font-semibold text-neutral-900">{message.from[0]?.name || message.from[0]?.address || "(unknown)"}</span>{message.from[0]?.name && <span className="text-neutral-500"> &lt;{message.from[0].address}&gt;</span>}</dd></div>
      <div className="flex gap-2"><dt className="w-10 shrink-0 text-neutral-400">To</dt><dd className="min-w-0 text-neutral-700 [overflow-wrap:anywhere]">{message.to.map((entry) => entry.name ? `${entry.name} <${entry.address}>` : entry.address).join(", ") || "(no one)"}</dd></div>
      {message.cc.length > 0 && <div className="flex gap-2"><dt className="w-10 shrink-0 text-neutral-400">Cc</dt><dd className="min-w-0 text-neutral-700 [overflow-wrap:anywhere]">{message.cc.map((entry) => entry.address).join(", ")}</dd></div>}
      <div className="flex gap-2"><dt className="w-10 shrink-0 text-neutral-400">Date</dt><dd className="text-neutral-700">{fullDate(message.date)}</dd></div>
    </dl>
    {(message.lead || message.track) && <div className="mt-3"><MailChips row={message} onLead={onLead} /></div>}
    {message.track?.state === "bounced" && <p className="mt-3 rounded-xl bg-danger-surface p-3 text-sm text-danger-text">This email bounced: it never reached {message.track.companyName}. Sales won&apos;t email that address again.</p>}
    {message.truncated && <p className="mt-3 rounded-xl bg-neutral-50 p-3 text-xs text-neutral-600">This message is very large: only its first part is shown. Attachments up to 25 MB still download from the list below.</p>}
    {message.html && <div className="mt-4 flex flex-wrap items-center gap-2">
      {!plain && message.remoteImages && !pictures && <span className="flex flex-wrap items-center gap-2 rounded-xl bg-neutral-50 px-3 py-2 text-xs text-neutral-600"><Eye size={14} className="shrink-0" />Pictures from the internet are hidden, so the sender can&apos;t tell you opened it.<button type="button" onClick={() => setPictures(true)} className="font-semibold text-primary-700 hover:underline">Show pictures</button></span>}
      <button type="button" onClick={() => setPlain((value) => !value)} className="text-xs font-semibold text-primary-700 hover:underline">{plain ? "Show the formatted message" : "Show as plain text"}</button>
    </div>}
    <div className="mt-3">
      {message.html && !plain ? <MailFrame html={message.html} pictures={pictures} /> : <div className="whitespace-pre-wrap rounded-xl border border-neutral-100 bg-white p-4 text-sm leading-6 text-neutral-800 [overflow-wrap:anywhere]">{message.text || "(no text)"}</div>}
    </div>
    {files.length > 0 && <div className="mt-4">
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500">{files.length === 1 ? "1 attachment" : `${files.length} attachments`}</h3>
      <ul className="grid gap-1.5 sm:grid-cols-2">{files.map((file) => <li key={file.part}><button type="button" onClick={() => void save(file.part, file.filename)} disabled={downloading === file.part} className="flex w-full items-center gap-2.5 rounded-xl border border-neutral-100 px-3 py-2.5 text-left text-sm transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
        <Paperclip size={15} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="min-w-0 flex-1 truncate font-medium text-neutral-800">{file.filename}</span><span className="tnum shrink-0 text-xs text-neutral-500">{sizeLabel(file.size)}</span>{downloading === file.part ? <span className="text-xs text-neutral-500">…</span> : <Download size={15} aria-hidden="true" className="shrink-0 text-neutral-500" />}
      </button></li>)}</ul>
    </div>}
    <div className="mt-5 flex flex-wrap gap-2 border-t border-neutral-100 pt-4">
      <button type="button" onClick={() => onCompose("reply")} className={primaryClass}><Reply size={16} aria-hidden="true" />Reply</button>
      {others && <button type="button" onClick={() => onCompose("reply_all")} className={secondaryClass}><ReplyAll size={15} aria-hidden="true" />Reply all</button>}
      <button type="button" onClick={() => onCompose("forward")} className={secondaryClass}><Forward size={15} aria-hidden="true" />Forward</button>
      {!desktop && <button type="button" onClick={onBack} className={clsx(secondaryClass, "ml-auto")}><X size={15} aria-hidden="true" />Close</button>}
    </div>
  </article>;
}

function MailSkeleton() {
  return <div role="status" aria-label="Loading your mail" className="grid gap-4 lg:grid-cols-[210px_340px_minmax(0,1fr)]">
    <Panel className="space-y-2 p-4 max-lg:hidden">{[0, 1, 2, 3, 4].map((index) => <span key={index} className="vso-skeleton block h-8 rounded-lg" />)}</Panel>
    <Panel className="space-y-3 p-4">{[0, 1, 2, 3].map((index) => <div key={index} className="grid gap-2"><span className="vso-skeleton h-3 w-1/2" /><span className="vso-skeleton h-2.5 w-4/5" /></div>)}</Panel>
    <Panel className="space-y-4 p-5 max-lg:hidden"><span className="vso-skeleton block h-5 w-1/3" /><span className="vso-skeleton block h-40 rounded-2xl" /></Panel>
  </div>;
}
