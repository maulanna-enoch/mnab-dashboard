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

Each bank/e-wallet gets its own Gmail label (`mnab/mandiri`, `mnab/ocbc`,
...). A Gmail filter per sender applies that one label. An Apps Script
trigger polls for mail carrying any of the known labels every 5 minutes,
and for each message:

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
Create one label per bank you want to support — just the specific label,
no separate parent label needed:

- `mnab/mandiri`
- `mnab/ocbc`

(A label named `mnab/mandiri` is just an ordinary Gmail label with a `/`
in the name — Gmail nests it under an "mnab" grouping in the sidebar for
display purposes only. There's no real `mnab` label to create separately,
and the script doesn't need one either.)

### 2. Create one filter per bank

**Settings → Filters and Blocked Addresses → Create a new filter.**
Match on the sender, then under "Apply the label" pick that bank's single
label. (Gmail's filter UI only allows one label per rule anyway, so this
is also the only thing that's actually possible — no need to juggle
multiple labels per filter.)

| Bank | Match | Label to apply |
|---|---|---|
| Mandiri (Livin') | `from:(noreply.livin@bankmandiri.co.id)` | `mnab/mandiri` |
| OCBC | `from:(notifikasi@ocbc.id)` | `mnab/ocbc` |

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

### 5. Skip the backlog, if you have one

**Only needed if a label already has old email under it** — e.g. you
reused a label you'd already been using for a while, so it's got hundreds
of pre-existing messages. If your labels are freshly created with nothing
under them yet, skip straight to step 6.

The script has no concept of "old" vs "new" mail — it imports anything
carrying a known label that isn't already tagged `mnab/imported`. Pointed
at a label with an existing backlog, it would try to import every single
one of those old messages as a transaction the first time it runs.

Run `markExistingMnabEmailsAsAlreadyImported` (same function dropdown,
**Run** once) to fix this. It applies the `mnab/imported` label to every
thread the normal import would currently match — same search, same label
— but never reads a message or writes a row to the sheet. After it runs,
only mail arriving under the label from that point on gets imported.

It's capped at 100 threads per run (a Gmail limit). Check the execution
log — if it says it hit that cap, just run it again until it logs 0
remaining. It's also safe to run more than once regardless: once a thread
is labeled `mnab/imported`, it stops matching and won't be touched again.

This step deliberately ignores `DRY_RUN` — it never writes rows or reads
message content either way, only applies a Gmail label, so it does real
(if easily-reversible-by-hand) label changes even while `DRY_RUN` is
still `true`.

### 6. Dry-run it first

The script ships with `DRY_RUN = true`. With that on, running
`processMnabEmails` logs exactly what row it *would* write (**View →
Logs**, or Ctrl+Enter) without touching the sheet or re-labeling
anything — safe to run repeatedly against real labeled email while
checking the output looks right. Once you're happy, flip `DRY_RUN` to
`false` in the script.

### 7. Install the trigger

Once `DRY_RUN` is off, run `installEmailImportTrigger` once. From then
on, `processMnabEmails` runs automatically every 5 minutes — no more
manual runs needed.

### 8. (Optional) Enable the AI fallback

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
- `markExistingMnabEmailsAsAlreadyImported` (step 5 above) is the one
  exception to all of the above: it ignores `DRY_RUN` and does make a real
  change (applying the `mnab/imported` label) even before you've flipped
  `DRY_RUN` off, since that's the entire point of it. It never touches the
  sheet or reads message content, though — only Gmail labels.

## What's next

The next phase (not built yet) swaps the 5-minute polling trigger for a
real push mechanism — Gmail `watch()` → Cloud Pub/Sub → an Apps Script
Web App receiver — so new transactions land within seconds instead of up
to 5 minutes, and without an Apps Script trigger running on a timer
whether or not there's anything new. That requires a Google Cloud
Billing account attached to the project (even though expected usage
stays within Pub/Sub's free tier). See the [design comment on issue #38](https://github.com/maulanna-enoch/mnab-dashboard/issues/38)
for the full setup plan for that phase.
