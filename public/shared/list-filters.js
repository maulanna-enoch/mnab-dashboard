/* List filters: "Uncategorised only" and "Statement month".
 *
 * One small filter row for the transaction lists on the Transactions page
 * and the Account detail page. It filters the same `visible` list each page
 * already hands to both its card list and its wide table, so like the Kind
 * chips it applies at every width.
 *
 *   const lf = ListFilters.mount(el, { onChange(state) {...} })
 *   lf.update(rows)     -> refreshes the Uncategorised count and the month
 *                          options from `rows` (call before filtering)
 *   lf.set(state)       -> restores a state without firing onChange
 *   lf.state()          -> { uncat: boolean, month: '' | 'YYYY-MM' | '__none' }
 *   lf.summary(visible) -> fills the "N transactions · out · in" line under
 *                          the row; hidden while no filter is on
 *   ListFilters.matches(txn, state)
 *   ListFilters.monthLabel('2026-11') -> 'Nov 2026'
 *
 * "Statement month" is each row's Month column (the billing month, see the
 * billing-month heuristic in shared/transaction-form.js), not its date.
 * "Uncategorised" is CategoryUI's Uncategorised: an Expense row no category
 * rule matched. Transfers and Income rows never count.
 *
 * Pairs with shared/list-filters.css; every class is prefixed lfl-.
 */
(function (global) {
  const UNCATEGORISED = 'Uncategorised';
  const NO_MONTH = '__none';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function monthLabel(key) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!m) return String(key || '');
    return `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}`;
  }

  function isUncategorised(t) { return !!t && t.category === UNCATEGORISED; }

  function matches(t, state) {
    const s = state || {};
    if (s.uncat && !isUncategorised(t)) return false;
    if (s.month === NO_MONTH) return !t.month;
    if (s.month && t.month !== s.month) return false;
    return true;
  }

  function fmt(n) { return 'Rp ' + Math.round(n).toLocaleString('id-ID'); }

  function mount(el, opts) {
    const o = opts || {};
    let state = { uncat: false, month: '' };

    el.classList.add('lfl-row-wrap');
    el.innerHTML =
      '<div class="lfl-row">' +
        '<button type="button" class="lfl-chip" data-lfl="uncat" aria-pressed="false">' +
          `${UNCATEGORISED} only <span class="lfl-count">0</span></button>` +
        '<select class="lfl-month" data-lfl="month" aria-label="Filter by statement month">' +
          '<option value="">All statement months</option></select>' +
      '</div>' +
      '<div class="lfl-summary" data-lfl="summary" hidden></div>';

    const chipEl = el.querySelector('[data-lfl="uncat"]');
    const countEl = chipEl.querySelector('.lfl-count');
    const monthEl = el.querySelector('[data-lfl="month"]');
    const summaryEl = el.querySelector('[data-lfl="summary"]');

    function paint() {
      chipEl.setAttribute('aria-pressed', state.uncat ? 'true' : 'false');
      monthEl.classList.toggle('lfl-on', !!state.month);
      if (monthEl.value !== state.month) {
        // A saved month the current rows don't have: keep it selectable so
        // the select shows what is actually filtering.
        if (state.month && !Array.from(monthEl.options).some((x) => x.value === state.month)) {
          monthEl.insertAdjacentHTML('beforeend',
            `<option value="${state.month}">${state.month === NO_MONTH ? 'No month' : monthLabel(state.month)}</option>`);
        }
        monthEl.value = state.month;
      }
    }

    chipEl.addEventListener('click', () => {
      state = { ...state, uncat: !state.uncat };
      paint();
      if (o.onChange) o.onChange({ ...state });
    });
    monthEl.addEventListener('change', () => {
      state = { ...state, month: monthEl.value };
      paint();
      if (o.onChange) o.onChange({ ...state });
    });

    function update(rows) {
      const list = rows || [];
      countEl.textContent = String(list.filter(isUncategorised).length);
      const keys = Array.from(new Set(list.map((t) => t.month).filter(Boolean))).sort().reverse();
      const hasNone = list.some((t) => !t.month);
      if (state.month && state.month !== NO_MONTH && !keys.includes(state.month)) keys.unshift(state.month);
      monthEl.innerHTML = '<option value="">All statement months</option>' +
        keys.map((k) => `<option value="${k}">${monthLabel(k)}</option>`).join('') +
        (hasNone || state.month === NO_MONTH ? `<option value="${NO_MONTH}">No month</option>` : '');
      monthEl.value = state.month;
      paint();
    }

    function summary(visible) {
      if (!state.uncat && !state.month) { summaryEl.hidden = true; return; }
      const list = visible || [];
      let out = 0;
      let inc = 0;
      list.forEach((t) => {
        if (t.transfer) return;
        const a = Math.abs(Number(t.amount) || 0);
        if (t.type === 'Income') inc += a; else out += a;
      });
      const bits = [`${list.length} ${list.length === 1 ? 'transaction' : 'transactions'}`];
      if (out) bits.push(`${fmt(out)} out`);
      if (inc) bits.push(`${fmt(inc)} in`);
      summaryEl.textContent = bits.join(' · ');
      summaryEl.hidden = false;
    }

    return {
      update,
      summary,
      set(next) { state = { uncat: !!(next && next.uncat), month: (next && next.month) || '' }; paint(); },
      state() { return { ...state }; },
    };
  }

  global.ListFilters = { mount, matches, monthLabel, NO_MONTH };
})(window);
