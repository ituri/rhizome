/* Global command palette (Alt+Shift+P) — fuzzy access to every app-level action.
 * Complements the '/' slash menu (block actions) and Ctrl+K (jump to a page/block).
 * Uses globals from app.js (state, settings, zoomTo, showSettings, …) like pages.js. */
(function () {
  const overlay = document.getElementById('cmd-overlay');
  const input = document.getElementById('cmd-input');
  const results = document.getElementById('cmd-results');
  if (!overlay || !input || !results) return;

  const shared = () => typeof SHARE_TOKEN !== 'undefined' && SHARE_TOKEN;
  const writable = () => !state.readOnly && !shared();

  // The command registry — each entry runs a global action. `when` hides it when N/A.
  function commands() {
    const atHome = state.zoom === HOME;
    const isDark = (settings.theme === 'auto' ? matchMedia('(prefers-color-scheme: dark)').matches : settings.theme) === 'dark';
    const cmds = [
      // Navigate
      { group: 'Navigate', label: 'Go to Daily Notes', hint: "Ctrl+'", run: () => { shared() ? zoomTo(HOME) : (location.hash = '#/'); } },
      { group: 'Navigate', label: 'Go to All Pages', when: () => !shared(), run: () => { location.hash = '#/pages'; } },
      { group: 'Navigate', label: 'Go to Assets', when: () => !shared(), run: () => { location.hash = '#/assets'; } },
      { group: 'Navigate', label: 'Jump to page or block…', hint: 'Ctrl+K', run: () => showJump() },
      { group: 'Navigate', label: 'Zoom out', hint: 'Ctrl+[', when: () => state.zoom !== HOME, run: () => zoomTo(parentOf(state.zoom) || HOME) },

      // Create & capture
      { group: 'Create', label: 'New page…', when: writable, run: () => {
        const t = prompt('New page title:'); if (!t || !t.trim()) return;
        snapshot(); const id = getOrCreatePage(t.trim()); markDirty(); zoomTo(id);
      } },
      { group: 'Create', label: 'Quick capture', hint: 'Ctrl+Shift+Space', when: () => !shared(), run: () => window.showCapture?.() },

      // View
      { group: 'View', label: () => (settings.showCompleted ? 'Hide completed items' : 'Show completed items'), hint: 'Ctrl+O',
        run: () => { settings.showCompleted = !settings.showCompleted; saveSettings(); renderPage(); } },
      { group: 'View', label: () => (isDark ? 'Switch to light theme' : 'Switch to dark theme'),
        run: () => { settings.theme = isDark ? 'light' : 'dark'; saveSettings(); applyTheme(); } },
      { group: 'View', label: 'Theme: follow system', when: () => settings.theme !== 'auto',
        run: () => { settings.theme = 'auto'; saveSettings(); applyTheme(); } },
      { group: 'View', label: () => (settings.hoverPreview !== false ? 'Disable live hover preview' : 'Enable live hover preview'),
        run: () => { settings.hoverPreview = !(settings.hoverPreview !== false); saveSettings(); if (settings.hoverPreview === false) window.__closeHoverPreview?.(); } },
      { group: 'View', label: 'Expand all', run: () => setCollapseAll(false) },
      { group: 'View', label: 'Collapse all', run: () => setCollapseAll(true) },

      // This page
      { group: 'Page', label: 'Star / unstar this page', hint: 'Ctrl+Shift+8', when: () => !shared() && !atHome, run: () => window.toggleStar?.() },
      { group: 'Page', label: 'Copy link to this page', when: () => !atHome, run: () => {
        navigator.clipboard?.writeText(location.origin + location.pathname + '#/n/' + state.zoom); showToast('Link copied');
      } },
      { group: 'Page', label: 'Page history…', when: () => !shared() && !atHome && !!window.historyPageOf?.(state.zoom),
        run: () => window.showPageHistory?.(window.historyPageOf(state.zoom)) },
      { group: 'Page', label: 'Present', run: () => startPresent() },
      { group: 'Page', label: 'Export…', run: () => openExportMenu(document.getElementById('btn-menu')) },

      // App
      { group: 'App', label: 'Settings…', run: () => showSettings() },
      { group: 'App', label: 'Import…', when: writable, run: () => document.getElementById('import-file')?.click() },
      { group: 'App', label: 'Open trash', when: () => !shared(), run: () => showTrash() },
      { group: 'App', label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: () => showHelp() },
      { group: 'App', label: 'Print', hint: 'Ctrl+P', run: () => { commitActiveText(); window.print(); } },
      { group: 'App', label: 'Log out', when: () => state.authRequired && !shared(), run: async () => { await fetch('/api/logout', { method: 'POST' }); location.reload(); } },
    ];
    return cmds.filter(c => !c.when || c.when()).map(c => ({ ...c, label: typeof c.label === 'function' ? c.label() : c.label }));
  }

  // lightweight fuzzy: subsequence match, contiguous + word-start bonuses. -1 = no match.
  function score(label, q) {
    if (!q) return 0;
    const s = label.toLowerCase(), n = q.toLowerCase();
    let si = 0, sc = 0, streak = 0;
    for (let qi = 0; qi < n.length; qi++) {
      let found = -1;
      for (let k = si; k < s.length; k++) { if (s[k] === n[qi]) { found = k; break; } }
      if (found < 0) return -1;
      sc += 10 - Math.min(9, found - si);            // closer to the last match = better
      if (found === si) sc += streak * 4;            // reward contiguous runs
      if (found === 0 || /[\s:/(]/.test(s[found - 1])) sc += 8; // word-start hit
      streak = found === si ? streak + 1 : 0;
      si = found + 1;
    }
    return sc;
  }

  let items = [], active = 0;

  function render(q) {
    const query = q.trim();
    let list = commands();
    if (query) {
      list = list.map(c => ({ c, s: score(c.label, query) })).filter(x => x.s >= 0)
        .sort((a, b) => b.s - a.s).map(x => x.c);
    }
    items = list;
    active = 0;
    results.innerHTML = '';
    if (!items.length) { results.innerHTML = '<div class="jump-empty">No matching command.</div>'; return; }
    let lastGroup = null;
    items.forEach((c, i) => {
      if (!query && c.group !== lastGroup) {
        lastGroup = c.group;
        const h = document.createElement('div');
        h.className = 'cmd-group'; h.textContent = c.group;
        results.append(h);
      }
      const row = document.createElement('button');
      row.className = 'jump-row cmd-row' + (i === active ? ' active' : '');
      row.dataset.i = i;
      row.innerHTML = `<div class="jr-main"><div class="jr-text">${escHtml(c.label)}</div></div>` +
        (c.hint ? `<span class="cmd-hint">${escHtml(c.hint)}</span>` : '');
      row.addEventListener('click', () => run(i));
      results.append(row);
    });
  }

  function setActive(i) {
    const rows = results.querySelectorAll('.cmd-row');
    if (!rows.length) return;
    active = (i + rows.length) % rows.length;
    rows.forEach((r, k) => r.classList.toggle('active', +r.dataset.i === active));
    rows[[...rows].findIndex(r => +r.dataset.i === active)]?.scrollIntoView({ block: 'nearest' });
  }

  function run(i) {
    const c = items[i];
    if (!c) return;
    close();
    try { c.run(); } catch (err) { showToast('Command failed'); console.error(err); }
  }

  function open() {
    if (typeof state === 'undefined' || !state) return;
    commitActiveText();
    closeAllPopovers?.();
    overlay.hidden = false;
    input.value = '';
    render('');
    input.focus();
  }
  function close() { overlay.hidden = true; }

  input.addEventListener('input', () => render(input.value));

  // called from app.js's global keydown while the overlay is open (mirrors jumpKeydown)
  window.paletteKeydown = function paletteKeydown(e) {
    if (overlay.hidden) return false;
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); return true; }
    if (e.key === 'Enter') { e.preventDefault(); run(active); return true; }
    return true; // consume everything else so app.js stays out of the way; typing reaches the input
  };

  window.openCommandPalette = open;
})();
