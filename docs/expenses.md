# Expense tracker

What the studio spends, in rupees: for each venture, the Office and Personal. It lives in Studio at **Expenses** (`/expenses/live`), and the API is under `/v1/expenses`. The data rules and the repeat logic are shared in `packages/contracts/src/expenses.ts`.

## What an expense is

- **Fields:**
  - the date paid;
  - the amount in paise (at most ₹1,000 crore);
  - a category;
  - an optional group;
  - who it was paid to;
  - where it's charged (a venture, Office or Personal);
  - an optional note;
  - an optional receipt (see [Receipts](#receipts)).
- **No numbers that could identify an account.** Labels (who it was paid to, notes, category and group names) refuse what reads like an account, card or phone number (`LONG_NUMBER`):
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

## Receipts

- **Adding one:** the receipt column of the add or edit popup offers **Take a photo** (a phone or tablet opens its own camera app, rear camera, for full resolution, focus and flash; a computer opens its webcam in the popup, with a frame to fit the receipt in, a shutter that waits for a real picture, and a switch when there are several cameras; blocked or missing cameras say so and leave Upload) and **Upload** (or drop a file). Either takes a photo (JPG, PNG, WebP, GIF or HEIC; never SVG) or a PDF, up to 10 MB (`MAX_RECEIPT_BYTES`; the web app's proxy copies at most 10 MB of a request, so keep the two equal). The browser first shrinks a big phone photo, gently (at most 3200 px either way, quality 0.92, unlike chat photos), so it uploads quickly; the server then keeps:
  - a photo as a WebP of at most about 4 megapixels (and 4096 px on its long side) at quality 85 with sharp colour edges, turned upright, with its location and camera data dropped. The budget is by area, so a tall, narrow receipt keeps its width and small print stays sharp; a smaller photo is never enlarged. A 12-megapixel phone photo (about 3 MB) comes out around 250–550 KB;
  - a PDF as it came.
- **Reading it:** Claude Haiku 5.5 (`claude-haiku-5-5`, `apps/api/src/expense-receipts.ts`) reads it in one call, with brief thinking (low effort: it reads blurry words reliably instead of guessing a better-known word), in at most 22 seconds and without a retry (the web app's proxy gives up on a request after 30). It stops if the person closes the page. A PDF of more than 5 pages (`MAX_RECEIPT_PAGES`, counted by the sandboxed PDF reader) is kept but not read. Its answer must match the receipt schema (`receiptDataSchema`, structured outputs). The fields it reads:
  - the kind of document and the merchant (name, address, phone, GSTIN or other tax ID);
  - the receipt, bill or invoice number, the date and time, and who it was billed to;
  - every line item (quantity, unit price, amount), the subtotal, discount, each tax line (CGST, SGST, IGST… with its rate), tip, and total;
  - the currency, how it was paid (card with only its last four digits), the footer;
  - the category it most likely belongs to, among those the person may use.
- **Tidying:** the server caps lengths, keeps a date only when it is a real one, and matches the category by name. Card numbers (four groups of four however they're spaced, Amex's 4-6-5, or 13 to 19 digits in a row) keep only their last four digits in every field but the receipt number and tax ID, and so does any run of 9 or more digits (a bank account) in "billed to" and the footer. Date ranges such as 01/10/2026 - 31/10/2026 are left alone.
- **Filling in the form:** only what's still empty when the reading finishes (the form stays editable meanwhile): who it was paid to, the amount (only when the receipt is in rupees: Haiku takes the currency from the symbol, or from where the merchant is when none is printed), the date (for a new expense) and the category (until one is picked). A line says what was filled in. A receipt in another currency says so, and asks for the rupee amount.
- **The digital receipt:** the panel shows what was read as a paper receipt. "Original" shows the kept photo or PDF above it (fetched only then), with "Open in a new tab". It warns when the items don't add up to the subtotal, or the subtotal, taxes and tip don't add up to the total.
- **When it can't be read** (no key set, the reader is busy, refused or too slow, an unclear photo, a long or damaged PDF): the receipt is still kept and its photo shown, and the details are typed in.
- **Who sees it:** whoever sees its expense, so a receipt on a restricted category stays hidden with it. Until the expense is saved, only the person who uploaded it. The category it suggested shows only to people who can see that category. Anyone with Edit may upload, up to 40 an hour. Only image and PDF bodies are accepted, so a plain cross-site form can't post one.
- **Letting go:** removing or replacing a receipt (and saving), or deleting its expense, lets it go: nobody sees or attaches it again, not even who uploaded it. A receipt attached to nothing for a day (also one whose form was closed unsaved) is deleted, with its copy, the next time someone opens Expenses or adds a receipt. It is recorded before its copy is stored, so a failure partway never leaves a copy behind. A new amount from a month on doesn't take the receipt along.
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
  - **From a website:** the API reads the company's own home page once and keeps the best icon it names (Apple touch icon, a PNG/WebP/JPEG icon, else /apple-touch-icon.png or a PNG inside /favicon.ico; never SVG). It uses the lead finder's safety checks: https on public hosts only, every redirect checked, the connection pinned to the checked address, 8 seconds per request, 30 seconds per site, small size limits, two sites at a time, and 30 an hour per person. Nothing goes to a third-party icon service. `COMPANY_LOGO_FETCH=off` keeps only uploaded logos.
  - **Uploaded:** PNG, JPEG, WebP or GIF up to 2 MB, kept as a 128 px WebP. An uploaded logo is never replaced by one from the website. Anyone who adds expenses may give a company its first logo; changing or removing one is for managers.
- **Settings → Companies** (managers): every company with its expense count, website and GSTIN. Rename (the new name is matched from then on), set the website (its logo is fetched), upload or remove the logo, and merge one company into another (its expenses, spellings, and the website, GSTIN or logo the other lacks move across).
- **Who sees a company:** only people who can see at least one of its expenses. A company paid only in restricted categories (a salary to a person) stays hidden, its other spellings are only those of expenses the person can see, and a rename that clashes with a hidden company never names it. A company's website and logo are shared by all its expenses.

## Categories and groups

- **Categories:** Subscription, Domain, AI tools, Hosting, Personal EMI and Salary to start with.
  - Managers can add, rename, recolour, archive and restore them.
  - Personal EMI and Salary are **restricted**.
  - An archived category or group stays on old expenses but isn't offered for new ones.
- **Groups:** your own bundles, for example "AI subscriptions" or "Domains". Each shows its cost a month and a year on the Subscriptions tab.
- **Storage:** both live in `expense_settings`, one document per workspace, created from the defaults on the first change.

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
- **No Claude access:** Claude connections can't reach these routes.
- **Audit:** every change is audited (`expense.*`) with the category, the repeat and the fields changed, never an amount. Refusals are audited too.

## Screens

- **Month:** one month picker in the page header, before Refresh, sets the month for Expenses, Office and Monthly.
- **Expenses:** one filter row (category, group, where it's charged, one-time or repeating) scopes everything below it.
  - **Dashboard cards:**
    - **Spent this month** (dark card): the total, with the change against last month; a bar of repeating against one-time; a ring of Office, Personal and ventures (by category on the Office tab).
    - **Repeating costs** (blue card): cost a month, how many are running and due this week, and the cost a year.
    - **By category:** a dial for the month. Click a legend chip to filter to that category.
    - **Recent expenses** (dark card): the month's split by category as a segmented bar, then the latest expenses by day. In the current month it shows only what has been paid so far.
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
