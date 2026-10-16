# Replies, calls and what happened

1. Name the lead by company (every tool accepts it); if several match, ask which. `get_lead` shows its timeline.
2. A person says they sent something: they mark it sent in the app (you can't). Remind them the one follow-up is due after the
   venture's follow-up days.
3. Sort a reply into one type with `log_reply` (channel, their words in `body` copied short, `replyType`):

| Type | Looks like | The app does, then you |
|---|---|---|
| interested | "yes, tell me", "how does it work", "call me" | next action to book the call (2 working hours); draft two call slots |
| send_details | "send brochure / details" | next action "Send details"; draft a short summary and the call offer, no attachment |
| price_first | "how much?" | next action; draft the approved price wording only (the lead's offer packet: `get_offer`), then the call offer |
| not_now | "later", "after the season" | check-back in 30 days; thinking if it was at replied; nothing to send unless asked |
| wrong_person | "talk to the owner" | next action "Find the right person"; draft a short note asking who and the right route |
| has_system | names a tool | ask what it does badly; if fully covered, set the lead lost "has system" (`update_lead`) |
| opt_out / hostile | "stop", "how did you get my number" | closed and on the do-not-contact list; nothing more is written. A person may apologise by hand |
| unclear | emoji, off-topic | clarify once, then treat it as silence |

   **Silence** is not a reply: don't log it. The follow-up date tracks it; after the one follow-up the person sets the lead lost
   ("no response").
4. A WhatsApp message from the lead does not switch WhatsApp on by itself when you log it: a person confirms it in the app (the
   Inbox, or Confirm WhatsApp on the lead). Until then answer by email. Same for "yes to WhatsApp" on a call you log: when the
   person logs that call themselves in the app, it records the opt-in at once. Once a lead opted in and its first message still
   waits as an email only, write its WhatsApp version (`steps/draft.md`, "The WhatsApp version").
5. Draft the answer with `save_draft` (purpose `reply`, no id needed) from the approved wording, and say it needs a review in a new
   chat; once it passes, the person sends it from the app's Inbox (no need to open Review). Warm replies are due within the venture's
   reply window: when that is close, say they can also write the answer themselves in the Inbox, where a reply a person writes is
   ready to send at once (no review), or ask you to check it first.
6. After a call the person tells you how it went: `log_call` (outcome: interested_book, send_details, call_back, no_answer, busy,
   not_interested, wrong_person, wrong_number, yes_whatsapp) with what they learned in `note`: their process, the problem in
   their words, who decides, the next step with a date. Offer a summary draft to send within 24 hours. `update_lead` sets a
   next action, value and currency, or a stage one step forward. Winning a deal is the person's decision in the app.

## Draft replies to my inbox

"Draft replies to my inbox": the whole Inbox, answered as drafts.

1. `inbox` (waiting, scope mine). Show it as a compact table: company, channel, what they said (short), reply type, hours
   waiting; warm replies (interested, send details, price first) past the reply window first.
2. For each lead, answer its latest message, from the approved wording in its offer packet (`get_offer`) and the reply-type table above:
   one `save_drafts` call with purpose `reply` and `inReplyTo` the message's `activityId` (25 at a time). Answer on the channel
   they wrote on; WhatsApp only when the lead opted in, otherwise by email.
3. Nothing to draft for opt-outs and hostile replies, or a reply that only says "not now" (unless the person asks). A message
   that arrived by itself (mail or WhatsApp) has no reply type yet: you can't sort it (no tool does), so draft the answer from
   what it says and tell the person to sort it in the app's Inbox.
4. Report: drafted, skipped (and why), and that the drafts need a review in a new chat ("review drafts"); then the person sends
   each one from the Inbox, where it shows under the message. Answering a message clears it from the Inbox once the person sends the
   reply. A reply that reached their phone or own mailbox gets into the Inbox when they log it with They replied on the lead (or you
   log it with `log_reply`).
