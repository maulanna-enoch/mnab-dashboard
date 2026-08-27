# Email transaction import — setup guide

Automatically turns bank/e-wallet transaction notification emails into
`Pending` rows in the `transactions` sheet, instead of typing them in by
hand. Tracked in [issue #38](https://github.com/maulanna-enoch/mnab-dashboard/issues/38) —
see that issue's comments for the full design write-up and rationale if
you want the "why" behind any of this.

**Current phase:** polling only (Apps Script time-driven trigger, no
Google Cloud billing required). A push-based version (Gmail `watch()` +
Cloud Pub/Sub) is designed but not built — see "What's next" below.

The code itself (`EmailImport.gs`) is **not stored in this repo**. Like
`Reconcile.gs`, `Payments.gs`, etc., it's Apps Script bound directly to
the Sheet and lives in the Apps Script editor, not in git. This guide is
what's versioned here; the script was generated and delivered separately
(see the code block posted in the [implementation comment on issue #38](https://github.com/maulanna-enoch/mnab-dashboard/issues/38)
if you need to recover the source).

## How it works, in short

Each bank/e-wallet gets a nested Gmail label (`mnab/mandiri`, `mnab/ocbc`,
...) under a parent `mnab` label. A Gmail filter per sender applies both
labels automatically. An Apps Script trigger polls for labeled mail every
5 minutes, and for each message:

1. **Detects which email template** the sender used (some banks send more
   than one structurally different layout — confirmed with OCBC, which
   has a completely different "BI Fast transfer" template vs. "Credit
   Card Transaction" template).
2. **Checks success vs. failure** before extracting anything — banks
   commonly reuse the exact same template for both, just swapping a word
   like "Berhasil"/"Gagal". A failed transaction still gets logged (so
   you have a record), but with the amount zeroed out and the payee
   flagged `[FAILED TRANSFER]`, since no money actually moved.
3. **Extracts the transaction fields** (payee, amount, date) and
   **resolves which account** (`SOF`) it belongs to — one label can cover
   multiple cards/accounts from the same bank, matched by the last 4
   digits shown in the email.
4. Falls back to asking Claude to extract the fields if the deterministic
   parser can't (only if an API key is configured — see below). If even
   that fails, the row still gets written, flagged `[NEEDS REVIEW]`, so
   nothing is ever silently dropped.
5. Writes the row as `Pending = TRUE`. Nothing here marks anything
   `Cleared` or `Reconciled` — that's still entirely a manual step, same
   as today.

## One-time setup

### 1. Create the Gmail labels

In Gmail: **Settings → See all settings → Labels → Create new label.**
Create:

- `mnab`
- `mnab/mandiri`
- `mnab/ocbc`

(Nested-looking labels like `mnab/mandiri` are just ordinary Gmail labels
with a `/` in the name — Gmail displays them nested, but there's nothing
special to configure.)

### 2. Create a filter per bank

**Settings → Filters and Blocked Addresses → Create a new filter.**
Match on the sender, then under "Apply the label" pick **both** the
parent and the specific child label:

| Bank | Match | Labels to apply |
|---|---|---|
| Mandiri (Livin') | `from:(noreply.livin@bankmandiri.co.id)` | `mnab`, `mnab/mandiri` |
| OCBC | `from:(notifikasi@ocbc.id)` | `mnab`, `mnab/ocbc` |

Add a new row here (new filter + new label) any time a new bank/e-wallet
needs to be supported — no other setup changes with it.

### 3. Add the script to the Sheet

Open the MNAB Sheet → **Extensions → Apps Script**. Paste `EmailImport.gs`
in as a new script file (or append it to an existing one — it doesn't
need to be separate from `Reconcile.gs` etc., just don't overwrite them).
Save.

### 4. Authorize it

In the Apps Script editor, pick `processMnabEmails` from the function
dropdown and click **Run** once. Approve the Gmail + Sheets access it
asks for.

### 5. Dry-run it first

The script ships with `DRY_RUN = true`. With that on, running
`processMnabEmails` logs exactly what row it *would* write (**View →
Logs**, or Ctrl+Enter) without touching the sheet or re-labeling
anything — safe to run repeatedly against real `mnab`-labeled email while
checking the output looks right. Once you're happy, flip `DRY_RUN` to
`false` in the script.

### 6. Install the trigger

Once `DRY_RUN` is off, run `installEmailImportTrigger` once. From then
on, `processMnabEmails` runs automatically every 5 minutes — no more
manual runs needed.

### 7. (Optional) Enable the AI fallback

**Project Settings (gear icon) → Script Properties → Add script
property**, key `ANTHROPIC_API_KEY`, value = an Anthropic API key.
Without this, emails the deterministic parser can't handle land as a
flagged `[NEEDS REVIEW]` row instead of attempting AI extraction — never
silently dropped either way.

## Safety notes

- Every row this writes is `Pending = TRUE`. It never marks anything
  `Cleared` or `Reconciled`.
- It only ever **appends** new rows — nothing here edits or deletes
  existing rows in `transactions`.
- While `DRY_RUN` is `true`, threads are never re-labeled as processed,
  so re-running is repeatable for testing.
- A failed-transaction email still produces a row (so you have a record
  something was attempted), but with `Amount`/`Expense`/`Income`/`Total`
  all `0` and the payee prefixed `[FAILED TRANSFER]` — it can't affect
  your balance.

## What's next

The next phase (not built yet) swaps the 5-minute polling trigger for a
real push mechanism — Gmail `watch()` → Cloud Pub/Sub → an Apps Script
Web App receiver — so new transactions land within seconds instead of up
to 5 minutes, and without an Apps Script trigger running on a timer
whether or not there's anything new. That requires a Google Cloud
Billing account attached to the project (even though expected usage
stays within Pub/Sub's free tier). See the [design comment on issue #38](https://github.com/maulanna-enoch/mnab-dashboard/issues/38)
for the full setup plan for that phase.
