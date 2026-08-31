# Payee location autocomplete — setup guide

Ranks/filters the Payee autocomplete in the Add transaction form by
proximity to your current location, and adds a `Payees` tab as the
authoritative payee registry (coordinates plus, going forward, every payee
name that's ever used). Tracked in
[issue #52](https://github.com/maulanna-enoch/mnab-dashboard/issues/52) —
see that issue's comments for the full design write-up if you want the
"why" behind any of this.

## One-time setup — the only thing you need to do by hand

### 1. Add a `Payees` tab to the Sheet

In the same Google Sheet as `transactions`/`Accounts`/etc., add a new tab
named exactly **`Payees`**. Give it a header row (row 1) and leave the data
starting at row 2 — same convention as every other tab in this Sheet.
Columns, in this exact order (the API reads this tab by fixed column
position, not by header name, so the order matters — the header row itself
is just for your own readability):

| Column | Header (row 1) | Contents |
|---|---|---|
| A | `Payee` | Payee name (text) |
| B | `Lat` | Latitude, decimal degrees |
| C | `Lon` | Longitude, decimal degrees |
| D | `Updated At` | Timestamp of the last coordinate write — informational only, never read back for logic |

That's it — leave the rest of the tab empty. The app populates it from
here on.

### 2. Nothing else to configure

- **No new environment variables.** This reuses the same `SHEET_ID`,
  `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` (read), and
  `GOOGLE_WRITE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_WRITE_PRIVATE_KEY` (write)
  Vercel project env vars the rest of the app already uses.
- **No new sharing/permission step.** Both service accounts already have
  access to the whole spreadsheet (that's how `transactions`/`Accounts`
  reads and writes work today) — a new tab in the same spreadsheet is
  covered automatically.
- **Browser location permission.** The first time you save a transaction
  after this ships, your phone/browser will prompt for location access for
  the site. Allow it if you want the location-pin toggle and
  proximity-sorted autocomplete to work. If you deny it (or it times out),
  transactions still save completely normally — you just won't see the
  toggle and the Payee list falls back to plain alphabetical order.

### 3. One-time backfill (do this once after deploying)

`Payees` starts empty. Open **Payees** from the link on the Accounts page
(or go to `/payees` directly) and tap **"Import payees from transaction
history"** once. This adds a row (name only, no coordinates yet) for every
distinct payee already in your `transactions` history, so the autocomplete
list isn't empty on day one. Safe to tap again any time — it only adds
payees that aren't already listed, never touches existing rows.

## How it works day to day

- The Payee field on the Add transaction form works exactly as before —
  pick an existing name or type a new one.
- When you save a **new** transaction, the form best-effort grabs your
  current location and shows a small location-pin toggle next to the Payee
  field (only if a position was actually captured). It defaults **on**. If
  you leave it on, saving updates that payee's stored coordinate to here —
  last-known-location, overwriting whatever was there before. Tap it off
  before saving if you're logging the transaction away from the actual
  payee (e.g. entering it from home that evening) and don't want to drag
  their location to the wrong place.
- This only happens on **new** transactions, not when editing an existing
  one — editing an old row doesn't imply you're currently at that payee, so
  the toggle/capture is skipped entirely there.
- **Payees** (reachable from the Accounts page) is the manual-override
  path: fix a coordinate that drifted, or pre-set one for a payee you'll
  never actually be standing at (e.g. a recurring online biller).

## What this deliberately does NOT do (see issue #52 for the reasoning)

- No reverse-geocoding — coordinates are raw lat/lon numbers only.
- One coordinate per payee (a single "last known location"), not
  multiple branches/locations for a chain.
- No recency ("last used") ordering anywhere in the autocomplete —
  alphabetical is the fallback when no position is available.
