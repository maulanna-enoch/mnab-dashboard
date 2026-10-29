/**
 * ShortcutImport.gs — MNAB receipt-screenshot importer for an iOS Shortcut
 *
 * WHAT IT DOES
 * You open a transaction receipt in a banking app and run the "Log to MNAB"
 * Shortcut. The Shortcut takes a screenshot and POSTs it to this script's web
 * app URL. This script:
 *   1. checks the shared secret (SHORTCUT_TOKEN),
 *   2. sends the image to Claude to read the receipt,
 *   3. works out the SOF (account) and the billing month,
 *   4. appends ONE row to `transactions` with Pending = TRUE,
 *   5. returns a one-line summary for the Shortcut to show as a notification.
 *
 * Every row lands Pending, the same as EmailImport.gs, so nothing counts as
 * confirmed until you review it in the dashboard's pending review.
 *
 * ── WHY THIS IS ITS OWN APPS SCRIPT PROJECT ────────────────────────────
 * Unlike every other file in apps-script/, this one does NOT go into the
 * MNAB Sheet's bound project. It lives in a separate, standalone Apps Script
 * project that opens the Sheet by ID.
 *
 * Reason: the Shortcut can't sign in to Google, so this web app has to be
 * deployed with access "Anyone". An Apps Script project has exactly one
 * doGet()/doPost() pair, shared by every deployment of that project, and an
 * HtmlService page served from a deployment can call any public function in
 * the project through google.script.run. In the bound project that would
 * put Deployer.gs's page (deploy / roll back) and every menu/trigger
 * function behind a public URL. A standalone project exposes only what's in
 * this file: doPost() behind SHORTCUT_TOKEN, and a doGet() health check.
 * doPost() refuses to run if it finds itself bound to a spreadsheet.
 *
 * The cost is that the few helpers this needs from EmailImport.gs and
 * Reconciliations.gs are COPIED below (prefixed sc / SC_), not shared:
 *   EmailImport.gs:     IMPORT_COLUMNS, ensureImportColumns_(),
 *                       loadImportedMessageIds_(), findManualMatch_(),
 *                       generateMatchId_(), formatIdr_(),
 *                       MANDIRI_SOF_MAP, OCBC_SOF_MAP, JAGO_SOF
 *   Reconciliations.gs: headerIndexMap(), billingMonthForDate()
 * If you add a card to MANDIRI_SOF_MAP / OCBC_SOF_MAP in EmailImport.gs, add
 * it to SC_MANDIRI_SOF_MAP / SC_OCBC_SOF_MAP here too.
 *
 * It also can't share EmailImport's script lock (locks are per project), so
 * its own lock only serializes Shortcut runs against each other. The window
 * where a Shortcut write and an EmailImport write could pick the same new
 * row is tiny (both compute "last row + 1" right before writing), and every
 * row lands Pending for review anyway.
 *
 * ── ONE-TIME SETUP ──────────────────────────────────────────────────────
 * 1. Go to https://script.google.com → New project. Name it
 *    "MNAB Shortcut Import". Replace the default Code.gs with this whole
 *    file. Save. (Not Extensions > Apps Script from the Sheet — that opens
 *    the bound project, which is the wrong place for this file.)
 * 2. Project Settings (gear icon) > Script Properties, in THIS project:
 *      MNAB_SHEET_ID      — the MNAB Sheet's ID: the long string between
 *                           /d/ and /edit in the Sheet's URL.
 *      ANTHROPIC_API_KEY  — your Anthropic API key (the same key the bound
 *                           project's EmailImport AI fallback uses is fine;
 *                           Script Properties aren't shared between
 *                           projects, so it has to be added here too).
 *      SHORTCUT_TOKEN     — a long random string you make up (e.g. from a
 *                           password generator, 32+ characters). The
 *                           Shortcut sends it with every request; anything
 *                           without it is rejected.
 *      SHORTCUT_MODEL     — optional. Claude model id. Defaults to
 *                           DEFAULT_SHORTCUT_MODEL below.
 * 3. Pick `testShortcutImportSetup` in the function dropdown and Run it once.
 *    It asks you to authorize Sheets + external requests, then logs whether
 *    the properties above are set and which account names it can see.
 * 4. Deploy > New deployment > type "Web app":
 *      Execute as:      Me
 *      Who has access:  Anyone
 *    SHORTCUT_TOKEN is what keeps strangers out, so keep it secret.
 *    Copy the Web app URL (ends in /exec) into the Shortcut.
 * 5. After pasting an UPDATED copy of this file later: Deploy > Manage
 *    deployments > edit (pencil) > Version: "New version" > Deploy. The /exec
 *    URL stays the same, but it keeps serving the old code until you do this.
 *    Deployer.gs can't do this one for you — it only updates the bound
 *    project.
 *
 * ── REQUEST / RESPONSE ──────────────────────────────────────────────────
 * POST JSON body:
 *   {
 *     "token":  "<SHORTCUT_TOKEN>",           required
 *     "image":  "<base64 JPEG or PNG>",       required
 *     "mediaType": "image/jpeg",              optional, sniffed if omitted
 *     "sof":    "mandiri",                    optional exact Accounts.Name,
 *                                             wins over anything read from
 *                                             the image
 *     "dryRun": true                          optional, parse and reply
 *                                             but write nothing
 *   }
 * Response (always HTTP 200, since Apps Script can't set status codes):
 *   { "ok": true|false, "message": "<one line for a notification>",
 *     "row": { ... } }
 *
 * ── DUPLICATES ──────────────────────────────────────────────────────────
 * Running the Shortcut twice on the same receipt is easy to do by accident.
 * When Claude can read a reference / transaction number off the receipt,
 * the row gets a dedupe key `shortcut:ref:<reference>` in the existing
 * 'Email Message ID' column (the import-dedupe column EmailImport.gs already
 * provisions and reads, so no new column). A second run with the same
 * reference is refused with a "already logged" message. Receipts with no
 * reference number fall back to date + time + amount + payee, and if there
 * isn't even a time on screen, no dedupe key is written (two identical
 * coffees on the same day are both real).
 *
 * The imported-vs-manual matching from EmailImport.gs (issue #51) also
 * applies: if you already typed the same transaction in by hand, both rows
 * get a shared Match ID / "Proposed" for you to confirm in the dashboard.
 *
 * ── BILLING MONTH ───────────────────────────────────────────────────────
 * Unlike EmailImport.gs's billingMonthGuess_() (credit-card rule only), this
 * looks up the SOF's Type on the Accounts tab and passes isCash explicitly
 * to scBillingMonthForDate_(), so cash/bank accounts get the 25th-to-24th
 * cycle. Blank/unknown type reads as cash, matching isCashAccountType() in
 * the dashboard. No SOF at all falls back to the credit-card rule, same as
 * EmailImport.gs. Written as 'MMMM yyyy', the same format EmailImport.gs
 * writes, and always just a guess to review.
 *
 * ── DATES ───────────────────────────────────────────────────────────────
 * Claude returns YYYY-MM-DD; it's turned into a Date from its local parts
 * (new Date(y, m - 1, d)), never `new Date('YYYY-MM-DD')`, which parses as
 * UTC. See the toISOString / timezone bug pattern in MNAB-project-state.md.
 */

var DEFAULT_SHORTCUT_MODEL = 'claude-haiku-4-5-20251001';
var SC_TRANSACTIONS_SHEET_NAME = 'transactions';
var SHORTCUT_ACCOUNTS_SHEET_NAME = 'Accounts';
var SC_LOCK_WAIT_MS = 30 * 1000;
var SHORTCUT_MAX_IMAGE_BASE64_CHARS = 6.5 * 1024 * 1024; // ~5 MB decoded — Claude's per-image limit

// ── WEB APP ENTRY POINTS ────────────────────────────────────────────────

// Health check. Opening the /exec URL in a browser should show this. It
// deliberately reveals nothing about the sheet. (Only safe because this is
// a standalone project — see "WHY THIS IS ITS OWN APPS SCRIPT PROJECT".)
function doGet() {
  return shortcutJson_({ ok: true, message: 'MNAB shortcut import is up. POST a screenshot to log a transaction.' });
}

function doPost(e) {
  try {
    if (shortcutIsBound_()) {
      return shortcutFail_('ShortcutImport.gs is inside the Sheet\'s own Apps Script project. It must be a separate standalone project (setup step 1).');
    }
    var req = parseShortcutRequest_(e);
    var props = PropertiesService.getScriptProperties();

    var expected = props.getProperty('SHORTCUT_TOKEN');
    if (!expected) return shortcutFail_('SHORTCUT_TOKEN is not set in Script Properties. See setup step 2 in ShortcutImport.gs.');
    if (!req.token || !shortcutSafeEquals_(String(req.token), expected)) return shortcutFail_('Wrong or missing token.');

    var apiKey = props.getProperty('ANTHROPIC_API_KEY');
    if (!apiKey) return shortcutFail_('ANTHROPIC_API_KEY is not set in Script Properties.');

    var image = normalizeShortcutImage_(req.image);
    if (!image) return shortcutFail_('No image in the request. Check the Shortcut sends the screenshot as base64 in "image".');
    if (image.length > SHORTCUT_MAX_IMAGE_BASE64_CHARS) {
      return shortcutFail_('Screenshot is too large for Claude (over 5 MB). Add a "Resize Image" step (width 1000) before encoding.');
    }
    var mediaType = req.mediaType || sniffShortcutMediaType_(image);

    var sheetId = props.getProperty('MNAB_SHEET_ID');
    if (!sheetId) return shortcutFail_('MNAB_SHEET_ID is not set in Script Properties.');
    var ss = SpreadsheetApp.openById(sheetId);
    var accounts = readShortcutAccounts_(ss);

    // The slow part (the Claude call, a few seconds) runs BEFORE taking the
    // lock, so a second Shortcut run isn't blocked by it.
    var extracted = callClaudeForReceipt_(apiKey, props.getProperty('SHORTCUT_MODEL') || DEFAULT_SHORTCUT_MODEL,
        image, mediaType, accounts);
    var row = buildShortcutRow_(extracted, accounts, req.sof);
    if (row.error) return shortcutFail_(row.error);

    if (req.dryRun === true || req.dryRun === 'true') {
      return shortcutJson_({ ok: true, message: '[Test] Would add: ' + shortcutSummary_(row), row: shortcutRowForReply_(row) });
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(SC_LOCK_WAIT_MS)) {
      return shortcutFail_('Another Shortcut import is still running. Try again in a minute.');
    }
    try {
      var sheet = ss.getSheetByName(SC_TRANSACTIONS_SHEET_NAME);
      if (!sheet) return shortcutFail_('Could not find a sheet tab named "' + SC_TRANSACTIONS_SHEET_NAME + '".');
      var headerMap = scEnsureImportColumns_(sheet);

      if (row.dedupeKey && scLoadImportedIds_(sheet, headerMap)[row.dedupeKey]) {
        return shortcutJson_({ ok: false, duplicate: true,
          message: 'Already logged: ' + shortcutSummary_(row) + '. Nothing added.', row: shortcutRowForReply_(row) });
      }

      var result = writeShortcutRow_(sheet, headerMap, row);
      return shortcutJson_({
        ok: true,
        message: 'Added (pending): ' + shortcutSummary_(row) + (result.matchedRow ? ' · possible match with a manual entry' : ''),
        row: shortcutRowForReply_(row)
      });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('ShortcutImport error: ' + (err && err.stack ? err.stack : err));
    return shortcutFail_('Error: ' + (err && err.message ? err.message : err));
  }
}

// Run by hand once from the editor (setup step 3).
function testShortcutImportSetup() {
  if (shortcutIsBound_()) {
    throw new Error('This project is bound to a spreadsheet. ShortcutImport.gs must live in its own standalone project — see setup step 1.');
  }
  var props = PropertiesService.getScriptProperties();
  Logger.log('MNAB_SHEET_ID set: ' + !!props.getProperty('MNAB_SHEET_ID'));
  Logger.log('ANTHROPIC_API_KEY set: ' + !!props.getProperty('ANTHROPIC_API_KEY'));
  Logger.log('SHORTCUT_TOKEN set: ' + !!props.getProperty('SHORTCUT_TOKEN') +
      (props.getProperty('SHORTCUT_TOKEN') && props.getProperty('SHORTCUT_TOKEN').length < 24 ? ' (short — use 32+ random characters)' : ''));
  Logger.log('Model: ' + (props.getProperty('SHORTCUT_MODEL') || DEFAULT_SHORTCUT_MODEL));
  var accounts = readShortcutAccounts_(SpreadsheetApp.openById(props.getProperty('MNAB_SHEET_ID')));
  Logger.log('Accounts visible (' + accounts.length + '): ' +
      accounts.map(function (a) { return a.name + ' [' + (a.isCash ? 'cash' : 'credit') + ']'; }).join(', '));
  // Touch UrlFetchApp so the authorization prompt includes external requests.
  UrlFetchApp.fetch('https://api.anthropic.com', { muteHttpExceptions: true });
  Logger.log('OK. Now deploy as a web app (setup step 4).');
}

// True when this code is running inside a container-bound project (e.g.
// someone pasted it into the MNAB Sheet's own Apps Script project).
function shortcutIsBound_() {
  try {
    return !!SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    return false;
  }
}

// ── REQUEST PARSING ─────────────────────────────────────────────────────

function parseShortcutRequest_(e) {
  var body = {};
  if (e && e.postData && e.postData.contents) {
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      body = {};
    }
  }
  // Also accept form fields / query params, in case the Shortcut is set to
  // "Form" instead of "JSON".
  var params = (e && e.parameter) || {};
  ['token', 'image', 'mediaType', 'sof', 'dryRun'].forEach(function (k) {
    if (body[k] === undefined && params[k] !== undefined) body[k] = params[k];
  });
  return body;
}

// Strips a data: URL prefix and any whitespace/newlines. The Shortcuts
// "Base64 Encode" action wraps lines every 76 chars by default.
function normalizeShortcutImage_(image) {
  if (!image) return '';
  var s = String(image);
  var comma = s.indexOf(',');
  if (s.indexOf('data:') === 0 && comma !== -1) s = s.slice(comma + 1);
  return s.replace(/\s+/g, '');
}

function sniffShortcutMediaType_(b64) {
  if (b64.indexOf('iVBOR') === 0) return 'image/png';
  if (b64.indexOf('/9j/') === 0) return 'image/jpeg';
  if (b64.indexOf('R0lGOD') === 0) return 'image/gif';
  if (b64.indexOf('UklGR') === 0) return 'image/webp';
  return 'image/jpeg'; // HEIC isn't accepted by Claude; the Shortcut converts to JPEG first
}

// Constant-time-ish compare, so the token can't be guessed a character at
// a time from response timing.
function shortcutSafeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── ACCOUNTS ────────────────────────────────────────────────────────────

// [{name, type, isCash}] from the Accounts tab. Read-only on purpose,
// unlike Reconciliations.gs's getAccountRows(), which self-provisions
// columns as a side effect.
function readShortcutAccounts_(ss) {
  var sheet = ss.getSheetByName(SHORTCUT_ACCOUNTS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var map = scHeaderIndexMap_(sheet); // 0-based
  if (map['Name'] === undefined) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var out = [];
  values.forEach(function (r) {
    var name = String(r[map['Name']] || '').trim();
    if (!name) return;
    var type = map['Type'] !== undefined ? String(r[map['Type']] || '') : '';
    out.push({ name: name, type: type, isCash: type.toLowerCase().indexOf('credit') === -1 });
  });
  return out;
}

function findShortcutAccount_(accounts, name) {
  if (!name) return null;
  var want = String(name).trim().toLowerCase();
  for (var i = 0; i < accounts.length; i++) {
    if (accounts[i].name.toLowerCase() === want) return accounts[i];
  }
  return null;
}

// ── CLAUDE ──────────────────────────────────────────────────────────────

function buildShortcutPrompt_(accounts) {
  var accountList = accounts.length
      ? accounts.map(function (a) { return '- ' + a.name + (a.type ? ' (' + a.type + ')' : ''); }).join('\n')
      : '(none available)';
  return [
    'This is a screenshot of a single transaction receipt / transaction detail screen from an Indonesian banking or e-wallet app.',
    'Extract it into JSON. Respond with ONLY the JSON object, no other text, no code fences.',
    '',
    'Fields:',
    '- isTransaction: boolean. false if the screen is not a single transaction receipt/detail (e.g. a home screen, a list of many transactions, a login screen).',
    '- status: "success", "failed" or "pending". Use "failed" for Gagal/Failed/Ditolak, "pending" for Tertunda/Diproses/Pending/Processing.',
    '- type: "Expense" for money leaving the account (payment, purchase, transfer out, top-up of another wallet, fee); "Income" for money coming in (transfer in, refund, cashback, interest).',
    '- amount: integer rupiah, the total actually debited/credited including any admin fee. Indonesian formatting uses "." for thousands and "," for decimals: "Rp 43.000,00" is 43000, "Rp 1.250.000" is 1250000. No symbols or separators in the output.',
    '- date: "YYYY-MM-DD" transaction date as shown. Indonesian month names: Januari, Februari, Maret, April, Mei, Juni, Juli, Agustus, September, Oktober, November, Desember (abbreviations like Agu, Okt, Des too).',
    '- time: "HH:mm" 24h if shown, else null.',
    '- payee: the merchant / recipient / sender as displayed (for Income, who the money came from). Keep the name the app shows; drop generic prefixes like "Pembayaran ke" but keep merchant names intact.',
    '- bank: which app/bank this is from: "mandiri" (Livin\' by Mandiri), "ocbc" (OCBC mobile / ONe Mobile), "jago" (Bank Jago), or "other".',
    '- accountLast4: last 4 digits of the SOURCE card or account number shown (the user\'s own account, not the recipient\'s), or null.',
    '- sof: the user\'s own account this was paid from / received into, chosen from the list below, copied EXACTLY; null if you can\'t tell with confidence.',
    '- reference: the reference / transaction / receipt number (No. Referensi, Ref No, ID Transaksi, etc.), or null.',
    '- category: one Indonesian category label, e.g. "Makanan dan Minuman", "Transportasi", "Belanja dan Servis", "Tagihan", "Kesehatan", "Hiburan", "Pendidikan", "Transfer", "Top Up", "Lainnya".',
    '- description: a short plain note of what this was (e.g. "QRIS payment", "BI-FAST transfer", "GoPay top-up"), max ~8 words.',
    '- confidence: "high", "medium" or "low" for the amount and date together.',
    '',
    'The user\'s accounts:',
    accountList,
    '',
    'If isTransaction is false, still return the object with the other fields null.'
  ].join('\n');
}

function callClaudeForReceipt_(apiKey, model, imageB64, mediaType, accounts) {
  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: model,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
          { type: 'text', text: buildShortcutPrompt_(accounts) }
        ]
      }]
    }),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) {
    var apiMsg = text;
    try { apiMsg = JSON.parse(text).error.message; } catch (ignore) {}
    throw new Error('Claude API ' + code + ': ' + String(apiMsg).substring(0, 200));
  }
  var body = JSON.parse(text);
  var reply = (body.content || []).filter(function (c) { return c.type === 'text'; })
      .map(function (c) { return c.text; }).join('');
  return parseShortcutJson_(reply);
}

// Tolerates code fences or stray prose around the object.
function parseShortcutJson_(reply) {
  var s = String(reply || '');
  var start = s.indexOf('{');
  var end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Claude did not return JSON: ' + s.substring(0, 120));
  return JSON.parse(s.slice(start, end + 1));
}

// ── ROW BUILDING ────────────────────────────────────────────────────────

// Returns the row object for writeShortcutRow_(), or {error: '...'} when
// there's nothing sensible to write.
function buildShortcutRow_(x, accounts, sofOverride) {
  if (!x || x.isTransaction === false) {
    return { error: 'That screen doesn\'t look like a single transaction receipt. Open the transaction detail and try again.' };
  }

  var amount = Math.round(Math.abs(Number(x.amount) || 0));
  var date = parseShortcutDate_(x.date);
  if (!date) return { error: 'Couldn\'t read the date off the receipt. Nothing added.' };
  if (!amount && x.status !== 'failed') return { error: 'Couldn\'t read the amount off the receipt. Nothing added.' };

  var type = x.type === 'Income' ? 'Income' : 'Expense';
  var sof = resolveShortcutSof_(x, accounts, sofOverride);
  var account = findShortcutAccount_(accounts, sof);
  // No SOF → credit-card rule, same fallback as EmailImport.gs; an unknown
  // Type on a known account reads as cash (isCashAccountType convention).
  var isCash = account ? account.isCash : false;
  var month = Utilities.formatDate(scBillingMonthForDate_(date, isCash), Session.getScriptTimeZone(), 'MMMM yyyy');

  var payee = String(x.payee || '').trim() || 'Unknown payee';
  var noteParts = [];
  if (x.category) noteParts.push(String(x.category).trim());
  if (x.description) noteParts.push(String(x.description).trim());
  if (x.reference) noteParts.push('Ref ' + String(x.reference).trim());
  if (x.time) noteParts.push(String(x.time).trim());
  if (!sof && x.accountLast4) noteParts.push('account ending ' + x.accountLast4 + ' not mapped — pick SOF by hand');
  if (x.confidence === 'low') noteParts.push('LOW CONFIDENCE — check amount/date');

  if (x.status === 'failed') {
    payee = '[FAILED] ' + payee;
    noteParts.unshift('Attempted ' + scFormatIdr_(amount) + ', receipt shows failed — no money moved');
    amount = 0;
  } else if (x.status === 'pending') {
    noteParts.push('receipt showed Tertunda/pending');
  }
  noteParts.push('(Shortcut import — AI-parsed, verify)');

  return {
    payee: payee,
    type: type,
    sof: sof,
    date: date,
    month: month,
    amount: amount,
    notes: noteParts.join('. ').replace(/\.\./g, '.'),
    dedupeKey: shortcutDedupeKey_(x, date, amount, payee)
  };
}

// Priority: explicit `sof` from the Shortcut (if it's a real account) →
// the last-4 maps copied from EmailImport.gs → Jago's single account →
// Claude's pick from the account list (only if it's an exact name) → blank.
function resolveShortcutSof_(x, accounts, sofOverride) {
  var byOverride = findShortcutAccount_(accounts, sofOverride);
  if (byOverride) return byOverride.name;

  var last4 = x.accountLast4 ? String(x.accountLast4).replace(/\D/g, '').slice(-4) : '';
  var bank = String(x.bank || '').toLowerCase();
  if (last4) {
    if (bank === 'mandiri' && SC_MANDIRI_SOF_MAP[last4]) return SC_MANDIRI_SOF_MAP[last4];
    if (bank === 'ocbc' && SC_OCBC_SOF_MAP[last4]) return SC_OCBC_SOF_MAP[last4];
    if (bank !== 'mandiri' && bank !== 'ocbc') {
      if (SC_MANDIRI_SOF_MAP[last4]) return SC_MANDIRI_SOF_MAP[last4];
      if (SC_OCBC_SOF_MAP[last4]) return SC_OCBC_SOF_MAP[last4];
    }
  }
  if (bank === 'jago') return SC_JAGO_SOF;

  var byClaude = findShortcutAccount_(accounts, x.sof);
  return byClaude ? byClaude.name : '';
}

function parseShortcutDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1) return null; // rejects 2026-02-31
  return d;
}

function shortcutDedupeKey_(x, date, amount, payee) {
  var ref = x.reference ? String(x.reference).replace(/\s+/g, '').toUpperCase() : '';
  if (ref) return 'shortcut:ref:' + ref;
  if (x.time) {
    return 'shortcut:' + Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd') + 'T' +
        String(x.time).trim() + '|' + amount + '|' + payee.toLowerCase();
  }
  return '';
}

// ── SHEET WRITE ─────────────────────────────────────────────────────────

// Same column set and Pending/Match semantics as EmailImport.gs's
// writeRow_(), but with the account-aware Month from buildShortcutRow_()
// and batched writes instead of one setValue() per cell.
function writeShortcutRow_(sheet, headerMap, row) {
  var isExpense = row.type === 'Expense';
  var matchedRow = scFindManualMatch_(sheet, headerMap, row.sof, row.amount, row.date, row.type);
  var matchId = matchedRow ? scGenerateMatchId_() : '';

  var values = {
    'Payee': row.payee,
    'Income/Expense': row.type,
    'SOF': row.sof || '',
    'Date': row.date,
    'Month': row.month,
    'Cleared': false,
    'Amount': row.amount,
    'Expense': isExpense ? row.amount : 0,
    'Income': isExpense ? 0 : row.amount,
    'Total': isExpense ? row.amount : -row.amount,
    'Notes': row.notes,
    'Pending': true,
    'Reconciled': false,
    'Email Message ID': row.dedupeKey || '',
    'Match ID': matchId,
    'Match Status': matchedRow ? 'Proposed' : ''
  };

  // Only the columns we have a value for are written, grouped into runs of
  // adjacent columns (one setValues() per run). Columns in between that
  // this script doesn't own are left untouched, so a per-row formula there
  // survives.
  var byCol = {};
  Object.keys(values).forEach(function (header) {
    var col = headerMap[header];
    if (col) byCol[col] = values[header];
  });
  var cols = Object.keys(byCol).map(Number).sort(function (a, b) { return a - b; });
  if (!cols.length) throw new Error('None of the expected columns were found on ' + SC_TRANSACTIONS_SHEET_NAME + '.');

  var newRow = sheet.getLastRow() + 1;
  var runStart = 0;
  for (var i = 1; i <= cols.length; i++) {
    if (i === cols.length || cols[i] !== cols[i - 1] + 1) {
      var run = cols.slice(runStart, i).map(function (c) { return byCol[c]; });
      sheet.getRange(newRow, cols[runStart], 1, run.length).setValues([run]);
      runStart = i;
    }
  }

  if (matchedRow) {
    if (headerMap['Match ID']) sheet.getRange(matchedRow, headerMap['Match ID']).setValue(matchId);
    if (headerMap['Match Status']) sheet.getRange(matchedRow, headerMap['Match Status']).setValue('Proposed');
  }
  return { rowIndex: newRow, matchedRow: matchedRow };
}

// ── REPLIES ─────────────────────────────────────────────────────────────

function shortcutSummary_(row) {
  var d = Utilities.formatDate(row.date, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  return (row.type === 'Income' ? '+' : '') + scFormatIdr_(row.amount) + ' · ' + row.payee + ' · ' +
      (row.sof || 'no SOF') + ' · ' + d;
}

function shortcutRowForReply_(row) {
  return {
    payee: row.payee,
    type: row.type,
    sof: row.sof,
    date: Utilities.formatDate(row.date, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
    month: row.month,
    amount: row.amount,
    notes: row.notes
  };
}

function shortcutFail_(message) {
  return shortcutJson_({ ok: false, message: message });
}

function shortcutJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── COPIED HELPERS ──────────────────────────────────────────────────────
// Copies, not shared code — this project can't see the bound project's
// globals (see "WHY THIS IS ITS OWN APPS SCRIPT PROJECT" up top). Keep them
// in step with the originals named on each one.

// From EmailImport.gs (MANDIRI_SOF_MAP / OCBC_SOF_MAP / JAGO_SOF): last-4 of
// the card, or of the account number when no card is involved → exact
// Accounts.Name. Add new cards in BOTH places.
var SC_MANDIRI_SOF_MAP = {
  '2166': 'mandiri platinum',
  '2892': 'mandiri 2892',
  '2069': 'mandiri golf',
  '0875': 'mandiri'
};

var SC_OCBC_SOF_MAP = {
  '4226': 'ocbc 90.N',
  '9376': 'ocbc platinum'
};

var SC_JAGO_SOF = 'jago';

// From EmailImport.gs (IMPORT_COLUMNS / ensureImportColumns_): header →
// 1-based column map, auto-provisioning the import columns if missing.
var SC_IMPORT_COLUMNS = ['Pending', 'Email Message ID', 'Match ID', 'Match Status'];

function scEnsureImportColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i + 1; });

  SC_IMPORT_COLUMNS.forEach(function (name) {
    if (!map[name]) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue(name);
      map[name] = newCol;
      Logger.log('Auto-provisioned a new "' + name + '" column on transactions at position ' + newCol + '.');
    }
  });
  return map;
}

// From EmailImport.gs (loadImportedMessageIds_): every value already in the
// 'Email Message ID' column, as a lookup.
function scLoadImportedIds_(sheet, headerMap) {
  var ids = {};
  var col = headerMap['Email Message ID'];
  var lastRow = sheet.getLastRow();
  if (!col || lastRow < 2) return ids;
  sheet.getRange(2, col, lastRow - 1, 1).getValues().forEach(function (r) {
    if (r[0]) ids[String(r[0]).trim()] = true;
  });
  return ids;
}

// From EmailImport.gs (MATCH_WINDOW_DAYS / generateMatchId_ /
// findManualMatch_, issue #51): exactly one existing MANUAL row (Pending not
// TRUE, no Match ID yet) with the same SOF, Amount and type, dated within
// two days → its 1-based row number; zero or ambiguous → null.
var SC_MATCH_WINDOW_DAYS = 2;

function scGenerateMatchId_() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function scFindManualMatch_(sheet, headerMap, sof, amount, date, type) {
  if (!sof || !amount || !(date instanceof Date) || isNaN(date.getTime())) return null;

  var sofCol = headerMap['SOF'];
  var amountCol = headerMap['Amount'];
  var dateCol = headerMap['Date'];
  var pendingCol = headerMap['Pending'];
  if (!sofCol || !amountCol || !dateCol || !pendingCol) return null;

  var typeCol = headerMap['Income/Expense'];
  var matchIdCol = headerMap['Match ID'];

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
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
    if (pendingValues[i][0] === true) continue;
    if (matchIdValues && matchIdValues[i][0]) continue;
    if (sofValues[i][0] !== sof) continue;
    if (Number(amountValues[i][0]) !== Number(amount)) continue;
    if (typeValues && (typeValues[i][0] || 'Expense') !== (type || 'Expense')) continue;

    var rDate = dateValues[i][0];
    if (!(rDate instanceof Date) || isNaN(rDate.getTime())) continue;
    var rTime = new Date(rDate.getFullYear(), rDate.getMonth(), rDate.getDate()).getTime();
    if (Math.abs(rTime - targetTime) > SC_MATCH_WINDOW_DAYS * dayMs) continue;

    matches.push(2 + i);
  }

  return matches.length === 1 ? matches[0] : null;
}

// From EmailImport.gs (formatIdr_).
function scFormatIdr_(amount) {
  return 'Rp ' + (Number(amount) || 0).toLocaleString('id-ID');
}

// From Reconciliations.gs (headerIndexMap): header → 0-based column index.
function scHeaderIndexMap_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) {
    if (h) map[String(h).trim()] = i;
  });
  return map;
}

// From Reconciliations.gs (billingMonthForDate / firstOfMonth), returns the
// first of the billing month. Credit cards: day 1–12 → this month, 13+ →
// next. Cash/bank: day 1–24 → previous month, 25+ → this month. Snaps to
// day 1 BEFORE moving the month (the billing-month overflow bug).
function scBillingMonthForDate_(date, isCash) {
  var d = new Date(date.getFullYear(), date.getMonth(), 1);
  var day = date.getDate();
  if (isCash) {
    if (day < 25) d.setMonth(d.getMonth() - 1);
  } else if (day > 12) {
    d.setMonth(d.getMonth() + 1);
  }
  return d;
}
