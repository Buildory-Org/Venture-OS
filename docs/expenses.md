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
  - an optional note.
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
    - **Month by month:** Office, ventures and Personal for the month as tiles, and seven months as pill columns. Click a column, or press Enter on it, to open that month.
  - **No hover effects:** picking a month or a category is a click.
  - **Animations:** everything animates in once when the page opens (columns rise, rings sweep, totals count up), and stays still for people who ask for reduced motion.
  - **Corner buttons** open Monthly and Subscriptions, or scroll down to the list.
  - **The list:** the month's expenses with their total. Exports as CSV.
- **Adding an expense:** "+ New group…" (Edit) and "+ New category…" (Manage) at the end of the lists add one without leaving the panel.
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
| POST / PATCH | `/v1/expenses/settings/categories[/:id]` | Manage |
| POST | `/v1/expenses/settings/groups` | Edit (start a group while adding an expense) |
| PATCH | `/v1/expenses/settings/groups/:id` | Manage |
| PUT | `/v1/expenses/settings/access/:userId` | Manage |
