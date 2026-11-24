/**
 * EmailImport.gs — MNAB email-to-transaction importer (Issue #38)
 *
 * Phase 1 (this file): short-interval time-driven trigger polling Gmail.
 * Phase 2 (future, not built yet): swap the trigger for Gmail watch() +
 * Cloud Pub/Sub push. None of the functions below need to change for that
 * later swap — only how processMnabEmails() gets invoked changes.
 *
 * ── IF YOU'RE UPGRADING AN ALREADY-LIVE SETUP ───────────────────────────
 * This version moves DRY_RUN out of the code (a `var`) and into a Script
 * Property instead — see "DRY_RUN IS NOW A SCRIPT PROPERTY" below for why.
 * One thing this changes: pasting this file over your existing script does
 * NOT preserve whatever DRY_RUN was set to before — Script Properties are
 * a separate store from the code text, and if you've never set the
 * property yet, it defaults to `true` (safe: nothing gets written). If
 * your setup was already live (importing for real), you need to add the
 * property once after pasting this in — see that section below — or it
 * will silently sit in dry-run/log-only mode until you do.
 *
 * ── ONE-TIME SETUP ──────────────────────────────────────────────────────
 * 1. In Gmail, create these labels (Settings > See all settings > Labels
 *    > Create new label) — you only ever need the specific child label,
 *    never a separate parent "mnab" label. Gmail nests "mnab/mandiri"
 *    under an "mnab" grouping in the sidebar automatically just because
 *    of the "/" in the name; there's no real "mnab" label to create:
 *      mnab/mandiri
 *      mnab/ocbc
 *      mnab/jago
 *      mnab/grab   (optional — Grab receipts; see "GRAB RECEIPTS" near the end)
 * 2. Create ONE Gmail filter per bank sender applying its single label
 *    (Gmail's filter UI only lets you pick one label per rule anyway, so
 *    this is also the only thing that's actually possible):
 *      from:(noreply.livin@bankmandiri.co.id) → apply label "mnab/mandiri"
 *      from:(notifikasi@ocbc.id)              → apply label "mnab/ocbc"
 *      from:(noreply@jago.com)                → apply label "mnab/jago"
 *      from:(no-reply@grab.com) subject:(receipt OR struk) → "mnab/grab"
 *    (Gmail > Settings > Filters and Blocked Addresses > Create a new
 *    filter > match the sender > Continue > check "Apply the label" >
 *    pick the one label.)
 * 3. Open the MNAB Sheet > Extensions > Apps Script, and paste this whole
 *    file in as a new script file (or into an existing one — doesn't need
 *    to be separate from Reconcile.gs etc., just don't overwrite them).
 *    Save.
 * 4. In the Apps Script editor, pick `processMnabEmails` from the function
 *    dropdown and click Run once. It'll ask you to authorize Gmail +
 *    Sheets access the first time — approve it.
 * 5. If either label already has a backlog of OLD email under it — e.g.
 *    you reused a label you'd already been using for a while, so it's got
 *    hundreds of pre-existing messages — run `markExistingMnabEmailsAsAlreadyImported`
 *    once now, BEFORE doing anything else below. It marks every
 *    currently-matching thread as already-handled WITHOUT writing any
 *    rows, so none of that backlog gets imported as a transaction; only
 *    mail that arrives after this point will. See "Skipping a pre-existing
 *    backlog" further down for details. If your labels are freshly
 *    created with nothing under them yet, skip this step entirely.
 * 6. DRY_RUN defaults to `true` (see "DRY_RUN IS NOW A SCRIPT PROPERTY"
 *    below) — nothing gets written until you say otherwise. With it true,
 *    run `processMnabEmails` a few times as real mail arrives under your
 *    labels and check the execution log (View > Logs, or Ctrl+Enter) — it
 *    prints exactly what row WOULD be written, without touching the sheet
 *    or re-labeling anything. Testing against OLD mail (a backlog) instead
 *    of waiting for new mail to arrive? Use `previewMnabBacklog` — see
 *    "TESTING AGAINST A BACKLOG" below. Once the logged output looks right,
 *    set the DRY_RUN script property to `false` (see below).
 * 7. Once you're happy with dry-run output, run `installEmailImportTrigger`
 *    once to install the 5-minute polling trigger. From then on this runs
 *    automatically — no need to run either function by hand again.
 * 8. (Optional, for the AI fallback) Project Settings (gear icon) > Script
 *    Properties > Add script property, key `ANTHROPIC_API_KEY`, value =
 *    your Anthropic API key. Without this, emails that the deterministic
 *    parser can't handle land as a flagged manual-review row instead of
 *    being silently dropped — they just skip the AI attempt and wait for
 *    you to fill them in by hand or improve the parser.
 * 9. (Optional, for push notifications) Two more script properties:
 *      PUSH_NOTIFY_URL     https://<your-vercel-domain>/api/push
 *      PUSH_NOTIFY_SECRET  the same value as PUSH_NOTIFY_SECRET in Vercel
 *    After a run writes new rows, this file sends them to that URL in one
 *    call and the dashboard pushes a notification to every device that
 *    turned notifications on (the bell on the home page). Leave either
 *    property unset and nothing is sent. See "PUSH NOTIFICATIONS" below.
 *
 * ── DRY_RUN IS NOW A SCRIPT PROPERTY, NOT A CODE VARIABLE ───────────────
 * Project Settings (gear icon) > Script Properties > Add script property,
 * key `DRY_RUN`, value `true` or `false`. Unset defaults to `true`.
 *
 * WHY: a hardcoded `var DRY_RUN = true;` in the code meant every time you
 * pasted an updated copy of this file over your live script — like this
 * very update — DRY_RUN silently reset to whatever the NEW file shipped
 * with, even if your live setup already had it set to `false`. Combined
 * with an already-installed 5-minute trigger, that's exactly what caused a
 * real incident on this project: a pasted update reset DRY_RUN to `true`,
 * the trigger kept firing every 5 minutes, and — see the next section —
 * every DRY_RUN=true run used to ALSO scan the entire backlog, not just
 * new mail, so it burned through an entire day's Gmail quota in well
 * under an hour, with nobody watching.
 *
 * Script Properties live outside the code text entirely, so pasting a new
 * version of this file from here on never touches them — DRY_RUN stays
 * whatever you last set it to, deploy after deploy.
 *
 * ── TESTING AGAINST A BACKLOG: previewMnabBacklog(), NOT DRY_RUN ────────
 * Previously, DRY_RUN=true made `processMnabEmails` ALSO widen its Gmail
 * search to include already-imported threads (so you could dry-run-test
 * against your whole backlog, not just new mail) — which is exactly the
 * behavior that, combined with an installed trigger left in DRY_RUN mode,
 * caused the quota incident above: every 5-minute trigger firing re-read
 * the ENTIRE backlog again, forever, since a dry run never marks anything
 * as done.
 *
 * That widened search now lives ONLY in a separate function,
 * `previewMnabBacklog()` — manual-only (never call it from a trigger; it's
 * never what `installEmailImportTrigger` installs), and it ALWAYS
 * simulates regardless of the DRY_RUN property, so it can never write a
 * row or re-label a thread no matter what. Run it by hand from the
 * function dropdown whenever you want to test the parser against mail
 * already labeled `mnab/imported` — it's safe and cheap to re-run as many
 * times as you like, but only because a human, not a timer, decides when
 * it runs.
 *
 * `processMnabEmails` — the only function the trigger ever calls — now
 * ALWAYS excludes already-imported threads, regardless of DRY_RUN. DRY_RUN
 * only ever controls whether a genuinely-new message gets written for real
 * or just logged; it no longer controls how much of Gmail gets read. That
 * decoupling is what makes it safe to leave `processMnabEmails` trigger-
 * bound indefinitely in either DRY_RUN state.
 *
 * ── SKIPPING A PRE-EXISTING BACKLOG ─────────────────────────────────────
 * `processMnabEmails` has no concept of "old" vs "new" mail — it just
 * searches for anything carrying a known label that ISN'T already tagged
 * `mnab/imported`. If you point it at a label that already has hundreds of
 * old messages sitting under it, it will treat every single one as a new
 * transaction to import the first time it runs.
 *
 * `markExistingMnabEmailsAsAlreadyImported()` (below) exists for exactly
 * this: it applies the `mnab/imported` label to every thread the normal
 * poll query would currently match — same search, same label — but never
 * reads a message or writes a row. Run it once, before your first LIVE
 * `processMnabEmails` run (DRY_RUN property = false), and the backlog is
 * permanently excluded from real imports; only mail landing under the
 * label from then on will ever get written to the sheet. It's capped at
 * `BOOTSTRAP_BATCH_SIZE` threads per run (Gmail per-call limits) — if the
 * log says it hit the cap, just run it again until it logs 0 remaining.
 * Safe to run more than once either way: already-labeled threads simply
 * stop matching the search.
 *
 * Marking a thread `mnab/imported` this way does NOT stop it from being
 * previewed via `previewMnabBacklog()`, though — see above.
 *
 * ── SAFETY NOTES ────────────────────────────────────────────────────────
 * - Every row this script writes lands as Pending = TRUE. Nothing here
 *   marks anything Cleared or Reconciled — that's still entirely your
 *   call, same as today.
 * - `getRange(...).setValue()` calls only ever APPEND new rows at the
 *   bottom of `transactions`. Nothing here edits or deletes existing rows.
 * - If DRY_RUN is true, the Gmail thread is NOT re-labeled as processed,
 *   so re-running processMnabEmails() will show you the same emails again
 *   — that's intentional, so dry-run testing is repeatable.
 * - `previewMnabBacklog()` ALWAYS behaves like DRY_RUN, even if the
 *   DRY_RUN script property is `false` — it never writes or re-labels no
 *   matter what, precisely so it's safe to run against a live setup too.
 * - `markExistingMnabEmailsAsAlreadyImported()` intentionally IGNORES
 *   DRY_RUN — that's the whole point of it (it never writes rows or reads
 *   message content at all, only applies a Gmail label), so it does real,
 *   non-reversible-by-this-script label changes regardless of DRY_RUN.
 *
 * ── TWO LAYERS OF DUPLICATE PROTECTION ──────────────────────────────────
 * The `mnab/imported` label (above) is a THREAD-level guard — it stops an
 * already-handled thread from being searched up again. But two things can
 * still produce a real duplicate row despite that:
 *
 * 1. Two executions overlapping — e.g. the 5-minute trigger firing again
 *    before a slow run finishes, or a manual run started while the trigger
 *    is also running. Both could search for unprocessed threads, both find
 *    the same one (neither has labeled it yet), and both write a row for
 *    it. Fixed with `LockService`: every entry point below grabs a
 *    script-wide lock at the very start and holds it for the whole run, so
 *    only one execution can ever be doing this at once (this also means
 *    `previewMnabBacklog()` can't race a live trigger run either). A
 *    second execution that can't get the lock within 30s just logs that
 *    and returns — it'll simply run again on the next scheduled trigger.
 * 2. A run that writes a row for a message but then fails/times out
 *    BEFORE reaching the "label this thread as imported" step (Apps
 *    Script's 6-minute execution cap, a thrown error, a quota hiccup).
 *    The thread is left unlabeled, so the next run picks the same message
 *    back up and would otherwise write it again. The lock above doesn't
 *    help here — it's the same message being reconsidered by a LATER,
 *    non-overlapping run. Fixed with a MESSAGE-level guard: every row
 *    this script writes is stamped with that email's Gmail message ID (an
 *    `Email Message ID` column, auto-provisioned the same way `Pending`
 *    is). Before processing any message, its ID is checked against every
 *    ID already present in that column; if it's already there, the
 *    message is skipped — logged, not written again — regardless of
 *    whether its thread ever got labeled. This check runs during
 *    `previewMnabBacklog()` too, since "this would be skipped as an
 *    already-imported duplicate" is exactly what a live run would actually
 *    do — an accurate preview, not a behavior change. It has no effect on
 *    backlog threads that were only ever LABELED via
 *    `markExistingMnabEmailsAsAlreadyImported()` (never written), since
 *    those never got a message ID recorded — they stay fully previewable
 *    exactly as before.
 *
 * Note this doesn't (and can't) catch duplicates that already happened
 * with an OLDER version of this script, before the `Email Message ID`
 * column existed — those rows were never stamped, so there's nothing to
 * match against. It only prevents new duplicates going forward. If you
 * suspect old duplicate rows are already sitting in `transactions`,
 * they'll need a manual look (or ask for a one-off script to help find
 * likely candidates by matching Payee/Amount/Date).
 *
 * ── THIRD KIND OF DUPLICATE: IMPORTED vs. MANUALLY-ENTERED (Issue #51) ──
 * The two layers above stop the SAME email from producing two rows. They
 * don't help with a different overlap: the user logs a transaction by hand
 * (e.g. a QRIS payment) and the bank's own notification email for that
 * same real-world payment shows up too, separately, as a new Pending row.
 * Without help, that's two rows in `transactions` for one real transaction
 * — double-counting in both balance concepts (see MNAB-project-state.md).
 *
 * Unlike the two layers above, this one does NOT change what gets written:
 * the imported row is always written normally, exactly as before. Instead,
 * `findManualMatch_()` (below, called from `writeRow_()`) checks every new
 * import against the sheet's existing MANUAL rows (Pending not TRUE, and
 * not already carrying a Match ID of its own) for: same `SOF`, same
 * `Amount`, same `Income/Expense` type, and a `Date` within
 * `MATCH_WINDOW_DAYS` days. On exactly one match, BOTH rows — the
 * brand-new imported one and the existing manual one — get stamped with
 * the same freshly-generated `Match ID` and `Match Status` = "Proposed"
 * (two more self-provisioned columns, same pattern as `Pending`/`Email
 * Message ID`). Nothing is deleted or excluded from balances at this
 * point; it's purely a flag for the dashboard to surface.
 *
 * The dashboard (not this file) is where the user actually resolves a
 * proposed match, via `api/transactions-update.js`'s `confirmMatch` /
 * `unmatchMatch` actions:
 *   - Confirm: the two rows really are the same real-world transaction.
 *     In this MVP, the app deletes the auto-imported leg outright and
 *     clears the Match ID/Status off the surviving manual row — the
 *     manual entry the user already made is treated as the record of
 *     that transaction. (A future iteration could do this more like the
 *     Transfer-flag exclusion issue #51 originally sketched, keeping both
 *     rows for an audit trail; deleting is simpler and is what got asked
 *     for here.)
 *   - Unmatch/decline: the two rows are coincidentally similar but not
 *     actually the same transaction. The Match ID/Status is cleared off
 *     BOTH rows and each goes back to being treated entirely
 *     independently — the imported row's own Pending flag is untouched,
 *     so it still goes through the normal Pending review flow on its own.
 *
 * Ambiguous cases (more than one manual row fits, or the only fitting
 * manual row is already tied up in another proposed/matched pair) are
 * left alone on purpose — no proposal is made, and the import just lands
 * as a normal Pending row, rather than risk flagging the wrong pairing.
 *
 * Only proposes a match at import time, against manual rows that already
 * exist when the email is processed. It does NOT re-sweep already-
 * imported Pending rows if a matching manual entry gets added afterward
 * — that gap is a known, accepted limitation, not an oversight.
 */

// ── CONFIG ──────────────────────────────────────────────────────────────

// DRY_RUN lives in Script Properties now, not as a `var` here — see
// "DRY_RUN IS NOW A SCRIPT PROPERTY" up top for why. Set it via Project
// Settings (gear icon) > Script Properties > key `DRY_RUN`, value `true`
// or `false`. Unset (e.g. a brand-new install) is treated as `true` —
// nothing gets written until you explicitly say otherwise.
function isDryRun_() {
  var value = PropertiesService.getScriptProperties().getProperty('DRY_RUN');
  return value === null ? true : value !== 'false';
}

var TRANSACTIONS_SHEET_NAME = 'transactions';
var PROCESSED_LABEL = 'mnab/imported'; // applied after a thread is handled, so it's never reprocessed
var MAX_THREADS_PER_RUN = 50; // safety cap; a backlog just catches up over a few runs

var FAILURE_KEYWORDS = [
  'gagal', 'tidak berhasil', 'ditolak', 'dibatalkan', 'kadaluarsa',
  'failed', 'unsuccessful', 'declined', 'cancelled', 'canceled', 'expired'
];

// last-4-digits (of the card, or of the account number when there's no
// card involved) → exact Accounts.Name. Confirmed with the user — use
// verbatim, don't reformat.
var MANDIRI_SOF_MAP = {
  '2166': 'mandiri platinum',
  '2892': 'mandiri 2892',
  '2069': 'mandiri golf',
  '0875': 'mandiri'
};

var OCBC_SOF_MAP = {
  '4226': 'ocbc 90.N',
  '9376': 'ocbc platinum'
  // no card last-4 entry here → resolved to 'ocbc' (cash account) instead,
  // when the email shows a bank account number rather than a card number.
  // See parseOcbcTransfer_().
};

// Jago notification emails show the underlying Pocket/account number
// (e.g. 104793934024, 101949727062, or an RDN number for money received
// into an investment-linked pocket) rather than a card last-4 — and real
// samples showed more than one such number across different Jago
// products. The user only tracks a single Accounts.Name for all of it, so
// unlike MANDIRI_SOF_MAP/OCBC_SOF_MAP this isn't a lookup table — every
// mnab/jago transaction resolves to this one constant regardless of which
// account number the email shows. If per-pocket tracking is ever wanted,
// swap this for a last-4/account-number map following the same pattern.
var JAGO_SOF = 'jago';

var INDONESIAN_MONTHS = {
  'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'mei': 4, 'may': 4, 'jun': 5,
  'jul': 6, 'agu': 7, 'aug': 7, 'sep': 8, 'okt': 9, 'oct': 9,
  'nov': 10, 'des': 11, 'dec': 11
};

// Label → parser function. Add a new bank by writing its parser function
// and adding one line here — no trigger/watch changes, and no filter
// beyond the one Gmail filter for that sender's label.
var LABEL_PARSERS = {
  'mnab/mandiri': parseMandiriEmail_,
  'mnab/ocbc': parseOcbcEmail_,
  'mnab/jago': parseJagoEmail_
};

// Built from LABEL_PARSERS's keys rather than a hardcoded parent "mnab"
// label — Gmail's filter UI only allows ONE label per rule, so there's no
// practical way to also stamp every message with a shared parent label.
// Searching "any of the known child labels" instead means each bank only
// ever needs its own single filter → single label.
//
// includeAlreadyImported (default false): when true, drops the
// "-label:mnab/imported" exclusion, so threads already marked as processed
// (e.g. via markExistingMnabEmailsAsAlreadyImported(), or normal live runs)
// show up too. Only previewMnabBacklog() ever passes true here — a manual-
// only function, never trigger-bound — specifically so you can dry-run-test
// the parser against your old marked-as-imported backlog without that
// testing having any side effects. processMnabEmails() (what the trigger
// calls) ALWAYS passes false, regardless of DRY_RUN, so already-imported
// threads stay excluded from every trigger-driven run, in either DRY_RUN
// state — see "TESTING AGAINST A BACKLOG" up top for why that matters.
function buildPollQuery_(includeAlreadyImported) {
  var clauses = Object.keys(LABEL_PARSERS).concat([GRAB_RECEIPT_LABEL]).map(function (l) { return 'label:' + l; });
  var query = '(' + clauses.join(' OR ') + ')';
  if (!includeAlreadyImported) {
    query += ' -label:' + PROCESSED_LABEL;
  }
  return query;
}

// ── ENTRY POINTS ────────────────────────────────────────────────────────

function installEmailImportTrigger() {
  uninstallEmailImportTrigger(); // avoid stacking duplicate triggers if run more than once
  ScriptApp.newTrigger('processMnabEmails')
      .timeBased()
      .everyMinutes(5)
      .create();
  Logger.log('Installed: processMnabEmails will now run automatically every 5 minutes.');
}

function uninstallEmailImportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processMnabEmails') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// Gmail per-call cap for this kind of batch operation. A backlog bigger
// than this just needs markExistingMnabEmailsAsAlreadyImported() run a
// couple more times — it logs whether it hit the cap so you know.
var BOOTSTRAP_BATCH_SIZE = 100;

// ── ONE-TIME BOOTSTRAP for a pre-existing backlog ─────────────────────
// See "SKIPPING A PRE-EXISTING BACKLOG" up top. Run this ONCE (or a few
// times back-to-back if it hits the batch cap) before your first real
// processMnabEmails run, ONLY if mnab/mandiri / mnab/ocbc / mnab/jago
// already have old mail under them that you don't want imported as
// transactions.
//
// Deliberately does NOT call handleMessage_/writeRow_ — it only ever
// touches Gmail labels, never the Sheet, and never reads message bodies.
// That's what makes it safe to run even while DRY_RUN is still true.
function markExistingMnabEmailsAsAlreadyImported() {
  var label = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
  var threads = GmailApp.search(buildPollQuery_(), 0, BOOTSTRAP_BATCH_SIZE);

  threads.forEach(function (thread) {
    thread.addLabel(label);
  });

  if (threads.length === 0) {
    Logger.log('No matching threads found — backlog is already fully marked (or there never was one). Safe to proceed.');
  } else if (threads.length === BOOTSTRAP_BATCH_SIZE) {
    Logger.log('Marked ' + threads.length + ' thread(s) as already-imported — that\'s a full batch, so there may be more. Run this again.');
  } else {
    Logger.log('Marked ' + threads.length + ' thread(s) as already-imported. Backlog cleared — safe to dry-run test / install the trigger now.');
  }
}

// How long to wait for another in-progress run to finish before giving up
// on this one. See "TWO LAYERS OF DUPLICATE PROTECTION" up top.
var LOCK_WAIT_MS = 30 * 1000;

// Rows written during the current runImportPass_(), collected by writeRow_
// for the push notification sent at the end of the run. null outside a run
// (and during dry runs nothing is collected, since nothing is written).
var importedThisRun_ = null;

// The ONLY function installEmailImportTrigger() ever binds to the 5-minute
// trigger. Always excludes already-imported threads (includeAlreadyImported:
// false) — regardless of DRY_RUN — so a trigger-driven run only ever looks
// at genuinely new mail. See "TESTING AGAINST A BACKLOG" up top for why
// that's no longer coupled to DRY_RUN the way it used to be.
function processMnabEmails() {
  runImportPass_({ includeAlreadyImported: false, forceDryRun: false });
}

// Manual-only — run this by hand from the function dropdown; never bind it
// to a trigger. Widens the search to include already-imported threads too,
// so you can test the parser against your whole backlog, not just new
// mail. ALWAYS simulates (forceDryRun: true) regardless of the DRY_RUN
// script property, so it can never write a row or re-label a thread no
// matter what — see "TESTING AGAINST A BACKLOG" up top.
function previewMnabBacklog() {
  runImportPass_({ includeAlreadyImported: true, forceDryRun: true });
}

// Shared core for both entry points above. `opts.includeAlreadyImported`
// controls how much of Gmail gets searched; `opts.forceDryRun` (true only
// for previewMnabBacklog()) overrides the DRY_RUN script property so that
// path can never go live by accident. Everything else — the lock, the
// message-ID duplicate guard, the actual parsing/writing — is identical
// either way, so previewMnabBacklog() is a faithful preview of exactly
// what processMnabEmails() would do.
function runImportPass_(opts) {
  var dryRun = opts.forceDryRun || isDryRun_();

  var lock = LockService.getScriptLock();
  var haveLock = lock.tryLock(LOCK_WAIT_MS);
  if (!haveLock) {
    Logger.log('Another import run appears to already be in progress — skipping this run rather than risk racing it (which could write duplicate rows). It will simply run again on the next trigger.');
    return;
  }

  importedThisRun_ = [];
  var grabThreads = []; // mnab/grab receipts — handled after the bank threads, see GRAB RECEIPTS
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TRANSACTIONS_SHEET_NAME);
    if (!sheet) throw new Error('Could not find a sheet tab named "' + TRANSACTIONS_SHEET_NAME + '".');
    var headerMap = ensureImportColumns_(sheet); // {headerName: 1-based column index}; provisions Pending/Email Message ID if missing
    var importedMessageIds = loadImportedMessageIds_(sheet, headerMap);

    var threads = GmailApp.search(buildPollQuery_(opts.includeAlreadyImported), 0, MAX_THREADS_PER_RUN);
    Logger.log((dryRun ? '[DRY RUN] ' : '') + 'Found ' + threads.length +
        (opts.includeAlreadyImported ? ' mnab thread(s) (including already-imported — backlog preview).' : ' unprocessed mnab thread(s).'));

    threads.forEach(function (thread) {
      var labelNames = thread.getLabels().map(function (l) { return l.getName(); });
      var alreadyImported = labelNames.indexOf(PROCESSED_LABEL) !== -1;
      var labelKey = labelNames.filter(function (n) {
        return n.indexOf('mnab/') === 0 && n !== PROCESSED_LABEL && n !== GRAB_UNMATCHED_LABEL;
      })[0];

      // Grab receipts never create rows — they enrich the bank's charge row.
      // Collected here and processed after every bank thread in this run,
      // so a charge and its receipt arriving together still match.
      if (labelKey === GRAB_RECEIPT_LABEL) {
        grabThreads.push(thread);
        return;
      }

      if (!labelKey || !LABEL_PARSERS[labelKey]) {
        Logger.log('Thread "' + thread.getFirstMessageSubject() + '" has no recognized mnab/* child label — skipping.');
        return;
      }

      thread.getMessages().forEach(function (message) {
        var messageId = message.getId();

        // Message-level duplicate guard — see "TWO LAYERS OF DUPLICATE
        // PROTECTION" up top. Independent of the thread's mnab/imported
        // label: catches the case where a past run wrote this exact
        // message's row but never got to label the thread.
        if (importedMessageIds[messageId]) {
          Logger.log((dryRun ? '[DRY RUN] ' : '') + 'Message "' + message.getSubject() + '" (id ' + messageId + ') already has a row in ' + TRANSACTIONS_SHEET_NAME + ' — skipping, not writing a duplicate.');
          return;
        }

        try {
          var wrote = handleMessage_(message, labelKey, headerMap, dryRun);
          if (wrote) importedMessageIds[messageId] = true; // guard against this same ID recurring later in this same run
        } catch (err) {
          Logger.log('ERROR processing message "' + message.getSubject() + '": ' + err);
          writeRow_(manualReviewRow_(message, labelKey, 'Unhandled error while processing: ' + err), headerMap, dryRun);
          importedMessageIds[messageId] = true;
        }
      });

      if (dryRun) {
        if (alreadyImported) {
          Logger.log('[DRY RUN] Thread "' + thread.getFirstMessageSubject() + '" is already labeled ' + PROCESSED_LABEL + ' — tested it anyway, nothing to re-label.');
        } else {
          Logger.log('[DRY RUN] Would label thread "' + thread.getFirstMessageSubject() + '" as ' + PROCESSED_LABEL + ' now (not doing it, so you can re-run this safely).');
        }
      } else {
        var label = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
        thread.addLabel(label);
      }
    });

    // Kept apart from the bank import above: a failure here is logged and
    // never stops new bank transactions from landing.
    try {
      processGrabReceiptThreads_(grabThreads, sheet, headerMap, dryRun, new Date());
    } catch (err) {
      Logger.log('ERROR processing Grab receipts (bank rows are unaffected): ' + err);
    }
    try {
      flagGrabChargesWithoutReceipt_(sheet, headerMap, dryRun, new Date());
    } catch (err) {
      Logger.log('ERROR in the Grab no-receipt sweep: ' + err);
    }
  } finally {
    lock.releaseLock();
    // In `finally` so rows written before an error mid-run still get their
    // notification. notifyNewTransactions_ never throws, so it can't mask
    // that error either.
    var written = importedThisRun_ || [];
    importedThisRun_ = null;
    if (!dryRun && written.length) notifyNewTransactions_(written);
  }
}

function handleMessage_(message, labelKey, headerMap, dryRun) {
  var subject = message.getSubject();
  var body = message.getBody(); // Gmail hands back already-decoded HTML, no quoted-printable handling needed
  var messageId = message.getId();

  var failure = classifyFailure_(subject, body);
  // messageDate is a fallback for templates with no explicit transaction
  // date in the body at all (e.g. parseJagoPocketReceived_ below) — every
  // existing parser ignores this extra third argument, so this is a
  // backward-compatible addition, not a signature change for them.
  var parsed = LABEL_PARSERS[labelKey](subject, body, message.getDate());

  if (!parsed) {
    parsed = tryAiFallback_(labelKey, subject, body);
  }

  if (!parsed) {
    return writeRow_(manualReviewRow_(message, labelKey, 'Deterministic and AI parsing both failed to extract required fields.'), headerMap, dryRun);
  }

  if (failure.isFailed) {
    return writeRow_({
      payee: '[FAILED TRANSFER] ' + (parsed.payee || 'unknown recipient'),
      type: parsed.type || 'Expense',
      sof: parsed.sof,
      date: parsed.date,
      amount: 0,
      notes: 'Attempted ' + formatIdr_(parsed.amount) + ' — ' + failure.reason +
          (parsed.notes ? '. ' + parsed.notes : '') + '. (Auto-imported — no money movement)',
      messageId: messageId
    }, headerMap, dryRun);
  }

  if (parsed.transferToSof) {
    return writeTransferPair_(parsed, messageId, headerMap, dryRun);
  }

  // Single-leg Transfer (e.g. parseOcbcIncomingTransfer_ for money moved in
  // from the user's own account at another bank): one row, Transfer = TRUE,
  // no Payment ID since there's no paired leg written here.
  if (parsed.transfer && !dryRun) ensureTransferColumns_(headerMap);

  return writeRow_({
    payee: parsed.payee,
    type: parsed.type || 'Expense',
    sof: parsed.sof,
    date: parsed.date,
    amount: parsed.amount,
    notes: (parsed.notes || '') + ' (Auto-imported)',
    messageId: messageId,
    transfer: !!parsed.transfer
  }, headerMap, dryRun);
}

// Self-transfer between two of the user's own accounts (so far only
// parseMandiriCardPayment_ asks for this): writes the two legs the
// dashboard's "Add Payment" writes — Expense on `parsed.sof`, Income on
// `parsed.transferToSof`, both Transfer = TRUE, both sharing one Payment
// ID and this email's Message ID. Each leg still goes through writeRow_
// on its own, so each lands Pending and each gets its own manual-match
// check (a payment already logged by hand matches leg-for-leg).
//
// The legs are only ever written together: the Message ID guard in
// runImportPass_ is per message, so a run that died between the two
// appends would never come back for the second one. If the first append
// throws, nothing was written; the second can only fail on a sheet error
// that would have failed the first too.
function writeTransferPair_(parsed, messageId, headerMap, dryRun) {
  if (!dryRun) ensureTransferColumns_(headerMap);
  var paymentId = 'pay_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); // same shape as generatePaymentId() in api/_lib/reconcile.js
  var notes = (parsed.notes || '') + ' (Auto-imported)';

  writeRow_({
    payee: 'Payment to ' + parsed.transferToSof,
    type: 'Expense',
    sof: parsed.sof,
    date: parsed.date,
    amount: parsed.amount,
    notes: notes,
    messageId: messageId,
    transfer: true,
    paymentId: paymentId
  }, headerMap, dryRun);

  return writeRow_({
    payee: 'Payment from ' + parsed.sof,
    type: 'Income',
    sof: parsed.transferToSof,
    date: parsed.date,
    amount: parsed.amount,
    notes: notes,
    messageId: messageId,
    transfer: true,
    paymentId: paymentId
  }, headerMap, dryRun);
}

// 'Transfer' and 'Payment ID' are normally already on `transactions` (the
// dashboard's Add Payment self-provisions them), but provision them here
// too, same append-at-the-end pattern as ensureImportColumns_, rather than
// silently dropping the flag. Kept out of IMPORT_COLUMNS on purpose so a
// run with no transfers in it never touches the header row.
var TRANSFER_COLUMNS = ['Transfer', 'Payment ID'];

function ensureTransferColumns_(headerMap) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TRANSACTIONS_SHEET_NAME);
  TRANSFER_COLUMNS.forEach(function (name) {
    if (!headerMap[name]) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue(name);
      headerMap[name] = newCol;
      Logger.log('Auto-provisioned a new "' + name + '" column on transactions at position ' + newCol + '.');
    }
  });
}

function manualReviewRow_(message, labelKey, reasonNote) {
  return {
    payee: '[NEEDS REVIEW] ' + message.getSubject(),
    type: 'Expense',
    sof: '', // left blank on purpose — pick the right account by hand
    date: message.getDate(),
    amount: 0,
    notes: reasonNote + ' Label: ' + labelKey + '. Open the original email in Gmail and fill this row in by hand, or improve the parser for this template.',
    messageId: message.getId()
  };
}

// ── MATCHING AGAINST MANUAL ENTRIES (Issue #51) ────────────────────────────
// See "THIRD KIND OF DUPLICATE" up top for the full rationale. Two days
// either side of the imported transaction's own date — matches the range
// the issue itself specified.
var MATCH_WINDOW_DAYS = 2;

function generateMatchId_() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Looks for exactly one existing MANUAL row (Pending not TRUE, and not
// already carrying a Match ID of its own — see below) in `transactions`
// with the same SOF, the same Amount, the same Income/Expense type, and a
// Date within MATCH_WINDOW_DAYS days of `date`. Returns that row's 1-based
// sheet row number, or null if there's no match or more than one candidate
// (ambiguous matches are deliberately left alone — see the file-header
// note). `type` is optional for callers that don't have it handy; when the
// 'Income/Expense' column can't be found, matching just skips the type
// check rather than refusing to match at all.
//
// A manual row that already has a Match ID (Proposed or otherwise) is
// excluded from candidacy — it's already tied up in a pairing from an
// earlier import, and linking a THIRD row to it would make "the other
// side of this match" ambiguous for the dashboard's confirm/unmatch
// actions, which assume exactly two rows share a Match ID.
function findManualMatch_(sheet, headerMap, sof, amount, date, type) {
  if (!sof || !amount || !(date instanceof Date) || isNaN(date.getTime())) return null;

  var sofCol = headerMap['SOF'];
  var amountCol = headerMap['Amount'];
  var dateCol = headerMap['Date'];
  var pendingCol = headerMap['Pending'];
  if (!sofCol || !amountCol || !dateCol || !pendingCol) return null; // schema surprise — don't guess, skip matching

  var typeCol = headerMap['Income/Expense']; // optional — matching still works without it, just less precise
  var matchIdCol = headerMap['Match ID']; // optional — see the exclusion note above

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null; // no data rows yet
  var numRows = lastRow - 1;

  var sofValues = sheet.getRange(2, sofCol, numRows, 1).getValues();
  var amountValues = sheet.getRange(2, amountCol, numRows, 1).getValues();
  var dateValues = sheet.getRange(2, dateCol, numRows, 1).getValues();
  var pendingValues = sheet.getRange(2, pendingCol, numRows, 1).getValues();
  var typeValues = typeCol ? sheet.getRange(2, typeCol, numRows, 1).getValues() : null;
  var matchIdValues = matchIdCol ? sheet.getRange(2, matchIdCol, numRows, 1).getValues() : null;

  var targetTime = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  var dayMs = 24 * 60 * 60 * 1000;
  var matches = [];

  for (var i = 0; i < numRows; i++) {
    if (pendingValues[i][0] === true) continue; // itself an unreviewed import, not a manual entry
    if (matchIdValues && matchIdValues[i][0]) continue; // already tied up in another pairing
    if (sofValues[i][0] !== sof) continue;
    if (Number(amountValues[i][0]) !== Number(amount)) continue;
    if (typeValues && (typeValues[i][0] || 'Expense') !== (type || 'Expense')) continue;

    var rDate = dateValues[i][0];
    if (!(rDate instanceof Date) || isNaN(rDate.getTime())) continue;
    var rTime = new Date(rDate.getFullYear(), rDate.getMonth(), rDate.getDate()).getTime();
    if (Math.abs(rTime - targetTime) > MATCH_WINDOW_DAYS * dayMs) continue;

    matches.push(2 + i); // 1-based sheet row number
  }

  if (matches.length === 1) return matches[0];
  return null; // zero or ambiguous (more than one candidate) — leave alone either way
}

// ── SHEET WRITE ─────────────────────────────────────────────────────────

// headerMap and dryRun are both required now (runImportPass_() resolves
// dryRun once per run — respecting forceDryRun for previewMnabBacklog() —
// and threads it through) rather than each call re-deriving it from a
// module-level flag. That's what guarantees previewMnabBacklog() can never
// write for real even if the DRY_RUN script property happens to be
// `false` at the time. Returns true once the row has been written-or-
// logged, so callers can mark that message ID as handled.
function writeRow_(row, headerMap, dryRun) {
  var amount = Number(row.amount) || 0;
  var isExpense = (row.type || 'Expense') === 'Expense';
  var monthGuess = billingMonthGuess_(row.date);

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TRANSACTIONS_SHEET_NAME);
  if (!sheet) throw new Error('Could not find a sheet tab named "' + TRANSACTIONS_SHEET_NAME + '".');

  // Issue #51: this transaction is still always written normally, exactly
  // like every other import — see "THIRD KIND OF DUPLICATE" up top. If it
  // looks like the same real-world transaction as one the user already
  // entered by hand, both rows just get flagged with a shared Match ID for
  // the dashboard to show and let the user confirm or decline.
  var matchedRow = findManualMatch_(sheet, headerMap, row.sof, amount, row.date, row.type);
  var matchId = matchedRow ? generateMatchId_() : '';
  if (matchedRow) {
    Logger.log((dryRun ? '[DRY RUN] ' : '') + 'Proposing a match for "' + row.payee + '" (' +
        formatIdr_(amount) + ' ' + (row.type || 'Expense') + ', ' + row.sof +
        ') against the existing manual entry at transactions row ' + matchedRow +
        ' within ' + MATCH_WINDOW_DAYS + ' day(s) — both rows will be flagged Match ID ' + matchId +
        ' / Match Status "Proposed" for review in the dashboard; neither is written/deleted automatically.');
  }

  var values = {
    'Payee': row.payee,
    'Income/Expense': row.type || 'Expense',
    'SOF': row.sof || '',
    'Date': row.date,
    'Month': monthGuess,
    'Cleared': false,
    'Amount': amount,
    'Expense': isExpense ? amount : 0,
    'Income': isExpense ? 0 : amount,
    'Total': (isExpense ? amount : 0) - (isExpense ? 0 : amount),
    'Notes': row.notes || '',
    'Pending': true,
    'Reconciled': false,
    'Email Message ID': row.messageId || '',
    'Match ID': matchId,
    'Match Status': matchedRow ? 'Proposed' : ''
  };
  // Only set on transfer legs (writeTransferPair_) — every other import
  // leaves these cells blank exactly as before, rather than writing FALSE.
  if (row.transfer) {
    values['Transfer'] = true;
    values['Payment ID'] = row.paymentId || '';
  }

  if (dryRun) {
    Logger.log('[DRY RUN] Would append row: ' + JSON.stringify(values));
    return true;
  }

  var newRowIndex = sheet.getLastRow() + 1;
  Object.keys(values).forEach(function (header) {
    var col = headerMap[header];
    // A header this script doesn't recognize (e.g. 'Cleared'/'Reconciled'
    // spelled differently than expected) is silently skipped rather than
    // erroring the whole row — check the sheet afterward if a column looks
    // empty that shouldn't be.
    if (col) sheet.getRange(newRowIndex, col).setValue(values[header]);
  });

  // Stamp the same Match ID/Status onto the existing manual row so the two
  // rows are linked from both directions — the dashboard's confirm/unmatch
  // actions look this up by Match ID, not by row position.
  if (matchedRow) {
    if (headerMap['Match ID']) sheet.getRange(matchedRow, headerMap['Match ID']).setValue(matchId);
    if (headerMap['Match Status']) sheet.getRange(matchedRow, headerMap['Match Status']).setValue('Proposed');
  }

  // Queue it for this run's push notification. A self-transfer is written
  // as two legs (writeTransferPair_); only the Expense leg is queued so one
  // card payment is one line in the notification, not two. A single-leg
  // transfer (no Payment ID, e.g. an incoming BI-Fast) is still queued.
  if (importedThisRun_ && !(row.transfer && row.paymentId && row.type === 'Income')) {
    importedThisRun_.push({
      payee: row.payee,
      type: row.type || 'Expense',
      sof: row.sof || '',
      amount: amount,
      transfer: Boolean(row.transfer)
    });
  }

  return true;
}

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────────────
// One POST per import run, after the lock is released, listing every row
// the run wrote. api/push.js (action=notify) turns that into one
// notification ("−Rp150.000 · GoFood" for one row, "3 new transactions"
// for several) and sends it to every subscribed device. The Web Push
// signing and encryption need crypto Apps Script doesn't have, which is
// why the sending happens on Vercel rather than here.
//
// Best effort by design: a missing property, a network error or a non-200
// is logged and ignored. The rows are already in the sheet, and the next
// run must not be blocked or retried because a notification failed.
function notifyNewTransactions_(items) {
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('PUSH_NOTIFY_URL');
    var secret = props.getProperty('PUSH_NOTIFY_SECRET');
    if (!url || !secret) {
      Logger.log('Push notifications not configured (PUSH_NOTIFY_URL / PUSH_NOTIFY_SECRET) — skipping notification for ' + items.length + ' new row(s).');
      return;
    }

    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secret },
      payload: JSON.stringify({ action: 'notify', items: items }),
      muteHttpExceptions: true
    });
    Logger.log('Push notify for ' + items.length + ' new row(s): HTTP ' + response.getResponseCode() + ' ' + response.getContentText().substring(0, 300));
  } catch (err) {
    Logger.log('Push notify failed (rows are still imported): ' + err);
  }
}

// Run by hand from the function dropdown to check the push setup end to
// end without waiting for a bank email. Sends one made-up transaction.
function testPushNotification() {
  notifyNewTransactions_([{ payee: 'Test from EmailImport.gs', type: 'Expense', sof: 'test', amount: 12345, transfer: false }]);
}

// Reads the header row into a {headerName: 1-based col index} map, and
// auto-provisions any of these columns that aren't there yet (appended
// after the last existing column) — mirrors how Reconcile.gs originally
// added 'Reconciled'/'Reconciled Date' the same way. 'Pending' was the
// original one; 'Email Message ID' was added later for the message-level
// duplicate guard (see "TWO LAYERS OF DUPLICATE PROTECTION" up top);
// 'Match ID'/'Match Status' were added for the imported-vs-manual matching
// feature (see "THIRD KIND OF DUPLICATE" up top).
var IMPORT_COLUMNS = ['Pending', 'Email Message ID', 'Match ID', 'Match Status'];

function ensureImportColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i + 1; });

  IMPORT_COLUMNS.forEach(function (name) {
    if (!map[name]) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue(name);
      map[name] = newCol;
      Logger.log('Auto-provisioned a new "' + name + '" column on transactions at position ' + newCol + '.');
    }
  });
  return map;
}

// Reads every existing value already in the 'Email Message ID' column into
// a {messageId: true} lookup, so runImportPass_() can skip any message it's
// already written a row for — see "TWO LAYERS OF DUPLICATE PROTECTION" up
// top. Cheap: one column, one read, once per run.
function loadImportedMessageIds_(sheet, headerMap) {
  var ids = {};
  var col = headerMap['Email Message ID'];
  var lastRow = sheet.getLastRow();
  if (!col || lastRow < 2) return ids; // no data rows yet (row 1 is the header)

  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  values.forEach(function (r) {
    var id = r[0];
    if (id) ids[String(id).trim()] = true;
  });
  return ids;
}

// Day 1–12 → same month; day 13+ → next month. Day-overflow-safe (setDate(1)
// before incrementing month) — see the known "billing-month overflow bug"
// in MNAB-project-state.md. Always a starting guess, editable like every
// other billing-month guess in this project.
function billingMonthGuess_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (d.getDate() > 12) {
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
  }
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMMM yyyy');
}

function formatIdr_(amount) {
  return 'Rp ' + (Number(amount) || 0).toLocaleString('id-ID');
}

// Indonesian-locale formatted amount: "." is the thousands separator, ","
// is the decimal separator — e.g. "Rp 43.000,00" means 43,000.00, NOT
// 4,300,000. Take only the whole-rupiah part (before the comma) and strip
// everything that isn't a digit from that. IDR has no meaningful sub-unit
// in practice, so the decimal part is discarded rather than parsed.
function parseIndonesianAmount_(str) {
  var wholePart = String(str).split(',')[0];
  return Number(wholePart.replace(/\D/g, '')) || 0;
}

// Western-style formatted amount: "," is the thousands separator, "." is
// the (optional) decimal separator — e.g. OCBC's "IDR 15,000,000" or
// "IDR99,000.00". Strip commas, then drop anything from a decimal point on.
function parseWesternAmount_(str) {
  var wholePart = String(str).replace(/,/g, '').split('.')[0];
  return Number(wholePart.replace(/\D/g, '')) || 0;
}

// ── SUCCESS / FAILURE CLASSIFICATION (shared, runs before field extraction) ──
// Banks reuse the same template for success and failure notifications —
// confirmed with a real OCBC sample that had a literal commented-out
// "...was successfully done..." span, with "Gagal"/"Tidak Berhasil" swapped
// into the subject/header instead. This MUST run before any bank-specific
// field extraction.

function classifyFailure_(subject, bodyHtml) {
  var haystack = (subject + ' ' + bodyHtml).toLowerCase();
  for (var i = 0; i < FAILURE_KEYWORDS.length; i++) {
    if (haystack.indexOf(FAILURE_KEYWORDS[i]) !== -1) {
      return { isFailed: true, reason: 'bank marked this "' + FAILURE_KEYWORDS[i] + '"' };
    }
  }
  return { isFailed: false, reason: '' };
}

// ── SHARED HELPERS ──────────────────────────────────────────────────────

function htmlToText_(html) {
  return html
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\n{2,}/g, '\n')
      .trim();
}

// Handles "27 Agu 2026" and "29 Jul 2026 07:08:13 WIB" style strings, and
// (used by the Jago parser below) full English month names like
// "27 July 2026 12:48 WIB" or "23 August 2026, 18:20 WIB" — the regex only
// captures day/month/year, so trailing time text (with or without a comma
// before it) doesn't matter.
function parseIndonesianDate_(str) {
  var m = String(str).match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  var day = parseInt(m[1], 10);
  var monthKey = m[2].toLowerCase().substring(0, 3);
  var month = INDONESIAN_MONTHS[monthKey];
  var year = parseInt(m[3], 10);
  if (month === undefined) return null;
  return new Date(year, month, day);
}

// Handles "31/07/26" (DD/MM/YY or DD/MM/YYYY)
function parseSlashDate_(str) {
  var m = String(str).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  var day = parseInt(m[1], 10);
  var month = parseInt(m[2], 10) - 1;
  var year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return new Date(year, month, day);
}

// ── mnab/mandiri PARSER ─────────────────────────────────────────────────
// Livin' by Mandiri sends more than one template from the same sender, so —
// like parseOcbcEmail_ below — this dispatches on the subject line first.
// Validated against a real "Pembayaran Berhasil!" (QRIS merchant payment,
// parseMandiriPayment_), a real "Top-up e-money Berhasil" (e-money card
// top-up, parseMandiriTopUp_) and real "Pembayaran Berhasil" credit card
// bill payments (parseMandiriCardPayment_). The QRIS payment template stays
// the DEFAULT branch, so every Mandiri email that isn't recognized here
// behaves exactly as it did before this dispatcher existed.
//
// The card-payment template can't be told apart by subject: it's
// "Pembayaran Berhasil", the QRIS one is "Pembayaran Berhasil!" — one "!"
// apart, too fragile to dispatch on. So that branch checks the BODY
// instead: a "Penyedia Jasa" (service provider) value of "Kartu Kredit
// ..." only ever appears on a card bill payment. Before this branch
// existed these emails fell through to parseMandiriPayment_, failed (no
// "Penerima" label), and went to the AI fallback — which booked them as a
// plain Expense, i.e. as spending, not as a transfer.

function parseMandiriEmail_(subject, bodyHtml) {
  if (/top[-\s]?up/i.test(subject)) {
    return parseMandiriTopUp_(bodyHtml);
  }
  if (isMandiriCardPayment_(bodyHtml)) {
    return parseMandiriCardPayment_(bodyHtml);
  }
  return parseMandiriPayment_(bodyHtml);
}

// Shared label/value extractor for Livin's templates. Each label in these
// templates sits alone on its own line (one per <td>/<p>), so the boundary
// check requires a LATER label to also be alone on its own line — not just
// present anywhere in the captured text. Without that anchor, a merchant
// name containing a label word (e.g. "24 JAM" containing "Jam", the
// time-field label) would falsely truncate the capture right there. Caught
// by testing against a real "24 JAM ..." laundromat payee.
//
// `labels` must list every label the template can show, IN THE ORDER THEY
// APPEAR (same contract as extractOcbcEnglishFields_ below).
//
// Both the label anchor and the boundary tolerate leading/trailing spaces
// and tabs on the line — htmlToText_ leaves the source HTML's own
// indentation in place, and the top-up template's labels come through
// padded (" Penyedia Jasa ") where the payment template's don't. This is a
// strict superset of what the payment parser matched before, so its
// validated behaviour is unchanged.
//
// Deliberately keeps internal newlines rather than collapsing to spaces:
// several of these values are multi-line ("Penerima" is merchant name then
// city; "Rekening Sumber" is account name then masked number) and callers
// need the \n still there to split on. The LAST label in `labels` has no
// later label to stop at, so it captures through the end of the email —
// footer included; callers pull what they need out of it with their own
// narrower regex rather than trusting the whole block.
function mandiriValueAfter_(text, labels, label) {
  var idx = labels.indexOf(label);
  var next = labels.slice(idx + 1).map(function (l) { return l.replace(/[.]/g, '\\.'); });
  var boundary = next.length ? '(?:' + next.join('|') + ')' : '$';
  var re = new RegExp(
      '(?:^|\\n)[ \\t]*' + label.replace(/[.]/g, '\\.') + '\\s*\\n([\\s\\S]*?)' +
      '(?:\\n[ \\t]*(?:' + boundary + ')[ \\t]*(?:\\n|$)|$)',
      'i'
  );
  var m = text.match(re);
  return m ? m[1].trim() : null;
}

// "Pembayaran Berhasil!" — QRIS / merchant payment.
var MANDIRI_PAYMENT_LABELS = ['Penerima', 'Tanggal', 'Jam', 'Nominal Transaksi', 'No. Referensi',
  'No. Ref. QRIS', 'Merchant PAN', 'Customer PAN', 'Pengakuisisi', 'Terminal ID', 'Sumber Dana'];

function parseMandiriPayment_(bodyHtml) {
  var text = htmlToText_(bodyHtml);

  function valueAfter(label) {
    return mandiriValueAfter_(text, MANDIRI_PAYMENT_LABELS, label);
  }

  var recipient = valueAfter('Penerima');
  var dateStr = valueAfter('Tanggal');
  var nominal = valueAfter('Nominal Transaksi');
  var refNo = valueAfter('No. Referensi');
  var sofRaw = valueAfter('Sumber Dana');

  if (!recipient || !dateStr || !nominal || !sofRaw) return null; // → AI fallback

  var last4 = (sofRaw.match(/\*{2,4}(\d{4})/) || [])[1];
  var sof = MANDIRI_SOF_MAP[last4];
  if (!sof) return null; // unrecognized card/account — don't guess, fall back to AI / manual review

  return {
    payee: recipient.split('\n')[0].trim(),
    type: 'Expense',
    amount: parseIndonesianAmount_(nominal), // Mandiri uses "43.000,00" (dot=thousands, comma=decimal)
    date: parseIndonesianDate_(dateStr),
    sof: sof,
    notes: "QRIS via Livin' by Mandiri — Ref " + refNo
  };
}

// "Top-up e-money Berhasil" — topping up a prepaid e-money card from a
// Mandiri account. Different label set from the payment template above
// ("Penyedia Jasa"/"Nominal Top-up"/"Nomor Referensi"/"Rekening Sumber"
// rather than "Penerima"/"Nominal Transaksi"/"No. Referensi"/"Sumber
// Dana"), which is why it needs its own parser rather than extra labels on
// that one. Validated against a real e-money top-up sample.
//
// Two masked numbers appear in this template and they mean opposite things:
// "Penyedia Jasa" shows the e-money CARD being topped up (the destination —
// deliberately NOT looked up in MANDIRI_SOF_MAP, it's not a funding
// account), while "Rekening Sumber" shows the Mandiri account the money
// actually left, which is the one that resolves to the SOF. Don't swap them.
//
// Booked as a plain Expense on the source account, matching how the Jago
// e-wallet top-up template is handled — the e-money card isn't one of the
// user's tracked accounts, so there's no second leg to write. (Contrast
// parseMandiriCardPayment_ below, where both sides ARE tracked accounts
// and the payment is written as a Transfer pair.)
var MANDIRI_TOPUP_LABELS = ['Penyedia Jasa', 'Tanggal', 'Jam', 'Nominal Top-up',
  'Nomor Referensi', 'Rekening Sumber'];

function parseMandiriTopUp_(bodyHtml) {
  var text = htmlToText_(bodyHtml);

  function valueAfter(label) {
    return mandiriValueAfter_(text, MANDIRI_TOPUP_LABELS, label);
  }

  var providerRaw = valueAfter('Penyedia Jasa');
  var dateStr = valueAfter('Tanggal');
  var nominal = valueAfter('Nominal Top-up');
  var refNo = valueAfter('Nomor Referensi');
  var sofRaw = valueAfter('Rekening Sumber');

  if (!providerRaw || !dateStr || !nominal || !sofRaw) return null; // → AI fallback

  // "Rekening Sumber" is the last label in this template, so its captured
  // value runs through the email footer — take only the first masked number
  // in it, which is the source account's last 4.
  var last4 = (sofRaw.match(/\*{2,4}(\d{4})/) || [])[1];
  var sof = MANDIRI_SOF_MAP[last4];
  if (!sof) return null; // unrecognized source account — don't guess, fall back to AI / manual review

  // "Penyedia Jasa" is two lines: the provider ("e-money") then the masked
  // card number being topped up ("****7267").
  var provider = providerRaw.split('\n')[0].trim();
  var targetMask = (providerRaw.match(/\*{2,4}\d{4}/) || [])[0];

  return {
    payee: provider + ' top up' + (targetMask ? ' (' + targetMask + ')' : ''),
    type: 'Expense',
    amount: parseIndonesianAmount_(nominal), // "Rp 100.000,00" — dot=thousands, comma=decimal
    date: parseIndonesianDate_(dateStr),
    sof: sof,
    notes: "Top-up " + provider + (targetMask ? ' ' + targetMask : '') +
        " via Livin' by Mandiri — Ref " + (refNo || 'unknown')
  };
}

// "Pembayaran Berhasil" — paying a Mandiri credit card bill from a Mandiri
// account in Livin'. Validated against three real samples (cards ****2166,
// ****2069, ****2892, all paid from ****0875). Body shape:
//
//   Penyedia Jasa      Kartu Kredit Mandiri / ****2166   ← card being PAID
//   Tanggal            27 Sep 2026
//   Jam                22:23:33 WIB
//   Nominal Pembayaran Rp 4.626.726,00
//   Biaya Transaksi    Rp 0,00
//   Total Transaksi    Rp 4.626.726,00
//   No. Referensi      2609271122061878958
//   Rekening Sumber    MAULANNA MARYUNANI / ****0875     ← account PAYING
//
// Same two-masked-numbers trap as the top-up template: "Penyedia Jasa" is
// the destination, "Rekening Sumber" is the source. Here BOTH resolve
// through MANDIRI_SOF_MAP, because both are tracked accounts.
//
// Written as a self-transfer, the same shape the dashboard's "Add Payment"
// (appendCardPaymentRows in api/_lib/reconcile.js) and Payments.gs use: an
// Expense leg on the source account and an Income leg on the card, both
// with Transfer = TRUE and a shared Payment ID, same payee wording. That
// keeps it out of spend/income totals, and lets the dashboard's
// undo-payment action remove both legs together. handleMessage_ does the
// two-leg write; this parser just returns `transferToSof` alongside the
// usual fields to ask for it.
//
// Both legs use "Nominal Pembayaran" (what reached the card). Every sample
// so far had Biaya Transaksi Rp 0; if a non-zero fee ever shows up it's
// noted on the row rather than booked, so the two legs stay equal.
var MANDIRI_CARD_PAYMENT_LABELS = ['Penyedia Jasa', 'Tanggal', 'Jam', 'Nominal Pembayaran',
  'Biaya Transaksi', 'Total Transaksi', 'No. Referensi', 'Rekening Sumber'];

function isMandiriCardPayment_(bodyHtml) {
  var provider = mandiriValueAfter_(htmlToText_(bodyHtml), MANDIRI_CARD_PAYMENT_LABELS, 'Penyedia Jasa');
  return !!provider && /^kartu kredit/i.test(provider.split('\n')[0].trim());
}

function parseMandiriCardPayment_(bodyHtml) {
  var text = htmlToText_(bodyHtml);

  function valueAfter(label) {
    return mandiriValueAfter_(text, MANDIRI_CARD_PAYMENT_LABELS, label);
  }

  var providerRaw = valueAfter('Penyedia Jasa');
  var dateStr = valueAfter('Tanggal');
  var nominal = valueAfter('Nominal Pembayaran');
  var fee = valueAfter('Biaya Transaksi');
  var refNo = valueAfter('No. Referensi');
  var sofRaw = valueAfter('Rekening Sumber');

  if (!providerRaw || !dateStr || !nominal || !sofRaw) return null; // → AI fallback

  var cardLast4 = (providerRaw.match(/\*{2,4}(\d{4})/) || [])[1];
  var sourceLast4 = (sofRaw.match(/\*{2,4}(\d{4})/) || [])[1]; // last label — runs into the footer, first mask only
  var cardSof = MANDIRI_SOF_MAP[cardLast4];
  var sourceSof = MANDIRI_SOF_MAP[sourceLast4];
  if (!cardSof || !sourceSof) return null; // unrecognized card/account — don't guess

  var date = parseIndonesianDate_(dateStr);
  var amount = parseIndonesianAmount_(nominal);
  if (!date || !amount) return null;

  var feeAmount = fee ? parseIndonesianAmount_(fee) : 0;
  var notes = "Card payment via Livin' by Mandiri — Ref " + (refNo || 'unknown');
  if (feeAmount) notes += '. Bank fee ' + formatIdr_(feeAmount) + ' not booked — add it by hand';

  return {
    payee: 'Payment to ' + cardSof, // source leg; handleMessage_ writes the card leg's payee
    type: 'Expense',
    amount: amount,
    date: date,
    sof: sourceSof,
    transferToSof: cardSof,
    notes: notes
  };
}

// ── mnab/ocbc PARSER ─────────────────────────────────────────────────────
// OCBC sends multiple structurally unrelated templates from the same
// sender — dispatches on subject line first. Validated against real
// "Transfer Dana ... dengan BI Fast" (Indonesian-language transfer, incl. a
// real failure sample), "Credit Card Transaction Notification",
// "Successful Funds Transfer with BI Fast to <name>" / "...To Other Bank"
// (English-language transfer — a separate template from the Indonesian
// one above, not just a translation of it: different field labels, so it
// needs its own parser, parseOcbcTransferEn_() below), and "Successful
// Payment to <biller/e-wallet name>" (English-language bill payment,
// covers e-wallet top-ups like DANA as well as any other OCBC biller,
// parseOcbcBillPayment_() below) emails.

function parseOcbcEmail_(subject, bodyHtml) {
  if (/credit card transaction/i.test(subject)) {
    return parseOcbcCreditCard_(bodyHtml);
  }
  // Must come BEFORE the outgoing "transfer dana" branch below: the
  // incoming subject ("BI-Fast Transfer Dana Masuk") also contains
  // "Transfer Dana", and would otherwise go to parseOcbcTransfer_, fail
  // (no KE / JUMLAH TRANSFER labels) and drop to the AI fallback.
  if (/dana masuk/i.test(subject)) {
    return parseOcbcIncomingTransfer_(bodyHtml);
  }
  if (/transfer dana/i.test(subject)) {
    return parseOcbcTransfer_(bodyHtml);
  }
  if (/successful funds transfer/i.test(subject)) {
    return parseOcbcTransferEn_(bodyHtml);
  }
  if (/successful payment to/i.test(subject)) {
    return parseOcbcBillPayment_(bodyHtml);
  }
  return null; // unrecognized OCBC template → AI fallback
}

function parseOcbcCreditCard_(bodyHtml) {
  var text = htmlToText_(bodyHtml);

  var cardMatch = text.match(/-(\d{4})\b/);
  var last4 = cardMatch ? cardMatch[1] : null;
  var sof = last4 ? OCBC_SOF_MAP[last4] : null;
  if (!sof) return null; // unrecognized card → AI fallback

  // "31/07/26" on one line, "OMBE KOFIE-HO JAKART - IDR99,000.00" on the next
  var lineMatch = text.match(/(\d{2}\/\d{2}\/\d{2,4})\s*\n\s*([^\n]+?)\s*-\s*IDR\s*([\d,]+(?:\.\d{2})?)/i);
  if (!lineMatch) return null;

  return {
    payee: lineMatch[2].trim(),
    type: 'Expense',
    amount: parseWesternAmount_(lineMatch[3]),
    date: parseSlashDate_(lineMatch[1]),
    sof: sof,
    notes: 'OCBC credit card ending ' + last4
  };
}

function parseOcbcTransfer_(bodyHtml) {
  var text = htmlToText_(bodyHtml);

  var toMatch = text.match(/\bKE\s*\n([^\n]+)/i);
  var amountMatch = text.match(/JUMLAH TRANSFER\s*\n[^\d]*([\d,]+)/i);
  var refMatch = text.match(/No\.\s*Referensi\s*:?\s*(\d+)/i);
  var dateMatch = text.match(/TANGGAL TRANSAKSI:\s*\n?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  // The "DARI" (from) block shows a bank account number when this is the
  // cash account. If there's no account-number-looking sequence there, this
  // isn't confidently the cash account, so don't guess — fall back to AI.
  var fromBlockMatch = text.match(/\bDARI\b([\s\S]{0,200}?)\bKE\b/i);
  var fromAccountNumber = fromBlockMatch && fromBlockMatch[1].match(/\b\d{9,}\b/);

  if (!toMatch || !amountMatch || !dateMatch) return null;
  if (!fromAccountNumber) return null; // couldn't confirm cash-account SOF → AI fallback

  return {
    payee: toMatch[1].trim(),
    type: 'Expense',
    amount: parseWesternAmount_(amountMatch[1]),
    date: parseIndonesianDate_(dateMatch[1]),
    sof: 'ocbc',
    notes: 'OCBC BI Fast transfer — Ref ' + (refMatch ? refMatch[1] : 'unknown')
  };
}

// "BI-Fast Transfer Dana Masuk" — money received into the OCBC cash
// account from another bank via BI-Fast. Validated against two real
// samples (from BCA and from Superbank). Before this parser existed these
// went to tryAiFallback_, which always books an Expense and can't resolve
// the 'ocbc' cash account (OCBC_SOF_MAP only holds card last-4s), so they
// landed as an Expense with a blank SOF. Body is a two-column table, one
// "<label>" cell then a ": <value>" cell per row:
//
//   Bank Pengirim         : BANK CENTRAL ASIA
//   Nama Pengirim         : MAULANNA MARYUNANI
//   No Rekening Pengirim  : 5325146157
//   Nominal               : Rp 60.909.090,00     ← dot=thousands, comma=decimal
//   Bank Penerima         : OCBC
//   Nama Penerima         : MAULANNA MARYUNANI
//   No Rekening Penerima  : 400810038440
//   Tanggal Transaksi     : 23 Oktober 2026
//   Waktu Transaksi       : 15:33:47
//   Berita                : -
//
// Booked as Income on 'ocbc'. When the sender's name equals the
// recipient's (case-insensitive) it's the user moving their own money in
// from another bank, so the row is flagged Transfer = TRUE — the project's
// convention for incoming transfers from the user's own other banks. Only
// this one leg is written: the sending bank (BCA, Superbank, …) isn't
// resolved to an Accounts.Name here, so its Expense leg comes from that
// bank's own import or is added by hand.
// htmlToText_ leaves whitespace-only lines between the label cell and the
// ": value" cell, hence \s* (not a single \n) before the colon.
function ocbcTableValue_(text, label) {
  var re = new RegExp('(?:^|\\n)[ \\t]*' + label + '\\s*:[ \\t]*([^\\n]*)', 'i');
  var m = text.match(re);
  if (!m) return null;
  var v = m[1].trim();
  return (v && v !== '-') ? v : null;
}

function parseOcbcIncomingTransfer_(bodyHtml) {
  var text = htmlToText_(bodyHtml);

  var senderBank = ocbcTableValue_(text, 'Bank Pengirim');
  var senderName = ocbcTableValue_(text, 'Nama Pengirim');
  var senderAcct = ocbcTableValue_(text, 'No Rekening Pengirim');
  var nominal = ocbcTableValue_(text, 'Nominal');
  var recipientName = ocbcTableValue_(text, 'Nama Penerima');
  var recipientAcct = ocbcTableValue_(text, 'No Rekening Penerima');
  var dateStr = ocbcTableValue_(text, 'Tanggal Transaksi');
  var memo = ocbcTableValue_(text, 'Berita');

  if (!senderName || !nominal || !dateStr) return null; // → AI fallback
  // Same conservative check as the outgoing parsers: only assume the 'ocbc'
  // cash account when a real account number is shown as the recipient.
  if (!recipientAcct || !/\d{9,}/.test(recipientAcct)) return null;

  var date = parseIndonesianDate_(dateStr); // "23 Oktober 2026" — first 3 letters "okt"
  var amount = parseIndonesianAmount_(nominal);
  if (!date || !amount) return null;

  var isSelf = !!recipientName &&
      senderName.replace(/\s+/g, ' ').toUpperCase() === recipientName.replace(/\s+/g, ' ').toUpperCase();

  var notesParts = ['OCBC BI-Fast incoming transfer'];
  notesParts.push('from ' + (senderBank || 'unknown bank') + (senderAcct ? ' ' + senderAcct : ''));
  if (memo) notesParts.push('Berita: ' + memo);

  return {
    payee: isSelf ? 'Transfer from ' + (senderBank || 'other bank') : senderName,
    type: 'Income',
    amount: amount,
    date: date,
    sof: 'ocbc',
    transfer: isSelf,
    notes: notesParts.join(' — ')
  };
}

// ── mnab/ocbc PARSERS: English-language templates ───────────────────────
// OCBC also sends English-language versions of its transfer/payment
// notifications, structurally different from the Indonesian ones above
// (different labels, and both put AMOUNT before TO rather than after) —
// covers real "Successful Funds Transfer with BI Fast to <name>" /
// "Successful Funds Transfer To Other Bank" (parseOcbcTransferEn_) and
// "Successful Payment to <name>" / "Successful Bill Payment" (e-wallet
// top-ups like DANA, or any other OCBC biller — parseOcbcBillPayment_)
// samples. Both share the same FROM/TO/AMOUNT/DATE/Reference Number label
// shape, so they're built on one shared field extractor below rather than
// duplicating the boundary-regex logic twice.

// OCBC's own "was successfully done" status span is HTML-commented out in
// both real samples (a leftover from a template that also renders this
// visibly on some other status), but htmlToText_'s blind tag-stripping
// doesn't know that — and because that comment sits inside whichever table
// cell happens to precede it (REMARK's cell on the transfer template, TO's
// cell on the bill-payment template — it moves depending on the template's
// row layout), it would otherwise trail onto the end of that field's
// captured value. Stripped centrally here rather than patched per-field.
var OCBC_STATUS_COMMENT_NOISE_RE = /was successfully done\s*-->/i;

function cleanOcbcFieldValue_(value) {
  if (!value) return value;
  return value
      .replace(OCBC_STATUS_COMMENT_NOISE_RE, '')
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(Boolean)
      .join('\n')
      .trim();
}

// Generic label/value extractor for OCBC's English-language templates.
// Each field label sits alone on its own line (surrounded by arbitrary
// tabs/spaces left over from the source HTML's indentation) — same shape
// as parseMandiriEmail_'s valueAfter() closure above, pulled out as a
// standalone helper here since more than one OCBC template needs it.
// `labels` must list every label that can appear in the template, IN THE
// ORDER THEY APPEAR, so each field's boundary can be built from "any LATER
// label" rather than just the immediate next one — that's what lets an
// optional field (e.g. a transfer with no REMARK at all) simply be absent
// without breaking extraction of the fields before or after it.
//
// The LAST label in `labels` has no later label to stop at, so it captures
// everything through the end of the email — footer/signature/copyright
// included. Don't trust that final field's value as-is; both templates
// here put "Reference Number" last, so extractReferenceNumber_() below
// pulls it with its own small dedicated regex instead.
function extractOcbcEnglishFields_(text, labels) {
  var values = {};
  labels.forEach(function (label, idx) {
    var laterLabels = labels.slice(idx + 1).map(function (l) { return l.replace(/[.]/g, '\\.'); });
    var boundary = laterLabels.length ? '(?:' + laterLabels.join('|') + ')' : '$';
    var escapedLabel = label.replace(/[.]/g, '\\.');
    var re = new RegExp(
        '(?:^|\\n)[ \\t]*' + escapedLabel + '[ \\t]*:?[ \\t]*\\n([\\s\\S]*?)' +
        '(?:\\n[ \\t]*(?:' + boundary + ')[ \\t]*:?[ \\t]*(?:\\n|$)|$)',
        'i'
    );
    var m = text.match(re);
    values[label] = m ? cleanOcbcFieldValue_(m[1]) : null;
  });
  return values;
}

function firstNonBlankLine_(value) {
  if (!value) return null;
  var lines = value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  return lines.length ? lines[0] : null;
}

// Reference Number is always the last field in both English OCBC templates
// (nothing after it to bound its capture — see extractOcbcEnglishFields_
// above), so it's pulled directly with its own regex rather than trusted
// from that generic extraction.
function extractReferenceNumber_(text) {
  var m = text.match(/Reference Number:?\s*\n\s*([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

// "Successful Funds Transfer with BI Fast to <name>" / "Successful Funds
// Transfer To Other Bank" — English-language transfer to another bank
// account. Validated against a real BI-Fast sample. FROM always shows a
// real OCBC account number for this template (unlike the bill-payment
// template below), so this confirms it the same conservative way the
// Indonesian parseOcbcTransfer_() above does, before assuming the cash
// account — it's still just a presence check, not a lookup, since OCBC_SOF_MAP
// is keyed by card last-4 (credit card transactions only), not by the
// account number a transfer's FROM block shows.
var OCBC_TRANSFER_EN_LABELS = ['FROM', 'AMOUNT', 'TO', 'REMARK', 'TRANSFER DATE', 'INSTRUCTION DATE', 'Reference Number'];

function parseOcbcTransferEn_(bodyHtml) {
  var text = htmlToText_(bodyHtml);
  var f = extractOcbcEnglishFields_(text, OCBC_TRANSFER_EN_LABELS);

  var toName = firstNonBlankLine_(f['TO']);
  if (!toName || !f['AMOUNT'] || !f['TRANSFER DATE']) return null; // → AI fallback

  var fromAccountNumber = f['FROM'] && f['FROM'].match(/\b\d{9,}\b/);
  if (!fromAccountNumber) return null; // couldn't confirm cash-account SOF → AI fallback

  var date = parseIndonesianDate_(f['TRANSFER DATE']); // "04 Sep 2026 11:09:04 WIB" — same day/Mon/year shape parseIndonesianDate_ already handles
  if (!date) return null;

  // TO's 2nd+ lines are the destination bank + account number (e.g.
  // "BANK BCA" then "2181524652") — folded into notes for reference.
  var toLines = f['TO'].split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var toDetailLine = toLines.length > 1 ? toLines.slice(1).join(' ') : null;

  var notesParts = ['OCBC transfer to other bank'];
  if (toDetailLine) notesParts.push(toDetailLine);
  if (f['REMARK']) notesParts.push('Remark: ' + f['REMARK']);
  notesParts.push('Ref ' + (extractReferenceNumber_(text) || 'unknown'));

  return {
    payee: toName,
    type: 'Expense',
    amount: parseWesternAmount_(f['AMOUNT']), // "IDR 370,000"
    date: date,
    sof: 'ocbc',
    notes: notesParts.join(' — ')
  };
}

// "Successful Payment to <name>" ("Successful Bill Payment" template) —
// covers e-wallet top-ups (DANA, GoPay, OVO, etc. — shown as a phone
// number under TO) as well as any other OCBC bill-pay biller. Validated
// against a real DANA top-up sample. Confirmed with the user: unlike the
// transfer template above, FROM here does NOT show a real source account
// number — the real sample shows the payment's own reference number
// repeated in that slot instead (an OCBC template quirk, not a genuine
// account number), so there's nothing reliable to confirm there. Every
// bill/e-wallet payment resolves to the 'ocbc' cash account regardless —
// there's no per-biller card/account distinction to make for this
// template, the same way transfers always resolve to 'ocbc' too.
var OCBC_BILL_PAYMENT_EN_LABELS = ['FROM', 'PAYMENT AMOUNT', 'TO', 'PAYMENT DATE', 'INSTRUCTION DATE', 'Reference Number'];

function parseOcbcBillPayment_(bodyHtml) {
  var text = htmlToText_(bodyHtml);
  var f = extractOcbcEnglishFields_(text, OCBC_BILL_PAYMENT_EN_LABELS);

  var toName = firstNonBlankLine_(f['TO']);
  if (!toName || !f['PAYMENT AMOUNT'] || !f['PAYMENT DATE']) return null; // → AI fallback

  var date = parseIndonesianDate_(f['PAYMENT DATE']);
  if (!date) return null;

  // TO's 2nd line is the e-wallet phone number / biller customer ID, when
  // there is one — only kept if it actually looks like one (short run of
  // digits/dashes/spaces/bullets). This template's TO cell is also where
  // the "was successfully done" status-comment noise happens to land (see
  // OCBC_STATUS_COMMENT_NOISE_RE above), so this is a second guard against
  // any of that leaking into notes if the shared regex ever misses a
  // variant of it.
  var toLines = f['TO'].split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var toIdLine = (toLines.length > 1 && /^[\d\s\-•]{4,}$/.test(toLines[1])) ? toLines[1] : null;

  return {
    payee: toName,
    type: 'Expense',
    amount: parseWesternAmount_(f['PAYMENT AMOUNT']), // "IDR 100,000"
    date: date,
    sof: 'ocbc',
    notes: 'OCBC bill payment' + (toIdLine ? ' — ' + toIdLine : '') +
        ' — Ref ' + (extractReferenceNumber_(text) || 'unknown')
  };
}

// ── mnab/jago PARSER ─────────────────────────────────────────────────────
// Bank Jago's notification emails mostly share one structurally regular
// table format ("transfer-table-title" / "transfer-table-content" cells,
// one label per row, occasionally more than one content line per label)
// across otherwise different transaction types, so — unlike Mandiri/OCBC
// above, which extract from the flattened text — this parser reads that
// table directly out of the HTML into a {label: [values]} map once, then
// each per-template function below just picks the fields it needs out of
// that map. Dispatched on subject line, validated against five real
// samples of that table-shaped kind: money received, e-Wallet top up, a
// QRIS/merchant payment, a Jago Partner autodebit (Bibit), a transfer
// to another bank account, and a cash withdrawal.
//
// Another template — "You've received money in your <Pocket> Pocket" (see
// parseJagoPocketReceived_ below) — is structurally different (plain
// paragraphs, no transfer-table markup at all, e.g. dividends/proceeds
// landing in the RDN Pocket from a securities company), so it's checked
// first and short-circuits before the table-based dispatch, which would
// otherwise bail out on it for lacking 'Amount'/'Transaction Date' table
// rows.
//
// All of these samples resolve to the single JAGO_SOF account (see CONFIG
// up top) — Jago's own multiple underlying Pocket/account numbers aren't
// otherwise distinguished here.

function parseJagoEmail_(subject, bodyHtml, messageDate) {
  if (/received money in your .+ pocket/i.test(subject)) {
    return parseJagoPocketReceived_(bodyHtml, messageDate);
  }

  var table = parseJagoTable_(bodyHtml);
  if (!table['Amount'] || !table['Transaction Date']) return null; // not a shape we recognize → AI fallback

  var amount = parseIndonesianAmount_(table['Amount'][0]); // Jago uses "Rp610.100" — dot-thousands, no decimal shown
  var date = parseIndonesianDate_(table['Transaction Date'][0]);
  if (!date) return null;

  if (/received some money/i.test(subject)) {
    return parseJagoIncome_(table, amount, date);
  }
  if (/top up/i.test(subject)) {
    return parseJagoTopUp_(table, amount, date);
  }
  if (/made a payment to/i.test(subject)) {
    return parseJagoPayment_(table, amount, date);
  }
  if (/made a transaction via/i.test(subject)) {
    return parseJagoPartnerTransaction_(table, amount, date);
  }
  if (/made a transfer/i.test(subject)) {
    return parseJagoTransfer_(table, amount, date);
  }
  if (/withdrawn cash/i.test(subject)) {
    return parseJagoCashWithdrawal_(table, amount, date);
  }
  return null; // unrecognized Jago subject/template → AI fallback
}

// Reads every <tr>...</tr> block that has a "transfer-table-title" cell
// into {label: [contentValue, ...]} — most labels have exactly one content
// value, but e.g. "To" on a transfer email has two (payee name, then
// "BCA • 3200308645"), which is why this returns an array per label rather
// than collapsing to a single string. Labels are read verbatim except for
// a stripped trailing colon, since Jago's own templates are inconsistent
// about it ("Amount" vs "Jago partner:" in real samples).
function parseJagoTable_(bodyHtml) {
  var rows = {};
  var trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  var trMatch;
  while ((trMatch = trRegex.exec(bodyHtml)) !== null) {
    var rowHtml = trMatch[1];
    var titleMatch = rowHtml.match(/transfer-table-title">\s*([^<]+?)\s*</i);
    if (!titleMatch) continue; // header/image rows etc. — not a labeled field
    var label = titleMatch[1].replace(/:\s*$/, '').trim();

    var contentRegex = /transfer-table-content">([^<]*)</gi;
    var contents = [];
    var contentMatch;
    while ((contentMatch = contentRegex.exec(rowHtml)) !== null) {
      var value = contentMatch[1].replace(/&nbsp;/g, ' ').trim();
      if (value) contents.push(value);
    }
    if (contents.length) rows[label] = contents;
  }
  return rows;
}

// "Yay! You've received some money" — money coming INTO a Jago Pocket
// from an external account. "From" is the external sender.
function parseJagoIncome_(table, amount, date) {
  var from = table['From'] && table['From'][0];
  if (!from) return null;
  return {
    payee: from,
    type: 'Income',
    amount: amount,
    date: date,
    sof: JAGO_SOF,
    notes: 'Jago — received transfer' + (table['To'] ? ' into ' + table['To'].join(' ') : '')
  };
}

// "You have done an e-Wallet top up" — "To" is the e-wallet phone number,
// not a merchant name, so it's labeled explicitly in the payee rather than
// left looking like a person's name.
function parseJagoTopUp_(table, amount, date) {
  var to = table['To'] && table['To'][0];
  if (!to) return null;
  return {
    payee: 'eWallet top up (' + to + ')',
    type: 'Expense',
    amount: amount,
    date: date,
    sof: JAGO_SOF,
    notes: 'Jago — eWallet top up'
  };
}

// "You have made a payment to <merchant>" — QRIS/card merchant payment.
// "To" is the merchant name; Acquirer Name / Merchant Location (when
// present) are folded into the notes rather than dropped.
function parseJagoPayment_(table, amount, date) {
  var to = table['To'] && table['To'][0];
  if (!to) return null;
  var extra = [];
  if (table['Acquirer Name']) extra.push('Acquirer ' + table['Acquirer Name'][0]);
  if (table['Merchant Location']) extra.push('Loc ' + table['Merchant Location'][0]);
  return {
    payee: to,
    type: 'Expense',
    amount: amount,
    date: date,
    sof: JAGO_SOF,
    notes: 'Jago QRIS/card payment' + (extra.length ? ' — ' + extra.join(', ') : '')
  };
}

// "You have made a transaction via <Jago Partner>" — a scheduled partner
// autodebit (e.g. Bibit Autodebit). The partner name is its own labeled
// field ("Jago partner"), not the counterparty in a From/To pair.
function parseJagoPartnerTransaction_(table, amount, date) {
  var partner = table['Jago partner'] && table['Jago partner'][0];
  if (!partner) return null;
  return {
    payee: partner,
    type: 'Expense',
    amount: amount,
    date: date,
    sof: JAGO_SOF,
    notes: 'Jago partner autodebit'
  };
}

// "You've received money in your <Pocket> Pocket" — a plain-paragraph
// notification (no transfer-table markup at all, unlike the five templates
// above) for money landing in a Jago Pocket, e.g. dividends/sale proceeds
// arriving in the RDN Pocket from a securities company. Real sample body:
// "You've received Rp4.650 from PT. Stockbit Sekuritas Digital in your RDN
// Pocket." Matched loosely (no leading "You've received" / apostrophe
// requirement) since Jago's apostrophe rendering isn't guaranteed to be a
// plain ASCII "'" in every email.
//
// This template has no explicit transaction date anywhere in the body —
// unlike every other Jago template, which has a "Transaction Date" table
// row — so it falls back to the email's own received timestamp
// (messageDate, threaded in from handleMessage_ via message.getDate()) as
// the best available approximation; edit the Date cell by hand afterward
// if a more precise date is ever needed.
function parseJagoPocketReceived_(bodyHtml, messageDate) {
  var text = htmlToText_(bodyHtml);
  var m = text.match(/received\s+Rp\s*([\d.,]+)\s+from\s+(.+?)\s+in your\s+(.+?)\s+Pocket\b/i);
  if (!m) return null; // unrecognized shape → AI fallback

  var amount = parseIndonesianAmount_(m[1]); // "Rp4.650" — dot-thousands, no decimal shown, same convention as the tabular templates' Amount field
  var payee = m[2].trim();
  var pocketName = m[3].trim(); // e.g. "RDN"

  if (!(messageDate instanceof Date) || isNaN(messageDate.getTime())) return null; // no date anywhere → AI fallback

  return {
    payee: payee,
    type: 'Income',
    amount: amount,
    date: messageDate,
    sof: JAGO_SOF,
    notes: pocketName + ' Pocket'
  };
}

// "You have made a transfer" — transfer to another bank account. "To" has
// two content lines: recipient name, then "<Bank> • <account number>".
function parseJagoTransfer_(table, amount, date) {
  var to = table['To'];
  if (!to || !to[0]) return null;
  return {
    payee: to[0],
    type: 'Expense',
    amount: amount,
    date: date,
    sof: JAGO_SOF,
    notes: 'Jago transfer' + (to[1] ? ' to ' + to[1] : '')
  };
}

// "You have withdrawn cash 💵" — ATM / cardless cash withdrawal off a Jago
// Pocket. Its table carries ONLY Amount and Transaction Date — no From/To
// row, no ATM/location field, nothing naming a counterparty — so unlike
// every other Jago template here there's nothing to read a payee out of,
// and it's a fixed label instead. (The subject's trailing 💵 emoji is not
// matched on; the text alone is enough and emoji rendering isn't
// guaranteed to survive intact.)
//
// Booked as a plain Expense on the Jago account, NOT as a Transfer to a
// separate cash/wallet account — nothing this script writes ever sets the
// Transfer flag. Since every row lands Pending anyway, re-tag it by hand at
// review time if you'd rather track physical cash as its own account.
function parseJagoCashWithdrawal_(table, amount, date) {
  return {
    payee: 'Cash withdrawal',
    type: 'Expense',
    amount: amount,
    date: date,
    sof: JAGO_SOF,
    notes: 'Jago cash withdrawal'
  };
}

// ── AI FALLBACK (Claude) ────────────────────────────────────────────────
// Only runs if ANTHROPIC_API_KEY is set in Script Properties (see setup
// step 8 above). Without it, unparseable emails land as a flagged
// manual-review row instead — never silently dropped either way.

function tryAiFallback_(labelKey, subject, bodyHtml) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    Logger.log('No ANTHROPIC_API_KEY script property set — skipping AI fallback for "' + subject + '".');
    return null;
  }

  var text = htmlToText_(bodyHtml).substring(0, 4000); // keep the prompt small
  var prompt = 'Extract this bank/e-wallet notification email into JSON with exactly these fields: ' +
      'payee (string), amount (number, no currency symbols or separators), date (YYYY-MM-DD string), ' +
      'accountLast4 (string, the last 4 digits of the card or account number mentioned, or null if none shown). ' +
      'Respond with ONLY the JSON object, no other text. ' +
      'If this email does not actually describe a completed transaction, respond with {"payee": null}.\n\n' +
      'Subject: ' + subject + '\n\nBody:\n' + text;

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  try {
    var body = JSON.parse(response.getContentText());
    var replyText = body.content && body.content[0] && body.content[0].text;
    var extracted = JSON.parse(replyText);
    if (!extracted || !extracted.payee) return null;

    // Jago always resolves to the single JAGO_SOF constant (see CONFIG up
    // top) rather than a last-4 lookup, since the user only tracks one
    // Accounts.Name for it regardless of which underlying Jago account
    // number the email showed.
    var sof;
    if (labelKey === 'mnab/jago') {
      sof = JAGO_SOF;
    } else {
      var sofMap = labelKey === 'mnab/mandiri' ? MANDIRI_SOF_MAP
          : labelKey === 'mnab/ocbc' ? OCBC_SOF_MAP
          : {};
      sof = extracted.accountLast4 ? sofMap[extracted.accountLast4] : null;
    }

    return {
      payee: extracted.payee,
      type: 'Expense',
      amount: Number(extracted.amount) || 0,
      date: extracted.date ? new Date(extracted.date) : new Date(),
      sof: sof || '', // still blank if the AI found a last-4 we don't have mapped — check by hand
      notes: '[AI-parsed — verify carefully] ' + subject
    };
  } catch (err) {
    Logger.log('AI fallback: could not parse a usable response for "' + subject + '": ' + err);
    return null;
  }
}

// ── GRAB RECEIPTS: enrich, correct and flag Grab card charges ────────────
//
// WHY: a Grab card charge reaches MNAB through the bank's email (mnab/ocbc,
// mnab/mandiri) as a bare "Grab* A-A42STUDWWC7N" row, written when Grab
// places a HOLD on the card at booking. Two things go wrong with that row:
//   1. A ride the driver cancels still leaves the row behind — the bank
//      voids the hold without sending any email.
//   2. The held amount isn't always what was finally charged. Real case:
//      a GrabExpress held Rp 16.500 (the email) but settled Rp 15.000 (the
//      statement).
// Grab's own receipt email arrives only for a completed trip/order, and it
// carries the final total. So this section reads receipts (Gmail label
// mnab/grab) and, for the charge each one belongs to:
//   - sets Payee to the product, plus the restaurant for food or "Tip" for a
//     tip ("GrabBike XL", "GrabFood - Fore Coffee, Cinere",
//     "GrabExpress Instant - Tip"),
//   - prepends route / distance / times / items to Notes,
//   - corrects Amount (and Expense/Income/Total) to the receipt total when
//     the row isn't Cleared or Reconciled yet,
//   - stamps the receipt's booking ID into a self-provisioned "Receipt ID"
//     column.
// And a sweep (flagGrabChargesWithoutReceipt_) marks any Grab charge that
// still has no receipt two days later as "[NO RECEIPT] …", Pending again,
// so likely-cancelled rides surface in the normal pending review. It never
// deletes anything — you do, after a look.
//
// RECEIPTS NEVER CREATE ROWS. A receipt paid by OVO/GrabPay/SuperBank has no
// card charge to enrich, and simply does nothing. That's also why mnab/grab
// is NOT in LABEL_PARSERS.
//
// MATCHING (findGrabChargeForReceipt_):
//   - By ID (rides, food, tips): the bank email's merchant text carries the
//     booking ID cut to 14 characters — "Grab* A-A42STUDWWC7N" for receipt
//     "A-A42STUDWWC7NAV" — so the receipt ID must START WITH the charge ID.
//   - Without ID (GrabExpress only — its receipt shows "IN-3-…", which
//     never appears on the card): an un-receipted Grab charge within a day
//     of the receipt whose held amount is between the receipt total and
//     125% of it (holds run high, never low), on the receipt's card if the
//     receipt names one. Used only when EXACTLY one charge fits; ID-bearing
//     receipts in the same run are matched first, so they can't be stolen.
//   - Tips are their own card charge with their own ID and receipt, so they
//     match by ID and stay their own row (they line up 1:1 with the
//     statement that way).
//
// "Receipt ID" column values: blank = waiting for a receipt; a booking ID =
// matched; NONE = flagged as having no receipt (a receipt that turns up
// later still matches it, and removes the flag). If you un-flag a row by
// hand, leave NONE in place so the sweep doesn't flag it again.
//
// RETRIES: a receipt with no matching charge yet (the bank email can lag)
// stays unlabeled and is retried on each run for GRAB_RETRY_DAYS days, then
// its thread gets mnab/imported + mnab/grab-unmatched for a manual look.
//
// SETUP: Gmail label "mnab/grab" and a filter
//     from:(no-reply@grab.com) subject:(receipt OR struk) → label mnab/grab
// Nothing else — the existing 5-minute trigger picks it up.
//
// BACKFILL (rows already in MNAB): previewGrabBackfill() / runGrabBackfill()
// — see the BACKFILL section at the end of this file.

var GRAB_RECEIPT_LABEL = 'mnab/grab';
var GRAB_UNMATCHED_LABEL = 'mnab/grab-unmatched';
var GRAB_RECEIPT_COLUMN = 'Receipt ID';
var GRAB_NO_RECEIPT_MARK = 'NONE';
var GRAB_NO_RECEIPT_PREFIX = '[NO RECEIPT] ';
var GRAB_RETRY_DAYS = 3;
var GRAB_FALLBACK_MAX_RATIO = 1.25; // held amount may be up to 25% above the receipt total
var GRAB_FALLBACK_DAY_WINDOW = 1;
var GRAB_FLAG_AFTER_DAYS = 2;       // dated 2+ days ago (so always 24h+) with no receipt → flag
var GRAB_FLAG_LOOKBACK_DAYS = 7;    // never flag older rows — they predate this feature
var GRAB_FLAG_INTERVAL_MS = 60 * 60 * 1000;
var GRAB_FLAG_LAST_RUN_KEY = 'GRAB_FLAG_LAST_RUN';

// ── Parsing ──

function grabReceiptLines_(html) {
  var text = String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&bull;/gi, '•')
      .replace(/&copy;/gi, '©')
      .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/[ 　]/g, ' ');
  return text.split('\n')
      .map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
      .filter(function (l) { return l && !/^[⋮•·|.\-\s]+$/.test(l); }); // drop route-dot / divider-only lines
}

// Integer rupiah from "Rp16.300", "Rp 15000", "RP 10000", "16.300".
function grabAmount_(str) {
  var s = String(str).replace(/[^\d.,]/g, '');
  if (!s) return 0;
  if (/[.,]\d{1,2}$/.test(s)) s = s.replace(/[.,]\d{1,2}$/, ''); // drop a decimal part
  return Number(s.replace(/[.,]/g, '')) || 0;
}

// Value for a label: the rest of the label's line ("Kode Booking: A-…") or,
// if the label stands alone, the next line.
function grabValueAfter_(lines, labelRe) {
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(labelRe);
    if (!m) continue;
    var rest = lines[i].slice(m[0].length).replace(/^[\s:]+/, '').trim();
    if (rest) return rest;
    return lines[i + 1] || '';
  }
  return '';
}

function grabShortPlace_(s) {
  s = String(s || '').trim();
  if (s.length <= 45) return s;
  return s.split(',')[0].trim();
}

function grab24h_(s) {
  var m = String(s || '').match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return '';
  var h = Number(m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}

// Returns null for anything that isn't a usable receipt (promos, surveys).
function parseGrabReceipt_(subject, bodyHtml, messageDate) {
  var lines = grabReceiptLines_(bodyHtml);
  var joined = lines.join('\n');

  var bookingId = (grabValueAfter_(lines, /^(Booking ID|Kode Booking|Pesanan ID|Order ID)\b/i).match(/^(A-[A-Z0-9]{8,}|IN-\d+-[A-Z0-9]{8,})/) || [])[1] ||
      (joined.match(/\b(A-[A-Z0-9]{10,}|IN-\d+-[A-Z0-9]{10,})\b/) || [])[1] || '';

  var total = 0;
  for (var i = 0; i < lines.length && !total; i++) {
    var tm = lines[i].match(/^total(\s+paid)?(\s*\(incl\. tax\))?\b\s*(.*)$/i);
    if (!tm) continue;
    if (/\d/.test(tm[3])) total = grabAmount_(tm[3]);
    else if (/^(rp\.?\s*)?[\d.,]+$/i.test(lines[i + 1] || '')) total = grabAmount_(lines[i + 1]);
  }

  if (!bookingId || !total) return null;

  var service = '';
  for (var j = 0; j < lines.length; j++) {
    if (/^Grab(Bike|Car|Express|Food|Mart|Taxi|Hemat|Car\w+)\b/.test(lines[j]) && lines[j].length < 40 && lines[j].indexOf('.') === -1) {
      service = lines[j];
      break;
    }
  }

  var isTip = /Grab Tips E-Receipt|Tip darimu/i.test(joined);
  var merchant = grabValueAfter_(lines, /^(Pesanan Dari|Order(ed)? from)\b/i);
  var kind = isTip ? 'tip'
      : (/^Grab(Food|Mart)/.test(service) || merchant) ? 'food'
      : /^GrabExpress/.test(service) ? 'express'
      : 'ride';

  var dm = joined.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|Mei|May|Jun|Jul|Agu|Aug|Sep|Okt|Oct|Nov|Des|Dec)[a-z]*\s+(\d{4}|\d{2})\b/i);
  var date = null;
  if (dm) {
    var year = Number(dm[3]);
    if (year < 100) year += 2000;
    var month = INDONESIAN_MONTHS[dm[2].toLowerCase().substring(0, 3)];
    if (month !== undefined) date = new Date(year, month, Number(dm[1]));
  }
  if (!date && messageDate instanceof Date) {
    date = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
  }

  var cardMatch = joined.match(/(?:Paid by|Dibayar dengan)\s*\n(?:\s*(?:Visa|Mastercard|JCB|Amex)\s*\n)?\s*(\d{4})\b/i);
  var last4 = cardMatch ? cardMatch[1] : '';
  var isCard = !!last4 || /(?:Paid by|Dibayar dengan|Detail Pembayaran:?)\s*\n\s*(Visa|Mastercard|Master Card|JCB|Amex|American Express)\b/i.test(joined);

  var pickup = grabValueAfter_(lines, /^Lokasi Penjemputan\b/i);
  var dropoff = grabValueAfter_(lines, /^Lokasi (Pengantaran|Tujuan)\b/i);
  var startTime = '', endTime = '', distance = '';
  for (var k = 0; k < lines.length; k++) {
    var km = lines[k].match(/^([\d.,]+\s*km)\s*•\s*(\d+\s*mins?)$/i);
    if (!km) continue;
    distance = km[1] + ' · ' + km[2];
    if (!pickup) {
      pickup = lines[k + 1] || '';
      startTime = grab24h_(lines[k + 2]);
      dropoff = lines[k + (startTime ? 3 : 2)] || '';
      endTime = grab24h_(lines[k + (startTime ? 4 : 3)]);
    }
    break;
  }

  var items = [];
  for (var n = 0; n < lines.length; n++) {
    var im = lines[n].match(/^(\d+)x(?:\s+(.+))?$/);
    if (im && kind === 'food') items.push(im[1] + 'x ' + (im[2] || lines[n + 1] || '').trim());
  }

  return {
    bookingId: bookingId.toUpperCase(),
    kind: kind,
    service: service || (kind === 'food' ? 'GrabFood' : 'Grab'),
    merchant: merchant,
    total: total,
    date: date,
    last4: last4,
    isCard: isCard,
    pickup: grabShortPlace_(pickup),
    dropoff: grabShortPlace_(dropoff),
    startTime: startTime,
    endTime: endTime,
    distance: distance,
    items: items,
    subject: subject
  };
}

// Always "<product>" or "<product> - <detail>", so the Grab product leads
// the Payee: "GrabBike XL", "GrabExpress Instant", "GrabExpress Instant - Tip",
// "GrabFood - Fore Coffee, Cinere" (the restaurant's own " - " becomes ", ").
function grabPayeeFor_(r) {
  if (r.kind === 'tip') return r.service + ' - Tip';
  if (r.kind === 'food' && r.merchant) return r.service + ' - ' + r.merchant.replace(/\s+-\s+/g, ', ');
  return r.service;
}

function grabNotesFor_(r) {
  var parts = [];
  if (r.kind === 'food') {
    if (r.items.length) parts.push(r.items.join(', '));
  } else {
    if (r.pickup || r.dropoff) parts.push((r.pickup || '?') + ' → ' + (r.dropoff || '?'));
    if (r.distance) parts.push(r.distance);
    if (r.startTime && r.endTime) parts.push(r.startTime + '–' + r.endTime);
  }
  parts.push('Grab ' + r.bookingId);
  return parts.join(' · ');
}

// ── Matching (pure — no Sheet/Gmail calls, so it's testable on its own) ──

// "Grab* A-A42STUDWWC7N" → "A-A42STUDWWC7N". Tolerates the [NO RECEIPT]
// prefix and "GRAB *" spacing variants.
function grabChargeId_(payee) {
  var p = String(payee || '').replace(/^\[NO RECEIPT\]\s*/i, '');
  var m = p.match(/^grab\s*\*\s*([A-Z0-9][A-Z0-9-]{7,})/i);
  return m ? m[1].toUpperCase() : '';
}

function grabSofForLast4_(last4) {
  if (!last4) return '';
  return OCBC_SOF_MAP[last4] || MANDIRI_SOF_MAP[last4] || '';
}

function grabDayDiff_(a, b) {
  var da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  var db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((da - db) / 86400000);
}

// rows: [{rowNum, payee, sof, date, amount, type, transfer, receiptId, cleared, reconciled}]
// Returns {status: 'already'|'matched'|'ambiguous'|'none', row, method}.
function findGrabChargeForReceipt_(receipt, rows) {
  for (var a = 0; a < rows.length; a++) {
    if (String(rows[a].receiptId || '').toUpperCase() === receipt.bookingId) return { status: 'already', row: rows[a] };
  }

  var cardSof = grabSofForLast4_(receipt.last4);
  var open = rows.filter(function (r) {
    var rid = String(r.receiptId || '').toUpperCase();
    if (rid && rid !== GRAB_NO_RECEIPT_MARK) return false;
    if ((r.type || 'Expense') !== 'Expense' || r.transfer) return false;
    if (cardSof && r.sof !== cardSof) return false;
    return !!grabChargeId_(r.payee);
  });

  var byId = open.filter(function (r) {
    var cid = grabChargeId_(r.payee);
    return cid.length >= 10 && receipt.bookingId.indexOf(cid) === 0;
  });
  if (byId.length === 1) return { status: 'matched', row: byId[0], method: 'id' };
  if (byId.length > 1) return { status: 'ambiguous' };

  // An ID-bearing receipt (A-…) that matched nothing doesn't fall back:
  // its charge is either not imported yet (retry) or not a card charge.
  if (receipt.bookingId.indexOf('A-') === 0) return { status: 'none' };

  if (!(receipt.date instanceof Date)) return { status: 'none' };
  var fits = open.filter(function (r) {
    if (!(r.date instanceof Date) || isNaN(r.date.getTime())) return false;
    if (Math.abs(grabDayDiff_(r.date, receipt.date)) > GRAB_FALLBACK_DAY_WINDOW) return false;
    var amt = Number(r.amount) || 0;
    return amt >= receipt.total && amt <= receipt.total * GRAB_FALLBACK_MAX_RATIO;
  });
  if (fits.length === 1) return { status: 'matched', row: fits[0], method: 'amount' };
  return { status: fits.length > 1 ? 'ambiguous' : 'none' };
}

// What to write to a matched row. Pure; returns {payee, notes, amount|undefined, receiptId}.
function grabEnrichmentFor_(receipt, row) {
  var oldAmount = Number(row.amount) || 0;
  var notes = grabNotesFor_(receipt);
  var out = { payee: grabPayeeFor_(receipt), receiptId: receipt.bookingId };
  if (oldAmount !== receipt.total) {
    if (row.cleared || row.reconciled) {
      notes += ' · receipt total ' + formatIdr_(receipt.total) + ' ≠ ' + formatIdr_(oldAmount) + ' charged — not changed, row already cleared';
    } else {
      notes += ' · held ' + formatIdr_(oldAmount) + ' → final ' + formatIdr_(receipt.total);
      out.amount = receipt.total;
    }
  }
  var oldNotes = String(row.notes || '').replace(/^No Grab receipt[^|]*\|\s*/, '');
  out.notes = notes + (oldNotes ? ' | ' + oldNotes : '');
  return out;
}

// ── Sheet plumbing ──

function grabTruthy_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function loadGrabRows_(sheet, headerMap) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  function col(r, name) { return headerMap[name] ? r[headerMap[name] - 1] : ''; }
  var rows = [];
  data.forEach(function (r, i) {
    var payee = col(r, 'Payee');
    if (!grabChargeId_(payee) && !col(r, GRAB_RECEIPT_COLUMN)) return; // only Grab-ish rows matter
    rows.push({
      rowNum: i + 2,
      payee: payee,
      sof: col(r, 'SOF'),
      date: col(r, 'Date'),
      amount: col(r, 'Amount'),
      type: col(r, 'Income/Expense') || 'Expense',
      transfer: grabTruthy_(col(r, 'Transfer')),
      receiptId: col(r, GRAB_RECEIPT_COLUMN),
      cleared: grabTruthy_(col(r, 'Cleared')),
      reconciled: grabTruthy_(col(r, 'Reconciled')),
      notes: col(r, 'Notes')
    });
  });
  return rows;
}

function ensureGrabColumn_(sheet, headerMap) {
  if (headerMap[GRAB_RECEIPT_COLUMN]) return;
  var newCol = sheet.getLastColumn() + 1;
  sheet.getRange(1, newCol).setValue(GRAB_RECEIPT_COLUMN);
  headerMap[GRAB_RECEIPT_COLUMN] = newCol;
  Logger.log('Auto-provisioned a new "' + GRAB_RECEIPT_COLUMN + '" column on transactions at position ' + newCol + '.');
}

function applyGrabEnrichment_(sheet, headerMap, row, change, dryRun) {
  var values = { 'Payee': change.payee, 'Notes': change.notes };
  values[GRAB_RECEIPT_COLUMN] = change.receiptId;
  if (change.amount !== undefined) {
    values['Amount'] = change.amount;
    values['Expense'] = change.amount;
    values['Income'] = 0;
    values['Total'] = change.amount;
  }
  if (dryRun) {
    Logger.log('[DRY RUN] Would update transactions row ' + row.rowNum + ' (' + row.payee + '): ' + JSON.stringify(values));
  } else {
    ensureGrabColumn_(sheet, headerMap);
    Object.keys(values).forEach(function (h) {
      if (headerMap[h]) sheet.getRange(row.rowNum, headerMap[h]).setValue(values[h]);
    });
    Logger.log('Grab receipt ' + change.receiptId + ' → transactions row ' + row.rowNum + ' (' + change.payee + ').');
  }
  // Keep the in-memory copy current for later receipts in this same run.
  row.payee = change.payee;
  row.notes = change.notes;
  row.receiptId = change.receiptId;
  if (change.amount !== undefined) row.amount = change.amount;
}

// Matches one parsed receipt against rows and writes it. Returns
// 'matched' | 'already' | 'ambiguous' | 'none' | 'not-card'.
function handleGrabReceipt_(receipt, rows, sheet, headerMap, dryRun) {
  if (!receipt.isCard) return 'not-card';
  var res = findGrabChargeForReceipt_(receipt, rows);
  if (res.status === 'matched') {
    applyGrabEnrichment_(sheet, headerMap, res.row, grabEnrichmentFor_(receipt, res.row), dryRun);
  }
  return res.status;
}

// Called by runImportPass_ with every thread that carries mnab/grab.
// Receipts with an A- ID go first so the amount-based Express fallback
// can't take a charge that has its own receipt in the same batch.
function processGrabReceiptThreads_(threads, sheet, headerMap, dryRun, now) {
  if (!threads.length) return;
  var rows = loadGrabRows_(sheet, headerMap);
  var items = [];
  threads.forEach(function (thread, t) {
    thread.getMessages().forEach(function (message) {
      items.push({
        t: t,
        message: message,
        receipt: parseGrabReceipt_(message.getSubject(), message.getBody(), message.getDate())
      });
    });
  });
  items.sort(function (x, y) {
    var xa = x.receipt && x.receipt.bookingId.indexOf('A-') === 0 ? 0 : 1;
    var ya = y.receipt && y.receipt.bookingId.indexOf('A-') === 0 ? 0 : 1;
    return xa - ya || x.message.getDate() - y.message.getDate();
  });

  var pending = {}; // thread index → true if something should be retried
  var unmatched = {};
  items.forEach(function (it) {
    if (!it.receipt) {
      Logger.log('mnab/grab: "' + it.message.getSubject() + '" is not a receipt this parser understands — ignoring.');
      return;
    }
    var status;
    try {
      status = handleGrabReceipt_(it.receipt, rows, sheet, headerMap, dryRun);
    } catch (err) {
      Logger.log('ERROR on Grab receipt ' + it.receipt.bookingId + ': ' + err);
      status = 'none';
    }
    if (status === 'none' || status === 'ambiguous') {
      var ageDays = (now - it.message.getDate()) / 86400000;
      if (ageDays < GRAB_RETRY_DAYS) {
        pending[it.t] = true;
        Logger.log('Grab receipt ' + it.receipt.bookingId + ' (' + formatIdr_(it.receipt.total) + '): ' + status + ' — will retry.');
      } else {
        unmatched[it.t] = true;
        Logger.log('Grab receipt ' + it.receipt.bookingId + ' (' + formatIdr_(it.receipt.total) + '): ' + status + ' after ' + GRAB_RETRY_DAYS + ' days — labeling ' + GRAB_UNMATCHED_LABEL + '.');
      }
    }
  });

  threads.forEach(function (thread, t) {
    if (pending[t]) return; // leave unlabeled → retried next run
    if (dryRun) {
      Logger.log('[DRY RUN] Would label Grab thread "' + thread.getFirstMessageSubject() + '" as ' + PROCESSED_LABEL + (unmatched[t] ? ' + ' + GRAB_UNMATCHED_LABEL : '') + '.');
      return;
    }
    thread.addLabel(GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL));
    if (unmatched[t]) thread.addLabel(GmailApp.getUserLabelByName(GRAB_UNMATCHED_LABEL) || GmailApp.createLabel(GRAB_UNMATCHED_LABEL));
  });
}

// ── No-receipt sweep ──

// Pure: which rows to flag, given today's date.
function grabRowsToFlag_(rows, today) {
  return rows.filter(function (r) {
    if (r.receiptId) return false; // matched, or already flagged (NONE)
    if (!grabChargeId_(r.payee) || (r.type || 'Expense') !== 'Expense' || r.transfer) return false;
    if (r.cleared || r.reconciled) return false; // it's on the statement — it happened
    if (!(r.date instanceof Date) || isNaN(r.date.getTime())) return false;
    var age = grabDayDiff_(today, r.date);
    return age >= GRAB_FLAG_AFTER_DAYS && age <= GRAB_FLAG_LOOKBACK_DAYS;
  });
}

function flagGrabChargesWithoutReceipt_(sheet, headerMap, dryRun, now) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(GRAB_FLAG_LAST_RUN_KEY)) || 0;
  if (!dryRun && now.getTime() - last < GRAB_FLAG_INTERVAL_MS) return;

  var rows = loadGrabRows_(sheet, headerMap);
  var toFlag = grabRowsToFlag_(rows, now);
  toFlag.forEach(function (r) {
    var values = {
      'Payee': GRAB_NO_RECEIPT_PREFIX + String(r.payee).replace(/^\[NO RECEIPT\]\s*/i, ''),
      'Notes': 'No Grab receipt within 24h — likely cancelled; delete if so. | ' + (r.notes || ''),
      'Pending': true
    };
    values[GRAB_RECEIPT_COLUMN] = GRAB_NO_RECEIPT_MARK;
    if (dryRun) {
      Logger.log('[DRY RUN] Would flag transactions row ' + r.rowNum + ' (' + r.payee + ', ' + formatIdr_(r.amount) + ') as no-receipt.');
      return;
    }
    ensureGrabColumn_(sheet, headerMap);
    Object.keys(values).forEach(function (h) {
      if (headerMap[h]) sheet.getRange(r.rowNum, headerMap[h]).setValue(values[h]);
    });
    Logger.log('Flagged transactions row ' + r.rowNum + ' (' + r.payee + ', ' + formatIdr_(r.amount) + '): no Grab receipt.');
  });
  if (!dryRun) props.setProperty(GRAB_FLAG_LAST_RUN_KEY, String(now.getTime()));
}

// ── BACKFILL (rows already in MNAB) ──
//
// Reads Grab receipts straight from Gmail by sender — label or not, already
// imported or not — and runs each through the same matcher, so existing
// "Grab* A-…" rows get their payee, notes and Receipt ID. It never flags
// anything as cancelled (the sweep's 7-day window stays as is), never
// labels threads, and never creates rows.
//
// Old rows you've already reconciled keep their amount: a different receipt
// total is only written into Notes. Rows whose payee you already renamed by
// hand (no "Grab* A-…" left) can't be matched by ID and are skipped.
//
//   previewGrabBackfill() — always a dry run; logs every update it would make.
//   runGrabBackfill()     — writes (unless the DRY_RUN property is true).
// Both page through Gmail GRAB_BACKFILL_PAGE threads at a time and remember
// where they stopped (GRAB_BACKFILL_OFFSET property); run again until the
// log says it's done. resetGrabBackfill() starts over. Re-running is safe:
// a receipt already stamped on a row is skipped.

var GRAB_BACKFILL_QUERY = 'from:(no-reply@grab.com) subject:(receipt OR struk)';
var GRAB_BACKFILL_SINCE = '2026/01/01';
var GRAB_BACKFILL_PAGE = 100;
var GRAB_BACKFILL_OFFSET_KEY = 'GRAB_BACKFILL_OFFSET';

function previewGrabBackfill() { runGrabBackfillPass_(true); }
function runGrabBackfill() { runGrabBackfillPass_(isDryRun_()); }
function resetGrabBackfill() {
  PropertiesService.getScriptProperties().deleteProperty(GRAB_BACKFILL_OFFSET_KEY);
  Logger.log('Grab backfill will start from the newest receipt next time.');
}

function runGrabBackfillPass_(dryRun) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log('An import run is in progress — try the backfill again in a minute.');
    return;
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var offset = dryRun ? 0 : (Number(props.getProperty(GRAB_BACKFILL_OFFSET_KEY)) || 0);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TRANSACTIONS_SHEET_NAME);
    // Read the header without provisioning anything — the only column the
    // backfill can add is Receipt ID, and only when it actually writes.
    var lastCol = sheet.getLastColumn();
    var headerMap = {};
    sheet.getRange(1, 1, 1, lastCol).getValues()[0].forEach(function (h, i) { if (h) headerMap[h] = i + 1; });
    var rows = loadGrabRows_(sheet, headerMap);
    var threads = GmailApp.search(GRAB_BACKFILL_QUERY + ' after:' + GRAB_BACKFILL_SINCE, offset, GRAB_BACKFILL_PAGE);

    var receipts = [];
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        var r = parseGrabReceipt_(m.getSubject(), m.getBody(), m.getDate());
        if (r) receipts.push(r);
      });
    });
    receipts.sort(function (x, y) {
      return (x.bookingId.indexOf('A-') === 0 ? 0 : 1) - (y.bookingId.indexOf('A-') === 0 ? 0 : 1);
    });

    var counts = { matched: 0, already: 0, ambiguous: 0, none: 0, 'not-card': 0 };
    receipts.forEach(function (r) {
      counts[handleGrabReceipt_(r, rows, sheet, headerMap, dryRun)]++;
    });

    var done = threads.length < GRAB_BACKFILL_PAGE;
    if (!dryRun) {
      if (done) props.deleteProperty(GRAB_BACKFILL_OFFSET_KEY);
      else props.setProperty(GRAB_BACKFILL_OFFSET_KEY, String(offset + threads.length));
    }
    Logger.log((dryRun ? '[DRY RUN] ' : '') + 'Grab backfill: ' + threads.length + ' thread(s), ' + receipts.length + ' receipt(s) — ' +
        counts.matched + ' matched, ' + counts.already + ' already done, ' + counts['not-card'] + ' not paid by card, ' +
        counts.none + ' no charge found, ' + counts.ambiguous + ' ambiguous. ' +
        (dryRun ? '(Preview covers the newest ' + GRAB_BACKFILL_PAGE + ' threads only.)'
            : done ? 'Done.' : 'More to go — run runGrabBackfill again.'));
  } finally {
    lock.releaseLock();
  }
}

// ── ONE-OFF: re-apply the current Payee format to already-matched rows ──
//
// Rows matched by the first version of this section got the old Payee
// format ("Fore Coffee - Cinere", "Grab tip (GrabExpress Instant)").
// Matching never revisits a matched row, so this rewrites them once:
//
//   previewReapplyGrabPayees() — dry run; logs each rename it would make.
//   reapplyGrabPayees()        — writes (unless the DRY_RUN property is true).
//
// Only a Payee that is EXACTLY the old auto-written value is changed, so
// any Payee you've edited by hand is left alone. The old "GrabFood · " /
// "Tip · " prefix is also dropped from Notes. Rides and GrabExpress didn't
// change format and are skipped. Safe to run more than once; it reads up to
// GRAB_REAPPLY_MAX_THREADS receipt threads per run — run it again if the
// log says there's more.

var GRAB_REAPPLY_MAX_THREADS = 500;

function previewReapplyGrabPayees() { reapplyGrabPayeesPass_(true); }
function reapplyGrabPayees() { reapplyGrabPayeesPass_(isDryRun_()); }

// The Payee the first version of this section wrote.
function grabOldPayeeFor_(r) {
  if (r.kind === 'tip') return 'Grab tip (' + r.service + ')';
  if (r.kind === 'food' && r.merchant) return r.merchant;
  return r.service;
}

// Pure: what to change on one matched row, or null.
function grabReapplyChange_(receipt, row) {
  var oldPayee = grabOldPayeeFor_(receipt);
  var newPayee = grabPayeeFor_(receipt);
  if (oldPayee === newPayee || String(row.payee) !== oldPayee) return null;
  var notes = String(row.notes || '');
  if (receipt.kind === 'food') notes = notes.replace(new RegExp('^' + receipt.service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · '), '');
  if (receipt.kind === 'tip') notes = notes.replace(/^Tip · /, '');
  return { payee: newPayee, notes: notes };
}

function reapplyGrabPayeesPass_(dryRun) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log('An import run is in progress — try again in a minute.');
    return;
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var offsetKey = 'GRAB_REAPPLY_OFFSET';
    var start = dryRun ? 0 : (Number(props.getProperty(offsetKey)) || 0);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TRANSACTIONS_SHEET_NAME);
    var lastCol = sheet.getLastColumn();
    var headerMap = {};
    sheet.getRange(1, 1, 1, lastCol).getValues()[0].forEach(function (h, i) { if (h) headerMap[h] = i + 1; });
    if (!headerMap[GRAB_RECEIPT_COLUMN]) {
      Logger.log('No "' + GRAB_RECEIPT_COLUMN + '" column yet — nothing has been matched, nothing to re-apply.');
      return;
    }
    var byReceipt = {};
    loadGrabRows_(sheet, headerMap).forEach(function (r) {
      var id = String(r.receiptId || '').toUpperCase();
      if (id && id !== GRAB_NO_RECEIPT_MARK) byReceipt[id] = r;
    });

    var renamed = 0, read = 0, threadsSeen = 0, more = false;
    for (var offset = start; ; offset += GRAB_BACKFILL_PAGE) {
      if (threadsSeen >= GRAB_REAPPLY_MAX_THREADS) { more = true; break; }
      var threads = GmailApp.search(GRAB_BACKFILL_QUERY + ' after:' + GRAB_BACKFILL_SINCE, offset, GRAB_BACKFILL_PAGE);
      threadsSeen += threads.length;
      threads.forEach(function (thread) {
        thread.getMessages().forEach(function (m) {
          var receipt = parseGrabReceipt_(m.getSubject(), m.getBody(), m.getDate());
          if (!receipt) return;
          read++;
          var row = byReceipt[receipt.bookingId];
          if (!row) return;
          var change = grabReapplyChange_(receipt, row);
          if (!change) return;
          renamed++;
          if (dryRun) {
            Logger.log('[DRY RUN] Row ' + row.rowNum + ': "' + row.payee + '" → "' + change.payee + '"');
          } else {
            sheet.getRange(row.rowNum, headerMap['Payee']).setValue(change.payee);
            if (headerMap['Notes'] && change.notes !== String(row.notes || '')) sheet.getRange(row.rowNum, headerMap['Notes']).setValue(change.notes);
            Logger.log('Row ' + row.rowNum + ': "' + row.payee + '" → "' + change.payee + '"');
          }
          row.payee = change.payee;
          row.notes = change.notes;
        });
      });
      if (threads.length < GRAB_BACKFILL_PAGE) break;
    }
    if (!dryRun) {
      if (more) props.setProperty(offsetKey, String(start + threadsSeen));
      else props.deleteProperty(offsetKey);
    }
    Logger.log((dryRun ? '[DRY RUN] ' : '') + 'Re-apply Grab payees: ' + read + ' receipt(s) read, ' + renamed + ' row(s) ' +
        (dryRun ? 'would be renamed.' : 'renamed.') + (more ? (dryRun ? ' (Preview stopped early — more receipts not read.)' : ' More to go — run reapplyGrabPayees again.') : ' Done.'));
  } finally {
    lock.releaseLock();
  }
}
