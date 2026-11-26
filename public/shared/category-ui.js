/* Category UI (Category system C3).
 *
 * Every transaction has a category -- what the money was for, see
 * api/_lib/categories.js -- next to its Kind. This module is the one place
 * the pages and the transaction form get:
 *
 *   CategoryUI.load()            -> Promise of { categories, byName } from
 *                                   /api/payees-list?action=categories,
 *                                   fetched once per page
 *   CategoryUI.chip(txn)         -> small coloured pill for a row ('' for a
 *                                   transfer or an income row with none)
 *   CategoryUI.nameChip(name)    -> the same pill for a bare category name
 *   CategoryUI.describe(txn)     -> { category, group, rule, why, manual }
 *   CategoryUI.pick(opts)        -> opens the searchable, grouped picker;
 *                                   Promise of a category name, 'auto', or
 *                                   null if closed. opts: { title, current,
 *                                   type: 'Expense' | 'Income' | 'any',
 *                                   allowAuto, autoLabel }
 *   CategoryUI.fillFilter(sel, value)
 *                                -> fills a <select> with All / Uncategorised
 *                                   / each group and category
 *   CategoryUI.matches(txn, value) -> does this row pass that filter
 *   CategoryUI.bulkAction        -> the "Set category" entry for BulkSelect's
 *                                   `actions` (a `pick` action, see
 *                                   shared/bulk-actions.js)
 *   CategoryUI.applyBulk(rowNumbers, choice)
 *                                -> POSTs transactions-update
 *                                   { action: 'setCategory' } in one request
 *   CategoryUI.setPayeeDefault(name, category)
 *                                -> POSTs payees-list { action: 'set-category' }
 *
 * Pairs with shared/category-ui.css; every class is prefixed ctg-.
 */
(function (global) {
  const UNCATEGORISED = 'Uncategorised';
  const INCOME_GROUP = 'Income';
  const FALLBACK_COLOUR = '#9ca3af';

  const WHY = {
    manual: 'set by you',
    bill: 'from its bill',
    payee: 'the payee’s default',
    'bank-label': 'from the bank’s label',
    default: 'no rule matched',
    transfer: 'a transfer',
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Data ────────────────────────────────────────────────────────────────
  let loaded = null;   // { categories, byName, fromTab }
  let loading = null;

  function load() {
    if (loaded) return Promise.resolve(loaded);
    if (loading) return loading;
    loading = fetch('/api/payees-list?action=categories')
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        const categories = data.categories || [];
        const byName = {};
        categories.forEach((c) => { byName[c.name.toLowerCase()] = c; });
        loaded = { categories, byName, fromTab: !!data.fromTab, warning: data.warning || null };
        return loaded;
      })
      .catch((err) => { loading = null; throw err; });
    return loading;
  }

  function lookup(name) {
    if (!loaded || !name) return null;
    return loaded.byName[String(name).toLowerCase()] || null;
  }

  function colourFor(name) {
    const c = lookup(name);
    return (c && c.colour) || FALLBACK_COLOUR;
  }

  function whyOf(rule) {
    const r = String(rule || '');
    if (/^rule\b/i.test(r)) return 'payee rule ' + r.replace(/^rule\s*/i, '');
    return WHY[r] || '';
  }

  function describe(txn) {
    if (!txn || !txn.category) return null;
    const rule = txn.categoryRule || '';
    return {
      category: txn.category,
      group: txn.categoryGroup || (lookup(txn.category) || {}).group || null,
      rule,
      why: whyOf(rule),
      manual: rule === 'manual',
      uncategorised: txn.category === UNCATEGORISED,
    };
  }

  function nameChip(name, opts) {
    if (!name) return '';
    const o = opts || {};
    if (name === UNCATEGORISED) {
      return `<span class="ctg-chip ctg-none"${o.title ? ` title="${escapeHtml(o.title)}"` : ''}>${UNCATEGORISED}</span>`;
    }
    const mark = o.manual ? '<span class="ctg-manual" aria-hidden="true">✎</span>' : '';
    return `<span class="ctg-chip" style="--ctg:${escapeHtml(colourFor(name))}"${o.title ? ` title="${escapeHtml(o.title)}"` : ''}>` +
      `<span class="ctg-dot" aria-hidden="true"></span>${escapeHtml(name)}${mark}</span>`;
  }

  function chip(txn) {
    const d = describe(txn);
    if (!d) return '';
    const title = `${d.category}${d.group ? ' · ' + d.group : ''}${d.why ? ' · ' + d.why : ''}`;
    return nameChip(d.category, { manual: d.manual, title });
  }

  // ── Filter ──────────────────────────────────────────────────────────────
  // Values: '' = every row, '__uncat' = Uncategorised, 'g:<group>' = a
  // whole group, anything else = one category.
  function fillFilter(select, value) {
    const groups = [];
    const byGroup = {};
    ((loaded && loaded.categories) || []).forEach((c) => {
      if (!byGroup[c.group]) { byGroup[c.group] = []; groups.push(c.group); }
      byGroup[c.group].push(c);
    });
    select.innerHTML = '<option value="">All categories</option>' +
      `<option value="__uncat">${UNCATEGORISED}</option>` +
      groups.map((g) => `<optgroup label="${escapeHtml(g)}">` +
        `<option value="g:${escapeHtml(g)}">All ${escapeHtml(g)}</option>` +
        byGroup[g].map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('') +
        '</optgroup>').join('');
    select.value = value || '';
    if (select.value !== (value || '')) {
      // A saved filter for a category that's gone: keep it visible.
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      select.appendChild(opt);
      select.value = value;
    }
  }

  function matches(txn, value) {
    if (!value) return true;
    if (value === '__uncat') return txn.category === UNCATEGORISED;
    if (value.indexOf('g:') === 0) return !!txn.categoryGroup && txn.categoryGroup === value.slice(2);
    return !!txn.category && txn.category.toLowerCase() === value.toLowerCase();
  }

  // ── Picker ──────────────────────────────────────────────────────────────
  let pickerEl = null;

  function ensurePicker() {
    if (pickerEl) return pickerEl;
    pickerEl = document.createElement('div');
    pickerEl.className = 'ctg-overlay';
    pickerEl.setAttribute('role', 'dialog');
    pickerEl.setAttribute('aria-modal', 'true');
    pickerEl.setAttribute('aria-labelledby', 'ctg-picker-title');
    pickerEl.innerHTML = `
      <div class="ctg-sheet">
        <div class="ctg-head">
          <div class="ctg-title" id="ctg-picker-title">Category</div>
          <button type="button" class="ctg-close" aria-label="Close">✕</button>
        </div>
        <input type="search" class="ctg-search" placeholder="Search categories" aria-label="Search categories" autocomplete="off" />
        <div class="ctg-list" role="listbox"></div>
      </div>`;
    document.body.appendChild(pickerEl);
    return pickerEl;
  }

  function pick(opts) {
    const o = opts || {};
    return load().then((data) => new Promise((resolve) => {
      const el = ensurePicker();
      const search = el.querySelector('.ctg-search');
      const list = el.querySelector('.ctg-list');
      el.querySelector('.ctg-title').textContent = o.title || 'Category';
      const type = o.type || 'any';
      const current = o.current ? String(o.current).toLowerCase() : '';
      const usable = data.categories.filter((c) => {
        if (type === 'Expense' && c.group === INCOME_GROUP) return false;
        if (type === 'Income' && c.group !== INCOME_GROUP) return false;
        return c.active || c.name.toLowerCase() === current;
      });

      function render() {
        const q = search.value.trim().toLowerCase();
        const hits = usable.filter((c) => !q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
        let html = '';
        if (o.allowAuto && !q) {
          html += `<button type="button" class="ctg-option ctg-auto" data-value="auto" role="option">${escapeHtml(o.autoLabel || 'Automatic')}</button>`;
        }
        let group = null;
        hits.forEach((c) => {
          if (c.group !== group) {
            group = c.group;
            html += `<div class="ctg-group">${escapeHtml(group)}</div>`;
          }
          const on = c.name.toLowerCase() === current;
          html += `<button type="button" class="ctg-option${on ? ' ctg-current' : ''}" data-value="${escapeHtml(c.name)}" role="option" aria-selected="${on}" style="--ctg:${escapeHtml(c.colour || FALLBACK_COLOUR)}">` +
            `<span class="ctg-dot" aria-hidden="true"></span>${escapeHtml(c.name)}${on ? ' <span class="ctg-check" aria-hidden="true">✓</span>' : ''}</button>`;
        });
        if (!hits.length) html += '<div class="ctg-empty">No category matches. Add one on the Categories tab in the sheet.</div>';
        list.innerHTML = html;
      }

      let done = false;
      function finish(value) {
        if (done) return;
        done = true;
        el.classList.remove('open');
        if (global.ModalA11y) global.ModalA11y.close(el);
        list.removeEventListener('click', onClick);
        search.removeEventListener('input', render);
        search.removeEventListener('keydown', onKey);
        el.removeEventListener('click', onBackdrop);
        el.querySelector('.ctg-close').removeEventListener('click', onCancel);
        resolve(value);
      }
      function onClick(e) {
        const btn = e.target.closest('[data-value]');
        if (btn) finish(btn.dataset.value);
      }
      function onKey(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = list.querySelector('.ctg-option:not(.ctg-auto)') || list.querySelector('.ctg-option');
          if (first) finish(first.dataset.value);
        }
      }
      function onBackdrop(e) { if (e.target === el) finish(null); }
      function onCancel() { finish(null); }

      search.value = '';
      render();
      list.addEventListener('click', onClick);
      search.addEventListener('input', render);
      search.addEventListener('keydown', onKey);
      el.addEventListener('click', onBackdrop);
      el.querySelector('.ctg-close').addEventListener('click', onCancel);
      el.classList.add('open');
      if (global.ModalA11y) global.ModalA11y.open(el, { focus: search, onClose: () => finish(null) });
      else search.focus();
    }));
  }

  // ── Writes ──────────────────────────────────────────────────────────────
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function applyBulk(rowNumbers, choice) {
    return postJson('/api/transactions-update', { action: 'setCategory', rowNumbers, category: choice });
  }

  function setPayeeDefault(name, category) {
    return postJson('/api/payees-list', { action: 'set-category', name, category: category || null });
  }

  // One-line note after a bulk Set category, or null when nothing was skipped.
  function bulkSummary(result) {
    const updated = (result && result.updated) || 0;
    const skipped = (result && result.skipped) || 0;
    if (!skipped) return null;
    return `${updated} updated. ${skipped} skipped: transfers have no category, and income and spending categories don’t mix.`;
  }

  // The type the picker should offer for a selection of rows.
  function typeFor(txns) {
    const types = new Set((txns || []).filter((t) => !t.transfer).map((t) => t.type));
    if (types.size === 1) return types.has('Income') ? 'Income' : 'Expense';
    return 'any';
  }

  const bulkAction = {
    key: 'setCategory',
    label: 'Set category',
    hotkey: 'y',
    pick: (txns) => pick({
      title: `Category for ${txns.length} ${txns.length === 1 ? 'transaction' : 'transactions'}`,
      type: typeFor(txns),
      allowAuto: true,
      autoLabel: 'Automatic (drop what you set)',
    }),
  };

  global.CategoryUI = {
    UNCATEGORISED,
    load,
    lookup,
    colourFor,
    describe,
    chip,
    nameChip,
    fillFilter,
    matches,
    pick,
    typeFor,
    applyBulk,
    setPayeeDefault,
    bulkSummary,
    bulkAction,
  };
})(window);
