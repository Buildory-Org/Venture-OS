# Today: what needs the person now

Read-only until the person picks something.
For the full morning routine ("run my morning", "daybreak") follow `steps/daybreak.md` instead.

1. `start_sales` (mode work). Greet with its `say` (it names the offer being worked on), show the numbered `next` options (the
   first is the suggestion), follow its `workOn` (with several active offers, ask which one to work on), and show
   today as a compact table: the counts (replies waiting, calls due, follow-ups due, drafts to review, drafts sent back,
   ready to send, first messages to write, WhatsApp versions to write, verdicts that need them, won deals to hand over), then
   the top items of each queue. The `next` options start with the app's "Ask Claude" words ("Draft replies to my inbox",
   "Review drafts", "Fix the drafts that need changes", "Write a WhatsApp version for my opted-in leads", "Write first messages
   for my recommended leads", "Research and judge …"): when the person picks one, follow that row of the table in `SKILL.md`. For a venture head covering the team,
   `sales_overview` with scope `all` (optionally one venture).
2. Go deeper only when asked:
   - **Replies waiting:** `inbox` (a warm reply is answered within the venture's reply window: say how long each has waited).
   - **Calls today / "who should I call":** `find_leads` (stage approved_for_contact and contacted, sort `next`), then
     `get_lead` for each: opening signal, the published number, the last note. Offer an opening for the first one.
   - **Follow-ups due:** the one follow-up only, then stop (`steps/draft.md`).
   - **Drafts waiting:** `list_drafts` (status in_review, ready). Reviewing is for a new chat, never this one. A draft's
     `otherVersions` names its email or WhatsApp twin: the person sends one, which closes the other.
   - **Verdicts that need them:** `find_leads` with needsYou true: they decide in the app; say what the open question is.
   - **New leads with no verdict:** `find_leads` with verdict none (count, don't list them all).
3. Answer under four headings in the table: **Do now**, **Due today**, **Waiting**, **Needs your decision**. Each line: company,
   venture, one-line reason. Then the counts of what is left.
4. End with the first `next` option as one question ("Shall I sort the 2 replies first?").

Never move stages or save drafts in this step; hand off to the right step file when the person says yes.
