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
  for (const t of targets) {
    const title = plainOf(N(t).text).trim();
    if (title && /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(title)) {
      tagRe.set(t, new RegExp('[#@]' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_\\-/])', 'u'));
    }
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
  }
  return out;
}

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
(function afterDocLoad() {
  if (!doc) { setTimeout(afterDocLoad, 100); return; }
  if (SHARE_TOKEN || state.readOnly) return;
  snapshot();
  let changed = false;
  changed = migrateDayLabels() || changed;
  changed = migrateDatePills() || changed;
  changed = migrateDupDatePages() || changed;
  changed = migrateWikiLinks() || changed;
  if (changed) { markDirty(); renderPage(); }
})();
