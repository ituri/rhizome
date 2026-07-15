'use strict';
/* ============================================================================
   Rhizome — the page layer.

   Roam-style conventions on top of the tendril tree: direct children of the
   root are discrete pages, the calendar subtree stores the daily notes.
   Loaded after app.js/app2.js in the same global scope; the view renderers
   (daily notes, all pages, references) live here so the upstream files keep
   small, mergeable diffs.
   ========================================================================= */

/* ---------------- page conventions ---------------- */

const isCalRoot = id => N(id)?.cal === 'root';

// every direct child of the root except the calendar container is a page
function pagesOf() {
  return kidsOf(ROOT).filter(id => !isCalRoot(id));
}

// alias (lowercased) -> pageId, gathered from each page's `Aliases:: a, b, c` child block
function pageAliasMap() {
  const map = new Map();
  for (const pid of pagesOf()) {
    for (const cid of kidsOf(contentIdOf(pid))) {
      const attr = window.parseAttribute(cid);
      if (!attr || attr.key.toLowerCase() !== 'aliases') continue;
      for (const raw of attr.value.split(',')) {
        const a = raw.replace(/^\[\[|\]\]$/g, '').trim().toLowerCase();
        if (a && !map.has(a)) map.set(a, pid);
      }
      break; // one Aliases block per page
    }
  }
  return map;
}
window.pageAliasMap = pageAliasMap;

function findPageByTitle(title) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  return pagesOf().find(id => plainOf(N(id).text).trim().toLowerCase() === want)
    || pageAliasMap().get(want) || null;
}

// pages append at the top level; callers wrap in snapshot()
function createPage(title) {
  const id = makeNode(escHtml(title.trim()));
  insertAt(ROOT, kidsOf(ROOT).length, id);
  return id;
}

// "July 14th, 2026" → "2026-07-14", else null
function parseRoamDate(title) {
  const m = title.trim().match(/^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th), (\d{4})$/);
  if (!m) return null;
  const mon = MONTHS_LONG.indexOf(m[1]) + 1;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

function getOrCreatePage(title) {
  const iso = parseRoamDate(title);          // a date resolves to its calendar day page,
  if (iso) return window.ensureDayId(iso);   // never a duplicate top-level page
  return findPageByTitle(title) || createPage(title);
}

// an anchor for a page reference: a plain link, or a tag pill when a #/@ sigil is given
window.makePageAnchor = function makePageAnchor(pageId, label, sigil) {
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + pageId);
  a.setAttribute('rel', 'noopener');
  if (sigil) {
    a.className = sigil === '@' ? 'tag mention' : 'tag';
    a.setAttribute('data-tag', sigil + label);
    a.textContent = sigil + label;
  } else {
    a.textContent = label;
  }
  return a;
};

// true when node `id` (a top-level page or a day page) now carries a title that
// already belongs to another page — used to block a colliding rename
window.pageTitleCollides = function pageTitleCollides(id) {
  const n = N(id);
  if (!n) return false;
  const isPage = kidsOf(ROOT).includes(id) || n.cal === 'day';
  if (!isPage) return false;
  const title = plainOf(n.text).trim().toLowerCase();
  if (!title) return false;
  const iso = parseRoamDate(title);
  if (iso) { const day = findDay(iso); return !!day && day !== id; } // a date belongs to its day page
  return pagesOf().some(p => p !== id && plainOf(N(p).text).trim().toLowerCase() === title);
};
window.getOrCreatePage = getOrCreatePage;

// the page containing a node: the node itself when top-level, ROOT for ROOT
function pageOf(id) {
  const chain = ancestorsOf(id);
  if (!chain.length) return id;
  return chain.length > 1 ? chain[1] : id;
}

/* ---------------- Roam-style day labels ---------------- */

const ordinal = n => {
  const h = n % 100;
  const t = n % 10;
  return n + (h >= 11 && h <= 13 ? 'th' : t === 1 ? 'st' : t === 2 ? 'nd' : t === 3 ? 'rd' : 'th');
};

function roamDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${ordinal(d)}, ${y}`;
}
window.roamDateLabel = roamDateLabel;

// one-time relabel of day nodes created before the fork ("Mon, Jul 14")
const OLD_DAY_RE = new RegExp(`^(${DOW_SHORT.join('|')}), (${MONTHS_SHORT.join('|')}) \\d{1,2}$`);
// migrations mutate the doc inside the shared afterDocLoad snapshot() (so recOld
// journals them → ops are emitted → they actually persist) and return whether they
// changed anything; afterDocLoad does the single markDirty()/renderPage()
function migrateDayLabels() {
  let changed = false;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (n.cal === 'day' && n.cd && OLD_DAY_RE.test(plainOf(n.text).trim())) {
      recOld(id);
      n.text = escHtml(roamDateLabel(n.cd));
      n.m = Date.now();
      changed = true;
    }
  }
  return changed;
}

// merge duplicate top-level pages titled like a date into their calendar day node
// (created before getOrCreatePage became date-aware)
function migrateDupDatePages() {
  let changed = false;
  for (const id of pagesOf()) {
    const n = N(id);
    if (n.cal) continue;
    const iso = parseRoamDate(plainOf(n.text).trim());
    if (!iso) continue;
    const day = window.ensureDayId(iso);
    if (day === id) continue;
    recOld(id); recOld(day);
    for (const c of [...kidsOf(id)]) moveNode(c, day, kidsOf(day).length);
    // re-point every link that aimed at the duplicate to the real day page
    // (match the closing quote so "#/n/abc" never clobbers "#/n/abcdef")
    const from = `#/n/${id}"`, to = `#/n/${day}"`;
    for (const k of Object.keys(doc.nodes)) {
      const t = doc.nodes[k].text;
      if (t && t.includes(from)) { recOld(k); doc.nodes[k].text = t.split(from).join(to); }
    }
    detach(id);
    delete doc.nodes[id];
    changed = true;
  }
  return changed;
}

/* ---------------- Daily Notes view ---------------- */

function dailyViewActive() {
  return state.view === 'daily' && state.zoom === ROOT && !SHARE_TOKEN && !searchActive();
}
window.dailyViewActive = dailyViewActive;

let dailyLoaded = 4;      // day sections currently mounted
const DAILY_STEP = 4;
const DAILY_CAP = 60;     // beyond this, a Load-more button bounds per-edit re-render cost

// all days worth showing, newest first: any day with content, plus today
function dailyDayList() {
  const root = calRoot(false);
  if (!root) return [];
  const today = todayStr();
  const out = [];
  for (const y of kidsOf(root)) {
    if (N(y).cal !== 'year') continue;
    for (const m of kidsOf(y)) {
      if (N(m).cal !== 'month') continue;
      for (const d of kidsOf(m)) {
        const n = N(d);
        if (n.cal === 'day' && n.cd && (hasKids(d) || n.cd === today)) out.push({ id: d, cd: n.cd });
      }
    }
  }
  out.sort((a, b) => b.cd.localeCompare(a.cd));
  return out;
}

// re-render with more sections when the sentinel scrolls into view
const dailyObserver = new IntersectionObserver(entries => {
  if (!entries.some(e => e.isIntersecting) || !dailyViewActive()) return;
  if (dailyLoaded >= DAILY_CAP) return; // Load-more takes over
  dailyLoaded += DAILY_STEP;
  renderPage();
});

function renderDailyView(frag) {
  dailyObserver.disconnect();
  const days = dailyDayList();
  const today = todayStr();
  const shown = days.slice(0, dailyLoaded);
  // Roam parity: every day section carries its own linked references (one doc scan for all)
  const refMap = collectLinkedRefs(new Set(shown.map(d => d.id)));

  for (const { id, cd } of shown) {
    const sec = document.createElement('section');
    sec.className = 'day-section';
    sec.dataset.day = id;

    // not contenteditable, so editableCtx()/editables() skip it by design
    const h = document.createElement('h2');
    h.className = 'day-title';
    h.textContent = roamDateLabel(cd);
    h.title = 'Open this day';
    h.addEventListener('click', () => zoomTo(id));
    sec.append(h);

    const kids = kidsOf(id).filter(c => shouldShow(c, false));
    for (const c of kids) sec.append(mountItem(c, false));
    if (!kids.length) {
      const ph = document.createElement('div');
      ph.className = 'day-empty';
      ph.textContent = cd === today
        ? "Click here to start writing. Type '/' to see commands."
        : 'Nothing here.';
      if (!state.readOnly) ph.addEventListener('click', () => opNewAt(id, 0));
      sec.append(ph);
    }
    const built = refMap.has(id) ? buildRefGroups(id, refMap.get(id)) : null;
    if (built) {
      const box = document.createElement('div');
      box.className = 'day-refs';
      const h = document.createElement('h3');
      h.textContent = `${built.count} Linked Reference${built.count === 1 ? '' : 's'}`;
      box.append(h, built.el);
      sec.append(box);
    }
    frag.append(sec);
  }

  if (days.length > dailyLoaded) {
    if (dailyLoaded >= DAILY_CAP) {
      const btn = document.createElement('button');
      btn.className = 'daily-more';
      btn.textContent = `Load ${Math.min(30, days.length - dailyLoaded)} more days`;
      btn.addEventListener('click', () => { dailyLoaded += 30; renderPage(); });
      frag.append(btn);
    } else {
      const sentinel = document.createElement('div');
      sentinel.id = 'daily-sentinel';
      frag.append(sentinel);
      // observe after it lands in the document
      queueMicrotask(() => { const el = document.getElementById('daily-sentinel'); if (el) dailyObserver.observe(el); });
    }
  }
}
window.renderDailyView = renderDailyView;

// entering the daily view guarantees today's page exists (never from renderPage —
// that runs on every SSE echo); also resets the scroll window
window.onViewChange = function onViewChange() {
  if (state.view !== 'daily' || SHARE_TOKEN || state.readOnly || !doc) return;
  dailyLoaded = DAILY_STEP;
  if (!findDay(todayStr())) {
    commitActiveText();
    snapshot();
    ensureDay(todayStr());
    markDirty();
  }
};

/* --- editing-op boundary guards, consulted from app.js --- */

// day sections must not leak items into the calendar hierarchy around them
window.isDayBoundary = p => dailyViewActive() && N(p)?.cal === 'day';

// Backspace/Delete merges never cross from one day section into another
window.crossDayMerge = (aId, bId) => {
  if (!dailyViewActive()) return false;
  const dayOf = id => { let p = id; while (p) { if (N(p)?.cal === 'day') return p; p = parentOf(p); } return null; };
  return dayOf(aId) !== dayOf(bId);
};

// clicks on blank page space create items in today's note, not top-level pages
window.newItemTarget = () => dailyViewActive() ? findDay(todayStr()) : null;

/* ---------------- All Pages view ---------------- */

function pagesViewActive() {
  return state.view === 'pages' && state.zoom === ROOT && !SHARE_TOKEN && !searchActive();
}
window.pagesViewActive = pagesViewActive;

let pagesSort = { key: 'm', dir: -1 };

function renderPagesView(frag) {
  const view = document.createElement('div');
  view.className = 'pages-view';
  const h = document.createElement('h1');
  h.className = 'pages-head';
  h.textContent = 'All Pages';
  view.append(h);

  const rows = pagesOf().map(id => {
    const cid = contentIdOf(id);
    const n = N(cid);
    return { id: cid, title: plainOf(n.text).trim() || 'Untitled', c: n.c ?? 0, m: n.m ?? 0 };
  });
  // journal day pages are pages too (Roam lists them in All Pages)
  const root = calRoot(false);
  if (root) {
    for (const y of kidsOf(root)) {
      if (N(y).cal !== 'year') continue;
      for (const mo of kidsOf(y)) {
        if (N(mo).cal !== 'month') continue;
        for (const d of kidsOf(mo)) {
          const n = N(d);
          if (n.cal === 'day') rows.push({ id: d, title: plainOf(n.text).trim() || 'Untitled', c: n.c ?? 0, m: n.m ?? 0 });
        }
      }
    }
  }
  const { key, dir } = pagesSort;
  rows.sort((a, b) => key === 'title'
    ? a.title.localeCompare(b.title) * dir
    : (a[key] - b[key]) * dir);

  const table = document.createElement('table');
  table.className = 'pages-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [k, label] of [['title', 'Title'], ['c', 'Created'], ['m', 'Updated']]) {
    const th = document.createElement('th');
    th.textContent = label + (key === k ? (dir > 0 ? ' ↑' : ' ↓') : '');
    th.addEventListener('click', () => {
      pagesSort = { key: k, dir: pagesSort.key === k ? -pagesSort.dir : (k === 'title' ? 1 : -1) };
      renderPage();
    });
    headRow.append(th);
  }
  headRow.append(document.createElement('th')); // delete column
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const tdTitle = document.createElement('td');
    const a = document.createElement('a');
    a.href = '#/n/' + r.id;
    a.textContent = r.title;
    tdTitle.append(a);
    const tdC = document.createElement('td');
    tdC.textContent = r.c ? roamDateLabel(isoOf(new Date(r.c))) : '—';
    const tdM = document.createElement('td');
    tdM.textContent = r.m ? roamDateLabel(isoOf(new Date(r.m))) : '—';
    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'pages-del';
    del.title = 'Delete page';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Delete the page “${r.title}” and everything in it? It moves to the trash.`)) return;
      if (state.zoom === r.id) location.hash = '#/';
      opDelete(r.id);
    });
    tdDel.append(del);
    tr.append(tdTitle, tdC, tdM, tdDel);
    tbody.append(tr);
  }
  table.append(tbody);
  view.append(table);

  if (!rows.length) {
    const hint = document.createElement('div');
    hint.className = 'pages-empty';
    hint.textContent = 'No pages yet — press Ctrl+K and type a name to create one.';
    view.append(hint);
  }
  frag.append(view);
}
window.renderPagesView = renderPagesView;

/* ---------------- sidebar: Daily Notes / All Pages / Shortcuts / page list --- */

// the page (top-level page or journal day) a node belongs to, for recency
function recencyPageId(id) {
  const chain = [...ancestorsOf(id), id]; // [root, …, id] — ancestorsOf excludes id itself
  for (let i = chain.length - 1; i >= 1; i--) if (N(chain[i])?.cal === 'day') return chain[i];
  const top = chain.length > 1 ? chain[1] : null;
  return top && !isCalRoot(top) ? top : null;
}

// pageId -> most recent edit time anywhere in its subtree (uses each node's `m`)
function pageRecency() {
  const rec = Object.create(null);
  for (const id in doc.nodes) {
    if (id === ROOT) continue;
    const pg = recencyPageId(id);
    if (!pg) continue;
    const m = doc.nodes[id].m || 0;
    if (rec[pg] === undefined || m > rec[pg]) rec[pg] = m; // register even brand-new (m=0) pages
  }
  return rec;
}

// sidebar page list: pinned first, then most-recently-edited (pages + journal days)
function sidebarPageList() {
  const pins = (meta().pins || []).filter(id => doc.nodes[id]);
  const pinnedSet = new Set(pins);
  const rec = pageRecency();
  const recent = Object.keys(rec).filter(id => !pinnedSet.has(id)).sort((a, b) => rec[b] - rec[a]);
  return { list: [...pins, ...recent.slice(0, 18)], pinnedSet };
}

function togglePin(id) {
  const m = meta();
  const i = m.pins.indexOf(id);
  if (i >= 0) m.pins.splice(i, 1); else m.pins.unshift(id);
  markDirty();
  window.renderSidebar();
}
window.togglePin = togglePin;

// replaces the upstream outline-tree sidebar (app2.js keeps its version unused)
window.renderSidebar = function renderSidebar() {
  if (SHARE_TOKEN || !doc) return;
  window.renderGraphSwitcher?.();

  $('#side-daily')?.classList.toggle('current', state.zoom === ROOT && state.view === 'daily');
  $('#side-pages-link')?.classList.toggle('current', state.view === 'pages');

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
    const title = s.id && s.id !== ROOT ? (plainOf(N(s.id).text).trim() || 'Untitled') : 'Daily Notes';
    a.innerHTML = (s.q ? `<span class="side-star-q">“${escHtml(s.q)}”</span>` : '') + escHtml(title);
    a.addEventListener('click', () => { setTimeout(() => setSearch(s.q || ''), 50); });
    const rm = document.createElement('button');
    rm.className = 'side-remove';
    rm.title = 'Remove star';
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      meta().stars.splice(idx, 1);
      markDirty();
      window.renderSidebar();
      window.updateStarBtn();
    });
    row.append(a, rm);
    starsBox.append(row);
  });

  const pagesBox = $('#side-pages');
  if (!pagesBox) return;
  pagesBox.innerHTML = '';
  const currentPage = pageOf(state.zoom);
  const { list, pinnedSet } = sidebarPageList();
  for (const id of list) {
    const cid = contentIdOf(id); // a top-level mirror lists its target's text
    const n = N(cid);
    if (!n) continue;
    if (n.done && !settings.showCompleted) continue;
    const isPinned = pinnedSet.has(id);
    const row = document.createElement('div');
    row.className = 'side-item side-page' + (isPinned ? ' pinned' : '');
    if (state.zoom !== ROOT && (currentPage === id || currentPage === cid)) row.classList.add('current');
    const pin = document.createElement('button');
    pin.className = 'side-pin' + (isPinned ? ' on' : '');
    pin.title = isPinned ? 'Unpin' : 'Pin to top';
    pin.textContent = '📌';
    pin.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); togglePin(id); });
    const a = document.createElement('a');
    a.href = '#/n/' + cid;
    a.textContent = plainOf(n.text).trim() || 'Untitled';
    const del = document.createElement('button');
    del.className = 'side-remove side-del';
    del.title = 'Delete page';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const title = plainOf(n.text).trim() || 'Untitled';
      if (!confirm(`Delete the page “${title}” and everything in it? It moves to the trash.`)) return;
      if (state.zoom === id || state.zoom === cid) location.hash = '#/'; // leave the page we're deleting
      opDelete(id);
    });
    row.append(pin, a, del);
    pagesBox.append(row);
  }
  window.renderRightbar?.(); // keep the side-by-side panel live with the main view
};

/* ---------------- Roam-style date-picker calendar ---------------- */

// the calendar popup Roam shows for /Date Picker: ‹ month⇅ year⇅ › steppers
// over a Su–Sa day grid; consumed by buildDatePicker() in app2.js
window.buildRoamCalendar = function buildRoamCalendar(onPick, onEscape) {
  const wrap = document.createElement('div');
  wrap.className = 'dp';
  const view = new Date();
  view.setDate(1);
  const DP_DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  const mk = (cls, label, fn, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's selection
    b.addEventListener('click', fn);
    return b;
  };

  const build = () => {
    wrap.innerHTML = '';
    const step = (unit, dir) => {
      if (unit === 'm') view.setMonth(view.getMonth() + dir);
      else view.setFullYear(view.getFullYear() + dir);
      build();
    };
    const stepper = unit => {
      const s = document.createElement('span');
      s.className = 'dp-step';
      s.append(mk('', '▴', () => step(unit, 1)), mk('', '▾', () => step(unit, -1)));
      return s;
    };
    const label = txt => {
      const s = document.createElement('span');
      s.className = 'dp-label';
      s.textContent = txt;
      return s;
    };

    const head = document.createElement('div');
    head.className = 'dp-head';
    const spacer = document.createElement('span');
    spacer.className = 'dp-spacer';
    head.append(
      mk('dp-nav', '‹', () => step('m', -1), 'Previous month'),
      label(MONTHS_LONG[view.getMonth()]), stepper('m'),
      spacer,
      label(String(view.getFullYear())), stepper('y'),
      mk('dp-nav', '›', () => step('m', 1), 'Next month'),
    );
    wrap.append(head);

    const grid = document.createElement('div');
    grid.className = 'dp-grid';
    for (const d of DP_DOW) {
      const c = document.createElement('span');
      c.className = 'dp-dow';
      c.textContent = d;
      grid.append(c);
    }
    const firstDow = new Date(view.getFullYear(), view.getMonth(), 1).getDay(); // 0 = Su
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement('span');
      blank.className = 'dp-blank';
      grid.append(blank);
    }
    const today = todayStr();
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoOf(new Date(view.getFullYear(), view.getMonth(), d));
      grid.append(mk('dp-day' + (iso === today ? ' today' : ''), String(d), () => onPick(iso)));
    }
    wrap.append(grid);
  };
  build();

  wrap.tabIndex = -1;
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); }
  });
  return wrap;
};

/* ---------------- Roam-style inserts: [[ page search, journal links, slash --- */

// the [[ autocomplete searches pages and day pages, like Roam's page picker
window.searchPages = function searchPages(q, limit = 8) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const scan = (id, day) => {
    const plain = plainOf(N(id).text).trim();
    if (!plain) return;
    const hay = plain.toLowerCase();
    let score = -1;
    if (!terms.length) score = day ? -1 : 0; // empty query: offer pages, not the whole journal
    else if (terms.every(t => hay.includes(t))) score = 100 - hay.indexOf(terms[0]) - (day ? 20 : 0);
    if (score >= 0) out.push({ id, plain, day, score });
  };
  for (const id of pagesOf()) scan(contentIdOf(id), false);
  // aliases resolve to their page but surface under the alias text the user typed
  for (const [alias, pid] of pageAliasMap()) {
    if (out.some(o => o.id === pid)) continue; // already matched by title
    let score = -1;
    if (terms.length && terms.every(t => alias.includes(t))) score = 90 - alias.indexOf(terms[0]);
    if (score >= 0) out.push({ id: pid, plain: alias, day: false, alias: true, score });
  }
  const root = calRoot(false);
  if (root) {
    for (const y of kidsOf(root)) {
      if (N(y).cal !== 'year') continue;
      for (const m of kidsOf(y)) {
        if (N(m).cal !== 'month') continue;
        for (const d of kidsOf(m)) if (N(d).cal === 'day') scan(d, true);
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
};

// find or create a journal day node (caller must have snapshot()ed)
window.ensureDayId = iso => findDay(iso) || ensureDay(iso);

// physically relocate an item under a journal day page (Roam "move to today")
window.moveItemToDay = function moveItemToDay(id, iso) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const day = ensureDayId(iso);
  if (day === id || isAncestor(id, day)) return; // never move a node into itself
  moveNode(id, day, kidsOf(day).length);
  markDirty();
  renderPage();
  showToast('Moved to ' + roamDateLabel(iso), { label: 'Open', fn: () => zoomTo(day) });
};

// convert literal [[Title]] / [[Target|Alias]] wiki-links in a text/HTML string
// into real page links (creating pages), skipping code, existing links and pills.
// Caller must have snapshot()ed. Returns the (possibly unchanged) HTML.
function linkifyWikiLinks(html) {
  if (!html || !html.includes('[[')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  let changed = false;
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue;
        if (!text.includes('[[')) continue;
        const re = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
        const frag = document.createDocumentFragment();
        let m, last = 0, hit = false;
        while ((m = re.exec(text))) {
          hit = true;
          // a # / @ right before [[ makes it a (multi-word) tag rather than a plain link
          const sig = (text[m.index - 1] === '#' || text[m.index - 1] === '@') && m.index - 1 >= last ? text[m.index - 1] : '';
          const preEnd = sig ? m.index - 1 : m.index;
          if (preEnd > last) frag.append(document.createTextNode(text.slice(last, preEnd)));
          frag.append(makePageAnchor(getOrCreatePage(m[1].trim()), (m[2] || m[1]).trim(), sig));
          last = re.lastIndex;
        }
        if (hit) {
          if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
          child.replaceWith(frag);
          changed = true;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE && !['A', 'CODE', 'TIME'].includes(child.tagName)) {
        walk(child);
      }
    }
  };
  walk(tpl.content);
  return changed ? tpl.innerHTML : html;
}

// turn every literal [[wiki-link]] in the doc into a real link. Mutates within the
// caller's snapshot (afterDocLoad or the import handler) and returns whether it
// changed anything; the caller markDirty()/renderPage()s.
window.migrateWikiLinks = function migrateWikiLinks() {
  if (SHARE_TOKEN || state.readOnly || !doc) return false;
  let changed = false;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n.text || !n.text.includes('[[')) continue;
    const linked = linkifyWikiLinks(n.text);
    if (linked !== n.text) { recOld(id); n.text = sanitizeHtml(linked); n.m = Date.now(); changed = true; }
  }
  return changed;
};

// a link element / HTML pointing at a journal day page (creates the day)
window.dayLinkEl = function dayLinkEl(iso) {
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + ensureDayId(iso));
  a.setAttribute('rel', 'noopener');
  a.textContent = roamDateLabel(iso);
  return a;
};
window.dayLinkHtml = iso => `<a href="#/n/${ensureDayId(iso)}" rel="noopener">${escHtml(roamDateLabel(iso))}</a>`;

// insert an internal link to a journal day page at the caret (creates the day)
window.insertJournalLink = function insertJournalLink(ctx, iso, at) {
  if (state.readOnly) return;
  snapshot();
  const day = findDay(iso) || ensureDay(iso);
  focusItem(ctx.id, 'text', at ?? 'end');
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + day);
  a.setAttribute('rel', 'noopener');
  a.textContent = roamDateLabel(iso);
  insertInlineAtCaret(sel, sel.getRangeAt(0), a);
  const el = elById.get(ctx.id)?.querySelector(':scope > .row > .content');
  if (el) scheduleCommit(el);
  markDirty();
};

// extra slash-menu entries, consumed by slashCommands() in app2.js
window.rhizomeSlashCommands = function rhizomeSlashCommands(ctx, popStart) {
  const at = popStart;
  const refocus = () => focusItem(ctx.id, 'text', at ?? 'end');
  return [
    {
      label: 'Page Reference', icon: '⟦⟧', hint: '[[',
      // typing "[[" re-enters the normal autocomplete flow via the input hook
      fn: () => { refocus(); document.execCommand('insertText', false, '[['); },
    },
    { label: 'Today', icon: '📅', fn: () => insertJournalLink(ctx, dateOffset(0), at) },
    { label: 'Tomorrow', icon: '📅', fn: () => insertJournalLink(ctx, dateOffset(1), at) },
    { label: 'Yesterday', icon: '📅', fn: () => insertJournalLink(ctx, dateOffset(-1), at) },
    { label: 'Date Picker', icon: '📅', fn: () => pickDate(nodeAnchor(ctx.id), iso => insertJournalLink(ctx, iso, at)) },
    {
      label: 'Current Time', icon: '🕐',
      fn: () => {
        refocus();
        const d = new Date();
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        document.execCommand('insertText', false, hhmm + ' ');
      },
    },
  ];
};

/* ---------------- Linked & Unlinked References ---------------- */

// references from daily notes group under their day page, not the calendar container
function refGroupOf(id) {
  let p = id;
  while (p) { if (N(p)?.cal === 'day') return p; p = parentOf(p); }
  return pageOf(id);
}

// one pass over the doc collecting linked references for every target at once
// (the daily view asks for all visible days in a single scan)
function collectLinkedRefs(targets) {
  const out = new Map(); // target → rows
  const add = (t, row) => { const a = out.get(t) || []; a.push(row); out.set(t, a); };
  // Roam-style: a page also collects #tag / @mention references to its title.
  // Only single-token titles can be tagged (multi-word titles have no tag form).
  const tagRe = new Map();
  const attrTargets = new Map(); // lowercased title → target (a "Key:: …" block references page Key)
  for (const t of targets) {
    const title = plainOf(N(t).text).trim();
    if (title && /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(title)) {
      tagRe.set(t, new RegExp('[#@]' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_\\-/])', 'u'));
    }
    if (title) attrTargets.set(title.toLowerCase(), t);
  }
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (n.mirror && n.mirror !== id && targets.has(n.mirror)) {
      const host = parentOf(id) || id;
      add(n.mirror, { id: host, label: '⧉ mirrored in ' + (plainOf(N(host)?.text || '').trim() || 'Untitled') });
    }
    if (!n.text) continue;
    const seen = new Set();
    for (const m of n.text.matchAll(/#\/n\/([A-Za-z0-9]+)/g)) {
      const t = m[1];
      if (t === id || seen.has(t) || !targets.has(t)) continue;
      seen.add(t);
      add(t, { id, html: n.text });
    }
    for (const [t, re] of tagRe) {
      if (t === id || seen.has(t)) continue;
      if (re.test(n.text)) { seen.add(t); add(t, { id, html: n.text }); }
    }
    if (attrTargets.size) {
      const am = plainOf(n.text).match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]*?)::/u);
      const t = am && attrTargets.get(am[1].trim().toLowerCase());
      if (t && t !== id && !seen.has(t)) { seen.add(t); add(t, { id, html: n.text }); }
    }
  }
  return out;
}

// "Key:: value" at a block's start → { key, value }, else null (foundation for aliases + queries)
window.parseAttribute = function parseAttribute(node) {
  const m = plainOf(N(node).text).match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]*?)::\s?([\s\S]*)$/u);
  return m ? { key: m[1].trim(), value: m[2].trim() } : null;
};

/* ---------------- Live queries: {{query: {and:…}{or:…}{not:…}{between:…}}} ---------------- */

// parse a query block into an AST. Page refs come from anchors (#/n/id) or literal
// [[Name]] / #tag; a [[date]] becomes a date leaf (for {between}). Returns a clause or null.
window.parseLiveQuery = function parseLiveQuery(raw) {
  const qm = (raw || '').match(/\{\{query:([\s\S]*)\}\}/);
  if (!qm) return null;
  const tokens = [];
  const re = /\{(and|or|not|between)\s*:|(\})|<a[^>]*href="#\/n\/([A-Za-z0-9]+)"[^>]*>[\s\S]*?<\/a>|\[\[([^\]]+)\]\]|#\[\[([^\]]+)\]\]|#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
  let m;
  while ((m = re.exec(qm[1]))) {
    if (m[1]) { tokens.push({ t: 'open', op: m[1] }); continue; }
    if (m[2]) { tokens.push({ t: 'close' }); continue; }
    if (m[3]) { // an existing anchor: a day node is a date, anything else a page
      const cd = N(m[3]) && N(m[3]).cd;
      tokens.push(cd ? { t: 'date', iso: cd } : { t: 'page', id: m[3] });
      continue;
    }
    const name = (m[4] || m[5] || m[6] || '').trim();
    if (!name) continue;
    const iso = parseRoamDate(name);
    if (iso) { tokens.push({ t: 'date', iso }); continue; }
    const id = findPageByTitle(name);
    if (id) tokens.push({ t: 'page', id });
  }
  let i = 0;
  const parse = () => {
    const tok = tokens[i];
    if (!tok) return null;
    if (tok.t === 'page') { i++; return { op: 'ref', id: tok.id }; }
    if (tok.t === 'date') { i++; return { op: 'date', iso: tok.iso }; }
    if (tok.t === 'open') {
      i++;
      const children = [];
      while (tokens[i] && tokens[i].t !== 'close') { const c = parse(); if (c) children.push(c); else i++; }
      i++; // consume the matching }
      return { op: tok.op, children };
    }
    i++;
    return null;
  };
  return parse();
};

// evaluate a query AST → array of matching block ids (selfId excluded)
window.evalLiveQuery = function evalLiveQuery(ast, selfId) {
  if (!ast) return [];
  const isResult = id => {
    const n = doc.nodes[id];
    return id !== selfId && n && n.text && !isCalRoot(id)
      && plainOf(n.text).trim() && !/\{\{query:/.test(n.text); // query blocks aren't results
  };
  const universe = () => Object.keys(doc.nodes).filter(isResult);
  const refMatches = pageId => {
    const set = new Set();
    const title = plainOf(N(pageId).text).trim();
    const tagRe = /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(title)
      ? new RegExp('[#@]' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_\\-/])', 'u') : null;
    for (const id of Object.keys(doc.nodes)) {
      if (!isResult(id)) continue;
      const n = doc.nodes[id];
      // a block matches a page ref if it links/tags the page, or lives on it (not the title itself)
      if (n.text.includes('#/n/' + pageId) || (tagRe && tagRe.test(n.text)) || (refGroupOf(id) === pageId && id !== pageId)) set.add(id);
    }
    return set;
  };
  const inter = sets => sets.reduce((a, s) => new Set([...a].filter(x => s.has(x))));
  const ev = node => {
    if (node.op === 'ref') return refMatches(node.id);
    if (node.op === 'date') return new Set(); // only meaningful inside {between}
    if (node.op === 'between') {
      const isos = node.children.map(c => c.iso).filter(Boolean).sort();
      const [a, b] = isos;
      const set = new Set();
      if (!a || !b) return set;
      for (const id of Object.keys(doc.nodes)) {
        if (!isResult(id)) continue;
        const cd = N(refGroupOf(id)) && N(refGroupOf(id)).cd;
        if (cd && cd >= a && cd <= b) set.add(id);
      }
      return set;
    }
    const pos = (node.children || []).filter(c => c.op !== 'not');
    const negs = (node.children || []).filter(c => c.op === 'not');
    let acc;
    if (node.op === 'or') { acc = new Set(); for (const c of pos) for (const x of ev(c)) acc.add(x); if (!pos.length) acc = new Set(universe()); }
    else if (node.op === 'not') { acc = new Set(universe()); for (const x of ev(node.children[0] || {})) acc.delete(x); return acc; }
    else acc = pos.length ? inter(pos.map(ev)) : new Set(universe()); // and (default)
    for (const ng of negs) for (const x of ev(ng.children[0] || {})) acc.delete(x);
    return acc;
  };
  const res = ev(ast);
  res.delete(selfId);
  return [...res];
};

// the live result list appended under a {{query:…}} block (re-runs on every render)
window.buildQueryResults = function buildQueryResults(n) {
  if (!/\{\{query:/.test(n.text || '')) return null;
  const box = document.createElement('div');
  box.className = 'query-block';
  const ast = window.parseLiveQuery(n.text);
  if (!ast) { box.innerHTML = '<div class="ref-none">Invalid query.</div>'; return box; }
  const ids = window.evalLiveQuery(ast, n.id).filter(id => doc.nodes[id]);
  const rows = ids.map(id => ({ id, html: N(contentIdOf(id)).text }));
  const built = rows.length ? buildRefGroups(null, rows) : null;
  const head = document.createElement('div');
  head.className = 'query-head';
  head.textContent = `${ids.length} result${ids.length === 1 ? '' : 's'}`;
  box.append(head);
  if (built) box.append(built.el);
  else { const none = document.createElement('div'); none.className = 'ref-none'; none.textContent = 'No matches.'; box.append(none); }
  return box;
};

// grouped DOM for one target's rows; null when nothing survives the self-filter
function buildRefGroups(target, rows) {
  const groups = new Map();
  let count = 0;
  for (const r of rows) {
    const gid = refGroupOf(r.id);
    if (gid === target) continue; // references from inside the page aren't backlinks
    const g = groups.get(gid) || [];
    if (g.length >= 30) continue;
    g.push(r);
    groups.set(gid, g);
    count++;
  }
  if (!count) return null;
  const el = document.createDocumentFragment();
  for (const [gid, gRows] of groups) {
    const gEl = document.createElement('div');
    gEl.className = 'ref-group';
    const title = document.createElement('a');
    title.className = 'ref-page';
    title.href = '#/n/' + gid;
    title.textContent = plainOf(N(gid)?.text || '').trim() || 'Untitled';
    gEl.append(title);
    for (const r of gRows) {
      const row = document.createElement('div');
      row.className = 'ref-row';
      if (r.html != null) {
        row.innerHTML = decorate(r.html);
        row.addEventListener('click', e => { if (!e.target.closest('a')) zoomTo(r.id); });
      } else {
        const a = document.createElement('a');
        a.href = '#/n/' + r.id;
        a.textContent = r.label;
        row.append(a);
      }
      gEl.append(row);
    }
    el.append(gEl);
  }
  return { el, count };
}

// replaces the upstream flat "Linked from" list with Roam-style sections:
// linked references grouped by their containing page, plus a lazy
// unlinked-references scan with a one-click Link action
// whole-outline search results, grouped by page (reuses the reference layout)
window.renderSearchResults = function renderSearchResults(frag) {
  const rows = [...(state.matchSet || [])]
    .filter(id => doc.nodes[id] && plainOf(N(contentIdOf(id)).text).trim()) // skip empty rows (bare mirrors, dividers)
    .map(id => ({ id, html: N(contentIdOf(id)).text })); // mirrors show their transcluded content
  const built = rows.length ? buildRefGroups(null, rows) : null;
  const view = document.createElement('div');
  view.className = 'search-results';
  if (built) view.append(built.el);
  else view.innerHTML = '<div class="ref-none">Nothing matches.</div>';
  frag.append(view);
};

window.renderBacklinks = function renderBacklinks() {
  if (!doc || state.zoom === HOME || searchActive()) { backlinksEl.hidden = true; return; }
  const target = state.zoom;
  const rows = collectLinkedRefs(new Set([target])).get(target) || [];
  const built = buildRefGroups(target, rows);

  backlinksEl.hidden = false;
  backlinksEl.innerHTML = '';
  const head = document.createElement('h3');
  const n = built ? built.count : 0;
  head.textContent = n ? `${n} Linked Reference${n === 1 ? '' : 's'}` : 'Linked References';
  backlinksEl.append(head);
  if (!built) {
    const none = document.createElement('div');
    none.className = 'ref-none';
    none.textContent = 'No linked references yet.';
    backlinksEl.append(none);
  } else {
    backlinksEl.append(built.el);
  }

  renderUnlinkedSection(target);
};

function renderUnlinkedSection(target) {
  const title = plainOf(N(target).text).trim();
  if (title.length < 3) return; // too short to mean anything in a text scan
  const box = document.createElement('div');
  box.className = 'unlinked-box';
  const head = document.createElement('h3');
  head.className = 'unlinked-head';
  head.innerHTML = '<span class="unlinked-caret">▸</span> Unlinked References';
  const body = document.createElement('div');
  body.className = 'unlinked-body';
  body.hidden = true;
  let scanned = false;
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.classList.toggle('open', !body.hidden);
    if (!scanned && !body.hidden) { scanned = true; fillUnlinked(body, target, title); }
  });
  box.append(head, body);
  backlinksEl.append(box);
}

// the O(doc) plain-text scan only runs when the section is expanded
function fillUnlinked(body, target, title) {
  const needle = title.toLowerCase();
  const rows = [];
  for (const id of Object.keys(doc.nodes)) {
    if (rows.length >= 50) break;
    if (id === target || isAncestor(target, id)) continue;
    const n = doc.nodes[id];
    if (n.mirror || n.cal) continue; // calendar titles ("July 14th, 2026") are noise, not mentions
    if ((n.text || '').includes('#/n/' + target)) continue; // already linked
    const plain = plainOf(n.text || '');
    if (!plain.toLowerCase().includes(needle)) continue;
    rows.push({ id, plain: plain.trim() });
  }
  body.innerHTML = '';
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'ref-none';
    none.textContent = 'No unlinked mentions.';
    body.append(none);
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ref-row unlinked-row';
    const span = document.createElement('span');
    span.className = 'unlinked-text';
    span.textContent = r.plain.slice(0, 120);
    span.addEventListener('click', () => zoomTo(r.id));
    const btn = document.createElement('button');
    btn.className = 'unlinked-link-btn';
    btn.textContent = 'Link';
    btn.addEventListener('click', () => {
      if (!linkifyMatch(r.id, target, title)) showToast('Could not link this mention automatically');
    });
    row.append(span, btn);
    body.append(row);
  }
}

// wrap the first plain-text occurrence of the page title in an internal link
function linkifyMatch(nodeId, pageId, title) {
  const n = N(nodeId);
  if (!n || state.readOnly) return false;
  const tpl = document.createElement('template');
  tpl.innerHTML = n.text || '';
  const needle = title.toLowerCase();
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  let hit = null;
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t.parentElement?.closest('a')) continue; // never nest inside an existing link
    const idx = t.nodeValue.toLowerCase().indexOf(needle);
    if (idx >= 0) { hit = { t, idx }; break; }
  }
  if (!hit) return false; // e.g. the mention spans inline markup — leave it to the user
  snapshot();
  const rest = hit.t.splitText(hit.idx);
  rest.splitText(title.length);
  const a = document.createElement('a');
  a.setAttribute('href', '#/n/' + pageId);
  a.setAttribute('rel', 'noopener');
  a.textContent = rest.nodeValue; // keeps the original casing
  rest.replaceWith(a);
  recOld(nodeId);
  n.text = sanitizeHtml(tpl.innerHTML);
  touch(nodeId);
  markDirty();
  renderPage(); // the row migrates from Unlinked to Linked
  return true;
}

// one-time upgrade of legacy single-date <time> pills to real day-page links
// (date ranges keep their pill — they span days, not a single page)
function migrateDatePills() {
  let changed = false;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id];
    if (!n.text || !n.text.includes('<time')) continue;
    const tpl = document.createElement('template');
    tpl.innerHTML = n.text;
    let touched = false;
    tpl.content.querySelectorAll('time[datetime]').forEach(t => {
      const dt = t.getAttribute('datetime');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return; // ranges (iso/iso2) stay pills
      t.replaceWith(dayLinkEl(dt));
      touched = true;
    });
    if (touched) { recOld(id); n.text = sanitizeHtml(tpl.innerHTML); n.m = Date.now(); changed = true; }
  }
  return changed;
}

// init() (app2.js) is async and still awaiting the doc when this file runs.
// One shared snapshot() wraps all migrations so recOld journals them and the ops
// actually persist (a snapshot-less mutation emits no op → is lost under opSync).
/* ---------------- Right sidebar: shift-click opens pages/blocks side-by-side ---------------- */

const RB_KEY = 'rhizome-rightbar';
function saveRb() { try { localStorage.setItem(RB_KEY, JSON.stringify(state.rightbar || [])); } catch { /* private mode */ } }

function rbTitle(id) {
  const n = N(id);
  if (n && n.cd) return roamDateLabel(n.cd);
  return plainOf(n?.text || '').trim() || 'Untitled';
}

// a read-only nested outline (decorate only — never mountItem, which would hijack elById)
function rbTree(id, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'rb-children';
  for (const c of kidsOf(contentIdOf(id))) {
    const cc = contentIdOf(c);
    const row = document.createElement('div');
    row.className = 'rb-item';
    const line = document.createElement('div');
    line.className = 'rb-line';
    line.innerHTML = decorate(N(cc).text || '');
    row.append(line);
    if (depth < 6 && kidsOf(cc).length) row.append(rbTree(c, depth + 1));
    wrap.append(row);
  }
  return wrap;
}

function rbEntry(id) {
  const box = document.createElement('div');
  box.className = 'rb-entry';
  const head = document.createElement('div');
  head.className = 'rb-head';
  const title = document.createElement('a');
  title.className = 'rb-title';
  title.href = '#/n/' + id;
  title.textContent = rbTitle(id);
  const x = document.createElement('button');
  x.className = 'rb-x';
  x.title = 'Remove from sidebar';
  x.textContent = '×';
  x.addEventListener('click', () => closeInRightbar(id));
  head.append(title, x);
  box.append(head);
  // a leaf block has no children to list, so show its own text
  if (plainOf(N(id).text || '').trim() && !kidsOf(contentIdOf(id)).length) {
    const line = document.createElement('div');
    line.className = 'rb-line rb-self';
    line.innerHTML = decorate(N(id).text);
    box.append(line);
  }
  box.append(rbTree(id, 0));
  return box;
}

window.openInRightbar = function openInRightbar(id) {
  id = contentIdOf(id);
  if (!doc.nodes[id]) return;
  if (!Array.isArray(state.rightbar)) state.rightbar = [];
  if (!state.rightbar.includes(id)) state.rightbar.unshift(id);
  saveRb();
  window.renderRightbar();
};

function closeInRightbar(id) {
  state.rightbar = (state.rightbar || []).filter(r => r !== id);
  saveRb();
  window.renderRightbar();
}

window.renderRightbar = function renderRightbar() {
  let bar = document.getElementById('right-sidebar');
  if (!bar) {
    bar = document.createElement('aside');
    bar.id = 'right-sidebar';
    bar.className = 'rightbar';
    document.querySelector('.shell')?.append(bar);
  }
  const ids = (state.rightbar || []).filter(id => doc && doc.nodes[id]);
  state.rightbar = ids;
  const open = ids.length > 0 && !SHARE_TOKEN;
  document.body.classList.toggle('rightbar-open', open);
  bar.innerHTML = '';
  if (!open) return;
  const head = document.createElement('div');
  head.className = 'rb-bar-head';
  const label = document.createElement('span');
  label.textContent = 'Sidebar';
  const closeAll = document.createElement('button');
  closeAll.className = 'rb-x';
  closeAll.title = 'Close sidebar';
  closeAll.textContent = '×';
  closeAll.addEventListener('click', () => { state.rightbar = []; saveRb(); window.renderRightbar(); });
  head.append(label, closeAll);
  bar.append(head);
  for (const id of ids) bar.append(rbEntry(id));
};

// shift-click a page link or bullet → open it in the right sidebar instead of navigating
document.addEventListener('click', e => {
  if (!e.shiftKey || SHARE_TOKEN || !doc) return;
  const a = e.target.closest('a[href^="#/n/"]');
  const bullet = e.target.closest('.bullet');
  let id = null;
  if (a) { const m = a.getAttribute('href').match(/#\/n\/([A-Za-z0-9]+)/); id = m && m[1]; }
  else if (bullet) { id = bullet.closest('.item')?.dataset.id || null; }
  if (!id || !doc.nodes[id]) return;
  e.preventDefault();
  e.stopPropagation();
  window.openInRightbar(id);
}, true);

(function afterDocLoad() {
  if (!doc) { setTimeout(afterDocLoad, 100); return; }
  if (SHARE_TOKEN || state.readOnly) return;
  try { state.rightbar = JSON.parse(localStorage.getItem(RB_KEY) || '[]').filter(id => doc.nodes[id]); } catch { state.rightbar = []; }
  window.renderRightbar();
  snapshot();
  let changed = false;
  changed = migrateDayLabels() || changed;
  changed = migrateDatePills() || changed;
  changed = migrateDupDatePages() || changed;
  changed = migrateWikiLinks() || changed;
  if (changed) { markDirty(); renderPage(); }
})();
