"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { MAX_RECEIPT_BYTES, type ExpenseReceipt, type ReceiptData } from "@venture-studio/contracts";
import { AlertTriangle, FileText, Paperclip } from "@/components/ui/icons";
import { Notice, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { getReceipt, receiptFileUrl, uploadReceipt } from "@/lib/expenses-api";
import { isCompressibleImage, prepareUpload } from "@/lib/image-compress";

// A receipt in the expense form (docs/expenses.md): add a photo or PDF, the server keeps a small copy and Claude Haiku reads it, and the
// form shows it back as a clean paper receipt, next to the original. The paper stays light in dark mode, like a real one.

const KIND: Record<ReceiptData["kind"], string> = { receipt: "Receipt", tax_invoice: "Tax invoice", invoice: "Invoice", bill: "Bill", other: "Receipt" };
const PAID_BY: Record<ReceiptData["paymentMethod"], string> = { cash: "Cash", card: "Card", upi: "UPI", bank_transfer: "Bank transfer", wallet: "Wallet", other: "Other", unknown: "" };
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function money(value: number, currency: string | null) {
  if (currency) { try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(value); } catch { /* an unknown code: plain below */ } }
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const longDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A line that doesn't add up (within a rupee, for rounding): the items against the subtotal, or the subtotal, taxes and tip against the total. */
function mismatch(data: ReceiptData): string | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const items = data.items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  if (data.items.length && data.items.every((item) => item.amount !== null) && data.subtotal !== null && !near(items, data.subtotal)) return `The items add up to ${money(items, data.currency)}, not the subtotal of ${money(data.subtotal, data.currency)}.`;
  if (data.subtotal !== null && data.total !== null) {
    const expected = data.subtotal - (data.discount ?? 0) + data.taxes.reduce((sum, tax) => sum + tax.amount, 0) + (data.tip ?? 0);
    // Prices that include tax print a total equal to the subtotal.
    if (!near(expected, data.total) && !near(data.subtotal, data.total)) return `The subtotal, taxes and tip come to ${money(expected, data.currency)}, not the total of ${money(data.total, data.currency)}.`;
  }
  return null;
}

const Rule = ({ double }: { double?: boolean }) => <hr aria-hidden="true" className={clsx("my-3 border-0 border-t border-dashed border-[#d6d3d1]", double && "border-t-2")} />;
const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => <div className={clsx("flex justify-between gap-4", strong && "font-bold")}><dt>{label}</dt><dd className="tabular-nums">{value}</dd></div>;

/** The receipt as read: a paper slip with a torn bottom edge. */
export function ReceiptPaper({ data }: { data: ReceiptData }) {
  const m = (value: number) => money(value, data.currency);
  const warning = mismatch(data);
  const paidBy = [PAID_BY[data.paymentMethod], data.cardLast4 ? `•••• ${data.cardLast4}` : ""].filter(Boolean).join(" ");
  return <div className="grid gap-2">
    <div className="mx-auto w-full max-w-[22rem] [filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.08))_drop-shadow(0_8px_18px_rgb(0_0_0/0.10))]">
      <figure aria-label="The receipt, as read" className="bg-[#fffdf8] px-5 pb-8 pt-5 font-mono text-[12px] leading-5 text-[#1c1917] [mask:conic-gradient(from_-45deg_at_bottom,#0000,#000_1deg_89deg,#0000_90deg)_50%/14px_100%]">
        <header className="text-center">
          <p className="font-sans text-[15px] font-extrabold uppercase tracking-[0.06em]">{data.merchant ?? KIND[data.kind]}</p>
          {data.merchantAddress && <p className="text-[#78716c]">{data.merchantAddress}</p>}
          {data.merchantPhone && <p className="text-[#78716c]">{data.merchantPhone}</p>}
          {data.merchantTaxId && <p className="text-[#78716c]">{GSTIN.test(data.merchantTaxId) ? "GSTIN" : "Tax ID"} {data.merchantTaxId}</p>}
        </header>
        <Rule />
        <dl className="grid gap-0.5">
          <Row label={`${KIND[data.kind]} no.`} value={data.number ?? "–"} />
          {(data.date || data.time) && <Row label="Date" value={[data.date ? longDay(data.date) : "", data.time ?? ""].filter(Boolean).join(", ")} />}
          {data.billedTo && <Row label="Billed to" value={data.billedTo} />}
        </dl>
        {data.items.length > 0 && <><Rule />
          <ul className="grid gap-1">{data.items.map((item, index) => <li key={index} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
            <span className="min-w-0 break-words">{item.quantity !== null && item.quantity !== 1 ? `${item.quantity} × ` : ""}{item.name}{item.unitPrice !== null && item.quantity !== null && item.quantity !== 1 && <span className="block text-[#78716c]">@ {m(item.unitPrice)}</span>}</span>
            <span className="tabular-nums">{item.amount !== null ? m(item.amount) : ""}</span>
          </li>)}</ul></>}
        <Rule />
        <dl className="grid gap-0.5">
          {data.subtotal !== null && <Row label="Subtotal" value={m(data.subtotal)} />}
          {data.discount !== null && <Row label="Discount" value={`−${m(Math.abs(data.discount))}`} />}
          {data.taxes.map((tax, index) => <Row key={index} label={`${tax.label}${tax.ratePercent !== null && !tax.label.includes("%") ? ` ${tax.ratePercent}%` : ""}`} value={m(tax.amount)} />)}
          {data.tip !== null && <Row label="Tip / service" value={m(data.tip)} />}
        </dl>
        <Rule double />
        <p className="flex justify-between gap-4 font-sans text-[15px] font-extrabold"><span>Total</span><span className="tabular-nums">{data.total !== null ? m(data.total) : "–"}</span></p>
        {paidBy && <p className="mt-1 text-[#78716c]">Paid by {paidBy}</p>}
        {data.footer && <p className="mt-3 text-center italic text-[#78716c]">{data.footer}</p>}
      </figure>
    </div>
    {warning && <p className="flex items-start gap-1.5 text-xs leading-5 text-warning-text"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{warning} Check it against the original.</p>}
  </div>;
}

type Props = {
  receiptId: string | null; canEdit: boolean;
  /** A receipt was added (fresh: just read, so the form may fill itself in), or removed (null). */
  onReceipt: (receipt: ExpenseReceipt | null, fresh: boolean) => void;
};

/** Add, show, replace or remove the expense's receipt. */
export function ReceiptSection({ receiptId, canEdit, onReceipt }: Props) {
  const [receipt, setReceipt] = useState<ExpenseReceipt | null>(null);
  const [busy, setBusy] = useState<"loading" | "reading" | null>(receiptId ? "loading" : null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Reading takes seconds and the form stays editable meanwhile: the answer goes to the form as it is then, not as it was when picked.
  const latest = useRef(onReceipt);
  useEffect(() => { latest.current = onReceipt; });
  const shown = receipt && receipt.id === receiptId ? receipt : null;

  // The receipt the expense already has, when the form opens on it.
  useEffect(() => {
    if (!receiptId || receipt?.id === receiptId) return;
    let live = true;
    getReceipt(receiptId).then((found) => { if (live) setReceipt(found); })
      .catch((cause: unknown) => { if (live) setError(describeError(cause, "Couldn't load the receipt.")); })
      .finally(() => { if (live) setBusy(null); });
    return () => { live = false; };
  }, [receiptId, receipt?.id]);
  // The kept copy, fetched only when it is shown (a PDF can be large): asked for, or a photo that couldn't be read. Let go when the
  // receipt changes or the form closes.
  const wantsCopy = Boolean(shown && (showOriginal || (!shown.data && shown.contentType === "image/webp")));
  const shownId = shown?.id;
  useEffect(() => {
    if (!shownId || !wantsCopy || preview?.id === shownId) return;
    let live = true;
    receiptFileUrl(shownId).then((url) => { if (live) setPreview({ id: shownId, url }); else URL.revokeObjectURL(url); })
      .catch((cause: unknown) => { if (live) setError(describeError(cause, "Couldn't load the original.")); });
    return () => { live = false; };
  }, [shownId, wantsCopy, preview?.id]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  async function add(file: File) {
    setError("");
    setBusy("reading");
    try {
      // Photos shrink first, like chat images (the server keeps a smaller copy still); a PDF goes as it is.
      const sent = isCompressibleImage(file.type) ? (await prepareUpload(file, { hd: false })).file : file;
      if (sent.size > MAX_RECEIPT_BYTES) { setError("That file is over 10 MB: pick a smaller photo or PDF."); return; }
      const added = await uploadReceipt(sent);
      setReceipt(added); latest.current(added, true);
    } catch (cause) { setError(describeError(cause, "Couldn't add the receipt. Try again.")); }
    finally { setBusy(null); if (input.current) input.current.value = ""; }
  }

  if (!canEdit && !receiptId) return null;
  const copy = preview && shown && preview.id === shown.id ? preview.url : null;
  const picker = <input ref={input} type="file" accept="image/*,application/pdf" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; if (file) void add(file); }} />;
  return <section aria-label="Receipt" className="grid gap-3">
    {busy === "loading" ? <div className="h-16 animate-pulse rounded-2xl bg-neutral-100" aria-label="Loading the receipt" />
      : !shown ? <button type="button" disabled={busy !== null} onClick={() => input.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void add(file); }}
          className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-3 text-left transition-transform duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-progress">
          <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-primary-700 shadow-sm">{busy === "reading" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-200 border-t-primary-700" /> : <Paperclip size={18} />}</span>
          <span className="min-w-0" aria-live="polite"><span className="block text-sm font-bold text-neutral-900">{busy === "reading" ? "Reading the receipt…" : "Add a receipt"}</span><span className="block text-xs leading-5 text-neutral-500">{busy === "reading" ? "Filling in the details from it. This takes a few seconds." : "A photo or PDF, up to 10 MB. It fills in the details for you."}</span></span>
        </button>
      : <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-neutral-900"><FileText size={15} aria-hidden="true" />Receipt</h3>
          <span className="flex flex-wrap gap-2">
            <button type="button" aria-expanded={showOriginal} onClick={() => setShowOriginal(!showOriginal)} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>{showOriginal ? "Hide original" : "Original"}</button>
            {canEdit && <button type="button" disabled={busy !== null} onClick={() => input.current?.click()} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>{busy === "reading" ? "Reading…" : "Replace"}</button>}
            {canEdit && <button type="button" disabled={busy !== null} onClick={() => { setReceipt(null); latest.current(null, false); }} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>Remove</button>}
          </span>
        </div>
        {showOriginal && <div className="grid gap-2">
          {!copy ? <div className="h-40 animate-pulse rounded-xl bg-neutral-100" aria-label="Loading the original" />
            : shown.contentType === "application/pdf" ? <iframe src={copy} title="The receipt as uploaded" className="h-[28rem] w-full rounded-xl border border-neutral-200 bg-white" />
            // eslint-disable-next-line @next/next/no-img-element -- an authorized blob link can't use Next image optimization
            : <img src={copy} alt="The receipt as uploaded" className="max-h-[32rem] w-auto justify-self-center rounded-xl border border-neutral-200" />}
          {copy && <a href={copy} target="_blank" rel="noopener noreferrer" className="justify-self-start text-xs font-semibold text-primary-700 underline-offset-2 hover:underline">Open in a new tab</a>}
        </div>}
        {shown.data ? <ReceiptPaper data={shown.data} />
          : <div className="grid gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">
            <p>{shown.error ?? "Couldn't read this receipt."} The original is kept with the expense.</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- an authorized blob link can't use Next image optimization */}
            {copy && !showOriginal && <img src={copy} alt="The receipt as uploaded" className="max-h-72 w-auto self-start rounded-lg border border-neutral-200" />}
          </div>}
      </>}
    {canEdit && picker}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
  </section>;
}
