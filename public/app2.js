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
      const cid = contentIdOf(c); // a mirror lists its target's text and subtree
      const n = N(cid);
      if (n.done && !settings.showCompleted) continue;
      const row = document.createElement('div');
      row.className = 'side-item';
      if (hasKids(cid)) row.classList.add('has-kids');
      if (sideOpen.has(c)) row.classList.add('open');
      if (state.zoom === cid) row.classList.add('current');
      const tw = document.createElement('button');
      tw.className = 'side-twirl';
      tw.innerHTML = CHEVRON;
      tw.addEventListener('click', () => {
        if (sideOpen.has(c)) sideOpen.delete(c); else sideOpen.add(c);
        saveSideOpen();
        renderSidebar();
      });
      const a = document.createElement('a');
      a.href = '#/n/' + cid;
      a.textContent = plainOf(n.text).trim() || 'Untitled';
      row.append(tw, a);
      wrap.append(row);
      if (sideOpen.has(c) && hasKids(cid) && depth < 12) {
        const kidsBox = document.createElement('div');
        kidsBox.className = 'side-kids';
        kidsBox.append(build(cid, depth + 1));
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
  // positionPopover only reads anchor.getBoundingClientRect(), so a fixed caret rect serves as the anchor
  if (rect) positionPopover(caretPop.el, { getBoundingClientRect: () => rect });
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
    // rhizome: Roam row layout — label left, keyboard hint and icon right
    b.innerHTML = `<span class="pop-label">${escHtml(it.label)}</span>${it.hint ? `<span class="kbd-hint">${escHtml(it.hint)}</span>` : ''}<span class="ic">${it.icon || '•'}</span>`;
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
      fmtCmd('Numbered list', '1.', 'number', '1. '),
      fmtCmd('Quote', '❝', 'quote', '> '),
      fmtCmd('Code block', '{ }', 'codeblock', '```'),
      fmtCmd('Divider', '—', 'divider', '---'),
      fmtCmd('Board (kanban)', '▦', 'board'),
      fmtCmd('Paragraph', '¶', 'p'),
      fmtCmd('Bullet (reset)', '•', 'bullet'),
    );
  }
  if (ctx.field === 'text') cmds.push(...(window.rhizomeSlashCommands?.(ctx, caretPop?.start ?? null) || []));
  cmds.push({ label: 'Date…', icon: '📅', hint: '!!', fn: () => openDatePop(ctx) });
  if (ctx.field === 'text') {
    // template inserts first, so typing "/template" ranks insertion above "Save as template"
    for (const tpl of getTemplates().slice(0, 6)) {
      cmds.push({ label: 'Template: ' + tpl.label, icon: '🧩', fn: () => insertTemplate(tpl.id, ctx) });
    }
    cmds.push(
      { label: 'Add note', icon: '≡', hint: 'Shift+Enter', fn: () => opAddNote(ctx) },
      { label: 'Complete', icon: '✓', hint: 'Ctrl+Enter', fn: () => opToggleDone(id) },
      { label: 'Duplicate', icon: '⧉', hint: 'Ctrl+D', fn: () => opDuplicate(id) },
      { label: 'Attach file', icon: '📎', fn: () => attachTo(id) },
      { label: 'Comment', icon: '💬', fn: () => { const it = elById.get(id); window.showComments(it?.querySelector('.content') || document.body, id); } },
      { label: 'Count items', icon: '#', fn: () => opCount(id) },
      { label: 'Move to…', icon: '→', fn: () => openNodePicker('Move to…', t => moveItemTo(id, t), subtreeOf(id)) },
      { label: 'Move to Today', icon: '▦', fn: () => moveItemToDay(id, dateOffset(0)) },
      { label: 'Move to Tomorrow', icon: '▦', fn: () => moveItemToDay(id, dateOffset(1)) },
      { label: 'Move to Next Week', icon: '▦', fn: () => moveItemToDay(id, dateOffset(7)) },
      { label: 'Move to Date…', icon: '📅', fn: () => pickDate(nodeAnchor(id), iso => moveItemToDay(id, iso)) },
      { label: 'Mirror', icon: '◇', hint: 'Alt+Shift+M', fn: () => opMirror(id) },
      { label: 'Mirror here…', icon: '◈', fn: () => mirrorHere(id) },
      { label: 'Mirror to…', icon: '◇', fn: () => openNodePicker('Mirror to…', t => mirrorItemTo(id, t), subtreeOf(id)) },
      { label: 'Mirror to Today', icon: '◇', fn: () => mirrorItemToDate(id, dateOffset(0)) },
      { label: 'Mirror to Date…', icon: '◇', fn: () => pickDate(nodeAnchor(id), iso => mirrorItemToDate(id, iso)) },
      { label: 'Sort A → Z', icon: '↓', fn: () => opSort(id, 1) },
      { label: 'Sort Z → A', icon: '↑', fn: () => opSort(id, -1) },
      { label: 'Expand all', icon: '▾', fn: () => setSubtreeCollapsed(id, false) },
      { label: 'Collapse all', icon: '▸', fn: () => setSubtreeCollapsed(id, true) },
      { label: 'Save as template', icon: '🧩', fn: () => saveAsTemplate(id) },
      { label: 'Export…', icon: '⬇', fn: () => exportNodePop(nodeAnchor(id), id) },
      { label: 'Copy link', icon: '🔗', hint: 'Alt+Shift+L', fn: () => { navigator.clipboard?.writeText(location.origin + location.pathname + '#/n/' + id); showToast('Link copied'); } },
    );
    if (state.aiEnabled && !SHARE_TOKEN) {
      cmds.push({ label: 'Ask AI…', icon: '✨', fn: () => askAI(id) });
      for (const [label, instr] of AI_PRESETS) cmds.push({ label, icon: '✨', fn: () => aiRun(id, instr) });
    }
    if (!SHARE_TOKEN) cmds.push({ label: 'Share', icon: '🌐', fn: () => showSharePop(nodeAnchor(id), id) });
    cmds.push({ label: 'Delete', icon: '✕', fn: () => opDelete(id) });
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
    // q is everything typed after the # / @ sigil, regardless of the prefix length at open
    const needle = (caretPop.prefix[0] + q).toLowerCase();
    const all = collectTags().filter(t => t.toLowerCase().startsWith(needle) && t.toLowerCase() !== needle);
    renderCaretItems(all.slice(0, 8).map(t => ({ label: t, icon: t[0] === '@' ? '@' : '#', tag: t })),
      it => pickTag(it.tag), '');
    if (!all.length) window.closeCaretPop();
  } else if (caretPop.type === 'linkpop') {
    // rhizome: [[ searches pages and day pages like Roam (Ctrl+K links arbitrary items);
    // use the original-case `query` for the new-page title, `q` only for matching
    const found = searchPages(query, 8).filter(it => it.id !== caretPop.ctx.id);
    const items = found.map(it => ({ label: it.plain.slice(0, 60), icon: it.day ? '📅' : '↗', linkId: it.id }));
    if (query.trim() && !found.some(f => f.plain.trim().toLowerCase() === query.trim().toLowerCase())) {
      items.push({ label: `Create page “${query.trim().slice(0, 40)}”`, icon: '＋', create: query.trim() });
    }
    renderCaretItems(items, it => pickLink(it), 'Search for a page — type to create one');
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

// [[ inline linking: replace the typed "[[query" with a link to an item,
// creating the item if requested. Backlinks pick it up automatically.
function pickLink(it) {
  const { ctx, start } = caretPop;
  const caret = caretOffsetIn(ctx.el) ?? start;
  window.closeCaretPop();
  snapshot();
  let linkId, label;
  if (it.create) {
    // rhizome: [[…]] creates (or reuses) a top-level page, never a child here
    linkId = getOrCreatePage(it.create);
    label = it.create;
  } else {
    if (!doc.nodes[it.linkId]) return;
    linkId = it.linkId;
    label = plainOf(N(linkId).text).trim() || 'Untitled';
  }
  selectPlainRange(ctx.el, start, caret);
  const sel = getSelection();
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + linkId);
  a.setAttribute('rel', 'noopener');
  a.textContent = label;
  insertInlineAtCaret(sel, r, a);
  scheduleCommit(ctx.el);
  markDirty();
  if (it.create) {
    // make the freshly created item visible (page + sidebar) without losing the caret
    const off = caretOffsetIn(ctx.el);
    commitActiveText();
    renderPage();
    if (off !== null) focusItem(ctx.id, ctx.field, off);
  }
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
  if (caretPop && caretPop.type === 'linkpop') {
    const m = before.match(/\[\[([^\]\n]*)$/);
    if (!m || off <= caretPop.start) { window.closeCaretPop(); }
    else refreshCaretPop(m[1]);
    return;
  }

  // [[title]] typed out in full → link to that page immediately (created if
  // needed, even when still empty), no popover interaction required
  const wl = before.match(/\[\[([^[\]\n]+)\]\]$/);
  if (wl && wl[1].trim() && ctx.field === 'text' && fmtOf(ctx.id) !== 'codeblock' && !state.readOnly) {
    window.closeCaretPop();
    const title = wl[1].trim();
    snapshot();
    const pageId = getOrCreatePage(title);
    selectPlainRange(ctx.el, off - wl[0].length, off); // select the whole "[[title]]"
    const sel = getSelection();
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const a = document.createElement('a');
    a.setAttribute('href', '#/n/' + pageId);
    a.setAttribute('rel', 'noopener');
    a.textContent = title;
    insertInlineAtCaret(sel, r, a);
    scheduleCommit(ctx.el);
    markDirty();
    return;
  }

  // [[ → internal-link autocomplete
  const lm = before.match(/\[\[([^\]\n]*)$/);
  if (lm && ctx.field === 'text' && fmtOf(ctx.id) !== 'codeblock') {
    openCaretPop('linkpop', ctx, off - lm[0].length);
    refreshCaretPop(lm[1]);
    clearDateSuggest();
    return;
  }

  // ``` → code block
  if (ctx.field === 'text' && before === '```' && fmtOf(ctx.id) !== 'codeblock') {
    ctx.el.textContent = ''; // opSetFormat re-serializes this element via commitActiveText
    N(ctx.id).text = '';
    opSetFormat(ctx.id, 'codeblock');
    return;
  }

  // '!!' → date picker
  if (before.endsWith('!!') && ctx.field === 'text' && fmtOf(ctx.id) !== 'codeblock') {
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
      refreshCaretPop(prefix.slice(1));
      clearDateSuggest();
      return;
    }
  }

  // natural-language date: typing "today"/"next thu"/"oct 7" offers Tab → date
  if (fmtOf(ctx.id) !== 'codeblock') maybeDateSuggest(ctx);
};

window.caretPopKeydown = function caretPopKeydown(e) {
  if (!caretPop) return false;
  const pick = () => {
    const it = caretPop.items[caretPop.active];
    if (it && caretPop.onPick) caretPop.onPick(it);
    else window.closeCaretPop();
  };
  if (e.key === 'Tab') { e.preventDefault(); pick(); return true; } // Tab confirms, like Enter
  return listNavKey(e, {
    rowSel: '.pop-item', container: caretPop.el,
    count: () => caretPop.items.length,
    getActive: () => caretPop.active, setActive: v => { caretPop.active = v; },
    onEscape: () => window.closeCaretPop(),
    onEnter: pick,
  });
};

/* ---------------- D. date picker ---------------- */

const DATE_QUICK_PICKS = [['Today', 0], ['Tomorrow', 1], ['Next week', 7], ['In 2 weeks', 14], ['Next month', 30]];

// the quick-pick row + calendar input shared by both date pickers; calls onPick(iso)
function buildDatePicker(onPick, onEscape) {
  if (window.buildRoamCalendar) return window.buildRoamCalendar(onPick, onEscape); // rhizome
  const frag = document.createDocumentFragment();
  const quick = document.createElement('div');
  quick.className = 'quick';
  for (const [label, days] of DATE_QUICK_PICKS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's selection
    b.addEventListener('click', () => onPick(dateOffset(days)));
    quick.append(b);
  }
  const input = document.createElement('input');
  input.type = 'date';
  input.value = dateOffset(0);
  const apply = () => { if (input.value) onPick(input.value); };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    else if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); }
  });
  frag.append(quick, input);
  return frag;
}

function openDatePop(ctx) {
  window.closeCaretPop();
  const sel = getSelection();
  savedDateRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const el = document.createElement('div');
  el.className = 'popover caret-pop datepick';
  el.append(buildDatePicker(
    iso => insertDate(ctx, iso),
    () => { window.closeCaretPop(); focusItem(ctx.id, ctx.field === 'title' ? 'title' : 'text', 'end'); },
  ));
  document.body.append(el);
  caretPop = { type: 'date', ctx, items: [], active: 0, el, onPick: null };
  positionCaretPop();
}

// insert an inline node at the collapsed range, add a trailing space, leave the caret after it
function insertInlineAtCaret(sel, r, node) {
  const space = document.createTextNode(' ');
  r.insertNode(space);
  r.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(space);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}

// a date pill element: single ISO, or a range when iso2 is given
function makeTimePill(iso, iso2) {
  const time = document.createElement('time');
  time.setAttribute('datetime', iso2 ? `${iso}/${iso2}` : iso);
  time.textContent = iso2 ? `${formatDate(iso)} – ${formatDate(iso2)}` : formatDate(iso);
  return time;
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
  insertInlineAtCaret(sel, r, dayLinkEl(iso)); // rhizome: a day-page link, not a pill
  scheduleCommit(ctx.el);
}

/* ---------------- D2. node picker (Move To… / Mirror To…) ---------------- */

function openNodePicker(title, onPick, exclude) {
  commitActiveText();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="jump" role="dialog" aria-label="${escAttr(title)}">
    <input class="np-input" placeholder="${escAttr(title)}" autocomplete="off" spellcheck="false">
    <div class="jump-results np-results"></div>
    <div class="jump-foot">↑↓ navigate · Enter to choose · Esc to cancel</div></div>`;
  document.body.append(overlay);
  const input = $('.np-input', overlay);
  const results = $('.np-results', overlay);
  let items = [], active = 0;
  const excluded = new Set(exclude || []);
  const render = q => {
    const home = { id: HOME, plain: SHARE_TOKEN ? crumbLabel(HOME) : 'Home', path: '', score: 0 };
    const found = searchNodes(q, 40).filter(it => !excluded.has(it.id));
    items = (q.trim() ? found : [home, ...found]).slice(0, 18);
    active = 0;
    results.innerHTML = '';
    items.forEach((it, i) => {
      results.append(jumpRow(it, i === 0, () => { close(); onPick(it.id); }));
    });
  };
  const close = () => overlay.remove();
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    listNavKey(e, {
      rowSel: '.jump-row', container: results,
      count: () => items.length,
      getActive: () => active, setActive: v => { active = v; },
      onEscape: close,
      onEnter: () => { if (items[active]) { close(); onPick(items[active].id); } },
    });
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  render('');
  input.focus();
}

function moveItemTo(id, targetParent) {
  if (targetParent === id || isAncestor(id, targetParent)) { showToast("Can't move an item into itself"); return; }
  snapshot();
  N(targetParent).collapsed = false;
  moveNode(id, targetParent, kidsOf(targetParent).length);
  renderPage();
  focusItem(id, 'text', 'end');
  markDirty();
  showToast('Moved');
}

function mirrorItemTo(id, targetParent) {
  if (targetParent === id || isAncestor(id, targetParent)) { showToast("Can't mirror into itself"); return; }
  snapshot();
  const target = isMirror(id) ? (mirrorTarget(id) || id) : id;
  const mid = makeNode('', { mirror: target, collapsed: true }); // start folded: no subtree wall
  N(targetParent).collapsed = false;
  insertAt(targetParent, kidsOf(targetParent).length, mid);
  renderPage();
  markDirty();
  // the mirror lands at the bottom of the target — show it, or say where it went
  const el = elById.get(mid);
  const where = `Mirror created in “${crumbLabel(targetParent)}”`;
  if (el) {
    el.classList.add('entering');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    showToast(where);
  } else {
    showToast(where, { label: 'Show', fn: () => zoomTo(targetParent) });
  }
}

// Workflowy-style "Mirror here": pick any item and a live mirror of it appears at the
// cursor — an empty bullet converts in place, anything else gains it as the next sibling.
// (mirrorItemTo is the opposite direction: push a mirror of THIS item somewhere else.)
function mirrorHere(id) {
  openNodePicker('Mirror here…', picked => {
    if (!N(picked) || !N(id)) return;
    snapshot();
    const target = isMirror(picked) ? (mirrorTarget(picked) || picked) : picked;
    const n = N(id);
    let mid = id;
    if (!isMirror(id) && !plainOf(n.text).trim() && !kidsOf(id).length && !(n.note || '').trim()) {
      recOld(id);
      n.text = '';
      n.mirror = target;
      n.collapsed = true; // start folded: no subtree wall
      touch(id);
      mirrorsDirty = true;
    } else {
      mid = makeNode('', { mirror: target, collapsed: true });
      insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id) + 1, mid);
    }
    renderPage();
    markDirty();
    const el = elById.get(mid);
    if (el) { el.classList.add('entering'); el.scrollIntoView({ block: 'nearest' }); }
    showToast(`Mirror of “${crumbLabel(target)}”`);
  }, [id]);
}

// sets/replaces a date pill on an item (Move to Today / Tomorrow / Next Week)

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoOf(d);
}

const nodeAnchor = id => elById.get(id)?.querySelector(':scope > .row .content') || document.body;

// mirror an item under a calendar-journal day (creating the day on demand)
function mirrorItemToDate(id, iso) {
  if (!doc.nodes[ROOT]) { showToast("The calendar isn't available in a shared view"); return; }
  mirrorItemTo(id, ensureDay(iso));
}

// count of descendant items (and how many are complete)
function opCount(id) {
  let items = 0, done = 0;
  const walk = x => { for (const c of kidsOf(x)) { items++; if (N(c).done) done++; walk(c); } };
  walk(contentIdOf(id)); // a mirror counts its target's subtree
  showToast(items ? `${items} item${items === 1 ? '' : 's'} below this${done ? ` · ${done} complete` : ''}` : 'No items below this');
}

// expand or collapse every descendant of an item at once
function setSubtreeCollapsed(id, collapsed) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  for (const x of subtreeOf(contentIdOf(id))) if (hasKids(x)) { recOld(x); N(x).collapsed = collapsed; }
  if (collapsed) { recOld(id); N(id).collapsed = false; } // keep the item itself open so the effect is visible
  touch(id);
  renderPage();
  markDirty();
}

// a date chooser (quick picks + calendar input) that calls back with an ISO date
function pickDate(anchor, cb) {
  openPopover(anchor, pop => {
    pop.classList.add('datepick');
    pop.append(buildDatePicker(iso => { closeAllPopovers(); cb(iso); }));
    setTimeout(() => pop.querySelector('input')?.focus(), 30);
  });
}

// export a single item's subtree (the doc-wide exporters' per-node sibling)
function exportNode(id, format) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (plainOf(N(id).text).trim().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item').toLowerCase();
  const fn = `tendril-${base}-${stamp}`;
  if (format === 'txt') download(`${fn}.txt`, 'text/plain', subtreeToText(id, 0));
  else if (format === 'md') download(`${fn}.md`, 'text/plain', subtreeToMarkdown(id, 0));
  else if (format === 'opml') download(`${fn}.opml`, 'text/xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${escHtml(plainOf(N(id).text))}</title></head><body>\n${subtreeToOpml(id)}\n</body></opml>`);
  else {
    const ids = subtreeOf(id);
    const inSet = new Set(ids);
    const nodes = {};
    for (const x of ids) {
      const n = doc.nodes[x];
      if (n.mirror && !inSet.has(n.mirror)) {
        // the target stays behind — materialize the mirror's content so the export
        // never carries a dangling pointer
        const t = doc.nodes[n.mirror];
        const copy = { ...n, text: t ? t.text : '', note: t ? t.note ?? null : null, done: t ? !!t.done : false };
        delete copy.mirror;
        if (t && t.format) copy.format = t.format;
        nodes[x] = copy;
      } else nodes[x] = n;
    }
    download(`${fn}.json`, 'application/json', JSON.stringify({ root: id, nodes }, null, 1));
  }
}

function exportNodePop(anchor, id) {
  id = contentIdOf(id); // exporting a mirror exports the shared content + subtree
  openPopover(anchor, pop => {
    const t = document.createElement('div');
    t.className = 'pop-title';
    t.textContent = 'Export this item & children';
    pop.append(t);
    for (const [label, fmt] of [['Plain text', 'txt'], ['Markdown', 'md'], ['OPML', 'opml'], ['JSON', 'json']]) {
      pop.append(menuItem(label, '⬇', () => exportNode(id, fmt)));
    }
  });
}

function insertTemplatePop(anchor, ctx) {
  const tpls = getTemplates();
  if (!tpls.length) { showToast('No templates yet — use “Save as template” first'); return; }
  openPopover(anchor, pop => {
    const t = document.createElement('div');
    t.className = 'pop-title';
    t.textContent = 'Insert template';
    pop.append(t);
    for (const tpl of tpls) pop.append(menuItem(tpl.label, '🧩', () => insertTemplate(tpl.id, ctx)));
  });
}

/* ---------------- D3. natural-language date suggestion (type "today" → Tab) ---------------- */

let dateSuggest = null;  // { id, field, start, iso }
const dateHintEl = (() => {
  const el = document.createElement('div');
  el.className = 'date-hint';
  el.hidden = true;
  el.addEventListener('mousedown', e => e.preventDefault());  // keep the editor focused
  el.addEventListener('click', e => {
    if (!dateSuggest) return;
    if (e.target.closest('.dh-cal')) {
      // open the full picker: drop the typed phrase first, then pick a date there
      const sug = dateSuggest;
      clearDateSuggest();
      if (document.activeElement === sug.el && doc.nodes[sug.id]) {
        const off = caretOffsetIn(sug.el);
        if (off != null && off >= sug.start) {
          snapshot();
          selectPlainRange(sug.el, sug.start, off);
          getSelection().getRangeAt(0).deleteContents();
          scheduleCommit(sug.el);
        }
        openDatePop({ id: sug.id, field: sug.field, el: sug.el });
      }
    } else {
      window.applyDateSuggest();           // click anywhere else = convert now
    }
  });
  document.body.append(el);
  return el;
})();

window.dateSuggestActive = () => !!dateSuggest;

function clearDateSuggest() {
  if (!dateSuggest) return;
  dateSuggest = null;
  dateHintEl.hidden = true;
}
window.clearDateSuggest = clearDateSuggest;

function maybeDateSuggest(ctx) {
  // only where a <time> pill can render, and not while another caret pop is open
  if (window.caretPopOpen?.() || ctx.field === 'note' || ctx.field === 'zoom-note') { clearDateSuggest(); return; }
  const off = caretOffsetIn(ctx.el);
  if (off == null) { clearDateSuggest(); return; }
  const before = (ctx.el.textContent || '').slice(0, off);
  const hit = nlDate(before);
  if (!hit) { clearDateSuggest(); return; }
  dateSuggest = { id: ctx.id, field: ctx.field, el: ctx.el, start: hit.start, iso: hit.iso, iso2: hit.iso2 };
  const label = hit.iso2 ? `${formatDate(hit.iso)} – ${formatDate(hit.iso2)}` : formatDate(hit.iso);
  dateHintEl.innerHTML =
    `<div class="dh-row"><span class="dh-date">${escHtml(label)}</span>` +
    `<span class="dh-cal" title="Open date picker">📅</span></div>` +
    `<div class="dh-foot">Press <kbd>Tab</kbd> or click here</div>`;
  dateHintEl.hidden = false;
  const rect = caretViewportRect();
  if (rect) {
    const pr = dateHintEl.getBoundingClientRect();
    dateHintEl.style.left = clamp(rect.left, 8, innerWidth - pr.width - 8) + 'px';
    dateHintEl.style.top = (rect.bottom + 7) + 'px';
  }
}

window.applyDateSuggest = function applyDateSuggest() {
  if (!dateSuggest) return false;
  const sug = dateSuggest;
  clearDateSuggest();
  if (document.activeElement !== sug.el || !doc.nodes[sug.id]) return false;
  const off = caretOffsetIn(sug.el);
  if (off == null || off < sug.start) return false;
  snapshot();
  selectPlainRange(sug.el, sug.start, off);          // select the typed phrase
  const sel = getSelection();
  const r = sel.getRangeAt(0);
  r.deleteContents();                                 // remove it
  // rhizome: a single date becomes a day-page link; ranges stay <time> pills
  insertInlineAtCaret(sel, r, sug.iso2 ? makeTimePill(sug.iso, sug.iso2) : dayLinkEl(sug.iso));
  scheduleCommit(sug.el);
  return true;
};

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
    linkResults.append(jumpRow(it, i === 0, () => applyLink('#/n/' + it.id)));
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
  listNavKey(e, {
    rowSel: '.jump-row', container: linkResults, scroll: false,
    count: () => linkItems.length,
    getActive: () => linkActive, setActive: v => { linkActive = v; },
    onEscape: () => { linkOverlay.hidden = true; },
    onEnter: () => {
      const q = linkInput.value.trim();
      if (/^https?:/i.test(q)) applyLink(q);
      else if (/^www\./i.test(q)) applyLink('https://' + q);
      else if (linkItems[linkActive]) applyLink('#/n/' + linkItems[linkActive].id);
    },
  });
};

linkOverlay.addEventListener('mousedown', e => { if (e.target === linkOverlay) linkOverlay.hidden = true; });

/* ---------------- G. comments ---------------- */

window.showComments = function showComments(anchor, id) {
  id = contentIdOf(id); // comments are content — shared by every instance
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
        recOld(id);
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
  recOld(id);
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
    const cid = contentIdOf(c); // a mirror presents as its target
    if (N(cid).done && !settings.showCompleted) continue;
    if (fmtOf(cid) === 'divider') continue;
    list.push({ title: plainOf(N(cid).text).trim() || 'Untitled', note: N(cid).note, kids: kidsOf(cid) });
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
      const cid = contentIdOf(id); // mirrors present their target's text and subtree
      const n = N(cid);
      if (n.done && !settings.showCompleted) continue;
      const li = document.createElement('li');
      if (n.done) li.className = 'done';
      li.textContent = plainOf(n.text).trim();
      if (depth < 2 && hasKids(cid)) li.append(buildUl(kidsOf(cid), depth + 1));
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

/* ---------------- J2. calendar hierarchy (Calendar › Year › Month › Day) ---------------- */

function calRoot(create) {
  let id = meta().calendar;
  if (id && doc.nodes[id] && N(id).cal === 'root') return id;
  id = Object.keys(doc.nodes).find(k => N(k).cal === 'root');
  if (id) { meta().calendar = id; return id; }
  if (!create) return null;
  const cid = makeNode('📅 Calendar', { cal: 'root' });
  insertAt(ROOT, kidsOf(ROOT).length, cid);
  meta().calendar = cid;
  return cid;
}

function calSortKey(id) {
  const n = N(id);
  return n.cal === 'year' ? n.cy : n.cal === 'month' ? n.cm : n.cal === 'day' ? n.cd : 0;
}
function sortCalChildren(parent) {
  kidsOf(parent).sort((a, b) => { const ka = calSortKey(a), kb = calSortKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
}
function ensureCalChild(parent, pred, make) {
  let id = kidsOf(parent).find(pred);
  if (id) return id;
  id = make();
  insertAt(parent, kidsOf(parent).length, id);
  sortCalChildren(parent);
  return id;
}
function calDayLabel(iso) {
  // rhizome: day pages carry Roam-style titles ("July 14th, 2026")
  return roamDateLabel(iso);
}
function ensureYear(y) {
  return ensureCalChild(calRoot(true), id => N(id).cal === 'year' && N(id).cy === y,
    () => makeNode(String(y), { cal: 'year', cy: y }));
}
function ensureMonth(y, m) {
  return ensureCalChild(ensureYear(y), id => N(id).cal === 'month' && N(id).cm === m,
    () => makeNode(MONTHS_LONG[m], { cal: 'month', cy: y, cm: m }));
}
function ensureDay(iso) {
  const [y, m] = iso.split('-').map(Number);
  return ensureCalChild(ensureMonth(y, m - 1), id => N(id).cal === 'day' && N(id).cd === iso,
    () => makeNode(calDayLabel(iso), { cal: 'day', cd: iso }));
}
function findDay(iso) {
  const root = calRoot(false); if (!root) return null;
  const [y, m] = iso.split('-').map(Number);
  const yr = kidsOf(root).find(id => N(id).cal === 'year' && N(id).cy === y); if (!yr) return null;
  const mo = kidsOf(yr).find(id => N(id).cal === 'month' && N(id).cm === m - 1); if (!mo) return null;
  return kidsOf(mo).find(id => N(id).cal === 'day' && N(id).cd === iso) || null;
}

function gotoDate(iso) {
  if (state.readOnly) return;
  const existing = findDay(iso);
  if (existing) { zoomTo(existing); return; }
  if (!doc.nodes[ROOT]) { showToast("The calendar isn't available in a shared view"); return; }
  commitActiveText();
  snapshot();
  const day = ensureDay(iso);
  markDirty();
  zoomTo(day);
}
const gotoToday = () => gotoDate(todayStr());

window.gotoDate = gotoDate;

const calStripEl = $('#cal-strip');

window.renderCalStrip = function renderCalStrip() {
  // rhizome: no calendar strip/overview — day pages are normal pages and the
  // year/month container nodes render as plain outline pages
  calStripEl.hidden = true;
  calStripEl.innerHTML = '';
};

$('#side-today')?.addEventListener('click', () => gotoToday());
$('#btn-calendar').addEventListener('click', () => { location.hash = '#/'; });  // rhizome: header → daily notes

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
        recTrash();
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
        recTrash();
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
    cloned.children = (node.children || []).map(c => idMap.get(c)).filter(Boolean);
    if (cloned.mirror && !doc.nodes[cloned.mirror]) {
      // the target was deleted while this sat in the trash. If it was promoted, its own
      // trash entry is the forwarding record (the original was converted to a mirror of
      // its heir before being trashed) — walk the chain to the live successor.
      let t = cloned.mirror;
      const seen = new Set();
      while (t && !doc.nodes[t] && !seen.has(t)) {
        seen.add(t);
        const fwd = (doc.trash || []).map(e => e.nodes[t]).find(x => x && x.mirror);
        t = fwd ? fwd.mirror : null;
      }
      if (t && doc.nodes[t]) cloned.mirror = t; // healed; otherwise it restores broken, as before
    }
    recOld(cloned.id); // restored node → undo removes it
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
  recTrash();
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
  // keep any draft: a stray Esc / outside click shouldn't lose a half-written capture
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

// capture-time enhancement: a natural-language date at the end of a line
// becomes a real date pill (so "call mom tomorrow" doesn't rot into the wrong
// day next week), and the capitalize setting applies like it does in the editor
function enhanceCaptureSpec(spec) {
  const plain = plainOf(spec.text);
  const hit = nlDate(plain);
  if (hit && hit.start + hit.phrase.length === plain.length && spec.text.endsWith(escHtml(hit.phrase))) {
    // rhizome: a single captured date links to its day page; ranges stay pills
    const ref = hit.iso2
      ? `<time datetime="${hit.iso}/${hit.iso2}">${escHtml(`${formatDate(hit.iso)} – ${formatDate(hit.iso2)}`)}</time>`
      : dayLinkHtml(hit.iso);
    spec.text = spec.text.slice(0, spec.text.length - escHtml(hit.phrase).length).replace(/\s+$/, ' ') + ref;
  }
  if (settings.capitalize) spec.text = applyCapitalize(spec.text);
  spec.children.forEach(enhanceCaptureSpec);
}

function doCapture() {
  const text = captureInput.value;
  const forest = parseIndentedText(text);
  if (!forest.length) { captureOverlay.hidden = true; return; }
  snapshot(); // rhizome: before enhance — a captured date may create its day node
  forest.forEach(enhanceCaptureSpec);
  const inbox = findOrCreateInbox();
  materializeForest(forest, inbox);
  captureInput.value = '';
  captureOverlay.hidden = true;
  renderPage();
  markDirty();
  showToast(`Captured to Inbox`, { label: 'Open', fn: () => zoomTo(inbox) });
}

window.captureKeydown = function captureKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); captureOverlay.hidden = true; return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCapture(); return; }
  // Tab indents the current line (the box's nesting model) instead of leaving the field
  if (e.key === 'Tab' && e.target === captureInput) {
    e.preventDefault();
    const ta = captureInput;
    const s = ta.selectionStart, end = ta.selectionEnd, v = ta.value;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    if (e.shiftKey) {
      const remove = v.startsWith('  ', lineStart) ? 2 : v.startsWith(' ', lineStart) ? 1 : 0;
      if (remove) {
        ta.value = v.slice(0, lineStart) + v.slice(lineStart + remove);
        ta.selectionStart = Math.max(lineStart, s - remove);
        ta.selectionEnd = Math.max(lineStart, end - remove);
      }
    } else {
      ta.value = v.slice(0, lineStart) + '  ' + v.slice(lineStart);
      ta.selectionStart = s + 2;
      ta.selectionEnd = end + 2;
    }
  }
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
  openPopover(anchor, pop => renderSharePop(pop, id));
}

// rebuilds itself in place so creating a link immediately reveals it (no reopen)
function renderSharePop(pop, id) {
  const existing = state.shares.find(s => s.id === id);
  pop.className = 'popover share-pop';
  pop.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'pop-title';
  title.textContent = existing ? 'Public link' : 'Create a public link';
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
      await navigator.clipboard?.writeText(input.value).catch(() => {});
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
    linkRow.append(input, copy);
    pop.append(linkRow);

    const modeNote = document.createElement('div');
    modeNote.className = 'pop-title';
    modeNote.textContent = existing.mode === 'edit' ? 'Anyone with the link can edit' : 'Anyone with the link can view';
    pop.append(modeNote);
    input.focus();

    pop.append(menuItem('Revoke link', '✕', async () => {
      await fetch('/api/shares/' + existing.token, { method: 'DELETE' });
      await fetchShares();
      elById.get(id)?.classList.toggle('shared-ring', state.shares.some(s => s.id === id));
      renderSharePop(pop, id);
    }, { danger: true, keepOpen: true }));
  } else {
    const make = mode => async () => {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: id, mode }),
      });
      const data = await res.json();
      await fetchShares();
      elById.get(id)?.classList.add('shared-ring'); // update the indicator without a re-render (which would close the popover)
      renderSharePop(pop, id);   // now shows the link + Copy, popover stays open
      await navigator.clipboard?.writeText(location.origin + data.url).catch(() => {});
      showToast('Public link created & copied');
    };
    pop.append(
      menuItem('View only', '👁', make('view'), { keepOpen: true }),
      menuItem('Can edit', '✎', make('edit'), { keepOpen: true }),
    );
  }
}

/* ---------------- N. attachments & AI ---------------- */

let attachTargetId = null;

function attachTo(id) {
  attachTargetId = contentIdOf(id); // attachments are content — shared by every instance
  $('#attach-file').click();
}

$('#attach-file').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length && attachTargetId) window.uploadAttachments(attachTargetId, files);
});

window.uploadAttachments = async function uploadAttachments(id, files) {
  if (state.readOnly || SHARE_TOKEN) { showToast('Attachments are unavailable on shared links'); return; }
  id = contentIdOf(id); // attachments are content — a paste onto a mirror attaches to the target
  snapshot();
  recOld(id); // capture the node before the async upload mutates its files
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

// one-shot canned AI actions (preset prompts over the same proxy as free-form Ask AI)
const AI_PRESETS = [
  ['AI: Summarize', 'Summarize this item and its children into a few concise bullet points.'],
  ['AI: Find tasks', "Extract the actionable tasks from this item and its children as a checklist; format each line as '- [ ] task'."],
  ['AI: Draft an outline', 'Draft a structured, nested outline that expands on this item.'],
  ['AI: Fix grammar & spelling', 'Rewrite this item and its children with corrected grammar and spelling, preserving the meaning and the nesting.'],
  ['AI: Make shorter', 'Rewrite this item and its children to be more concise, preserving the structure.'],
];

// send a prompt + the item's subtree to the AI proxy and graft the reply in as sub-items
async function aiRun(id, prompt) {
  showToast('✨ Asking AI…');
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
    materializeForest(forest, id);
    renderPage();
    markDirty();
    showToast('AI results added as sub-items', { label: 'Undo', fn: undo });
  } catch (err) {
    showToast(String(err.message || err));
  }
}

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
      await aiRun(id, prompt); // closes the popover on success; on error it stays and we re-enable
      go.textContent = 'Go';
      go.disabled = false;
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
  const cid = contentIdOf(id);   // mirrors get the FULL menu — content actions hit the target
  const n = N(cid);
  if (isMirror(id) && !mirrorTarget(id)) {
    // broken mirror (original gone, nothing promoted — e.g. restored from an old trash)
    openPopover(anchor, pop => {
      pop.append(menuItem('Delete mirror', '✕', () => opDelete(id), { danger: true }));
    });
    return;
  }
  openPopover(anchor, pop => {
    if (isMirror(id)) pop.append(menuItem('Open original', '◈', () => zoomTo(cid)));
    if (!state.readOnly) {
      pop.append(
        menuItem(n.done ? 'Mark incomplete' : 'Complete', '✓', () => opToggleDone(id), { hint: 'Ctrl+Enter' }),
        menuItem(n.note != null ? 'Edit note' : 'Add note', '≡', () => opAddNote({ id, field: 'text' }), { hint: 'Shift+Enter' }),
      );
    }
    pop.append(menuItem('Zoom in', '◎', () => zoomTo(cid), { hint: 'Alt+→' }));
    if (!state.readOnly) {
      // turn into…
      const title = document.createElement('div');
      title.className = 'pop-title';
      title.textContent = 'Turn into';
      pop.append(title);
      const seg = document.createElement('div');
      seg.className = 'seg seg-wrap';
      const types = [['•', 'bullet'], ['☑', 'todo'], ['1.', 'number'], ['H₁', 'h1'], ['H₂', 'h2'], ['❝', 'quote'], ['{}', 'codeblock'], ['▦', 'board']];
      for (const [label, fmt] of types) {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = fmt;
        if (fmtOf(cid) === fmt) b.classList.add('active');
        b.addEventListener('click', () => { closeAllPopovers(); opSetFormat(id, fmt); });
        seg.append(b);
      }
      pop.append(seg);
      pop.append(document.createElement('hr'));
      pop.append(
        menuItem('Add date', '📅', () => openDatePop({ id, field: 'text', el: elById.get(id)?.querySelector('.content') }), { hint: '!!' }),
        menuItem('Move to Today', '▦', () => moveItemToDay(id, dateOffset(0))),
        menuItem('Move to Tomorrow', '▦', () => moveItemToDay(id, dateOffset(1))),
        menuItem('Move to Next Week', '▦', () => moveItemToDay(id, dateOffset(7))),
        menuItem('Move to Date…', '📅', () => pickDate(anchor, iso => moveItemToDay(id, iso))),
        document.createElement('hr'),
        menuItem('Move to…', '→', () => openNodePicker('Move to…', t => moveItemTo(id, t), subtreeOf(id)), { hint: 'Alt+Ctrl+M' }),
        menuItem('Mirror', '◇', () => opMirror(id), { hint: 'Alt+Shift+M' }),
        menuItem('Mirror here…', '◈', () => mirrorHere(id)),
        menuItem('Mirror to…', '◇', () => openNodePicker('Mirror to…', t => mirrorItemTo(id, t), subtreeOf(id))),
        menuItem('Mirror to Today', '◇', () => mirrorItemToDate(id, dateOffset(0))),
        menuItem('Mirror to Date…', '◇', () => pickDate(anchor, iso => mirrorItemToDate(id, iso))),
        menuItem('Duplicate', '⧉', () => opDuplicate(id), { hint: 'Ctrl+D' }),
        document.createElement('hr'),
        menuItem('Comments', '💬', () => {
          const it = elById.get(id);
          window.showComments(it?.querySelector(':scope > .row') || anchor, id);
        }),
        menuItem('Attach file', '📎', () => attachTo(id)),
        menuItem('Save as template', '🧩', () => saveAsTemplate(cid)),
        menuItem('Insert template…', '🧩', () => insertTemplatePop(anchor, { id, field: 'text' })),
        menuItem('Count items', '#', () => opCount(id)),
        menuItem('Export…', '⬇', () => exportNodePop(anchor, id)),
      );
      if (hasKids(cid)) pop.append(
        menuItem('Sort A → Z', '↓', () => opSort(id, 1)),
        menuItem('Sort Z → A', '↑', () => opSort(id, -1)),
        menuItem('Expand all', '▾', () => setSubtreeCollapsed(id, false)),
        menuItem('Collapse all', '▸', () => setSubtreeCollapsed(id, true)),
      );
      if (state.aiEnabled) {
        pop.append(menuItem('Ask AI…', '✨', () => askAI(id)));
        for (const [label, instr] of AI_PRESETS) pop.append(menuItem(label, '✨', () => aiRun(id, instr)));
      }
    }
    pop.append(document.createElement('hr'));
    if (!SHARE_TOKEN && state.authRequired !== null) {
      pop.append(menuItem(state.shares.some(s => s.id === id) ? 'Sharing…' : 'Share', '🌐', () => {
        showSharePop(anchor, id);
      }));
    }
    pop.append(
      menuItem('Present', '▶', () => { zoomTo(cid); setTimeout(() => startPresent(cid), 100); }),
      menuItem('Copy link', '🔗', async () => {
        await navigator.clipboard?.writeText(location.origin + location.pathname + '#/n/' + cid);
        showToast('Link copied');
      }, { hint: 'Alt+Shift+L' }),
      menuItem('Copy as text', '📄', async () => {
        await navigator.clipboard?.writeText(subtreeToText(cid, 0));
        showToast('Copied as indented text');
      }),
    );
    if (!state.readOnly) {
      pop.append(
        document.createElement('hr'),
        menuItem('Delete', '✕', () => opDelete(id), { hint: 'Ctrl+Shift+⌫', danger: true }),
      );
    }
    const tnode = N(cid);
    const ts = v => v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
    const foot = document.createElement('div');
    foot.className = 'pop-title pop-foot';
    foot.innerHTML = `<span><b>Changed</b> ${ts(tnode.m)}</span><span><b>Created</b> ${ts(tnode.c)}</span>`;
    pop.append(foot);
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
    addTitle('Page width');
    pop.append(segRow([['Reading', 'reading'], ['Full', 'full']],
      () => settings.width, v => { settings.width = v; saveSettings(); applyTheme(); }));
    addTitle('Date format');
    pop.append(segRow([['Jun 12', 'medium'], ['Fri, Jun 12', 'dow'], ['6/12', 'short'], ['ISO', 'iso']],
      () => settings.dateFormat, v => { settings.dateFormat = v; saveSettings(); renderPage(); }));

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
    const toggle = (cond, on, off, icon, after) => menuItem(cond ? on : off, icon, () => { after(); saveSettings(); }, { keepOpen: false });
    pop.append(
      toggle(settings.arrows === 'always', 'Show arrows on hover only', 'Always show expand arrows', '▸',
        () => { settings.arrows = settings.arrows === 'always' ? 'hover' : 'always'; applyTheme(); }),
      toggle(settings.capitalize, 'Stop auto-capitalizing', 'Capitalize first word', 'A',
        () => { settings.capitalize = !settings.capitalize; }),
      toggle(settings.richTags, 'Plain tags only', 'Rich tags (emoji in tags)', '#',
        () => { settings.richTags = !settings.richTags; renderPage(); }),
      toggle(settings.markdownPaste !== false, 'Paste markdown as plain text', 'Convert markdown on paste', '↧',
        () => { settings.markdownPaste = settings.markdownPaste === false; }),
      toggle(settings.animations !== false, 'Turn off smooth animations', 'Turn on smooth animations', '✨',
        () => { settings.animations = settings.animations === false; applyTheme(); }),
    );

    if (!SHARE_TOKEN) {
      pop.append(document.createElement('hr'));
      pop.append(
        menuItem('Quick capture', '📥', () => window.showCapture(), { hint: 'Ctrl+Shift+Space' }),
        menuItem('Trash', '🗑', () => showTrash()),
        menuItem('Present', '▶', () => startPresent()),
      );
      addTitle('Week starts');
      pop.append(segRow([['Monday', 'mon'], ['Sunday', 'sun']],
        () => settings.weekStart, v => { settings.weekStart = v; saveSettings(); }));
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
      menuItem('Print', '🖨', () => { commitActiveText(); window.print(); }, { hint: 'Ctrl+P' }),
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
    $('#btn-calendar').hidden = true;
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
  if (!SHARE_TOKEN && /^#\/n\/root\b/.test(location.hash)) history.replaceState(null, '', '#/'); // rhizome: legacy root links
  const m = location.hash.match(/^#\/n\/([A-Za-z0-9]+)/);
  if (m && doc.nodes[m[1]] && m[1] !== ROOT) {
    const target = m[1];
    if (!SHARE_TOKEN || target === HOME || isAncestor(HOME, target)) state.zoom = target;
  }
  state.view = state.zoom === ROOT ? parseHashView() : null; // rhizome
  window.onViewChange?.();
  renderPage();
  setSaveUI(dirty ? 'saving' : 'saved');
  connectSSE();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

/* ---------------- search quick-filter chips ---------------- */
(function initSearchChips() {
  const dropdown = document.getElementById('search-dropdown');
  const chipsEl = document.getElementById('search-chips');
  const panelEl = document.getElementById('search-panel');
  if (!dropdown || !chipsEl || !panelEl) return;

  const SVG = {
    link: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="3.1" ry="7"/><line x1="3" y1="10" x2="17" y2="10"/></svg>',
    date: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4.5" width="14" height="12.5" rx="2"/><line x1="3" y1="8" x2="17" y2="8"/><line x1="6.5" y1="2.8" x2="6.5" y2="5.5" stroke-linecap="round"/><line x1="13.5" y1="2.8" x2="13.5" y2="5.5" stroke-linecap="round"/></svg>',
    time: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><path d="M10 6v4.3L13 12" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    people: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7.5" cy="8" r="2.6"/><path d="M3.5 16c0-2.3 1.8-4 4-4s4 1.7 4 4"/><path d="M12.8 6.3a2.4 2.4 0 0 1 0 4.4M14.2 16c0-2-1-3.4-2.4-4.1" stroke-linecap="round"/></svg>',
  };

  const DATE_VALUES = ['today', 'tomorrow', 'yesterday', 'this week', 'next week', 'last week', 'this month', 'next month', 'last month'];
  const DOW = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const TIME_VALUES = ['today', '1d', '3d', '7d', '2w', '1m'];

  const val = (label, token) => ({ label, token, val: true });  // concrete value (ink)
  const op = (label, token) => ({ label, token });              // operator token (accent)
  const sub = (label, build) => ({ label, build });             // drills into a sub-list
  const hint = text => ({ hint: text });

  function tagOptions(sigil) {
    const tags = (typeof collectTags === 'function' ? collectTags() : []).filter(t => t[0] === sigil);
    if (!tags.length) return [hint(sigil === '#' ? 'No #tags yet — type # in an item to make one' : 'No @mentions yet — type @ in an item to make one')];
    return tags.slice(0, 30).map(t => val(t, t));
  }
  const dateSpan = prefix => DATE_VALUES.map(v => val(v, `${prefix}:${v.replace(/ /g, '-')}`));

  const CHIPS = [
    { key: 'link', icon: SVG.link, title: 'Web links', build: () => [op('has:link', 'has:link')] },
    { key: 'tag', icon: '#', title: 'Tags', build: () => tagOptions('#') },
    { key: 'mention', icon: '@', title: 'Mentions', build: () => tagOptions('@') },
    { key: 'date', icon: SVG.date, title: 'Dates', build: () => [
      sub('date:', () => dateSpan('date')),
      sub('date-before:', () => dateSpan('date-before')),
      sub('date-after:', () => dateSpan('date-after')),
      sub('day-of-week:', () => DOW.map(w => val(w, `day-of-week:${w}`))),
      ...DATE_VALUES.map(v => val(v, `date:${v.replace(/ /g, '-')}`)),
    ] },
    { key: 'time', icon: SVG.time, title: 'Changed / created', build: () => [
      sub('changed:', () => TIME_VALUES.map(v => val(v, `changed:${v}`))),
      sub('created:', () => TIME_VALUES.map(v => val(v, `created:${v}`))),
    ] },
    { key: 'people', icon: SVG.people, title: 'People', build: () => [val('me', '-is:shared'), val('others', 'is:shared')] },
    { key: 'more', icon: '…', title: 'More filters', build: () => [
      sub('is:', () => ['complete', 'incomplete', 'todo', 'heading', 'mirror', 'shared'].map(v => val(v, `is:${v}`))),
      sub('has:', () => ['note', 'date', 'file', 'link', 'comment', 'tag'].map(v => val(v, `has:${v}`))),
      op('in:note:', 'in:note:'),
      sub('text:', () => ['bold', 'italic', 'underline', 'strike', 'code', 'color'].map(v => val(v, `text:${v}`))),
      op('link:', 'link:'),
      sub('highlight:', () => ['any', ...(typeof COLOR_NAMES !== 'undefined' ? COLOR_NAMES : [])].map(v => val(v, `highlight:${v}`))),
    ] },
  ];

  let activeKey = null;
  let drill = null; // { label, build }

  for (const c of CHIPS) {
    const b = document.createElement('button');
    b.className = 'search-chip';
    b.type = 'button';
    b.dataset.key = c.key;
    b.title = c.title;
    b.innerHTML = c.icon;
    b.addEventListener('click', () => {
      drill = null;
      activeKey = activeKey === c.key ? null : c.key; // click again to close the panel
      render();
    });
    chipsEl.append(b);
  }

  function renderList(list) {
    panelEl.innerHTML = '';
    if (drill) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'search-opt back';
      back.textContent = `‹ ${drill.label}`;
      back.addEventListener('click', () => { drill = null; render(); });
      panelEl.append(back);
    }
    for (const o of list) {
      if (o.hint) {
        const s = document.createElement('span');
        s.className = 'search-hint';
        s.textContent = o.hint;
        panelEl.append(s);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'search-opt' + (o.val ? ' val' : '');
      b.textContent = o.label;
      b.addEventListener('click', () => {
        if (o.build) { drill = { label: o.label, build: o.build }; render(); }
        else insert(o.token);
      });
      panelEl.append(b);
    }
  }

  function render() {
    for (const el of chipsEl.children) el.classList.toggle('active', el.dataset.key === activeKey);
    if (drill) return renderList(drill.build());
    if (activeKey) return renderList(CHIPS.find(c => c.key === activeKey).build());
    panelEl.innerHTML = '<span class="search-hint">For the jump-to menu, hit Enter now — or Ctrl+K from anywhere.</span>';
  }

  function insert(token) {
    const cur = searchEl.value.trim();
    setSearch(cur ? `${cur} ${token}` : token);
    searchEl.focus();
    drill = null; // back to the chip's top level so filters can be stacked
    render();
  }

  searchEl.addEventListener('focus', () => { if (dropdown.hidden) { dropdown.hidden = false; render(); } });
  // clicks inside the dropdown must not pull focus off the input (keeps it open)
  dropdown.addEventListener('mousedown', e => e.preventDefault());
  searchBoxEl.addEventListener('focusout', e => {
    if (!searchBoxEl.contains(e.relatedTarget)) { dropdown.hidden = true; activeKey = null; drill = null; }
  });

  // Escape/Enter on the search input are routed here from the global keydown handler
  window.searchPanelBack = () => {
    if (drill) { drill = null; render(); return true; }
    if (activeKey) { activeKey = null; render(); return true; }
    return false;
  };
  window.closeSearchPanel = () => { dropdown.hidden = true; activeKey = null; drill = null; };
})();

window.addEventListener('resize', () => {
  document.body.classList.toggle('sidebar-mobile', innerWidth < 900);
});

init();
