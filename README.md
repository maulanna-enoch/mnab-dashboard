# MNAB Dashboard

A mobile-friendly home menu, with an "Installments & Bills" page reading from
the `installmentsbills` tab. Rows are split into two categories:

- **Installments** — have a real payoff date in `Ends`. Broken down by ending
  month with a running "remaining after" total.
- **Bills** — recurring items that don't really end, marked in the sheet with
  a far-future placeholder `Ends` date (year ≥ 2099). Shown as a flat total,
  no month breakdown.

Both only count rows where `is_active` is `TRUE`.

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

## Project structure

```
mnab-dashboard/
  api/_lib/sheets.js                  Shared: reads the sheet, classifies each row (active/Bill/Installment)
  api/installments-summary.js         Sum of active Installment amounts (excludes Bills)
  api/installments-by-end-month.js    Active Installments grouped by ending month, with running remaining total
  api/bills-summary.js                Sum + list of active Bills
  public/index.html                   Home menu page
  public/installments/index.html      Installments & Bills page (linked from home)
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
