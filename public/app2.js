/* ============================================================
   Tendril — feature modules (loads after app.js)
   sidebar/stars · slash menu · tag autocomplete · dates · fmtbar
   links · comments · mirrors UI · templates · presentations
   calendar · trash · capture · sharing · attachments · AI · init
   ============================================================ */
'use strict';

/* ---------------- A. sidebar & stars ---------------- */

const sideOpen = new Set(JSON.parse(localStorage.getItem('tendril-side-open') || '[]'));

function saveSideOpen() {
  localStorage.setItem('tendril-side-open', JSON.stringify([...sideOpen].slice(0, 500)));
}

window.renderSidebar = function renderSidebar() {
  if (SHARE_TOKEN || !doc) return;
  const starsBox = $('#side-stars');
  const starsSection = $('#side-stars-section');
  const stars = meta().stars;
  starsSection.hidden = !stars.length;
  starsBox.innerHTML = '';
  stars.forEach((s, idx) => {
    if (s.id && !doc.nodes[s.id]) return;
    const row = document.createElement('div');
    row.className = 'side-item';
    const a = document.createElement('a');
    a.href = s.id && s.id !== ROOT ? '#/n/' + s.id : '#/';
    const title = s.id && s.id !== ROOT ? (plainOf(N(s.id).text).trim() || 'Untitled') : 'Home';
    a.innerHTML = (s.q ? `<span class="side-star-q">“${escHtml(s.q)}”</span>` : '') + escHtml(title);
    a.addEventListener('click', () => { setTimeout(() => setSearch(s.q || ''), 50); });
    const rm = document.createElement('button');
    rm.className = 'side-remove';
    rm.title = 'Remove star';
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      meta().stars.splice(idx, 1);
      markDirty();
      renderSidebar();
      window.updateStarBtn();
    });
    row.append(a, rm);
    starsBox.append(row);
  });

  const treeBox = $('#side-tree');
  treeBox.innerHTML = '';
  const build = (id, depth) => {
    const wrap = document.createDocumentFragment();
    for (const c of kidsOf(id)) {
      const n = N(c);
      if (n.done && !settings.showCompleted) continue;
      const row = document.createElement('div');
      row.className = 'side-item';
      if (hasKids(c)) row.classList.add('has-kids');
      if (sideOpen.has(c)) row.classList.add('open');
      if (state.zoom === c) row.classList.add('current');
      const tw = document.createElement('button');
      tw.className = 'side-twirl';
      tw.innerHTML = CHEVRON;
      tw.addEventListener('click', () => {
        if (sideOpen.has(c)) sideOpen.delete(c); else sideOpen.add(c);
        saveSideOpen();
        renderSidebar();
      });
      const a = document.createElement('a');
      a.href = '#/n/' + c;
      a.textContent = plainOf(n.text).trim() || (n.mirror ? '(mirror)' : 'Untitled');
      row.append(tw, a);
      wrap.append(row);
      if (sideOpen.has(c) && hasKids(c) && depth < 12) {
        const kidsBox = document.createElement('div');
        kidsBox.className = 'side-kids';
        kidsBox.append(build(c, depth + 1));
        wrap.append(kidsBox);
      }
    }
    return wrap;
  };
  treeBox.append(build(ROOT, 0));
};

window.toggleStar = function toggleStar() {
  if (SHARE_TOKEN) return;
  const q = state.search.trim();
  const id = state.zoom;
  const stars = meta().stars;
  const idx = stars.findIndex(s => (s.id || ROOT) === id && (s.q || '') === q);
  if (idx >= 0) { stars.splice(idx, 1); showToast('Star removed'); }
  else { stars.push({ id, q }); showToast(q ? 'Search starred' : 'Page starred'); }
  markDirty();
  window.updateStarBtn();
  window.renderSidebar();
};

window.updateStarBtn = function updateStarBtn() {
  if (SHARE_TOKEN || !doc) return;
  const q = state.search.trim();
  const starred = meta().stars.some(s => (s.id || ROOT) === state.zoom && (s.q || '') === q);
  $('#btn-star').classList.toggle('starred', starred);
};

$('#btn-star').addEventListener('click', () => window.toggleStar());
$('#btn-sidebar').addEventListener('click', () => {
  settings.sidebar = !settings.sidebar;
  saveSettings();
  document.body.classList.toggle('sidebar-open', settings.sidebar && !SHARE_TOKEN);
  document.body.classList.toggle('sidebar-mobile', innerWidth < 900);
  if (settings.sidebar) window.renderSidebar();
});

/* ---------------- B. backlinks ---------------- */

window.renderBacklinks = function renderBacklinks() {
  if (!doc || state.zoom === HOME) { backlinksEl.hidden = true; return; }
  const target = state.zoom;
  const rows = [];
  for (const id of Object.keys(doc.nodes)) {
    if (id === target) continue;
    const n = doc.nodes[id];
    if (n.mirror === target || (n.text || '').includes('#/n/' + target)) {
      const pathIds = ancestorsOf(id).filter(a => a !== ROOT);
      rows.push({
        id: n.mirror === target ? (parentOf(id) || id) : id,
        label: n.mirror === target ? 'mirrored in ' + (plainOf(N(parentOf(id) || id)?.text || '').trim() || 'Untitled')
          : (plainOf(n.text).trim() || 'Untitled'),
        path: pathIds.map(a => plainOf(N(a).text).trim() || 'Untitled').join(' › '),
      });
    }
  }
  if (!rows.length) { backlinksEl.hidden = true; return; }
  backlinksEl.hidden = false;
  backlinksEl.innerHTML = '<h3>Linked from</h3>';
  for (const r of rows.slice(0, 30)) {
    const div = document.createElement('div');
    div.className = 'backlink-row';
    const a = document.createElement('a');
    a.href = '#/n/' + r.id;
    a.textContent = '↩ ' + r.label.slice(0, 80);
    div.append(a);
    if (r.path) {
      const span = document.createElement('span');
      span.className = 'backlink-path';
      span.textContent = r.path.slice(0, 90);
      div.append(span);
    }
    backlinksEl.append(div);
  }
};

/* ---------------- C. caret popovers (slash / tags / dates) ---------------- */

let caretPop = null;   // { type, ctx, start, items, active, el }
let pendingSlash = null;
let savedDateRange = null;

window.caretPopOpen = () => !!caretPop;

window.closeCaretPop = function closeCaretPop() {
  caretPop?.el?.remove();
  caretPop = null;
};

function caretViewportRect() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(false);
  let rect = r.getClientRects()[0] || r.getBoundingClientRect();
  if (!rect || (rect.top === 0 && rect.left === 0)) {
    const el = sel.anchorNode?.parentElement;
    if (el) rect = el.getBoundingClientRect();
  }
  return rect;
}

function openCaretPop(type, ctx, start, extra = {}) {
  window.closeCaretPop();
  currentPopover?.remove();
  currentPopover = null;
  const el = document.createElement('div');
  el.className = 'popover caret-pop';
  document.body.append(el);
  caretPop = { type, ctx, start, items: [], active: 0, el, ...extra };
  positionCaretPop();
  refreshCaretPop('');
}

function positionCaretPop() {
  if (!caretPop) return;
  const rect = caretViewportRect();
  if (!rect) return;
  const pr = caretPop.el.getBoundingClientRect();
  let left = clamp(rect.left, 8, innerWidth - pr.width - 8);
  let top = rect.bottom + 6;
  if (top + pr.height > innerHeight - 8) top = Math.max(8, rect.top - pr.height - 6);
  caretPop.el.style.left = left + 'px';
  caretPop.el.style.top = top + 'px';
}

function renderCaretItems(items, onPick, emptyMsg) {
  const el = caretPop.el;
  el.innerHTML = '';
  caretPop.items = items;
  caretPop.active = 0;
  caretPop.onPick = onPick;
  if (!items.length) {
    el.innerHTML = `<div class="jump-empty">${escHtml(emptyMsg || 'No matches')}</div>`;
    return;
  }
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'pop-item' + (i === 0 ? ' active' : '');
    b.innerHTML = `<span class="ic">${it.icon || '•'}</span><span>${escHtml(it.label)}</span>${it.hint ? `<span class="kbd-hint">${escHtml(it.hint)}</span>` : ''}`;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => onPick(it));
    el.append(b);
  });
  positionCaretPop();
}

function slashCommands(ctx) {
  const id = ctx.id;
  const cmds = [];
  const fmtCmd = (label, icon, fmt, hint) => ({
    label, icon, hint,
    fn: () => opSetFormat(id, fmt),
  });
  if (ctx.field === 'text') {
    cmds.push(
      fmtCmd('Heading 1', 'H₁', 'h1', '# '),
      fmtCmd('Heading 2', 'H₂', 'h2', '## '),
      fmtCmd('Heading 3', 'H₃', 'h3', '### '),
      fmtCmd('To-do', '☑', 'todo', '[] '),
      fmtCmd('Quote', '❝', 'quote', '> '),
      fmtCmd('Code block', '{ }', 'codeblock', '```'),
      fmtCmd('Divider', '—', 'divider', '---'),
      fmtCmd('Board (kanban)', '▦', 'board'),
      fmtCmd('Paragraph', '¶', 'p'),
      fmtCmd('Bullet (reset)', '•', 'bullet'),
    );
  }
  cmds.push({ label: 'Date…', icon: '📅', hint: '!!', fn: () => openDatePop(ctx) });
  if (ctx.field === 'text') {
    cmds.push(
      { label: 'Add note', icon: '≡', hint: 'Shift+Enter', fn: () => opAddNote(ctx) },
      { label: 'Complete', icon: '✓', hint: 'Ctrl+Enter', fn: () => opToggleDone(id) },
      { label: 'Duplicate', icon: '⧉', hint: 'Ctrl+D', fn: () => opDuplicate(id) },
      { label: 'Mirror', icon: '◇', hint: 'Alt+Shift+M', fn: () => opMirror(id) },
      { label: 'Attach file', icon: '📎', fn: () => attachTo(id) },
      { label: 'Comment', icon: '💬', fn: () => { const it = elById.get(id); window.showComments(it?.querySelector('.content') || document.body, id); } },
    );
    if (state.aiEnabled && !SHARE_TOKEN) {
      cmds.push({ label: 'Ask AI', icon: '✨', fn: () => askAI(id) });
    }
    for (const tpl of getTemplates().slice(0, 6)) {
      cmds.push({ label: 'Template: ' + tpl.label, icon: '🧩', fn: () => insertTemplate(tpl.id, ctx) });
    }
  }
  cmds.push({ label: 'Present', icon: '▶', fn: () => startPresent() });
  return cmds;
}

function refreshCaretPop(query) {
  if (!caretPop) return;
  const q = query.toLowerCase();
  if (caretPop.type === 'slash') {
    const items = slashCommands(caretPop.ctx).filter(c => c.label.toLowerCase().includes(q));
    renderCaretItems(items.slice(0, 12), it => runSlashCommand(it), 'No matching commands');
  } else if (caretPop.type === 'tag') {
    const prefix = caretPop.prefix;
    const all = collectTags().filter(t => t.toLowerCase().startsWith((prefix + q).toLowerCase()) && t.toLowerCase() !== (prefix + q).toLowerCase());
    renderCaretItems(all.slice(0, 8).map(t => ({ label: t, icon: t[0] === '@' ? '@' : '#', tag: t })),
      it => pickTag(it.tag), '');
    if (!all.length) window.closeCaretPop();
  }
}

function deletePlainRange(el, from, to) {
  // delete plain-text offsets [from, to) inside el
  const range = document.createRange();
  let remaining = from, endRemaining = to;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node, startSet = false, endSet = false;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!startSet && remaining <= len) { range.setStart(node, remaining); startSet = true; }
    if (!startSet) remaining -= len;
    if (!endSet && endRemaining <= len) { range.setEnd(node, endRemaining); endSet = true; break; }
    if (!endSet) endRemaining -= len;
  }
  if (startSet && endSet) range.deleteContents();
}

function runSlashCommand(it) {
  const { ctx, start } = caretPop;
  const caret = caretOffsetIn(ctx.el) ?? start;
  window.closeCaretPop();
  snapshot();
  deletePlainRange(ctx.el, start, caret);
  commitActiveText();
  it.fn();
}

let tagCache = null;
let tagCacheAt = 0;

function collectTags() {
  if (tagCache && Date.now() - tagCacheAt < 5000) return tagCache;
  const counts = new Map();
  for (const id of Object.keys(doc.nodes)) {
    const txt = plainOf(doc.nodes[id].text) + ' ' + (doc.nodes[id].note || '');
    for (const m of txt.matchAll(/(^|[\s(])([#@][\p{L}\p{N}_][\p{L}\p{N}_\-\/]*)/gu)) {
      counts.set(m[2], (counts.get(m[2]) || 0) + 1);
    }
  }
  tagCache = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  tagCacheAt = Date.now();
  return tagCache;
}

function pickTag(tag) {
  const { ctx, start } = caretPop;
  const caret = caretOffsetIn(ctx.el) ?? start;
  window.closeCaretPop();
  deletePlainRange(ctx.el, start, caret);
  document.execCommand('insertText', false, tag + ' ');
  scheduleCommit(ctx.el);
}

window.slashWillOpen = function slashWillOpen(ctx, offset) {
  pendingSlash = { id: ctx.id, field: ctx.field, start: offset };
};

window.editorInputHook = function editorInputHook(ctx) {
  // open slash menu right after '/' lands in the DOM
  if (pendingSlash && pendingSlash.id === ctx.id && pendingSlash.field === ctx.field) {
    const start = pendingSlash.start;
    pendingSlash = null;
    openCaretPop('slash', ctx, start);
    return;
  }
  const off = caretOffsetIn(ctx.el);
  if (off === null) { window.closeCaretPop(); return; }
  const before = (ctx.el.textContent || '').slice(0, off);

  if (caretPop && caretPop.type === 'slash') {
    if (off <= caretPop.start || !before.slice(caretPop.start).startsWith('/')) { window.closeCaretPop(); }
    else refreshCaretPop(before.slice(caretPop.start + 1, off));
    return;
  }
  if (caretPop && caretPop.type === 'tag') {
    const m = before.match(/([#@][\p{L}\p{N}_\-\/]*)$/u);
    if (!m || off <= caretPop.start) { window.closeCaretPop(); return; }
    refreshCaretPop(before.slice(caretPop.start + 1, off));
    return;
  }

  // ``` → code block
  if (ctx.field === 'text' && before === '```' && fmtOf(ctx.id) !== 'codeblock') {
    N(ctx.id).text = '';
    opSetFormat(ctx.id, 'codeblock');
    return;
  }

  // '!!' → date picker
  if (before.endsWith('!!') && ctx.field === 'text') {
    deletePlainRange(ctx.el, off - 2, off);
    scheduleCommit(ctx.el);
    openDatePop(ctx);
    return;
  }

  // '#'/'@' → tag autocomplete
  const tm = before.match(/(^|[\s(])([#@][\p{L}\p{N}_\-\/]*)$/u);
  if (tm && ctx.field === 'text' && fmtOf(ctx.id) !== 'codeblock') {
    const start = off - tm[2].length;
    const prefix = tm[2];
    if (collectTags().some(t => t.toLowerCase().startsWith(prefix.toLowerCase()) && t.length > prefix.length)) {
      openCaretPop('tag', ctx, start, { prefix });
      refreshCaretPop('');
    }
  }
};

window.caretPopKeydown = function caretPopKeydown(e) {
  if (!caretPop) return false;
  if (e.key === 'Escape') { e.preventDefault(); window.closeCaretPop(); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!caretPop.items.length) return true;
    caretPop.active = clamp(caretPop.active + (e.key === 'ArrowDown' ? 1 : -1), 0, caretPop.items.length - 1);
    $$('.pop-item', caretPop.el).forEach((el, i) => el.classList.toggle('active', i === caretPop.active));
    $$('.pop-item', caretPop.el)[caretPop.active]?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const it = caretPop.items[caretPop.active];
    if (it && caretPop.onPick) caretPop.onPick(it);
    else window.closeCaretPop();
    return true;
  }
  return false;
};

/* ---------------- D. date picker ---------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function isoFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function openDatePop(ctx) {
  window.closeCaretPop();
  const sel = getSelection();
  savedDateRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const el = document.createElement('div');
  el.className = 'popover caret-pop datepick';
  const quick = document.createElement('div');
  quick.className = 'quick';
  const today = new Date();
  const opts = [
    ['Today', 0], ['Tomorrow', 1], ['Next week', 7], ['In 2 weeks', 14], ['Next month', 30],
  ];
  for (const [label, days] of opts) {
    const b = document.createElement('button');
    b.textContent = label;
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => insertDate(ctx, isoFromDate(d)));
    quick.append(b);
  }
  const input = document.createElement('input');
  input.type = 'date';
  input.value = isoFromDate(today);
  input.addEventListener('change', () => { if (input.value) insertDate(ctx, input.value); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (input.value) insertDate(ctx, input.value); }
    if (e.key === 'Escape') { e.preventDefault(); window.closeCaretPop(); focusItem(ctx.id, ctx.field === 'title' ? 'title' : 'text', 'end'); }
    e.stopPropagation();
  });
  el.append(quick, input);
  document.body.append(el);
  caretPop = { type: 'date', ctx, items: [], active: 0, el, onPick: null };
  positionCaretPop();
}

function insertDate(ctx, iso) {
  window.closeCaretPop();
  const sel = getSelection();
  if (savedDateRange && ctx.el.contains(savedDateRange.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(savedDateRange);
  } else {
    setCaretOffset(ctx.el, 'end');
  }
  savedDateRange = null;
  snapshot();
  const r = getSelection().getRangeAt(0);
  r.collapse(false);
  const time = document.createElement('time');
  time.setAttribute('datetime', iso);
  time.textContent = fmtDateLabel(iso);
  const space = document.createTextNode(' ');
  r.insertNode(space);
  r.insertNode(time);
  const after = document.createRange();
  after.setStartAfter(space);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  scheduleCommit(ctx.el);
}

/* ---------------- E. inline formatting (fmtbar, colors, links) ---------------- */

const fmtbarEl = $('#fmtbar');

function selCtx() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const n = sel.anchorNode;
  const el = n instanceof Element ? n : n?.parentElement;
  return editableCtx(el);
}

const fmtbarUpdate = debounce(() => {
  if (state.readOnly) { fmtbarEl.hidden = true; return; }
  const sel = getSelection();
  if (!sel.rangeCount || sel.getRangeAt(0).collapsed) { fmtbarEl.hidden = true; return; }
  const ctx = selCtx();
  if (!ctx || ctx.field === 'note' || ctx.field === 'zoom-note' ||
      (ctx.field === 'text' && fmtOf(ctx.id) === 'codeblock')) {
    fmtbarEl.hidden = true;
    return;
  }
  if (!ctx.el.contains(sel.getRangeAt(0).endContainer)) { fmtbarEl.hidden = true; return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  fmtbarEl.hidden = false;
  const pr = fmtbarEl.getBoundingClientRect();
  fmtbarEl.style.left = clamp(rect.left + rect.width / 2 - pr.width / 2, 8, innerWidth - pr.width - 8) + 'px';
  fmtbarEl.style.top = Math.max(8, rect.top - pr.height - 8) + 'px';
}, 120);

document.addEventListener('selectionchange', fmtbarUpdate);

function stripInlineIn(root, test) {
  let changed = true;
  while (changed) {
    changed = false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (test(node)) {
        const parent = node.parentNode;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        changed = true;
        break;
      }
    }
  }
}

function applyInline(spec, elOverride) {
  // spec: { tag, className, href, stripPrefix }
  const sel = getSelection();
  if (!sel.rangeCount || sel.getRangeAt(0).collapsed) return;
  const ctx = elOverride ? editableCtx(elOverride) : selCtx();
  if (!ctx) return;
  const range = sel.getRangeAt(0);
  if (!ctx.el.contains(range.commonAncestorContainer)) return;
  snapshot();
  const frag = range.extractContents();
  if (spec.stripPrefix) {
    stripInlineIn(frag, n => n.tagName === 'SPAN' && [...n.classList].some(c => c.startsWith(spec.stripPrefix)));
  }
  if (spec.tag) {
    stripInlineIn(frag, n => n.tagName === spec.tag.toUpperCase());
  }
  let inserted;
  if (spec.tag && !spec.removeOnly) {
    const wrap = document.createElement(spec.tag);
    if (spec.className) wrap.className = spec.className;
    if (spec.href) { wrap.setAttribute('href', spec.href); wrap.setAttribute('rel', 'noopener'); }
    wrap.append(frag);
    inserted = wrap;
    range.insertNode(wrap);
  } else {
    inserted = frag.firstChild;
    range.insertNode(frag);
  }
  if (inserted) {
    const r = document.createRange();
    try { r.selectNodeContents(inserted.nodeType === 1 ? inserted : ctx.el); } catch { r.selectNodeContents(ctx.el); }
    sel.removeAllRanges();
    sel.addRange(r);
  }
  scheduleCommit(ctx.el);
}

window.wrapSelectionTag = (tag, className, el) => applyInline({ tag, className }, el);

const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'];
const COLOR_VALUES = {
  red: 'oklch(0.6 0.19 25)', orange: 'oklch(0.68 0.15 55)', yellow: 'oklch(0.75 0.13 92)',
  green: 'oklch(0.62 0.13 150)', blue: 'oklch(0.6 0.13 250)', purple: 'oklch(0.58 0.16 300)',
  pink: 'oklch(0.68 0.17 350)', gray: 'oklch(0.6 0.01 70)',
};

function showSwatches(anchor, prefix) {
  const range = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
  openPopover(anchor, pop => {
    const box = document.createElement('div');
    box.className = 'swatches';
    const none = document.createElement('button');
    none.className = 'swatch none';
    none.title = 'Remove';
    none.addEventListener('mousedown', e => e.preventDefault());
    none.addEventListener('click', () => {
      closeAllPopovers();
      if (range) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
      applyInline({ stripPrefix: prefix + '-', removeOnly: true });
    });
    box.append(none);
    for (const c of COLOR_NAMES) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = COLOR_VALUES[c];
      b.title = c;
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => {
        closeAllPopovers();
        if (range) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
        applyInline({ tag: 'span', className: `${prefix}-${c}`, stripPrefix: prefix + '-' });
      });
      box.append(b);
    }
    pop.append(box);
  });
}

fmtbarEl.addEventListener('mousedown', e => e.preventDefault());
fmtbarEl.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const cmd = btn.dataset.cmd;
  const ctx = selCtx();
  switch (cmd) {
    case 'bold': snapshot(); document.execCommand('bold'); if (ctx) scheduleCommit(ctx.el); break;
    case 'italic': snapshot(); document.execCommand('italic'); if (ctx) scheduleCommit(ctx.el); break;
    case 'underline': snapshot(); document.execCommand('underline'); if (ctx) scheduleCommit(ctx.el); break;
    case 'strike': snapshot(); document.execCommand('strikeThrough'); if (ctx) scheduleCommit(ctx.el); break;
    case 'code': applyInline({ tag: 'code' }); break;
    case 'link': if (ctx) window.openLinkDialog(ctx); break;
    case 'color': showSwatches(btn, 'tc'); break;
    case 'highlight': showSwatches(btn, 'hl'); break;
  }
});

/* ---------------- F. link dialog (Ctrl+K with selection) ---------------- */

const linkOverlay = $('#link-overlay');
const linkInput = $('#link-input');
const linkResults = $('#link-results');
let linkItems = [];
let linkActive = 0;
let linkCtx = null;
let linkRange = null;

window.openLinkDialog = function openLinkDialog(ctx) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.getRangeAt(0).collapsed) return;
  linkCtx = ctx;
  linkRange = sel.getRangeAt(0).cloneRange();
  linkOverlay.hidden = false;
  linkInput.value = '';
  renderLinkResults('');
  linkInput.focus();
};

function renderLinkResults(q) {
  linkItems = q.trim() && !/^https?:|^www\./i.test(q) ? searchNodes(q, 8) : (q.trim() ? [] : searchNodes('', 6));
  linkActive = 0;
  linkResults.innerHTML = '';
  if (/^https?:|^www\./i.test(q)) {
    linkResults.innerHTML = '<div class="jump-empty">Press Enter to link to this URL</div>';
    return;
  }
  linkItems.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'jump-row' + (i === 0 ? ' active' : '');
    b.innerHTML = `<div class="jr-text">${escHtml(it.plain.slice(0, 80))}</div>` +
      (it.path ? `<div class="jr-path">${escHtml(it.path)}</div>` : '');
    b.addEventListener('click', () => applyLink('#/n/' + it.id));
    linkResults.append(b);
  });
}

linkInput.addEventListener('input', () => renderLinkResults(linkInput.value));

function applyLink(href) {
  linkOverlay.hidden = true;
  if (!linkRange || !linkCtx) return;
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(linkRange);
  applyInline({ tag: 'a', href }, linkCtx.el);
  linkRange = null;
  linkCtx = null;
}

window.linkDlgKeydown = function linkDlgKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); linkOverlay.hidden = true; return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!linkItems.length) return;
    linkActive = clamp(linkActive + (e.key === 'ArrowDown' ? 1 : -1), 0, linkItems.length - 1);
    $$('.jump-row', linkResults).forEach((el, i) => el.classList.toggle('active', i === linkActive));
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = linkInput.value.trim();
    if (/^https?:/i.test(q)) applyLink(q);
    else if (/^www\./i.test(q)) applyLink('https://' + q);
    else if (linkItems[linkActive]) applyLink('#/n/' + linkItems[linkActive].id);
  }
};

linkOverlay.addEventListener('mousedown', e => { if (e.target === linkOverlay) linkOverlay.hidden = true; });

/* ---------------- G. comments ---------------- */

window.showComments = function showComments(anchor, id) {
  const pop = openPopover(anchor, p => {
    p.classList.add('comments-panel');
    const title = document.createElement('div');
    title.className = 'pop-title';
    title.textContent = 'Comments';
    const list = document.createElement('div');
    list.className = 'comments-list';
    const renderList = () => {
      list.innerHTML = '';
      const comments = N(id).comments || [];
      if (!comments.length) list.innerHTML = '<div class="jump-empty">No comments yet.</div>';
      comments.forEach((c, i) => {
        const div = document.createElement('div');
        div.className = 'comment';
        div.textContent = c.t;
        const metaRow = document.createElement('div');
        metaRow.className = 'comment-meta';
        const when = document.createElement('span');
        when.textContent = new Date(c.ts).toLocaleString();
        metaRow.append(when);
        if (!state.readOnly) {
          const del = document.createElement('button');
          del.textContent = 'delete';
          del.addEventListener('click', () => {
            snapshot();
            N(id).comments.splice(i, 1);
            if (!N(id).comments.length) delete N(id).comments;
            markDirty();
            renderList();
            refreshChip();
          });
          metaRow.append(del);
        }
        div.append(metaRow);
        list.append(div);
      });
    };
    renderList();
    p.append(title, list);
    if (!state.readOnly) {
      const inputRow = document.createElement('div');
      inputRow.className = 'comment-input-row';
      const ta = document.createElement('textarea');
      ta.placeholder = 'Write a comment…';
      ta.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); }
        if (e.key === 'Escape') { e.preventDefault(); closeAllPopovers(); }
      });
      const btn = document.createElement('button');
      btn.className = 'textbtn';
      btn.textContent = 'Add';
      const add = () => {
        const t = ta.value.trim();
        if (!t) return;
        snapshot();
        if (!N(id).comments) N(id).comments = [];
        N(id).comments.push({ t, ts: Date.now() });
        touch(id);
        markDirty();
        ta.value = '';
        renderList();
        refreshChip();
      };
      btn.addEventListener('click', add);
      inputRow.append(ta, btn);
      p.append(inputRow);
      setTimeout(() => ta.focus(), 30);
    }
  });
  const refreshChip = () => {
    const item = elById.get(id);
    if (!item) return;
    let chip = item.querySelector(':scope > .row > .comment-chip');
    const count = (N(id).comments || []).length;
    if (!count) { chip?.remove(); return; }
    if (!chip) {
      chip = document.createElement('button');
      chip.className = 'comment-chip';
      item.querySelector(':scope > .row').append(chip);
    }
    chip.innerHTML = `💬 ${count}`;
  };
  return pop;
};

/* ---------------- H. templates ---------------- */

function getTemplates() {
  const out = [];
  for (const id of Object.keys(doc.nodes)) {
    const plain = plainOf(doc.nodes[id].text);
    if (plain.includes('#template')) {
      out.push({ id, label: plain.replace(/#template/g, '').trim().slice(0, 40) || 'Untitled' });
    }
  }
  return out;
}

function saveAsTemplate(id) {
  if (plainOf(N(id).text).includes('#template')) { showToast('Already a template'); return; }
  snapshot();
  N(id).text = sanitizeHtml(N(id).text + ' <span>#template</span>');
  touch(id);
  renderPage();
  markDirty();
  showToast('Saved as template — insert it anywhere with /template');
}

function insertTemplate(tplId, ctx) {
  if (!doc.nodes[tplId]) return;
  commitActiveText();
  snapshot();
  const copy = cloneSubtree(tplId);
  N(copy).text = sanitizeHtml(N(copy).text.replace(/#template/g, '').trim());
  if (ctx.field === 'title') {
    insertAt(state.zoom, 0, copy);
  } else {
    const n = N(ctx.id);
    if (!plainOf(n.text).length && !hasKids(ctx.id)) {
      const p = parentOf(ctx.id);
      const at = kidsOf(p).indexOf(ctx.id);
      deleteSubtree(ctx.id);
      insertAt(p, at, copy);
    } else {
      insertAt(parentOf(ctx.id), kidsOf(parentOf(ctx.id)).indexOf(ctx.id) + 1, copy);
    }
  }
  renderPage();
  focusItem(copy, 'text', 'end');
  markDirty();
}

/* ---------------- I. presentation mode ---------------- */

const presentOverlay = $('#present-overlay');
const presentSlide = $('#present-slide');
let slides = [];
let slideIdx = 0;

function buildSlideList(rootId) {
  const list = [];
  const rootTitle = rootId === HOME && !SHARE_TOKEN ? 'Home' : plainOf(N(rootId).text).trim() || 'Untitled';
  list.push({ title: rootTitle, note: N(rootId).note, kids: kidsOf(rootId), overview: true });
  for (const c of kidsOf(rootId)) {
    if (N(c).done && !settings.showCompleted) continue;
    if (fmtOf(c) === 'divider') continue;
    list.push({ title: plainOf(N(c).text).trim() || 'Untitled', note: N(c).note, kids: kidsOf(c) });
  }
  return list;
}

function renderSlide() {
  const s = slides[slideIdx];
  presentSlide.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = s.title;
  presentSlide.append(h);
  if (s.note) {
    const note = document.createElement('div');
    note.className = 'p-note';
    note.textContent = s.note;
    presentSlide.append(note);
  }
  const buildUl = (ids, depth) => {
    const ul = document.createElement('ul');
    for (const id of ids) {
      const n = N(id);
      if (n.done && !settings.showCompleted) continue;
      const li = document.createElement('li');
      if (n.done) li.className = 'done';
      li.textContent = plainOf(n.text).trim() || (n.mirror ? '(mirror)' : '');
      if (depth < 2 && hasKids(id)) li.append(buildUl(kidsOf(id), depth + 1));
      ul.append(li);
    }
    return ul;
  };
  if (s.kids.length) presentSlide.append(buildUl(s.kids, s.overview ? 1 : 0));
  $('#present-pos').textContent = `${slideIdx + 1} / ${slides.length}`;
}

function startPresent(rootId) {
  commitActiveText();
  slides = buildSlideList(rootId || state.zoom);
  if (!slides.length) return;
  slideIdx = 0;
  presentOverlay.hidden = false;
  renderSlide();
}

window.presentKeydown = function presentKeydown(e) {
  if (presentOverlay.hidden) return false;
  if (e.key === 'Escape') { e.preventDefault(); presentOverlay.hidden = true; return true; }
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
    e.preventDefault();
    if (slideIdx < slides.length - 1) { slideIdx++; renderSlide(); }
    return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    if (slideIdx > 0) { slideIdx--; renderSlide(); }
    return true;
  }
  return true;
};

presentOverlay.addEventListener('click', e => {
  if (e.target.closest('.present-foot')) return;
  if (slideIdx < slides.length - 1) { slideIdx++; renderSlide(); }
  else presentOverlay.hidden = true;
});

/* ---------------- J. calendar ---------------- */

let calMonth = null; // Date at first of month

function datesIndex() {
  const map = new Map();
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    const html = (n.text || '') + ' ' + (n.note || '');
    for (const m of html.matchAll(/datetime="(\d{4}-\d{2}-\d{2})/g)) {
      if (!map.has(m[1])) map.set(m[1], []);
      if (map.get(m[1]).length < 8) map.get(m[1]).push({ id, text: plainOf(n.text).trim().slice(0, 40) || 'Untitled', done: n.done });
    }
  }
  return map;
}

function renderCalendar() {
  const grid = $('#cal-grid');
  const y = calMonth.getFullYear(), mo = calMonth.getMonth();
  $('#cal-title').textContent = calMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  grid.innerHTML = '';
  for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    const d = document.createElement('div');
    d.className = 'cal-dow';
    d.textContent = dow;
    grid.append(d);
  }
  const idx = datesIndex();
  const first = new Date(y, mo, 1);
  let startOffset = (first.getDay() + 6) % 7;
  const today = todayStr();
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, mo, 1 - startOffset + i);
    const iso = isoFromDate(d);
    const cell = document.createElement('div');
    cell.className = 'cal-day' + (d.getMonth() !== mo ? ' other' : '') + (iso === today ? ' today' : '');
    cell.innerHTML = `<div class="cal-num">${d.getDate()}</div>`;
    for (const it of idx.get(iso) || []) {
      const a = document.createElement('a');
      a.className = 'cal-item';
      a.href = '#/n/' + it.id;
      a.textContent = (it.done ? '✓ ' : '• ') + it.text;
      a.addEventListener('click', () => { $('#calendar-overlay').hidden = true; });
      cell.append(a);
    }
    grid.append(cell);
    if (i >= 34 && d.getMonth() !== mo && d.getDate() >= 7) break;
  }
}

function showCalendar() {
  calMonth = calMonth || new Date(new Date().setDate(1));
  $('#calendar-overlay').hidden = false;
  renderCalendar();
}

$('#cal-prev').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });
$('#cal-close').addEventListener('click', () => { $('#calendar-overlay').hidden = true; });
$('#calendar-overlay').addEventListener('mousedown', e => { if (e.target.id === 'calendar-overlay') e.target.hidden = true; });

/* ---------------- K. trash ---------------- */

function showTrash() {
  const listEl = $('#trash-list');
  const render = () => {
    const entries = trashList();
    listEl.innerHTML = entries.length ? '' : '<div class="trash-empty-msg">The trash is empty. Deleted items rest here for 30 days.</div>';
    entries.forEach((entry, i) => {
      const rootNode = entry.nodes[entry.root];
      const row = document.createElement('div');
      row.className = 'trash-row';
      const text = document.createElement('span');
      text.className = 'trash-text';
      text.textContent = plainOf(rootNode?.text || '').trim() || 'Untitled';
      const metaEl = document.createElement('span');
      metaEl.className = 'trash-meta';
      const count = Object.keys(entry.nodes).length - 1;
      metaEl.textContent = `${count ? `+${count} · ` : ''}${new Date(entry.ts).toLocaleDateString()}`;
      const restore = document.createElement('button');
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => {
        snapshot();
        restoreTrashEntry(entry);
        trashList().splice(i, 1);
        renderPage();
        markDirty();
        render();
        showToast('Restored');
      });
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Delete forever';
      del.addEventListener('click', () => {
        snapshot();
        trashList().splice(i, 1);
        markDirty();
        render();
      });
      row.append(text, metaEl, restore, del);
      listEl.append(row);
    });
  };
  render();
  $('#trash-overlay').hidden = false;
}

function restoreTrashEntry(entry) {
  // remap ids on conflict (e.g. restored twice via undo interplay)
  const idMap = new Map();
  for (const oldId of Object.keys(entry.nodes)) {
    idMap.set(oldId, doc.nodes[oldId] ? uid() : oldId);
  }
  for (const [oldId, node] of Object.entries(entry.nodes)) {
    const cloned = structuredClone(node);
    cloned.id = idMap.get(oldId);
    cloned.children = (cloned.children || []).map(c => idMap.get(c) || c).filter(c => entry.nodes[[...idMap.entries()].find(([, v]) => v === c)?.[0]] || entry.nodes[c]);
    cloned.children = (node.children || []).map(c => idMap.get(c)).filter(Boolean);
    doc.nodes[cloned.id] = cloned;
  }
  const newRoot = idMap.get(entry.root);
  const parent = entry.parent && doc.nodes[entry.parent] ? entry.parent : HOME;
  rebuildParentMap();
  insertAt(parent, Math.min(entry.index ?? 0, kidsOf(parent).length), newRoot);
  rebuildParentMap();
}

$('#trash-close').addEventListener('click', () => { $('#trash-overlay').hidden = true; });
$('#trash-empty').addEventListener('click', () => {
  if (!trashList().length) return;
  if (!confirm('Permanently delete everything in the trash?')) return;
  snapshot();
  doc.trash = [];
  markDirty();
  $('#trash-list').innerHTML = '<div class="trash-empty-msg">The trash is empty.</div>';
});
$('#trash-overlay').addEventListener('mousedown', e => { if (e.target.id === 'trash-overlay') e.target.hidden = true; });

/* ---------------- L. quick capture ---------------- */

const captureOverlay = $('#capture-overlay');
const captureInput = $('#capture-input');

window.showCapture = function showCapture() {
  commitActiveText();
  captureOverlay.hidden = false;
  captureInput.value = '';
  captureInput.focus();
};

function findOrCreateInbox() {
  let inbox = kidsOf(ROOT).find(id => plainOf(N(id).text).trim().toLowerCase() === 'inbox');
  if (!inbox) {
    inbox = makeNode('Inbox');
    insertAt(ROOT, 0, inbox);
  }
  return inbox;
}

function doCapture() {
  const text = captureInput.value;
  const forest = parseIndentedText(text);
  if (!forest.length) { captureOverlay.hidden = true; return; }
  snapshot();
  const inbox = findOrCreateInbox();
  const materialize = (spec, parent) => {
    const id = makeNode(spec.text);
    insertAt(parent, kidsOf(parent).length, id);
    spec.children.forEach(c => materialize(c, id));
  };
  forest.forEach(s => materialize(s, inbox));
  captureOverlay.hidden = true;
  renderPage();
  markDirty();
  showToast(`Captured to Inbox`, { label: 'Open', fn: () => zoomTo(inbox) });
}

window.captureKeydown = function captureKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); captureOverlay.hidden = true; return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCapture(); }
};

$('#capture-save').addEventListener('click', doCapture);
captureOverlay.addEventListener('mousedown', e => { if (e.target === captureOverlay) captureOverlay.hidden = true; });

/* ---------------- M. sharing ---------------- */

async function fetchShares() {
  if (SHARE_TOKEN) return;
  try {
    state.shares = await (await fetch('/api/shares')).json();
  } catch { state.shares = []; }
}

function showSharePop(anchor, id) {
  const existing = state.shares.find(s => s.id === id);
  openPopover(anchor, pop => {
    pop.classList.add('share-pop');
    const title = document.createElement('div');
    title.className = 'pop-title';
    title.textContent = 'Share this item';
    pop.append(title);
    if (existing) {
      const linkRow = document.createElement('div');
      linkRow.className = 'share-link-row';
      const input = document.createElement('input');
      input.readOnly = true;
      input.value = location.origin + '/s/' + existing.token;
      input.addEventListener('focus', () => input.select());
      const copy = document.createElement('button');
      copy.className = 'textbtn';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        await navigator.clipboard?.writeText(input.value);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      linkRow.append(input, copy);
      pop.append(linkRow);
      const modeNote = document.createElement('div');
      modeNote.className = 'pop-title';
      modeNote.textContent = existing.mode === 'edit' ? 'Anyone with the link can edit' : 'Anyone with the link can view';
      pop.append(modeNote);
      pop.append(menuItem('Revoke link', '✕', async () => {
        await fetch('/api/shares/' + existing.token, { method: 'DELETE' });
        await fetchShares();
        renderPage();
        showToast('Share link revoked');
      }, { danger: true }));
    } else {
      const make = mode => async () => {
        const res = await fetch('/api/shares', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: id, mode }),
        });
        const data = await res.json();
        await fetchShares();
        renderPage();
        await navigator.clipboard?.writeText(location.origin + data.url).catch(() => {});
        showToast('Share link created and copied');
      };
      pop.append(
        menuItem('Share — view only', '👁', make('view')),
        menuItem('Share — can edit', '✎', make('edit')),
      );
    }
  });
}

/* ---------------- N. attachments & AI ---------------- */

let attachTargetId = null;

function attachTo(id) {
  attachTargetId = id;
  $('#attach-file').click();
}

$('#attach-file').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length && attachTargetId) window.uploadAttachments(attachTargetId, files);
});

window.uploadAttachments = async function uploadAttachments(id, files) {
  if (state.readOnly || SHARE_TOKEN) { showToast('Attachments are unavailable on shared links'); return; }
  snapshot();
  let added = 0;
  for (const file of files) {
    if (file.size > 32 * 1024 * 1024) { showToast(`"${file.name}" is over the 32 MB limit`); continue; }
    try {
      const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name || 'pasted-image.png'), {
        method: 'POST',
        body: file,
      });
      if (!res.ok) throw new Error('upload failed');
      const data = await res.json();
      const n = N(id);
      if (!n.files) n.files = [];
      n.files.push({ url: data.url, name: data.name, type: file.type || '' });
      touch(id);
      added++;
    } catch {
      showToast(`Could not upload "${file.name}"`);
    }
  }
  if (added) {
    renderPage();
    markDirty();
    showToast(`Attached ${added} file${added === 1 ? '' : 's'}`);
  }
};

function askAI(id) {
  const item = elById.get(id);
  const anchor = item?.querySelector('.content') || document.body;
  openPopover(anchor, pop => {
    const title = document.createElement('div');
    title.className = 'pop-title';
    title.textContent = '✨ Ask AI about this item';
    const row = document.createElement('div');
    row.className = 'comment-input-row';
    const ta = document.createElement('textarea');
    ta.placeholder = 'e.g. break this into steps, brainstorm ideas, summarize…';
    const go = document.createElement('button');
    go.className = 'textbtn';
    go.textContent = 'Go';
    const run = async () => {
      const prompt = ta.value.trim();
      if (!prompt) return;
      go.textContent = '…';
      go.disabled = true;
      try {
        const res = await fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, context: subtreeToText(id, 0) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'AI request failed');
        const forest = parseIndentedText(data.text || '');
        if (!forest.length) throw new Error('the AI returned nothing usable');
        closeAllPopovers();
        snapshot();
        N(id).collapsed = false;
        const materialize = (spec, parent) => {
          const nid = makeNode(spec.text);
          insertAt(parent, kidsOf(parent).length, nid);
          spec.children.forEach(c => materialize(c, nid));
        };
        forest.forEach(s => materialize(s, id));
        renderPage();
        markDirty();
        showToast('AI results added as sub-items', { label: 'Undo', fn: undo });
      } catch (err) {
        showToast(String(err.message || err));
        go.textContent = 'Go';
        go.disabled = false;
      }
    };
    go.addEventListener('click', run);
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
      if (e.key === 'Escape') { e.preventDefault(); closeAllPopovers(); }
    });
    row.append(ta, go);
    pop.append(title, row);
    setTimeout(() => ta.focus(), 30);
  });
}

/* ---------------- O. item menu ---------------- */

window.showItemMenu = function showItemMenu(anchor, id) {
  const n = N(id);
  if (isMirror(id)) {
    openPopover(anchor, pop => {
      const t = mirrorTarget(id);
      if (t) pop.append(menuItem('Open original', '◇', () => zoomTo(t)));
      pop.append(menuItem('Delete mirror', '✕', () => opDelete(id), { danger: true }));
    });
    return;
  }
  openPopover(anchor, pop => {
    if (!state.readOnly) {
      pop.append(
        menuItem(n.done ? 'Mark incomplete' : 'Complete', '✓', () => opToggleDone(id), { hint: 'Ctrl+Enter' }),
        menuItem(n.note != null ? 'Edit note' : 'Add note', '≡', () => opAddNote({ id, field: 'text' }), { hint: 'Shift+Enter' }),
      );
    }
    pop.append(menuItem('Zoom in', '◎', () => zoomTo(id), { hint: 'Alt+→' }));
    if (!state.readOnly) {
      // turn into…
      const title = document.createElement('div');
      title.className = 'pop-title';
      title.textContent = 'Turn into';
      pop.append(title);
      const seg = document.createElement('div');
      seg.className = 'seg';
      const types = [['•', 'bullet'], ['☑', 'todo'], ['H₁', 'h1'], ['H₂', 'h2'], ['❝', 'quote'], ['{}', 'codeblock'], ['▦', 'board']];
      for (const [label, fmt] of types) {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = fmt;
        if (fmtOf(id) === fmt) b.classList.add('active');
        b.addEventListener('click', () => { closeAllPopovers(); opSetFormat(id, fmt); });
        seg.append(b);
      }
      pop.append(seg);
      pop.append(document.createElement('hr'));
      pop.append(
        menuItem('Duplicate', '⧉', () => opDuplicate(id), { hint: 'Ctrl+D' }),
        menuItem('Mirror', '◇', () => opMirror(id), { hint: 'Alt+Shift+M' }),
        menuItem('Comments', '💬', () => {
          const it = elById.get(id);
          window.showComments(it?.querySelector(':scope > .row') || anchor, id);
        }),
        menuItem('Attach file', '📎', () => attachTo(id)),
        menuItem('Save as template', '🧩', () => saveAsTemplate(id)),
      );
      if (state.aiEnabled) pop.append(menuItem('Ask AI', '✨', () => askAI(id)));
    }
    pop.append(document.createElement('hr'));
    if (!SHARE_TOKEN && state.authRequired !== null) {
      pop.append(menuItem(state.shares.some(s => s.id === id) ? 'Sharing…' : 'Share', '🌐', () => {
        showSharePop(anchor, id);
      }));
    }
    pop.append(
      menuItem('Present', '▶', () => { zoomTo(id); setTimeout(() => startPresent(id), 100); }),
      menuItem('Copy link', '🔗', async () => {
        await navigator.clipboard?.writeText(location.origin + location.pathname + '#/n/' + id);
        showToast('Link copied');
      }, { hint: 'Alt+Shift+L' }),
      menuItem('Copy as text', '📄', async () => {
        await navigator.clipboard?.writeText(subtreeToText(id, 0));
        showToast('Copied as indented text');
      }),
    );
    if (!state.readOnly) {
      pop.append(
        document.createElement('hr'),
        menuItem('Delete', '✕', () => opDelete(id), { hint: 'Ctrl+Shift+⌫', danger: true }),
      );
    }
  });
};

/* ---------------- P. main menu ---------------- */

function segRow(options, getCurrent, onPick) {
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [label, value] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    if (getCurrent() === value) b.classList.add('active');
    b.addEventListener('click', () => {
      onPick(value);
      $$('button', seg).forEach(x => x.classList.toggle('active', x === b));
    });
    seg.append(b);
  }
  return seg;
}

$('#btn-menu').addEventListener('click', e => {
  if (currentPopover) { closeAllPopovers(); return; }
  openPopover(e.currentTarget, pop => {
    const addTitle = t => {
      const el = document.createElement('div');
      el.className = 'pop-title';
      el.textContent = t;
      pop.append(el);
    };
    addTitle('Theme');
    pop.append(segRow([['Light', 'light'], ['Auto', 'auto'], ['Dark', 'dark']],
      () => settings.theme, v => { settings.theme = v; saveSettings(); applyTheme(); }));
    addTitle('Accent');
    pop.append(segRow([['Clay', 'terracotta'], ['Sage', 'sage'], ['Indigo', 'indigo'], ['Ink', 'ink']],
      () => settings.accent, v => { settings.accent = v; saveSettings(); applyTheme(); }));
    addTitle('Font');
    pop.append(segRow([['Sans', 'default'], ['Serif', 'serif'], ['System', 'system'], ['Mono', 'mono']],
      () => settings.font, v => { settings.font = v; saveSettings(); applyTheme(); }));
    addTitle('Density');
    pop.append(segRow([['Cozy', 'cozy'], ['Compact', 'compact']],
      () => settings.density, v => { settings.density = v; saveSettings(); applyTheme(); }));

    pop.append(document.createElement('hr'));
    pop.append(menuItem(settings.showCompleted ? 'Hide completed' : 'Show completed', '☑', () => {
      settings.showCompleted = !settings.showCompleted;
      saveSettings();
      renderPage();
    }, { hint: 'Ctrl+O' }));
    pop.append(menuItem(settings.embeds ? 'Disable video embeds' : 'Enable video embeds', '▶', () => {
      settings.embeds = !settings.embeds;
      saveSettings();
      renderPage();
    }));
    pop.append(menuItem(settings.copyTag ? 'Stop tagging duplicates #copy' : 'Tag duplicates with #copy', '⧉', () => {
      settings.copyTag = !settings.copyTag;
      saveSettings();
    }));

    if (!SHARE_TOKEN) {
      pop.append(document.createElement('hr'));
      pop.append(
        menuItem('Calendar', '📅', () => showCalendar()),
        menuItem('Quick capture', '📥', () => window.showCapture(), { hint: 'Ctrl+Shift+Space' }),
        menuItem('Trash', '🗑', () => showTrash()),
        menuItem('Present', '▶', () => startPresent()),
      );
    }
    pop.append(document.createElement('hr'));
    pop.append(
      menuItem('Expand all', '▾', () => setCollapseAll(false)),
      menuItem('Collapse all', '▸', () => setCollapseAll(true)),
      document.createElement('hr'),
      menuItem('Export as text', '↧', () => exportDoc('txt')),
      menuItem('Export as Markdown', '↧', () => exportDoc('md')),
      menuItem('Export as OPML', '↧', () => exportDoc('opml')),
      menuItem('Export as JSON', '↧', () => exportDoc('json')),
    );
    if (!SHARE_TOKEN && !state.readOnly) {
      pop.append(menuItem('Import…', '↥', () => $('#import-file').click()));
    }
    pop.append(document.createElement('hr'));
    pop.append(menuItem('Keyboard shortcuts', '⌘', () => showHelp(), { hint: 'Ctrl+/' }));
    if (state.authRequired && !SHARE_TOKEN) {
      pop.append(menuItem('Lock (log out)', '🔒', async () => {
        await fetch('/api/logout', { method: 'POST' });
        location.reload();
      }));
    }
    const foot = document.createElement('div');
    foot.className = 'pop-title';
    const total = Object.keys(doc.nodes).length - 1;
    foot.textContent = `${total} item${total === 1 ? '' : 's'} · v${state.version}`;
    pop.append(foot);
  });
});

/* ---------------- Q. service worker & init ---------------- */

async function init() {
  applyTheme();
  document.body.classList.toggle('sidebar-mobile', innerWidth < 900);
  if (SHARE_TOKEN) {
    $('#btn-sidebar').hidden = true;
    $('#btn-star').hidden = true;
  }
  try {
    if (!SHARE_TOKEN) {
      await ensureAuth();
      await fetchShares();
    }
    await loadDoc();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">Could not load the outline. <br><br><code>${escHtml(String(err.message || err))}</code></div>`;
    return;
  }
  const m = location.hash.match(/^#\/n\/([A-Za-z0-9]+)/);
  if (m && doc.nodes[m[1]]) {
    const target = m[1];
    if (!SHARE_TOKEN || target === HOME || isAncestor(HOME, target)) state.zoom = target;
  }
  renderPage();
  setSaveUI(dirty ? 'saving' : 'saved');
  connectSSE();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

window.addEventListener('resize', () => {
  document.body.classList.toggle('sidebar-mobile', innerWidth < 900);
});

init();
