"use client";
import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Paperclip, Send, X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { ActionLabel, DetailDrawer, Field, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { attachmentOf, sendMail, type MailAccount, type MailMessage, type MailRow } from "@/lib/sales-mail-api";

// The pieces of Mail (screens/sales/mail.tsx): the sandboxed frame a message's HTML is shown in, the chips that say what a message is to
// Sales, and the window a message is written in.

/**
 * A message's HTML (already cleaned by the API) in a frame that runs no script, sends no form, can't reach this page and loads nothing from
 * the internet: pictures only when the reader asks (`pictures`), since a picture can tell the sender the message was opened. Links open in
 * a new tab.
 */
export function MailFrame({ html, pictures, className }: { html: string; pictures: boolean; className?: string | undefined }) {
  const doc = useMemo(() => {
    const policy = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${pictures ? " https: http:" : ""}; media-src 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;background:#fff;color:#111827;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}body{padding:16px}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
  }, [html, pictures]);
  return <iframe title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={doc} className={clsx("block w-full rounded-xl border border-neutral-100 bg-white", className ?? "h-[70dvh] min-h-[320px]")} />;
}

const TRACK = {
  sent: { label: "No reply yet", tone: "bg-neutral-100 text-neutral-600" },
  replied: { label: "Replied", tone: "bg-success-surface text-success-text" },
  bounced: { label: "Bounced", tone: "bg-danger-surface text-danger-text" },
  uncertain: { label: "May not have gone", tone: "bg-warning-surface text-warning-text" },
} as const;

/** What a message is to Sales: the lead it is with, and what became of an email Sales sent. */
export function MailChips({ row, onLead }: { row: Pick<MailRow, "lead" | "track">; onLead?: ((leadId: string) => void) | undefined }) {
  const lead = row.track ? { leadId: row.track.leadId, companyName: row.track.companyName } : row.lead;
  if (!lead && !row.track) return null;
  const chip = "inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold";
  return <span className="flex min-w-0 flex-wrap items-center gap-1.5">
    {lead && (onLead
      ? <button type="button" onClick={(event) => { event.stopPropagation(); onLead(lead.leadId); }} className={clsx(chip, "truncate bg-primary-50 text-primary-700 hover:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600")}>Lead · {lead.companyName}</button>
      : <span className={clsx(chip, "truncate bg-primary-50 text-primary-700")}>Lead · {lead.companyName}</span>)}
    {row.track && <span className={clsx(chip, TRACK[row.track.state].tone)}>{TRACK[row.track.state].label}</span>}
  </span>;
}

export const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);
export const personLabel = (entry: { name?: string | undefined; address: string } | undefined) => (entry ? entry.name || entry.address : "");

export type ComposeMode = "new" | "reply" | "reply_all" | "forward";
export type ComposeStart = { mode: ComposeMode; source?: { folder: string; message: MailMessage } };

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** Addresses typed in a field: commas, semicolons, spaces or new lines between them; "Name <a@b.c>" keeps the address. */
export function parseAddresses(text: string): { addresses: string[]; bad: string[] } {
  const parts = text.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean).flatMap((part) => (/<[^>]+>/.test(part) ? [part.match(/<([^>]+)>/)![1]!.trim()] : part.split(/\s+/)));
  const addresses: string[] = [];
  const bad: string[] = [];
  for (const part of parts) { const address = part.toLowerCase(); if (ADDRESS.test(address)) { if (!addresses.includes(address)) addresses.push(address); } else bad.push(part); }
  return { addresses, bad };
}

const prefixed = (prefix: "Re" | "Fwd", subject: string) => {
  const bare = subject.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim();
  return `${prefix}: ${bare}`.trim();
};

/** Who a reply goes to: the Reply-To address or the sender; to all adds the other recipients (never this mailbox). */
function recipientsFor(start: ComposeStart, own: string): { to: string; cc: string; subject: string } {
  const message = start.source?.message;
  if (!message || start.mode === "new") return { to: "", cc: "", subject: "" };
  if (start.mode === "forward") return { to: "", cc: "", subject: prefixed("Fwd", message.subject) };
  const fromUs = message.from.some((entry) => entry.address === own);
  const first = fromUs ? message.to : message.replyTo.length ? message.replyTo : message.from;
  const to = first.map((entry) => entry.address).filter((address) => address !== own);
  const cc = start.mode === "reply_all" ? [...message.to, ...message.cc].map((entry) => entry.address).filter((address) => address !== own && !to.includes(address)) : [];
  return { to: to.join(", "), cc: [...new Set(cc)].join(", "), subject: prefixed("Re", message.subject) };
}

const TITLES: Record<ComposeMode, string> = { new: "New message", reply: "Reply", reply_all: "Reply to all", forward: "Forward" };

/** The window a message is written in: to, cc, subject, text and attachments, sent from the person's own mailbox. */
export function MailCompose({ account, start, onClose, onSent }: { account: MailAccount; start: ComposeStart; onClose: () => void; onSent: () => void }) {
  const initial = useMemo(() => recipientsFor(start, account.address), [start, account.address]);
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [showCc, setShowCc] = useState(Boolean(initial.cc));
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const picker = useRef<HTMLInputElement>(null);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const dirty = Boolean(body.trim() || files.length || (start.mode === "new" && (to.trim() || subject.trim())));
  const original = start.source?.message;

  async function send() {
    const toList = parseAddresses(to);
    const ccList = parseAddresses(showCc ? cc : "");
    const bad = [...toList.bad, ...ccList.bad];
    if (bad.length) { setError(`Check ${bad.length === 1 ? "this address" : "these addresses"}: ${bad.slice(0, 3).join(", ")}`); return; }
    if (!toList.addresses.length) { setError("Add who it goes to"); return; }
    if (total > 10 * 1024 * 1024) { setError("Attachments can be 10 MB at most in all"); return; }
    if (!subject.trim() && !window.confirm("Send it without a subject?")) return;
    setBusy(true); setError("");
    try {
      const attachments = await Promise.all(files.map(attachmentOf));
      const result = await sendMail(account.id, {
        mode: start.mode, ...(start.source ? { source: { folder: start.source.folder, uid: start.source.message.uid } } : {}),
        to: toList.addresses, cc: ccList.addresses, subject: subject.trim(), body, attachments,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, requestId: requestId.current,
      });
      const noted = result.notedOn.length ? ` Noted on ${result.notedOn.map((lead) => lead.companyName).join(", ")}.` : "";
      if (result.state === "uncertain") toast({ tone: "error", title: "It may not have gone", body: result.warnings[0] ?? "Look in Sent before sending it again.", duration: 9000 });
      else toast({ title: "Sent", body: `${toList.addresses[0]}${toList.addresses.length + ccList.addresses.length > 1 ? ` and ${toList.addresses.length + ccList.addresses.length - 1} more` : ""}.${noted}` });
      for (const warning of result.state === "sent" ? result.warnings : []) toast({ tone: "info", title: "Sent, with a note", body: warning, duration: 9000 });
      onSent();
    } catch (cause) {
      setError(describeError(cause, "It didn't send. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((current) => [...current, ...Array.from(list)].slice(0, 10));
    if (picker.current) picker.current.value = "";
  }

  const footer = <div className="flex flex-wrap items-center gap-2">
    <button type="button" onClick={() => void send()} disabled={busy} className={clsx(primaryClass, "max-sm:flex-1")}><ActionLabel busy={busy} busyText="Sending…" idle={<><Send size={16} aria-hidden="true" />Send</>} /></button>
    <button type="button" onClick={() => picker.current?.click()} disabled={busy || files.length >= 10} className={secondaryClass}><Paperclip size={15} aria-hidden="true" />Attach</button>
    <input ref={picker} type="file" multiple hidden onChange={(event) => addFiles(event.target.files)} />
    <span className="ml-auto text-xs text-neutral-500 max-sm:w-full">From {account.address}</span>
  </div>;

  return <DetailDrawer layout="dialog" wide title={TITLES[start.mode]} subtitle={original ? original.subject || "(no subject)" : undefined} dirty={dirty} onClose={onClose} footer={footer}>
    <div className="grid gap-3">
      <Field label="To"><input autoFocus={start.mode === "new" || start.mode === "forward"} className={inputClass} value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@company.com" autoComplete="off" inputMode="email" /></Field>
      {showCc ? <Field label="Cc"><input className={inputClass} value={cc} onChange={(event) => setCc(event.target.value)} autoComplete="off" inputMode="email" /></Field>
        : <button type="button" onClick={() => setShowCc(true)} className="justify-self-start text-xs font-semibold text-primary-700 hover:underline">Add Cc</button>}
      <Field label="Subject"><input className={inputClass} value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={300} /></Field>
      <Field label="Message"><textarea autoFocus={start.mode === "reply" || start.mode === "reply_all"} className={clsx(inputClass, "min-h-[220px] resize-y leading-6")} value={body} onChange={(event) => setBody(event.target.value)} maxLength={50_000} /></Field>
      {original && <p className="text-xs leading-5 text-neutral-500">{start.mode === "forward" ? "The message and its attachments go under your text." : "The message you answer is quoted under your text."} Sent as plain text, with no tracking.</p>}
      {files.length > 0 && <ul className="grid gap-1.5">{files.map((file, index) => <li key={`${file.name}-${index}`} className="flex items-center gap-2 rounded-xl bg-neutral-50 px-3 py-2 text-sm">
        <Paperclip size={14} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="min-w-0 flex-1 truncate">{file.name}</span><span className="tnum text-xs text-neutral-500">{sizeLabel(file.size)}</span>
        <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_entry, at) => at !== index))} className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"><X size={14} /></button>
      </li>)}</ul>}
      {total > 10 * 1024 * 1024 && <p className="text-xs font-semibold text-danger-text">Attachments are {sizeLabel(total)}: 10 MB at most in all.</p>}
      {error && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    </div>
  </DetailDrawer>;
}
