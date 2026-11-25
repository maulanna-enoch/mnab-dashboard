# MNAB Dashboard

A mobile-friendly home menu with three pages:

### Cash Flow (`/cashflow`)

Reads the `Diary` tab. A month dropdown (populated from whatever months
actually exist in `Diary`) drives three cards:

- **Left to spend** (hero number) — `Income − Outflow`. Red if negative.
- **Income** — sum of `Income/Expense = Income` rows for the selected month.
- **Outflow** — sum of `Income/Expense = Expense` rows, split three ways by
  `Status`: **Paid** (settled), **Billed** (statement closed, amount is
  final), and **Unbilled** (still accruing, amount is an estimate — anything
  that isn't exactly `Paid` or `Billed` falls into this bucket).

Each card expands to show the underlying line items.

### Bills (`/installments`)

Debt Exit plan WS3. One request, `GET /api/installments-summary?action=page`
(rules in `api/_lib/bills-page.js`), feeds the whole page:

- **Left to pay before payroll** (hero) and **This pay cycle**: every bill,
  installment and card statement due from the last 25th to the next one,
  marked Paid, Due soon (3 days), Late or Upcoming. A bill is paid when a
  transaction carries its Bill ID (`Source ID`), isn't Pending, and is dated
  between the previous and the next due date. A paid amount that differs
  from the registry is flagged, and so is an auto-inserted row still waiting
  to be confirmed.
- **Card statements**: the open one and the two before it, per card, worked
  out from transactions (see Card statements below).
- **Running now**: Cash bills, Card bills and Installments (n/total, end
  month, what's left), from `installmentsbills`' Kind column.
- **Ending soon**: when rows end and how much each frees up.
- **Committed as % of salary**: this month and the next 12, using
  `monthly_salary_rp` from Settings (amounts only if it's blank).

The older `?action=committed`, `/api/bills-summary` and
`/api/installments-by-end-month` still work but the page no longer uses the
last two.

### Card statements (worked out, no Diary)

A credit card's statement for month M is worked out from `transactions`
(`api/_lib/statements.js`): the card's rows with `Month = M`, except
Transfer Income legs, are the charges; the card's Transfer Income legs with
`Month = M` (what Add Payment writes) are the payments. It closes on the
12th of M (`open` until then), then reads `billed` until payments cover it
(within Rp0.5) and `paid` after. Add an optional **Statement Due Day**
column to `Accounts` (a day of month) for a due date and a late flag.
`GET /api/reconcile?action=statements[&month=YYYY-MM][&months=N][&card=]`
lists them; `?action=billed-amount` (Add Payment pre-fill, Convert to card
payment check) now reads the same numbers instead of the Diary.

### Transactions (`/transactions`)

Reads and **writes** the `transactions` tab (Payee, Income/Expense, SOF,
Date, Month, Cleared, Amount, Expense, Income, Total, Notes). A chronological
feed grouped by date, a "+" button to add an entry, and tapping any entry
opens the same form pre-filled for editing or deleting.

The `Amount` column is the only one you type — `Expense`, `Income`, and
`Total` are computed by the app on every write, mirroring the sheet's own
formula logic (`Expense = Amount` if the row is an Expense else 0, same for
`Income`, `Total = Expense − Income`), since API-written rows aren't
guaranteed to inherit a Table's auto-fill formulas. If you ever change that
formula in the sheet, update `buildTransactionRow` in `api/_lib/sheets.js`
to match.

This is the one part of the app that writes to your sheet, and it uses a
**separate, write-only service account** from everything else — see setup
step 5 below.

## 1. Create a Google Cloud service account

1. Go to https://console.cloud.google.com/ and create a new project (or reuse one).
2. Enable the **Google Sheets API**: APIs & Services → Library → search "Google Sheets API" → Enable.
3. Create credentials: APIs & Services → Credentials → Create Credentials → Service account.
   - Name it anything (e.g. `mnab-reader`). No roles needed.
4. Open the new service account → Keys tab → Add Key → Create new key → JSON. This downloads a `.json` file.
5. Open that JSON file. You need two values from it: `client_email` and `private_key`.

## 2. Share the sheet with the service account

1. Open your Google Sheet: https://docs.google.com/spreadsheets/d/114Ly5pJgF0hOYLb8oCazEiuuB9ndbY6Z61PagSAicas
2. Click **Share**, paste the service account's `client_email`, give it **Viewer** access, uncheck "notify".

## 3. Push this project to GitHub

Already done — this repo lives at https://github.com/maulanna-enoch/mnab-dashboard
(pushed via GitHub Desktop).

## 4. Deploy on Vercel

1. Go to https://vercel.com and sign up/log in with your GitHub account.
2. "Add New Project" → import `maulanna-enoch/mnab-dashboard`.
3. Before deploying, add environment variables (Settings → Environment Variables), one per line from your service account JSON and sheet:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` = the `client_email` value
   - `GOOGLE_PRIVATE_KEY` = the `private_key` value, quotes and all (keep the `\n` characters as-is)
   - `SHEET_ID` = `114Ly5pJgF0hOYLb8oCazEiuuB9ndbY6Z61PagSAicas`
4. Deploy. Vercel gives you a URL like `mnab.vercel.app`.
5. Open it on your phone, then "Add to Home Screen" for an app-like shortcut.

## 5. Set up a second service account for write access

Everything above is read-only (`spreadsheets.readonly` scope, shared as
Viewer). The Transactions feature needs to *write* rows, so it uses a
**separate** service account with Editor access, kept apart from the
read-only one on purpose — a bug in a read endpoint can never accidentally
write, because that credential is physically incapable of it.

This doesn't cost anything extra — the Sheets API has no paid tier, and its
quota is pooled per Google Cloud project, not per service account, so a
second account in the same project doesn't shrink your headroom.

1. In the same Google Cloud project as before: APIs & Services → Credentials
   → Create Credentials → Service account.
   - Name it something distinguishable, e.g. `mnab-writer`.
2. Open it → Keys tab → Add Key → Create new key → JSON. Download it.
3. Open that JSON file, note `client_email` and `private_key`.
4. Open your Google Sheet → Share → paste the **new** service account's
   `client_email` → set its access to **Editor** (not Viewer) → uncheck
   "notify".
5. In Vercel (Settings → Environment Variables), add two more variables
   alongside your existing ones:
   - `GOOGLE_WRITE_SERVICE_ACCOUNT_EMAIL` = the new account's `client_email`
   - `GOOGLE_WRITE_PRIVATE_KEY` = the new account's `private_key` (same
     rules as before: no surrounding quotes, keep the `\n` as literal text)
6. Leave `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` and the
   original service account's Viewer access exactly as they are — every
   existing page keeps using the read-only credential. Only the new
   transaction-write endpoint(s) will use the write credential and the
   `https://www.googleapis.com/auth/spreadsheets` (non-readonly) scope.

## Project structure

```
mnab-dashboard/
  api/_lib/sheets.js                  Shared: read/write clients, row parsing + classification, buildTransactionRow
  api/_lib/settings.js                Settings tab keys, defaults and value parsing (see "Settings tab" below)
  api/_lib/kinds.js                   Fixed / Variable / Transfer / Income rules (see "Fixed / variable" below)
  api/_lib/week.js                    Weekly budget engine (see "Weekly budget" below)
  api/cashflow-summary.js             Income/Paid/Budgeted/Left-to-spend for a given ?month=YYYY-MM;
                                      ?action=months lists the Diary months for the dropdown
                                      ?action=settings returns the Settings tab (typed, with defaults)
                                      ?action=week returns the weekly budget (allowance, left, history)
  api/push.js                         Web Push: device subscriptions + the notify call EmailImport.gs makes
  api/installments-summary.js         Sum of active Installment amounts (excludes Bills);
                                      ?action=registry lists bills with their IB-n IDs
  api/installments-by-end-month.js    Active Installments grouped by ending month, with running remaining total
  api/bills-summary.js                Sum + list of active Bills
  api/accounts-list.js                Account names from the Accounts tab, for the transaction form's dropdown
  api/transactions-list.js            All transactions, most recent first (no caching -- always fresh)
  api/transactions-add.js             POST: appends a new row to transactions (write credential)
  api/transactions-update.js          POST: overwrites a row by rowNumber (write credential)
  api/transactions-delete.js          POST: removes a row by rowNumber (write credential)
  public/index.html                   Home menu page
  public/cashflow/index.html          Cash Flow page (linked from home)
  public/installments/index.html      Installments & Bills page (linked from home)
  public/transactions/index.html      Transactions page: feed + add/edit/delete form (linked from home)
  vercel.json                         Enables clean URLs (e.g. /installments instead of /installments.html)
  package.json                        Dependency: googleapis
  .env.example                        Reference for the env vars above (don't commit real secrets)
```

Files under `api/_lib/` are not deployed as endpoints — Vercel ignores any
path with an underscore-prefixed segment, which is exactly what we want for
shared helper code.

## Settings tab

One key/value tab, `Settings`, holds the numbers the weekly budget depends on,
so no page or endpoint hard-codes them. Create it once by hand in the MNAB
sheet: row 1 headers `Key | Value | Notes`, then one row per setting below.
Rows are read **by key**, so order doesn't matter and extra rows are ignored.

| Key | Value | Default if blank or missing |
|---|---|---|
| `weekly_allowance_rp` | Weekly variable-spending allowance, e.g. `1.500.000` | not set |
| `week_start_day` | `Wednesday` (or `Wed`) | Wednesday |
| `rollover_enabled` | `TRUE` / `FALSE` | TRUE |
| `rollover_cap_rp` | Max carried into next week, in Rp | blank = no cap |
| `monthly_salary_rp` | Monthly salary, in Rp | not set |
| `hole_start_date` | Date the Steals hole is counted from, `dd/mm/yyyy` | not set |
| `budget_start_date` | First day of the weekly budget, `dd/mm/yyyy`; rollover counts from that week | blank = oldest week shown (optional) |

Rupiah can be typed as a number or with `.` separators (`5.000.000`). A value
that can't be read falls back to its default and shows up in `warnings` from
`GET /api/cashflow-summary?action=settings`; nothing throws. Server code reads
settings with `fetchSettings()` from `api/_lib/sheets.js`. Rupiah values stay
in MNAB -- never copy them into the Claude Sheet.

## Fixed / variable (`Kind`)

Every transaction has a Kind: **Transfer**, **Income**, **Fixed** (bills and
installments) or **Variable** (day-to-day spending, card swipes included).
The weekly allowance counts only Variable. The rules are in
`api/_lib/kinds.js` (and mirrored in `apps-script/Kinds.gs`):

1. Transfer flag → Transfer. 2. Income → Income. 3. Kind set by hand → as
set. 4. A Bill ID (`Source ID`, the IB-n code) or Notes starting
`Auto-insert` → Fixed. 5. The payee's Kind on the `Payees` tab → that.
6. Otherwise → Variable.

`transactions` gets two self-provisioned columns, `Kind` and `Kind Rule`
(which rule set it; `manual` = set by hand). The Bill ID reuses the existing
`Source ID` column rather than adding a new one. Server code that needs
Kind should read rows with `fetchClassifiedTransactionRows()` from
`api/_lib/sheets.js`, which recomputes Kind from the rules (keeping hand-set
ones), so it's right even before the backfill has run. The transaction form
shows a Variable / Fixed toggle on expenses and suggests a bill when the
payee and amount match one (`GET /api/installments-summary?action=registry`).
The Payees page sets a payee's Kind (`POST /api/payees-list`,
`action: 'set-kind'`).

## Bill vs. Installment classification

This currently works off a date threshold: any row where `Ends` is in or
after the year 2099 is treated as a Bill. If you'd rather control this
explicitly, add a `Type` column to the sheet (`Installment` / `Bill`) and
update `api/_lib/sheets.js` to read it instead — more robust than a magic
date, at the cost of tagging each row yourself.

## Extending later

- New "widget" on the Installments & Bills page: another `api/*.js` function
  plus a card in `public/installments/index.html`.
- New page entirely (e.g. net worth, budget vs. actual): a new folder under
  `public/` with its own `index.html`, plus a link added to `public/index.html`'s
  nav menu.

## Weekly budget (`?action=week`)

`GET /api/cashflow-summary?action=week` is the number that steers day-to-day
spending. The rules live in `api/_lib/week.js`:

- **The week** runs from `week_start_day` (Wednesday) to the day before the
  next one. "Today" is the calendar date in Jakarta.
- **What counts:** only transactions whose Kind is **Variable**, in the week
  of their Date (card swipes on the day of the swipe). Pending and uncleared
  rows count. The imported leg of a still-**Proposed** email-import match is
  left out (so one purchase isn't counted twice) and listed in `excluded`.
- **Rollover** (`rollover_enabled`): what's left carries into next week,
  capped at `rollover_cap_rp` if set. Overspend reduces next week, but a week
  never starts below 0. Rollover counts from `budget_start_date`'s week; set
  it, or the start shifts with the history window (a warning says so).
- The current `weekly_allowance_rp` is applied to every week shown.

Query: `&date=YYYY-MM-DD` (as of another day), `&weeks=N` (history length,
default 12), `&transactions=0` (leave out this week's list).

Response: `week` (`start`, `end`, `allowance`, `carryIn`, `available`,
`spent`, `left`, `daysLeft`, `perDay`, `transactions`), `history` (completed
weeks, oldest first, each with `kept`), `streak` (weeks kept in a row),
`excluded`, `warnings`. All amounts are whole rupiah.
