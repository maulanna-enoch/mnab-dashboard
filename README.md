# MNAB Dashboard

A mobile-friendly home menu with three pages:

### Cash Flow (`/cashflow`)

Reads the `Diary` tab. A month dropdown (populated from whatever months
actually exist in `Diary`) drives three cards:

- **Left to spend** (hero number) — `Income − Outflow`. Red if negative.
- **Income** — sum of `Income/Expense = Income` rows for the selected month.
- **Outflow** — sum of `Income/Expense = Expense` rows, split into **Paid**
  (`Status = Paid`) and **Budgeted** (anything else — i.e. the unpaid rows
  your sheet's button adds at the start of the month).

Each card expands to show the underlying line items.

### Installments & Bills (`/installments`)

Reads the `installmentsbills` tab. Rows are split into two categories:

- **Installments** — have a real payoff date in `Ends`. Broken down by ending
  month with a running "remaining after" total.
- **Bills** — recurring items that don't really end, marked in the sheet with
  a far-future placeholder `Ends` date (year ≥ 2099). Shown as a flat total,
  no month breakdown.

Both only count rows where `is_active` is `TRUE`.

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
  api/cashflow-months.js              Distinct months found in Diary, for the month dropdown
  api/cashflow-summary.js             Income/Paid/Budgeted/Left-to-spend for a given ?month=YYYY-MM
  api/installments-summary.js         Sum of active Installment amounts (excludes Bills)
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
