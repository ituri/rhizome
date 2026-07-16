/* ============================================================
   Rhizome — self-hostable, page-based outliner (core)
   app.js  : model, rendering, editing ops, keyboard, search, sync
   app2.js : feature UIs (sidebar, menus, slash, dates, share, AI…)
   ============================================================ */
'use strict';

/* ---------------- 1. state ---------------- */

const ROOT = 'root';
let HOME = ROOT;                 // navigation root (share root in share mode)

let doc = null;                  // { nodes: { id -> node }, root, meta?, trash? }
let parentMap = new Map();

const shareMatch = location.pathname.match(/^\/s\/([a-f0-9]{24,})/);
const SHARE_TOKEN = shareMatch ? shareMatch[1] : null;

const state = {
  version: 0,
  zoom: ROOT,
  view: null,                    // rhizome: 'daily' | 'pages' | null — hash-derived root-level view
  search: '',
  sel: null,
  matchSet: null,
  openSet: null,
  matchCount: 0,
  query: null,                   // parsed search query
  ftsCandidates: null,           // {q, ids, ok, pending} — cached FTS candidate set for large-doc search
  readOnly: false,
  shareMode: null,               // 'view' | 'edit' | null
  aiEnabled: false,
  authRequired: false,
  shares: [],                    // [{token, id, mode}]
};

const settings = Object.assign(
  {
    theme: 'auto', accent: 'terracotta', font: 'default', density: 'cozy',
    showCompleted: true, embeds: true, copyTag: true, sidebar: false,
    width: 'reading', arrows: 'hover', capitalize: false, richTags: false,
    dateFormat: 'medium', weekStart: 'mon', markdownPaste: true, animations: true,
    opSync: true, // op delta-sync is the default save path (PUT remains the fallback)
  },
  JSON.parse(localStorage.getItem('tendril-settings') || '{}')
);

const undoStack = [];
const redoStack = [];
let pendingOps = [];   // Route B: ops emitted from the journal, awaiting the next save
let metaDirty = false; // doc.meta (pins/stars) changed — op-sync can't carry it, so force a whole-doc PUT
let serverHasDoc = false; // false until we've loaded/seeded a doc on the server (then ops apply)
let burst = { key: '', at: 0 };

let dirty = false;
let saving = false;
let changeSeq = 0;
let composing = false;
let navGoalX = null;

const bc = (!SHARE_TOKEN && 'BroadcastChannel' in window) ? new BroadcastChannel('tendril-sync') : null;

/* ---------------- 2. dom refs ---------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const pageEl = $('#page');
const treeEl = $('#tree');
const crumbsEl = $('#crumbs');
const zoomHeadEl = $('#zoom-head');
const zoomTitleEl = $('#zoom-title');
const zoomNoteEl = $('#zoom-note');
const searchEl = $('#search');
const searchBoxEl = $('#searchbox');
const searchBannerEl = $('#search-banner');
const emptyHintEl = $('#empty-hint');
const saveStateEl = $('#save-state');
const dropIndicatorEl = $('#drop-indicator');
const toastsEl = $('#toasts');
const mobilebarEl = $('#mobilebar');
const backlinksEl = $('#backlinks');

const elById = new Map();

/* ---------------- 3. utils ---------------- */

const uid = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 8);
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => escHtml(s).replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

const stripTags = (() => {
  const tpl = document.createElement('template');
  return html => { tpl.innerHTML = html; return tpl.content.textContent || ''; };
})();

const plainOf = html => stripTags(html || '').replace(/ /g, ' ');

const todayStr = () => isoOf(new Date());

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- natural-language date parsing (today, next thu, oct 7, in 3 days…) ----
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// markdown block markers typed at line start, e.g. "## " → h2, "> " → quote, "[] " → todo
const BLOCK_MARKERS = { '#': 'h1', '##': 'h2', '###': 'h3', '>': 'quote', '[]': 'todo' };

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// returns { iso, start } — or { iso, iso2, start } for a range — when `before`
// ends with a recognized date phrase (single, or "<dateA> - <dateB>")
function nlDate(before) {
  const sep = before.match(/^(.*\S)\s*[-–]\s*(\S.*)$/);
  if (sep) {
    const right = nlDateSingle(sep[2]);
    const left = nlDateSingle(sep[1]);
    if (right && left && right.start === 0 && left.start + left.phrase.length === sep[1].length) {
      return { iso: left.iso, iso2: right.iso, start: left.start, phrase: before.slice(left.start) };
    }
  }
  return nlDateSingle(before);
}

function nlDateSingle(before) {
  const lower = before.toLowerCase();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const add = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  const matchers = [
    [/(?:^|\s)in\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|days|week|weeks|month|months|year|years)$/, m => {
      const n = NUM_WORDS[m[1]] ?? parseInt(m[1], 10);
      const d = new Date(today), u = m[2];
      if (u.startsWith('day')) d.setDate(d.getDate() + n);
      else if (u.startsWith('week')) d.setDate(d.getDate() + n * 7);
      else if (u.startsWith('month')) d.setMonth(d.getMonth() + n);
      else d.setFullYear(d.getFullYear() + n);
      return d;
    }],
    [/(?:^|\s)(next|last|this)\s+(week|month|year)$/, m => {
      const dir = m[1] === 'next' ? 1 : m[1] === 'last' ? -1 : 0, d = new Date(today);
      if (m[2] === 'week') d.setDate(d.getDate() + dir * 7);
      else if (m[2] === 'month') d.setMonth(d.getMonth() + dir);
      else d.setFullYear(d.getFullYear() + dir);
      return d;
    }],
    [/(?:^|\s)next\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/, m => {
      let delta = (WD[m[1]] - today.getDay() + 7) % 7;
      return add((delta === 0 ? 7 : delta) + 7);
    }],
    [/(?:^|\s)(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?$/, m => add((WD[m[1]] - today.getDay() + 7) % 7)],
    [/(?:^|\s)(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/, m => {
      const mo = MON[m[1].slice(0, 3)], day = +m[2];
      if (day < 1 || day > 31) return null;
      let d = new Date(m[3] ? +m[3] : today.getFullYear(), mo, day);
      if (!m[3] && d < today) d = new Date(today.getFullYear() + 1, mo, day);
      return d;
    }],
    [/(?:^|\s)(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?$/, m => {
      const day = +m[1], mo = MON[m[2].slice(0, 3)];
      if (day < 1 || day > 31) return null;
      let d = new Date(m[3] ? +m[3] : today.getFullYear(), mo, day);
      if (!m[3] && d < today) d = new Date(today.getFullYear() + 1, mo, day);
      return d;
    }],
    [/(?:^|\s)(\d{4})-(\d{1,2})-(\d{1,2})$/, m => new Date(+m[1], +m[2] - 1, +m[3])],
    [/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/, m => {
      let yr = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear();
      const d = new Date(yr, +m[1] - 1, +m[2]);
      if (!m[3] && d < today) d.setFullYear(yr + 1);
      return d;
    }],
    [/(?:^|\s)(today|tonight)$/, () => add(0)],
    [/(?:^|\s)(tomorrow|tmrw|tmr)$/, () => add(1)],
    [/(?:^|\s)(yesterday|yest)$/, () => add(-1)],
  ];
  for (const [re, fn] of matchers) {
    const m = lower.match(re);
    if (!m) continue;
    let phrase = m[0], start = before.length - phrase.length;
    if (/^\s/.test(phrase)) { start += 1; phrase = phrase.slice(1); }
    const d = fn(m);
    if (d && !isNaN(d)) return { iso: isoOf(d), start, phrase };
  }
  return null;
}

// derives a date pill's label from its ISO value, honoring the format setting,
// so changing the setting reformats every existing date live
function formatDate(iso) {
  const [y, mo, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !mo || !d) return iso;
  const date = new Date(y, mo - 1, d);
  switch (settings.dateFormat) {
    case 'short': return `${mo}/${d}/${y}`;
    case 'iso': return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    case 'dow': return `${DOW_SHORT[date.getDay()]}, ${MONTHS_SHORT[mo - 1]} ${d}`;
    case 'long': return `${MONTHS_LONG[mo - 1]} ${d}, ${y}`;
    default: return `${MONTHS_SHORT[mo - 1]} ${d}, ${y}`;
  }
}

/* ---------------- 4. html hygiene ---------------- */

const INLINE = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's', CODE: 'code' };
const SPAN_CLASS_RE = /^(tc|hl)-(red|orange|yellow|green|blue|purple|pink|gray)$/;

function safeHref(href) {
  if (!href) return null;
  if (/^(https?:|mailto:|#)/i.test(href.trim())) return href.trim();
  return null;
}

// like safeHref but also admits our own site-relative upload paths
function fileHref(href) {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  return /^(\/files\/|https?:)/i.test(h) ? h : null;
}

function serializeChildren(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escHtml(child.nodeValue.replace(/ /g, " "))
        .replace(/\(\(([A-Za-z0-9]+)\)\)/g, (m, id) => doc.nodes[id] ? `<a href="#/n/${id}" class="block-ref"></a>` : m);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = INLINE[child.tagName];
      if (child.tagName === 'BR') {
        out += ' ';
      } else if (child.tagName === 'A') {
        const href = safeHref(child.getAttribute('href'));
        const inner = serializeChildren(child);
        if (href && child.classList.contains('block-ref')) { // rhizome: store block refs empty (text stays live)
          out += `<a href="${escAttr(href)}" class="block-ref"></a>`;
        } else if (!href) { out += inner; }
        else if (child.classList.contains('tag')) { // rhizome: keep #[[…]] tag pills (whitelisted class)
          const cls = child.classList.contains('mention') ? 'tag mention' : 'tag';
          const dt = child.getAttribute('data-tag');
          out += `<a href="${escAttr(href)}" class="${cls}"${dt ? ` data-tag="${escAttr(dt)}"` : ''}>${inner}</a>`;
        } else { out += `<a href="${escAttr(href)}">${inner}</a>`; }
      } else if (child.tagName === 'TIME' && child.getAttribute('datetime')) {
        out += `<time datetime="${escAttr(child.getAttribute('datetime'))}">${escHtml(child.textContent)}</time>`;
      } else if (child.tagName === 'SPAN') {
        const kept = [...child.classList].filter(c => SPAN_CLASS_RE.test(c));
        const inner = serializeChildren(child);
        if (kept.length && inner) out += `<span class="${kept.join(' ')}">${inner}</span>`;
        else out += inner;
      } else if (tag) {
        const inner = serializeChildren(child);
        out += inner ? `<${tag}>${inner}</${tag}>` : '';
      } else {
        out += serializeChildren(child);
      }
    }
  }
  return out;
}

const serializeEl = el => serializeChildren(el);

const sanitizeHtml = (() => {
  const tpl = document.createElement('template');
  return html => { tpl.innerHTML = html || ''; return serializeChildren(tpl.content); };
})();

// uppercase the first letter of the bullet (settings.capitalize)
function applyCapitalize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const m = node.nodeValue.match(/\S/);
    if (m) {
      const ch = node.nodeValue[m.index];
      if (ch.toLowerCase() !== ch.toUpperCase() && ch === ch.toLowerCase()) {
        node.nodeValue = node.nodeValue.slice(0, m.index) + ch.toUpperCase() + node.nodeValue.slice(m.index + 1);
        return tpl.innerHTML;
      }
      return html;
    }
  }
  return html;
}

// converts pasted markdown-ish text to Tendril inline html (settings.markdownPaste)
function mdInline(plain) {
  let s = escHtml(plain);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, t, h) => `<a href="${escAttr(h)}" rel="noopener">${t}</a>`);
  return s;
}

// rich tags (settings.richTags) additionally allow emoji inside tags
const TAG_RE = /(^|[\s(])([#@][\p{L}\p{N}_][\p{L}\p{N}_\-\/]*)/gu;
const TAG_RE_RICH = /(^|[\s(])([#@][\p{L}\p{N}_\p{Extended_Pictographic}][\p{L}\p{N}_\-\/\p{Extended_Pictographic}‍️]*)/gu;
const tagRe = () => settings.richTags ? TAG_RE_RICH : TAG_RE;
const URL_RE = /https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;

function highlightTermsOf() {
  if (!state.query) return null;
  const seg = state.query.segments[state.query.segments.length - 1];
  const terms = [];
  for (const clause of seg) {
    for (const cond of clause.or) {
      if (!cond.neg && cond.kind === 'text' && cond.value.length > 0) terms.push(cond.value);
    }
  }
  return terms.length ? terms : null;
}

function decorate(html, opts = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const terms = searchActive() ? highlightTermsOf() : null;

  // rhizome: a leading "Key:: value" renders the key as an attribute chip
  if (!opts.plain) {
    const first = tpl.content.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      const m = first.nodeValue.match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]*?)::(\s|$)/u);
      if (m) {
        const key = document.createElement('span');
        key.className = 'attr-key';
        key.setAttribute('data-attr', m[1]);
        key.textContent = m[1];
        first.replaceWith(key, document.createTextNode(first.nodeValue.slice(m[1].length)));
      }
    }
  }

  const walk = (node, inLink) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        // rhizome: a block reference shows the target block's CURRENT text, live —
        // but while its line is being edited it reverts to its raw ((id)) source
        if (child.tagName === 'A' && child.classList.contains('block-ref')) {
          const m = (child.getAttribute('href') || '').match(/#\/n\/([A-Za-z0-9]+)/);
          if (opts.editing) { child.replaceWith(document.createTextNode(m ? `((${m[1]}))` : '')); continue; }
          const t = m && doc.nodes[m[1]];
          child.textContent = t ? (plainOf(t.text).trim().slice(0, 140) || 'Untitled') : '(deleted block)';
          child.setAttribute('contenteditable', 'false');
          continue;
        }
        if (child.tagName === 'TIME' && child.getAttribute('datetime')) {
          const dt = child.getAttribute('datetime');
          const t = todayStr();
          if (dt.includes('/')) {
            const [a, b] = dt.split('/').map(s => s.slice(0, 10));
            child.textContent = formatDate(a) + ' – ' + formatDate(b);
            child.classList.toggle('today', a <= t && t <= b);
            child.classList.toggle('past', b < t);
          } else {
            const d = dt.slice(0, 10);
            child.textContent = formatDate(d);
            child.classList.toggle('today', d === t);
            child.classList.toggle('past', d < t);
          }
          continue;
        }
        walk(child, inLink || child.tagName === 'A' || child.tagName === 'CODE');
        continue;
      }
      if (child.nodeType !== Node.TEXT_NODE) continue;
      let html2 = escHtml(child.nodeValue);
      if (!inLink && !opts.plain) {
        html2 = html2.replace(URL_RE, m =>
          `<a href="${escAttr(m)}" rel="noopener">${m}</a>`);
        html2 = html2.replace(tagRe(), (m, pre, tag) =>
          `${pre}<span class="tag${tag[0] === '@' ? ' mention' : ''}" data-tag="${escAttr(tag)}">${tag}</span>`);
      }
      if (terms) {
        for (const t of terms) {
          html2 = html2.split(/(<[^>]+>)/).map(seg => {
            if (seg.startsWith('<')) return seg;
            const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            return seg.replace(re, m => `<mark>${m}</mark>`);
          }).join('');
        }
      }
      const span = document.createElement('template');
      span.innerHTML = html2;
      child.replaceWith(span.content);
    }
  };
  walk(tpl.content, false);
  return tpl.innerHTML;
}

function displayHtml(n) {
  return decorate(n.text, { plain: n.format === 'codeblock' });
}

/* ---------------- 5. model ---------------- */

const N = id => doc.nodes[id];
const kidsOf = id => N(id).children;
const hasKids = id => kidsOf(id).length > 0;
const parentOf = id => parentMap.get(id);

function rebuildParentMap() {
  parentMap = new Map();
  for (const id of Object.keys(doc.nodes)) {
    for (const c of doc.nodes[id].children) parentMap.set(c, id);
  }
  mirrorsDirty = true; // full-doc swaps (load, adopt, import, undo/redo) may change mirror topology
}

function ancestorsOf(id) {
  const out = [];
  let p = parentOf(id);
  while (p) { out.unshift(p); p = parentOf(p); }
  return out;
}

const isAncestor = (a, b) => {
  let p = parentOf(b);
  while (p) { if (p === a) return true; p = parentOf(p); }
  return false;
};

function makeNode(text = '', extra = {}) {
  const id = uid();
  const now = Date.now();
  recOld(id); // new node → recorded as "didn't exist" so undo removes it
  doc.nodes[id] = { id, text, note: null, done: false, collapsed: false, children: [], c: now, m: now, ...extra };
  if (extra.mirror) mirrorsDirty = true;
  return id;
}

const touch = id => { if (doc.nodes[id]) { recOld(id); N(id).m = Date.now(); } };

function detach(id) {
  const p = parentOf(id);
  if (!p) return;
  recOld(p); // the parent's children array changes
  const arr = kidsOf(p);
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  parentMap.delete(id);
}

function insertAt(parent, index, id) {
  recOld(parent); // the parent's children array changes
  const arr = kidsOf(parent);
  arr.splice(clamp(index, 0, arr.length), 0, id);
  parentMap.set(id, parent);
}

function moveNode(id, parent, index) {
  const oldParent = parentOf(id);
  if (oldParent === parent) {
    const oldIdx = kidsOf(parent).indexOf(id);
    if (oldIdx < index) index--;
  }
  detach(id);
  insertAt(parent, index, id);
  touch(id);
}

function deleteSubtree(id) {
  detach(id);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    stack.push(...kidsOf(cur));
    recOld(cur); // record each removed node so undo restores the whole subtree
    if (doc.nodes[cur].mirror || mirrorCounts.has(cur)) mirrorsDirty = true; // an instance or a target left the doc
    delete doc.nodes[cur];
    parentMap.delete(cur);
  }
}

function cloneSubtree(id) {
  const src = N(id);
  const nid = makeNode(src.text, {
    note: src.note, done: src.done, collapsed: src.collapsed,
    format: src.format, mirror: src.mirror,
    files: src.files ? structuredClone(src.files) : undefined,
    comments: src.comments ? structuredClone(src.comments) : undefined,
  });
  for (const c of src.children) {
    const cc = cloneSubtree(c);
    insertAt(nid, kidsOf(nid).length, cc);
  }
  return nid;
}

function countDescendants(id) {
  let n = 0;
  const stack = [...kidsOf(id)];
  while (stack.length) { const c = stack.pop(); n++; stack.push(...kidsOf(c)); }
  return n;
}

function subtreeOf(id) {
  const out = [id];
  const stack = [id];
  while (stack.length) { const c = stack.pop(); for (const k of kidsOf(c)) { out.push(k); stack.push(k); } }
  return out;
}

function meta() {
  if (!doc.meta) doc.meta = {};
  if (!doc.meta.stars) doc.meta.stars = [];
  if (!doc.meta.pins) doc.meta.pins = [];
  return doc.meta;
}

function trashList() {
  if (!doc.trash) doc.trash = [];
  return doc.trash;
}

const fmtOf = id => N(id).format || 'bullet';
function numberFor(id) {
  const p = parentOf(id);
  if (!p) return 1;
  const sibs = kidsOf(p);
  let i = sibs.indexOf(id), n = 1;
  for (let j = i - 1; j >= 0; j--) {
    if (fmtOf(sibs[j]) === 'number') n++; else break;
  }
  return n;
}
const isMirror = id => !!N(id).mirror;
const mirrorTarget = id => {
  const t = N(id).mirror;
  return t && doc.nodes[t] ? t : null;
};
// Mirrors are full interactive instances (Workflowy semantics): every instance shows and
// edits the SAME content + subtree. Content ops (text, note, done, format, dates, sort…)
// route to the node that owns the content; structural ops (move, indent, delete) act on
// the instance itself. contentIdOf is that routing.
const contentIdOf = id => { const t = N(id)?.mirror; return t && doc.nodes[t] ? t : id; };
// targets that currently have at least one live mirror instance → they render the diamond
// bullet too, and revert to a circle automatically once the last mirror is gone.
// The full scan costs ~15ms at 100k nodes, so it only runs when mirror topology may have
// changed (mirrorsDirty — set conservatively at every mutation that can touch a `mirror`
// field or remove nodes; over-flagging is harmless, a stale skip is not).
let mirrorCounts = new Map();      // target id → number of live instances
let mirrorInstances = new Map();   // target id → [mirror node ids] (search expands matches with these)
let mirrorsDirty = true;
function rebuildMirrorCounts() {
  if (!mirrorsDirty) return;
  mirrorsDirty = false;
  mirrorCounts = new Map();
  mirrorInstances = new Map();
  for (const id in doc.nodes) {
    const t = doc.nodes[id].mirror;
    if (t && doc.nodes[t]) {
      mirrorCounts.set(t, (mirrorCounts.get(t) || 0) + 1);
      if (!mirrorInstances.has(t)) mirrorInstances.set(t, []);
      mirrorInstances.get(t).push(id);
    }
  }
}
const editableNode = id => fmtOf(id) !== 'divider' && (!isMirror(id) || !!mirrorTarget(id));

/* ---------------- 6. caret & focus utilities ---------------- */

function textLen(el) { return (el.textContent || '').length; }

function caretOffsetIn(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

// plain-text offset of the selection FOCUS (the moving end of a shift-selection),
// unlike caretOffsetIn which reports the range start
function selFocusOffsetIn(el) {
  const sel = getSelection();
  if (!sel.focusNode || !el.contains(sel.focusNode)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  try { pre.setEnd(sel.focusNode, sel.focusOffset); } catch { return null; }
  return pre.toString().length;
}

function setCaretOffset(el, offset) {
  el.focus({ preventScroll: false });
  const sel = getSelection();
  const range = document.createRange();
  if (offset === 'end') offset = textLen(el);
  let remaining = clamp(offset ?? 0, 0, textLen(el));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let placed = false;
  while (node) {
    if (node.nodeValue.length >= remaining) {
      range.setStart(node, remaining);
      placed = true;
      break;
    }
    remaining -= node.nodeValue.length;
    node = walker.nextNode();
  }
  if (!placed) { range.selectNodeContents(el); range.collapse(false); }
  else range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectPlainRange(el, from, to) {
  if (from === to) { setCaretOffset(el, from); return; }
  const range = document.createRange();
  let rs = from, re = to, startSet = false, endSet = false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!startSet) {
      if (rs <= len) { range.setStart(node, rs); startSet = true; }
      else rs -= len;
    }
    if (startSet && !endSet) {
      if (re <= len) { range.setEnd(node, re); endSet = true; break; }
    }
    re -= len;
  }
  if (!startSet) { setCaretOffset(el, 'end'); return; }
  if (!endSet) range.setEnd(el, el.childNodes.length);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretRangeAtPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  }
  return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
}

function caretLineInfo(el) {
  const er = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
  const fallback = { first: true, last: true, x: er.left, lh };
  const sel = getSelection();
  if (!sel.rangeCount) return fallback;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(false);
  let rect = r.getClientRects()[0] || r.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) return fallback;
  return {
    first: rect.top - er.top < lh * 0.75,
    last: er.bottom - rect.bottom < lh * 0.75,
    x: rect.left,
    lh,
  };
}

function setCaretAtX(el, x, edge) {
  el.focus({ preventScroll: false });
  if (!textLen(el)) return;
  const er = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
  const y = edge === 'last' ? er.bottom - lh / 2 : er.top + lh / 2;
  const cx = clamp(x, er.left + 1, er.right - 1);
  const range = caretRangeAtPoint(cx, y);
  if (range && el.contains(range.startContainer)) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    setCaretOffset(el, edge === 'last' ? 'end' : 0);
  }
}

// The focusable text stops, in document order. The only non-editable member of
// navTargets() is the collapsed-column bar, so filtering it out yields exactly
// the editable stops.
function editables() {
  return navTargets().filter(el => el.isContentEditable);
}

// The ordered stops for arrow-key navigation: every editable, plus collapsed
// board-column bars so a column can never become an unreachable dead-end —
// the renderer decides the order, nav just walks it.
function navTargets() {
  const out = [];
  if (state.zoom !== HOME && !zoomHeadEl.hidden && zoomHeadEl.style.display !== 'none') {
    if (zoomTitleEl.isContentEditable) out.push(zoomTitleEl);
    if (!zoomNoteEl.hidden && zoomNoteEl.isContentEditable) out.push(zoomNoteEl);
  }
  for (const el of treeEl.querySelectorAll('.content, .note, .col-collapsed')) {
    if (el.offsetParent === null) continue;
    if (el.isContentEditable || el.classList.contains('col-collapsed')) out.push(el);
  }
  return out;
}

// Move the caret onto a nav stop. A collapsed column bar isn't editable, so
// entering it expands the column first and lands in its header.
function focusNavTarget(target, edge, x) {
  if (target.classList.contains('col-collapsed')) {
    const colId = target.dataset.colToggle;
    if (colId && N(colId)) {
      N(colId).collapsed = false;
      touch(colId);
      renderPage();
      focusItem(colId, 'text', edge === 'last' ? 'end' : 0);
      markDirty();
    }
    return;
  }
  setCaretAtX(target, x, edge);
  target.scrollIntoView({ block: 'nearest' });
}

// In a board, ←/→ at the text edge should hop to the neighbouring COLUMN (same card
// index), not to the previous/next stop of the same column — vertical arrows already
// cover that. Returns the stop to land on, or null when not in a board / no neighbour.
function boardHopTarget(el, dir) {
  const colEl = el.closest('.board-col');
  if (!colEl) return null;
  const stops = c => [...c.querySelectorAll('.content, .note, .col-collapsed')]
    .filter(x => x.offsetParent !== null && (x.isContentEditable || x.classList.contains('col-collapsed')));
  let sib = colEl;
  do { sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling; }
  while (sib && !sib.classList.contains('board-col'));
  if (!sib) return null;
  const theirs = stops(sib); // never empty: a column always has its title or its collapsed bar
  if (!theirs.length) return null;
  const idx = Math.max(0, stops(colEl).indexOf(el));
  return theirs[Math.min(idx, theirs.length - 1)];
}

function editableCtx(el) {
  if (!el || !(el instanceof Element)) return null;
  el = el.closest?.('[contenteditable="true"]');
  if (!el) return null;
  if (el === zoomTitleEl) return { el, id: state.zoom, field: 'title' };
  if (el === zoomNoteEl) return { el, id: state.zoom, field: 'zoom-note' };
  const item = el.closest('.item');
  if (!item) return null;
  return { el, id: item.dataset.id, field: el.classList.contains('note') ? 'note' : 'text' };
}

// the mirror instance an element renders inside, if any — focus restoration uses it to
// land the caret in the SAME transcluded copy the user was editing, not the primary one
const mirrorHostOf = el => el?.closest?.('.item.is-mirror')?.dataset.id || null;

function focusItem(id, field = 'text', offset = 'end', host = null) {
  if (id === state.zoom) {
    const el = field === 'note' || field === 'zoom-note' ? zoomNoteEl : zoomTitleEl;
    if (!el.hidden) setCaretOffset(el, offset);
    return;
  }
  let item = null;
  if (host && host !== id) item = elById.get(host)?.querySelector(`.item[data-id="${id}"]`) || null;
  if (!item) item = elById.get(id);
  if (!item) return;
  const el = field === 'note' ? item.querySelector(':scope > .note') : item.querySelector(':scope > .row .content');
  if (el && el.isContentEditable) setCaretOffset(el, offset);
}

function captureFocus() {
  const ctx = editableCtx(document.activeElement);
  if (!ctx) return null;
  return { id: ctx.id, field: ctx.field, offset: caretOffsetIn(ctx.el) ?? 0, host: mirrorHostOf(ctx.el) };
}

function restoreFocus(f) {
  if (!f || !doc.nodes[f.id]) return;
  focusItem(f.id, f.field, f.offset, f.host);
}

/* ---------------- 7. undo / redo ---------------- */

/* Op-log undo. Instead of structuredClone'ing the whole doc per edit (O(doc) — the 100k
   jank), each operation records only the prior state of the nodes it touches (O(change)).
   An undo entry is a Map(id → prior node clone | null); undo/redo restore those nodes in
   place and re-derive the parent map. recOld() is called by the mutation primitives and
   field-edit sites; it's a no-op when no operation is being recorded. */
const ABSENT = Symbol('absent'); // "this op didn't touch trash/meta"
let undoTxn = null;       // { nodes: Map(id→prior clone|null), trash: ABSENT|clone, meta: ABSENT|clone }
let undoFocus = null;     // focus captured at the start of the op

function recOld(id) {     // remember a node's state BEFORE this op changes it (once per op)
  if (undoTxn && !undoTxn.nodes.has(id)) undoTxn.nodes.set(id, doc.nodes[id] ? structuredClone(doc.nodes[id]) : null);
}
function recTrash() { if (undoTxn && undoTxn.trash === ABSENT) undoTxn.trash = structuredClone(doc.trash || []); }
function recMeta() { if (undoTxn && undoTxn.meta === ABSENT) undoTxn.meta = structuredClone(doc.meta || {}); }

function captureNodes(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, doc.nodes[id] ? structuredClone(doc.nodes[id]) : null);
  return m;
}
// snapshot the current state of whatever an entry touched (used to build the inverse entry)
function captureLike(entry) {
  return {
    nodes: captureNodes(entry.nodes.keys()),
    trash: entry.trash !== ABSENT ? structuredClone(doc.trash || []) : ABSENT,
    meta: entry.meta !== ABSENT ? structuredClone(doc.meta || {}) : ABSENT,
    focus: captureFocus(),
  };
}
function commitUndoTxn() { // close the in-progress op into an undo entry
  if (undoTxn && (undoTxn.nodes.size || undoTxn.trash !== ABSENT || undoTxn.meta !== ABSENT)) {
    queueOps(undoTxn);       // Route B: emit this operation's sync ops from the same journal
    undoStack.push({ ...undoTxn, focus: undoFocus });
    if (undoStack.length > 200) undoStack.shift();
  }
  undoTxn = null;
}
function resetHistory() { undoStack.length = 0; redoStack.length = 0; undoTxn = null; } // whole-doc swaps (import/adopt)

function snapshot() {
  commitUndoTxn();             // finalize the previous op
  undoTxn = { nodes: new Map(), trash: ABSENT, meta: ABSENT }; // begin recording the next
  undoFocus = captureFocus();
  redoStack.length = 0;
}

function applyEntry(entry) {   // restore the recorded nodes/trash/meta in place — O(change)
  for (const [id, node] of entry.nodes) { if (node === null) delete doc.nodes[id]; else doc.nodes[id] = node; }
  if (entry.trash !== ABSENT) doc.trash = entry.trash;
  if (entry.meta !== ABSENT) doc.meta = entry.meta;
}
function applyHistory(focus) {
  burst = { key: '', at: 0 }; // typing right after undo/redo must snapshot afresh
  rebuildParentMap();
  if (!doc.nodes[state.zoom]) state.zoom = HOME;
  renderPage();
  restoreFocus(focus);
  markDirty();
}

function undo() {
  if (state.readOnly) return;
  commitActiveText();
  commitUndoTxn();             // finalize any in-progress op so it's undoable
  if (!undoStack.length) return;
  const entry = undoStack.pop();
  const inv = captureLike(entry); // current (pre-undo) state of the touched nodes
  redoStack.push(inv);
  applyEntry(entry);
  queueOps(inv);                   // Route B: sync the undo as ops (pre-undo → restored)
  applyHistory(entry.focus);
}

function redo() {
  if (state.readOnly) return;
  commitActiveText();
  commitUndoTxn();
  if (!redoStack.length) return;
  const entry = redoStack.pop();
  const inv = captureLike(entry);
  undoStack.push(inv);
  applyEntry(entry);
  queueOps(inv);
  applyHistory(entry.focus);
}

/* ---------------- 8. persistence & sync ---------------- */

// the active graph's API base, e.g. "/api/g/<graphId>". Set by ensureAuth once the graph
// is known; document/ops/events/version/search/shares all hang off it. Files & AI stay global.
let apiBase = '';
let SAVE_URL = SHARE_TOKEN ? `/api/share/${SHARE_TOKEN}/doc` : '/api/doc';

function setSaveUI(mode) {
  saveStateEl.classList.toggle('saving', mode === 'saving');
  saveStateEl.classList.toggle('offline', mode === 'offline');
  $('.save-label', saveStateEl).textContent =
    mode === 'saving' ? 'saving' : mode === 'offline' ? 'offline' : 'saved';
  saveStateEl.title =
    mode === 'offline' ? 'Cannot reach the server — changes are kept here and retried.' : 'All changes saved';
}

const scheduleSave = debounce(() => doSave(), 600);

function markDirty() {
  if (state.readOnly) return;
  dirty = true;
  changeSeq++;
  setSaveUI('saving');
  scheduleSave();
}

// pins/stars live in doc.meta, which the op-sync delta protocol doesn't carry. Route the
// next save through the whole-doc PUT (its body includes doc.meta) so the change actually
// reaches the server instead of being dropped by the empty-pendingOps early-return.
function markMetaDirty() {
  metaDirty = true;
  markDirty();
}
window.markMetaDirty = markMetaDirty;

// every doc that arrives from the network passes through the whitelist
// serializer — guests with edit-share tokens can PUT arbitrary markup
function sanitizeDocTexts(d) {
  for (const id of Object.keys(d.nodes)) {
    const n = d.nodes[id];
    n.text = sanitizeHtml(n.text || '');
    if (!Array.isArray(n.children)) n.children = [];
  }
  return d;
}

// graft any nodes that exist on the server but not locally (e.g. captured via API
// or added from another device) into our copy before we overwrite the server.
function graftMissing(serverDoc) {
  if (!serverDoc || !serverDoc.nodes) return;
  sanitizeDocTexts(serverDoc);
  const queue = [serverDoc.root];
  while (queue.length) {
    const pid = queue.shift();
    const sn = serverDoc.nodes[pid];
    if (!sn) continue;
    for (const cid of sn.children || []) {
      if (!doc.nodes[cid] && doc.nodes[pid]) {
        // copy the whole missing subtree
        const stack = [cid];
        while (stack.length) {
          const x = stack.pop();
          if (!serverDoc.nodes[x] || doc.nodes[x]) continue;
          doc.nodes[x] = serverDoc.nodes[x];
          stack.push(...(serverDoc.nodes[x].children || []));
        }
        const idx = (sn.children || []).indexOf(cid);
        insertAt(pid, Math.min(idx, kidsOf(pid).length), cid);
      }
      queue.push(cid);
    }
  }
}

/* ---------------- offline cache (IndexedDB) ----------------
   A tiny key/value store so the app boots offline: we stash the last /api/me and
   the last-known doc per graph. A cold start with no network reads these instead
   of failing (localStorage's ~5MB cap is too small for a large graph). Every
   accessor resolves (never rejects) so callers can await it unguarded. */
const idb = (() => {
  const noStore = typeof indexedDB === 'undefined';
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('rhizome', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  }));
  return {
    get: k => noStore ? Promise.resolve(null) : run('readonly', s => s.get(k)).catch(() => null),
    set: (k, v) => noStore ? Promise.resolve() : run('readwrite', s => s.put(v, k)).catch(() => {}),
  };
})();

// Snapshot the current doc into the offline boot cache, tagged with the live
// dirty flag so a cold offline start knows whether edits still need pushing.
function cacheDoc() {
  if (!doc || SHARE_TOKEN) return;
  idb.set('doc:' + state.graphId, { version: state.version, doc, dirty, at: Date.now() });
}

function stashOffline() {
  cacheDoc();
  try {
    localStorage.setItem('tendril-offline', JSON.stringify({ baseVersion: state.version, doc, at: Date.now() }));
  } catch { /* quota — best effort */ }
}

async function doSave() {
  if (saving || !doc || state.readOnly) return;
  saving = true;
  const seq = changeSeq;
  try {
    // Route B op delta-sync (default): send the ops the journal emitted — no baseline is
    // consulted, so the send path cannot drift. The server dedupes by op id and orders by
    // a monotonic version, so a re-send after a failure is safe. PUT remains the fallback.
    if (settings.opSync && !SHARE_TOKEN && serverHasDoc && !metaDirty) {
      commitActiveText(true); // flush the active edit into the op WITH re-decorate (so e.g. a
      commitUndoTxn();        // just-inserted date pill is styled), then finalize the op
      if (!pendingOps.length) {
        // Nothing to delta-sync. If the doc is CLEAN, we're genuinely up to date → "saved".
        // But if it's still DIRTY, a mutation reached node state WITHOUT emitting an op (e.g.
        // a debounced text commit that landed outside a transaction) — reporting "saved" here
        // would strand it on this device only: the "typed in the web, green, but it never
        // reached the server / iOS" truncation bug. Fall through (below) to the whole-doc PUT,
        // whose body carries the full node text, instead of POSTing an empty op batch.
        if (!dirty) {
          if (changeSeq === seq) { setSaveUI('saved'); localStorage.removeItem('tendril-offline'); }
          return;
        }
      } else {
        const batch = pendingOps;        // take the queue; edits during the await accumulate a fresh one
        pendingOps = [];
        const r = await fetch(apiBase + '/ops', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: batch, device: DEVICE_ID }),
        });
        if (r.ok) {
          const rv = (await r.json()).version;
          if (rv > state.version) state.version = rv; // never regress if a peer broadcast already advanced us
          if (changeSeq === seq) { dirty = false; setSaveUI('saved'); localStorage.removeItem('tendril-offline'); }
          cacheDoc(); // refresh the offline boot snapshot with the just-synced state
          return;
        }
        pendingOps = batch.concat(pendingOps); // failed → requeue (idempotent), fall to the whole-doc PUT
      }
    }
    // ops journaled after this stringify are NOT in the PUT body — they must survive it
    const opsBeforePut = pendingOps.length;
    let res = await fetch(SAVE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: state.version, doc, device: DEVICE_ID }),
    });
    if (res.status === 409) {
      const server = await res.json();
      graftMissing(server.doc);
      rebuildParentMap();
      res = await fetch(SAVE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: server.version, doc, device: DEVICE_ID }),
      });
    }
    if (res.status === 401) { location.reload(); return; }
    if (res.status === 410 || res.status === 403) {
      setSaveUI('offline');
      showToast(res.status === 403 ? 'This share is view-only now.' : 'The shared item was deleted.');
      return;
    }
    if (!res.ok) throw new Error('save failed: ' + res.status);
    state.version = (await res.json()).version;
    pendingOps = pendingOps.slice(opsBeforePut); // drop only ops the PUT body already contained
    serverHasDoc = true; // the whole doc was just sent — ops queued before it are now redundant
    if (changeSeq === seq) {
      metaDirty = false; // doc.meta was just persisted in the PUT body
      dirty = false;
      setSaveUI('saved');
      localStorage.removeItem('tendril-offline');
      bc?.postMessage({ version: state.version }); // just a nudge — peers refetch (no whole-doc clone)
    }
    cacheDoc(); // refresh the offline boot snapshot with the just-synced state
  } catch {
    setSaveUI('offline');
    stashOffline();
    setTimeout(() => { if (dirty) doSave(); }, 5000);
  } finally {
    saving = false;
    if (changeSeq !== seq && dirty) scheduleSave();
  }
}

function adoptRemote(version, remoteDoc) {
  doc = sanitizeDocTexts(remoteDoc);
  state.version = version;
  rebuildParentMap();
  serverHasDoc = true;
  pendingOps = []; // adopting the server's whole doc supersedes any queued local ops (only happens when not dirty)
  if (!doc.nodes[state.zoom]) state.zoom = HOME;
  renderPage();
}

bc?.addEventListener('message', async e => {
  // another tab saved — refetch the whole doc instead of receiving it cloned over the channel
  if (dirty || !e.data || e.data.version <= state.version) return;
  try {
    const full = await (await fetch(apiBase + '/doc')).json();
    if (!dirty && full.version > state.version) adoptRemote(full.version, full.doc);
  } catch { /* offline */ }
});

/* ---------------- 8b. op sync (Phase 2/4) ----------------
   Delta sync over /api/ops is the default save path (settings.opSync, on unless
   disabled): common edits (insert/update/move) go as a minimal op set; deletes /
   trash changes fall back to the whole-doc PUT so trash stays consistent (op-based
   trash is the remaining cutover step). Receiving the server's authoritative op
   broadcast is always on, and replaying it is safe because the PUT path broadcasts
   no `ops` — so a PUT-only peer just refetches as before. */
// Per-SESSION actor id (fresh per page load), NOT per device. It tags op ids, the HLC
// tiebreak, and the broadcast origin. It must be unique per tab so the origin-skip only
// ignores *this* tab's own echo — two tabs of one browser share localStorage, so a
// persisted id would make them wrongly ignore each other's ops.
const DEVICE_ID = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
const pad = (n, w) => String(n).padStart(w, '0');
const hlcClock = {
  p: 0, c: 0,
  tick() { const w = Date.now(); if (w > this.p) { this.p = w; this.c = 0; } else this.c++; return `${pad(this.p, 13)}:${pad(this.c, 5)}:${DEVICE_ID}`; },
  recv(s) { const [rp, rc] = s.split(':'); const w = Date.now(); const p = Math.max(w, this.p, +rp);
    if (p === this.p && p === +rp) this.c = Math.max(this.c, +rc) + 1; else if (p === this.p) this.c++; else if (p === +rp) this.c = +rc + 1; else this.c = 0; this.p = p; },
};
let opSeq = 0;
const OP_SKIP = new Set(['id', 'children', '$hlc']); // structural/metadata — never a field patch
const deepEq = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// apply the server's authoritative op stream to the local doc (server already merged)
function applyRemoteOps(ops) {
  for (const o of ops) {
    hlcClock.recv(o.hlc);
    const n = doc.nodes[o.node];
    if (o.kind === 'insert') {
      if (doc.nodes[o.node]) continue;
      doc.nodes[o.node] = { ...o.data, id: o.node, children: [] };
      const p = doc.nodes[o.parent] || doc.nodes[ROOT];
      if (p) p.children.splice(Math.min(o.ord | 0, p.children.length), 0, o.node);
    } else if (o.kind === 'update') {
      if (n) { for (const k in o.patch) n[k] = o.patch[k]; if (o.unset) for (const k of o.unset) delete n[k]; }
    } else if (o.kind === 'move') {
      if (n && doc.nodes[o.parent] && !isAncestor(o.node, o.parent)) {
        detach(o.node); const p = doc.nodes[o.parent]; p.children.splice(Math.min(o.ord | 0, p.children.length), 0, o.node);
      }
    } else if (o.kind === 'delete') {
      if (n) { const ids = subtreeOf(o.node), nodes = {}; for (const x of ids) nodes[x] = doc.nodes[x];
        if (!doc.trash) doc.trash = []; const par = parentOf(o.node);
        doc.trash.unshift({ ts: o.ts != null ? o.ts : Date.now(), parent: par, index: par ? kidsOf(par).indexOf(o.node) : 0, root: o.node, nodes });
        detach(o.node); for (const x of ids) delete doc.nodes[x]; }
    } else if (o.kind === 'untrash') {
      if (doc.trash && o.ts != null) { const i = doc.trash.findIndex(t => t.ts === o.ts); if (i >= 0) doc.trash.splice(i, 1); }
    }
  }
  rebuildParentMap();
}
window.__applyRemoteOps = applyRemoteOps;  // for the convergence e2e test

// Route B: derive the structured ops for ONE operation straight from the undo journal's
// touched-set (O(change)). There is no baseline doc to diff against, so nothing can drift
// — the journal already knows exactly which nodes changed and their prior state.
function opsFromJournal(txn) {
  const ops = [];
  const mk = (kind, node, extra) => ops.push({ id: `${DEVICE_ID}-${opSeq++}`, hlc: hlcClock.tick(), kind, node, ...extra });

  // prior parent/ord, reconstructed from the old children arrays of touched nodes
  const oldParent = new Map(), oldOrd = new Map();
  for (const [pid, old] of txn.nodes) if (old) (old.children || []).forEach((c, i) => { oldParent.set(c, pid); oldOrd.set(c, i); });

  const handled = new Set();
  // inserts in tree order (parents before children), then moves/reorders — walk the NEW
  // children of every touched node, breadth-first from the touched roots
  const queue = [...txn.nodes.keys()];
  while (queue.length) {
    const pid = queue.shift();
    const pn = doc.nodes[pid];
    if (!pn) continue;
    (pn.children || []).forEach((c, ord) => {
      if (handled.has(c)) return;
      const isNew = txn.nodes.has(c) && txn.nodes.get(c) === null;
      if (isNew) { handled.add(c); const { children, ...data } = doc.nodes[c]; mk('insert', c, { parent: pid, ord, data }); queue.push(c); }
      else {
        handled.add(c);
        const op_ = oldParent.has(c) ? oldParent.get(c) : pid;     // parent unchanged if it never left a touched parent
        const oo = oldOrd.has(c) ? oldOrd.get(c) : ord;
        if (op_ !== pid || oo !== ord) mk('move', c, { parent: pid, ord });
      }
    });
  }
  // deletes: was a child of a touched node, now gone from the doc (carry the trash ts)
  for (const [c] of oldParent) if (!doc.nodes[c] && !handled.has(c)) {
    handled.add(c);
    const ts = (doc.trash || []).find(t => t.root === c)?.ts;
    mk('delete', c, ts != null ? { ts } : {});
  }
  for (const [id, old] of txn.nodes) if (old && !doc.nodes[id] && !handled.has(id)) { handled.add(id); mk('delete', id, {}); }
  // field updates for surviving touched nodes (incl. the root's own fields). `unset`
  // distinguishes a removed key (delete n.format) from a key set to null (note = null).
  for (const [id, old] of txn.nodes) {
    if (!old || !doc.nodes[id]) continue;
    const nn = doc.nodes[id], patch = {}, unset = [];
    for (const k of new Set([...Object.keys(old), ...Object.keys(nn)])) {
      if (OP_SKIP.has(k)) continue;
      if (!deepEq(old[k], nn[k])) { if (nn[k] === undefined) unset.push(k); else patch[k] = nn[k]; }
    }
    if (Object.keys(patch).length || unset.length) mk('update', id, unset.length ? { patch, unset } : { patch });
  }
  // untrash: a trash entry that disappeared this op (restore-cleanup / purge)
  if (txn.trash !== ABSENT) { const live = new Set((doc.trash || []).map(t => t.ts)); for (const t of txn.trash) if (!live.has(t.ts)) mk('untrash', t.root, { ts: t.ts }); }
  return ops;
}
window.__opsFromJournal = () => undoTxn ? opsFromJournal(undoTxn) : []; // for the emission oracle

// queue an operation's sync ops (Route B). No baseline is consulted — the ops come
// straight from the journal, so the send path cannot drift.
function queueOps(txn) {
  if (!settings.opSync || SHARE_TOKEN) return;
  const ops = opsFromJournal(txn);
  if (ops.length) pendingOps.push(...ops);
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { flushBeforeHide(); return; } // backgrounded → persist NOW
  if (document.visibilityState !== 'visible' || !doc) return;
  if (!SHARE_TOKEN && (!sse || sse.readyState === 2)) openSSE(); // revive the stream after sleep
  if (dirty) return;
  try {
    if (SHARE_TOKEN) {
      const full = await (await fetch(SAVE_URL)).json();
      if (!dirty && full.version > state.version) adoptRemote(full.version, full.doc);
      return;
    }
    const v = await (await fetch(apiBase + '/version')).json();
    if (v.version > state.version) {
      const full = await (await fetch(apiBase + '/doc')).json();
      if (!dirty) adoptRemote(full.version, full.doc);
    }
  } catch { /* offline */ }
});

// Flush a pending edit + save when the page is backgrounded or torn down. On mobile,
// switching apps or locking the screen FREEZES timers, so the 450 ms commit-debounce and
// 600 ms save-debounce may never fire — characters typed just before the switch stay only
// in the contenteditable DOM and are lost, so the node syncs a truncated PREFIX (e.g. a
// bullet becomes "History einer Sei…"). beforeunload is unreliable on mobile; pagehide and
// visibilitychange:hidden fire dependably, so we commit the live DOM text and beacon the doc.
function flushBeforeHide() {
  if (!doc || state.readOnly) return;
  commitActiveText(); // pull the live contenteditable text into node.text before we serialize
  if (!dirty) return;
  // stash first: if the beacon loses a version race the server rejects it,
  // and the next load merges the stash via graftMissing instead
  stashOffline();
  navigator.sendBeacon?.(SAVE_URL, new Blob(
    [JSON.stringify({ baseVersion: state.version, doc })],
    { type: 'application/json' }
  ));
}
window.addEventListener('pagehide', flushBeforeHide);
window.addEventListener('beforeunload', flushBeforeHide);

let sse = null;
// (re)open the live event stream; called on connect and again after the tab wakes / the
// network returns, so a laptop opened after sleep resumes live sync without a manual refresh
function openSSE() {
  try {
    if (sse) { try { sse.close(); } catch { /* already closed */ } }
    sse = new EventSource(apiBase + '/events');
    sse.onmessage = async e => {
      try {
        const data = JSON.parse(e.data);
        // our own op echo: we already applied these locally — just track the version,
        // never re-apply (this closes the POST-response vs SSE-broadcast race)
        if (data.origin && data.origin === DEVICE_ID) { if (data.version > state.version) state.version = data.version; return; }
        if (data.version <= state.version || dirty) return;
        if (data.ops && data.version === state.version + 1) {
          // contiguous authoritative op batch → replay locally (no whole-doc refetch)
          applyRemoteOps(data.ops);
          state.version = data.version;
          renderPage();
        } else {
          const full = await (await fetch(apiBase + '/doc')).json();
          if (!dirty && full.version > state.version) adoptRemote(full.version, full.doc);
        }
      } catch { /* ignore */ }
    };
  } catch { sse = null; /* SSE unsupported */ }
}

function connectSSE() {
  if (SHARE_TOKEN) {
    // shares poll instead (no cookie auth)
    setInterval(async () => {
      if (dirty || document.visibilityState !== 'visible') return;
      try {
        const full = await (await fetch(SAVE_URL)).json();
        if (!dirty && full.version > state.version) adoptRemote(full.version, full.doc);
      } catch { /* offline */ }
    }, 20000);
    return;
  }
  openSSE();
  // the network returning is a strong wake signal — reopen the stream if it died while offline
  window.addEventListener('online', () => { if (!sse || sse.readyState === 2) openSSE(); });
}

/* ---------------- 9. text commit ---------------- */

let pendingCommit = null;

const commitDebounced = debounce(() => commitActiveText(true), 450);

function scheduleCommit(el) {
  const ctx = editableCtx(el);
  if (!ctx) return;
  if (pendingCommit && pendingCommit.el !== el) commitPending();
  pendingCommit = { el, ctx };
  commitDebounced();
}

function commitPending(redecorateOk = false) {
  if (!pendingCommit) return;
  const { el, ctx } = pendingCommit;
  pendingCommit = null;
  commitDebounced.cancel();
  if (!doc.nodes[ctx.id]) return;
  // editing a mirror row edits the CONTENT OWNER (Workflowy equivalence): text and note
  // commits route to the target; the mirror node itself never holds content
  const node = N(contentIdOf(ctx.id));
  if (ctx.field === 'note' || ctx.field === 'zoom-note') {
    const v = (el.innerText || '').replace(/ /g, ' ').replace(/\n$/, '');
    if (node.note !== v) { recOld(node.id); node.note = v; touch(node.id); markDirty(); }
  } else {
    let html = serializeEl(el);
    if (settings.capitalize && (ctx.field === 'text' || ctx.field === 'title')) html = applyCapitalize(html);
    if (node.text !== html) {
      recOld(node.id);
      node.text = html;
      touch(node.id);
      markDirty();
      if (ctx.field === 'title') updateDocTitle();
      syncMirrorRows(node.id);
    }
    if (redecorateOk && document.activeElement === el && !composing && !window.caretPopOpen?.()) {
      // the line is focused → keep block refs as their raw ((id)) source while editing
      const display = ctx.field === 'text'
        ? decorate(node.text, { plain: node.format === 'codeblock', editing: true })
        : displayHtml(node);
      if (display !== el.innerHTML) {
        const off = caretOffsetIn(el);
        const selLen = getSelection().rangeCount ? getSelection().toString().length : 0;
        el.innerHTML = display;
        if (off !== null) selectPlainRange(el, off, off + selLen);
      }
    }
  }
}

function commitActiveText(redecorateOk = false) {
  if (pendingCommit) { commitPending(redecorateOk); return; }
  const ctx = editableCtx(document.activeElement);
  if (ctx) { pendingCommit = { el: ctx.el, ctx }; commitPending(redecorateOk); }
}

// refresh every other DOM instance of a node's row after its text changed: mirror rows
// (data-mirror) AND transcluded/duplicate copies of the node itself (same data-id can
// render in several places once mirrors transclude their subtree)
function syncMirrorRows(targetId) {
  const html = displayHtml(N(targetId));
  const sel = `.item[data-mirror="${targetId}"] > .row .content, .item[data-id="${targetId}"] > .row .content`;
  for (const el of treeEl.querySelectorAll(sel)) {
    if (el === document.activeElement) continue; // never clobber the caret being typed in
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

/* ---------------- 10. search (operator engine) ---------------- */

const searchActive = () => state.search.trim().length > 0;

function parseQuery(q) {
  const rawTokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1] !== undefined) rawTokens.push({ text: m[1], quoted: true });
    else rawTokens.push({ text: m[2], quoted: false });
  }
  const segments = [[]];
  let pendingOr = false;
  const pushCond = cond => {
    const seg = segments[segments.length - 1];
    if (pendingOr && seg.length) {
      seg[seg.length - 1].or.push(cond);
      pendingOr = false;
    } else {
      seg.push({ or: [cond] });
    }
  };
  for (const tok of rawTokens) {
    if (!tok.quoted && tok.text === '>') { segments.push([]); pendingOr = false; continue; }
    if (!tok.quoted && tok.text === 'OR') { pendingOr = true; continue; }
    let text = tok.text;
    let neg = false;
    if (!tok.quoted && (text.startsWith('-') || text.startsWith('–')) && text.length > 1) {
      neg = true;
      text = text.slice(1);
    }
    let cond = null;
    if (!tok.quoted) {
      // longest operator names first so e.g. `date-before:` wins over `date:`
      const op = text.match(/^(is|has|text|highlight|changed|created|in|on|link|date-before|date-after|day-of-week|date):(.*)$/i);
      // 'text:' gets its own kind so it can't collide with plain search terms
      if (op) cond = { neg, kind: op[1].toLowerCase() === 'text' ? 'textfmt' : op[1].toLowerCase(), value: op[2].toLowerCase() };
    }
    if (!cond) cond = { neg, kind: 'text', value: text.toLowerCase() };
    if (cond.value !== '' || cond.kind !== 'text') pushCond(cond);
  }
  return { segments: segments.map(s => s.filter(c => c.or.length)), raw: q };
}

// every ISO date an item references: <time> pills (both ends of a range) plus
// rhizome day-page links (a date is a link now, so date search must see it too)
function pillDates(html) {
  const out = [];
  for (const m of (html || '').matchAll(/datetime="(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?/g)) {
    out.push(m[1]);
    if (m[2]) out.push(m[2]);
  }
  for (const m of (html || '').matchAll(/#\/n\/([A-Za-z0-9]+)/g)) {
    const t = doc.nodes[m[1]];
    if (t && t.cal === 'day' && t.cd) out.push(t.cd);
  }
  return out;
}

// resolve a date-filter value (ISO, natural-language, or a named span) to an
// inclusive {from, to} ISO range; null if it can't be parsed
function resolveDateRange(value) {
  const raw = (value || '').trim().toLowerCase();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { from: raw, to: raw };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const span = (a, b) => ({ from: isoOf(a), to: isoOf(b) });
  const shift = days => { const d = new Date(today); d.setDate(d.getDate() + days); return d; };
  const weekStart = settings.weekStart === 'sun' ? 0 : 1;
  const weekOf = base => {
    const s = new Date(base); s.setDate(s.getDate() - ((s.getDay() - weekStart + 7) % 7));
    const e = new Date(s); e.setDate(s.getDate() + 6);
    return span(s, e);
  };
  const monthOf = (y, m) => span(new Date(y, m, 1), new Date(y, m + 1, 0));
  switch (raw.replace(/[-_]/g, ' ')) {
    case 'today': return span(today, today);
    case 'tomorrow': return span(shift(1), shift(1));
    case 'yesterday': return span(shift(-1), shift(-1));
    case 'this week': return weekOf(today);
    case 'next week': return weekOf(shift(7));
    case 'last week': return weekOf(shift(-7));
    case 'this month': return monthOf(today.getFullYear(), today.getMonth());
    case 'next month': return monthOf(today.getFullYear(), today.getMonth() + 1);
    case 'last month': return monthOf(today.getFullYear(), today.getMonth() - 1);
  }
  const hit = nlDate(raw); // "next friday", "oct 7", "jun 12 - jun 15", …
  return hit ? { from: hit.iso, to: hit.iso2 || hit.iso } : null;
}

function nodeMeetsCond(n, cond, hay, html) {
  let hit = false;
  switch (cond.kind) {
    case 'text':
      hit = hay.includes(cond.value);
      break;
    case 'is':
      if (cond.value === 'complete' || cond.value === 'completed' || cond.value === 'done') hit = !!n.done;
      else if (cond.value === 'incomplete') hit = !n.done;
      else if (cond.value === 'todo') hit = n.format === 'todo';
      else if (cond.value === 'mirror') hit = !!n.mirror;
      else if (cond.value === 'heading') hit = /^h[123]$/.test(n.format || '');
      else if (cond.value === 'shared') hit = state.shares.some(s => s.id === n.id);
      break;
    case 'has':
      if (cond.value === 'note') hit = !!(n.note && n.note.trim());
      else if (cond.value === 'date') hit = pillDates(html).length > 0; // rhizome: pills + day-links
      else if (cond.value === 'file' || cond.value === 'image') hit = !!(n.files && n.files.length);
      else if (cond.value === 'comment') hit = !!(n.comments && n.comments.length);
      else if (cond.value === 'link') hit = html.includes('<a ');
      else if (cond.value === 'tag') hit = /[#@][\w]/.test(plainOf(n.text));
      break;
    case 'highlight':
      hit = cond.value === 'any' || cond.value === ''
        ? /class="[^"]*hl-/.test(html)
        : html.includes(`hl-${cond.value}`);
      break;
    case 'changed':
    case 'created': {
      const ts = cond.kind === 'created' ? (n.c || n.m || 0) : (n.m || 0);
      const now = Date.now();
      let ms = null;
      if (cond.value === 'today') ms = now - new Date(new Date().setHours(0, 0, 0, 0)).getTime();
      else {
        const dm = cond.value.match(/^(\d+)([dhwm])$/);
        if (dm) ms = parseInt(dm[1], 10) *
          (dm[2] === 'h' ? 3600e3 : dm[2] === 'w' ? 604800e3 : dm[2] === 'm' ? 2592000e3 : 86400e3);
      }
      hit = ms !== null && now - ts <= ms;
      break;
    }
    case 'date': {
      const r = resolveDateRange(cond.value);
      hit = !!r && pillDates(html).some(p => p >= r.from && p <= r.to);
      break;
    }
    case 'date-before': {
      const r = resolveDateRange(cond.value);
      hit = !!r && pillDates(html).some(p => p < r.from);
      break;
    }
    case 'date-after': {
      const r = resolveDateRange(cond.value);
      hit = !!r && pillDates(html).some(p => p > r.to);
      break;
    }
    case 'day-of-week': {
      const wd = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }[cond.value];
      hit = wd != null && pillDates(html).some(p => {
        const [y, m, d] = p.split('-').map(Number);
        return new Date(y, m - 1, d).getDay() === wd;
      });
      break;
    }
    case 'in':
      hit = (n.note || '').toLowerCase().includes(cond.value.replace(/^note:/, ''));
      break;
    case 'on':
      hit = pillDates(html).includes(cond.value); // rhizome: matches pills and day-links
      break;
    case 'link': {
      // match by URL/href even when the link's display text was changed
      const hrefs = [...html.matchAll(/href="([^"]*)"/gi)].map(x => x[1].toLowerCase());
      hit = cond.value ? hrefs.some(h => h.includes(cond.value)) : hrefs.length > 0;
      break;
    }
  }
  return cond.neg ? !hit : hit;
}

// 'text:' operator handled separately since it inspects formatting
function nodeMeetsTextFormat(n, cond, html) {
  const map = { bold: '<b>', italic: '<i>', underline: '<u>', strike: '<s>', code: '<code>', color: 'tc-' };
  const needle = map[cond.value] || null;
  const hit = needle ? html.includes(needle) : false;
  return cond.neg ? !hit : hit;
}

function nodeMatchesSegment(id, seg) {
  const n = N(contentIdOf(id)); // a mirror matches when its target's content matches
  const html = (n.text || '') + ' ' + (n.note || '');
  const hay = (plainOf(n.text) + ' ' + (n.note || '')).toLowerCase();
  for (const clause of seg) {
    const ok = clause.or.some(cond =>
      cond.kind === 'textfmt'
        ? nodeMeetsTextFormat(n, cond, html)
        : nodeMeetsCond(n, cond, hay, html));
    if (!ok) return false;
  }
  return true;
}

// Build an FTS query for a segment: the plain positive (non-negated, single-term) text
// conditions, space-joined. The /api/search endpoint prefix-wraps and ANDs them, yielding a
// candidate superset the full predicate below then filters exactly. Returns '' when nothing
// can bound the set (pure is:/has:/date:, OR-of-text, negation-only) → caller does a full walk.
function ftsQueryForSegment(seg) {
  const words = [];
  for (const group of seg) {
    if (group.or.length !== 1) continue;           // an OR alternative can't bound the candidates
    const c = group.or[0];
    if (c.kind === 'text' && !c.neg && c.value) words.push(c.value);
  }
  return words.join(' ');
}

// the ancestor-chain (`a > b > c`) constraint — shared by the full walk and the FTS path
function passesAncestorChain(id, ancestorSegs) {
  if (!ancestorSegs.length) return true;
  const chain = ancestorsOf(id).filter(a => a !== ROOT); // top-down
  let ci = 0;
  for (const segA of ancestorSegs) {
    let found = false;
    while (ci < chain.length) { if (nodeMatchesSegment(chain[ci], segA)) { found = true; ci++; break; } ci++; }
    if (!found) return false;
  }
  return true;
}

let treeFtsThreshold = 4000;   // above this the in-tree search bar uses the SQLite FTS index
let searchSeq = 0;             // guards against a stale FTS response clobbering a newer query

function computeSearch() {
  if (!searchActive()) { state.matchSet = null; state.openSet = null; state.matchCount = 0; state.query = null; state.ftsCandidates = null; return; }
  state.query = parseQuery(state.search);
  const segs = state.query.segments.filter(s => s.length);
  if (!segs.length) { state.matchSet = null; state.openSet = null; state.matchCount = 0; state.query = null; return; }
  const lastSeg = segs[segs.length - 1];
  const ancestorSegs = segs.slice(0, -1);

  // Large docs: let SQLite FTS5 produce the candidate set (O(matches)) instead of walking
  // every node on every render. The full operator predicate still runs over those candidates,
  // so is:/has:/date:/negation/ancestor-chains all keep working; only plain-text matching
  // takes FTS token-prefix semantics (same trade the quick-jump already makes above its
  // threshold). Shares and offline keep the exact client-side walk.
  const ftsQ = (!SHARE_TOKEN && Object.keys(doc.nodes).length > treeFtsThreshold) ? ftsQueryForSegment(lastSeg) : '';
  let candidates = null;        // null → walk the whole zoom subtree
  if (ftsQ) {
    const cache = state.ftsCandidates;
    if (!cache || cache.q !== ftsQ) {
      // fetch once per distinct FTS query; re-render when it lands. The current matchSet stays
      // on screen meanwhile — with the 160ms debounce and a local query that's a few ms.
      const seq = ++searchSeq;
      state.ftsCandidates = { q: ftsQ, ids: null, ok: false, pending: true };
      fetch(apiBase + '/search?q=' + encodeURIComponent(ftsQ))
        .then(r => r.json())
        .then(({ ids }) => { if (seq === searchSeq) { state.ftsCandidates = { q: ftsQ, ids: ids || [], ok: true, pending: false }; renderPage(); } })
        .catch(() => { if (seq === searchSeq) { state.ftsCandidates = { q: ftsQ, ids: null, ok: false, pending: false }; renderPage(); } });
      return;                                    // keep prior results until candidates arrive
    }
    if (cache.pending) return;                   // in flight → leave the prior results up
    if (cache.ok) candidates = cache.ids;        // got them → evaluate over candidates
    // cache.ok === false (offline / error) → candidates stays null → full-walk fallback
    // mirror instances of a matching node match too (FTS only indexes the real node)
    if (candidates && mirrorInstances.size) {
      const extra = [];
      for (const c of candidates) { const ms = mirrorInstances.get(c); if (ms) extra.push(...ms); }
      if (extra.length) candidates = candidates.concat(extra);
    }
  }

  // rhizome: search spans the whole outline (Roam-style), rendered grouped by
  // page in the results view — not scoped to the current zoom
  const scope = HOME;
  const matches = new Set();
  const open = new Set();
  const consider = id => {
    if (id === ROOT || id === scope) return;
    if (nodeMatchesSegment(id, lastSeg) && passesAncestorChain(id, ancestorSegs)) matches.add(id);
  };
  if (candidates) {
    for (const id of candidates) if (N(id) && (scope === ROOT || isAncestor(scope, id))) consider(id);
  } else {
    const visit = id => { consider(id); for (const c of N(id).children) visit(c); };
    visit(scope);
  }
  for (const id of matches) {
    let p = parentOf(id);
    while (p && p !== scope && !open.has(p)) { open.add(p); p = parentOf(p); }
  }
  state.matchSet = matches;
  state.openSet = open;
  state.matchCount = matches.size;
}

function setSearch(q, { fromInput = false, append = false } = {}) {
  if (append && state.search.trim()) q = state.search.trim() + ' ' + q;
  state.search = q;
  if (!fromInput) searchEl.value = q;
  searchBoxEl.classList.toggle('has-query', q.length > 0);
  renderPage();   // → computeSearch(): for large docs this fetches FTS candidates, then re-renders
}

// rhizome: a #tag / @mention is a page (Roam-style) — clicking opens that page,
// whose Linked References gather every block that tags it
function openTag(tag) {
  const name = tag.replace(/^[#@]/, '').trim();
  if (!name || SHARE_TOKEN) return;
  commitActiveText();
  snapshot();
  const page = window.getOrCreatePage(name);
  markDirty();
  zoomTo(page);
}

const searchDebounced = debounce(q => setSearch(q, { fromInput: true }), 160);

/* ---------------- 11. rendering ---------------- */

function updateDocTitle() {
  document.title = state.zoom === HOME && !SHARE_TOKEN
    ? (state.view === 'pages' ? 'All Pages — Rhizome' : state.view === 'daily' ? 'Daily Notes — Rhizome' : 'Outline — Rhizome')
    : (plainOf(N(state.zoom).text).trim() || 'Untitled') + ' — Rhizome';
}

function crumbLabel(id) {
  const t = plainOf(N(id).text).trim();
  return t || 'Untitled';
}

function renderCrumbs() {
  crumbsEl.innerHTML = '';
  if (state.zoom === HOME) { crumbsEl.style.display = 'none'; return; }
  let chain = ancestorsOf(state.zoom).filter(id => id === HOME || isAncestor(HOME, id));
  if (!chain.includes(HOME)) chain.unshift(HOME);
  // rhizome: crumbs start at the containing page, not at a "Home" root, and the
  // calendar containers stay invisible — a day page is a normal page
  if (!SHARE_TOKEN) chain = chain.filter(id => id !== HOME && !['root', 'year', 'month'].includes(N(id)?.cal));
  if (!chain.length) { crumbsEl.style.display = 'none'; return; }
  crumbsEl.style.display = '';
  chain.forEach((id, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      crumbsEl.append(sep);
    }
    const a = document.createElement('a');
    a.href = id === HOME ? '#/' : '#/n/' + id;
    a.textContent = id === HOME ? (SHARE_TOKEN ? crumbLabel(HOME) : 'Home') : crumbLabel(id);
    crumbsEl.append(a);
  });
}

function renderZoomHead() {
  const showHead = state.zoom !== HOME || (SHARE_TOKEN && state.zoom === HOME);
  if (!showHead) { zoomHeadEl.style.display = 'none'; return; }
  zoomHeadEl.style.display = '';
  const n = N(state.zoom);
  const editable = !state.readOnly;
  zoomTitleEl.contentEditable = editable ? 'true' : 'false';
  zoomTitleEl.spellcheck = false;
  zoomTitleEl.dataset.ph = 'Untitled';
  zoomTitleEl.classList.toggle('done', !!n.done);
  zoomTitleEl.innerHTML = decorate(n.text);
  if (n.note !== null && n.note !== undefined) {
    zoomNoteEl.hidden = false;
    zoomNoteEl.contentEditable = editable ? 'true' : 'false';
    zoomNoteEl.spellcheck = false;
    zoomNoteEl.dataset.ph = 'Add a note…';
    zoomNoteEl.textContent = n.note;
  } else {
    zoomNoteEl.hidden = true;
    zoomNoteEl.textContent = '';
  }
}

const CHEVRON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.5 7 5 2.5 8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5.2 4 7.6 8.5 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function isExpandedInView(id) {
  const p = parentOf(id);
  if (p && N(p) && N(p).format === 'board') return true;
  if (searchActive() && state.openSet && state.openSet.has(id)) return true;
  return !N(id).collapsed;
}

function shouldShow(id, underMatch) {
  if (!searchActive() || !state.matchSet) return true;
  return underMatch || state.matchSet.has(id) || state.openSet.has(id);
}

function buildAttachments(n) {
  if (!n.files || !n.files.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'attachments';
  for (const f of n.files) {
    const url = fileHref(f.url); // null for javascript: and other unsafe schemes
    if ((f.type || '').startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'att-img';
      img.src = url || '';
      img.alt = f.name;
      img.loading = 'lazy';
      img.addEventListener('click', () => { if (url) window.open(url, '_blank', 'noopener'); });
      wrap.append(img);
      if (!state.readOnly) {
        const rm = document.createElement('button');
        rm.className = 'att-remove';
        rm.title = 'Remove attachment';
        rm.textContent = '×';
        rm.addEventListener('click', () => removeAttachment(n.id, f.url));
        wrap.append(rm);
      }
    } else {
      const chip = document.createElement('a');
      chip.className = 'att-chip';
      chip.href = url || '#';
      chip.target = '_blank';
      chip.rel = 'noopener';
      chip.innerHTML = `<span>📎</span><span class="att-name">${escHtml(f.name || 'file')}</span>`;
      if (!state.readOnly) {
        const rm = document.createElement('button');
        rm.className = 'att-remove';
        rm.title = 'Remove attachment';
        rm.textContent = '×';
        rm.addEventListener('click', e => { e.preventDefault(); removeAttachment(n.id, f.url); });
        chip.append(rm);
      }
      wrap.append(chip);
    }
  }
  return wrap;
}

function removeAttachment(id, url) {
  snapshot();
  const n = N(id);
  recOld(id);
  n.files = (n.files || []).filter(f => f.url !== url);
  if (!n.files.length) delete n.files;
  touch(id);
  renderPage();
  markDirty();
}

function buildEmbed(n) {
  if (!settings.embeds) return null;
  const text = n.text || '';
  const div = document.createElement('div');
  div.className = 'embed';
  let yt = text.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
  if (yt) {
    div.classList.toggle('embed-short', text.includes('/shorts/'));
    div.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" loading="lazy" allowfullscreen title="YouTube embed"></iframe>`;
    return div;
  }
  let loom = text.match(/loom\.com\/share\/([\w-]+)/);
  if (loom) {
    div.innerHTML = `<iframe src="https://www.loom.com/embed/${loom[1]}" loading="lazy" allowfullscreen title="Loom embed"></iframe>`;
    return div;
  }
  // tweets/X: a privacy-respecting link card (no Twitter tracking script)
  let tw = text.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
  if (tw) {
    div.classList.add('embed-tweet');
    div.innerHTML = `<a href="https://x.com/${tw[1]}/status/${tw[2]}" target="_blank" rel="noopener">
      <span class="tw-bird">𝕏</span><span class="tw-meta"><b>@${escHtml(tw[1])}</b><span>View post on X →</span></span></a>`;
    return div;
  }
  return null;
}

// targets currently being transcluded up the render stack — a mirror sitting inside its
// own target's subtree (or two mirrors of each other's ancestors) must not recurse forever
const transcludeStack = [];

function mountItem(id, underMatch = false) {
  const n = N(id);
  const mirror = isMirror(id);
  // a live mirror is a full instance of its target: the cycle guard falls back to the
  // old one-line pointer when this target is already being transcluded above us
  let target = mirror ? mirrorTarget(id) : null;
  const looped = !!target && transcludeStack.includes(target);
  if (looped) target = null;
  const cn = target ? N(target) : n;             // the node that owns the displayed content
  const cfmt = target ? (cn.format || 'bullet') : fmtOf(id);
  const expanded = isExpandedInView(id);

  const item = document.createElement('div');
  item.className = 'item fmt-' + cfmt;
  item.dataset.id = id;
  if (mirror) {
    item.classList.add('is-mirror');
    if (target) item.dataset.mirror = target;
    else item.classList.add('broken');
    if (looped) item.classList.add('looped');
  }
  if (!mirror && mirrorCounts.has(id)) item.classList.add('mirrored'); // original of ≥1 mirror → diamond too
  if (cn.done) item.classList.add('done');
  if (kidsOf(cn.id).length) item.classList.add('has-children');
  if (!expanded) item.classList.add('collapsed');
  if (state.shares.some(s => s.id === id)) item.classList.add('shared-ring');
  // transcluded copies must not steal the id→element mapping from the node's real location
  if (!transcludeStack.length) elById.set(id, item);
  else if (!elById.has(id)) elById.set(id, item);

  const row = document.createElement('div');
  row.className = 'row';

  const gutter = document.createElement('div');
  gutter.className = 'gutter';
  const menuBtn = document.createElement('button');
  menuBtn.className = 'itemmenu-btn';
  menuBtn.title = 'Item menu';
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.tabIndex = -1;
  menuBtn.textContent = '⋯';
  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.title = 'Expand / collapse';
  toggle.tabIndex = -1;
  toggle.innerHTML = CHEVRON;
  gutter.append(menuBtn, toggle);
  row.append(gutter);

  if (cfmt === 'todo') {
    const box = document.createElement('button');
    box.className = 'todo-box';
    box.title = 'Complete (Ctrl+Enter)';
    box.tabIndex = -1;
    box.innerHTML = CHECK;
    row.append(box);
  } else if (cfmt === 'number') {
    const bullet = document.createElement('a');
    bullet.className = 'bullet num-bullet';
    bullet.title = 'Zoom in';
    bullet.innerHTML = `<span class="num">${numberFor(id)}.</span><span class="dot"></span>`;
    row.append(bullet);
  } else {
    const bullet = document.createElement('a');
    bullet.className = 'bullet';
    bullet.title = mirror ? 'Open original' : 'Zoom in';
    bullet.innerHTML = '<span class="dot"></span>';
    row.append(bullet);
  }

  const content = document.createElement('div');
  content.className = 'content';
  // a live mirror row is fully editable — commits route to the target (commitPending)
  const editable = !state.readOnly && cfmt !== 'divider' && (!mirror || !!target);
  content.contentEditable = editable ? 'true' : 'false';
  content.spellcheck = false;
  if (mirror && !target) {
    content.innerHTML = looped ? '↻ (mirror loop)' : '(original was deleted)';
    if (looped) content.title = 'This mirror sits inside the subtree it mirrors — rendering stops here to avoid an infinite loop';
  } else if (cfmt !== 'divider') {
    content.innerHTML = displayHtml(cn);
  }
  row.append(content);

  if (cn.comments && cn.comments.length) {
    const chip = document.createElement('button');
    chip.className = 'comment-chip';
    chip.title = 'Comments';
    chip.innerHTML = `💬 ${cn.comments.length}`;
    row.append(chip);
  }

  item.append(row);

  if (cn.note !== null && cn.note !== undefined) {
    item.append(buildNoteEl(cn.note));
  }
  const atts = buildAttachments(cn); // attachments are content — shown at every instance (handlers close over cn.id)
  if (atts) item.append(atts);
  const embed = buildEmbed(cn);
  if (embed) item.append(embed);
  const qr = window.buildQueryResults?.(cn); // live {{query:…}} result list
  if (qr) item.append(qr);

  const um = underMatch || (searchActive() && state.matchSet?.has(id));

  // children: a live mirror transcludes its target's subtree (real nodes, fully
  // interactive — they exist once in the data, several times in the DOM)
  if (target) transcludeStack.push(target);
  const kidsRoot = target || id;
  if (cfmt === 'board') {
    if (expanded) item.append(buildBoardEl(kidsRoot, false)); // collapsing the board node hides its columns
  } else if (expanded && kidsOf(kidsRoot).length) {
    const wrap = buildChildrenWrap(kidsRoot, um);
    if (wrap) item.append(wrap);
  }
  if (target) transcludeStack.pop();
  return item;
}

function buildNoteEl(noteText) {
  const note = document.createElement('div');
  note.className = 'note';
  note.contentEditable = state.readOnly ? 'false' : 'true';
  note.spellcheck = false;
  note.dataset.ph = 'Add a note…';
  note.textContent = noteText;
  return note;
}

function buildBoardEl(boardId, zoomed) {
  const board = document.createElement('div');
  board.className = 'board' + (zoomed ? ' board-zoomed' : '');
  for (const col of kidsOf(boardId).filter(c => shouldShow(c, true))) {
    const collapsed = !!N(col).collapsed && !searchActive();
    const colEl = document.createElement('div');
    colEl.className = 'board-col' + (collapsed ? ' collapsed' : '');
    if (!searchActive()) {
      const tog = document.createElement('button');
      tog.className = 'col-toggle';
      tog.dataset.colToggle = col;
      tog.title = collapsed ? 'Expand column' : 'Collapse column';
      tog.tabIndex = -1;
      tog.innerHTML = CHEVRON;
      colEl.append(tog);
    }
    if (collapsed) {
      const bar = document.createElement('button');
      bar.className = 'col-collapsed';
      bar.dataset.colToggle = col;
      const cards = kidsOf(contentIdOf(col)).length;
      bar.innerHTML = `<span class="cc-title">${escHtml(plainOf(N(contentIdOf(col)).text).trim() || 'Untitled')}</span>`
        + `<span class="cc-count">${cards} card${cards === 1 ? '' : 's'}</span>`
        + '<span class="cc-hint">Expand column</span>';
      colEl.append(bar);
    } else {
      colEl.append(mountItem(col, true));
      if (!state.readOnly && !searchActive()) {
        const add = document.createElement('button');
        add.className = 'board-add';
        add.dataset.addCard = col;
        add.textContent = '+ New card';
        colEl.append(add);
      }
    }
    board.append(colEl);
  }
  if (!state.readOnly && !searchActive()) {
    const addCol = document.createElement('button');
    addCol.className = 'board-add-col';
    addCol.dataset.addCol = boardId;
    addCol.title = 'Add column';
    addCol.textContent = '+';
    board.append(addCol);
  }
  return board;
}

function buildChildrenWrap(id, underMatch) {
  const visible = kidsOf(id).filter(c => shouldShow(c, underMatch));
  if (!visible.length) return null;
  const anim = document.createElement('div');
  anim.className = 'children-anim';
  const box = document.createElement('div');
  box.className = 'children';
  for (const c of visible) box.append(mountItem(c, underMatch));
  anim.append(box);
  return anim;
}

function renderPage() {
  closeAllPopovers();
  selClear(false);
  elById.clear();
  rebuildMirrorCounts();
  computeSearch();
  renderCrumbs();
  renderZoomHead();
  window.renderGeo?.();   // mini-map + reverse-geocoded title for location pages
  updateDocTitle();

  const scrollY = window.scrollY;
  treeEl.innerHTML = '';
  treeEl.classList.toggle('hide-done', !settings.showCompleted);
  pageEl.classList.toggle('board-page', N(state.zoom).format === 'board');
  // rhizome: day pages are normal pages — cal-page styling only wraps year/month navigation
  pageEl.classList.toggle('cal-page', ['year', 'month'].includes(N(state.zoom).cal));
  const roots = kidsOf(state.zoom).filter(c => shouldShow(c, false));
  const frag = document.createDocumentFragment();
  // rhizome: an active search renders whole-outline results grouped by page
  const specialView = searchActive() && window.renderSearchResults ? 'search'
    : window.pagesViewActive?.() ? 'pages' : window.dailyViewActive?.() ? 'daily' : null;
  if (specialView === 'search') {
    window.renderSearchResults(frag);
  } else if (specialView === 'pages') {
    window.renderPagesView(frag);
  } else if (specialView === 'daily') {
    window.renderDailyView(frag);
  } else if (N(state.zoom).format === 'board') {
    // a zoomed board stays a board: children render as full-page columns
    frag.append(buildBoardEl(state.zoom, true));
  } else {
    for (const c of roots) frag.append(mountItem(c, false));
  }
  treeEl.append(frag);

  if (searchActive()) {
    searchBannerEl.hidden = false;
    searchBannerEl.innerHTML =
      `<b>${state.matchCount}</b> match${state.matchCount === 1 ? '' : 'es'} for “${escHtml(state.search.trim())}” — Esc to clear`;
  } else {
    searchBannerEl.hidden = true;
  }

  const visibleRoots = roots.filter(id => settings.showCompleted || !N(id).done);
  if (specialView) {
    emptyHintEl.hidden = true;
  } else if (N(state.zoom).format === 'board') {
    emptyHintEl.hidden = true;
  } else if (!visibleRoots.length && !searchActive()) {
    emptyHintEl.hidden = false;
    emptyHintEl.textContent = kidsOf(state.zoom).length
      ? 'Everything here is complete.'
      : state.readOnly ? 'Nothing here.' : 'An empty page. Click here, or press Enter, to begin.';
  } else if (!roots.length && searchActive()) {
    emptyHintEl.hidden = false;
    emptyHintEl.textContent = 'Nothing matches.';
  } else {
    emptyHintEl.hidden = true;
  }

  window.scrollTo(0, scrollY);
  window.renderCalStrip?.();
  window.renderSidebar?.();
  window.renderBacklinks?.();
  window.updateStarBtn?.();
}

function refreshItemShell(id) {
  if (!doc.nodes[id]) return;
  const n = N(id);
  // every DOM instance: the node's own rows (possibly transcluded copies) + mirror rows of it
  for (const item of treeEl.querySelectorAll(`.item[data-id="${id}"], .item[data-mirror="${id}"]`)) {
    item.classList.toggle('done', !!n.done);
    item.classList.toggle('has-children', hasKids(id)); // a mirror row's kids ARE the target's
    if (item.dataset.id === id) item.classList.toggle('collapsed', !isExpandedInView(id));
  }
}

/* ---------------- 12. structural operations ---------------- */

function opNewAt(parent, index, text = '', focusOffset = 0) {
  if (state.readOnly) return null;
  parent = contentIdOf(parent); // new children of a mirror belong to the shared subtree
  commitActiveText();
  snapshot();
  const id = makeNode(text);
  insertAt(parent, index, id);
  renderPage();
  elById.get(id)?.classList.add('entering');
  focusItem(id, 'text', focusOffset);
  markDirty();
  return id;
}

function opSplit(ctx) {
  const { el, id } = ctx;
  const n = N(contentIdOf(id)); // splitting a mirror row splits the shared content
  const host = mirrorHostOf(el); // keep the caret in the same transcluded copy after render
  const sel = getSelection();
  if (!sel.rangeCount) return;
  commitActiveText();

  const offset = caretOffsetIn(el) ?? textLen(el);
  const len = textLen(el);

  if (offset === 0 && len > 0) {
    snapshot();
    const nid = makeNode('');
    if (ctx.field === 'title') insertAt(id, 0, nid);
    else insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id), nid);
    renderPage();
    elById.get(nid)?.classList.add('entering');
    focusItem(id, 'text', 0, host);
    markDirty();
    return;
  }

  const r = sel.getRangeAt(0);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(el);
  afterRange.setStart(r.endContainer, r.endOffset);
  const afterHtml = sanitizeHtml((() => {
    const tmp = document.createElement('div');
    tmp.append(afterRange.cloneContents());
    return tmp.innerHTML;
  })());
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(el);
  beforeRange.setEnd(r.startContainer, r.startOffset);
  const beforeHtml = sanitizeHtml((() => {
    const tmp = document.createElement('div');
    tmp.append(beforeRange.cloneContents());
    return tmp.innerHTML;
  })());

  snapshot();
  recOld(n.id);
  n.text = beforeHtml;
  touch(n.id);
  // a split item inherits to-do / numbered format so lists stay homogeneous
  const inherit = (n.format === 'todo' || n.format === 'number') ? { format: n.format } : {};
  const nid = makeNode(afterHtml, inherit);
  if (ctx.field === 'title') {
    insertAt(id, 0, nid);
  } else if (kidsOf(n.id).length && isExpandedInView(id)) {
    insertAt(n.id, 0, nid); // first child of the shared subtree → appears at every instance
  } else {
    insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id) + 1, nid);
  }
  renderPage();
  elById.get(nid)?.classList.add('entering');
  focusItem(nid, 'text', 0, host);
  markDirty();
}

function visiblePrevNextContent(el, dir) {
  const all = editables();
  const i = all.indexOf(el);
  if (i < 0) return null;
  const isContent = x => x.classList.contains('content') || x === zoomTitleEl;
  if (dir < 0) {
    for (let j = i - 1; j >= 0; j--) if (isContent(all[j])) return all[j];
  } else {
    for (let j = i + 1; j < all.length; j++) if (isContent(all[j])) return all[j];
  }
  return null;
}

// absorb `goneId` into `keepId`: append its text/note, reparent its children
// (preserving sibling order), delete it, and leave the caret at the join point
function mergeInto(keepId, goneId) {
  const keep = N(keepId), gone = N(goneId);
  snapshot();
  const joinAt = plainOf(keep.text).length;
  recOld(keepId); recOld(goneId); // keep absorbs text/note/children; gone is deleted
  keep.text = keep.text + gone.text;
  if (gone.note) keep.note = keep.note ? keep.note + '\n' + gone.note : gone.note;
  const kids = [...kidsOf(goneId)];
  if (parentOf(goneId) === keepId) {
    const arr = kidsOf(keepId);
    arr.splice(arr.indexOf(goneId), 1, ...kids); // replace gone in place with its children
    parentMap.delete(goneId);
    for (const k of kids) parentMap.set(k, keepId);
  } else {
    detach(goneId);
    for (const k of kids) { kidsOf(keepId).push(k); parentMap.set(k, keepId); }
  }
  N(goneId).children = [];
  delete doc.nodes[goneId];
  if (kids.length) keep.collapsed = false;
  touch(keepId);
  renderPage();
  focusItem(keepId, 'text', joinAt);
  markDirty();
}

function opMergeBack(ctx) {
  const { el, id } = ctx;
  if (isMirror(id)) return; // a mirror row holds no text of its own — merging would corrupt
  const n = N(id);
  commitActiveText();
  const prevEl = visiblePrevNextContent(el, -1);
  if (!prevEl) return;
  const prevCtx = editableCtx(prevEl);
  if (prevCtx && prevCtx.field !== 'title' && isMirror(prevCtx.id)) return;
  const isEmpty = !plainOf(n.text).length && !hasKids(id) && (n.note == null || n.note === '');

  // an empty item just disappears into the previous line (or the page title)
  if (isEmpty) {
    snapshot();
    deleteSubtree(id);
    renderPage();
    if (prevCtx.field === 'title') setCaretOffset(zoomTitleEl, 'end');
    else focusItem(prevCtx.id, 'text', 'end');
    markDirty();
    return;
  }
  if (prevCtx.field === 'title') return; // can't merge text up into the page title
  if (window.crossDayMerge?.(prevCtx.id, id)) return; // day sections never merge into each other
  mergeInto(prevCtx.id, id);
}

function opMergeForward(ctx) {
  const { el, id } = ctx;
  if (ctx.field === 'title') return;
  commitActiveText();
  const nextEl = visiblePrevNextContent(el, 1);
  if (!nextEl) return;
  const nextCtx = editableCtx(nextEl);
  if (!nextCtx || nextCtx.field === 'title') return;
  if (isMirror(id) || isMirror(nextCtx.id)) return; // mirror rows hold no text — never merge
  if (window.crossDayMerge?.(id, nextCtx.id)) return; // day sections never merge into each other
  mergeInto(id, nextCtx.id);
}

function opIndent(id, focus) {
  const p = parentOf(id);
  if (!p) return;
  const arr = kidsOf(p);
  const i = arr.indexOf(id);
  if (i <= 0) return;
  let newParent = arr[i - 1];
  if (isMirror(newParent)) {
    // a mirror node's own children never render — indenting under a mirror row means
    // indenting into the shared subtree it shows
    const t = mirrorTarget(newParent);
    if (!t) return; // a broken mirror can't hold children
    newParent = t;
  }
  if (newParent === id || isAncestor(id, newParent)) return; // mirror of own subtree → would cycle
  commitActiveText();
  snapshot();
  recOld(newParent);
  N(newParent).collapsed = false;
  moveNode(id, newParent, kidsOf(newParent).length);
  renderPage();
  restoreFocus(focus);
  markDirty();
}

function opOutdent(id, focus) {
  const p = parentOf(id);
  if (!p || p === state.zoom || window.isDayBoundary?.(p)) return;
  const gp = parentOf(p);
  if (!gp) return;
  commitActiveText();
  snapshot();
  moveNode(id, gp, kidsOf(gp).indexOf(p) + 1);
  renderPage();
  restoreFocus(focus);
  markDirty();
}

function opMoveVert(id, dir, focus) {
  const p = parentOf(id);
  if (!p) return;
  const arr = kidsOf(p);
  const i = arr.indexOf(id);
  const j = i + dir;
  if (j < 0 || j >= arr.length) {
    // at the edge of this level → pop the item out to its parent's level (Workflowy-style),
    // unless we'd escape the zoomed view or a day section
    const gp = parentOf(p);
    if (!gp || p === state.zoom || window.isDayBoundary?.(p)) return;
    commitActiveText();
    snapshot();
    moveNode(id, gp, kidsOf(gp).indexOf(p) + (dir > 0 ? 1 : 0)); // down → after the parent, up → before it
    renderPage();
    restoreFocus(focus);
    markDirty();
    return;
  }
  // if the neighbour we're moving toward is an expanded parent, descend INTO it instead of
  // swapping past it (Workflowy-style): up → become its last child, down → its first child.
  // Its last child is the row directly above us and its first child the row directly below,
  // so this is still a one-row move — just one that enters the nested level.
  const sib = arr[j];
  const sc = contentIdOf(sib);
  if (!N(sib).collapsed && kidsOf(sc).length) {
    commitActiveText();
    snapshot();
    moveNode(id, sc, dir > 0 ? 0 : kidsOf(sc).length);
    renderPage();
    restoreFocus(focus);
    markDirty();
    return;
  }
  commitActiveText();
  snapshot();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderPage();
  restoreFocus(focus);
  markDirty();
}

function opToggleDone(id) {
  if (state.readOnly) return;
  id = contentIdOf(id); // completing a mirror completes every instance
  commitActiveText();
  snapshot();
  const n = N(id);
  recOld(id);
  n.done = !n.done;
  touch(id);
  if (id === state.zoom) {
    zoomTitleEl.classList.toggle('done', n.done);
  } else {
    refreshItemShell(id);
    if (n.done && !settings.showCompleted) {
      const item = elById.get(id);
      const nf = neighborFocus(item);
      if (item) {
        item.classList.add('vanishing');
        setTimeout(() => { renderPage(); applyNeighborFocus(nf); }, 230);
      }
    }
  }
  markDirty();
}

function opToggleCollapse(id, collapse) {
  const n = N(id);
  if (!kidsOf(contentIdOf(id)).length) return; // a mirror's kids are the target's
  const want = collapse === undefined ? !n.collapsed : collapse;
  if (want === n.collapsed) return;
  commitActiveText();
  snapshot();
  recOld(id); // journal it — Route B emits ops from the journal, so an un-recorded collapse never syncs or persists
  n.collapsed = want;
  markDirty();
  const item = elById.get(id);
  // mirrors and multiply-rendered nodes re-render in full — the animated partial
  // rebuild below only patches one DOM instance
  const multi = isMirror(id) || treeEl.querySelectorAll(`.item[data-id="${id}"]`).length > 1;
  if (!item || multi || fmtOf(id) === 'board') {
    // boards re-render in full (no children-anim wrap to animate); keep the caret
    // where it was so you can keep toggling from the keyboard
    const f = captureFocus();
    renderPage();
    if (f && doc.nodes[f.id]) restoreFocus(f);
    return;
  }
  const wrap = item.querySelector(':scope > .children-anim');
  if (want) {
    item.classList.add('collapsed');
    if (wrap) {
      wrap.classList.add('closing', 'anim');
      wrap.addEventListener('transitionend', () => wrap.remove(), { once: true });
      setTimeout(() => wrap.remove(), 320);
    }
  } else {
    item.classList.remove('collapsed');
    wrap?.remove();
    const fresh = buildChildrenWrap(id, searchActive() && state.matchSet.has(id));
    if (fresh) {
      fresh.classList.add('closing', 'anim');
      item.append(fresh);
      requestAnimationFrame(() => requestAnimationFrame(() => fresh.classList.remove('closing')));
      fresh.addEventListener('transitionend', () => fresh.classList.remove('anim'), { once: true });
      setTimeout(() => fresh.classList.remove('anim'), 320);
    }
  }
}

// where the caret should land after `items` disappear: end of the previous
// visible line; else start of the next line outside the vanishing subtrees;
// else the page title (when zoomed). Computed BEFORE the items are removed.
function neighborFocus(items) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!list.length) return null;
  // prefer the previous bullet, then the next one; the page title only as a
  // last resort — deleting the first bullet should land on the line that
  // slides up into its place, not jump out of the list
  const all = editables().filter(e => e.classList.contains('content') && !list.some(it => it.contains(e)));
  const first = list[0], last = list[list.length - 1];
  let prev = null, next = null;
  for (const e of all) {
    if (first.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING) prev = e;
    if (!next && (last.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) next = e;
  }
  const el = prev || next;
  if (!el) {
    return state.zoom !== HOME && !state.readOnly ? { id: state.zoom, field: 'title', offset: 'end' } : null;
  }
  const ctx = editableCtx(el);
  if (!ctx) return null;
  return { id: ctx.id, field: 'text', offset: prev ? 'end' : 0 };
}

function applyNeighborFocus(nf) {
  if (!nf) return;
  if (nf.field === 'title' ? state.zoom !== nf.id : !doc.nodes[nf.id]) return;
  focusItem(nf.id, nf.field, nf.offset);
}

// All instances are equivalent (Workflowy): deleting whatever subtree happens to hold a
// mirrored node's content must not kill its other instances. Every doomed node with a
// surviving outside mirror hands content + children to its oldest mirror, the remaining
// mirrors repoint, and the doomed node itself BECOMES a mirror of the heir — so the trash
// entry it is about to enter restores as a live instance (not a content duplicate), and
// the server, replaying the same emitted ops, builds an identical trash entry. Runs inside
// the caller's snapshot/journal, so undo and op-sync cover it like any compound edit.
function promoteOne(id, heirs) {
  const hid = heirs[0], h = N(hid), o = N(id);
  recOld(hid); recOld(id);
  for (const k of ['text', 'note', 'done', 'format', 'files', 'comments', 'cal', 'c', 'm']) {
    if (o[k] !== undefined) h[k] = o[k];
    else delete h[k];
  }
  delete h.mirror;
  for (const c of [...kidsOf(id)]) { detach(c); insertAt(hid, kidsOf(hid).length, c); }
  for (const m of heirs.slice(1)) { recOld(m); N(m).mirror = hid; touch(m); }
  o.text = ''; o.note = null; o.done = false;
  delete o.format; delete o.files; delete o.comments; delete o.cal;
  o.mirror = hid;
  touch(hid); touch(id);
  mirrorsDirty = true;
}

// promote every node in the doomed subtree that still has mirrors outside it; promoting a
// parent moves its children OUT of the subtree, which can rescue mirrored descendants, so
// recompute after each promotion until nothing doomed is mirrored anymore
function promoteDoomed(rootId) {
  let promoted = false;
  for (let guard = 0; guard < 1000; guard++) {
    const doomed = new Set(subtreeOf(rootId));
    const heirsOf = new Map();
    for (const k in doc.nodes) {
      const t = doc.nodes[k].mirror;
      if (t && doomed.has(t) && !doomed.has(k) && !N(t).mirror) {
        if (!heirsOf.has(t)) heirsOf.set(t, []);
        heirsOf.get(t).push(k);
      }
    }
    if (!heirsOf.size) return promoted;
    const [t, heirs] = heirsOf.entries().next().value;
    promoteOne(t, heirs);
    promoted = true;
  }
  return promoted;
}

function opDelete(id, { toast = true } = {}) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const label = plainOf(N(contentIdOf(id)).text).trim() || 'item'; // before promotion clears it
  const promoted = promoteDoomed(id);
  const count = countDescendants(id); // after promotion: counts what actually disappears
  const item = elById.get(id);
  const nf = neighborFocus(item);

  // move to trash before removing
  recTrash();
  const nodes = {};
  const stack = [id];
  while (stack.length) {
    const x = stack.pop();
    nodes[x] = structuredClone(N(x));
    stack.push(...kidsOf(x));
  }
  trashList().unshift({
    ts: Date.now(),
    parent: parentOf(id),
    index: kidsOf(parentOf(id)).indexOf(id),
    root: id,
    nodes,
  });
  if (trashList().length > 200) doc.trash = trashList().slice(0, 200);

  deleteSubtree(id);
  if (state.zoom === id || !doc.nodes[state.zoom]) state.zoom = HOME;
  renderPage();
  applyNeighborFocus(nf);
  markDirty();
  if (toast) {
    showToast(promoted
      ? `Deleted “${label.slice(0, 40)}” — its content lives on in a mirror`
      : `Deleted “${label.slice(0, 40)}”${count ? ` and ${count} sub-item${count === 1 ? '' : 's'}` : ''}`,
    { label: 'Undo', fn: undo });
  }
}

function opDuplicate(id) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const copy = cloneSubtree(id);
  if (settings.copyTag && !plainOf(N(copy).text).includes('#copy')) {
    N(copy).text = N(copy).text + ' <span class="tag" data-tag="#copy">#copy</span>';
    N(copy).text = sanitizeHtml(N(copy).text);
  }
  insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id) + 1, copy);
  renderPage();
  elById.get(copy)?.classList.add('entering');
  focusItem(copy, 'text', 'end');
  markDirty();
}

function opAddNote(ctx) {
  if (state.readOnly) return;
  const id = contentIdOf(ctx.id); // a mirror's note IS the target's note
  const n = N(id);
  commitActiveText();
  if (n.note === null || n.note === undefined) {
    snapshot();
    recOld(id);
    n.note = '';
    markDirty();
  }
  if (id === state.zoom) {
    renderZoomHead();
    setCaretOffset(zoomNoteEl, 'end');
    return;
  }
  // data lives on the content owner; the caret stays on the instance the user invoked from
  const at = doc.nodes[ctx.id] ? ctx.id : id;
  const item = elById.get(at);
  if (item && !item.querySelector(':scope > .note')) {
    item.querySelector(':scope > .row').after(buildNoteEl(n.note));
  }
  focusItem(at, 'note', 'end');
}

function opRemoveNote(id) {
  const owner = contentIdOf(id);
  const n = N(owner);
  if (n.note === null || n.note === undefined) return;
  snapshot();
  recOld(owner);
  n.note = null;
  markDirty();
  if (owner === state.zoom) { renderZoomHead(); setCaretOffset(zoomTitleEl, 'end'); return; }
  for (const it of treeEl.querySelectorAll(`.item[data-id="${owner}"], .item[data-mirror="${owner}"]`)) {
    it.querySelector(':scope > .note')?.remove();
  }
  focusItem(id, 'text', 'end');
}

function opSetFormat(id, fmt, { focus = true } = {}) {
  if (state.readOnly) return;
  id = contentIdOf(id); // format is content — shared by every instance
  commitActiveText();
  snapshot();
  const n = N(id);
  recOld(id);
  if (fmt === 'bullet' || n.format === fmt) delete n.format;
  else n.format = fmt;
  touch(id);
  renderPage();
  if (focus && editableNode(id)) focusItem(id, 'text', 'end');
  markDirty();
}

function opMirror(id) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const target = isMirror(id) ? (mirrorTarget(id) || id) : id;
  const mid = makeNode('', { mirror: target, collapsed: true }); // start folded: no subtree wall
  insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id) + 1, mid);
  renderPage();
  elById.get(mid)?.classList.add('entering');
  markDirty();
  showToast('Mirror created — it stays in sync with the original');
}

function opSort(id, dir) {
  id = contentIdOf(id); // a mirror's children are the target's
  if (state.readOnly || !hasKids(id)) return;
  commitActiveText();
  snapshot();
  const key = c => plainOf(N(c).text).trim().toLowerCase();
  kidsOf(id).sort((a, b) => dir * key(a).localeCompare(key(b), undefined, { numeric: true }));
  touch(id);
  renderPage();
  markDirty();
  showToast(`Sorted ${dir > 0 ? 'A → Z' : 'Z → A'}`, { label: 'Undo', fn: undo });
}

// expand/collapse every item on the current page (the whole-page case of setSubtreeCollapsed)
const setCollapseAll = collapsed => setSubtreeCollapsed(state.zoom, collapsed);

/* ---------------- 13. zoom & routing ---------------- */

// a target is only zoomable if it exists and (in a share) sits within the shared subtree
function resolveZoomTarget(id) {
  if (!id || !doc.nodes[id]) return HOME;
  id = contentIdOf(id); // zooming a mirror shows the shared page (its own node is empty)
  if (SHARE_TOKEN && id !== HOME && !isAncestor(HOME, id)) return HOME;
  return id;
}

function zoomTo(id) {
  id = resolveZoomTarget(id);
  if (id === state.zoom) return;
  // rhizome: zooming out of a page lands on the Daily Notes home (no unified outline)
  location.hash = id === HOME ? '#/' : '#/n/' + id;
}

// per-view caret memory: leaving a view stores where the caret was, so
// returning to it (zoom out, breadcrumb, back) lands exactly there again
const viewFocus = new Map();

// rebuild the page for a new zoom target and place the caret intelligently
function renderZoomView(target, leaving) {
  state.zoom = target;
  if (searchActive()) setSearch('');
  renderPage();
  if (state.readOnly) { window.scrollTo(0, 0); return; }
  const saved = viewFocus.get(target);
  if (saved && doc.nodes[saved.id] && (saved.id === target || elById.has(saved.id))) {
    restoreFocus(saved);
    if (saved.id !== target) elById.get(saved.id)?.scrollIntoView({ block: 'center' });
    else window.scrollTo(0, 0);
  } else if (target !== HOME) {
    const off = (leaving && leaving.id === target && leaving.field === 'text') ? leaving.offset : 'end';
    setCaretOffset(zoomTitleEl, off);
    window.scrollTo(0, 0);
  } else {
    window.scrollTo(0, 0);
  }
}

const rowContentOf = id => elById.get(id)?.querySelector(':scope > .row > .content') || null;

// rhizome: which root-level view the current hash names (null → a node view)
function parseHashView() {
  if (SHARE_TOKEN) return null;
  if (/^#\/pages\b/.test(location.hash)) return 'pages';
  if (/^#\/outline\b/.test(location.hash)) return null; // legacy: the full root outline
  const m = location.hash.match(/^#\/n\/([A-Za-z0-9]+)/);
  return m ? null : 'daily';
}

function applyHash() {
  const m = location.hash.match(/^#\/n\/([A-Za-z0-9]+)/);
  if (!SHARE_TOKEN && m && m[1] === ROOT) { location.hash = '#/'; return; } // re-fires applyHash
  const nextView = parseHashView();
  const target = resolveZoomTarget(m ? m[1] : HOME);
  if (target === state.zoom && nextView === state.view) return;
  state.view = nextView;
  window.onViewChange?.();

  // remember the caret in the view we're leaving (before it's torn down)
  const leaving = captureFocus();
  commitActiveText();
  if (leaving) viewFocus.set(state.zoom, leaving);

  const prevZoom = state.zoom;
  const dirFwd = isAncestor(prevZoom, target) || prevZoom === HOME;
  // the explicit setting wins over the OS reduced-motion preference, since the
  // animation is opt-out here; turn it off in the menu to honor reduced motion.
  // automated browsers get instant navigation so e2e timing stays deterministic.
  // calendar navigation is lateral page-flipping, not a zoom — render it instantly
  // so the scrolling date strip doesn't slide sideways under the cross-fade.
  const calNav = !!(N(target)?.cal || N(prevZoom)?.cal);
  const animate = settings.animations !== false && (!navigator.webdriver || window.__tendrilForceAnim) && !calNav;
  const useVT = animate && typeof document.startViewTransition === 'function';

  if (!useVT) {
    pageEl.classList.remove('anim-fwd', 'anim-back');
    if (animate) { void pageEl.offsetWidth; pageEl.classList.add(dirFwd ? 'anim-fwd' : 'anim-back'); }
    renderZoomView(target, leaving);
    return;
  }

  // Smooth morph: the item that swaps between a row and the title glides into
  // place, while the rest of the page cross-fades. The morphing item is the
  // zoom target (when zooming in) or the item we were zoomed into (zooming out).
  const morphId = dirFwd ? target : prevZoom;
  const oldEl = dirFwd ? rowContentOf(target) : (prevZoom !== HOME ? zoomTitleEl : null);
  if (oldEl) oldEl.style.viewTransitionName = 'zoom-morph';
  document.documentElement.classList.add(dirFwd ? 'vt-fwd' : 'vt-back');

  let newEl = null;
  const vt = document.startViewTransition(() => {
    if (oldEl) oldEl.style.viewTransitionName = '';   // clear before the new snapshot
    renderZoomView(target, leaving);
    newEl = dirFwd ? (target !== HOME ? zoomTitleEl : null) : rowContentOf(morphId);
    if (newEl) newEl.style.viewTransitionName = 'zoom-morph';
  });
  const cleanup = () => {
    if (newEl) newEl.style.viewTransitionName = '';
    zoomTitleEl.style.viewTransitionName = '';
    document.documentElement.classList.remove('vt-fwd', 'vt-back');
  };
  vt.finished.then(cleanup, cleanup);
}

window.addEventListener('hashchange', () => { if (doc) applyHash(); });

/* ---------------- 14. selection mode ---------------- */

function selIds() {
  if (!state.sel) return [];
  const arr = kidsOf(state.sel.parent);
  const a = arr.indexOf(state.sel.anchor);
  const f = arr.indexOf(state.sel.focus);
  if (a < 0 || f < 0) return [];
  const [lo, hi] = a <= f ? [a, f] : [f, a];
  return arr.slice(lo, hi + 1);
}

function selRender() {
  $$('.item.selected', treeEl).forEach(el => el.classList.remove('selected'));
  // a node may render in several places (transcluded under mirrors) — highlight them all
  for (const id of selIds()) {
    for (const el of treeEl.querySelectorAll(`.item[data-id="${id}"]`)) el.classList.add('selected');
  }
}

function selEnter(id) {
  commitActiveText();
  const p = parentOf(id);
  if (!p) return;
  state.sel = { parent: p, anchor: id, focus: id };
  document.activeElement?.blur?.();
  getSelection().removeAllRanges();
  selRender();
}

function selClear(rerender = true) {
  if (!state.sel) return;
  state.sel = null;
  if (rerender) $$('.item.selected', treeEl).forEach(el => el.classList.remove('selected'));
}

function selExtend(dir) {
  if (!state.sel) return;
  const arr = kidsOf(state.sel.parent);
  const i = arr.indexOf(state.sel.focus);
  const j = clamp(i + dir, 0, arr.length - 1);
  state.sel.focus = arr[j];
  selRender();
  elById.get(arr[j])?.scrollIntoView({ block: 'nearest' });
}

function selKeydown(e) {
  const mod = e.ctrlKey || e.metaKey;
  const ids = selIds();
  if (!ids.length) { selClear(); return false; }
  const sel = state.sel;
  // a menu auto-opened by Ctrl+A shouldn't block extending/acting on the selection
  // (Escape is intercepted earlier while a popover is open, so it never reaches here)
  if (currentPopover) closeAllPopovers();

  if (e.key === 'Escape') {
    e.preventDefault();
    const f = sel.focus;
    selClear();
    focusItem(f, 'text', 'end');
    return true;
  }
  if (e.shiftKey && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    selExtend(e.key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (state.readOnly) return true;
  if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) {
      const p = sel.parent;
      if (p === state.zoom || !parentOf(p)) return true; // impossible move — no undo entry
      commitActiveText();
      snapshot();
      const gp = parentOf(p);
      let at = kidsOf(gp).indexOf(p) + 1;
      for (const id of ids) { moveNode(id, gp, at); at = kidsOf(gp).indexOf(id) + 1; }
      state.sel.parent = gp;
    } else {
      const arr = kidsOf(sel.parent);
      const first = arr.indexOf(ids[0]);
      if (first <= 0) return true; // impossible move — no undo entry
      commitActiveText();
      snapshot();
      const np = arr[first - 1];
      N(np).collapsed = false;
      for (const id of ids) moveNode(id, np, kidsOf(np).length);
      state.sel.parent = np;
    }
    renderPage();
    state.sel = sel;
    selRender();
    markDirty();
    return true;
  }
  if ((mod || e.altKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    const arr = kidsOf(sel.parent);
    const lo = arr.indexOf(ids[0]);
    const hi = arr.indexOf(ids[ids.length - 1]);
    if (dir < 0 && lo === 0) return true;
    if (dir > 0 && hi === arr.length - 1) return true;
    snapshot();
    if (dir < 0) { const [mv] = arr.splice(lo - 1, 1); arr.splice(hi, 0, mv); }
    else { const [mv] = arr.splice(hi + 1, 1); arr.splice(lo, 0, mv); }
    renderPage();
    state.sel = sel;
    selRender();
    markDirty();
    return true;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    snapshot();
    const count = ids.length;
    const nf = neighborFocus(ids.map(x => elById.get(x)));
    for (const id of ids) { promoteDoomed(id); deleteSubtree(id); }
    selClear(false);
    renderPage();
    applyNeighborFocus(nf);
    markDirty();
    showToast(`Deleted ${count} item${count === 1 ? '' : 's'}`, { label: 'Undo', fn: undo });
    return true;
  }
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    snapshot();
    const allDone = ids.every(id => N(id).done);
    for (const id of ids) { recOld(id); N(id).done = !allDone; touch(id); }
    renderPage();
    state.sel = sel;
    selRender();
    markDirty();
    return true;
  }
  if (mod && (e.key === 'a' || e.key === 'A')) {
    // Ctrl+A ladder, continued: all siblings at this level, then one level up
    // each press, stopping at the zoom page's top level
    e.preventDefault();
    const arr = kidsOf(sel.parent);
    if (ids.length < arr.length) {
      sel.anchor = arr[0];
      sel.focus = arr[arr.length - 1];
    } else if (sel.parent !== state.zoom) {
      const gp = parentOf(sel.parent);
      if (gp) {
        const up = kidsOf(gp);
        state.sel = { parent: gp, anchor: up[0], focus: up[up.length - 1] };
      }
    }
    selRender();
    elById.get(state.sel.focus)?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (mod && (e.key === 'c' || e.key === 'C')) return true;
  if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); return true; }
  if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) return false;
  if (e.key.length === 1 && !mod && !e.altKey) {
    // exit selection mode; no preventDefault, so the typed character still
    // lands in the freshly focused item instead of being swallowed
    const f = sel.focus;
    selClear();
    focusItem(f, 'text', 'end');
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const f = sel.focus;
    selClear();
    focusItem(f, 'text', e.key === 'ArrowUp' ? 0 : 'end');
    return true;
  }
  return true;
}

document.addEventListener('copy', e => {
  if (!state.sel) return;
  const ids = selIds();
  if (!ids.length) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', ids.map(id => subtreeToText(id, 0)).join(''));
});

/* ---------------- 15. keyboard ---------------- */

document.addEventListener('keydown', onKeydown);

function onKeydown(e) {
  if (e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;

  // overlays & caret popovers first
  if (window.presentKeydown?.(e)) return;
  if (!$('#jump-overlay').hidden) { jumpKeydown(e); return; }
  if (!$('#link-overlay').hidden) { window.linkDlgKeydown?.(e); return; }
  if (!$('#capture-overlay').hidden) { window.captureKeydown?.(e); return; }
  if (!$('#help-overlay').hidden) {
    if (e.key === 'Escape' || (mod && (e.key === '/' || e.key === '?'))) { e.preventDefault(); hideHelp(); }
    return;
  }
  if (!$('#trash-overlay').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); $('#trash-overlay').hidden = true; }
    return;
  }
  if (window.caretPopKeydown?.(e)) return;
  if (currentPopover && e.key === 'Escape') { e.preventDefault(); closeAllPopovers(); return; }

  // global shortcuts
  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
  if (mod && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y')) { e.preventDefault(); redo(); return; }
  if (mod && (e.key === 'k' || e.key === 'K') && !e.shiftKey) {
    // Ctrl+K: link when text is selected, jump otherwise
    const sel = getSelection();
    const ctx0 = editableCtx(document.activeElement);
    if (ctx0 && sel.rangeCount && !sel.getRangeAt(0).collapsed && !state.readOnly) {
      e.preventDefault();
      window.openLinkDialog?.(ctx0);
      return;
    }
    e.preventDefault();
    showJump();
    return;
  }
  if (mod && (e.key === '/' || e.key === '?')) { e.preventDefault(); showHelp(); return; }
  if (mod && e.key === "'") { e.preventDefault(); if (SHARE_TOKEN) zoomTo(HOME); else location.hash = '#/'; return; } // rhizome: home = daily notes
  if (mod && !e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    settings.showCompleted = !settings.showCompleted;
    saveSettings();
    renderPage();
    showToast(settings.showCompleted ? 'Showing completed items' : 'Hiding completed items');
    return;
  }
  if (mod && e.shiftKey && e.key === '8' && !SHARE_TOKEN) { e.preventDefault(); window.toggleStar?.(); return; }
  if (mod && e.shiftKey && e.code === 'Space' && !SHARE_TOKEN) { e.preventDefault(); window.showCapture?.(); return; }

  if (state.sel) { if (selKeydown(e)) return; }

  if (e.target === searchEl) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (window.searchPanelBack?.()) return; // pop a drilled level / active chip first
      setSearch('');
      searchEl.blur();
      const first = editables()[0];
      if (first) setCaretOffset(first, 'end');
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchEl.value.trim()) { searchEl.blur(); }
      else { window.closeSearchPanel?.(); showJump(); } // empty query → jump-to menu
    }
    return;
  }

  const ctx = editableCtx(e.target);
  if (!ctx) {
    if (e.key === 'Escape' && searchActive()) { setSearch(''); }
    // zoom-out works even without focus
    if ((e.altKey && e.key === 'ArrowLeft') || (mod && e.key === '[') || (e.altKey && e.key === ',')) {
      e.preventDefault();
      if (state.zoom !== HOME) zoomTo(parentOf(state.zoom) || HOME);
    }
    return;
  }
  const { el, id, field } = ctx;
  const isNote = field === 'note' || field === 'zoom-note';
  const isTitle = field === 'title';
  const fmt = isTitle || isNote ? null : fmtOf(id);

  if (!['ArrowUp', 'ArrowDown'].includes(e.key)) navGoalX = null;
  if (state.readOnly) return;

  /* ----- formatting ----- */
  if (mod && !e.shiftKey && ['b', 'i', 'u'].includes(e.key.toLowerCase()) && !isNote) {
    e.preventDefault();
    snapshot();
    document.execCommand({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]);
    scheduleCommit(el);
    return;
  }
  if (mod && e.shiftKey && (e.key === 'x' || e.key === 'X') && !isNote) {
    e.preventDefault();
    snapshot();
    document.execCommand('strikeThrough');
    scheduleCommit(el);
    return;
  }
  if (mod && !e.shiftKey && (e.key === 'e' || e.key === 'E') && !isNote) {
    e.preventDefault();
    window.wrapSelectionTag?.('code', null, el);
    return;
  }

  /* ----- markdown shortcuts (space after a marker at line start) ----- */
  if (e.key === ' ' && !mod && !isNote && !isTitle && fmt !== 'codeblock') {
    const sel = getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      const off = caretOffsetIn(el);
      const before = (el.textContent || '').slice(0, off);
      let fmt = BLOCK_MARKERS[before];
      if (!fmt && /^\d+[.)]$/.test(before)) fmt = 'number';
      if (fmt && off === before.length) {
        e.preventDefault();
        el.textContent = ''; // opSetFormat re-serializes this element via commitActiveText
        N(id).text = '';
        opSetFormat(id, fmt);
        return;
      }
    }
  }

  /* ----- Enter family ----- */
  if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
    if (isNote || fmt === 'codeblock') {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      scheduleCommit(el);
      return;
    }
    // '---' + Enter → divider
    if ((el.textContent || '') === '---') {
      e.preventDefault();
      el.textContent = ''; // opSetFormat re-serializes this element via commitActiveText
      N(id).text = '';
      opSetFormat(id, 'divider', { focus: false });
      const nid = makeNode('');
      insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id) + 1, nid);
      renderPage();
      focusItem(nid, 'text', 0);
      markDirty();
      return;
    }
    // in a board, Enter on a column header adds a card to that column, not a new lane
    if (N(parentOf(id))?.format === 'board') {
      e.preventDefault();
      opNewAt(id, 0);
      return;
    }
    e.preventDefault();
    opSplit(ctx);
    return;
  }
  if (e.key === 'Enter' && e.shiftKey && !mod) {
    e.preventDefault();
    if (isNote) { focusItem(id, field === 'zoom-note' ? 'title' : 'text', 'end'); return; }
    opAddNote(ctx);
    return;
  }
  if (e.key === 'Enter' && mod && !e.shiftKey) {
    e.preventDefault();
    opToggleDone(id);
    return;
  }

  /* ----- Tab ----- */
  if (e.key === 'Tab' && !e.shiftKey && window.dateSuggestActive?.()) {
    // typed a date phrase ("today", "next thu", "oct 7") — Tab turns it into a pill
    e.preventDefault();
    if (window.applyDateSuggest()) return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (isTitle || field === 'zoom-note') return;
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0, host: mirrorHostOf(el) };
    if (e.shiftKey) opOutdent(id, focus);
    else opIndent(id, focus);
    return;
  }

  /* ----- delete / merge ----- */
  if (e.key === 'Backspace' && !mod && !e.altKey) {
    const sel = getSelection();
    const collapsed = sel.rangeCount && sel.getRangeAt(0).collapsed;
    if (isNote && collapsed && !textLen(el)) {
      e.preventDefault();
      opRemoveNote(field === 'zoom-note' ? state.zoom : id);
      return;
    }
    if (!isNote && !isTitle && collapsed && caretOffsetIn(el) === 0) {
      const n = N(id);
      if (n.format && !plainOf(n.text).length && !hasKids(id)) {
        // backspace on an empty formatted item resets it to a plain bullet first
        e.preventDefault();
        opSetFormat(id, 'bullet');
        return;
      }
      if (hasKids(id) && plainOf(n.text).length > 0) return;
      e.preventDefault();
      opMergeBack(ctx);
      return;
    }
    return;
  }
  if (e.key === 'Delete' && !mod && !e.altKey && !isNote && !isTitle) {
    const sel = getSelection();
    const collapsed = sel.rangeCount && sel.getRangeAt(0).collapsed;
    if (collapsed && caretOffsetIn(el) === textLen(el)) {
      e.preventDefault();
      opMergeForward(ctx);
      return;
    }
    return;
  }
  if (mod && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
    e.preventDefault();
    if (!isTitle && field !== 'zoom-note') opDelete(id);
    else if (state.zoom !== HOME) { const z = state.zoom; zoomTo(parentOf(z) || HOME); setTimeout(() => opDelete(z), 50); }
    return;
  }

  /* ----- duplicate / mirror / copy link ----- */
  if ((mod && !e.shiftKey && (e.key === 'd' || e.key === 'D') && !isTitle && field !== 'zoom-note') ||
      (e.altKey && e.shiftKey && (e.key === 'd' || e.key === 'D') && !isTitle)) {
    e.preventDefault();
    opDuplicate(id);
    return;
  }
  if (e.altKey && e.shiftKey && (e.key === 'm' || e.key === 'M') && !isTitle && !isNote) {
    e.preventDefault();
    opMirror(id);
    return;
  }
  if (e.altKey && mod && (e.key === 'm' || e.key === 'M') && !isTitle && !isNote && !state.readOnly) {
    e.preventDefault();
    openNodePicker('Move to…', t => moveItemTo(id, t), subtreeOf(id));
    return;
  }
  if (e.altKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault();
    navigator.clipboard?.writeText(location.origin + location.pathname + '#/n/' + id);
    showToast('Link copied');
    return;
  }

  /* ----- move item ----- */
  if ((mod || e.altKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isTitle && field !== 'zoom-note') {
    e.preventDefault();
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0, host: mirrorHostOf(el) };
    opMoveVert(id, e.key === 'ArrowDown' ? 1 : -1, focus);
    return;
  }
  if (e.altKey && e.shiftKey && (e.key === '9' || e.key === '0') && !isTitle) {
    e.preventDefault();
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0, host: mirrorHostOf(el) };
    opMoveVert(id, e.key === '0' ? 1 : -1, focus);
    return;
  }

  /* ----- indent aliases ----- */
  if (e.altKey && e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !isTitle && field !== 'zoom-note') {
    e.preventDefault();
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0, host: mirrorHostOf(el) };
    if (e.key === 'ArrowRight') opIndent(id, focus);
    else opOutdent(id, focus);
    return;
  }

  /* ----- collapse / expand ----- */
  if (mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isTitle) {
    e.preventDefault();
    opToggleCollapse(id, e.key === 'ArrowUp');
    return;
  }

  /* ----- zoom ----- */
  if ((e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) || (mod && e.key === ']') || (e.altKey && e.key === '.')) {
    e.preventDefault();
    if (!isTitle) zoomTo(isMirror(id) ? (mirrorTarget(id) || id) : id);
    return;
  }
  if ((e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) || (mod && e.key === '[') || (e.altKey && e.key === ',')) {
    e.preventDefault();
    if (state.zoom !== HOME) zoomTo(parentOf(state.zoom) || HOME);
    return;
  }

  /* ----- select whole item (and surface its menu, like Workflowy) ----- */
  if (mod && (e.key === 'a' || e.key === 'A') && !isTitle && !isNote) {
    const sel = getSelection();
    const allSelected = sel.rangeCount &&
      sel.toString().replace(/ /g, ' ') === (el.textContent || '').replace(/ /g, ' ') &&
      textLen(el) > 0;
    if (allSelected || textLen(el) === 0) {
      e.preventDefault();
      selEnter(id);
      // open the item menu for quick action; any further selection move dismisses it
      const it = elById.get(id);
      window.showItemMenu?.(it?.querySelector(':scope > .row .bullet') || it?.querySelector(':scope > .row .content') || document.body, id);
    }
    return;
  }

  /* ----- escape ----- */
  if (e.key === 'Escape') {
    e.preventDefault();
    if (window.dateSuggestActive?.()) { window.clearDateSuggest(); return; }
    if (isNote) { focusItem(id, field === 'zoom-note' ? 'title' : 'text', 'end'); return; }
    if (searchActive()) {
      // clearing search shouldn't lose your place
      const here = { id, field, offset: caretOffsetIn(el) ?? 0 };
      setSearch('');
      if (doc.nodes[here.id]) restoreFocus(here);
      return;
    }
    el.blur();
    return;
  }

  /* ----- shift+vertical at the text edge → escalate to item selection ----- */
  if (e.shiftKey && !mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isTitle && !isNote) {
    const off = selFocusOffsetIn(el);
    const atEdge = e.key === 'ArrowDown' ? off === textLen(el) : off === 0;
    if (off !== null && atEdge) {
      e.preventDefault();
      selEnter(id);
    }
    return; // not at the edge: native selection keeps extending inside the bullet
  }

  /* ----- vertical navigation ----- */
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.altKey && !e.shiftKey) {
    const info = caretLineInfo(el);
    const up = e.key === 'ArrowUp';
    if ((up && info.first) || (!up && info.last)) {
      const list = navTargets();
      const i = list.indexOf(el);
      const target = list[i + (up ? -1 : 1)];
      if (target) {
        e.preventDefault();
        const x = navGoalX ?? info.x;
        navGoalX = x;
        focusNavTarget(target, up ? 'last' : 'first', x);
      } else if (!up && (isTitle || field === 'zoom-note') && !state.readOnly && !kidsOf(state.zoom).length) {
        // ArrowDown off the header of an empty page starts the first bullet
        e.preventDefault();
        opNewAt(state.zoom, 0);
      }
    }
    return;
  }

  /* ----- horizontal hop (in a board: to the neighbouring column) ----- */
  if (e.key === 'ArrowLeft' && !mod && !e.altKey && !e.shiftKey) {
    const sel = getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed && caretOffsetIn(el) === 0) {
      const hop = boardHopTarget(el, -1);
      if (hop) {
        e.preventDefault();
        if (hop.classList.contains('col-collapsed')) { focusNavTarget(hop, 'first', 0); return; }
        setCaretOffset(hop, 'end');
        hop.scrollIntoView({ block: 'nearest' });
        return;
      }
      const list = editables();
      const target = list[list.indexOf(el) - 1];
      if (target) { e.preventDefault(); setCaretOffset(target, 'end'); }
    }
    return;
  }
  if (e.key === 'ArrowRight' && !mod && !e.altKey && !e.shiftKey) {
    const sel = getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed && caretOffsetIn(el) === textLen(el)) {
      const hop = boardHopTarget(el, 1);
      if (hop) {
        e.preventDefault();
        if (hop.classList.contains('col-collapsed')) { focusNavTarget(hop, 'first', 0); return; }
        setCaretOffset(hop, 0);
        hop.scrollIntoView({ block: 'nearest' });
        return;
      }
      const list = editables();
      const target = list[list.indexOf(el) + 1];
      if (target) { e.preventDefault(); setCaretOffset(target, 0); }
    }
    return;
  }

  /* ----- slash command ----- */
  if (e.key === '/' && !mod && !e.altKey && !isNote && fmt !== 'codeblock') {
    const sel = getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
      const off = caretOffsetIn(el) ?? 0;
      const before = (el.textContent || '').slice(0, off);
      if (off === 0 || /[\s ]$/.test(before)) {
        window.slashWillOpen?.(ctx, off);
      }
    }
    return;
  }
}

/* ---------------- 16. editing events ---------------- */

pageEl.addEventListener('beforeinput', e => {
  const ctx = editableCtx(e.target);
  if (!ctx) return;
  if (state.readOnly) { e.preventDefault(); return; }
  redoStack.length = 0;
  const key = ctx.id + ':' + ctx.field;
  const now = Date.now();
  if (key !== burst.key || now - burst.at > 800) snapshot();
  burst = { key, at: now };

  // rhizome: auto-close brackets ([ → [], (( → (())) and type over the close
  if (e.inputType === 'insertText' && fmtOf(ctx.id) !== 'codeblock') {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.getRangeAt(0).collapsed) return;
    const CLOSE = { '[': ']', '(': ')' };
    if (CLOSE[e.data]) {
      e.preventDefault();
      const r = sel.getRangeAt(0);
      const t = document.createTextNode(e.data + CLOSE[e.data]);
      r.insertNode(t);
      const caret = document.createRange();
      caret.setStart(t, 1); caret.collapse(true);
      sel.removeAllRanges(); sel.addRange(caret);
      ctx.el.normalize();
      scheduleCommit(ctx.el);
      window.editorInputHook?.(ctx);
    } else if ((e.data === ']' || e.data === ')') && (ctx.el.textContent || '')[caretOffsetIn(ctx.el)] === e.data) {
      e.preventDefault(); // step over the auto-inserted close instead of doubling it
      sel.modify('move', 'forward', 'character');
      window.editorInputHook?.(ctx);
    }
  }
});

pageEl.addEventListener('input', e => {
  const ctx = editableCtx(e.target);
  if (!ctx) return;
  if (ctx.el.innerHTML === '<br>') ctx.el.innerHTML = '';
  scheduleCommit(ctx.el);
  window.editorInputHook?.(ctx);
});

pageEl.addEventListener('compositionstart', () => { composing = true; });
pageEl.addEventListener('compositionend', e => {
  composing = false;
  const ctx = editableCtx(e.target);
  if (ctx) scheduleCommit(ctx.el);
});

pageEl.addEventListener('focusout', e => {
  const ctx = editableCtx(e.target);
  if (!ctx) return;
  window.clearDateSuggest?.();
  commitActiveText();
  // rhizome: a page can't be renamed onto an existing page/day title — revert if it collides
  if (ctx.field === 'title' && titleBeforeEdit != null && window.pageTitleCollides?.(contentIdOf(ctx.id))) {
    const node = N(contentIdOf(ctx.id));
    recOld(node.id);
    node.text = titleBeforeEdit;
    touch(node.id);
    markDirty();
    renderZoomHead();
    updateDocTitle();
    showToast('A page with that title already exists — rename reverted');
    titleBeforeEdit = null;
    return;
  }
  if (ctx.field === 'title') titleBeforeEdit = null;
  // rhizome: leaving a line renders its block refs back to the live target text
  if (ctx.field === 'text' && doc.nodes[ctx.id] && document.activeElement !== ctx.el) {
    const display = displayHtml(N(contentIdOf(ctx.id)));
    if (ctx.el.innerHTML !== display) ctx.el.innerHTML = display;
  }
  if ((ctx.field === 'note' || ctx.field === 'zoom-note') && doc.nodes[ctx.id]) {
    const n = N(contentIdOf(ctx.id)); // a mirror's note lives on the target
    if (n.note === '' && document.activeElement !== ctx.el) {
      n.note = null;
      markDirty();
      if (ctx.field === 'zoom-note') { zoomNoteEl.hidden = true; }
      else { // the note may render under several instances — clear them all
        for (const it of treeEl.querySelectorAll(`.item[data-id="${n.id}"], .item[data-mirror="${n.id}"]`)) {
          it.querySelector(':scope > .note')?.remove();
        }
      }
    }
  }
});

treeEl.addEventListener('dragstart', e => e.preventDefault());

/* ---------------- 17. clicks ---------------- */

treeEl.addEventListener('click', e => {
  const attrKey = e.target.closest('.attr-key');
  if (attrKey) { e.preventDefault(); openTag(attrKey.dataset.attr); return; }
  const tag = e.target.closest('.tag');
  if (tag) {
    e.preventDefault();
    openTag(tag.dataset.tag);
    return;
  }
  const dateEl = e.target.closest('time[datetime]');
  if (dateEl && !e.target.closest('a')) {
    e.preventDefault();
    setSearch('on:' + dateEl.getAttribute('datetime').slice(0, 10));
    return;
  }
  const link = e.target.closest('a[href]');
  if (link && !link.classList.contains('bullet') && !link.classList.contains('att-chip')) {
    e.preventDefault();
    const href = link.getAttribute('href');
    const m = href.match(/#\/n\/([A-Za-z0-9]+)/);
    if (m && doc.nodes[m[1]]) zoomTo(m[1]);
    else window.open(href, '_blank', 'noopener');
    return;
  }
  const colTog = e.target.closest('[data-col-toggle]');
  if (colTog) {
    const col = colTog.dataset.colToggle;
    if (N(col)) { N(col).collapsed = !N(col).collapsed; touch(col); renderPage(); markDirty(); }
    return;
  }
  const addCard = e.target.closest('.board-add');
  if (addCard) {
    const col = addCard.dataset.addCard;
    N(col).collapsed = false;
    opNewAt(col, kidsOf(col).length);
    return;
  }
  const addCol = e.target.closest('.board-add-col');
  if (addCol) {
    const boardId = addCol.dataset.addCol;
    opNewAt(boardId, kidsOf(boardId).length);
    return;
  }
  const todoBox = e.target.closest('.todo-box');
  if (todoBox) {
    const id = todoBox.closest('.item').dataset.id;
    opToggleDone(id);
    return;
  }
  const commentChip = e.target.closest('.comment-chip');
  if (commentChip) {
    const id = commentChip.closest('.item').dataset.id;
    window.showComments?.(commentChip, id);
    return;
  }
  const toggle = e.target.closest('.toggle');
  if (toggle) {
    const id = toggle.closest('.item').dataset.id;
    opToggleCollapse(id);
    return;
  }
  const menuBtn = e.target.closest('.itemmenu-btn');
  if (menuBtn) {
    const id = menuBtn.closest('.item').dataset.id;
    window.showItemMenu?.(menuBtn, id);
    return;
  }
  // live mirror rows are editable — clicking places the caret like any row; only a
  // BROKEN mirror's text (not editable) keeps click-through behavior, which is a no-op
  if (state.sel && !e.target.closest('.item.selected')) selClear();
});

zoomHeadEl.addEventListener('click', e => {
  const attrKey = e.target.closest('.attr-key');
  if (attrKey) { e.preventDefault(); openTag(attrKey.dataset.attr); return; }
  const tag = e.target.closest('.tag');
  if (tag) { e.preventDefault(); openTag(tag.dataset.tag); }
});

emptyHintEl.addEventListener('click', () => {
  if (!kidsOf(state.zoom).length && !state.readOnly) {
    opNewAt(state.zoom, 0);
  }
});

pageEl.addEventListener('click', e => {
  if (e.target !== pageEl || state.readOnly) return;
  const container = window.newItemTarget?.() ?? state.zoom; // rhizome: daily view targets today
  if (!container) return;
  const kids = kidsOf(container);
  if (!kids.length) { opNewAt(container, 0); return; }
  const last = editables().filter(x => x.classList.contains('content')).pop();
  if (last) {
    const c = editableCtx(last);
    if (c && !plainOf(N(c.id).text).length) { setCaretOffset(last, 'end'); return; }
  }
  opNewAt(container, kids.length);
});

document.addEventListener('mousedown', e => {
  if (state.sel && !e.target.closest('.item.selected') && !e.target.closest('.popover')) selClear();
});

/* ---------------- 18. paste ---------------- */

pageEl.addEventListener('paste', e => {
  const ctx = editableCtx(e.target);
  if (!ctx || state.readOnly) return;

  // pasted images / files become attachments
  const files = [...(e.clipboardData.files || [])];
  if (files.length && ctx.field === 'text') {
    e.preventDefault();
    window.uploadAttachments?.(ctx.id, files);
    return;
  }

  const text = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '');
  if (!text) { e.preventDefault(); return; }
  if (!text.includes('\n') || ctx.field === 'note' || ctx.field === 'zoom-note' ||
      (ctx.field === 'text' && fmtOf(ctx.id) === 'codeblock')) {
    e.preventDefault();
    const keepNewlines = ctx.field === 'note' || ctx.field === 'zoom-note' || (ctx.field === 'text' && fmtOf(ctx.id) === 'codeblock');
    document.execCommand('insertText', false, keepNewlines ? text : text.replace(/\n+/g, ' '));
    scheduleCommit(ctx.el);
    return;
  }
  e.preventDefault();
  const forest = parseIndentedText(text);
  if (!forest.length) return;
  commitActiveText();
  snapshot();
  insertForest(ctx, forest);
});

function parseIndentedText(text) {
  const lines = text.split('\n').filter(l => l.trim().length);
  if (!lines.length) return [];
  const md = settings.markdownPaste !== false;
  const items = lines.map(line => {
    const m = line.match(/^[\t ]*/)[0];
    const depth = [...m].reduce((d, ch) => d + (ch === '\t' ? 2 : 1), 0);
    let body = line.trim();
    const spec = { depth, children: [] };
    if (md) {
      // detect markdown block markers
      let mm;
      if ((mm = body.match(/^(#{1,3})\s+(.*)$/))) { spec.format = 'h' + mm[1].length; body = mm[2]; }
      else if ((mm = body.match(/^([-*])\s+\[([ xX])\]\s+(.*)$/))) { spec.format = 'todo'; spec.done = mm[2].toLowerCase() === 'x'; body = mm[3]; }
      else if ((mm = body.match(/^>\s+(.*)$/))) { spec.format = 'quote'; body = mm[1]; }
      else if (/^([-*_]){3,}$/.test(body)) { spec.format = 'divider'; body = ''; }
      else body = body.replace(/^([-*•]|\d+[.)])\s+/, '');
    } else {
      body = body.replace(/^([-*•]|\d+[.)])\s+/, '');
    }
    spec.text = md ? mdInline(body) : escHtml(body);
    return spec;
  });
  const levels = [...new Set(items.map(i => i.depth))].sort((a, b) => a - b);
  for (const it of items) it.depth = levels.indexOf(it.depth);
  const rootList = [];
  const stack = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].depth >= it.depth) stack.pop();
    if (!stack.length) rootList.push(it);
    else stack[stack.length - 1].children.push(it);
    stack.push(it);
  }
  return rootList;
}

function specOpts(spec) {
  const o = {};
  if (spec.format) o.format = spec.format;
  if (spec.done) o.done = true;
  return o;
}

// the one place a parsed forest (paste, import, capture, AI) becomes real nodes —
// goes through specOpts so format/done survive
function materializeForest(forest, parent, index = kidsOf(parent).length) {
  const make = (spec, p, i) => {
    const id = makeNode(spec.text, specOpts(spec));
    insertAt(p, i, id);
    spec.children.forEach((c, j) => make(c, id, j));
    return id;
  };
  let last = null;
  forest.forEach((spec, i) => { last = make(spec, parent, index + i); });
  return last;
}

function insertForest(ctx, forest) {
  let lastId = null;
  if (ctx.field === 'title') {
    lastId = materializeForest(forest, state.zoom, 0);
  } else {
    const id = ctx.id;
    const n = N(id);
    const p = parentOf(id);
    // a mirror row's OWN text is empty but it displays its target's — never treat it as
    // a disposable empty bullet (pasting would silently delete the instance)
    if (!plainOf(n.text).length && !hasKids(id) && !isMirror(id)) {
      const at = kidsOf(p).indexOf(id);
      deleteSubtree(id);
      lastId = materializeForest(forest, p, at);
    } else {
      lastId = materializeForest(forest, p, kidsOf(p).indexOf(id) + 1);
    }
  }
  renderPage();
  if (lastId) focusItem(lastId, 'text', 'end');
  markDirty();
}

/* ---------------- 19. drag & drop ---------------- */

let drag = null;

treeEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const bullet = e.target.closest('.bullet');
  // in a board, the whole card / column header is a drag handle — natural kanban dragging.
  // (no pointer capture for these, so a plain click still places the text caret)
  const boardRow = (!bullet && e.target.closest('.board') &&
    !e.target.closest('.board-add, .col-toggle, .col-collapsed, .todo-box, .itemmenu-btn, .toggle, a, button'))
    ? e.target.closest('.board-col .item > .row') : null;
  const handle = bullet || boardRow;
  if (!handle) return;
  const item = handle.closest('.item');
  if (!item) return;
  const id = item.dataset.id;
  const isTouch = e.pointerType === 'touch';
  drag = {
    id, started: false, allowed: !isTouch && !state.readOnly,
    startX: e.clientX, startY: e.clientY,
    pointerId: e.pointerId, ghost: null, target: null, fromBody: !bullet,
  };
  if (isTouch && !state.readOnly) {
    drag.holdTimer = setTimeout(() => { if (drag) drag.allowed = true; }, 350);
  }
  if (bullet) { try { bullet.setPointerCapture(e.pointerId); } catch { /* synthetic events */ } }
});

document.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.started) {
    if (!drag.allowed) {
      if (Math.hypot(dx, dy) > 8) { clearTimeout(drag.holdTimer); drag = null; }
      return;
    }
    if (Math.hypot(dx, dy) < 5) return;
    startDrag(e);
  }
  if (!drag.started) return;
  e.preventDefault();
  drag.ghost.style.left = e.clientX + 'px';
  drag.ghost.style.top = e.clientY + 'px';
  updateDropTarget(e.clientX, e.clientY);
  autoScroll(e.clientY);
});

document.addEventListener('pointerup', () => {
  if (!drag) return;
  clearTimeout(drag.holdTimer);
  if (!drag.started) {
    const { id, fromBody } = drag;
    drag = null;
    // a tap on the dot zooms; a tap on a card body just edits (caret already placed)
    if (!fromBody) zoomTo(isMirror(id) ? (mirrorTarget(id) || id) : id);
    return;
  }
  finishDrag();
});

document.addEventListener('pointercancel', () => { if (drag) cancelDrag(); });

function startDrag(e) {
  commitActiveText();
  if (drag.fromBody) { document.activeElement?.blur?.(); getSelection().removeAllRanges(); } // stop text selection mid-drag
  drag.started = true;
  document.body.classList.add('dragging-item');
  const item = elById.get(drag.id);
  item?.classList.add('dragging');
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  const count = countDescendants(drag.id);
  ghost.textContent = plainOf(N(contentIdOf(drag.id)).text).trim() || 'Untitled';
  if (count) {
    const c = document.createElement('span');
    c.className = 'ghost-count';
    c.textContent = `+${count}`;
    ghost.append(c);
  }
  document.body.append(ghost);
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  drag.ghost = ghost;
}

function rowsForDrop() {
  const dragged = elById.get(drag.id);
  return $$('.row', treeEl).filter(r => !dragged || !dragged.contains(r));
}

function contentLeftOf(id) {
  const el = elById.get(id)?.querySelector(':scope > .row .content');
  return el ? el.getBoundingClientRect().left : treeEl.getBoundingClientRect().left;
}

// board columns flow horizontally, so the generic top-to-bottom row scan
// picks the wrong column — resolve board drops against the hovered column.
function boardDropTarget(x, y) {
  const stack = document.elementsFromPoint(x, y);
  let colEl = stack.find(el => el.classList?.contains('board-col'));
  if (!colEl) {
    // over the board but between/below columns: snap to the nearest column
    const boardEl = stack.find(el => el.classList?.contains('board'));
    if (!boardEl) return null;
    let bestDist = Infinity;
    for (const c of boardEl.querySelectorAll(':scope > .board-col')) {
      const r = c.getBoundingClientRect();
      const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (dist < bestDist) { bestDist = dist; colEl = c; }
    }
    if (!colEl) return null;
  }
  const colItem = colEl.querySelector(':scope > .item');
  const colId = colItem?.dataset.id;
  if (!colId || colId === drag.id || isAncestor(drag.id, colId)) return null;
  const boardId = parentOf(colId);
  const colRect = colEl.getBoundingClientRect();

  // dragging a column itself → reorder columns within the board
  if (parentOf(drag.id) === boardId) {
    const sibs = kidsOf(boardId);
    let index = sibs.indexOf(colId);
    if (x > colRect.left + colRect.width / 2) index++;
    return { parent: boardId, index, top: colRect.top - 4, left: colRect.left, width: colRect.width };
  }

  const dragged = elById.get(drag.id);
  const cardRows = [...colEl.querySelectorAll(':scope > .item > .children-anim > .children > .item > .row')]
    .filter(r => !dragged || !dragged.contains(r));
  let index = kidsOf(colId).length;
  let top = null;
  for (const r of cardRows) {
    const rc = r.getBoundingClientRect();
    if (y < rc.top + rc.height / 2) {
      index = kidsOf(colId).indexOf(r.closest('.item').dataset.id);
      top = rc.top - 4;
      break;
    }
  }
  if (top === null) {
    top = cardRows.length
      ? cardRows[cardRows.length - 1].getBoundingClientRect().bottom + 4
      : colItem.querySelector(':scope > .row').getBoundingClientRect().bottom + 4;
  }
  return { parent: colId, index, top, left: colRect.left + 8, width: colRect.width - 16 };
}

function updateDropTarget(x, y) {
  const boardTarget = boardDropTarget(x, y);
  if (boardTarget) {
    drag.target = boardTarget;
    dropIndicatorEl.hidden = false;
    dropIndicatorEl.style.top = (boardTarget.top - 1) + 'px';
    dropIndicatorEl.style.left = boardTarget.left + 'px';
    dropIndicatorEl.style.width = boardTarget.width + 'px';
    return;
  }
  // outside a board, ignore rows that live inside one
  const rows = rowsForDrop().filter(r => !r.closest('.board'));
  const treeRect = treeEl.getBoundingClientRect();
  let target = null;

  if (!rows.length) {
    target = { parent: state.zoom, index: 0, top: treeRect.top + 4, left: treeRect.left };
  } else {
    let row = rows.find(r => { const rc = r.getBoundingClientRect(); return y < rc.bottom; }) || rows[rows.length - 1];
    const rc = row.getBoundingClientRect();
    const id = row.closest('.item').dataset.id;
    if (y < rc.top + rc.height / 2) {
      const p = parentOf(id) ?? state.zoom;
      target = { parent: p, index: kidsOf(p).indexOf(id), top: rc.top, left: contentLeftOf(id) - 14 };
    } else {
      const itemEl2 = elById.get(id);
      const expandedKids = itemEl2?.querySelector(':scope > .children-anim');
      const cp = contentIdOf(id); // dropping into a mirror drops into the shared subtree
      if (expandedKids && isExpandedInView(id) && hasKids(cp)) {
        target = { parent: cp, index: 0, top: rc.bottom, left: contentLeftOf(id) + 12 };
      } else if (x > contentLeftOf(id) + 16 && (!isMirror(id) || cp !== id)) {
        target = { parent: cp, index: kidsOf(cp).length, top: rc.bottom, left: contentLeftOf(id) + 12 };
      } else {
        let cur = id;
        while (true) {
          const p = parentOf(cur);
          if (!p || p === state.zoom || window.isDayBoundary?.(p)) break;
          const sibs = kidsOf(p);
          if (sibs.indexOf(cur) !== sibs.length - 1) break;
          if (x >= contentLeftOf(cur) - 6) break;
          cur = p;
        }
        const p = parentOf(cur) ?? state.zoom;
        target = { parent: p, index: kidsOf(p).indexOf(cur) + 1, top: rc.bottom, left: contentLeftOf(cur) - 14 };
      }
    }
  }

  if (target && (target.parent === drag.id || isAncestor(drag.id, target.parent))) target = null;

  drag.target = target;
  if (target) {
    dropIndicatorEl.hidden = false;
    dropIndicatorEl.style.top = (target.top - 1) + 'px';
    dropIndicatorEl.style.left = target.left + 'px';
    dropIndicatorEl.style.width = Math.max(60, treeEl.getBoundingClientRect().right - target.left) + 'px';
  } else {
    dropIndicatorEl.hidden = true;
  }
}

let scrollRAF = null;
function autoScroll(y) {
  const margin = 70;
  let dy = 0;
  if (y < margin) dy = -(margin - y) / 4;
  else if (y > innerHeight - margin) dy = (y - (innerHeight - margin)) / 4;
  if (dy && !scrollRAF) {
    const step = () => {
      scrollRAF = null;
      if (!drag || !drag.started) return;
      window.scrollBy(0, dy);
    };
    scrollRAF = requestAnimationFrame(step);
  }
}

function finishDrag() {
  const { id, target } = drag;
  cancelDrag();
  if (!target || state.readOnly) return;
  snapshot();
  N(target.parent).collapsed = false;
  moveNode(id, target.parent, target.index);
  renderPage();
  const el = elById.get(id);
  el?.classList.add('dropped');
  el?.scrollIntoView({ block: 'nearest' });
  markDirty();
}

function cancelDrag() {
  document.body.classList.remove('dragging-item');
  dropIndicatorEl.hidden = true;
  drag?.ghost?.remove();
  if (drag) elById.get(drag.id)?.classList.remove('dragging');
  drag = null;
}

/* ---------------- 20. popovers & toasts ---------------- */

let currentPopover = null;
let popoverAnchor = null;
let popoverOpts = null;
let popoverCloser = null; // the active outside-mousedown listener, cleared when the popover closes

function closeAllPopovers() {
  // drop the outside-mousedown listener too, or a closed popover's stale listener
  // fires on the NEXT popover and closes it before its click lands (nested menus)
  if (popoverCloser) { document.removeEventListener('mousedown', popoverCloser); popoverCloser = null; }
  currentPopover?.remove();
  currentPopover = null;
  popoverAnchor = null;
  popoverOpts = null;
  window.closeCaretPop?.();
}

// Place a popover so it is ALWAYS fully on-screen: prefer below the anchor,
// flip above if it fits better there, and when it fits neither side cap its
// height to the larger gap and let it scroll. Width is clamped horizontally.
function positionPopover(pop, anchor, opts = {}) {
  const margin = 8, gap = 6;
  pop.style.maxHeight = '';
  const ar = anchor.getBoundingClientRect();
  let pr = pop.getBoundingClientRect();
  const below = innerHeight - margin - (ar.bottom + gap);
  const above = (ar.top - gap) - margin;
  let placeAbove, maxH = innerHeight - 2 * margin;
  if (pr.height <= below) placeAbove = false;
  else if (pr.height <= above) placeAbove = true;
  else { placeAbove = above > below; maxH = Math.max(below, above); }
  pop.style.maxHeight = Math.max(120, maxH) + 'px';
  pr = pop.getBoundingClientRect();
  let top = placeAbove ? ar.top - gap - pr.height : ar.bottom + gap;
  top = clamp(top, margin, Math.max(margin, innerHeight - pr.height - margin));
  const left = clamp(opts.alignX ?? ar.left, margin, Math.max(margin, innerWidth - pr.width - margin));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function openPopover(anchor, build, opts = {}) {
  closeAllPopovers();
  const pop = document.createElement('div');
  pop.className = 'popover' + (opts.className ? ' ' + opts.className : '');
  build(pop);
  document.body.append(pop);
  positionPopover(pop, anchor, opts);
  currentPopover = pop;
  popoverAnchor = anchor;
  popoverOpts = opts;
  setTimeout(() => {
    if (currentPopover !== pop) return; // superseded before the listener even armed
    popoverCloser = ev => { if (!pop.contains(ev.target)) closeAllPopovers(); };
    document.addEventListener('mousedown', popoverCloser);
  });
  return pop;
}

// keep an open popover on-screen as the viewport changes; close it if the
// page (not the popover's own content) scrolls out from under it
addEventListener('resize', () => {
  if (currentPopover && popoverAnchor && document.body.contains(popoverAnchor)) {
    positionPopover(currentPopover, popoverAnchor, popoverOpts || {});
  }
});
addEventListener('scroll', e => {
  if (currentPopover && e.target !== currentPopover && !currentPopover.contains(e.target)) closeAllPopovers();
}, true);

function menuItem(label, icon, fn, opts = {}) {
  const b = document.createElement('button');
  b.innerHTML = `<span class="ic">${icon}</span><span>${escHtml(label)}</span>${opts.hint ? `<span class="kbd-hint">${opts.hint}</span>` : ''}`;
  if (opts.danger) b.classList.add('danger');
  b.addEventListener('click', () => { if (!opts.keepOpen) closeAllPopovers(); fn(); });
  return b;
}

function showToast(text, action) {
  const t = document.createElement('div');
  t.className = 'toast';
  const span = document.createElement('span');
  span.className = 'toast-text';
  span.textContent = text;
  t.append(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => { dismiss(); action.fn(); });
    t.append(b);
  }
  toastsEl.append(t);
  const dismiss = () => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 220);
  };
  setTimeout(dismiss, 5200);
}

/* ---------------- 21. quick jump (Ctrl+K) ---------------- */

const jumpOverlay = $('#jump-overlay');
const jumpInput = $('#jump-input');
const jumpResults = $('#jump-results');
let jumpItems = [];
let jumpActive = 0;

function showJump() {
  commitActiveText();
  jumpOverlay.hidden = false;
  jumpInput.value = '';
  renderJump('');
  jumpInput.focus();
}

function hideJump() { jumpOverlay.hidden = true; }

function searchNodes(q, limit = 14) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const walk = (id, path) => {
    for (const c of kidsOf(id)) {
      const n = N(c);
      const plain = plainOf(n.text).trim();
      if (plain && !n.mirror) {
        const hay = plain.toLowerCase();
        let score = -1;
        if (!terms.length) score = 0;
        else if (terms.every(t => hay.includes(t))) {
          score = 100 - hay.indexOf(terms[0]) - Math.min(40, path.length);
        }
        if (score >= 0) out.push({ id: c, plain, path: path.join(' › '), done: n.done, score });
      }
      walk(c, [...path, plain || 'Untitled']);
    }
  };
  walk(HOME, []);
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// one search-result row, shared by quick-jump, the node picker, and the link dialog
function jumpRow(it, active, onClick, { showDone = false } = {}) {
  const b = document.createElement('button');
  b.className = 'jump-row' + (active ? ' active' : '');
  b.innerHTML = `<div class="jr-text${showDone && it.done ? ' done' : ''}">${escHtml(it.plain.slice(0, 90))}</div>` +
    (it.path ? `<div class="jr-path">${escHtml(it.path)}</div>` : '');
  b.addEventListener('click', onClick);
  return b;
}

// ancestor breadcrumb for a node (used when results come from the FTS index, which
// returns ids without the path the local walk computes inline)
function jumpPath(id) {
  const parts = []; let p = parentOf(id);
  while (p && p !== HOME) { parts.unshift(plainOf(N(p).text).trim() || 'Untitled'); p = parentOf(p); }
  return parts.join(' › ');
}

let jumpSeq = 0;
let jumpFtsThreshold = 4000; // below this the local walk is instant; above, use the server FTS index

function renderJump(q) {
  const seq = ++jumpSeq;
  // large docs: let SQLite FTS5 do the scan (O(matches)) instead of walking every node per keystroke
  if (!SHARE_TOKEN && q.trim() && Object.keys(doc.nodes).length > jumpFtsThreshold) {
    fetch(apiBase + '/search?q=' + encodeURIComponent(q))
      .then(r => r.json())
      .then(({ ids }) => {
        if (seq !== jumpSeq) return; // a newer keystroke superseded this response
        const items = (ids || [])
          .filter(id => doc.nodes[id] && !N(id).mirror && plainOf(N(id).text).trim())
          .slice(0, 14)
          .map(id => ({ id, plain: plainOf(N(id).text).trim(), path: jumpPath(id), done: N(id).done }));
        paintJump(items, q);
      })
      .catch(() => { if (seq === jumpSeq) paintJump(searchNodes(q), q); }); // offline → local fallback
    return;
  }
  paintJump(searchNodes(q), q);
}

function paintJump(items, q = '') {
  jumpItems = items;
  // rhizome: offer to create a page unless the query already names one exactly
  const title = q.trim();
  if (title && !SHARE_TOKEN && !state.readOnly && !window.findPageByTitle?.(title)) {
    jumpItems = [...items, { createPage: title, plain: `Create page “${title.slice(0, 80)}”`, path: '' }];
  }
  jumpActive = 0;
  jumpResults.innerHTML = '';
  if (!jumpItems.length) {
    jumpResults.innerHTML = '<div class="jump-empty">Nothing found.</div>';
    return;
  }
  jumpItems.forEach((it, i) => {
    const row = jumpRow(it, i === 0, () => { hideJump(); jumpPick(it); }, { showDone: true });
    if (it.createPage) row.classList.add('jump-create');
    jumpResults.append(row);
  });
}

// shared by click and Enter: create-page rows materialize on pick
function jumpPick(it) {
  if (it.createPage) {
    snapshot();
    const id = getOrCreatePage(it.createPage);
    markDirty();
    zoomTo(id);
  } else {
    zoomTo(it.id);
  }
}

jumpInput.addEventListener('input', () => renderJump(jumpInput.value));

// shared Esc/↑↓/Enter handling for the result lists (quick-jump, node picker,
// link dialog, caret popovers). Returns true if it consumed the key.
function listNavKey(e, { rowSel, container, count, getActive, setActive, onEnter, onEscape, scroll = true }) {
  if (e.key === 'Escape') { e.preventDefault(); onEscape?.(); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!count()) return true;
    const next = clamp(getActive() + (e.key === 'ArrowDown' ? 1 : -1), 0, count() - 1);
    setActive(next);
    const rows = $$(rowSel, container);
    rows.forEach((el, i) => el.classList.toggle('active', i === next));
    if (scroll) rows[next]?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); return true; }
  return false;
}

function jumpKeydown(e) {
  listNavKey(e, {
    rowSel: '.jump-row', container: jumpResults,
    count: () => jumpItems.length,
    getActive: () => jumpActive, setActive: v => { jumpActive = v; },
    onEscape: hideJump,
    onEnter: () => { const it = jumpItems[jumpActive]; if (it) { hideJump(); jumpPick(it); } },
  });
}

jumpOverlay.addEventListener('mousedown', e => { if (e.target === jumpOverlay) hideJump(); });

/* ---------------- 22. help ---------------- */

const HELP = [
  ['Editing', [
    ['New item / split at caret', 'Enter'],
    ['Add / edit note', 'Shift+Enter'],
    ['Complete', 'Ctrl+Enter'],
    ['Indent / outdent', 'Tab / Shift+Tab'],
    ['Move item up / down', 'Alt+Shift+↑ ↓'],
    ['Duplicate item', 'Ctrl+D'],
    ['Mirror item', 'Alt+Shift+M'],
    ['Move item to…', 'Alt+Ctrl+M'],
    ['Delete item + children', 'Ctrl+Shift+⌫'],
    ['Copy link to item', 'Alt+Shift+L'],
  ]],
  ['Formatting', [
    ['Bold / italic / underline', 'Ctrl+B I U'],
    ['Strikethrough', 'Ctrl+Shift+X'],
    ['Inline code', 'Ctrl+E'],
    ['Link selected text', 'Ctrl+K'],
    ['Heading / quote / to-do', '# ## ### > [] + space'],
    ['Numbered list', '1. + space'],
    ['Divider', '--- + Enter'],
    ['All block types & more', '/ slash menu'],
    ['Link to another item', '[[ …'],
    ['Type a date', 'today / next fri + Tab'],
    ['Date picker', '!! or /date'],
  ]],
  ['Navigation', [
    ['Zoom in', 'Alt+→ or Alt+.'],
    ['Zoom out', 'Alt+← or Alt+,'],
    ['Daily Notes', "Ctrl+'"],
    ['Expand / collapse', 'Ctrl+↓ / Ctrl+↑'],
    ['Find or create a page', 'Ctrl+K'],
    ['Star this page', 'Ctrl+Shift+8'],
    ['Show / hide completed', 'Ctrl+O'],
  ]],
  ['Selection & misc', [
    ['Select item + open menu', 'Ctrl+A twice'],
    ['Extend selection', 'Shift+↑ ↓'],
    ['Quick capture to Inbox', 'Ctrl+Shift+Space'],
    ['Undo / redo', 'Ctrl+Z / Ctrl+Shift+Z'],
    ['Filter by tag', 'click · Shift+click adds'],
    ['Search operators', '"…" -x OR is: has: date: changed:'],
    ['Quick filters', 'focus search → chip row'],
    ['This panel', 'Ctrl+/'],
  ]],
];

function showHelp() {
  const cols = $('#help-cols');
  cols.innerHTML = '';
  for (const [group, rows] of HELP) {
    const g = document.createElement('div');
    g.className = 'help-group';
    g.innerHTML = `<h3>${group}</h3>`;
    for (const [label, keys] of rows) {
      const r = document.createElement('div');
      r.className = 'help-row';
      r.innerHTML = `<span>${escHtml(label)}</span><kbd>${escHtml(keys)}</kbd>`;
      g.append(r);
    }
    cols.append(g);
  }
  $('#help-overlay').hidden = false;
}
function hideHelp() { $('#help-overlay').hidden = true; }
$('#help-close').addEventListener('click', hideHelp);
$('#btn-help').addEventListener('click', showHelp);
$('#help-overlay').addEventListener('mousedown', e => { if (e.target.id === 'help-overlay') hideHelp(); });

/* ---------------- 23. import / export ---------------- */

// Text exporters follow mirrors (content + transcluded subtree). `stack` carries the
// targets being transcluded up the recursion so a mirror loop exports once, not forever.
function subtreeToText(id, depth, stack = []) {
  const cid = contentIdOf(id);
  const n = N(cid);
  let out = '  '.repeat(depth) + '- ' + plainOf(n.text) + (n.done ? ' ✓' : '') + '\n';
  if (n.note) out += n.note.split('\n').map(l => '  '.repeat(depth + 1) + l).join('\n') + '\n';
  if (cid === id || !stack.includes(cid)) {
    const next = cid === id ? stack : [...stack, cid];
    for (const c of n.children) out += subtreeToText(c, depth + 1, next);
  }
  return out;
}

function subtreeToMarkdown(id, depth, stack = []) {
  const cid = contentIdOf(id);
  const n = N(cid);
  const fmt = n.format || 'bullet';
  const indent = '  '.repeat(depth);
  let line;
  const text = plainOf(n.text);
  if (fmt === 'h1' && depth === 0) line = `# ${text}`;
  else if (fmt === 'h2' && depth === 0) line = `## ${text}`;
  else if (fmt === 'h3' && depth === 0) line = `### ${text}`;
  else if (fmt === 'divider') line = `${indent}---`;
  else if (fmt === 'todo') line = `${indent}- [${n.done ? 'x' : ' '}] ${text}`;
  else if (fmt === 'quote' && depth === 0) line = `> ${text}`;
  else line = `${indent}- ${text}${n.done ? ' ~~done~~' : ''}`;
  let out = line + '\n';
  if (n.note) out += n.note.split('\n').map(l => indent + '  ' + l).join('\n') + '\n';
  if (cid === id || !stack.includes(cid)) {
    const next = cid === id ? stack : [...stack, cid];
    for (const c of n.children) out += subtreeToMarkdown(c, depth + 1, next);
  }
  return out;
}

function subtreeToOpml(id, stack = []) {
  const cid = contentIdOf(id);
  const n = N(cid);
  const attrs = [`text="${escAttr(plainOf(n.text))}"`];
  if (n.note) attrs.push(`_note="${escAttr(n.note)}"`);
  if (n.done) attrs.push(`_complete="true"`);
  const follow = cid === id || !stack.includes(cid);
  if (!n.children.length || !follow) return `<outline ${attrs.join(' ')}/>`;
  const next = cid === id ? stack : [...stack, cid];
  return `<outline ${attrs.join(' ')}>${n.children.map(c => subtreeToOpml(c, next)).join('')}</outline>`;
}

function download(name, mime, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// off-thread JSON serialization (a Web Worker), so exporting a huge document doesn't
// freeze the UI during stringify; falls back to the main thread if Workers are unavailable
const serializeWorker = (() => { try { return ('Worker' in window) ? new Worker('/serialize-worker.js') : null; } catch { return null; } })();
let serializeSeq = 0;
const serializePending = new Map();
serializeWorker?.addEventListener('message', e => {
  const { id, json, error } = e.data || {};
  const r = serializePending.get(id);
  if (r) { serializePending.delete(id); error ? r.reject(new Error(error)) : r.resolve(json); }
});
serializeWorker?.addEventListener('error', () => { for (const r of serializePending.values()) r.reject(new Error('worker failed')); serializePending.clear(); }); // → callers fall back to the main thread
function serializeAsync(payload, indent = 0) {
  if (!serializeWorker) return Promise.resolve(JSON.stringify(payload, null, indent));
  const id = ++serializeSeq;
  return new Promise((resolve, reject) => { serializePending.set(id, { resolve, reject }); serializeWorker.postMessage({ id, payload, indent }); });
}

function exportDoc(format) {
  commitActiveText();
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    serializeAsync(doc, 1)
      .then(json => download(`rhizome-${stamp}.json`, 'application/json', json))
      .catch(() => download(`rhizome-${stamp}.json`, 'application/json', JSON.stringify(doc, null, 1)));
  } else if (format === 'txt') {
    download(`rhizome-${stamp}.txt`, 'text/plain',
      kidsOf(HOME).map(id => subtreeToText(id, 0)).join(''));
  } else if (format === 'md') {
    download(`rhizome-${stamp}.md`, 'text/plain',
      kidsOf(HOME).map(id => subtreeToMarkdown(id, 0)).join('\n'));
  } else if (format === 'opml') {
    const body = kidsOf(HOME).map(subtreeToOpml).join('\n');
    download(`rhizome-${stamp}.opml`, 'text/xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Rhizome export</title></head><body>\n${body}\n</body></opml>`);
  }
}

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  try {
    if (file.name.endsWith('.json')) {
      const data = JSON.parse(text);
      const incoming = data.doc || data;
      if (!incoming.nodes || !incoming.nodes[incoming.root || ROOT]) throw new Error('not a Tendril document');
      if (!confirm('Replace the entire outline with this file? Your current outline will be overwritten (undo is available).')) return;
      snapshot();
      if (!incoming.nodes[ROOT]) {
        // a share-guest export is rooted at the shared node — wrap it in a fresh home
        incoming.nodes[ROOT] = { id: ROOT, text: '', note: null, done: false, collapsed: false, children: [incoming.root] };
      }
      incoming.root = ROOT;
      // strip mirror pointers whose targets aren't in the file (e.g. an old subtree
      // export) — a dangling pointer would render as a broken mirror forever
      for (const k of Object.keys(incoming.nodes)) {
        const nn = incoming.nodes[k];
        if (nn && nn.mirror && !incoming.nodes[nn.mirror]) delete nn.mirror;
      }
      doc = sanitizeDocTexts(incoming); // also normalizes missing children arrays
      rebuildParentMap();
      state.zoom = HOME;
      window.migrateWikiLinks?.();
      renderPage();
      markDirty();
      showToast('Outline imported', { label: 'Undo', fn: undo });
    } else if (file.name.endsWith('.opml') || file.name.endsWith('.xml')) {
      const xml = new DOMParser().parseFromString(text, 'text/xml');
      if (xml.querySelector('parsererror')) throw new Error('invalid OPML');
      snapshot();
      const addOutline = (el, parent) => {
        const id = makeNode(escHtml(el.getAttribute('text') || ''), {
          note: el.getAttribute('_note') || null,
          done: el.getAttribute('_complete') === 'true',
        });
        insertAt(parent, kidsOf(parent).length, id);
        for (const c of el.children) if (c.tagName === 'outline') addOutline(c, id);
        return id;
      };
      let count = 0;
      for (const el of xml.querySelectorAll('body > outline')) { addOutline(el, state.zoom); count++; }
      markDirty();
      window.migrateWikiLinks?.();
      renderPage();
      showToast(`Imported ${count} top-level item${count === 1 ? '' : 's'} from OPML`);
    } else {
      const forest = parseIndentedText(text);
      if (!forest.length) throw new Error('no items found');
      snapshot();
      materializeForest(forest, state.zoom);
      markDirty();
      window.migrateWikiLinks?.();
      renderPage();
      showToast('Text outline imported');
    }
  } catch (err) {
    showToast('Import failed: ' + err.message);
  }
});

/* ---------------- 24. theme & settings ---------------- */

const darkMQ = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const mode = settings.theme === 'auto' ? (darkMQ.matches ? 'dark' : 'light') : settings.theme;
  const html = document.documentElement;
  html.dataset.theme = mode;
  if (settings.accent && settings.accent !== 'terracotta') html.dataset.accent = settings.accent;
  else delete html.dataset.accent;
  if (settings.font && settings.font !== 'default') html.dataset.font = settings.font;
  else delete html.dataset.font;
  if (settings.density && settings.density !== 'cozy') html.dataset.density = settings.density;
  else delete html.dataset.density;
  if (settings.width === 'full') html.dataset.width = 'full'; else delete html.dataset.width;
  if (settings.arrows === 'always') html.dataset.arrows = 'always'; else delete html.dataset.arrows;
  html.classList.toggle('no-anim', settings.animations === false);
  document.body.classList.toggle('sidebar-open', !!settings.sidebar && !SHARE_TOKEN);
}
darkMQ.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });

function saveSettings() {
  localStorage.setItem('tendril-settings', JSON.stringify(settings));
}

/* ---------------- 25. search & mobile wiring ---------------- */

searchEl.addEventListener('input', () => searchDebounced(searchEl.value));
$('#search-clear').addEventListener('click', () => { setSearch(''); searchEl.focus(); });

const isCoarse = matchMedia('(pointer: coarse)').matches;
let lastItemId = null;

let titleBeforeEdit = null; // the page title as it was when editing began (to revert a colliding rename)
// while a line is edited its block refs show their raw ((id)) source (Roam-style),
// so they can be selected, edited or removed; on blur they render back to live text
function blockRefsToSource(el) {
  for (const a of el.querySelectorAll('a.block-ref')) {
    const m = (a.getAttribute('href') || '').match(/#\/n\/([A-Za-z0-9]+)/);
    a.replaceWith(document.createTextNode(m ? `((${m[1]}))` : ''));
  }
}

pageEl.addEventListener('focusin', e => {
  const ctx = editableCtx(e.target);
  if (ctx && ctx.field === 'text') blockRefsToSource(ctx.el);
  if (ctx && ctx.field !== 'title' && ctx.field !== 'zoom-note') lastItemId = ctx.id;
  if (ctx && ctx.field === 'title') titleBeforeEdit = N(contentIdOf(ctx.id))?.text ?? null;
  if (isCoarse && ctx && !state.readOnly) mobilebarEl.hidden = false;
});
pageEl.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!editableCtx(document.activeElement)) mobilebarEl.hidden = true;
  }, 150);
});

mobilebarEl.addEventListener('pointerdown', e => e.preventDefault());
mobilebarEl.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn || !lastItemId || !doc.nodes[lastItemId]) return;
  const id = lastItemId;
  const focus = captureFocus() || { id, field: 'text', offset: 0 };
  switch (btn.dataset.act) {
    case 'indent': opIndent(id, focus); break;
    case 'outdent': opOutdent(id, focus); break;
    case 'move-up': opMoveVert(id, -1, focus); break;
    case 'move-down': opMoveVert(id, 1, focus); break;
    case 'note': opAddNote({ id, field: 'text' }); break;
    case 'complete': opToggleDone(id); break;
    case 'zoom': zoomTo(id); break;
  }
});

/* ---------------- 26. welcome document ---------------- */

function welcomeDoc() {
  const d = { root: ROOT, nodes: { [ROOT]: { id: ROOT, text: '', note: null, done: false, collapsed: false, children: [] } } };
  doc = d;
  parentMap = new Map();
  const add = (parent, text, opts = {}) => {
    const id = makeNode(text, opts);
    insertAt(parent, kidsOf(parent).length, id);
    return id;
  };
  const w = add(ROOT, 'Welcome to <b>Rhizome</b> 🌱');
  add(w, 'Your notes live on <b>pages</b> — this is one — and your days live in <b>Daily Notes</b>, the view you land on.');
  const basics = add(w, 'The basics', { collapsed: false });
  add(basics, 'Write into today. Every day gets its own page; scroll down for the days before');
  add(basics, 'Press <b>Enter</b> to make a new item, <b>Tab</b> to indent, <b>Shift+Tab</b> to outdent');
  add(basics, 'Click a bullet — or press <b>Alt+→</b> — to zoom into it. <b>Alt+←</b> zooms back out');
  add(basics, 'Type <b>[[</b> to link to a page — or create it on the spot. <b>Ctrl+K</b> finds or creates pages by name');
  add(basics, 'Every page shows its <b>Linked References</b> below — and unlinked mentions you can link with one click');
  add(basics, 'Press <b>Shift+Enter</b> to attach a note to an item', { note: 'Notes look like this. They can run as long as you like.' });
  add(basics, 'Press <b>Ctrl+Enter</b> to complete something', { done: true });
  const power = add(w, 'Power moves', { collapsed: true });
  add(power, 'Tag things with #tags and @people, then click a tag to filter');
  add(power, 'Type <b>/</b> for block types: headings, to-dos, numbered lists, boards, code, dividers…');
  add(power, 'Type a date in plain words — <b>today</b>, <b>next friday</b>, <b>oct 7</b>, <b>in 3 days</b> — then press <b>Tab</b>');
  add(power, 'Drag any bullet to reorganize. Drop it deeper or shallower by moving sideways');
  add(power, '<b>Ctrl+A</b> twice selects whole items — then Tab, move, complete or delete in bulk');
  add(power, 'Select text to format it — colors and highlights included');
  add(power, 'Search supports <code>"phrases"</code>, <code>-not</code>, <code>OR</code>, <code>is:complete</code>, <code>has:note</code>, <code>changed:7d</code>…');
  const sample = add(ROOT, 'Try it: plan something #example', { collapsed: true });
  add(sample, 'A trip, a project, an essay…');
  add(sample, 'Every top-level item is a page — this one too');
  return d;
}

/* ---------------- 27. login & bootstrap (init lives in app2.js) ---------------- */

// choose the active graph (the saved one, else the first) and point the API base at it
function pickActiveGraph(me) {
  state.graphs = me.graphs || [];
  const saved = localStorage.getItem('rhizome-active-graph');
  const pick = state.graphs.find(g => g.id === saved) || state.graphs[0];
  state.graphId = pick?.id || 'default'; // open mode has no graphs → the default graph
  apiBase = '/api/g/' + state.graphId;
  if (!SHARE_TOKEN) SAVE_URL = apiBase + '/doc';
}

// switch the active graph: remember it and reload so the whole app rebinds to it
window.switchGraph = function switchGraph(gid) {
  if (gid === state.graphId) return;
  localStorage.setItem('rhizome-active-graph', gid);
  location.hash = '#/';
  location.reload();
};

async function ensureAuth() {
  let me;
  try {
    me = await (await fetch('/api/me')).json();
    idb.set('me', me); // remember who we are so a cold offline start can boot without the network
  } catch {
    // offline: boot from the last known session instead of a blank screen. First-ever
    // login still needs the network, but a returning user gets straight to their data.
    me = await idb.get('me');
    if (me && (me.user || me.authRequired === false)) {
      state.offline = true;
      state.authRequired = me.authRequired;
      state.aiEnabled = !!me.ai;
      state.user = me.user || null;
      pickActiveGraph(me);
      return;
    }
    throw new Error('offline and no cached session');
  }
  state.authRequired = me.authRequired;
  state.aiEnabled = !!me.ai;
  state.user = me.user || null;
  if (!me.authRequired || me.user) { pickActiveGraph(me); return; } // open instance, or already logged in

  const screen = $('#login-screen');
  screen.hidden = false;
  const err = $('#login-error');
  let mode = 'login'; // 'login' | 'register'
  const setMode = m => {
    mode = m;
    const reg = mode === 'register';
    $('#login-sub').textContent = reg ? 'Create your account.' : 'Sign in to your account.';
    $('#login-submit').textContent = reg ? 'Register' : 'Sign in';
    $('#login-invite').hidden = !(reg && me.inviteRequired);
    $('#login-code').hidden = !(!reg && me.totp);
    $('#login-toggle-text').textContent = reg ? 'Already have an account?' : 'No account yet?';
    $('#login-toggle').textContent = reg ? 'Sign in' : 'Register';
    $('#login-username').setAttribute('autocomplete', reg ? 'username' : 'username');
    $('#login-password').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    err.hidden = true;
  };
  setMode('login');
  $('#login-username').focus();
  $('#login-toggle').addEventListener('click', e => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); });

  await new Promise(resolve => {
    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      err.hidden = true;
      const payload = { username: $('#login-username').value.trim(), password: $('#login-password').value };
      if (mode === 'register') payload.invite = $('#login-invite').value.trim();
      else if (me.totp) payload.code = $('#login-code').value;
      const res = await fetch(mode === 'register' ? '/api/register' : '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (res.ok) {
        state.user = (await res.json()).user;
        const me2 = await (await fetch('/api/me')).json(); // learn the new user's graphs
        pickActiveGraph(me2);
        screen.hidden = true;
        resolve();
      }
      else {
        err.textContent = (await res.json()).error || 'Something went wrong';
        err.hidden = false;
        $('#login-password').select();
      }
    });
  });
}

async function loadDoc() {
  if (SHARE_TOKEN) {
    const data = await (await fetch(SAVE_URL)).json();
    if (data.error) throw new Error(data.error);
    doc = data.doc;
    doc.root = data.root;
    HOME = data.root;
    state.zoom = HOME;
    state.version = data.version || 0;
    state.shareMode = data.mode;
    state.readOnly = data.mode !== 'edit';
    sanitizeDocTexts(doc);
    rebuildParentMap();
    const banner = $('#share-banner');
    banner.hidden = false;
    banner.innerHTML = state.readOnly
      ? 'You are viewing a <b>shared outline</b> (read-only).'
      : 'You are editing a <b>shared outline</b> — changes save to its owner.';
    return;
  }
  let data;
  try {
    data = await (await fetch(apiBase + '/doc')).json();
  } catch {
    // offline cold start: boot from the last cached doc for this graph instead of a
    // blank/broken screen. If the cache carried unsaved edits, mark dirty so reconnect
    // flushes them; the periodic save retry + the `online` listener pick it up.
    state.offline = true;
    const cached = await idb.get('doc:' + state.graphId);
    if (cached && cached.doc && cached.doc.nodes) {
      doc = cached.doc;
      doc.root = doc.root || ROOT;
      serverHasDoc = true;
      state.version = cached.version || 0;
      sanitizeDocTexts(doc);
      rebuildParentMap();
      setSaveUI('offline');
      if (cached.dirty) { markDirty(); showToast('Offline — your changes will sync when you reconnect'); }
      else showToast('Offline — showing your last synced data');
    } else {
      welcomeDoc();
      rebuildParentMap();
      setSaveUI('offline');
    }
    return;
  }
  if (data.doc && data.doc.nodes && data.doc.nodes[data.doc.root || ROOT]) {
    doc = data.doc;
    doc.root = doc.root || ROOT;
    serverHasDoc = true;
    state.version = data.version || 0; // = the server's op-log head (seq); ops apply contiguously from here
    sanitizeDocTexts(doc);
    rebuildParentMap();
    cacheDoc(); // seed the offline boot snapshot with the freshly loaded server doc
  } else {
    // fresh install: the server has no doc yet → the first save is a whole-doc PUT that
    // seeds the welcome outline (there are no ops to send for a doc the server lacks)
    welcomeDoc();
    rebuildParentMap();
    markDirty();
  }
  // restore changes that were stranded offline
  try {
    const stash = JSON.parse(localStorage.getItem('tendril-offline') || 'null');
    if (stash && stash.doc) {
      const server = stash.baseVersion < state.version ? doc : null;
      doc = stash.doc;
      if (server) graftMissing(server); // keep offline edits, graft newer server nodes in
      rebuildParentMap();
      markDirty();
      showToast('Restored unsaved offline changes');
    }
  } catch { /* ignore */ }
  // prune trash older than 30 days
  if (doc.trash) {
    const cutoff = Date.now() - 30 * 86400e3;
    const before = doc.trash.length;
    doc.trash = doc.trash.filter(t => t.ts > cutoff);
    if (doc.trash.length !== before) markDirty();
  }
}
