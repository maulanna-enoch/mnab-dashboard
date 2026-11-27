# MNAB Dashboard

A mobile-friendly dashboard. Pages:

### Home (`/`)

Answers "can I spend this?" and "am I getting out of debt?" (Debt Exit WS5):

- **Left this week** (hero) from `?action=week`: what's left of this week's
  allowance plus rollover, with a per-day hint, the week's dates, spent vs.
  available, and this week's Variable transactions. Red when over.
- **Where it went** from the same response's `where`: this week's Variable
  spending by category as a stacked bar, the top three categories, the change
  against the same point last week, the biggest payee and how much has no
  category yet. The whole card opens `/where`.
- **Weeks on budget**: one bar per completed budget week (oldest first) plus
  this week, height = spent / available, the dashed line = 100%, green when
  kept, red when not, with the streak of weeks kept.
- **Owed to the future** from `?action=debt`: the actual hole (Steals,
  reserves only) and % of salary, the projected debt-free date, how many
  days last week's over/under-spend moved it, and the date at your recent
  pace.
### Where it went (`/where`)

Debt Exit WS8, from `GET /api/cashflow-summary?action=where`. Variable
spending for a week or a calendar month (Week / Month toggle, ‹ › or the
arrow keys for earlier periods): the total against the same point of the
period before and the allowance, a stacked bar by category, then **By
category** (amount, share, change; Uncategorised last) or **Top payees**.
Tapping a category opens its detail: the last 12 periods, its payees and its
transactions; tap a transaction to move it to another category. On
**Uncategorised**, each payee has **Set category** to give it a default.
State lives in the URL (`?period=month&offset=-1&category=Groceries`), so
Back and links work.

The old Diary-based monthly Cash Flow view was removed when the Diary tab
was retired; `/cashflow` still redirects to Home.

### Bills (`/installments`)

Debt Exit plan WS3. One request, `GET /api/installments-summary?action=page`
(rules in `api/_lib/bills-page.js`), feeds three tabs, one question each:

- **This cycle** — what to pay before payroll (the last 25th up to the next
  one) and what's done. Only money leaving a cash account: bills paid from a
  cash account, and card statements. Bills and cicilan charged to a card are
  listed *inside* the statement they land on, never on their own, so the
  hero total never counts them twice. Late / Due soon (3 days) / Upcoming
  first, Paid greyed out at the bottom. A cash bill is paid when a
  non-Pending transaction carries its Bill ID (`Source ID`) between the
  previous and next due date; amount mismatches and auto-inserted rows still
  waiting to be confirmed are flagged.
- **Commitments** — what you're signed up for, by how it's paid: *From
  cash*, then one card per credit card with its bills and cicilan and its
  recent statements. A row is "on a card" when its SOF is a credit card
  account.
- **Outlook** — committed as % of salary (`monthly_salary_rp` in Settings)
  for 13 months, and the Ending soon list that explains the drops.

A notice lists active `installmentsbills` rows the page can't place (no Day
of Month, no Kind, an Installment without Starts/Ends).

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
  api/_lib/where.js                   Where it went: spending by category / payee per week or month
  api/cashflow-summary.js             Home's data: ?action=settings returns the Settings tab (typed, with defaults)
                                      ?action=week returns the weekly budget (allowance, left, history)
                                      ?action=where returns spending by category and payee (Where it went)
                                      ?action=debt returns the actual hole and debt projection
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
| `hole_fee_pct` | Lender fee on the hole per 30 days, e.g. `1%` | 1% |
| `job_start_date` | Start date at the current job, `dd/mm/yyyy` (prorates the THR) | blank (optional) |
| `thr_date` | Date the THR is paid, `dd/mm/yyyy` | blank = no THR in the projection |
| `thr_rp` | THR amount in Rp, if you know it | blank = months of service ÷ 12 × salary |
| `thr_share_pct` | Share of the THR put toward the hole | 100% |
| `raise_pct` | Yearly raise | 2% |
| `first_raise_date` | When the first raise takes effect, `dd/mm/yyyy` | blank = no raises in the projection |

Rupiah can be typed as a number or with `.` separators (`5.000.000`).
Percentages are best typed with a `%` (`1%`, `1,5%`) or in a cell formatted as
a percentage; a bare number above 1 is read as percentage points (`2` = 2%),
but a bare `1` means 100%. The last seven rows only feed the debt projection
and mirror the Claude Sheet's Assumptions tab. A value
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
`excluded`, `warnings`, and `where` (this week's categories and top three
payees, as below). All amounts are whole rupiah.

## Where it went (`?action=where`)

`GET /api/cashflow-summary?action=where&period=week|month&offset=0&category=NAME`
(rules in `api/_lib/where.js`). The same lines as the weekly budget: Kind =
Variable only, on the swipe date, pending and uncleared included, proposed
import duplicates left out. A week runs from `week_start_day`; a month is the
calendar month. `offset` 0 is the current period, -1 the one before. A
finished period is compared with the whole period before it; the current one
with the same number of days at the start of the last one. The allowance is
`weekly_allowance_rp` for a week and that × days ÷ 7 for a month.

Response: `start`, `end`, `inProgress`, `daysElapsed`, `daysTotal`, `total`,
`count`, `compare` (`start`, `end`, `total`, `partial`), `allowance`,
`categories` (`name`, `group`, `amount`, `count`, `compareAmount`; biggest
first, Uncategorised last), `payees` (top 10: `name`, `amount`, `count`, main
`category`), `morePayees` (`count`, `amount`), `excludedCount`. With
`category`, also `detail`: `amount`, `count`, `compareAmount`, `history` (the
last 12 periods), `payees`, `transactions`.

## Actual hole and debt projection (`?action=debt`)

`GET /api/cashflow-summary?action=debt` answers "am I getting out of debt?".
The rules live in `api/_lib/debt.js`:

- **The actual hole** comes from the `Steals` log: Steal rows minus Payback
  rows, counting the reserve types only (Penarikan Reksadana, Pinjaman,
  Tabungan / Dana Darurat), from `hole_start_date` up to today. It's the
  same figure as "Owed to future (reserves)" on the Steals Summary tab; card
  cash advances and paylater are left out.
- **The projection** is the Claude Sheet's Payoff plan, month by month from
  next month: hole + fee against salary + THR + raises − bills − day-to-day,
  where day-to-day is `weekly_allowance_rp` × 52 / 12 and bills come from
  `installmentsbills`. A bill counts from its Starts month until the sheet's
  "first statement free" month: Ends month + 1 for cash; for a card (a Card
  bill, or anything whose SOF is a credit card) + 1 if Ends is on or before
  the 12th, else + 2. Like the sheet, only the one THR in `thr_date` is
  modelled. Given the same inputs it matches the sheet month for month.
- **Debt-free month** is the month after the last month that still has a
  hole (the sheet's "debt-free for good"). `estimatedDate` places it within
  that month by how much of the month's room the last of the hole takes.
- **At your pace** reruns it with day-to-day moved by the average
  over/under-spend of the last 4 completed budget weeks (`&pace=N`).
  **Last week** shows how many days last week's over/under-spend moves the
  estimated date if it lands on the hole (positive = later).

Query: `&date=YYYY-MM-DD`, `&months=N` (default 60), `&pace=N`, `&rows=0`
(leave out the month-by-month table).

Response: `hole` (`amount`, `pctOfSalary`, `byType`), `inputs`, `plan`
(`debtFreeMonth`, `estimatedDate`, `peak`, `peakAfterThr`, `months`), `pace`,
`lastWeek` (`deviation`, `movedDays`), `warnings`. Amounts are whole rupiah.
