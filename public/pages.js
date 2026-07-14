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

function findPageByTitle(title) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  return pagesOf().find(id => plainOf(N(id).text).trim().toLowerCase() === want) || null;
}

// pages append at the top level; callers wrap in snapshot()
function createPage(title) {
  const id = makeNode(escHtml(title.trim()));
  insertAt(ROOT, kidsOf(ROOT).length, id);
  return id;
}

function getOrCreatePage(title) {
  return findPageByTitle(title) || createPage(title);
}
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
function migrateDayLabels() {
  if (SHARE_TOKEN || state.readOnly || !doc) return;
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
  if (changed) { markDirty(); renderPage(); }
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

  for (const { id, cd } of days.slice(0, dailyLoaded)) {
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
        ? 'Click here, or press Enter, to begin today’s note.'
        : 'Nothing here.';
      if (!state.readOnly) ph.addEventListener('click', () => opNewAt(id, 0));
      sec.append(ph);
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
    tr.append(tdTitle, tdC, tdM);
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

// replaces the upstream outline-tree sidebar (app2.js keeps its version unused)
window.renderSidebar = function renderSidebar() {
  if (SHARE_TOKEN || !doc) return;

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
  for (const id of pagesOf()) {
    const cid = contentIdOf(id); // a top-level mirror lists its target's text
    const n = N(cid);
    if (n.done && !settings.showCompleted) continue;
    const row = document.createElement('div');
    row.className = 'side-item side-page';
    if (state.zoom !== ROOT && (currentPage === id || currentPage === cid)) row.classList.add('current');
    const a = document.createElement('a');
    a.href = '#/n/' + cid;
    a.textContent = plainOf(n.text).trim() || 'Untitled';
    row.append(a);
    pagesBox.append(row);
  }
};

/* ---------------- Linked & Unlinked References ---------------- */

// replaces the upstream flat "Linked from" list with Roam-style sections:
// linked references grouped by their containing page, plus a lazy
// unlinked-references scan with a one-click Link action
window.renderBacklinks = function renderBacklinks() {
  if (!doc || state.zoom === HOME) { backlinksEl.hidden = true; return; }
  const target = state.zoom;

  // references from daily notes group under their day page, not the calendar container
  const refGroupOf = id => {
    let p = id;
    while (p) { if (N(p)?.cal === 'day') return p; p = parentOf(p); }
    return pageOf(id);
  };

  const groups = new Map(); // containing page (or day) → rows
  let linkedCount = 0;
  for (const id of Object.keys(doc.nodes)) {
    if (id === target) continue;
    const n = doc.nodes[id];
    if (n.mirror === target || (n.text || '').includes('#/n/' + target)) {
      const gid = refGroupOf(id);
      if (gid === target) continue; // references from inside the page aren't backlinks
      const rows = groups.get(gid) || [];
      if (rows.length >= 30) continue;
      if (n.mirror === target) {
        const host = parentOf(id) || id;
        rows.push({ id: host, label: '⧉ mirrored in ' + (plainOf(N(host)?.text || '').trim() || 'Untitled') });
      } else {
        rows.push({ id, html: n.text });
      }
      groups.set(gid, rows);
      linkedCount++;
    }
  }

  backlinksEl.hidden = false;
  backlinksEl.innerHTML = '';
  const head = document.createElement('h3');
  head.textContent = `Linked References (${linkedCount})`;
  backlinksEl.append(head);
  if (!linkedCount) {
    const none = document.createElement('div');
    none.className = 'ref-none';
    none.textContent = 'No linked references yet.';
    backlinksEl.append(none);
  }
  for (const [gid, rows] of groups) {
    const gEl = document.createElement('div');
    gEl.className = 'ref-group';
    const title = document.createElement('a');
    title.className = 'ref-page';
    title.href = '#/n/' + gid;
    title.textContent = plainOf(N(gid)?.text || '').trim() || 'Untitled';
    gEl.append(title);
    for (const r of rows) {
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
    backlinksEl.append(gEl);
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

// init() (app2.js) is async and still awaiting the doc when this file runs
(function afterDocLoad() {
  if (doc) migrateDayLabels();
  else setTimeout(afterDocLoad, 100);
})();
