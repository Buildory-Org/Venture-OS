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
- **No numbers that could identify an account.** The "paid to" and note fields refuse any run of 9 or more digits (spaces, dots and dashes between them are allowed). That keeps out account, card and phone numbers: only amounts and labels are stored.
- **Repeats:**
  - One-time, monthly or yearly. A repeat lands on the same day of the month, or on the month's last day when the month is shorter.
  - A repeating expense continues until its **last month**, which is optional and included.
  - Totals are worked out from these rules (`occurrenceIn`), so no scheduled job has to create monthly copies.
- **"Price changed?"** (`POST /v1/expenses/:id/change`):
  - The expense stops the month before the change, and a copy with the new amount starts that month (`continuesId` points back to the original).
  - Earlier months keep what was actually paid.
  - Editing the amount directly changes every month.
- **Delete** removes an expense for good. The audit log records that it happened.

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
| Edit | View, plus add, edit and delete expenses. |
| Manage | Edit, plus categories, groups and the access list. |

- **Restricted switch:** each member also has a switch for whether they see **restricted** categories (salary, EMI).
  - Without it, those expenses are left out of the list, the totals, the categories and every change, and the screens say restricted items are left out.
  - Only people with restricted access can grant it, take it away, make a category restricted, or add to a restricted category.
- **Defaults:** admins get Manage with restricted access; everyone else gets No access.
- **The tracker can't be locked:** at least one member always keeps Manage with restricted access.
- **Enforced on the server:** the API applies every rule (`routes/expenses.ts`). The screens only hide what the API would refuse anyway.
- **No Claude access:** Claude connections can't reach these routes.
- **Audit:** every change is audited (`expense.*`) with the category, the repeat and the fields changed, never an amount. Refusals are audited too.

## Screens

- **Expenses:** one month at a time, filtered by category, group, where it's charged, and one-time or repeating. Shows the total for what's listed and exports it as CSV.
- **Office:** the same list, limited to Office, with the Office's own monthly total.
- **Monthly:** the last 3, 6 or 12 months for Office, Personal, each venture and overall, plus the chosen month by category. Exports as CSV.
- **Subscriptions:**
  - everything that repeats, by group, with its cost a month and a year (a yearly payment counts as a twelfth a month);
  - the next payment dates, with what's due in the next 30 days;
  - stopped ones at the end.
- **Settings:** the access list, categories and groups (managers only).
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
| POST / PATCH | `/v1/expenses/settings/groups[/:id]` | Manage |
| PUT | `/v1/expenses/settings/access/:userId` | Manage |
