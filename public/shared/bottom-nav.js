/* Shared bottom tab bar, mounted once per page:
 *
 *   BottomNav.mount(document.getElementById('bnv-root'), { active: 'home' });
 *
 * `active` is one of 'home' | 'bills' | 'transactions' | 'accounts' and
 * picks which tab renders in the accent color. This is the ONE place the
 * bottom nav's markup/behaviour lives (mirrors shared/transaction-form.js
 * and shared/swipe-actions.js) -- editing this file (and bottom-nav.css)
 * changes every page at once. Every id/class it creates is prefixed bnv- so
 * it can't collide with a host page's own styles or ids.
 *
 * Tabs are plain links (a full page load per tap, same as every other nav
 * in this no-build static app) rather than a client-side router.
 */
(function (global) {
  const TABS = [
    {
      id: 'home',
      label: 'Home',
      href: '/',
      icon: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9"/>',
    },
    {
      id: 'bills',
      label: 'Bills',
      href: '/installments',
      icon: '<path d="M6 3h12v17l-2.5-1.5L13 20l-1-1.5-1 1.5-2.5-1.5L6 20V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    },
    {
      id: 'transactions',
      label: 'Transactions',
      href: '/transactions',
      icon: '<path d="M4 8h13l-3-3.5"/><path d="M20 16H7l3 3.5"/>',
    },
    {
      id: 'accounts',
      label: 'Accounts',
      href: '/accounts',
      icon: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M3 10h18"/><rect x="14" y="13" width="4" height="2.5" rx="0.5"/>',
    },
  ];

  function tabHTML(tab, active) {
    const isActive = tab.id === active;
    return `
      <a class="bnv-tab${isActive ? ' bnv-active' : ''}" href="${tab.href}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${tab.icon}</svg>
        <span class="bnv-label">${tab.label}</span>
      </a>`;
  }

  function mount(rootEl, options) {
    const opts = options || {};
    const active = opts.active || 'home';
    rootEl.innerHTML = `<nav class="bnv-bar">${TABS.map((t) => tabHTML(t, active)).join('')}</nav>`;
  }

  global.BottomNav = { mount };
})(window);
