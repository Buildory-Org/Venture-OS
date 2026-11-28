import { z } from "zod";
import {
  mailAccountSchema, mailFolderSchema, mailListSchema, mailMessageSchema, mailSendInputSchema, mailSendResultSchema, successEnvelope,
  type MailAccount, type MailFolder, type MailList, type MailMessage, type MailRow, type MailSendInput, type MailSendResult,
} from "@venture-studio/contracts";
import { localDevUserId } from "@/lib/dev-identity";
import { StudioApiError } from "@/lib/studio-api";
import { salesRequest as request } from "@/lib/sales-api";

// Client for Mail (docs/sales-channels.md section 3a): the person's own connected mailbox, read live from their mail server. Only its owner
// reaches these routes.

export type { MailAccount, MailFolder, MailList, MailMessage, MailRow, MailSendInput, MailSendResult };

const id = encodeURIComponent;
const json = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });
const folderQuery = (folder: string) => `folder=${id(folder)}`;

export async function listMailAccounts() {
  return successEnvelope(z.array(mailAccountSchema)).parse(await request("/v1/sales/mail/accounts")).data;
}
export async function listMailFolders(accountId: string) {
  return successEnvelope(z.array(mailFolderSchema)).parse(await request(`/v1/sales/mail/${id(accountId)}/folders`)).data;
}
export async function listMail(accountId: string, input: { folder: string; before?: number | undefined; q?: string | undefined; limit?: number }) {
  const params = new URLSearchParams({ folder: input.folder, limit: String(input.limit ?? 50) });
  if (input.before) params.set("before", String(input.before));
  if (input.q) params.set("q", input.q);
  return successEnvelope(mailListSchema).parse(await request(`/v1/sales/mail/${id(accountId)}/messages?${params}`)).data;
}
/** One message; opening it marks it read on the mail server. */
export async function readMail(accountId: string, folder: string, uid: number) {
  return successEnvelope(mailMessageSchema).parse(await request(`/v1/sales/mail/${id(accountId)}/messages/${uid}?${folderQuery(folder)}`)).data;
}
export async function flagMail(accountId: string, folder: string, uid: number, change: { seen?: boolean; flagged?: boolean }) {
  await request(`/v1/sales/mail/${id(accountId)}/messages/${uid}?${folderQuery(folder)}`, json(change, "PATCH"));
}
export async function moveMail(accountId: string, folder: string, uid: number, to: "inbox" | "trash" | "junk" | "archive") {
  return successEnvelope(z.object({ folder: z.string() })).parse(await request(`/v1/sales/mail/${id(accountId)}/messages/${uid}/move?${folderQuery(folder)}`, json({ to }))).data;
}
export async function sendMail(accountId: string, input: MailSendInput) {
  return successEnvelope(mailSendResultSchema).parse(await request(`/v1/sales/mail/${id(accountId)}/send`, json(mailSendInputSchema.parse(input)))).data;
}

/** Saves an attachment: fetched with the person's session, then handed to the browser as a file (never opened as a page). */
export async function downloadAttachment(accountId: string, folder: string, uid: number, part: string, filename: string) {
  const devUserId = localDevUserId();
  const response = await fetch(`/v1/sales/mail/${id(accountId)}/messages/${uid}/parts/${id(part)}?${folderQuery(folder)}`, { credentials: "same-origin", cache: "no-store", headers: devUserId ? { "x-dev-user-id": devUserId } : {} });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
    throw new StudioApiError(body?.error?.message ?? `The download failed (HTTP ${response.status})`, body?.error?.code as never);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "attachment";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A file picked in the browser, as the send route takes it (base64). */
export async function attachmentOf(file: File): Promise<{ filename: string; contentType: string; data: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { filename: file.name || "attachment", contentType: file.type || "application/octet-stream", data: btoa(binary) };
}
