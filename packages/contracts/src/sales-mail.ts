import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// Mail (docs/sales-channels.md section 3a): a person's own connected mailbox, read live over IMAP like a webmail. Only the mailbox's owner
// opens it (not an admin, not a head). Nothing read here is stored: the sales Inbox keeps filing only replies from leads.

/** What a folder is for, from the server's special-use flags or its name. */
export const MAIL_FOLDER_ROLES = ["inbox", "sent", "drafts", "junk", "trash", "archive", "other"] as const;
export const mailFolderRoleSchema = z.enum(MAIL_FOLDER_ROLES);
export type MailFolderRole = z.infer<typeof mailFolderRoleSchema>;
export const mailFolderSchema = z.object({
  path: z.string(), name: z.string(), role: mailFolderRoleSchema, depth: z.number().int().min(0),
  total: z.number().int().min(0), unread: z.number().int().min(0),
});
export type MailFolder = z.infer<typeof mailFolderSchema>;

export const mailAddressSchema = z.object({ name: z.string().optional(), address: z.string() });
export type MailAddress = z.infer<typeof mailAddressSchema>;

/** The lead an address belongs to (in a venture the viewer can open). */
export const mailLeadSchema = z.object({ leadId: idSchema, companyName: z.string(), ventureId: idSchema });
/** A message the sales app sent from this mailbox (one of its drafts): what became of it. */
export const mailTrackSchema = z.object({
  draftId: idSchema.optional(), leadId: idSchema, companyName: z.string(),
  state: z.enum(["sent", "bounced", "uncertain", "replied"]), repliedAt: isoDateSchema.optional(),
});
export type MailTrack = z.infer<typeof mailTrackSchema>;

export const mailRowSchema = z.object({
  uid: z.number().int().positive(), folder: z.string(), subject: z.string(), date: isoDateSchema.optional(),
  from: z.array(mailAddressSchema), to: z.array(mailAddressSchema),
  seen: z.boolean(), flagged: z.boolean(), answered: z.boolean(), hasAttachments: z.boolean(), size: z.number().int().min(0),
  lead: mailLeadSchema.optional(), track: mailTrackSchema.optional(),
});
export type MailRow = z.infer<typeof mailRowSchema>;

export const mailListQuerySchema = z.object({
  folder: z.string().trim().min(1).max(500).default("INBOX"),
  /** The next page: messages with a lower UID than this. */
  before: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const mailListSchema = z.object({ folder: z.string(), total: z.number().int().min(0), items: z.array(mailRowSchema), nextBefore: z.number().int().positive().optional() });
export type MailList = z.infer<typeof mailListSchema>;

/** One attachment, by its MIME part number ("2", "1.3"): downloaded straight from the mail server. `size` is roughly what it weighs. */
export const mailAttachmentSchema = z.object({ part: z.string().regex(/^\d+(\.\d+)*$/).max(40), filename: z.string(), contentType: z.string(), size: z.number().int().min(0), inline: z.boolean() });
export const MAIL_PART_PATTERN = /^\d+(\.\d+){0,9}$/;
export const mailMessageSchema = mailRowSchema.extend({
  cc: z.array(mailAddressSchema), replyTo: z.array(mailAddressSchema), messageId: z.string().optional(),
  text: z.string(),
  /** The message's own HTML with scripts, frames, forms and meta tags taken out: shown only inside a sandboxed frame that runs no script. */
  html: z.string().optional(),
  /** The HTML loads pictures from the internet (blocked until the reader asks: a picture can tell the sender the message was opened). */
  remoteImages: z.boolean(),
  attachments: z.array(mailAttachmentSchema),
  /** The message was cut: only its first part was read. */
  truncated: z.boolean(),
});
export type MailMessage = z.infer<typeof mailMessageSchema>;

export const mailFolderQuerySchema = z.object({ folder: z.string().trim().min(1).max(500) });
export const mailFlagInputSchema = z.object({ seen: z.boolean().optional(), flagged: z.boolean().optional() }).refine((value) => value.seen !== undefined || value.flagged !== undefined, { message: "Say what to change" });
export const mailMoveInputSchema = z.object({ to: z.enum(["inbox", "trash", "junk", "archive"]) });

const emailList = (max: number) => z.array(z.string().trim().toLowerCase().email().max(254)).max(max);
/** Attachments added in the browser, base64: 10 files and 10 MB at most in all. */
export const MAIL_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
export const mailUploadSchema = z.object({
  filename: z.string().trim().min(1).max(200), contentType: z.string().trim().max(150).default("application/octet-stream"),
  data: z.string().max(Math.ceil(MAIL_ATTACHMENT_LIMIT_BYTES * 4 / 3) + 8),
});
export const mailSendInputSchema = z.object({
  mode: z.enum(["new", "reply", "reply_all", "forward"]).default("new"),
  /** The message replied to or forwarded (in this mailbox). */
  source: z.object({ folder: z.string().trim().min(1).max(500), uid: z.number().int().positive() }).optional(),
  to: emailList(20).min(1, "Add at least one address"), cc: emailList(20).default([]),
  subject: z.string().trim().max(300).default(""), body: z.string().max(50_000).default(""),
  attachments: z.array(mailUploadSchema).max(10).default([]),
  /** The writer's time zone, for the date in "On …, … wrote:". */
  timezone: z.string().trim().max(60).optional(),
  /** The same request sent twice (a double click, a retry) sends one message. */
  requestId: z.string().trim().min(8).max(128),
}).refine((value) => value.mode === "new" || value.source !== undefined, { message: "A reply or a forward names the message it answers", path: ["source"] });
export type MailSendInput = z.input<typeof mailSendInputSchema>;
export const mailSendResultSchema = z.object({
  state: z.enum(["sent", "uncertain"]), messageId: z.string().optional(),
  /** Leads the message was noted on (the lead's history and its Inbox item). */
  notedOn: z.array(z.object({ leadId: idSchema, companyName: z.string() })),
  /** Things that went wrong after it went out, in words (it was still sent). */
  warnings: z.array(z.string()),
});
export type MailSendResult = z.infer<typeof mailSendResultSchema>;

/** The mailboxes a person can open here: their own connected email accounts. */
export const mailAccountSchema = z.object({ id: idSchema, label: z.string(), address: z.string(), status: z.string(), ventureIds: z.array(idSchema), defaultFor: z.array(idSchema) });
export type MailAccount = z.infer<typeof mailAccountSchema>;
