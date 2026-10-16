"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { MAX_RECEIPT_BYTES, type ExpenseCompany, type ExpenseReceipt, type ReceiptBlock, type ReceiptData } from "@venture-studio/contracts";
import { AlertTriangle, Camera, CameraSwitch, FileText, Paperclip, QrCode, RefreshCw, Upload } from "@/components/ui/icons";
import { Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { getReceipt, readReceiptAgain, receiptFileUrl, uploadReceipt } from "@/lib/expenses-api";
import { isCompressibleImage, prepareUpload } from "@/lib/image-compress";
import { CompanyAvatar } from "./expense-company";

// A receipt in the expense form (docs/expenses.md): add a photo or PDF, the server keeps a small copy and Claude Haiku reads it, and the
// form shows it back as a paper receipt, next to the original: its full copy (every printed line, as printed) once that is written, a
// summary of what was read before then (and for receipts read before full copies existed). The paper stays light in dark mode.

/** The company a receipt was paid to, for its logo on the card. */
type ReceiptCompany = Pick<ExpenseCompany, "id" | "logo" | "name">;
const KIND: Record<ReceiptData["kind"], string> = { receipt: "Receipt", tax_invoice: "Tax invoice", invoice: "Invoice", bill: "Bill", other: "Receipt" };
const PAID_BY: Record<ReceiptData["paymentMethod"], string> = { cash: "Cash", card: "Card", upi: "UPI", bank_transfer: "Bank transfer", wallet: "Wallet", other: "Other", unknown: "" };
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// Receipts aren't chat photos: up to 3200 px either way at high quality, so the server still has the small print to keep.
const RECEIPT_UPLOAD = { longSide: 3200, shortSide: 3200, quality: 0.92 };

function money(value: number, currency: string | null) {
  if (currency) { try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(value); } catch { /* an unknown code: plain below */ } }
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const longDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * A line that doesn't add up: the items against the subtotal, or the subtotal, taxes and tip against the total. Within a rupee for a
 * rupee receipt (round-off), within a cent or two (or 0.2%) in another currency. Prices that include tax print a total equal to the
 * subtotal, except when a tax is printed as added on top ("+18% VAT"): then the subtotal and that tax must make the total.
 */
function mismatch(data: ReceiptData): string | null {
  const slack = data.currency && data.currency !== "INR" ? Math.max(0.02, Math.abs(data.total ?? 0) * 0.002) : 1;
  const near = (a: number, b: number) => Math.abs(a - b) <= slack;
  const items = data.items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  // With taxes inside the prices, the items may add up to the total and the subtotal be the taxable amount without them.
  const itemsMakeTotal = data.taxIncluded === true && data.total !== null && near(items, data.total);
  if (data.items.length && data.items.every((item) => item.amount !== null) && data.subtotal !== null && !near(items, data.subtotal) && !itemsMakeTotal) return `The items add up to ${money(items, data.currency)}, not the subtotal of ${money(data.subtotal, data.currency)}.`;
  if (data.subtotal !== null && data.total !== null) {
    const extras = -(data.discount ?? 0) + (data.tip ?? 0) + (data.roundOff ?? 0);
    const withTaxes = data.subtotal + extras + data.taxes.reduce((sum, tax) => sum + tax.amount, 0);
    // Taxes the receipt says are part of the prices: the subtotal is either the total already, or the taxable amount the taxes make up.
    if (data.taxIncluded === true) return near(withTaxes, data.total) || near(data.subtotal + extras, data.total) ? null : `The subtotal and tip come to ${money(data.subtotal + extras, data.currency)}, not the total of ${money(data.total, data.currency)}.`;
    const addedOnTop = data.taxIncluded === false || data.taxes.some((tax) => /^\s*\+|\b(add|added|plus)\b/i.test(tax.label));
    if (!near(withTaxes, data.total) && (addedOnTop || !near(data.subtotal, data.total))) return `The subtotal, taxes and tip come to ${money(withTaxes, data.currency)}, not the total of ${money(data.total, data.currency)}.`;
  }
  return null;
}

/** An amount as printed ("₹1,250.00", "Rs. 399", "498.0"), or null. */
function printedAmount(text: string): number | null {
  const digits = text.replace(/₹|rs\.?|inr|[$€£¥,\s]/gi, "");
  return /^[-−]?\d+(\.\d+)?$/.test(digits) ? Number(digits.replace("−", "-")) : null;
}
/**
 * Whether the full copy shows this amount anywhere (as a cell, or among a line's numbers: "Net Amount 498.0"). A copy that doesn't show
 * the total read into the form missed part of the receipt, so the summary of the details is drawn instead.
 */
function copyShows(layout: ReceiptBlock[], total: number, slack: number): boolean {
  return layout.some((line) => [line.text, ...line.cells].some((words) => (words.match(/[\d,]*\d(?:\.\d+)?/g) ?? []).some((found) => Math.abs(Number(found.replace(/,/g, "")) - total) <= slack)));
}
/** The total printed on the full copy: its last "Total", "Net amount", "Grand total" or "Amount payable" line, read from the bottom. */
function copyTotal(layout: ReceiptBlock[]): number | null {
  const label = /^\s*(grand |net |bill |invoice )?(total|amount)( amount| payable| due| to pay)?\s*:?\s*$|^\s*(net amount|amount payable|to pay)\s*:?\s*$/i;
  for (const line of [...layout].reverse()) {
    if (line.kind === "pair" && label.test(line.text)) { const value = printedAmount(line.cells[0] ?? ""); if (value !== null) return value; }
    if (line.kind === "row") {
      const at = line.cells.findIndex((cell) => label.test(cell));
      if (at >= 0) for (const cell of line.cells.slice(at + 1).reverse()) { const value = printedAmount(cell); if (value !== null) return value; }
    }
  }
  return null;
}

const Rule = ({ double }: { double?: boolean }) => <hr aria-hidden="true" className={clsx("my-3 border-0 border-t border-dashed border-[#d6d3d1]", double && "border-t-2")} />;

// A cell that is an amount, a quantity or a rate ("399.00", "1.00", "₹1,250", "Rs. 399", "5%"): its column lines up on the right.
const NUMERIC = /^[\s(]*[-+−]?\s?(?:[₹$€£¥]|rs\.?|inr)?\s?[\d,]*\d(\.\d+)?\s?%?[)\s]*$/i;

/**
 * A table of the full copy: its header lines (a bill may print two, "CGST" over "Rate | Amt") and rows, amount columns on the right.
 * A table wider than the paper scrolls inside it, and can be scrolled from the keyboard.
 */
function CopyTable({ lines }: { lines: ReceiptBlock[] }) {
  const heads = lines.filter((line) => line.kind === "head");
  const rows = lines.filter((line) => line.kind === "row");
  const width = Math.max(1, ...lines.map((line) => line.cells.length));
  const pad = (cells: string[]) => Array.from({ length: width }, (_, index) => cells[index] ?? "");
  // A column is numeric when at least half its filled cells are: the totals' labels ("Total", "Net Amount") often sit in a rate or
  // amount column under the numbers.
  const numeric = Array.from({ length: width }, (_, column) => { const filled = rows.map((row) => row.cells[column] ?? "").filter((cell) => cell.trim()); const numbers = filled.filter((cell) => NUMERIC.test(cell)).length; return numbers > 0 && numbers * 2 >= filled.length; });
  return <div role="region" aria-label={heads[0]?.cells.filter(Boolean).join(", ") || "Table"} tabIndex={0} className="-mx-1 my-1 overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
    <table className="w-full border-collapse text-[11px] leading-4">
      {heads.length > 0 && <thead>{heads.map((head, line) => <tr key={line} className={clsx("text-[#78716c]", line === heads.length - 1 && "border-b border-dashed border-[#d6d3d1]")}>{pad(head.cells).map((cell, index) => cell
        ? <th key={index} scope="col" className={clsx("px-1 pb-1 font-semibold", numeric[index] ? "text-right" : "text-left")}>{cell}</th>
        : <td key={index} />)}</tr>)}</thead>}
      <tbody>{rows.map((row, index) => <tr key={index}>{pad(row.cells).map((cell, column) => <td key={column} className={clsx("px-1 py-0.5 align-top", numeric[column] ? "whitespace-nowrap text-right tabular-nums" : "break-words")}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}

/** One line of the full copy, as printed. */
function CopyLine({ line }: { line: ReceiptBlock }) {
  const centered = line.centered && "text-center";
  if (line.kind === "heading") return <p className={clsx("break-words font-sans text-[15px] font-extrabold leading-6", centered)}>{line.text}</p>;
  if (line.kind === "pair") return <p className="flex justify-between gap-4"><span className="text-[#78716c]">{line.text}</span><span className="min-w-0 break-words text-right">{line.cells[0]}</span></p>;
  if (line.kind === "rule") return <Rule />;
  if (line.kind === "code") return <p className={clsx("my-1 flex items-center gap-2 rounded-md border border-dashed border-[#d6d3d1] px-2.5 py-2 text-[#57534e]", line.centered && "justify-center")}><QrCode size={16} aria-hidden="true" className="shrink-0" /><span>{line.cells[0] || "Code"}{line.text ? ` · ${line.text}` : ""}</span></p>;
  return <p className={clsx("break-words", centered)}>{line.text}</p>;
}

/** The full copy: every printed line top to bottom, neighbouring header and row lines drawn as one table (a header after rows starts another). */
function FullCopy({ layout }: { layout: ReceiptBlock[] }) {
  const parts: (ReceiptBlock | ReceiptBlock[])[] = [];
  for (const line of layout) {
    const last = parts.at(-1);
    if (line.kind === "head" || line.kind === "row") {
      if (Array.isArray(last) && !(line.kind === "head" && last.some((one) => one.kind === "row"))) last.push(line);
      else parts.push([line]);
    } else parts.push(line);
  }
  return <div className="grid gap-0.5">{parts.map((part, index) => Array.isArray(part) ? <CopyTable key={index} lines={part} /> : <CopyLine key={index} line={part} />)}</div>;
}

// The receipt card's paper: light in both themes, like a real receipt.
const PAPER = "bg-[#fafaf9]";
// A notch cut out of each side of a strip, so the page shows through: the perforation between the card's head and its items.
const NOTCHES = "radial-gradient(circle at 0 50%, #0000 9px, #000 9.5px) left / 51% 100% no-repeat, radial-gradient(circle at 100% 50%, #0000 9px, #000 9.5px) right / 51% 100% no-repeat";
function Perforation() {
  return <div aria-hidden="true" className={clsx("relative h-5", PAPER)} style={{ mask: NOTCHES, WebkitMask: NOTCHES }}><div className="absolute inset-x-5 top-1/2 border-t border-dashed border-[#d6d3d1]" /></div>;
}
// What the total panel already says (sums, taxes, payment), and the header (number, date, time): left out of the details and notes.
const MONEY_LINE = /\b(sub ?total|total|net amount|amount payable|grand total|taxable|gst|cgst|sgst|igst|vat|tax|round ?off|rounding|discount|paid by|payment|tip)\b/i;
const HEADER_LINE = /\b(date|time)\b/i;

/**
 * The receipt as a card (the merchant and the document's number and date on top; then its details; a perforation; the items, numbered,
 * each with its quantity and price; the total on a grey panel with the subtotal, taxes and payment; a QR code printed on it; its notes
 * and terms; and the merchant's tax ID, phone and closing line at the foot). Drawn from the details read, and from the full copy for what
 * only it has: the "label: value" lines, the notes and terms, and the codes.
 */
function ReceiptCard({ data, company }: { data: ReceiptData; company?: ReceiptCompany }) {
  const m = (value: number) => money(value, data.currency);
  const name = data.merchant ?? KIND[data.kind];
  const layout = data.layout;
  const tableAt = layout.findIndex((line) => line.kind === "head" || line.kind === "row");
  let lastPair = -1;
  layout.forEach((line, index) => { if (line.kind === "pair") lastPair = index; });
  const details = layout.length
    ? layout.filter((line) => line.kind === "pair" && line.cells[0] && !HEADER_LINE.test(line.text) && !MONEY_LINE.test(line.text) && line.cells[0] !== data.number).map((line) => ({ label: line.text, value: line.cells[0]! }))
    : ([["Store", data.store], ["Cashier", data.cashier], ["Billed to", data.billedTo]] as const).flatMap(([label, value]) => (value ? [{ label, value }] : []));
  // Notes are the lines printed after the items (or after the last "label: value" line): terms, timings, thanks.
  const notesFrom = tableAt >= 0 ? tableAt : lastPair + 1;
  const notes = layout.slice(notesFrom).filter((line) => (line.kind === "text" || line.kind === "heading") && line.text !== data.footer && !MONEY_LINE.test(line.text)).map((line) => line.text.replace(/^s*[*•·-–]+s*/, "")).filter(Boolean);
  const codes = layout.filter((line) => line.kind === "code");
  const when = [data.date ? longDay(data.date) : "", data.time ?? ""].filter(Boolean).join(", ");
  const paidBy = [PAID_BY[data.paymentMethod], data.cardLast4 ? `•••• ${data.cardLast4}` : ""].filter(Boolean).join(" ");
  const summary = [
    ...(data.subtotal !== null ? [{ label: "Subtotal", value: m(data.subtotal) }] : []),
    ...(data.discount !== null ? [{ label: "Discount", value: `−${m(Math.abs(data.discount))}` }] : []),
    ...data.taxes.map((tax) => ({ label: `${tax.label}${tax.ratePercent !== null && !tax.label.includes("%") ? ` ${tax.ratePercent}%` : ""}${data.taxIncluded ? " (included)" : ""}`, value: m(tax.amount) })),
    ...(data.tip !== null ? [{ label: "Tip / service", value: m(data.tip) }] : []),
    ...(data.roundOff !== null ? [{ label: "Round off", value: `${data.roundOff < 0 ? "−" : "+"}${m(Math.abs(data.roundOff))}` }] : []),
    ...(paidBy ? [{ label: "Paid by", value: paidBy }] : []),
  ];
  const foot = [data.merchantTaxId ? `${GSTIN.test(data.merchantTaxId) ? "GSTIN" : "Tax ID"} ${data.merchantTaxId}` : "", data.merchantPhone ?? "", data.website ?? ""].filter(Boolean);
  return <article aria-label={`Receipt from ${name}`} className="mx-auto w-full max-w-[22rem] font-sans text-[#1c1917] [filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.08))_drop-shadow(0_8px_18px_rgb(0_0_0/0.10))]">
    <header className={clsx(PAPER, "rounded-t-[20px] px-5 pb-4 pt-5")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CompanyAvatar company={company} name={name} size={34} />
          <p className="min-w-0 break-words text-[15px] font-bold leading-5">{name}</p>
        </div>
        <div className="max-w-[48%] shrink-0 break-words text-right text-[11px] leading-4 text-[#78716c]">
          <p>{data.title ?? KIND[data.kind]}</p>
          {data.number && <p className="font-medium text-[#57534e]">№ {data.number}</p>}
          {when && <p className="tabular-nums">{when}</p>}
        </div>
      </div>
      {data.merchantAddress && <p className="mt-3 text-[11px] leading-4 text-[#78716c]">{data.merchantAddress}</p>}
      {details.length > 0 && <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">{details.map((detail, index) => <div key={index} className="min-w-0">
        <dt className="text-[11px] leading-4 text-[#78716c]">{detail.label}</dt>
        <dd className="break-words text-[13px] font-semibold leading-5">{detail.value}</dd>
      </div>)}</dl>}
    </header>
    <Perforation />
    {data.items.length > 0 && <ol aria-label="Items" className={clsx(PAPER, "grid gap-3 px-5 pb-1 pt-2")}>{data.items.map((item, index) => <li key={index} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-2 text-[12.5px] leading-5">
      <span aria-hidden="true" className="tabular-nums text-[#a8a29e]">{index + 1}</span>
      <span className="min-w-0 break-words">{item.name}{item.quantity !== null && item.unitPrice !== null && <span className="block text-[11px] tabular-nums text-[#78716c]">{item.quantity} × {m(item.unitPrice)}</span>}</span>
      <span className="text-right font-semibold tabular-nums">{item.amount !== null ? m(item.amount) : ""}</span>
    </li>)}</ol>}
    <div className={clsx(PAPER, "px-3 pb-3 pt-3")}>
      <div className="rounded-2xl bg-[#efeeec] px-4 py-3">
        <p className="flex items-baseline justify-between gap-3"><span className="text-[15px] font-semibold">Total{data.items.length > 0 && <span className="block text-[11px] font-normal text-[#78716c]">{data.items.length} {data.items.length === 1 ? "item" : "items"}{data.totalQuantity !== null && data.totalQuantity !== data.items.length ? `, quantity ${data.totalQuantity}` : ""}</span>}</span><span className="text-[22px] font-bold tabular-nums tracking-[-0.01em]">{data.total !== null ? m(data.total) : "–"}</span></p>
        {summary.length > 0 && <dl className="mt-2 grid gap-1 text-[11.5px] leading-4 text-[#57534e]">{summary.map((row, index) => <div key={index} className="flex justify-between gap-3"><dt className="min-w-0">{row.label}</dt><dd className="shrink-0 tabular-nums">{row.value}</dd></div>)}</dl>}
      </div>
    </div>
    {codes.map((code, index) => <div key={index} className={clsx(PAPER, "flex items-center gap-3 px-5 py-2")}>
      <span aria-hidden="true" className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-[#d6d3d1] bg-[#fff] text-[#44403c]"><QrCode size={28} /></span>
      <span className="min-w-0"><span className="block break-words text-[13px] font-semibold leading-5">{code.text || code.cells[0]}</span><span className="block text-[11px] leading-4 text-[#78716c]">{code.cells[0] || "Code"} on the receipt: scan the original</span></span>
    </div>)}
    {notes.length > 0 && <div className={clsx(PAPER, "px-5 pb-3 pt-2")}>
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#a8a29e]">Notes</p>
      <ul className="mt-1.5 grid list-disc gap-1 pl-4 text-[11.5px] leading-4 text-[#57534e] marker:text-[#c4bfb9]">{notes.map((note, index) => <li key={index} className="break-words">{note}</li>)}</ul>
    </div>}
    {foot.length > 0 || data.footer
      ? <footer className="flex justify-between gap-4 rounded-b-[20px] bg-[#efeeec] px-5 py-3.5 text-[11px] leading-4 text-[#78716c]">
          <div className="min-w-0 break-words">{foot.map((line) => <p key={line}>{line}</p>)}</div>
          {data.footer && <p className="max-w-[55%] break-words text-right italic">{data.footer}</p>}
        </footer>
      : <div aria-hidden="true" className={clsx(PAPER, "h-4 rounded-b-[20px]")} />}
  </article>;
}

/**
 * The receipt as read: a card (ReceiptCard), and the paper as printed one click away once its full copy is written. Notes under it say
 * when the copy is still being written, couldn't be, or missed part of the receipt, and when its sums don't add up.
 */
export function ReceiptPaper({ data, copy, company, actions }: { data: ReceiptData; copy?: ExpenseReceipt["copy"]; company?: ReceiptCompany; actions?: React.ReactNode }) {
  const m = (value: number) => money(value, data.currency);
  const [printed, setPrinted] = useState(false);
  const slack = data.currency && data.currency !== "INR" ? 0.02 : 1;
  const incomplete = data.layout.length > 0 && data.total !== null && !copyShows(data.layout, data.total, slack);
  const full = data.layout.length > 0 && !incomplete;
  // The full copy and the details are two readings of one receipt: when the total printed on the copy isn't the total the form got, say so.
  const printedTotal = full ? copyTotal(data.layout) : null;
  const apart = printedTotal !== null && data.total !== null && Math.abs(printedTotal - data.total) > slack;
  const warning = apart ? `The receipt shows a total of ${m(printedTotal!)}, but ${m(data.total!)} was read into the form.` : mismatch(data);
  // A copy that missed part of the receipt draws the card from the details alone.
  const shown = incomplete ? { ...data, layout: [] } : data;
  return <div className="grid gap-2">
    {printed && full
      ? <div className="mx-auto w-full max-w-[22rem] [filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.08))_drop-shadow(0_8px_18px_rgb(0_0_0/0.10))]">
          <figure aria-label="The receipt, copied as printed" className="bg-[#fffdf8] px-5 pb-8 pt-5 font-mono text-[12px] leading-5 text-[#1c1917] [mask:conic-gradient(from_-45deg_at_bottom,#0000,#000_1deg_89deg,#0000_90deg)_50%/14px_100%]">
            <FullCopy layout={data.layout} />
          </figure>
        </div>
      : <ReceiptCard data={shown} company={company} />}
    {(full || actions) && <div className="flex flex-wrap items-center justify-center gap-1">
      {full && <button type="button" aria-pressed={printed} onClick={() => setPrinted(!printed)} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-neutral-600 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
        <FileText size={13} aria-hidden="true" />{printed ? "Show as a card" : "Show as printed"}
      </button>}
      {actions}
    </div>}
    {copy === "writing" && <p role="status" className="flex items-center justify-center gap-1.5 text-xs text-neutral-500"><span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-500" />Writing out the full copy…</p>}
    {copy === "failed" && !full && <p className="text-center text-xs leading-5 text-neutral-500">The full copy couldn&apos;t be written. Read again to try once more.</p>}
    {incomplete && copy !== "writing" && <p className="text-center text-xs leading-5 text-neutral-500">The full copy missed part of this receipt (it doesn&apos;t show the total), so this is what was read. Read again to try once more.</p>}
    {warning && <p className="flex items-start gap-1.5 text-xs leading-5 text-warning-text"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{warning} Check it against the original.</p>}
  </div>;
}

type Props = {
  receiptId: string | null; canEdit: boolean;
  /** The company the expense is paid to, when it is known: its logo goes on the card. */
  company?: ReceiptCompany;
  /** A receipt was added (fresh: just read, so the form may fill itself in), or removed (null). */
  onReceipt: (receipt: ExpenseReceipt | null, fresh: boolean) => void;
};

/** Why the webcam didn't open, for the person (the browser's own error names). */
function cameraProblem(cause: unknown): string {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access is blocked: allow it from the camera icon in the address bar, or upload a file instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found: upload a file instead.";
  if (name === "NotReadableError") return "The camera is in use by another app: close it, or upload a file instead.";
  return "Couldn't open the camera: upload a file instead.";
}

/** The webcam, in the panel, for computers: a live view, a shutter, and a switch when there is more than one camera. */
function CameraView({ onShot, onCancel, onFail }: { onShot: (file: File) => void; onCancel: () => void; onFail: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [cameras, setCameras] = useState<string[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const fail = useRef(onFail);
  useEffect(() => { fail.current = onFail; });
  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    // As sharp as the camera gives: small print needs the pixels. The back camera on a tablet, the chosen one after a switch.
    navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(cameraId ? { deviceId: { exact: cameraId } } : { facingMode: { ideal: "environment" } }), width: { ideal: 3840 }, height: { ideal: 2160 } } })
      .then(async (opened) => {
        if (!live) { opened.getTracks().forEach((track) => track.stop()); return; }
        stream = opened;
        if (video.current) { video.current.srcObject = opened; await video.current.play().catch(() => undefined); }
        const found = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput").map((device) => device.deviceId).filter(Boolean);
        if (live) setCameras(found);
      })
      .catch((cause: unknown) => { if (live) fail.current(cameraProblem(cause)); });
    return () => { live = false; stream?.getTracks().forEach((track) => track.stop()); };
  }, [cameraId]);

  // The shutter waits for a real picture: a camera's first frames can be tiny or blank while it starts.
  const sized = () => setReady((video.current?.videoWidth ?? 0) >= 320);
  function shoot() {
    const frame = video.current;
    if (!frame || frame.videoWidth < 320) return;
    const canvas = document.createElement("canvas");
    canvas.width = frame.videoWidth; canvas.height = frame.videoHeight;
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
    canvas.toBlob((blob) => { if (blob) onShot(new File([blob], `receipt-${Date.now()}.jpg`, { type: "image/jpeg" })); }, "image/jpeg", 0.92);
  }
  function next() {
    const stream = video.current?.srcObject;
    const current = stream instanceof MediaStream ? stream.getVideoTracks()[0]?.getSettings().deviceId : undefined;
    const at = cameras.indexOf(cameraId ?? current ?? "");
    setReady(false); setCameraId(cameras[(at + 1) % cameras.length] ?? null);
  }
  return <div role="group" aria-label="Camera" className="grid gap-3 rounded-2xl bg-[#0c0d0f] p-3">
    <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-black sm:aspect-[4/3] lg:aspect-[3/4]">
      <video ref={video} playsInline muted onLoadedData={sized} onResize={sized} className="h-full w-full object-contain" />
      {!ready && <span className="absolute inset-0 grid place-items-center text-sm text-white/70">Opening the camera…</span>}
      <span aria-hidden="true" className="pointer-events-none absolute inset-[7%] rounded-lg border-2 border-dashed border-white/35" />
    </div>
    <p className="text-center text-xs text-white/60">Fit the whole receipt inside the frame, flat and in good light.</p>
    <div className="grid grid-cols-[1fr_auto_1fr] items-center">
      <button type="button" onClick={onCancel} className="justify-self-start rounded-lg px-3 py-2 text-sm font-semibold text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Cancel</button>
      <button type="button" onClick={shoot} disabled={!ready} aria-label="Take the photo" className="grid h-16 w-16 place-items-center rounded-full border-4 border-white/80 transition-transform duration-150 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"><span className="h-12 w-12 rounded-full bg-white" /></button>
      {cameras.length > 1 ? <button type="button" onClick={next} aria-label="Switch camera" className="grid h-10 w-10 justify-self-end place-items-center rounded-full text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><CameraSwitch size={20} /></button> : <span />}
    </div>
  </div>;
}

/** Add (a photo taken now, or a photo or PDF), show, replace or remove the expense's receipt. */
export function ReceiptSection({ receiptId, canEdit, company, onReceipt }: Props) {
  const [receipt, setReceipt] = useState<ExpenseReceipt | null>(null);
  const [busy, setBusy] = useState<"loading" | "reading" | "rereading" | null>(receiptId ? "loading" : null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [announced, setAnnounced] = useState("");
  // Choosing a new one over the one shown (Replace), and the computer's webcam open.
  const [replacing, setReplacing] = useState(false);
  const [camera, setCamera] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const shot = useRef<HTMLInputElement>(null);
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
  // A full copy still being written comes a few seconds after the details: looked for every two seconds, for 160 seconds at most
  // (the API counts it as failed after 150), then shown as failed here too. The receipt shown may have changed meanwhile: only its own answer replaces it.
  const writingId = shown?.copy === "writing" ? shown.id : null;
  useEffect(() => {
    if (!writingId) return;
    let live = true;
    let tries = 0;
    const timer = window.setInterval(() => {
      if (++tries > 80) { window.clearInterval(timer); setReceipt((current) => (current?.id === writingId ? { ...current, copy: "failed" } : current)); return; }
      getReceipt(writingId).then((found) => { if (live && found.copy !== "writing") setReceipt((current) => (current?.id === found.id ? found : current)); }).catch(() => undefined);
    }, 2_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [writingId]);
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
    setError(""); setCamera(false);
    setBusy("reading");
    try {
      // A big phone photo shrinks first so it uploads quickly, but gently (receipts are small print; the server makes the kept copy);
      // a PDF goes as it is.
      const sent = isCompressibleImage(file.type) ? (await prepareUpload(file, { hd: false }, RECEIPT_UPLOAD)).file : file;
      if (sent.size > MAX_RECEIPT_BYTES) { setError("That file is over 10 MB: pick a smaller photo or PDF."); return; }
      const added = await uploadReceipt(sent);
      setReceipt(added); setReplacing(false); latest.current(added, true);
    } catch (cause) { setError(describeError(cause, "Couldn't add the receipt. Try again.")); }
    finally { setBusy(null); for (const picker of [input.current, shot.current]) if (picker) picker.value = ""; }
  }
  /** Reads the receipt shown again (its details and full copy); the form keeps what it has. A failed read leaves the one before. */
  async function readAgain() {
    if (!shown) return;
    setError(""); setAnnounced(""); setBusy("rereading");
    try { const fresh = await readReceiptAgain(shown.id); setReceipt((current) => (current?.id === fresh.id ? fresh : current)); setAnnounced("Read again."); }
    catch (cause) { setError(describeError(cause, "Couldn't read it again. Try again in a moment.")); }
    finally { setBusy(null); }
  }
  /** Phones and tablets open their own camera app (full resolution, focus, flash); a computer opens its webcam here. */
  function takePhoto() {
    setError("");
    if (window.matchMedia("(pointer: coarse)").matches || !navigator.mediaDevices?.getUserMedia) shot.current?.click();
    else setCamera(true);
  }

  if (!canEdit && !receiptId) return null;
  // Reads the kept original again: a receipt read before the full copy existed, or one that was read badly.
  const readAgainButton = shown && canEdit && !replacing ? <button type="button" disabled={busy !== null || shown.copy === "writing"} onClick={() => void readAgain()} title="Read the details and the full copy again from the kept original"
        className="inline-flex min-h-8 items-center gap-1.5 justify-self-center rounded-lg px-2.5 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-50">
        <RefreshCw size={13} aria-hidden="true" className={clsx(busy === "rereading" && "animate-spin")} />{busy === "rereading" ? "Reading it again…" : shown.data && !shown.data.layout.length ? "Read again for the full copy" : "Read again"}
      </button> : null;
  const copy = preview && shown && preview.id === shown.id ? preview.url : null;
  const choose = canEdit && (!shown || replacing) && busy !== "loading";
  const chooser = camera
    ? <CameraView onShot={(file) => void add(file)} onCancel={() => setCamera(false)} onFail={(message) => { setCamera(false); setError(message); }} />
    : <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && busy === null) void add(file); }}
        className="grid gap-3 rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-4">
        <div className="flex items-center gap-3" aria-live="polite">
          <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-primary-700 shadow-sm">{busy === "reading" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-200 border-t-primary-700" /> : <Paperclip size={18} />}</span>
          <span className="min-w-0"><span className="block text-sm font-bold text-neutral-900">{busy === "reading" ? "Reading the receipt…" : replacing ? "Another receipt" : "Add a receipt"}</span><span className="block text-xs leading-5 text-neutral-500">{busy === "reading" ? "Filling in the details from it. This takes a few seconds." : "Take a photo, or upload a photo or PDF (up to 10 MB). It fills in the details for you."}</span></span>
        </div>
        {busy !== "reading" && <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={takePhoto} className={clsx(primaryClass, "!min-h-11")}><Camera size={17} aria-hidden="true" />Take a photo</button>
          <button type="button" onClick={() => input.current?.click()} className={clsx(secondaryClass, "!min-h-11")}><Upload size={17} aria-hidden="true" />Upload</button>
        </div>}
        {replacing && busy !== "reading" && <button type="button" onClick={() => setReplacing(false)} className="justify-self-center text-xs font-semibold text-neutral-500 underline-offset-2 hover:underline">Keep the one I have</button>}
      </div>;
  return <section aria-label="Receipt" className="grid gap-3">
    {busy === "loading" && <div className="h-16 animate-pulse rounded-2xl bg-neutral-100" aria-label="Loading the receipt" />}
    {choose && chooser}
    {shown && <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-neutral-900"><FileText size={15} aria-hidden="true" />Receipt</h3>
        <span className="flex flex-wrap gap-2">
          <button type="button" aria-expanded={showOriginal} onClick={() => setShowOriginal(!showOriginal)} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>{showOriginal ? "Hide original" : "Original"}</button>
          {canEdit && !replacing && <button type="button" disabled={busy !== null} onClick={() => setReplacing(true)} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>Replace</button>}
          {canEdit && <button type="button" disabled={busy !== null} onClick={() => { setReceipt(null); setReplacing(false); setCamera(false); latest.current(null, false); }} className={clsx(secondaryClass, "!min-h-8 !px-3 !text-xs")}>Remove</button>}
        </span>
      </div>
      {showOriginal && <div className="grid gap-2">
        {!copy ? <div className="h-40 animate-pulse rounded-xl bg-neutral-100" aria-label="Loading the original" />
          : shown.contentType === "application/pdf" ? <iframe src={copy} title="The receipt as uploaded" className="h-[28rem] w-full rounded-xl border border-neutral-200 bg-white" />
          // eslint-disable-next-line @next/next/no-img-element -- an authorized blob link can't use Next image optimization
          : <img src={copy} alt="The receipt as uploaded" className="max-h-[32rem] w-auto justify-self-center rounded-xl border border-neutral-200" />}
        {copy && <a href={copy} target="_blank" rel="noopener noreferrer" className="justify-self-start text-xs font-semibold text-primary-700 underline-offset-2 hover:underline">Open in a new tab</a>}
      </div>}
      {shown.data ? <ReceiptPaper data={shown.data} copy={shown.copy} company={company} actions={readAgainButton} />
        : <div className="grid gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">
          <p>{shown.error ?? "Couldn't read this receipt."} The original is kept with the expense.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- an authorized blob link can't use Next image optimization */}
          {copy && !showOriginal && <img src={copy} alt="The receipt as uploaded" className="max-h-72 w-auto self-start rounded-lg border border-neutral-200" />}
        </div>}
      {!shown.data && readAgainButton}
    </>}
    {canEdit && <>
      <input ref={input} type="file" accept="image/*,application/pdf" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; if (file) void add(file); }} />
      <input ref={shot} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; if (file) void add(file); }} />
    </>}
    <p role="status" className="sr-only">{announced}</p>
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
  </section>;
}
