# Expense tracker

What the studio spends, counted in rupees (and shown in any currency): for each venture, the Office and Personal. It lives in Studio at **Expenses** (`/expenses/live`), and the API is under `/v1/expenses`. The data rules and the repeat logic are shared in `packages/contracts/src/expenses.ts`.

## What an expense is

- **Fields:**
  - the date paid;
  - the amount: in rupees (paise, at most ₹1,000 crore), or in another currency (see [Currencies](#currencies));
  - a category;
  - an optional group;
  - who it was paid to;
  - where it's charged (a venture, Office or Personal);
  - an optional note;
  - optional tags (see [Tags](#tags));
  - an optional receipt (see [Receipts](#receipts)).
- **No numbers that could identify an account.** Labels (who it was paid to, notes, tags, category and group names) refuse what reads like an account, card or phone number (`LONG_NUMBER`):
  - 9 or more digits in a row;
  - a card's groups of four;
  - a phone number in two groups of five or three groups.

  Dates, times and invoice numbers such as `INV-2026-10-00123` are fine. Only amounts and labels are stored.
- **Repeats:**
  - One-time, monthly or yearly. A repeat lands on the same day of the month, or on the month's last day when the month is shorter.
  - A repeating expense continues until its **last month**, which is optional and included.
  - All dates are between 2000 and 2099.
  - Totals are worked out from these rules (`occurrenceIn`), so no scheduled job has to create monthly copies.
- **"Price changed?"** (`POST /v1/expenses/:id/change`):
  - The expense stops the month before the change, and a copy with the new amount starts that month (`continuesId` points back to the original).
  - Earlier months keep what was actually paid.
  - The copy keeps the original's day of the month in `anchorDay`, so the 31st stays the 31st after a 30-day month.
  - Editing the amount directly changes every month.
- **Delete** removes an expense for good. The audit log records that it happened.
  - Deleting the copy a price change made **undoes** that change: the original carries on as before.
- **Version check:** an edit, a price change or a delete sends the version it was made from (`expectedUpdatedAt`). A change saved in the meantime refuses it (409) instead of being overwritten, and the form sends only the fields that changed.

## Currencies

- **Paid in:** the rupee, or one of the ~30 currencies the European Central Bank publishes a daily reference rate for (`EXPENSE_CURRENCIES`: USD, EUR, GBP, SGD, AUD, CAD, CHF, JPY, …; no AED). The amount is kept in that currency's smallest unit (`foreign.amountMinor`; none for the yen, the won and the króna).
- **What it counts as in rupees** (`amountPaise`, which every total reads):
  - **What the bank charged**, when given ("Charged in ₹", one-time payments only): counted exactly, card markup and GST on forex included (`chargedPaise`).
  - **Otherwise the day's rate:** the amount at the reference rate of the day it was paid, or the latest published before it (a weekend's is the Friday's; a day still to come takes the latest). The rate and its day are kept (`rate`, `rateDate`), so a past month's total never changes.
  - **Repeating** payments in another currency convert at each payment's own day's rate (their first at the saved rate). "Price changed?" takes the new amount in the expense's own currency.
  - Editing the amount, currency, bank figure or date prices it again; other edits keep its rate.
- **Shown in:** the picker at the top of the page ("Show amounts in", rupees by default, remembered on this device) shows every total, chart, list, the Monthly table and the CSVs in that currency: each payment at its own day's rate, and one paid in that very currency exactly as paid. Rows paid in another currency also show what was paid ("paid €6.49").
- **Rates:** the API asks Frankfurter (`EXCHANGE_RATES_URL`, the European Central Bank's reference rates, no key) for each working day once and keeps it (`exchange_rates`; the span kept is in `exchange_rate_coverage`, its latest days asked for again every six hours). Only dates and currency codes go out. When the source can't be reached it isn't asked again for ten minutes: the screens use the kept rates (or fall back to rupees and say so), and a new expense in another currency asks for the bank's figure or a moment's wait (503).

## Upcoming payments

- **What:** three days before each payment of a repeating expense (monthly or yearly), at 10:00 India time, a "Payment due" notice: "Anthropic: $20 due on Thu, 5 Nov (about ₹1,902)". One-time expenses get none.
- **Who:** everyone who manages expenses (admins by default); restricted categories (salaries, EMIs) only to those who see them. It arrives like other notices (the inbox, the pop-up with the short task beep, push when the site is closed) and follows the **Upcoming payments** switch in Notifications → Delivery preferences.
- **One row per subscription:** each month's notice joins the same inbox row (its count and the dates it came), and comes back on top.
- **Actions:** ↗ opens the expense; ■ "Stop after this payment" opens it with its last month set to that payment's month (saving confirms it).
- **How it is kept in step:** the worker plans one reminder per expense and manager (kind `expense_due`) from the expenses every few minutes, so new subscriptions, edits, stops, deletions and access changes are followed without the API doing anything. Before sending it checks again: the expense still repeats and is paid that day, the person still manages expenses and may see it, and the day hasn't passed (a worker that was away skips to the next payment). Each notice has its own idempotency key (reminder and payment day), so a retry never sends it twice.
- **Claude:** a key with expenses ticked sees these notices in `whats_new` and can mark them read, never those about salaries or EMIs; a key without the tick sees none. They stay out of "Your reminders" and snooze. The inbox shows one only while its expense exists and is open to the reader.

## Claude

- **Opt in per key:** on the Connect Claude page, **Include expenses** on a Venture Studio key: reports, lists and subscriptions with Read only; also adding, changing, repricing and deleting with Read and update. Without the tick Claude can't reach expenses at all (the expense routes check the key's scopes too).
- **Same rules as the app:** the access list applies to the key's owner. **Salaries and EMIs never go through Claude**, even for people who see them in the app: reports and lists leave them out (and say so), and they can't be added, read or marked read.
- **The tools:** `expense_options`, `expense_report`, `list_expenses`, `list_subscriptions`, `add_expenses`, `update_expense`, `change_expense_price`, `delete_expense` (docs/mcp.md#expenses). Tags work there too: added with the spelling in use, a `tag` filter on reports and lists, and each tag's total in a report ("how much went on Rahul this month?"). Totals use the same conversion as the page. Deleting needs the person's yes in the conversation and the version they were shown (a change since is refused); every change is audited as made through Claude.
- **Receipts:** Claude reads a receipt pasted into the chat itself and adds the expense; the original file is attached from the expense's link in the app.
- **App only:** the access list, categories, company merges, renames and logos.

## Receipts

- **Adding one:** the receipt column of the add or edit popup offers **Take a photo** (a phone or tablet opens its own camera app, rear camera, for full resolution, focus and flash; a computer opens its webcam in the popup, with a frame to fit the receipt in, a shutter that waits for a real picture, and a switch when there are several cameras; blocked or missing cameras say so and leave Upload) and **Upload** (or drop a file). Either takes a photo (JPG, PNG, WebP, GIF or HEIC; never SVG) or a PDF, up to 10 MB (`MAX_RECEIPT_BYTES`; the web app's proxy copies at most 10 MB of a request, so keep the two equal). The browser first shrinks a big phone photo, gently (at most 3200 px either way, quality 0.92, unlike chat photos), so it uploads quickly; the server then keeps:
  - a photo as a WebP of at most about 4 megapixels (and 4096 px on its long side) at quality 85 with sharp colour edges, turned upright, with its location and camera data dropped. The budget is by area, so a tall, narrow receipt keeps its width and small print stays sharp; a smaller photo is never enlarged. A 12-megapixel phone photo (about 3 MB) comes out around 250–550 KB;
  - a PDF as it came.
- **Reading it:** Claude Haiku 5.5 (`claude-haiku-5-5`, `apps/api/src/expense-receipts.ts`) is asked two things at once, each with brief thinking (low effort: it reads blurry words reliably instead of guessing a better-known word) and without a retry: the details (what fills in the form, in at most 30 seconds, under the web app's one-minute proxy limit) and the full copy (below). The details come back with the upload, in about as long as before the full copy existed (6 to 11 seconds on a photo of a shop bill); the copy is saved on the receipt when it comes, usually by then. Both stop if the person closes the page first, and the copy stops when the details can't be read. A PDF of more than 5 pages (`MAX_RECEIPT_PAGES`, counted by the sandboxed PDF reader) is kept but not read. Each answer must match its schema (structured outputs). The details it reads, only as printed (never a subtotal or a payment method that isn't there: "Shri: CASH" is who was billed, not how):
  - the kind of document and its own title (Retail Invoice, Tax Invoice), and the merchant (name, address, phone, GSTIN or other tax ID);
  - the receipt, bill or invoice number, the date and time, the store or branch and the cashier, and who it was billed to;
  - every line item (quantity, unit price, amount), the total quantity, the subtotal, discount, each tax line (CGST, SGST, IGST… with its rate) and whether the taxes are part of the prices or added on top, tip, and total;
  - the currency, how it was paid (card with only its last four digits), the footer;
  - the category it most likely belongs to, among those the person may use.
- **The full copy:** the whole receipt as printed, top to bottom, nothing left out: headings, lines of text (each term and note too), "label: value" pairs, tables with their own columns (Description, Qty, Rate, Amount, and the total lines under them), printed rules, and a QR code or barcode named with what is printed by it ("Scan & Pay"). Lines are kept small (kind, text, cells, centred; a table up to 14 columns) so a long receipt stays quick; the reader writes at most 200 lines (`MAX_RECEIPT_BLOCKS`), with room for them (16,000 tokens, two minutes), and a longer receipt ends with a line saying the rest is on the original. It is stored on the receipt apart from the details (`layout`, with `copyState` and `copyStartedAt` while it is being written, so an older reading never replaces a newer one); one not saved two and a half minutes after it was asked for counts as failed.
- **Numbers in the full copy:** it is the receipt's own text, read by whoever sees the expense and by Claude, so it is cut more carefully than the fields: a card number (one that passes the card checksum, so an e-invoice acknowledgement or order number stays whole) keeps its last four digits; the number in a UPI ID (`9876543210@ybl`) does too, anywhere; and on a line or in a table about a bank account, UPI, Aadhaar or PAN, every run of 9 or more digits and an Aadhaar's 4-4-4 groups are cut. The original photo keeps everything, and stays in the app.
- **Tidying:** the server caps lengths, keeps a date only when it is a real one, and matches the category by name. Card numbers (four groups of four however they're spaced, Amex's 4-6-5, or 13 to 19 digits in a row) keep only their last four digits in every field but the receipt number and tax ID, and so does any run of 9 or more digits (a bank account) in "billed to" and the footer. Date ranges such as 01/10/2026 - 31/10/2026 are left alone.
- **Filling in the form:** only what's still empty when the reading finishes (the form stays editable meanwhile): who it was paid to, the amount in the receipt's own currency (Haiku takes the currency from the symbol, or from where the merchant is when none is printed; the day's rate in rupees shows under it), the date (for a new expense) and the category (until one is picked). A line says what was filled in. A receipt in a currency the tracker can't convert (such as AED) says so and asks for the rupee amount; one in another currency suggests adding what the bank charged.
- **The digital receipt:** the panel draws the full copy as a paper receipt: the lines in their order, centred where printed, pairs with the label on the left, tables with their header and the amount columns on the right (a wide table scrolls inside the paper on a phone), and a QR code shown as a marked box. While the copy is being written (a few seconds after the details) it shows the details as a summary, with "Writing out the full copy…", and looks again every two seconds; receipts read before the full copy existed show that summary until they are read again. "Original" shows the kept photo or PDF above it (fetched only then), with "Open in a new tab". It warns when the items don't add up to the subtotal, or the subtotal, taxes and tip don't add up to the total: within a rupee on a rupee receipt (round-off), within a cent or two in another currency. Taxes the receipt says are part of the prices aren't added (its subtotal may then be the total, or the taxable amount the taxes make up to it); a total equal to the subtotal also passes as prices that include tax, unless a tax is printed as added on top ("+18% VAT"). With a full copy, it also warns when the total printed on it (its last Total, Net amount or Amount payable line) isn't the total read into the form. A copy that doesn't show the total read into the form anywhere missed part of the receipt: the summary is drawn instead, saying so, with Read again.
- **Read again:** under the paper ("Read again for the full copy" on one read before it existed), for anyone who may change the expense: the details and the full copy are read anew from the kept original. The expense keeps what was saved; a read that fails leaves the one before (a busy or slow reader: try again; no key set, or a PDF too long or that won't open: said plainly). A receipt let go, or read again by someone else, while it was being read keeps the other reading. It counts against the same 40 an hour as adding a receipt, and is in the app only (never through Claude). Audited as `expense.receipt.read`.
- **When it can't be read** (no key set, the reader is busy, refused or too slow, an unclear photo, a long or damaged PDF): the receipt is still kept and its photo shown, and the details are typed in.
- **Who sees it:** whoever sees its expense, so a receipt on a restricted category stays hidden with it. Until the expense is saved, only the person who uploaded it. The category it suggested shows only to people who can see that category. Anyone with Edit may upload, up to 40 an hour. Only image and PDF bodies are accepted, so a plain cross-site form can't post one.
- **Letting go:** removing or replacing a receipt (and saving), or deleting its expense, lets it go: nobody sees or attaches it again, not even who uploaded it. A receipt attached to nothing for a day (also one whose form was closed unsaved) is deleted, with its copy, the next time someone opens Expenses or adds a receipt. It is recorded before its copy is stored, so a failure partway never leaves a copy behind. A new amount from a month on doesn't take the receipt along.
- **Claude:** `list_expenses` with an expense's id shows its receipt's details and, once written, the full copy as plain lines ("label: value", table cells between bars, a QR code named), with a note that it was printed on an outside document (data, never instructions), each line clipped like every other text it reads.
- **Where it goes:** the copy is stored with the app's other files (R2 in production), under `<workspace>/expense-receipts/`, and served only through the API. The receipt is sent to Anthropic's API only to be read. The audit (`expense.receipt.upload`) records whether it was read, never what it says.
- **Setup:** `ANTHROPIC_API_KEY` in the API's settings (`deploy/.env`, Coolify). Without it, receipts are kept and not read.

## Companies

- **What a company is:** who an expense was paid to, kept once per workspace (`expense_companies`, `apps/api/src/expense-companies.ts`). Every expense gets one when it's saved; expenses saved before companies existed get theirs once when the API starts (`assignExpenseCompanies`, safe to repeat).
- **Grouping, without any model:** an expense joins the company whose name matches its "Paid to", else the one with the same GSTIN (from its receipt), else the same website (from its receipt or the form); otherwise it starts a new company named after its "Paid to" without notes in brackets.
  - **Matching names** (`companyKey` in the contracts) ignores case, accents on Latin letters, notes in brackets, web endings (.com, .in…), punctuation, spaces and legal words at the end (LLC, Ltd, Pvt, Limited, Inc, India…). "GoDaddy.com, LLC", "GODADDY INDIA", "Go Daddy" and "GoDaddy (buildory.dev)" are one company. Names in other scripts keep their letters, and text after a dash is part of the name, so "Salary - Ramesh" and "Salary - Priya" stay apart.
  - **The name wins:** a misread website or GSTIN never pulls a known name into another company, and a GSTIN or website already belonging to one company is never copied onto another.
  - **Shared domains don't count:** mail and payment services (gmail.com, outlook.com, razorpay.com, paytm.com…) never group or name a company.
  - It's deliberately cautious: different spellings it misses ("AWS" and "Amazon Web Services") are merged once in Settings → Companies, and are matched from then on.
- **Filter:** a Company filter beside Category and Group (once there are two companies), and the CSV has a Company column.
- **Logos:** every list row and Recent expenses shows the company's logo, or its initial on its category's colour.
  - **A new company** (first seen as the expense is added) shows an optional row under "Paid to": its website (filled in from the receipt when printed) or an uploaded logo. Without either it shows its initial.
  - **From a website:** the API reads the company's own home page once and keeps the best icon it names (Apple touch icon, a PNG/WebP/JPEG icon, else /apple-touch-icon.png or a PNG inside /favicon.ico; never SVG). When the site refuses automated requests (GoDaddy and OpenAI do) or names nothing usable, the logo comes from Google's favicon service, which then learns that domain (from the server, nothing about who looks or what was paid). Both use the lead finder's safety checks: https on public hosts only, every redirect checked, the connection pinned to the checked address, 8 seconds per request, 30 seconds per site, small size limits, two sites at a time, and 30 an hour per person. `COMPANY_LOGO_FETCH=off` keeps only uploaded logos.
  - **What you see:** while a logo is looked for, Settings → Companies says "Finding the logo…", and the page reads it again by itself a few seconds later (also after adding a new company's website in the expense popup). When neither the site nor Google has one, it says "No logo found: upload one"; "Find logo" looks again.
  - **Uploaded:** PNG, JPEG, WebP or GIF up to 2 MB, kept as a 128 px WebP. An uploaded logo is never replaced by one from the website. Anyone who adds expenses may give a company its first logo; changing or removing one is for managers.
- **Settings → Companies** (managers): every company with its expense count, website and GSTIN. Rename (the new name is matched from then on), set the website (its logo is found), "Find logo" again, upload or remove the logo, and merge one company into another (its expenses, spellings, and the website, GSTIN or logo the other lacks move across).
- **Who sees a company:** only people who can see at least one of its expenses. A company paid only in restricted categories (a salary to a person) stays hidden, its other spellings are only those of expenses the person can see, and a rename that clashes with a hidden company never names it. A company's website and logo are shared by all its expenses.

## Categories and groups

- **Categories:** Subscription, Domain, AI tools, Hosting, Personal EMI and Salary to start with.
  - Managers can add, rename, recolour, archive and restore them.
  - Personal EMI and Salary are **restricted**.
  - An archived category or group stays on old expenses but isn't offered for new ones.
- **Groups:** your own bundles, for example "AI subscriptions" or "Domains". Each shows its cost a month and a year on the Subscriptions tab.
- **Storage:** both live in `expense_settings`, one document per workspace, created from the defaults on the first change.

## Tags

- **What for:** words of your own on an expense, to filter and total by: most often who it was for (an Office purchase for a person, like "Rahul"), or an event or a project. An expense with "Rahul" and "Clothes" counts under both.
- **Rules:** up to 10 an expense, of up to 30 characters, no commas and no long numbers. Spaces are tidied and a leading # dropped; tags are told apart without case ("rahul" is "Rahul"), and each is kept once.
- **Adding them:** the Tags field in the expense popup. Press Enter (or type a comma) after each; Backspace in the empty box takes the last one back to edit. Tags used before are offered as you type (with nothing typed, the most used), and a typed one that matches takes its spelling.
- **Filtering:** a Tag filter on the Expenses and Office tabs (with how many expenses carry each), shown once any expense has a tag.
- **Totals:** a "<month> by tag" card under the dashboard cards: each tag's total for the month, biggest first, and what wasn't tagged. Click a tag to filter to it. It follows the other filters, so on the Office tab it is what each person or thing cost the Office.
- **Who sees them:** tags come only from expenses the reader can see, so a tag used only on salaries stays unknown to someone who can't see salaries. The audit counts tags but never records them.
- **Elsewhere:** the CSV has a Tags column; a new amount from a month on keeps the tags; editing an expense keeps them unless they're changed. Through Claude, see [Claude](#claude).

## Who can see and change what

The tracker has its own access list, under Settings. Each member has a **level**:

| Level | Can |
|---|---|
| No access | Nothing. The page isn't in their sidebar, and every route answers "not found". |
| View | See expenses and totals, and export a CSV. |
| Edit | View, plus add, edit and delete expenses, and start a group while adding one. |
| Manage | Edit, plus categories, groups and the access list. |

- **Restricted switch:** each member also has a switch for whether they see **restricted** categories (salary, EMI).
  - Without it, those expenses are left out of the list, the totals, the categories and every change, and the screens say restricted items are left out.
  - Only people with restricted access can grant it, take it away, make a category restricted, or add to a restricted category.
- **Defaults:**
  - The admins there are when the tracker is first opened get Manage with restricted access, recorded in the list.
  - Admins made later get Manage without restricted access, until someone with restricted access grants it.
  - Everyone else gets No access.
- **The tracker can't be locked:**
  - The access list must always leave at least one active member with Manage and restricted access.
  - If that person leaves the workspace, any admin regains Manage with restricted access.
  - Entries for people no longer in the workspace are removed the next time the list is saved.
- **Enforced on the server:** the API applies every rule (`routes/expenses.ts`). The screens only hide what the API would refuse anyway.
- **Claude:** only with a key that has expenses ticked (the scopes are checked again here), never salaries or EMIs, and never the managing routes (categories, companies, access), receipt uploads or receipt files. See [Claude](#claude).
- **Audit:** every change is audited (`expense.*`) with the category, the repeat and the fields changed, never an amount. Refusals are audited too.

## Screens

- **Month:** one month picker in the page header, before Refresh, sets the month for Expenses, Office and Monthly.
- **Expenses:** one filter row (category, tag, group, company, where it's charged, one-time or repeating) scopes everything below it.
  - **Dashboard cards:**
    - **Spent this month** (dark card): the total, with the change against last month; a bar of repeating against one-time; a ring of Office, Personal and ventures (by category on the Office tab).
    - **Repeating costs** (blue card): cost a month, how many are running and due this week, and the cost a year.
    - **By category:** a dial for the month. Click a legend chip to filter to that category.
    - **Recent expenses** (dark card): the month's split by category as a segmented bar, then the latest expenses by day. In the current month it shows only what has been paid so far.
    - **By tag** (once tags are used): each tag's total for the month as bars, and what wasn't tagged; click one to filter to it.
    - **Month by month:** Office, ventures and Personal for the month as tiles, and seven months as columns on a rupee axis (34px bars at most, 11px labels, like the dashboard's other bar charts). Point at a column, or focus it, for a tooltip with the month's total, where it went (or its categories on the Office tab) and how many expenses; click it, or press Enter, to open that month. The open month is the blue column, with its total above it.
  - **No hover effects on the cards:** picking a category is a click; only the month columns show a tooltip.
  - **Animations:** everything animates in once when the page opens (columns rise, rings sweep, totals count up), and stays still for people who ask for reduced motion.
  - **Corner buttons** open Monthly and Subscriptions, or scroll down to the list.
  - **The list:** the month's expenses with their total. Exports as CSV.
- **Adding or editing an expense** opens a popup: the receipt on the left on wide screens, the details on the right, Save pinned at the bottom. On phones it fills the screen, and Back closes it like leaving a screen (asking first when something was changed). "+ New group…" (Edit) and "+ New category…" (Manage) at the end of the lists add one without leaving it.
- **Office:** the same list, limited to Office, with the Office's own monthly total.
- **Monthly:** the last 3, 6 or 12 months for Office, Personal, each venture and overall, plus the chosen month by category. Exports as CSV.
- **Subscriptions:**
  - everything that repeats, by group, with its cost a month and a year (a yearly payment counts as a twelfth a month);
  - the next payment dates, with what's due in the next 30 days;
  - stopped ones at the end.
- **Subscriptions** counts only what has already started. One starting later (such as a new price from next month) is listed under "Starting later", outside the totals.
- **Settings:** the access list, categories and groups (managers only). A manager who can't see restricted categories is never told a hidden category's name.
- **Inside a venture:** when a venture is selected in the sidebar, the page shows that venture only and new expenses are charged to it, shown read-only. "Show everything" clears the selection.

## API

| Method | Path | Needs |
|---|---|---|
| GET | `/v1/expenses/access` | Signed in (returns only your own level) |
| GET | `/v1/expenses/settings` | View (the access list only for Manage) |
| GET | `/v1/expenses` | View |
| POST | `/v1/expenses` | Edit |
| PATCH / DELETE | `/v1/expenses/:id` | Edit |
| POST | `/v1/expenses/:id/change` | Edit |
| GET | `/v1/expenses/rates?from&to&currencies` | View (rupees for one unit, each working day; at most about three years) |
| POST | `/v1/expenses/receipts` (the photo or PDF as the body) | Edit |
| GET | `/v1/expenses/receipts/:id[/file]` | View, and seeing its expense (before it's attached: the uploader) |
| GET | `/v1/expenses/companies/:id/logo` | View, and seeing one of its expenses |
| POST | `/v1/expenses/companies/:id/logo` (the image as the body) | Edit for a company without a logo, else Manage |
| DELETE | `/v1/expenses/companies/:id/logo` | Manage |
| PATCH | `/v1/expenses/companies/:id` (name, website) | Manage |
| POST | `/v1/expenses/companies/:id/merge` (`into`) | Manage |
| POST / PATCH | `/v1/expenses/settings/categories[/:id]` | Manage |
| POST | `/v1/expenses/settings/groups` | Edit (start a group while adding an expense) |
| PATCH | `/v1/expenses/settings/groups/:id` | Manage |
| PUT | `/v1/expenses/settings/access/:userId` | Manage |
