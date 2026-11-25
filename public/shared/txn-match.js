/* Manual "Match" of two transactions that are really the same one -- e.g. a
 * bank email import (Pending) and the bill row InstallmentsBills.gs
 * auto-inserted for the same payment (also Pending, carries a Source ID).
 *
 * Shared by the browser (bulk bar on Transactions / Account detail, which
 * uses it to decide whether to offer "Match" and to say which row stays)
 * and the server (api/transactions-update.js `action: 'matchRows'`, which
 * uses the SAME rule so the confirmation text can't disagree with what
 * actually happens). UMD so both `require()` and a plain <script> work.
 *
 * Row shape (subset of /api/transactions-list): { rowNumber, type, amount,
 * billId, paymentId, notes, pending, cleared }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TxnMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function billIdOf(t) {
    return t && t.billId ? String(t.billId).trim().toUpperCase() : '';
  }
  function isAutoInsert(t) {
    return /^\s*auto-insert/i.test(String((t && t.notes) || ''));
  }
  function isCleared(t) {
    return t && (t.cleared === true || String(t.cleared || '').toLowerCase() === 'cleared');
  }

  // Can these two rows be matched? Returns { ok, reason }.
  function canMatch(a, b) {
    if (!a || !b) return { ok: false, reason: 'Select exactly 2 transactions.' };
    if (a.rowNumber === b.rowNumber) return { ok: false, reason: 'Select 2 different transactions.' };
    if ((a.type || 'Expense') !== (b.type || 'Expense')) return { ok: false, reason: 'One is Income and the other is Expense.' };
    if (Math.round(Number(a.amount) || 0) !== Math.round(Number(b.amount) || 0)) return { ok: false, reason: 'Amounts are different.' };
    const ba = billIdOf(a);
    const bb = billIdOf(b);
    if (ba && bb && ba !== bb) return { ok: false, reason: `Linked to two different bills (${ba}, ${bb}).` };
    if (a.paymentId && b.paymentId) return { ok: false, reason: 'Both are card-payment legs.' };
    return { ok: true, reason: '' };
  }

  // Which row survives. The first rule that tells them apart wins:
  //   1. The row WITHOUT a bill link (the real payment); the bill link moves onto it.
  //   2. The card-payment leg (deleting it would orphan the other leg).
  //   3. The row that is NOT an "Auto-insert" placeholder.
  //   4. The row that isn't Pending (already reviewed by hand).
  //   5. The Cleared row.
  //   6. The older row (lower row number).
  function pickKeeper(a, b) {
    const rules = [
      (t) => !billIdOf(t),
      (t) => !!t.paymentId,
      (t) => !isAutoInsert(t),
      (t) => !t.pending,
      (t) => isCleared(t),
    ];
    for (const rule of rules) {
      const ra = !!rule(a);
      const rb = !!rule(b);
      if (ra !== rb) return ra ? { keep: a, drop: b } : { keep: b, drop: a };
    }
    return a.rowNumber < b.rowNumber ? { keep: a, drop: b } : { keep: b, drop: a };
  }

  // The bill ID the surviving row ends up carrying ('' when neither has one).
  function resultingBillId(a, b) {
    return billIdOf(a) || billIdOf(b);
  }

  function shortDate(iso) {
    if (!iso) return 'no date';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  function describe(t) {
    return `"${t.payee || '(no payee)'}" · ${t.sof || '-'} · ${shortDate(t.date)}`;
  }

  // Confirmation text for the bulk bar.
  function confirmText(a, b, formatAmount) {
    const { keep, drop } = pickKeeper(a, b);
    const billId = resultingBillId(a, b);
    const amt = formatAmount ? formatAmount(Number(keep.amount) || 0) : String(keep.amount);
    let msg = `Match these as one ${amt} transaction?\n\nKeep: ${describe(keep)}\nDelete: ${describe(drop)}`;
    if (billId) msg += `\n\nThe kept row gets linked to bill ${billId}, so the bill shows as paid.`;
    return msg;
  }

  // The bulk-bar action definition (shared/bulk-actions.js), so the
  // Transactions page and the Account detail page offer the same thing.
  function bulkAction(formatAmount) {
    return {
      key: 'match',
      label: 'Match',
      hotkey: 'g',
      hotkeySymbol: 'G',
      confirmVerb: 'Match',
      when: (txns) => txns.length === 2 && canMatch(txns[0], txns[1]).ok,
      confirm: (txns) => confirmText(txns[0], txns[1], formatAmount),
    };
  }

  return { canMatch, pickKeeper, resultingBillId, billIdOf, isAutoInsert, confirmText, bulkAction };
});
