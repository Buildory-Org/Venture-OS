# Sales autopilot

Status: build spec v1, 2026-11-22. Branch `sales-outreach-flow`.

**Why.** Until now a person carried every step to a Claude chat ("run my morning", "review drafts in a new chat", "write first
messages"), then approved and sent each message one at a time. The work stopped wherever the person stopped. The autopilot moves the
steps Claude does onto the server, so a person's part shrinks to one: read the checked messages and approve the batch.

**What it is.** Per venture, off by default. When a head switches it on, the API process:

1. **Finds** up to N new companies each working day for one offer (the built-in finder, `docs/sales-dealflow.md` §10a).
2. **Judges** each new lead against its offer's approved packet, quoting the company's own pages.
3. **Writes** the first email for each recommended lead, and later the one follow-up.
4. **Reviews** every draft waiting for review in a separate call (drafts written in a Claude chat too).
5. **Sends** approved emails through the approver's mailbox, spaced, inside the daily caps (the send queue).
6. **Sorts replies** and drafts an answer for a person to send.

Contracts: `packages/contracts/src/sales-autopilot.ts`. Web client: `apps/web/src/lib/sales-autopilot-api.ts`.
Server: `apps/api/src/sales/autopilot/*`, `apps/api/src/sales/channels/send-queue.ts`, `apps/api/src/routes/sales-autopilot.ts`.

## 1. Rules it never breaks

The connector's rules for Claude live in `apps/api/src/mcp/tools-sales.ts`, not in the API routes. The autopilot does not go through the
connector, so it applies the same rules itself (share the functions where they can be exported; never copy a rule in a weaker form).

1. **Off until switched on.** `SALES_AUTOPILOT=on` on the server (the API's own default is **off**, and it never runs under tests; the
   production stack in `deploy/compose.yaml` sets it on unless `deploy/.env` says `off`),
   `sales_settings.autopilot.enabled` per venture (default false), and `ANTHROPIC_API_KEY` for Claude's steps. Without any of the three,
   that part does nothing and says why (§6 blockers).
2. **It works as a named person, who agreed.** `autopilot.runAsUserId`, an active member who can write in the venture. Leads it adds are
   theirs. A person can only name **themself**: nobody makes someone else the sender. Automatic sending can only be switched on by that
   person, because the emails go from their mailbox; that includes switching a stopped autopilot back on with "automatic" still stored.
   Switching it off is always open to a head or an admin. Verdicts, drafts and reviews are written `via: "claude"` (so nothing it writes
   counts as a person's decision), audit channel `engine`.
3. **Evidence or nothing.** A verdict's evidence quote must appear word for word (case and white space aside) in the text of the page at
   its URL, as the server read that page in this pass. A quote that is not found is dropped. A "recommend" needs a verified signal quote
   and no failed gate, else it is saved as "hold" (which waits for a person: `needsYou`). The page text is never stored.
4. **A person's word stands.** A lead whose verdict a person set or overrode, or that waits for a person (`needsYou`), is never judged
   again, and no draft is written for it.
5. **Claude never approves its own work.** The review is a separate model call with its own session id (`auto-r:<uuid>`, never the
   writer's `auto-w:<uuid>`), given only the draft, the lead's facts, the offer's rules and the checks: never the writer's reasoning.
   The autopilot never sets `personApproval`, never approves a play, an offer or a brain note, and never overrides a verdict.
6. **The message rules.** Same as the connector: a draft only for a "recommend" lead that does not wait for a person; a first message
   only before first contact; one follow-up, only at "contacted", then stop; an email needs a subject; no links except one `wa.me` link
   on the last line of an email; nothing for a do-not-contact lead; one open version per channel. It writes **email only** (no WhatsApp,
   Instagram, LinkedIn or call opener).
7. **People approve; the app only sends what was approved.** A draft enters the send queue when a person taps "Approve and send" (they
   are the sender), or, under the "automatic" mode, when it passed review and needs no person's approval (the play's first batch was
   approved by a head and the venture does not ask for a person on every message): then the sender is the person it works as.
   Email only. Every send goes through `sendDraftThrough` (`sales/channels/dispatch.ts`), which checks everything again at that moment:
   do-not-contact, approval, the channel, the version, the cap.
8. **A draft that changed is not sent.** The queue keeps the draft's `updatedAt` from when it was queued (`sendQueue.version`); any
   edit, review or other change since takes it out of the queue.
9. **Spaced, in working hours, inside the caps.** Sends go on the venture's working days between 10:00 and 19:00 (its time zone), 4 to
   10 minutes apart per sender and per mailbox (never like clockwork), and never past `dailyCaps.email`: the rest waits for the next
   working day.
9a. **The sender's mailbox and domain are protected** (section 5a). A mailbox warms up (5 cold emails a day from the queue at first, 5
   more after every 5 days it sent on, up to the cap). An address that bounced, was refused or whose domain takes no mail is never
   mailed again. Three bounces among a mailbox's last 50 emails pause its queue for three days; the mail server's own push-back pauses
   it too. Nothing goes out automatically from a domain without SPF and DMARC records.
10. **Stop on reply, and opt-outs at once.** A reply discards the pending follow-up (already so). A reply Claude sorts as opt-out or
    hostile puts the company on the do-not-contact list at once, as when a person sorts it. Replies are **never** answered
    automatically: the answer is a draft a person sends.
11. **Text from outside is data.** Page text, lead fields and replies go to Claude inside marked blocks, with the instruction to treat
    them as data. The model has no tools; it returns one structured answer (zod), which the server checks before saving anything.
12. **A spend cap, three layers.** (a) `autopilot.dailyLeadLimit` leads judged or written per venture and local day, with small limits
    per pass. (b) A hard budget on calls to Claude per venture and day, checked before every call of every step:
    `dailyLeadLimit * 6 + 60`; when it is used up nothing more is asked that day and the status says so. (c) Every item (a lead, a draft,
    a reply) keeps its own attempt count (`autopilot` on the item, `AUTOPILOT_MAX_TRIES`): three tries with a growing wait, then it is
    left for a person. A try counts only when Claude was really asked about that item and the answer was unusable: a spent budget, a
    rate limit, a timeout or a key problem never costs an item a try. What it gave up on is counted in the status (`stuck`) and shown:
    Today and the Autopilot card say how many, Review lists the drafts it could not check, the Inbox and the lead drawer offer the
    Claude chat again for that item. Each call logs one JSON line
    (event, model, tokens, stop reason; never text) and counts in `sales_autopilot_days`.
13. **Stopping means stopped.** A draft a person took back out of the queue, or that the queue gave up on, is held (`queueHold`): the
    autopilot never queues it again; only a person does. Switching the venture off, leaving "automatic" or changing the person it works
    as takes every automatically queued email back out of the queue at once, and the queue worker checks the same thing again before
    each automatic send.

`docs/sales-dealflow.md` §1 is updated to match (the app does send now, on a person's approval).

## 2. Settings

`salesSettingsSchema.autopilot` (`autopilotSettingsSchema`), stored in the venture's `sales_settings` row:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | false | the venture's switch |
| `runAsUserId` | the head who switched it on | who it works as |
| `find` `{ enabled, offerId, request, places, perDay }` | off, 10 a day | the standing find rule |
| `judge`, `write`, `review`, `followUps`, `replies` | true | Claude's steps |
| `send` | `by_hand` | `by_hand`, `after_approval` or `automatic` (rule 7) |
| `dailyLeadLimit` | 25 | rule 12 |

- `PUT /v1/sales/settings` takes `salesSettingsInputSchema` (no `autopilot`) and **keeps the stored autopilot**.
- `PUT /v1/sales/autopilot?ventureId=` saves the autopilot only: head or admin, in the app (`forbidClaude`). Switching it on without
  `runAsUserId` sets the caller. `runAsUserId` may only be the caller, or stay what is stored; that person must be an active member who
  can write in the venture. `send: "automatic"` is accepted only from the run-as person, or unchanged with the same run-as person.
  `find.offerId`, when given, must be an offer of the venture. Switching off, leaving "automatic" or changing the run-as person drops the
  automatically queued emails (`dropAutoQueued`). Audit `sales.autopilot.update` with the changed field names.

## 3. Data

- `sales_settings.autopilot`: the settings.
- `sales_drafts.sendQueue` (`draftSendQueueSchema`): `{ at, by, auto?, accountId?, version, notBefore, attempts, lastError? }` on a ready
  draft that waits to be sent. Index `{ "sendQueue.notBefore": 1 }` (sparse/partial) for the worker.
- `sales_drafts.queueHold`: `{ at, by?, reason }` on a draft that left the queue unsent (a person took it back, or the worker gave up).
  Only a person queueing it again clears it.
- `sales_autopilot_state`: `_id` = ventureId; `{ workspaceId, leaseUntil, workerId, lastRunAt, lastError?, runRequestedAt?, findDay? }`.
- `sales_autopilot_days`: `_id` = `${ventureId}:${day}`; `{ workspaceId, ventureId, day, ...counts }` (`autopilotDaySchema`), kept with `$inc`.

## 4. The loop (`sales/autopilot/runner.ts`)

`createAutopilot({ database, env, model?, reader?, now?, pollMs?, log? })` returns `{ runOnce(ventureId?), start(), stop() }`, built like
`createFinder`. `autopilotEnabled(config)` = `SALES_AUTOPILOT === "on" && NODE_ENV !== "test"`. Every 60 s it takes each venture whose
autopilot is on, one at a time, under a lease (5 minutes, renewed while it works; a second API process skips a venture another holds).
`POST /v1/sales/autopilot/run` sets `runRequestedAt` so the next tick takes that venture first.

One pass, in this order (the most urgent first, each step only when its switch is on and its blockers are clear):

1. **Replies** (≤ 10): inbound message activities on the venture's leads that wait in the Inbox with no `replyType`. Claude picks the
   reply type (`REPLY_TYPES`, never "silence") and, for a warm one (interested, send_details, price_first, wrong_person…), writes a reply
   draft (`purpose: "reply"`, `inReplyTo`, email only, same thread). The type is applied through the same function the app uses
   (`applyReplyType`), so opt-outs suppress at once. A reply draft goes to review like any draft and is never queued.
2. **Review** (≤ 10): drafts `in_review` in the venture. One call each → `pass` or `fail` with issues, saved through the same rule as
   the route (`reviewOutcome`, via "claude", the reviewer session id). A person's approval notice fires as it does today.
3. **Fix** (≤ 5): drafts `needs_changes` that the autopilot wrote and that were revised fewer than 2 times: the writer rewrites with the
   reviewer's issues, the draft returns to `in_review`. After 2 rounds it stays for a person.
4. **Follow-ups** (≤ 5): leads at `contacted` whose `followUpDueAt` has come, with no open or sent follow-up: the one follow-up email.
5. **First messages** (≤ 5): leads `approved_for_contact` with a "recommend" verdict, not waiting for a person, with a published email
   route and no first message open or sent.
6. **Judge** (≤ 5): leads at `identified` with a website and no verdict. The server reads the site with the finder's reader
   (`createReader`, `parseHtml`, `pickPages`: robots.txt, private-address and CAPTCHA checks apply), gives Claude the page lines, and
   checks the answer (rule 3). A site that can't be read gives a "hold" with that reason, without a model call.
7. **Find**: on a working day, when the rule is on and no autopilot find run was made today: one queued find run (`kind: "find"`,
   `plan.limit = perDay`, the rule's offer, request and places), created as the person it works as. The built-in finder works it.
8. **Queue** (mode `automatic` only): ready email drafts that need no person's approval and are not queued → `enqueueDraft` as the
   person it works as (`auto: true`).

Steps 4 to 6 share the day's `dailyLeadLimit`. A failure on one lead is logged and counted; the pass goes on. A model error that will
not pass by itself (no key, bad key, no credit) stops the pass and is kept as `lastError`.

### The model (`sales/autopilot/model.ts`)

`AutopilotModel = { ask<T>(question: { event, system, user, schema, maxTokens, timeoutMs }): Promise<{ value: T; usage } | { error; lasting? }> }`.
The real one follows `apps/api/src/expense-receipts.ts` (`messages.parse` with a zod output format, `maxRetries: 0`, a timeout, never
throws, logs tokens only), with the model from `SALES_AUTOPILOT_MODEL`. Tests pass a fake. Prompts are in the same folder, one file per
step, each with: the venture's approved offer packet (who it is for, gates, signals, what we say, message rules, price boundary), the
approved brain notes, the lead's facts, and for the judge the page lines. No prompt ever contains a key, a password or another lead.

## 5. The send queue (`sales/channels/send-queue.ts`)

```ts
export const sendQueueEnabled = (config: { SALES_AUTOPILOT: "on" | "off"; NODE_ENV: string }) => boolean;
export type EnqueueResult = { queued: true; notBefore: Date } | { queued: false; reason: string };
/** Puts a ready email draft in the queue to go from ctx.actor's mailbox. Refuses, with the reason in plain words, what a send would refuse. */
export function enqueueDraft(ctx: SalesCtx, env: ChannelEnv, draft: AppDocument, lead: AppDocument, options?: { auto?: boolean; accountId?: string; now?: Date }): Promise<EnqueueResult>;
export function unqueueDraft(ctx: SalesCtx, draft: AppDocument, now?: Date): Promise<boolean>;
export function createSendQueue(options: { database: Database; env: ChannelEnv; pollMs?: number; now?: () => Date; gapMs?: () => number; log?: (line: Record<string, unknown>) => void }): { runOnce(): Promise<number>; start(): void; stop(): Promise<void> };
```

- **Enqueue** checks: a first message or the follow-up (a reply is sent from the Inbox, never queued); email channel; status ready; no `sendLock`; not queued already; `sendBlocker` and the version rule clear; the sender
  may edit the lead; the sender has an enabled mailbox usable for the venture (the given one, else their default); the lead has an email
  to send to. `notBefore` = the later of now and the sender's last queued `notBefore` for the venture plus the gap, moved into the next
  working window when it falls outside one. Sets `sendQueue` with `version` = the draft's `updatedAt` **after** this write. Audit
  `sales.draft.queue`.
- **Worker**, every 60 s: drafts with `sendQueue.notBefore <= now`, status ready, no `sendLock`, oldest first, one per sender and
  venture per tick. Outside the working window → `notBefore` moves to the next one. Builds the sender's ctx (`actorFor`, via "app",
  channel "engine") and calls `sendDraftThrough` with `expectedUpdatedAt: sendQueue.version` and a `requestId` fixed per draft and queue
  entry (so a retry never sends twice). Sent → `sendQueue` unset (the day's `sent` counts). The daily cap reached → `notBefore` = the next
  working day 10:00. Draft changed, a blocker, no mailbox → out of the queue with `lastError` kept on the draft's audit and a
  notification to the sender. A provider failure → `attempts + 1` and retry in 15 minutes, out of the queue after 3. An uncertain send →
  out of the queue (the person says whether it went, as today).
- One sender and venture is claimed at a time (a lock per sender and venture), and the worker checks the sender's last send before each
  one, so two API processes can't send a sender's messages closer together than the gap.
- Before each send the worker asks the sender protection (section 5a) about the mailbox it would go from: paused → the sender's entries
  wait for the pause to end; the mailbox's last message was less than the gap ago (for any venture) → it waits its turn; an `auto` entry
  from a domain without SPF or DMARC → it waits 6 hours and the sender is told once a day; the lead's domain takes no mail → out of the
  queue, the address remembered. A mail server's answer that is about the mailbox (a refused password, "slow down", a block) pauses the
  mailbox instead of counting as a failed try: `attempts` stays, `sendQueue.waits` goes up (the next send is a new request, not a replay).
  A refused address leaves the queue at once.
- An `auto` entry is sent only while the venture is still on, still "automatic", and still works as the same person; otherwise it is
  dropped. `dropAutoQueued(scope, ventureId, reason)` drops them all when the settings change.
- Editing, vetoing, discarding or sending a queued draft by hand takes it out of the queue (the routes unset `sendQueue`).
- Lists: a queued draft is in neither `toReview` nor `readyToSend`; `counts.queuedToSend` counts them and `counts.toApprove` counts ready
  drafts that wait for a person's approval. Draft rows carry `sendQueue`.

## 5a. Sender protection (`sales/channels/mailbox-guard.ts`)

Receiving mail servers rate a sender by how it behaves. These rules keep a mailbox, and the domain behind it, in good standing while
the app sends for it. They need no setting and no key. "Cold" means a first message or a follow-up; an answer to a reply is never cold.

| Rule | What happens | Where |
|---|---|---|
| Warm-up limit | The queue sends at most 5 cold emails a day from a mailbox at first, and 5 more after every 5 days the mailbox sent on (counted over the last 30 days), up to the venture's `dailyCaps.email`: 5, 10, 15, 20. The rest waits for the next working day, quietly. Every cold email sent through the app counts (one row per mailbox and day in `sales_mailbox_days`); a person's own "Send now" is counted but never held. | `claimMailboxSlot` in `sendDraftThrough` |
| Spacing | 4 to 10 minutes between one mailbox's queued emails, whichever venture they are for (`guard.nextAt`). | the worker |
| Bad addresses | An address that bounced, that the mail server refused as wrong (a 5xx to RCPT TO with a 5.1.x, 5.2.1 or 5.4.1 status, or none), or whose domain has no mail server is kept in `sales_bad_addresses`. No cold email goes to it again from the app, by hand or from the queue, and none is written for it (the app, Claude's `save_draft` and the autopilot's own writer are refused); the refusal says so and what to do (another address, or send it yourself and mark it sent). An answer to a reply still goes: they wrote from somewhere. | `addressBlocker` in `POST /leads/:id/drafts`, the autopilot's write step, enqueue, and both checks of `sendDraftThrough` |
| The lead's mail server | Before a queued send the lead's domain is looked up (MX, else an IPv4 or IPv6 address). A definite "no" takes the email out of the queue; a lookup that fails lets it go. | `canReceiveMail` in the worker |
| Bounces | The inbox sync tells the protection about every bounce (`noteBounce`): the address is remembered, the sender is told once ("Bounced: email to Acme"), and the mailbox's last 50 emails of the last two weeks are counted. Three bounces pause its queue for three days and start the warm-up again at 5 a day. | `email/sync.ts` markBounced |
| The mail server's push-back | A 4xx answer about us ("try again later" at MAIL FROM or DATA, or a rate or limit anywhere) pauses the mailbox for an hour. A 5xx answer about the sender (a sending limit, a rate or quota, spam, a block list, reputation, a suspended account, relaying refused, or a 5.7.x policy status at MAIL FROM or DATA) pauses it until the next working day at 10:00. A refused password pauses it until the password is entered again or a test passes (it is tried again every 6 hours). The emails stay queued, untried. An answer about the lead's side (greylisting, a full mailbox, a server that only takes mail from certain senders) pauses nothing and blames no address: that email is tried again like any failure. | `refusalKind` in `email/provider.ts` names the `kind`; the worker pauses |
| One email, not the mailbox | The email whose answer paused the mailbox goes to the back of its sender's line. If it alone keeps getting that answer while the others go, its third one counts as its own failed try (`MAX_WAITS` = 2), so one lead can never stall a sender's queue. | the worker |
| SPF and DMARC | The sending domain's records are looked up at most once a day (once an hour while something is missing; the Test button looks at once). Missing SPF or DMARC holds **automatic** entries only: nobody reads those before they go. Emails a person approved still go; the mailbox's card, its Test result and the Autopilot card say what is missing. A shared mail domain (gmail.com) is not looked up. | `senderRecordsFor`, `recordsProblem` |

- The state lives on the mailbox's row as `guard` (`pausedUntil`, `pauseKind`, `pauseReason`, `rampSince`, `nextAt`, `dns`, `dayLimit`).
  The API never returns it raw: a mailbox carries `protection` (`pauseNote`, `domainNote`, `dayLimit`, `dayCap`) only while there is
  something to say.
- Every pause is audited (`sales.channel.pause`) and told to the mailbox's owner once a day per kind, with a link to Channels. A pause
  that already lasts longer is never shortened by a shorter one.
- A lookup that fails (DNS down, a timeout) never holds or drops anything: only a definite answer does.
- What it does not do: it does not judge the text (the review does), it does not warm a mailbox up with made-up mail, it does not look
  at DKIM (the selector is not public knowledge), and it does not hold a person's own "Send now" except for a bad address.
- Under the test runner nothing is looked up unless a test hands in a resolver (`useGuardDnsForTests`).

### Several drafts at once: `POST /v1/sales/drafts/batch`

`draftBatchInputSchema` → `draftBatchResultSchema`. A person only (`forbidClaude`). Up to 50 drafts; each answers on its own.
`approve` follows the single approve route's rules exactly (who may approve, the play's first-batch count). `approve_and_send` approves
where a person's approval is needed and the caller may give it, then queues each email it can; a draft that can't be queued stays
approved, with the reason ("WhatsApp is sent by hand", "Connect your mailbox to send from the app"). `send` queues only. `unqueue` is
for the person who queued it, a head or an admin.

## 6. Status: `GET /v1/sales/autopilot?ventureId=`

`autopilotStatusSchema`: the settings, `canChange`, who it works as, what the server can do, the state, the blockers, today's and the
previous active day's counts, and what waits. Anyone who can open the venture reads it. Blockers are plain sentences that say what fixes
them, for example:

- "Autopilot is switched off on this server." (no step)
- "Claude isn't set up on this server yet: an admin adds the key." (judge, write, review, followUps, replies)
- "Pick an offer for the daily search." / "Company search has no key: an admin adds one in Sales settings." (find)
- "{name} has no mailbox connected: connect one in Channels." (send)
- "The send queue is paused for {address} until {when}: {why}." (send; the rest of the work goes on)
- "Automatic sending waits: {domain} has no SPF or DMARC record, …" (send, mode "automatic" only)
- "The offer has no approved packet yet." (judge, write)

## 7. Screens (web)

- **Sidebar**: four groups instead of 13 flat rows: Work (Today, Review, Inbox, Calls), Leads (Leads, Pipeline, Find leads), Plan
  (Offers, Plays, Reports), Setup (Channels, Do not contact, Sales settings). One name per page everywhere ("Today", "Sales settings").
- **Today**: an autopilot strip on top ("Since yesterday: found 10, judged 10, wrote 6, 5 passed the check. 5 wait for your
  approval." with one button to the Review queue); the four stat tiles that repeated the list's filters are gone.
- **Review**: grouped by what the person does: **Approve**, **Send**, **Fix**, then a quiet line for what Claude is still checking and
  what is queued to send (with the time). Select all, "Approve and send N". One word per state everywhere.
- **Inbox**: when the autopilot sorts replies, the reply type arrives filled in and the answer is drafted.
- **Find leads**: the standing rule on top ("Every working day, find 10 …"), the one-off form under "Run once".
- **Sales settings**: an Autopilot card (switch, who it works as, the steps, the three sending levels, the daily limit, blockers).
- **Channels**: a mailbox's card says what the sender protection is doing (section 5a): a paused queue and why, a record its domain
  lacks, and the warm-up limit while it is below the cap. Test adds a "Domain records (SPF, DMARC)" check.
- **"Ask Claude" chips** stay only where the app does not do the step itself (the autopilot off, or the step switched off).

## 8. Tests and switches

- `apps/api/test/sales-autopilot.test.ts`, `apps/api/test/sales-send-queue.test.ts`: a fake model, a fake page reader and a fake mail
  provider; never a real network call, never a real send.
- `apps/api/test/sales-sender-protection.test.ts`: the warm-up, bad addresses, the pauses and the domain's records (section 5a), with a
  fake mail provider and a fake DNS resolver.
- `SALES_AUTOPILOT=on|off` (default **off**; never under tests). `SALES_AUTOPILOT_MODEL` (default `claude-opus-5-5`).
- Production (`deploy/compose.yaml`) passes both to the API and sets `SALES_AUTOPILOT` on unless `deploy/.env` says `off`, so "Approve and
  send" works there without a setting. Each venture's autopilot is still off until a head switches it on.
- The local demo server runs with `SALES_AUTOPILOT=on`, no Claude key, and one mailbox on a `.example` mail server, which can never be
  reached: it shows the screens and can send nothing.

## 9. Known limits

- **The signal quote is checked for being on the page, not for being a good signal.** A quote must be word for word on the page, at
  least 20 characters and 4 words, but the server does not check that it matches the offer's "look for" list: Claude decides that. The
  person's read of a play's first batch, and the separate review, are what catch a weak reason.
- **The no-links rule works from a list of endings.** It catches web and email addresses with common endings, paths, `www.` and `@`.
  An unusual ending with no path can slip past the server check; the reviewer is told to fail it too.
- **Spacing counts what the queue sent.** An email a person sends by hand does not push the queue's next send back; it does count
  toward the daily cap.

## 10. Not in v1

WhatsApp, Instagram and LinkedIn sends by the app; automatic answers to replies; closing quiet leads; more than one follow-up; per-step
models; a spend limit in money.
