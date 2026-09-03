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
 * 2. Create ONE Gmail filter per bank sender applying its single label
 *    (Gmail's filter UI only lets you pick one label per rule anyway, so
 *    this is also the only thing that's actually possible):
 *      from:(noreply.livin@bankmandiri.co.id) → apply label "mnab/mandiri"
 *      from:(notifikasi@ocbc.id)              → apply label "mnab/ocbc"
 *      from:(noreply@jago.com)                → apply label "mnab/jago"
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
  '4226': 'ocbc 90.n',
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
  var clauses = Object.keys(LABEL_PARSERS).map(function (l) { return 'label:' + l; });
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
        return n.indexOf('mnab/') === 0 && n !== PROCESSED_LABEL;
      })[0];

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
  } finally {
    lock.releaseLock();
  }
}

function handleMessage_(message, labelKey, headerMap, dryRun) {
  var subject = message.getSubject();
  var body = message.getBody(); // Gmail hands back already-decoded HTML, no quoted-printable handling needed
  var messageId = message.getId();

  var failure = classifyFailure_(subject, body);
  var parsed = LABEL_PARSERS[labelKey](subject, body);

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
          (parsed.notes ? '. ' + parsed.notes : '') + '. (Auto-imported, unreviewed — no funds actually moved.)',
      messageId: messageId
    }, headerMap, dryRun);
  }

  return writeRow_({
    payee: parsed.payee,
    type: parsed.type || 'Expense',
    sof: parsed.sof,
    date: parsed.date,
    amount: parsed.amount,
    notes: (parsed.notes || '') + ' (Auto-imported, unreviewed.)',
    messageId: messageId
  }, headerMap, dryRun);
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
    'Email Message ID': row.messageId || ''
  };

  if (dryRun) {
    Logger.log('[DRY RUN] Would append row: ' + JSON.stringify(values));
    return true;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TRANSACTIONS_SHEET_NAME);
  if (!sheet) throw new Error('Could not find a sheet tab named "' + TRANSACTIONS_SHEET_NAME + '".');

  var newRowIndex = sheet.getLastRow() + 1;
  Object.keys(values).forEach(function (header) {
    var col = headerMap[header];
    // A header this script doesn't recognize (e.g. 'Cleared'/'Reconciled'
    // spelled differently than expected) is silently skipped rather than
    // erroring the whole row — check the sheet afterward if a column looks
    // empty that shouldn't be.
    if (col) sheet.getRange(newRowIndex, col).setValue(values[header]);
  });
  return true;
}

// Reads the header row into a {headerName: 1-based col index} map, and
// auto-provisions any of these columns that aren't there yet (appended
// after the last existing column) — mirrors how Reconcile.gs originally
// added 'Reconciled'/'Reconciled Date' the same way. 'Pending' was the
// original one; 'Email Message ID' was added later for the message-level
// duplicate guard — see "TWO LAYERS OF DUPLICATE PROTECTION" up top.
var IMPORT_COLUMNS = ['Pending', 'Email Message ID'];

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
// Validated against a real "Pembayaran Berhasil!" (Livin' by Mandiri) email.

function parseMandiriEmail_(subject, bodyHtml) {
  var text = htmlToText_(bodyHtml);

  var LABELS = ['Penerima', 'Tanggal', 'Jam', 'Nominal Transaksi', 'No. Referensi',
    'No. Ref. QRIS', 'Merchant PAN', 'Customer PAN', 'Pengakuisisi', 'Terminal ID', 'Sumber Dana'];

  // Each label in this template sits alone on its own line (one per <td>/<p>),
  // so the boundary check requires the NEXT label to also be alone on its own
  // line — not just present anywhere in the captured text. Without that
  // anchor, a merchant name containing a label word (e.g. "24 JAM" containing
  // "Jam", the time-field label) would falsely truncate the capture right
  // there. Caught by testing against a real "24 JAM ..." laundromat payee.
  function valueAfter(label) {
    var idx = LABELS.indexOf(label);
    var next = LABELS.slice(idx + 1).map(function (l) { return l.replace(/[.]/g, '\\.'); });
    var boundary = next.length ? '(?:' + next.join('|') + ')' : '$';
    var re = new RegExp(
        '(?:^|\\n)' + label.replace(/[.]/g, '\\.') + '\\s*\\n([\\s\\S]*?)(?:\\n(?:' + boundary + ')(?:\\n|$)|$)',
        'i'
    );
    var m = text.match(re);
    // Deliberately keep internal newlines rather than collapsing to spaces:
    // "Penerima" is a two-line value (merchant name, then city) and callers
    // that want just the first line need the \n still there to split on.
    return m ? m[1].trim() : null;
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

// ── mnab/ocbc PARSER ─────────────────────────────────────────────────────
// OCBC sends multiple structurally unrelated templates from the same
// sender — dispatches on subject line first. Validated against real
// "Transfer Dana ... dengan BI Fast" (transfer, incl. a real failure
// sample) and "Credit Card Transaction Notification" emails.

function parseOcbcEmail_(subject, bodyHtml) {
  if (/credit card transaction/i.test(subject)) {
    return parseOcbcCreditCard_(bodyHtml);
  }
  if (/transfer dana/i.test(subject)) {
    return parseOcbcTransfer_(bodyHtml);
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

// ── mnab/jago PARSER ─────────────────────────────────────────────────────
// Bank Jago's notification emails all share one structurally regular
// table format ("transfer-table-title" / "transfer-table-content" cells,
// one label per row, occasionally more than one content line per label)
// across otherwise different transaction types, so — unlike Mandiri/OCBC
// above, which extract from the flattened text — this parser reads that
// table directly out of the HTML into a {label: [values]} map once, then
// each per-template function below just picks the fields it needs out of
// that map. Dispatched on subject line, validated against five real
// samples: money received, e-Wallet top up, a QRIS/merchant payment, a
// Jago Partner autodebit (Bibit), and a transfer to another bank account.
//
// All five samples resolve to the single JAGO_SOF account (see CONFIG up
// top) — Jago's own multiple underlying Pocket/account numbers aren't
// otherwise distinguished here.

function parseJagoEmail_(subject, bodyHtml) {
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
