# Draft a message

Only for a lead whose latest verdict says recommend (or an answer to a reply the lead sent).

1. `get_lead` (company): the verdict, the signal to open with, the published contact route, whether the lead opted in to
   WhatsApp, the timeline (what was already sent, any reply) and the drafts waiting (each shows its `otherVersions`). Never draft
   a second follow-up, and never draft to a lead that opted out, is closed or is waiting for a person's decision (the tool refuses
   those).
2. From the lead's offer packet (`get_offer`) take the message rules, the template the verdict named, the approved claims and
   proof words, the claims to avoid and the price boundary (`get_brain` has the venture's shared notes). If something you need
   is missing, say what is missing instead of inventing wording. Respect the venture settings line: only allowed channels,
   daily caps, and the language/send window.
3. Channel: the first allowed channel the lead publishes (default email; WhatsApp only when the lead opted in, and only a person
   records that; LinkedIn is always sent by hand). Email may end with one `wa.me` line to invite a WhatsApp reply. When the lead
   opted in to WhatsApp, write the email AND a WhatsApp version (below).
4. Write from the template: line 1 is the observed signal (it must match the verdict's quote); then a question; then what we do
   in one plain sentence; then proof only in the approved words; then one call to action. No price, no links (except the one
   wa.me line on an email), no attachments. Personalise only from the evidence. Keep to the channel's length (Buildory: email
   about 100 words, WhatsApp about 60).
5. `save_draft` (name the lead by `company`; channel, subject, body). For many leads `save_drafts` (up to 25, partial success
   per lead). Tell the person the word count and that it needs a review in a **new chat** ("review drafts") before it goes
   out. Do not review it yourself.

A lead has one waiting draft per channel for its first message and for its follow-up: a second one on the same channel is
refused ("already has an email first message waiting"); change the waiting one with `revise_draft` instead.

## First messages for the recommended leads

"Write first messages for my recommended leads": `find_leads` (verdict `recommend`, stage `approved_for_contact`, owner `me`,
one offer at a time, sort `relevance`), read that offer's packet once (`get_offer`), then write steps 1 to 4 for each and save
them with `save_drafts` (purpose `first_touch`, 25 at a time). A lead that already has a first message waiting comes back
refused for that lead only: leave it and say so. A lead that opted in to WhatsApp gets its WhatsApp version in the same batch.
Report: written, refused (with the reason), left; then point to "review drafts" in a new chat. **In a full run**
(`steps/full-run.md`) don't report or point anywhere yet: keep the draft ids and go straight on to its independent review
(a fresh review subagent in Claude Code), then fix what fails with `revise_draft` as below.

"Write the first message for <company>" is the same for one lead (and its WhatsApp version when it opted in).

## The WhatsApp version

"Write a WhatsApp version for <company>", the daybreak list `whatsappVersions`, or a `next` option that says it. The lead opted
in to WhatsApp (they messaged us, or a person recorded their yes) and its first message waits as an email only: write the same
first message for WhatsApp so the person can choose which one to send.

- The offer's WhatsApp rules: short (about 60 words), plain text, no subject, no link, the language the offer says.
- Keep the email version's opening signal and its one question (daybreak gives the email under `emailDraft`; otherwise
  `get_lead`). It is the same message, not a second pitch.
- `save_draft` with `channel: "whatsapp"`, `purpose: "first_touch"`. It is allowed even though a yes-to-WhatsApp call moved the
  lead to replied, as long as no message went either way: nothing sent to the lead yet, and nothing from it. A lead that wrote to
  us (on WhatsApp or by email) gets a reply instead (purpose `reply`). Several leads: one `save_drafts` call.
- Both versions go to review in a new chat. The person sends one; the app then closes the other and records why ("the WhatsApp
  version of this first message was sent"). Once a first message went out there is no other version to write: the tool refuses, and the next message is
  the follow-up or a reply.
- No opt-in yet: no WhatsApp version (the tool refuses). Tell the person a yes on a call, logged by them in the app, records it.

## Fix the drafts that need changes

"Fix the drafts that need changes": in a work chat, `list_drafts` (status `needs_changes`, scope `mine`). For each one apply
exactly the reviewer's `issues` (nothing else) with `revise_draft` (draft id, the new `body` and/or `subject`; give `channel`
when the new body ends with a wa.me line). It goes back to review: say it needs another review in a new chat ("review drafts"),
and never review your own fix. If an issue can't be fixed from the evidence or the offer's packet, say so instead of guessing.

A **reply** draft (`purpose` reply) answers the lead's latest message; no id is needed. Warm replies are due within the
venture's reply window: say so. A follow-up is the one allowed per lead, after the venture's follow-up days; it may also have an
email and a WhatsApp version (opt-in only), and sending one closes the other.

For a play with two variants, draft each lead in its assigned variant and put "variant A" or "variant B" at the start of the
subject line (the person removes it when sending).
