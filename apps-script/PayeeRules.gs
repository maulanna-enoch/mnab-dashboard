/**
 * PayeeRules.gs — rename / tidy email-imported transactions with rules
 * you keep in a sheet tab.
 *
 * WHY: bank emails name a merchant however the bank's system cuts it —
 * "DANA QROFF * FamilyM", "DANA QR * ESB Restau" — and the parsers in
 * EmailImport.gs add their own boilerplate to Notes. Rather than a new
 * parser change for every merchant, the rules live in a `PayeeRules` tab
 * you edit yourself, and EmailImport.gs applies them as each row is
 * written.
 *
 * ── THE TAB ─────────────────────────────────────────────────────────────
 * Finances > Setup > Payee Rules… creates it (and adds starter DANA rules
 * if it's empty). One rule per row. Rules are checked from the lowest
 * Order up, and the FIRST rule that matches wins; nothing after it runs.
 *
 *   Order       number. Lower runs first. Put specific rules above
 *               general ones (e.g. "DANA … ESB" at 40, "DANA … anything"
 *               at 50). Blank = after every numbered rule.
 *   Active      checkbox. Only ticked rules run.
 *   Source      any | mandiri | ocbc | jago — which bank's emails. Blank
 *               = any. ("mnab/ocbc" works too.)
 *   SOF         only rows for this exact account (Accounts.Name). Blank
 *               = any account.
 *   Match On    payee | notes | either — which text the pattern is
 *               checked against. This is the text the PARSER produced,
 *               before any rule. Blank = payee.
 *   Match Type  equals | contains | starts with | regex. Always ignores
 *               upper/lower case and repeated spaces.
 *   Pattern     the text (or regex) to look for.
 *   Set Payee   the new Payee. Blank = keep the parsed payee.
 *   Set Notes   the new Notes. Blank = keep the parsed notes as before.
 *               A single "-" = empty Notes. When a rule sets Notes, the
 *               " (Auto-imported)" suffix is not added — the rule's text
 *               is used as is. (Pending + Email Message ID still mark the
 *               row as imported.)
 *   Transfer    TRUE / FALSE sets the row's Transfer flag. Blank = keep.
 *   Comment     yours; ignored by the script.
 *
 * TOKENS you can use in Set Payee / Set Notes:
 *   {payee} {notes}  the parser's original payee / notes
 *   {sof}            the account
 *   {amount}         "Rp 25.000"
 *   {1} {2} … {9}    regex rules only: the text caught by the 1st, 2nd …
 *                    pair of ( ) in Pattern, counted from the left.
 *                    A (?: ) group is NOT counted. A group that caught
 *                    nothing becomes empty.
 *   A token this file doesn't know (a typo) is left in as written, so
 *   you'll see it in the row.
 *
 *   Example: Pattern ^DANA QR(?:OFF)?\s*\*\s*(.+)$  Set Payee DANA - {1}
 *     "DANA QROFF * FamilyM" → "DANA - FamilyM"
 *
 * ── WHAT RULES NEVER TOUCH ──────────────────────────────────────────────
 *   - [NEEDS REVIEW] / [FAILED TRANSFER] / [NO RECEIPT] rows — a rule must
 *     not be able to hide a warning.
 *   - Grab card charges ("Grab* A-…"). The Grab receipt matcher finds its
 *     row by that exact text, and the receipt then sets a better payee
 *     than a rule could.
 *   - Both legs of a card payment ("Payment to … / Payment from …") —
 *     those names are generated, not bank text.
 *   - Amount, date, account, Income/Expense. Rules only change Payee,
 *     Notes and Transfer.
 *
 * ── NOTHING IS LOST ─────────────────────────────────────────────────────
 * Every email-imported row gets a `Raw Import` cell holding what the
 * parser produced, one item per line: source label, payee, notes. And a
 * `Payee Rule` cell with the Order of the rule that fired ("#50"), blank
 * if none did. Both columns are added to `transactions` automatically.
 *
 * ── CHANGING RULES LATER ────────────────────────────────────────────────
 * Rules apply as rows are imported. To run your current rules over rows
 * already in the sheet: Finances > Apply Payee Rules to All Rows….
 * It goes over EVERY row in transactions: pending, confirmed, cleared and
 * reconciled, from an email or not (Grab-enriched rows and the warning
 * rows above are still skipped). Rules only change Payee, Notes and
 * Transfer, never an amount, so balances and reconciliations don't move.
 * A row is only touched when a rule matches it, or when a rule changed it
 * before and no rule matches any more (then it goes back to its Raw
 * Import text). Rows no rule has ever matched are left as they are, hand
 * edits included. The first time a rule changes a row that has no Raw
 * Import yet, its current text is saved there first. It shows every
 * change and asks before writing anything.
 *
 * A broken rule (bad regex, unknown Match Type, no Pattern) is skipped
 * and named in the log / that dialog. It never stops an import.
 *
 * ── INSTALL ─────────────────────────────────────────────────────────────
 * Paste this as a NEW script file named `PayeeRules` (Deployer only
 * replaces files that already exist), then paste the updated
 * EmailImport.gs and Reconciliations.gs (menu items). Reload the sheet,
 * then run Finances > Setup > Payee Rules… once.
 */

var PAYEE_RULES_SHEET_NAME = 'PayeeRules';
var PAYEE_RULES_HEADERS = ['Order', 'Active', 'Source', 'SOF', 'Match On', 'Match Type',
  'Pattern', 'Set Payee', 'Set Notes', 'Transfer', 'Comment'];
var PAYEE_RULES_SOURCES = ['any', 'mandiri', 'ocbc', 'jago'];
var PAYEE_RULES_MATCH_ON = ['payee', 'notes', 'either'];
var PAYEE_RULES_MATCH_TYPES = ['equals', 'contains', 'starts with', 'regex'];
var PAYEE_RULES_SKIP_RE = /^\s*(\[NEEDS REVIEW\]|\[FAILED TRANSFER\]|\[NO RECEIPT\]|grab\s*\*|payment (to|from) )/i;
var RAW_IMPORT_COLUMN = 'Raw Import';
var PAYEE_RULE_COLUMN = 'Payee Rule';
var AUTO_IMPORTED_SUFFIX = ' (Auto-imported)';
var PAYEE_RULES_PREVIEW_MAX = 25;

// Starter rules written by setupPayeeRules() into an empty tab.
var PAYEE_RULES_STARTERS = [
  [40, true, 'any', '', 'payee', 'regex', '^DANA QR(?:OFF)?\\s*\\*\\s*ESB', 'DANA - ESB Restaurant', '', '', 'ESB is a restaurant POS — the restaurant itself isn\'t in the email'],
  [41, true, 'any', '', 'payee', 'regex', '^DANA QR(?:OFF)?\\s*\\*\\s*FamilyM', 'DANA - FamilyMart', '', '', ''],
  [50, true, 'any', '', 'payee', 'regex', '^DANA QR(?:OFF)?\\s*\\*\\s*(.+)$', 'DANA - {1}', '', '', 'Catch-all for DANA QRIS; add specific rules above it']
];

// Rules for the current import run. Loaded once on first use, cleared by
// resetPayeeRulesCache_() at the start of each runImportPass_.
var payeeRulesCache_ = null;

function resetPayeeRulesCache_() {
  payeeRulesCache_ = null;
}

// ── Loading ──────────────────────────────────────────────────────────────

// Returns {rules: [...], errors: ['Row 5: …']}. A missing tab = no rules.
function loadPayeeRules_(ss) {
  var sheet = (ss || SpreadsheetApp.getActiveSpreadsheet()).getSheetByName(PAYEE_RULES_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return { rules: [], errors: [] };
  var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  return parsePayeeRules_(values);
}

// Pure: header row + data rows (as getValues() returns them) → rules.
function parsePayeeRules_(values) {
  var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  function col(name) { return headers.indexOf(name.toLowerCase()); }
  var c = {};
  PAYEE_RULES_HEADERS.forEach(function (h) { c[h] = col(h); });
  function get(row, h) { return c[h] === -1 ? '' : row[c[h]]; }

  var rules = [];
  var errors = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var rowNum = i + 1;
    var pattern = String(get(row, 'Pattern') == null ? '' : get(row, 'Pattern'));
    var active = get(row, 'Active');
    if (!(active === true || String(active).trim().toUpperCase() === 'TRUE')) continue;
    if (!pattern.trim()) {
      errors.push('Row ' + rowNum + ': no Pattern — skipped.');
      continue;
    }

    var matchType = String(get(row, 'Match Type') || 'contains').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (matchType === 'startswith') matchType = 'starts with';
    if (PAYEE_RULES_MATCH_TYPES.indexOf(matchType) === -1) {
      errors.push('Row ' + rowNum + ': unknown Match Type "' + get(row, 'Match Type') + '" — skipped.');
      continue;
    }

    var matchOn = String(get(row, 'Match On') || 'payee').trim().toLowerCase();
    if (PAYEE_RULES_MATCH_ON.indexOf(matchOn) === -1) {
      errors.push('Row ' + rowNum + ': unknown Match On "' + get(row, 'Match On') + '" — skipped.');
      continue;
    }

    var re = null;
    if (matchType === 'regex') {
      try {
        re = new RegExp(pattern.trim(), 'i');
      } catch (err) {
        errors.push('Row ' + rowNum + ': invalid regex /' + pattern + '/ (' + err.message + ') — skipped.');
        continue;
      }
    }

    var orderRaw = get(row, 'Order');
    var order = orderRaw === '' || orderRaw == null || isNaN(Number(orderRaw)) ? Infinity : Number(orderRaw);

    rules.push({
      rowNum: rowNum,
      order: order,
      label: order === Infinity ? 'row ' + rowNum : '#' + order,
      source: normalizeRuleSource_(get(row, 'Source')),
      sof: String(get(row, 'SOF') || '').trim().toLowerCase(),
      matchOn: matchOn,
      matchType: matchType,
      pattern: matchType === 'regex' ? pattern.trim() : normalizeRuleText_(pattern).toLowerCase(),
      re: re,
      setPayee: String(get(row, 'Set Payee') == null ? '' : get(row, 'Set Payee')),
      setNotes: String(get(row, 'Set Notes') == null ? '' : get(row, 'Set Notes')),
      transfer: parseRuleTransfer_(get(row, 'Transfer'))
    });
  }

  rules.sort(function (a, b) {
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
    return a.rowNum - b.rowNum;
  });
  return { rules: rules, errors: errors };
}

function normalizeRuleSource_(v) {
  var s = String(v || '').trim().toLowerCase().replace(/^mnab\//, '');
  return s === 'any' ? '' : s;
}

function normalizeRuleText_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function parseRuleTransfer_(v) {
  if (v === true) return true;
  if (v === false) return false;
  var s = String(v || '').trim().toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  return null;
}

// ── Matching (pure — no Sheet/Gmail calls, testable on its own) ─────────

// input: {source: 'mnab/ocbc' | 'ocbc', sof, payee, notes, amount}
// Returns null when no rule fires, else
//   {rule, payee, notes (null = keep), transfer (null = keep)}.
function matchPayeeRule_(rules, input) {
  var payee = normalizeRuleText_(input.payee);
  if (PAYEE_RULES_SKIP_RE.test(payee)) return null;
  var notes = normalizeRuleText_(input.notes);
  var source = normalizeRuleSource_(input.source);
  var sof = String(input.sof || '').trim().toLowerCase();

  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (r.source && r.source !== source) continue;
    if (r.sof && r.sof !== sof) continue;

    var targets = r.matchOn === 'payee' ? [payee] : r.matchOn === 'notes' ? [notes] : [payee, notes];
    var groups = null;
    for (var t = 0; t < targets.length && !groups; t++) groups = testRule_(r, targets[t]);
    if (!groups) continue;

    var ctx = { payee: payee, notes: notes, sof: input.sof || '', amount: input.amount };
    var newPayee = normalizeRuleText_(renderRuleTemplate_(r.setPayee, ctx, groups));
    var notesTpl = r.setNotes.trim();
    var newNotes = notesTpl === '' ? null
        : notesTpl === '-' ? ''
        : normalizeRuleText_(renderRuleTemplate_(r.setNotes, ctx, groups));
    return {
      rule: r,
      payee: newPayee || payee, // a rule can't blank the payee
      notes: newNotes,
      transfer: r.transfer
    };
  }
  return null;
}

// Returns the regex groups array (index 0 = whole match) or null.
function testRule_(rule, text) {
  if (rule.re) return text.match(rule.re);
  var hay = text.toLowerCase();
  var ok = rule.matchType === 'equals' ? hay === rule.pattern
      : rule.matchType === 'starts with' ? hay.indexOf(rule.pattern) === 0
      : hay.indexOf(rule.pattern) !== -1;
  return ok ? [text] : null;
}

function renderRuleTemplate_(tpl, ctx, groups) {
  return String(tpl || '').replace(/\{([a-z]+|\d)\}/gi, function (whole, key) {
    if (/^\d$/.test(key)) {
      var n = Number(key);
      if (n === 0) return groups[0] || '';
      return groups.length > n && groups[n] != null ? groups[n] : '';
    }
    switch (key.toLowerCase()) {
      case 'payee': return ctx.payee;
      case 'notes': return ctx.notes;
      case 'sof': return ctx.sof;
      case 'amount': return formatRuleIdr_(ctx.amount);
      default: return whole; // unknown token: leave visible
    }
  });
}

function formatRuleIdr_(amount) {
  var n = Math.round(Number(amount) || 0);
  return 'Rp ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ── Raw Import cell ──────────────────────────────────────────────────────
// Three lines: source label, parser payee, parser notes.

function buildRawImport_(source, payee, notes) {
  var src = String(source || '');
  if (src && src.indexOf('mnab/') !== 0) src = 'mnab/' + src;
  return [src, String(payee || ''), String(notes || '')].join('\n').replace(/\n+$/, '');
}

function parseRawImport_(cell) {
  var lines = String(cell || '').split('\n');
  if (lines.length < 2 || !/^mnab\//.test(lines[0])) return null;
  return { source: lines[0], payee: lines[1] || '', notes: lines.slice(2).join(' ') };
}

// ── Import-time entry point (called by EmailImport.gs handleMessage_) ───

// parsed: what a LABEL_PARSERS function (or the AI fallback) returned.
// Returns the fields writeRow_ needs: {payee, notes, transfer, raw,
// payeeRule}. With no rule, payee/notes/transfer are exactly what
// handleMessage_ wrote before this file existed.
function applyPayeeRulesForImport_(parsed, labelKey) {
  if (!payeeRulesCache_) {
    try {
      payeeRulesCache_ = loadPayeeRules_();
      payeeRulesCache_.errors.forEach(function (e) { Logger.log('PayeeRules: ' + e); });
    } catch (err) {
      Logger.log('PayeeRules: could not read the ' + PAYEE_RULES_SHEET_NAME + ' tab (' + err + ') — importing without rules.');
      payeeRulesCache_ = { rules: [], errors: [] };
    }
  }
  return resolvePayeeRuleFields_(payeeRulesCache_.rules, parsed, labelKey);
}

// Pure core of the above.
function resolvePayeeRuleFields_(rules, parsed, labelKey) {
  var parsedNotes = parsed.notes || '';
  var out = {
    payee: parsed.payee,
    notes: parsedNotes + AUTO_IMPORTED_SUFFIX,
    transfer: !!parsed.transfer,
    raw: buildRawImport_(labelKey, parsed.payee, parsedNotes),
    payeeRule: ''
  };
  var hit;
  try {
    hit = matchPayeeRule_(rules, {
      source: labelKey, sof: parsed.sof, payee: parsed.payee, notes: parsedNotes, amount: parsed.amount
    });
  } catch (err) {
    Logger.log('PayeeRules: error while matching "' + parsed.payee + '" (' + err + ') — imported unchanged.');
    hit = null;
  }
  if (!hit) return out;
  out.payee = hit.payee;
  if (hit.notes !== null) out.notes = hit.notes;
  if (hit.transfer !== null) out.transfer = hit.transfer;
  out.payeeRule = hit.rule.label;
  Logger.log('PayeeRules ' + hit.rule.label + ': "' + parsed.payee + '" → "' + out.payee + '"');
  return out;
}

// ── Re-apply to rows already in the sheet ───────────────────────────────

// SOF → source label, for old rows that have no Raw Import yet.
function sourceForSof_(sof) {
  var s = String(sof || '').trim().toLowerCase();
  if (!s) return '';
  var found = '';
  Object.keys(MANDIRI_SOF_MAP).forEach(function (k) { if (MANDIRI_SOF_MAP[k].toLowerCase() === s) found = 'mnab/mandiri'; });
  if (found) return found;
  Object.keys(OCBC_SOF_MAP).forEach(function (k) { if (OCBC_SOF_MAP[k].toLowerCase() === s) found = 'mnab/ocbc'; });
  if (found) return found;
  if (s === 'ocbc') return 'mnab/ocbc';
  if (s === String(JAGO_SOF).toLowerCase()) return 'mnab/jago';
  return '';
}

function isTruthyCell_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

// Notes a rule-free row would have: what the import writes (parser notes
// + the " (Auto-imported)" suffix) for email rows, the text as is for
// anything else.
function defaultRuleNotes_(raw, isEmail) {
  return isEmail ? raw.notes + AUTO_IMPORTED_SUFFIX : raw.notes;
}

// Notes to fall back on when the matching rule (if any) sets none: the
// row's current Notes if they're still the raw text (with or without the
// suffix), otherwise — an earlier rule replaced them — the raw text.
function restoreRuleNotes_(currentNotes, raw, isEmail) {
  var stripped = currentNotes.slice(-AUTO_IMPORTED_SUFFIX.length) === AUTO_IMPORTED_SUFFIX
      ? currentNotes.slice(0, -AUTO_IMPORTED_SUFFIX.length) : currentNotes;
  if (stripped === raw.notes || currentNotes.trim() === AUTO_IMPORTED_SUFFIX.trim() && raw.notes === '') return currentNotes;
  return defaultRuleNotes_(raw, isEmail);
}

// Pure: works out every change, over EVERY row in transactions — pending,
// confirmed, cleared and reconciled, from email or not. rows: [{rowNum,
// payee, notes, sof, amount, messageId, receiptId, raw, payeeRule,
// transfer}]. Returns [{rowNum, before:{…}, after:{…}, rawToSave (string
// or null), changed: true}] for rows whose values would change.
//
// A row is only touched when:
//   - a rule matches it now (Payee/Notes/Transfer set by the rule; the
//     pre-rule text is saved to Raw Import the first time, so a later
//     rule change can put it back), or
//   - a rule changed it before (Payee Rule filled in) and no rule matches
//     any more: it goes back to its Raw Import text.
// A row no rule has ever touched is left exactly as it is, so hand edits
// on rows the rules don't cover are never overwritten.
function planPayeeRuleChanges_(rules, rows) {
  var changes = [];
  rows.forEach(function (r) {
    if (String(r.receiptId || '').trim()) return; // Grab-enriched
    var isEmail = !!String(r.messageId || '').trim();
    var currentPayee = String(r.payee || '');
    if (!currentPayee.trim()) return;

    var raw = parseRawImport_(r.raw);
    var hadRaw = !!raw;
    if (!raw) {
      // No pre-rule text saved yet: today's values are the raw text.
      var notes = String(r.notes || '');
      if (isEmail) {
        if (notes.slice(-AUTO_IMPORTED_SUFFIX.length) === AUTO_IMPORTED_SUFFIX) {
          notes = notes.slice(0, -AUTO_IMPORTED_SUFFIX.length);
        } else if (notes === AUTO_IMPORTED_SUFFIX.trim()) {
          notes = '';
        }
      }
      raw = { source: sourceForSof_(r.sof) || 'mnab/other', payee: currentPayee, notes: notes };
    }
    if (PAYEE_RULES_SKIP_RE.test(raw.payee) || PAYEE_RULES_SKIP_RE.test(currentPayee)) return;

    var before = {
      payee: currentPayee, notes: String(r.notes || ''),
      transfer: isTruthyCell_(r.transfer), payeeRule: String(r.payeeRule || '')
    };
    var ruledBefore = hadRaw && before.payeeRule !== '';

    var hit = null;
    try {
      hit = matchPayeeRule_(rules, {
        source: raw.source, sof: r.sof, payee: raw.payee, notes: raw.notes, amount: r.amount
      });
    } catch (err) {
      hit = null;
    }

    var after;
    if (hit) {
      // Notes the rule doesn't set: the raw text if an earlier rule had
      // replaced them, otherwise whatever the row has now.
      var baseNotes = ruledBefore ? restoreRuleNotes_(before.notes, raw, isEmail) : before.notes;
      after = {
        payee: hit.payee,
        notes: hit.notes !== null ? hit.notes : baseNotes,
        transfer: hit.transfer !== null ? hit.transfer : before.transfer,
        payeeRule: hit.rule.label
      };
    } else if (ruledBefore) {
      after = { payee: raw.payee, notes: restoreRuleNotes_(before.notes, raw, isEmail), transfer: before.transfer, payeeRule: '' };
    } else {
      return; // no rule now, none before: leave it alone
    }

    var changed = before.payee !== after.payee || before.notes !== after.notes ||
        before.transfer !== after.transfer || before.payeeRule !== after.payeeRule;
    if (!changed) return;
    changes.push({
      rowNum: r.rowNum, before: before, after: after, changed: true,
      rawToSave: hadRaw ? null : buildRawImport_(raw.source, raw.payee, raw.notes)
    });
  });
  return changes;
}

// Finances > Apply Payee Rules to All Rows…
function applyPayeeRulesToAllRows() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TRANSACTIONS_SHEET_NAME);
  if (!sheet) { ui.alert('Could not find a sheet tab named "' + TRANSACTIONS_SHEET_NAME + '".'); return; }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    ui.alert('An email import is running right now. Try again in a minute.');
    return;
  }
  try {
    var loaded = loadPayeeRules_(ss);
    var headerMap = ensureImportColumns_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { ui.alert('No transactions yet.'); return; }
    var nRows = lastRow - 1;
    var values = sheet.getRange(2, 1, nRows, sheet.getLastColumn()).getValues();
    function cell(row, name) { return headerMap[name] ? row[headerMap[name] - 1] : ''; }

    var rows = values.map(function (v, i) {
      return {
        rowNum: i + 2,
        payee: cell(v, 'Payee'), notes: cell(v, 'Notes'), sof: cell(v, 'SOF'), amount: cell(v, 'Amount'),
        messageId: cell(v, 'Email Message ID'), receiptId: cell(v, GRAB_RECEIPT_COLUMN),
        raw: cell(v, RAW_IMPORT_COLUMN), payeeRule: cell(v, PAYEE_RULE_COLUMN), transfer: cell(v, 'Transfer')
      };
    });
    var changes = planPayeeRuleChanges_(loaded.rules, rows);

    var msg = [];
    if (loaded.errors.length) msg.push('Skipped rules:\n' + loaded.errors.join('\n') + '\n');
    if (!changes.length) {
      msg.push('Nothing to change: every row already matches your current rules.');
      ui.alert('Payee rules', msg.join('\n'), ui.ButtonSet.OK);
      return;
    }
    msg.push(changes.length + ' row(s) will change (pending, cleared and reconciled rows included):\n');
    changes.slice(0, PAYEE_RULES_PREVIEW_MAX).forEach(function (c) {
      var line = 'Row ' + c.rowNum + ': ' + c.before.payee + ' → ' + c.after.payee + (c.after.payeeRule ? '  [' + c.after.payeeRule + ']' : '  [rule removed]');
      if (c.before.notes !== c.after.notes) line += '\n      Notes: ' + (c.after.notes || '(empty)');
      if (c.before.transfer !== c.after.transfer) line += '\n      Transfer: ' + c.after.transfer;
      msg.push(line);
    });
    if (changes.length > PAYEE_RULES_PREVIEW_MAX) msg.push('…and ' + (changes.length - PAYEE_RULES_PREVIEW_MAX) + ' more.');
    msg.push('\nApply?');
    if (ui.alert('Payee rules', msg.join('\n'), ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    if (changes.some(function (c) { return c.after.transfer && !c.before.transfer; })) ensureTransferColumns_(headerMap);
    ensurePayeeRuleColumns_(sheet, headerMap);

    // Re-read the columns we write: the dashboard can edit rows while the
    // dialog was open. A row whose Payee/Notes moved since is skipped.
    var names = ['Payee', 'Notes', 'Transfer', PAYEE_RULE_COLUMN, RAW_IMPORT_COLUMN];
    var cols = {};
    names.forEach(function (name) {
      cols[name] = sheet.getRange(2, headerMap[name], nRows, 1).getValues();
    });
    var touched = {};
    var applied = 0, skipped = 0;
    changes.forEach(function (c) {
      var i = c.rowNum - 2;
      if (String(cols['Payee'][i][0] || '') !== c.before.payee || String(cols['Notes'][i][0] || '') !== c.before.notes) {
        skipped++;
        return;
      }
      function put(name, value) { cols[name][i][0] = value; touched[name] = true; }
      if (c.rawToSave !== null) put(RAW_IMPORT_COLUMN, c.rawToSave);
      if (c.before.payee !== c.after.payee) put('Payee', c.after.payee);
      if (c.before.notes !== c.after.notes) put('Notes', c.after.notes);
      if (c.before.transfer !== c.after.transfer) put('Transfer', c.after.transfer);
      put(PAYEE_RULE_COLUMN, c.after.payeeRule);
      applied++;
    });
    // One write per changed column, not one per cell: a catch-all rule over
    // the whole history can touch hundreds of rows.
    names.forEach(function (name) {
      if (touched[name]) sheet.getRange(2, headerMap[name], nRows, 1).setValues(cols[name]);
    });
    ui.alert('Payee rules', 'Updated ' + applied + ' row(s).' +
        (skipped ? '\n' + skipped + ' row(s) were edited while this dialog was open and were left alone — run it again to pick them up.' : ''),
        ui.ButtonSet.OK);
  } finally {
    lock.releaseLock();
  }
}

// Old menu name, kept so a sheet whose Reconciliations.gs hasn't been
// re-pasted yet still works. Same behaviour: every row.
function applyPayeeRulesToPendingRows() {
  applyPayeeRulesToAllRows();
}

function ensurePayeeRuleColumns_(sheet, headerMap) {
  [RAW_IMPORT_COLUMN, PAYEE_RULE_COLUMN].forEach(function (name) {
    if (!headerMap[name]) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue(name);
      headerMap[name] = newCol;
    }
  });
}

// ── Setup ────────────────────────────────────────────────────────────────

// Finances > Setup > Payee Rules…  Safe to re-run: fixes headers and
// dropdowns, adds the starter rules only when the tab has no rules.
function setupPayeeRules() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PAYEE_RULES_SHEET_NAME) || ss.insertSheet(PAYEE_RULES_SHEET_NAME);

  sheet.getRange(1, 1, 1, PAYEE_RULES_HEADERS.length).setValues([PAYEE_RULES_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  var addedStarters = false;
  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, PAYEE_RULES_STARTERS.length, PAYEE_RULES_HEADERS.length).setValues(PAYEE_RULES_STARTERS);
    addedStarters = true;
  }

  var n = Math.max(sheet.getMaxRows() - 1, 1);
  function list(colName, items) {
    var col = PAYEE_RULES_HEADERS.indexOf(colName) + 1;
    sheet.getRange(2, col, n, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(items, true).setAllowInvalid(false).build());
  }
  sheet.getRange(2, PAYEE_RULES_HEADERS.indexOf('Active') + 1, n, 1).insertCheckboxes();
  list('Source', PAYEE_RULES_SOURCES);
  list('Match On', PAYEE_RULES_MATCH_ON);
  list('Match Type', PAYEE_RULES_MATCH_TYPES);
  list('Transfer', ['TRUE', 'FALSE']);
  // Plain text, so a pattern like "0875" or a template stays as typed.
  ['Pattern', 'Set Payee', 'Set Notes', 'SOF'].forEach(function (h) {
    sheet.getRange(2, PAYEE_RULES_HEADERS.indexOf(h) + 1, n, 1).setNumberFormat('@');
  });

  var loaded = loadPayeeRules_(ss);
  var msg = 'The ' + PAYEE_RULES_SHEET_NAME + ' tab is ready' + (addedStarters ? ', with ' + PAYEE_RULES_STARTERS.length + ' starter DANA rules' : '') +
      '. ' + loaded.rules.length + ' active rule(s).' +
      (loaded.errors.length ? '\n\nSkipped:\n' + loaded.errors.join('\n') : '') +
      '\n\nNew imports use these rules automatically. To run them over rows already in transactions, use Finances > Apply Payee Rules to All Rows….';
  SpreadsheetApp.getUi().alert('Payee rules', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}
