# Sales channels: email, WhatsApp, Instagram and LinkedIn

How Dealflow Sales sends and receives through real accounts. Every connection is an **account** linked to one or more ventures, so several
ventures and several accounts work at the same time: Buildory's sellers each send from their own mailbox, EditHood has its own WhatsApp number,
one person can have a mailbox per venture, and a venture can have two WhatsApp numbers.

Claude never connects an account, never changes one and never sends: a person clicks **Send** in the app. Claude's drafts still pass the
separate review (and a person's approval where the venture asks for it) before they can be sent. A reply a person writes in the app is
ready at once, approved by them (`docs/sales-dealflow.md` §5, "A person's own reply"), and sends from the Inbox.

| Channel | What the app does | Account belongs to |
|---|---|---|
| Email | Sends from the person's own mailbox (SMTP), reads the inbox (IMAP) and files replies, bounces and opt-outs on the lead | the person (personal) |
| WhatsApp | Sends from the venture's WhatsApp Business number (Meta Cloud API) to leads who opted in; replies, delivery ticks and STOP arrive by webhook | the venture(s) |
| Instagram | Receives DMs to the venture's professional account by webhook and answers within 24 hours of the person's last message | the venture(s) |
| LinkedIn | No sending API exists for this use: the app opens the profile and copies the message, the person sends it, marks it sent, and the daily cap counts it | the person (personal) |

## 1. Accounts

Collection `sales_channel_accounts` (contracts: `packages/contracts/src/sales-channels.ts`, server core: `apps/api/src/sales/channels/accounts.ts`).

```
{ _id, workspaceId, kind: email|whatsapp|instagram|linkedin, label, ownerUserId? (personal kinds), ventureIds[], defaultFor[], enabled,
  status: not_tested|connected|needs_attention, statusNote?, settings{…per kind}, secrets{ name: SealedSecret }, verifyToken? (whatsapp/instagram),
  mailSync? (email: { uidValidity, lastUid, startedAt, leaseUntil, leaseBy }), lastCheckedAt?, lastSyncAt?, lastError?,
  createdBy, createdAt, updatedAt }
```

- **Personal kinds** (email, linkedin): `ownerUserId` = the person who connected it. Only they send through it and change it; an admin may switch
  it off or remove it. Heads of its ventures see it (label, address, status), never a secret.
- **Venture kinds** (whatsapp, instagram): managed by an admin or by a head of **every** venture it serves. Every writer in one of those ventures
  sends through it (the activity records who sent).
- `ventureIds`: at least one; the person creating it must be a writer (personal) or head (venture) in each. `defaultFor` is a subset of
  `ventureIds`. Saving `defaultFor: [X]` removes X from the `defaultFor` of the other accounts in the same scope (the same owner and kind for
  personal accounts; the same kind for venture accounts), so there is at most one default per venture, kind (and person).
- **Secrets** (email `password`; whatsapp and instagram `accessToken` and `appSecret`) are sealed with `sealSecret` (AES-256-GCM, key from
  BETTER_AUTH_SECRET via HKDF, bound to `workspace:account:name`), opened only with `openSecrets` for one provider call, never returned, logged
  or audited. People see `{ set, last4 }`. A secret that no longer opens reads as not set, and the account as needing attention.
- `verifyToken`: made with `newVerifyToken()` when a WhatsApp or Instagram account is created; shown to its managers with the webhook URL
  (`<APP_ORIGIN>/v1/webhooks/meta`) to paste into the Meta app. It never changes unless the account is removed.
- Duplicate guard: one email account per owner and address; one WhatsApp account per `phoneNumberId` and one Instagram account per
  `instagramAccountId` in the workspace (409 otherwise).
- What people see of a secret: whether it is set and when. A mail password keeps nothing in clear; a Meta token or app secret (16+
  characters) keeps its last four characters, shown only to the people who manage the account.
- Mail servers: SSL/TLS or STARTTLS only (never unencrypted), the standard ports only (SMTP 25/465/587/2525, IMAP 143/993), a public host
  name (no IP addresses or local names), and the API refuses a name that resolves to a private or reserved address before connecting (it
  connects to the address it checked, with the name kept for the certificate check). Server banners are never shown back.
- **One Meta app per trust boundary**: Meta signs every webhook delivery with the app's secret, so whoever holds an app secret shared by
  several accounts could forge deliveries for all of them. Ventures that don't trust each other's heads use separate Meta apps.
- A switched-off WhatsApp or Instagram account still files incoming messages (a STOP is never lost); it just can't be sent through.

### Account API (all under `/v1/sales`, session only: Claude is refused with `forbidClaude`; MCP never reaches them)

| Method and path | Who | Body / query | Answer |
|---|---|---|---|
| `GET /channels` | anyone | `?ventureId=&kind=` | `ChannelAccount[]` the person can see (`canManage` says whether they may change it) |
| `POST /channels` | writer (personal) / head of every venture (venture kinds) | `channelAccountInputSchema` | 201 `ChannelAccount` (status `not_tested`) |
| `PATCH /channels/:id` | manager | `channelAccountUpdateSchema` | `ChannelAccount`; changing a secret or the server settings resets status to `not_tested`; `settings` must match the kind |
| `DELETE /channels/:id` | manager | | 200 `{ deleted: true }`; past activities keep their `message.accountId` |
| `POST /channels/:id/test` | manager | | `ChannelAccountTest`; stores status `connected` or `needs_attention` (+ `statusNote`, `lastCheckedAt`); 5 tests a minute per person |
| `GET /channels/presets` | anyone | | `EMAIL_PROVIDER_PRESETS` |
| `GET /channels/:id/templates` | anyone who can use it (WhatsApp) | | `WhatsappTemplate[]` with status APPROVED, cached 10 minutes |

Every change is audited (`sales.channel.create|update|delete|test`) with only the kind and which fields changed.

## 2. Sending a draft through an account

`POST /v1/sales/drafts/:id/send` with `draftSendThroughInputSchema` `{ accountId?, template?, requestId, expectedUpdatedAt? }` (session only,
Claude refused). `expectedUpdatedAt` is the draft's `updatedAt` the person saw: a draft edited, reviewed or approved since then is refused
with `409 DRAFT_CHANGED` ("This draft changed since you opened it: read it again before sending"), checked before anything else and again
in the claim's filter (step 5), so it can't slip in between.

1. The draft passes everything `sendBlocker` checks today (ready, approved where needed, not do-not-contact, the venture allows the channel,
   WhatsApp opt-in), and no other version of the same message is being sent or went out since it was written (`versionBlocker`: a lead's
   first message and its follow-up go out on one channel only, and one reply per message of the lead's; a version that bounced doesn't
   count; `docs/sales-dealflow.md` §5, "Versions"). The channel is email, whatsapp or instagram (linkedin and call openers: 409, "send it yourself and mark it sent").
2. The account: `pickSendAccount(ctx, lead.ventureId, channel, accountId)`; its secrets must open (409 "reconnect" otherwise).
3. The recipient: email, the lead's first email route (the draft reader shows it); WhatsApp, the lead's WhatsApp route, else its phone route,
   normalised with `normalizePhone` (India +91 by default); Instagram, the person's Instagram-scoped id from a conversation linked to this lead
   on this account (`sales_channel_contacts`). None: 409 saying what is missing.
4. Windows: WhatsApp free text only within 24 hours of the lead's last inbound WhatsApp on this account; outside it a `template` is required
   (409 `TEMPLATE_REQUIRED`). Instagram only within 24 hours of their last message (409 otherwise: "send it from the Instagram app and mark it
   sent").
5. Claim, in this order: the draft (`sendLock: { requestId, by, at }` set only where `status: "ready"`, no `sendLock` and, when given,
   `updatedAt` equal to `expectedUpdatedAt`), then the day's send
   (`claimSendSlot`, the venture's cap per person and channel). Then the lead, play and settings are read again and `sendBlocker` runs once
   more on the claimed draft (a refusal gives both claims back), and the message is built from the claimed draft. Then the provider call,
   **outside** any transaction, with a 23-second timeout (25 s at most, under the web proxy's 60 s). A reply arriving meanwhile never
   discards a draft that is being sent. WhatsApp: a number stored without a country code is refused when the lead's country isn't India
   ("write it with its country code"); the number actually used is returned as `delivery.to`.
6. Outcome (`SendOutcome` from the provider):
   - `sent`: one transaction marks the draft sent (`sentVia` `smtp` / `whatsapp_api` / `instagram_api`, `sentAccountId`, `delivery: {state:
     "sent"}`), logs the outbound activity through `applyActivity` with `message: { accountId, externalId, threadKey, subject, from, to,
     delivery }` (stage, follow-up date and the rest of the rules run as for a manual send), clears the Inbox item it answers, closes the
     lead's other open versions of the message (its email or WhatsApp twin, or its other replies to the same message: discarded with
     `closedReason` and `sentVersion`), removes
     `sendLock`, audits `sales.draft.sent` (with `closedVersions` when it closed any). 201 `{ draft, activity, lead }`.
   - A refusal after the claim (the cap used up, a last-moment check) gives both claims back and restores the draft as it was, its
     `updatedAt` included.
   - `failed`: the day's send is given back, `sendLock` removed, `delivery: { state: "failed", error }` kept on the draft (it stays ready).
     502 `SEND_FAILED` with the provider's reason in plain words.
   - `uncertain`: the send stays counted, `sendLock` stays, `delivery: { state: "uncertain", error }`. 202 with the draft. A person checks
     their Sent folder or WhatsApp and answers `POST /v1/sales/drafts/:id/delivery` `{ outcome: "sent" | "not_sent" }`: sent records it as sent
     (no provider id) and closes the other versions; not_sent removes the lock and gives the send back if it was today's. Until then the
     message's other versions can't be sent (by hand or through an account). A bounce that arrives for an unsettled send
     settles it as sent, then bounced.
   - A send interrupted by a restart (a `sendLock` still "sending" after 2 minutes) reads as `uncertain`: every action on the draft answers
     "We couldn't confirm the last send: say whether it went out" and `/delivery` settles it either way.
7. Idempotency: the same `requestId` returns the first answer; a second request for a draft that has a `sendLock` with another requestId gets
   409 "already being sent". The email Message-ID is derived from the draft id and attempt, so a retried SMTP call is recognisable. A late
   "it went out" after "it didn't go" changes nothing (409).

`POST /drafts/:id/sent` (marking a hand-sent message) stays as it is, accepts `sentVia: "manual"` only (others: 400 pointing at `/send`) and
also takes an optional `accountId` naming the mailbox or LinkedIn profile it went from (recorded in `message.accountId`) and the same optional
`expectedUpdatedAt` (in its claim's filter too). It follows the same version rule: refused while another version is being sent, and it closes
the other open versions (or other replies to the same message) in the same transaction.

**Where a send would go** (`sendTarget`): every open email, WhatsApp and Instagram draft the API returns carries `sendTarget: { channel, to }`,
worked out by the same code as step 3 (`targetFrom`) with the account a send would pick by itself (the person's default for the venture, or
their only one): the email address; for WhatsApp the number the lead wrote from on that account, else its WhatsApp or phone route,
normalised; for Instagram the linked conversation, shown as its @handle when known. Absent when there is none. It is shown even when the
person has no account to send through; with several accounts and no default the lead's routes decide (the send's `to` says where it
went). For a list it costs two queries at most (the venture accounts and the linked conversations); email needs none.

**Versions in the Review screen**: a lead's first message may wait as an email and a WhatsApp version (Claude writes the WhatsApp one once
the lead opted in). Every open first message and follow-up carries `otherVersions` (`[{ id, channel, status }]`), and the draft lists carry
the lead's `whatsappOptIn` and `contactRoutes`, so the screen groups a lead's versions by `leadId` + `purpose` and lets the person pick one
to send; whether they can send it from the app comes from their usable accounts (`GET /channels`: `kind`, `enabled`, `ventureIds`, and the
owner for a mailbox). A version closed because another went out reads `status: discarded` with `closedReason` and `sentVersion`.

**Daily caps**: `CAPPED_CHANNELS` = email, whatsapp, linkedin, instagram; `dailyCaps` has all four (LinkedIn 15, the rest 20 by default).
Hand-marked and app-sent messages count the same.

## 3. Email (SMTP and IMAP)

Files: `apps/api/src/sales/channels/email/*`.

- **Send** (nodemailer): from `"<senderName>" <address>`, to the lead's address; subject = the draft's subject; plain text body (the draft),
  no tracking pixels or links rewritten. A reply sets `In-Reply-To` and `References` from the inbound message it answers. `Message-ID` is
  `<draft-<id>-<attempt>@<domain of the address>>`. `saveToSent`: append the sent message to the Sent folder over IMAP (`\Seen`). Timeouts:
  connect 15 s, greeting 15 s, socket 30 s. SMTP 5xx on RCPT/DATA → `failed`; auth errors → `failed` ("the mailbox refused the password: for
  Gmail use an app password"); a timeout or reset after DATA started → `uncertain`.
- **Test**: SMTP `verify()` and an IMAP login + `INBOX` status, in parallel, 35 s (40 s at most). Nothing is sent.
- **Server addresses**: the host name is resolved first and refused when it points at a private or reserved address; the connection goes to
  the checked address with the name kept for TLS. Server text is shown only for 4xx/5xx answers to MAIL FROM, RCPT TO or DATA; every
  connection problem reads "Couldn't reach <host> on port <port>". At most 5 mailboxes per person.
- **Inbox sync** (imapflow, `createMailSync` started from `server.ts` like the finder; `SALES_MAIL_SYNC=on`, never under tests): every 3
  minutes, for each enabled email account with `syncInbox`, take a lease on the account (`mailSync.leaseUntil`), open `INBOX` read-only (never
  set flags, never delete, never move), fetch messages with UID > `lastUid` (on first sync: only mail from the connection time onwards; when
  UIDVALIDITY changes, restart from the current UIDNEXT), at most 200 per round, newest last, and advance the cursor after each message.
  Three mailboxes are read at once, each within 150 s (the connection is closed then), with a 5-minute lease renewed every minute.
  For each message (mailparser without its HTML conversion, the source cut at 512 KB, HTML-only mail turned into text by a one-pass strip of
  at most 100 KB, attachments ignored):
  1. A failed delivery report (`Action: failed` or `Status: 5.x.x`, or a mailer-daemon bounce with permanent/5xx wording) naming one of our
     Message-IDs → `delivery: { state: "bounced", error }` on that activity and draft. The message never reached the lead, so the drafts its
     sending closed (its email or WhatsApp twin, or the other replies to the same message) open again in the status they had, with
     `reopenedAt` and `reopenedBecause: "bounced"` (`docs/sales-dealflow.md` §5); nothing else changes. Delay and success notices are skipped.
  2. `Auto-Submitted` other than `no`, `X-Autoreply`, `Precedence: bulk|auto_reply|list` → skipped.
  3. Matched to a lead in one of the account's ventures by `In-Reply-To`/`References` against our sent Message-IDs, but only when the sender
     is one of the lead's addresses or on the lead's own (not shared) domain, and never a teammate, a connected mailbox or the mailbox's own
     domain (a colleague's forward stays out); else by the sender's exact address (the lead's indexed `suppressKeys`). A sender matching
     several leads, or none, is not stored (mail that isn't from a lead stays private).
  4. Stored as an inbound activity (`kind: "email", direction: "in"`, via `system`, actor = the mailbox owner, `body` = the new text without
     the quoted thread, max 10,000 characters, `message` with the Message-ID, thread, subject, from, to). `applyActivity` then applies the reply
     rules (stop follow-ups, Inbox item, notify the owner). The reply type is left for a person (the Inbox asks), so nothing is auto-classified.
  5. Duplicate guard: unique `(workspaceId, message.accountId, message.externalId)` for inbound activities.
  Errors set `lastError` and status `needs_attention` (auth) without stopping the other accounts.

## 4. WhatsApp (Meta WhatsApp Business Cloud API)

Files: `apps/api/src/sales/channels/meta/*`. Graph base `https://graph.facebook.com/<META_GRAPH_VERSION>`; every call sends the access token
in the `Authorization` header and `appsecret_proof` (HMAC-SHA256 of the token with the app secret). Timeouts 20 s.

- **Settings**: `phoneNumberId`, `businessAccountId` (WABA id), `displayNumber`. Secrets: a system-user `accessToken`, the app's `appSecret`.
- **Test**: `GET /<phoneNumberId>?fields=display_phone_number,verified_name,quality_rating` (stores `displayNumber`), and
  `GET /<businessAccountId>/message_templates?limit=1`. Nothing is sent.
- **Send**: `POST /<phoneNumberId>/messages` `{ messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } }`, or
  `type: "template"` with the template's name, language and body parameters. A reply passes `context: { message_id }`. HTTP 4xx with a Meta
  error → `failed` (with Meta's message, e.g. 131047 "more than 24 hours since the customer last replied"); network error or 5xx → `uncertain`.
- **Templates**: `GET /<businessAccountId>/message_templates?status=APPROVED&fields=name,language,status,category,components` → body text and
  the number of variables (`{{1}}` or named `{{first_name}}`; named ones are sent with their `parameter_name`). Left out of the list because
  body values alone can't fill them: templates with an image/video/document header, a value in the header or a button link, code buttons, and
  the authentication (login code) category.

## 5. Instagram (Instagram API with Instagram Login)

Graph base `https://graph.instagram.com/<META_GRAPH_VERSION>`. Settings: `instagramAccountId`, `username`. Secrets: the Instagram user
`accessToken` (long-lived) and the Instagram app's `appSecret` (it signs the webhooks).

- **Test**: `GET /me?fields=user_id,username` (the id must equal `instagramAccountId`; stores `username`).
- **Send** (replies only, within 24 hours of the person's last message): `POST /<instagramAccountId>/messages`
  `{ recipient: { id: <IGSID> }, message: { text } }`.
- First messages to someone who hasn't written are not sent by the app (Meta's rules): the draft reader offers "Open Instagram, copy the
  message" and Mark sent, like LinkedIn.

## 6. Meta webhook (WhatsApp and Instagram)

`GET|POST /v1/webhooks/meta`, mounted before the session gate, rate limited per IP, with the raw body (app.ts skips JSON parsing for
`/v1/webhooks/`).

- **GET** (Meta's handshake): `hub.mode=subscribe`, `hub.verify_token` equal to the `verifyToken` of any WhatsApp or Instagram account →
  answer `hub.challenge` as plain text; otherwise 403.
- **POST**: read the raw body (max 1 MB), parse it, collect the account ids it names (WhatsApp: `entry[].changes[].value.metadata.
  phone_number_id`; Instagram: `entry[].id`), load those accounts, and accept the delivery only if `X-Hub-Signature-256` equals
  `sha256=HMAC_SHA256(appSecret, rawBody)` (constant-time compare) for one of them; process only the entries of accounts whose app secret
  matched. Unsigned or wrongly signed: 401 and nothing stored. Once verified, answer 200 — unless a message couldn't be stored (a database
  hiccup): then 500, so Meta sends the delivery again (stored messages are skipped on the retry). Processing errors are logged and audited
  without bodies, numbers or secrets, never returned.
- Duplicate guard: each Meta message id (`wamid…`, Instagram `mid`) is processed once (unique index on inbound `message.externalId` per
  account; statuses update in place).
- **WhatsApp messages**: the sender's `wa_id` → `+<digits>`; matched to a lead in the account's ventures through `sales_channel_contacts`
  (`{ workspaceId, accountId, externalUserId, leadId }`, made when a person links a conversation) or the lead's WhatsApp/phone routes
  (normalised, exactly one lead). Matched: an inbound `whatsapp` activity (text, or "[image]", "[voice note]"… for media, never downloaded) via
  `applyActivity`, which records the WhatsApp opt-in "they_messaged" exactly as a person logging an inbound WhatsApp does. The words STOP,
  UNSUBSCRIBE or "stop messages" alone → the activity gets `replyType: "opt_out"` (the opt-out rules run: do not contact, follow-ups stop).
  Not matched (or several leads match): a **new conversation** in `sales_inbound` (one open conversation per account and sender, marked
  `open: true` until a person handles it, the unique index relies on that; up to 50 messages kept) for a person to link to a lead.
- **Hidden numbers** (WhatsApp, since April 2026): a sender may come with a per-business user id (`from_user_id`, `contacts[].user_id`)
  and no phone number. The phone is used when present, else that id; the id is saved on the contact link so later messages without a number
  still reach the lead. Sending to such an id alone is not built yet (sends use the phone).
- **Account updates** naming only the WhatsApp Business account (template status and the like) are matched by `businessAccountId`, verified
  and answered 200, so Meta never switches the webhook off for failures.
- **WhatsApp statuses** (`sent`, `delivered`, `read`, `failed` with errors): update `message.delivery` on the outbound activity with that
  `externalId`, and `delivery` on its draft. Never moves a stage.
- **Instagram messages** (`messaging[]` with `message`, skipping `is_echo` and our own sends): the sender's IGSID → matched through
  `sales_channel_contacts`, else by the username (looked up once with `GET /<IGSID>?fields=username,name`) against the lead's Instagram routes;
  otherwise a new conversation.

### Conversations API (`/v1/sales`, session only)

| Method and path | Who | Body | Answer |
|---|---|---|---|
| `GET /inbound` | writers | `?ventureId=` | open `InboundConversation[]` of accounts serving the person's ventures, newest first |
| `POST /inbound/:id/attach` | a writer who can edit the lead | `{ leadId }` (a lead in one of the account's ventures) | links the sender to the lead (`sales_channel_contacts`), files the kept messages as inbound activities, marks it handled → `{ conversation, lead }` |
| `POST /inbound/:id/dismiss` | writers | | marks it handled without a lead |

To answer someone who isn't a lead yet, a person creates the lead (the existing New lead form, prefilled with the number or handle) and then
links the conversation.

## 7. LinkedIn

A personal account holds the person's profile URL. LinkedIn drafts (connection notes up to 300 characters, messages) are sent by hand: the draft
reader opens the lead's LinkedIn route, copies the message, and the person marks it sent (choosing which profile, if they have several). The
daily cap (15 by default) counts these. No automation, no logged-in scraping.

## 8. Screens

- **Sales > Channels** (`/sales/live/channels`): "My connections" (mailboxes with provider presets: Gmail, Outlook, Zoho, Hostinger, Titan,
  or custom; LinkedIn profiles), "Venture numbers and accounts" (WhatsApp, Instagram; heads only can add), each with status, Test, default per
  venture, switch off, remove; WhatsApp/Instagram show the webhook URL and verify token with copy buttons and the setup steps.
- **Draft reader**: Send (choose the account when there are several; WhatsApp outside 24 hours: pick a template and fill its values), the
  uncertain state with "It went out / It didn't go", the delivery state (sent, delivered, read, failed, bounced). LinkedIn and first Instagram
  messages: Open profile + Copy + Mark sent.
- **Inbox**: channel icons (email, WhatsApp, Instagram, LinkedIn), "New conversations" (link to a lead, create a lead, dismiss), delivery ticks
  on our messages in the lead timeline. Answering happens in the Inbox: the reply box offers only the channels the lead can take (email
  with an address; WhatsApp once they opted in, and when the venture's number is connected only within 24 hours of their last WhatsApp,
  since outside it the number sends approved templates only; the others named with the reason) and says which account it goes out from
  (the person's mailbox, the venture's number, or their own app); a ready reply sends inline with the same send box, "Did you send it?"
  and how-it's-recorded line as the draft reader. Sending it, either way, marks the message it answers handled.
- **Setup checklist**: "Connect your mailbox" and, for heads, "Connect the venture's WhatsApp number".
- **Sales settings**: daily caps for LinkedIn and Instagram; Instagram in the channels a venture uses (off by default).

## 9. Setting up the Meta side (for the person connecting WhatsApp or Instagram)

1. In Meta Business Manager, create (or open) the app, add the WhatsApp product (and/or Instagram), and add the business phone number.
2. Create a system user with access to the WhatsApp Business account; generate a permanent token with `whatsapp_business_messaging` and
   `whatsapp_business_management` (Instagram: `instagram_business_basic`, `instagram_business_manage_messages`).
3. In Venture OS, Sales > Channels > Add WhatsApp number: paste the phone number id, the WhatsApp Business account id, the token and the app
   secret (App settings > Basic). Test.
4. In the Meta app's Webhooks settings: callback URL and verify token from the account card; subscribe to `messages` (WhatsApp) or `messages`
   (Instagram).
5. Message templates for first messages and follow-ups after 24 hours are created and approved in WhatsApp Manager.
