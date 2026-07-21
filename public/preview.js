/* Live hover preview (Roam42-style) — hovering a [[page link]], #tag or ((block ref))
 * pops up the target's live outline. It's a real, editable transclusion: the panel is
 * mounted under #page (so the delegated editing handlers apply) and rendered with the
 * same mountItem() the main view uses, guarded by transcludeStack so it never steals the
 * elById mapping. Edits sync back through the normal op path + syncMirrorRows.
 *
 * Only on devices with a real pointer (hover) — no-op on touch. Toggle in Settings. */
(function () {
  if (!window.matchMedia || !matchMedia('(hover: hover)').matches) return;

  const OPEN_DELAY = 380, CLOSE_DELAY = 220;
  let panel = null, targetId = null, anchor = null;
  let openTimer = null, closeTimer = null;

  const enabled = () => (typeof settings === 'undefined') || settings.hoverPreview !== false;

  // the internal node an anchor points at (#/n/<id>), or null for external/other links
  function idFor(a) {
    const m = (a.getAttribute('href') || '').match(/^#\/n\/([A-Za-z0-9]+)$/);
    return m && doc && doc.nodes[m[1]] ? m[1] : null;
  }

  function place(p, a) {
    const r = a.getBoundingClientRect();
    const pw = Math.min(p.offsetWidth, window.innerWidth - 16);
    const ph = p.offsetHeight;
    let left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    // prefer below the link; flip above when it would overflow the viewport
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8 && r.top - 6 - ph > 8) top = r.top - 6 - ph;
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  }

  function build(id) {
    const p = document.createElement('div');
    p.className = 'hover-preview';

    const head = document.createElement('div');
    head.className = 'hp-head';
    const title = document.createElement('span');
    title.className = 'hp-title';
    title.textContent = plainOf(N(id).text).trim() || 'Untitled';
    const open = document.createElement('button');
    open.className = 'hp-open';
    open.title = 'Open';
    open.textContent = '↗';
    open.addEventListener('click', () => { const t = id; close(true); location.hash = '#/n/' + t; });
    head.append(title, open);

    // the live, editable outline — same renderer as the page, without clobbering elById
    const body = document.createElement('div');
    body.className = 'hp-body tree';
    transcludeStack.push('__preview__');
    try { body.append(mountItem(id, false)); } finally { transcludeStack.pop(); }

    p.append(head, body);
    // the panel lives outside #tree, so the tree's link-click handler doesn't reach it —
    // navigate internal links (and open external ones) from here (focus was already blocked
    // by the #page pointerdown guard, so the anchor survives to this click)
    p.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (!a || a.classList.contains('bullet') || a.classList.contains('att-chip')) return;
      const href = a.getAttribute('href') || '';
      const m = href.match(/#\/n\/([A-Za-z0-9]+)/);
      e.preventDefault();
      if (m && doc.nodes[m[1]]) { const t = m[1]; close(true); zoomTo(t); }
      else if (/^https?:/.test(href)) window.open(href, '_blank', 'noopener');
    });
    p.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    p.addEventListener('mouseleave', scheduleClose);
    // keep open while the user is editing inside it; close shortly after focus leaves
    p.addEventListener('focusout', () => setTimeout(() => {
      if (panel && !panel.contains(document.activeElement)) scheduleClose();
    }, 0));
    return p;
  }

  function open(id, a) {
    if (panel && targetId === id) { clearTimeout(closeTimer); return; }
    close(false);
    if (!N(id)) return;
    targetId = id; anchor = a;
    panel = build(id);
    pageEl.append(panel);   // under #page → inherits the delegated editing handlers
    place(panel, a);
  }

  function close(flush) {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    if (!panel) return;
    // flush a half-typed edit before tearing the DOM down (delegated focusout may not fire in time)
    if (flush !== false && panel.contains(document.activeElement)) commitActiveText();
    panel.remove();
    panel = null; targetId = null; anchor = null;
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      // don't yank it away mid-edit
      if (panel && panel.contains(document.activeElement)) return;
      close(true);
    }, CLOSE_DELAY);
  }

  // ---- triggers (delegated on #page) ----
  pageEl.addEventListener('mouseover', e => {
    if (!enabled()) return;
    const a = e.target.closest && e.target.closest('a[href^="#/n/"]');
    if (!a || a.closest('.hover-preview')) return;   // no previews of previews
    const id = idFor(a);
    if (!id || id === state.zoom) return;            // skip links to the page you're already on
    clearTimeout(closeTimer);
    if (panel && targetId === id) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => open(id, a), OPEN_DELAY);
  });
  pageEl.addEventListener('mouseout', e => {
    const a = e.target.closest && e.target.closest('a[href^="#/n/"]');
    if (!a) return;
    clearTimeout(openTimer);
    scheduleClose();
  });

  // close on the things that make a floating panel stale
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel) close(true); }, true);
  window.addEventListener('scroll', () => { if (panel && !panel.contains(document.activeElement)) close(true); }, true);
  // a full re-render (navigation / structural edit) replaces #tree's children — drop the panel then
  if (typeof treeEl !== 'undefined') {
    new MutationObserver(() => { if (panel) close(true); }).observe(treeEl, { childList: true });
  }

  window.__closeHoverPreview = () => close(true);
})();
