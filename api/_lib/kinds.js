// Fixed / variable classification for `transactions` (Debt Exit plan, WS1).
//
// Every transaction has one Kind:
//   Transfer  money moving between your own accounts (Transfer flag TRUE),
//             incl. both legs of a card statement payment
//   Income    any other Income row
//   Fixed     a bill or installment: linked to an installmentsbills row by
//             its IB-n code, or a row InstallmentsBills.gs auto-inserted
//   Variable  everything else -- day-to-day spending, card swipes included
//             on the day they happen. The weekly allowance (WS4) counts
//             only these.
//
// Rules, first match wins:
//   1. Transfer flag             -> Transfer   (rule "transfer")
//   2. Income                    -> Income     (rule "income")
//   3. Kind set by hand          -> as set     (rule "manual")
//   4. Has a Bill ID             -> Fixed      (rule "bill")
//      or Notes start "Auto-insert"           (rule "auto-insert")
//   5. Payee has a Kind on the
//      Payees tab                -> that Kind  (rule "payee")
//   6. Otherwise                 -> Variable   (rule "default")
//
// Rules 1-2 always win, even over a hand-set Kind: a hand-set "Fixed" on a
// row that later becomes a transfer leg must not keep counting as spending.
// The plan's rule list has no "manual" step; it's here so a choice made in
// the transaction form (or typed into the sheet) survives a backfill rerun.
//
// Columns on `transactions` (self-provisioned, read by header name):
//   Kind       the result above, written on every save/import/backfill
//   Kind Rule  which rule produced it. "manual" marks a hand-set Kind; a
//              Kind with a BLANK Kind Rule (typed straight into the sheet)
//              also counts as manual.
//   Source ID  the Bill ID. This column already exists: InstallmentsBills.gs
//              stamps it with the bill's permanent IB-n code on every row
//              it inserts, so WS1 reuses it rather than adding a second
//              "Bill ID" column.
//
// Readers should not trust a stored Kind blindly: classifyKind() is cheap,
// so readers recompute it from the row (keeping only a manual Kind). A
// stored auto Kind can be stale -- e.g. a payee override added after the
// row was written -- until the backfill (Kinds.gs) is rerun.
//
// The same rules live in apps-script/Kinds.gs (email import, inbox import,
// backfill). Change both together.

const KIND_COLUMN = 'Kind';
const KIND_RULE_COLUMN = 'Kind Rule';
const BILL_ID_COLUMN = 'Source ID';

const KINDS = ['Fixed', 'Variable', 'Transfer', 'Income'];
const SPENDING_KINDS = ['Fixed', 'Variable']; // the only two a person (or payee override) can pick
const BILL_ID_RE = /^IB-\d+$/;
const AUTO_INSERT_RE = /^\s*auto-insert\b/i;

function normalizeKind(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return KINDS.find((k) => k.toLowerCase() === s) || null;
}

// Only Fixed/Variable can be chosen; anything else reads as "no choice".
function normalizeSpendingKind(v) {
  const k = normalizeKind(v);
  return k && SPENDING_KINDS.includes(k) ? k : null;
}

function normalizeBillId(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return BILL_ID_RE.test(s) ? s : null;
}

function isManualKind(storedKind, storedRule) {
  if (!normalizeSpendingKind(storedKind)) return false;
  const rule = String(storedRule == null ? '' : storedRule).trim().toLowerCase();
  return rule === '' || rule === 'manual';
}

function normalizePayeeKey(name) {
  return String(name || '').trim().toLowerCase();
}

// fields: { type, isTransfer, billId, notes, payee, storedKind, storedRule }
// payeeKinds: { lowercasedPayee: 'Fixed' | 'Variable' } (optional)
// Returns { kind, rule }.
function classifyKind(fields, payeeKinds) {
  const f = fields || {};
  if (f.isTransfer) return { kind: 'Transfer', rule: 'transfer' };
  if (f.type === 'Income') return { kind: 'Income', rule: 'income' };
  if (isManualKind(f.storedKind, f.storedRule)) {
    return { kind: normalizeSpendingKind(f.storedKind), rule: 'manual' };
  }
  if (normalizeBillId(f.billId)) return { kind: 'Fixed', rule: 'bill' };
  if (AUTO_INSERT_RE.test(String(f.notes || ''))) return { kind: 'Fixed', rule: 'auto-insert' };
  const payeeKind = payeeKinds ? payeeKinds[normalizePayeeKey(f.payee)] : null;
  if (payeeKind) return { kind: payeeKind, rule: 'payee' };
  return { kind: 'Variable', rule: 'default' };
}

// rows: the Payees tab as fetchPayeeRows() returns it.
function payeeKindMap(payeeRows) {
  const map = {};
  (payeeRows || []).forEach((p) => {
    const k = normalizeSpendingKind(p.kind);
    if (k) map[normalizePayeeKey(p.name)] = k;
  });
  return map;
}

// The Kind to store when a row is saved through the dashboard
// (transactions-add / transactions-update). The request may carry:
//   kindManual true + kind  -> the person picked Fixed / Variable
//   kindManual false        -> the person reset it to automatic
//   neither                 -> keep whatever the row had (an inline edit,
//                              swipe-to-clear etc. never mentions Kind)
// existing: { storedKind, storedRule } of the row being edited (add: none).
function kindForSave(fields, request, existing, payeeKinds) {
  const req = request || {};
  const ex = existing || {};
  let storedKind = ex.storedKind || null;
  let storedRule = ex.storedRule || null;
  if (req.kindManual === true && normalizeSpendingKind(req.kind)) {
    storedKind = normalizeSpendingKind(req.kind);
    storedRule = 'manual';
  } else if (req.kindManual === false) {
    storedKind = null;
    storedRule = null;
  }
  return classifyKind({ ...fields, storedKind, storedRule }, payeeKinds);
}

// Bulk "Set kind" (transactions-update { action: 'setKind' }).
// rows: fetchTransactionRows() rows (needs rowNumber, type, isTransfer,
//   billId, notes, payee, storedKind, storedKindRule).
// rowNumbers: the selection. choice: 'Variable' | 'Fixed' | 'auto'.
// Returns { writes: [{ rowNumber, kind, rule }], skipped: [rowNumber],
// missing: [rowNumber] }. Income and Transfer rows are skipped -- rules 1-2
// always decide those, so a hand-set Kind there would never take effect.
function planBulkKind(rows, rowNumbers, choice, payeeKinds) {
  const pick = choice === 'auto' ? 'auto' : normalizeSpendingKind(choice);
  if (!pick) throw new Error('kind must be Variable, Fixed or auto');
  const byRow = new Map((rows || []).map((r) => [r.rowNumber, r]));
  const writes = [];
  const skipped = [];
  const missing = [];
  const seen = new Set();
  (rowNumbers || []).forEach((raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || seen.has(n)) return;
    seen.add(n);
    const r = byRow.get(n);
    if (!r) { missing.push(n); return; }
    if (r.isTransfer || r.type === 'Income') { skipped.push(n); return; }
    const request = pick === 'auto' ? { kindManual: false } : { kindManual: true, kind: pick };
    const { kind, rule } = kindForSave(
      { type: r.type, isTransfer: r.isTransfer, billId: r.billId, notes: r.notes, payee: r.payee },
      request,
      { storedKind: r.storedKind, storedRule: r.storedKindRule },
      payeeKinds,
    );
    writes.push({ rowNumber: n, kind, rule });
  });
  return { writes, skipped, missing };
}

// ── Bill suggestions for the transaction form ─────────────────────────────
// "Payee and amount match the registry": the payee names the bill (same
// name, or one contains the other as whole words) and the amount is within
// 1% or Rp 1.000 of the bill's amount, whichever is larger -- loose enough
// for a few-rupiah price drift (the Vidio IB-18 case), tight enough that two
// different bills from one merchant don't both match.
function amountsClose(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return false;
  return Math.abs(x - y) <= Math.max(y * 0.01, 1000);
}

function nameTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function namesMatch(payee, billName) {
  const p = nameTokens(payee);
  const b = nameTokens(billName);
  if (!p || !b) return false;
  if (p === b) return true;
  const [shorter, longer] = p.length <= b.length ? [p, b] : [b, p];
  if (shorter.length < 3) return false;
  return (' ' + longer + ' ').includes(' ' + shorter + ' ');
}

// bills: [{ id, name, amount, isActive }]. Returns matching active bills,
// closest amount first.
function suggestBills(bills, { payee, amount }) {
  return (bills || [])
    .filter((b) => b.id && b.isActive && namesMatch(payee, b.name) && amountsClose(amount, b.amount))
    .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount));
}

module.exports = {
  KIND_COLUMN,
  KIND_RULE_COLUMN,
  BILL_ID_COLUMN,
  KINDS,
  SPENDING_KINDS,
  normalizeKind,
  normalizeSpendingKind,
  normalizeBillId,
  isManualKind,
  classifyKind,
  kindForSave,
  planBulkKind,
  payeeKindMap,
  amountsClose,
  namesMatch,
  suggestBills,
};
