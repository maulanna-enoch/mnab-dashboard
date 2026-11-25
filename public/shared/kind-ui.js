/* Kind visibility (Debt Exit plan, follow-up to WS1/WS4).
 *
 * Every transaction has a Kind -- Variable / Fixed / Transfer / Income, see
 * api/_lib/kinds.js -- and only Variable counts toward the weekly allowance.
 * Until this module the Kind was only visible by opening a row's edit
 * sheet (and only for Expense rows), so there was no way to check at a
 * glance what the weekly budget was counting. This module is the one place
 * the list pages get:
 *
 *   KindUI.badge(txn)            -> small coloured pill for a row ('' if
 *                                   the row has no Kind, e.g. old API data)
 *   KindUI.describe(txn)         -> { kind, why, counts } plain-text lines
 *                                   for titles / the form
 *   KindUI.filterChipsHTML(id)   -> the Variable / Fixed / Transfer / Income
 *                                   chip row, plus KindUI.wireFilter()
 *   KindUI.matches(txn, kinds)   -> does this row pass the chip filter
 *                                   (kinds: array of picked Kinds; empty =
 *                                   every row)
 *   KindUI.bulkAction            -> the "Set kind" entry for BulkSelect's
 *                                   `actions` (a `choices` action, see
 *                                   shared/bulk-actions.js)
 *   KindUI.applyBulk(rowNumbers, choice)
 *                                -> POSTs transactions-update
 *                                   { action: 'setKind' } in one request and
 *                                   returns { updated, skipped }
 *
 * Pairs with shared/kind-ui.css; every class is prefixed knd-.
 */
(function (global) {
  const KINDS = ['Variable', 'Fixed', 'Transfer', 'Income'];

  const WHY = {
    manual: 'set by you',
    bill: 'linked to a bill',
    'auto-insert': 'auto-inserted bill row',
    payee: 'from the payee’s Kind',
    default: 'automatic',
    transfer: 'marked as a transfer',
    income: 'income',
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function kindOf(txn) {
    const k = txn && txn.kind;
    return KINDS.includes(k) ? k : null;
  }

  function describe(txn) {
    const kind = kindOf(txn);
    if (!kind) return null;
    const rule = txn.kindRule || '';
    return {
      kind,
      rule,
      manual: rule === 'manual',
      why: WHY[rule] || '',
      counts: kind === 'Variable',
    };
  }

  function badge(txn) {
    const d = describe(txn);
    if (!d) return '';
    const title = `${d.kind}${d.why ? ' · ' + d.why : ''} · ${d.counts ? 'counts toward' : 'not counted in'} the weekly allowance`;
    const mark = d.manual ? '<span class="knd-manual" aria-hidden="true">✎</span>' : '';
    return `<span class="knd-badge knd-${d.kind.toLowerCase()}" title="${escapeHtml(title)}">${d.kind}${mark}</span>`;
  }

  // kinds: array of picked Kinds. Nothing picked = every row.
  function matches(txn, kinds) {
    if (!kinds || !kinds.length) return true;
    return kinds.includes(kindOf(txn));
  }

  // Turns a ?kind= value ("Variable,Fixed") into a clean, ordered array.
  function parseKinds(raw) {
    const picked = String(raw || '').split(',').map((s) => s.trim());
    return KINDS.filter((k) => picked.includes(k));
  }

  // Multi-select: each chip toggles on its own; none on = show everything.
  function filterChipsHTML(id) {
    return `<div class="knd-filter" id="${id}" role="group" aria-label="Filter by kind (pick any; none = all)">` +
      KINDS.map((k) => `<button type="button" class="knd-chip knd-chip-${k.toLowerCase()}" data-kind-filter="${k}" aria-pressed="false">${k}</button>`).join('') +
      '</div>';
  }

  // Wires a chip row rendered by filterChipsHTML(). A tap toggles that chip;
  // `onChange(kinds)` gets the picked Kinds in KINDS order (empty = all).
  // Returns a setter so the host can restore a saved selection.
  function wireFilter(el, onChange) {
    function picked() {
      return KINDS.filter((k) => {
        const b = el.querySelector(`[data-kind-filter="${k}"]`);
        return b && b.getAttribute('aria-pressed') === 'true';
      });
    }
    function set(kinds) {
      const want = kinds || [];
      el.querySelectorAll('[data-kind-filter]').forEach((b) => {
        b.setAttribute('aria-pressed', want.includes(b.dataset.kindFilter) ? 'true' : 'false');
      });
    }
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-kind-filter]');
      if (!btn) return;
      btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      onChange(picked());
    });
    return set;
  }

  // Counts per Kind for the chip labels ("Variable 12").
  function updateCounts(el, list) {
    const counts = {};
    KINDS.forEach((k) => { counts[k] = 0; });
    list.forEach((t) => { const k = kindOf(t); if (k) counts[k] += 1; });
    el.querySelectorAll('[data-kind-filter]').forEach((b) => {
      const v = b.dataset.kindFilter;
      b.innerHTML = `${v} <span class="knd-chip-count">${counts[v] || 0}</span>`;
    });
  }

  // BulkSelect action. Income and Transfer rows can't be given a Kind by
  // hand (rules 1-2 in api/_lib/kinds.js always win), so the server skips
  // them and says how many.
  const bulkAction = {
    key: 'setKind',
    label: 'Set kind',
    hotkey: 'k',
    choices: [
      { value: 'Variable', label: 'Variable', hotkey: 'v' },
      { value: 'Fixed', label: 'Fixed', hotkey: 'f' },
      { value: 'auto', label: 'Automatic', hotkey: 'a' },
    ],
  };

  async function applyBulk(rowNumbers, choice) {
    const res = await fetch('/api/transactions-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setKind', rowNumbers, kind: choice }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  // One-line result for a toast/alert after a bulk Set kind.
  function bulkSummary(result) {
    const updated = (result && result.updated) || 0;
    const skipped = (result && result.skipped) || 0;
    if (!skipped) return null;
    return `${updated} updated. ${skipped} skipped: Income and Transfer rows always keep their own Kind.`;
  }

  global.KindUI = {
    KINDS,
    describe,
    badge,
    matches,
    parseKinds,
    filterChipsHTML,
    wireFilter,
    updateCounts,
    bulkAction,
    applyBulk,
    bulkSummary,
  };
})(window);
