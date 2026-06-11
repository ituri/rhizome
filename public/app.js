/* ============================================================
   Tendril — self-hostable infinite outliner (core)
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
  search: '',
  sel: null,
  matchSet: null,
  openSet: null,
  matchCount: 0,
  query: null,                   // parsed search query
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
  },
  JSON.parse(localStorage.getItem('tendril-settings') || '{}')
);

const undoStack = [];
const redoStack = [];
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

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- natural-language date parsing (today, next thu, oct 7, in 3 days…) ----
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

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
      out += escHtml(child.nodeValue.replace(/ /g, ' '));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = INLINE[child.tagName];
      if (child.tagName === 'BR') {
        out += ' ';
      } else if (child.tagName === 'A') {
        const href = safeHref(child.getAttribute('href'));
        const inner = serializeChildren(child);
        out += href ? `<a href="${escAttr(href)}">${inner}</a>` : inner;
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

  const walk = (node, inLink) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
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
  doc.nodes[id] = { id, text, note: null, done: false, collapsed: false, children: [], c: now, m: now, ...extra };
  return id;
}

const touch = id => { if (doc.nodes[id]) N(id).m = Date.now(); };

function detach(id) {
  const p = parentOf(id);
  if (!p) return;
  const arr = kidsOf(p);
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  parentMap.delete(id);
}

function insertAt(parent, index, id) {
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
const editableNode = id => !isMirror(id) && fmtOf(id) !== 'divider';

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

function editables() {
  const out = [];
  if (state.zoom !== HOME && !zoomHeadEl.hidden && zoomHeadEl.style.display !== 'none') {
    if (zoomTitleEl.isContentEditable) out.push(zoomTitleEl);
    if (!zoomNoteEl.hidden && zoomNoteEl.isContentEditable) out.push(zoomNoteEl);
  }
  for (const el of treeEl.querySelectorAll('.content, .note')) {
    if (el.offsetParent !== null && el.isContentEditable) out.push(el);
  }
  return out;
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

function focusItem(id, field = 'text', offset = 'end') {
  if (id === state.zoom) {
    const el = field === 'note' || field === 'zoom-note' ? zoomNoteEl : zoomTitleEl;
    if (!el.hidden) setCaretOffset(el, offset);
    return;
  }
  const item = elById.get(id);
  if (!item) return;
  const el = field === 'note' ? item.querySelector(':scope > .note') : item.querySelector(':scope > .row .content');
  if (el && el.isContentEditable) setCaretOffset(el, offset);
}

function captureFocus() {
  const ctx = editableCtx(document.activeElement);
  if (!ctx) return null;
  return { id: ctx.id, field: ctx.field, offset: caretOffsetIn(ctx.el) ?? 0 };
}

function restoreFocus(f) {
  if (!f || !doc.nodes[f.id]) return;
  focusItem(f.id, f.field, f.offset);
}

/* ---------------- 7. undo / redo ---------------- */

function snapshot() {
  undoStack.push({ doc: structuredClone(doc), zoom: state.zoom, focus: captureFocus() });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function applyHistory(entry) {
  burst = { key: '', at: 0 }; // typing right after undo/redo must snapshot afresh
  doc = entry.doc;
  rebuildParentMap();
  if (!doc.nodes[state.zoom]) state.zoom = HOME;
  renderPage();
  restoreFocus(entry.focus);
  markDirty();
}

function undo() {
  if (!undoStack.length || state.readOnly) return;
  commitActiveText();
  const entry = undoStack.pop();
  redoStack.push({ doc: structuredClone(doc), zoom: state.zoom, focus: captureFocus() });
  applyHistory(entry);
}

function redo() {
  if (!redoStack.length || state.readOnly) return;
  commitActiveText();
  const entry = redoStack.pop();
  undoStack.push({ doc: structuredClone(doc), zoom: state.zoom, focus: captureFocus() });
  applyHistory(entry);
}

/* ---------------- 8. persistence & sync ---------------- */

const SAVE_URL = SHARE_TOKEN ? `/api/share/${SHARE_TOKEN}/doc` : '/api/doc';

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

function stashOffline() {
  try {
    localStorage.setItem('tendril-offline', JSON.stringify({ baseVersion: state.version, doc, at: Date.now() }));
  } catch { /* quota — best effort */ }
}

async function doSave() {
  if (saving || !doc || state.readOnly) return;
  saving = true;
  const seq = changeSeq;
  try {
    let res = await fetch(SAVE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: state.version, doc }),
    });
    if (res.status === 409) {
      const server = await res.json();
      graftMissing(server.doc);
      rebuildParentMap();
      res = await fetch(SAVE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: server.version, doc }),
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
    if (changeSeq === seq) {
      dirty = false;
      setSaveUI('saved');
      localStorage.removeItem('tendril-offline');
      bc?.postMessage({ version: state.version, doc });
    }
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
  if (!doc.nodes[state.zoom]) state.zoom = HOME;
  renderPage();
}

bc?.addEventListener('message', e => {
  if (!dirty && e.data.version > state.version) adoptRemote(e.data.version, e.data.doc);
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || dirty || !doc) return;
  try {
    if (SHARE_TOKEN) {
      const full = await (await fetch(SAVE_URL)).json();
      if (!dirty && full.version > state.version) adoptRemote(full.version, full.doc);
      return;
    }
    const v = await (await fetch('/api/version')).json();
    if (v.version > state.version) {
      const full = await (await fetch('/api/doc')).json();
      if (!dirty) adoptRemote(full.version, full.doc);
    }
  } catch { /* offline */ }
});

window.addEventListener('beforeunload', () => {
  commitActiveText();
  if (dirty && doc && !state.readOnly) {
    // stash first: if the beacon loses a version race the server rejects it,
    // and the next load merges the stash via graftMissing instead
    stashOffline();
    navigator.sendBeacon?.(SAVE_URL, new Blob(
      [JSON.stringify({ baseVersion: state.version, doc })],
      { type: 'application/json' }
    ));
  }
});

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
  try {
    const es = new EventSource('/api/events');
    es.onmessage = async e => {
      try {
        const data = JSON.parse(e.data);
        if (data.version > state.version && !dirty) {
          const full = await (await fetch('/api/doc')).json();
          if (!dirty && full.version > state.version) adoptRemote(full.version, full.doc);
        }
      } catch { /* ignore */ }
    };
  } catch { /* SSE unsupported */ }
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
  const node = N(ctx.id);
  if (ctx.field === 'note' || ctx.field === 'zoom-note') {
    const v = (el.innerText || '').replace(/ /g, ' ').replace(/\n$/, '');
    if (node.note !== v) { node.note = v; touch(ctx.id); markDirty(); }
  } else {
    let html = serializeEl(el);
    if (settings.capitalize && (ctx.field === 'text' || ctx.field === 'title')) html = applyCapitalize(html);
    if (node.text !== html) {
      node.text = html;
      touch(ctx.id);
      markDirty();
      if (ctx.field === 'title') updateDocTitle();
      syncMirrorRows(ctx.id);
    }
    if (redecorateOk && document.activeElement === el && !composing && !window.caretPopOpen?.()) {
      const display = displayHtml(node);
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

function syncMirrorRows(targetId) {
  for (const el of treeEl.querySelectorAll(`.item[data-mirror="${targetId}"] > .row .content`)) {
    el.innerHTML = decorate(N(targetId).text) + '<span class="mirror-badge">mirror</span>';
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
      const op = text.match(/^(is|has|text|highlight|changed|in|on|link):(.*)$/i);
      // 'text:' gets its own kind so it can't collide with plain search terms
      if (op) cond = { neg, kind: op[1].toLowerCase() === 'text' ? 'textfmt' : op[1].toLowerCase(), value: op[2].toLowerCase() };
    }
    if (!cond) cond = { neg, kind: 'text', value: text.toLowerCase() };
    if (cond.value !== '' || cond.kind !== 'text') pushCond(cond);
  }
  return { segments: segments.map(s => s.filter(c => c.or.length)), raw: q };
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
      else if (cond.value === 'date') hit = html.includes('<time');
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
    case 'changed': {
      const m = n.m || 0;
      const now = Date.now();
      let ms = null;
      if (cond.value === 'today') ms = now - new Date(new Date().setHours(0, 0, 0, 0)).getTime();
      else {
        const dm = cond.value.match(/^(\d+)([dhw])$/);
        if (dm) ms = parseInt(dm[1], 10) * (dm[2] === 'h' ? 3600e3 : dm[2] === 'w' ? 604800e3 : 86400e3);
      }
      hit = ms !== null && now - m <= ms;
      break;
    }
    case 'in':
      hit = (n.note || '').toLowerCase().includes(cond.value.replace(/^note:/, ''));
      break;
    case 'on':
      hit = html.includes(`datetime="${cond.value}`);
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
  const n = N(id);
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

function computeSearch() {
  state.matchSet = null;
  state.openSet = null;
  state.matchCount = 0;
  state.query = null;
  if (!searchActive()) return;
  state.query = parseQuery(state.search);
  const segs = state.query.segments.filter(s => s.length);
  if (!segs.length) { state.query = null; return; }
  const lastSeg = segs[segs.length - 1];
  const ancestorSegs = segs.slice(0, -1);
  const matches = new Set();
  const open = new Set();

  const visit = id => {
    const n = N(id);
    if (id !== ROOT && id !== state.zoom) {
      if (nodeMatchesSegment(id, lastSeg)) {
        // ancestor segments must match, in order, walking down from the top
        let ok = true;
        if (ancestorSegs.length) {
          const chain = ancestorsOf(id).filter(a => a !== ROOT);
          let ci = 0;
          for (const segA of ancestorSegs) {
            let found = false;
            while (ci < chain.length) {
              if (nodeMatchesSegment(chain[ci], segA)) { found = true; ci++; break; }
              ci++;
            }
            if (!found) { ok = false; break; }
          }
        }
        if (ok) matches.add(id);
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(state.zoom);
  for (const id of matches) {
    let p = parentOf(id);
    while (p && p !== state.zoom && !open.has(p)) { open.add(p); p = parentOf(p); }
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
  computeSearch();
  renderPage();
}

const searchDebounced = debounce(q => setSearch(q, { fromInput: true }), 160);

/* ---------------- 11. rendering ---------------- */

function updateDocTitle() {
  document.title = state.zoom === HOME && !SHARE_TOKEN
    ? 'Tendril'
    : (plainOf(N(state.zoom).text).trim() || 'Untitled') + ' — Tendril';
}

function crumbLabel(id) {
  const t = plainOf(N(id).text).trim();
  return t || 'Untitled';
}

function renderCrumbs() {
  crumbsEl.innerHTML = '';
  if (state.zoom === HOME) { crumbsEl.style.display = 'none'; return; }
  crumbsEl.style.display = '';
  const chain = ancestorsOf(state.zoom).filter(id => id === HOME || isAncestor(HOME, id));
  if (!chain.includes(HOME)) chain.unshift(HOME);
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

function mountItem(id, underMatch = false) {
  const n = N(id);
  const fmt = fmtOf(id);
  const mirror = isMirror(id);
  const target = mirror ? mirrorTarget(id) : null;
  const expanded = isExpandedInView(id);

  const item = document.createElement('div');
  item.className = 'item fmt-' + fmt;
  item.dataset.id = id;
  if (mirror) {
    item.classList.add('is-mirror');
    if (target) item.dataset.mirror = target;
    else item.classList.add('broken');
  }
  if (n.done || (target && N(target).done)) item.classList.add('done');
  if (hasKids(id)) item.classList.add('has-children');
  if (!expanded) item.classList.add('collapsed');
  if (state.shares.some(s => s.id === id)) item.classList.add('shared-ring');
  elById.set(id, item);

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

  if (fmt === 'todo') {
    const box = document.createElement('button');
    box.className = 'todo-box';
    box.title = 'Complete (Ctrl+Enter)';
    box.tabIndex = -1;
    box.innerHTML = CHECK;
    row.append(box);
  } else if (fmt === 'number') {
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
  const editable = !state.readOnly && !mirror && fmt !== 'divider';
  content.contentEditable = editable ? 'true' : 'false';
  content.spellcheck = false;
  if (mirror) {
    content.innerHTML = target
      ? decorate(N(target).text) + '<span class="mirror-badge">mirror</span>'
      : '(original was deleted)';
  } else if (fmt !== 'divider') {
    content.innerHTML = displayHtml(n);
  }
  row.append(content);

  if (n.comments && n.comments.length) {
    const chip = document.createElement('button');
    chip.className = 'comment-chip';
    chip.title = 'Comments';
    chip.innerHTML = `💬 ${n.comments.length}`;
    row.append(chip);
  }

  item.append(row);

  if (n.note !== null && n.note !== undefined && !mirror) {
    item.append(buildNoteEl(n.note));
  }
  const atts = buildAttachments(n);
  if (atts) item.append(atts);
  const embed = !mirror && buildEmbed(n);
  if (embed) item.append(embed);

  const um = underMatch || (searchActive() && state.matchSet?.has(id));

  if (fmt === 'board') {
    item.append(buildBoardEl(id, false));
  } else if (expanded && hasKids(id)) {
    const wrap = buildChildrenWrap(id, um);
    if (wrap) item.append(wrap);
  }
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
    const colEl = document.createElement('div');
    colEl.className = 'board-col';
    colEl.append(mountItem(col, true));
    if (!state.readOnly && !searchActive()) {
      const add = document.createElement('button');
      add.className = 'board-add';
      add.dataset.addCard = col;
      add.textContent = '+ New card';
      colEl.append(add);
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
  computeSearch();
  renderCrumbs();
  renderZoomHead();
  updateDocTitle();

  const scrollY = window.scrollY;
  treeEl.innerHTML = '';
  treeEl.classList.toggle('hide-done', !settings.showCompleted);
  pageEl.classList.toggle('board-page', N(state.zoom).format === 'board');
  pageEl.classList.toggle('cal-page', !!N(state.zoom).cal && N(state.zoom).cal !== 'root');
  const roots = kidsOf(state.zoom).filter(c => shouldShow(c, false));
  const frag = document.createDocumentFragment();
  if (N(state.zoom).format === 'board') {
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
  if (N(state.zoom).format === 'board') {
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
  const item = elById.get(id);
  if (!item || !doc.nodes[id]) return;
  const n = N(id);
  item.classList.toggle('done', !!n.done);
  item.classList.toggle('has-children', hasKids(id));
  item.classList.toggle('collapsed', !isExpandedInView(id));
}

/* ---------------- 12. structural operations ---------------- */

function opNewAt(parent, index, text = '', focusOffset = 0) {
  if (state.readOnly) return null;
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
  const n = N(id);
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
    focusItem(id, 'text', 0);
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
  n.text = beforeHtml;
  touch(id);
  // a split item inherits to-do / numbered format so lists stay homogeneous
  const inherit = (n.format === 'todo' || n.format === 'number') ? { format: n.format } : {};
  const nid = makeNode(afterHtml, inherit);
  if (ctx.field === 'title') {
    insertAt(id, 0, nid);
  } else if (hasKids(id) && isExpandedInView(id)) {
    insertAt(id, 0, nid);
  } else {
    insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id) + 1, nid);
  }
  renderPage();
  elById.get(nid)?.classList.add('entering');
  focusItem(nid, 'text', 0);
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

function opMergeBack(ctx) {
  const { el, id } = ctx;
  const n = N(id);
  commitActiveText();
  const prevEl = visiblePrevNextContent(el, -1);
  if (!prevEl) return;
  const prevCtx = editableCtx(prevEl);
  const isEmpty = !plainOf(n.text).length && !hasKids(id) && (n.note === null || n.note === undefined || n.note === '');

  if (prevCtx.field === 'title') {
    if (isEmpty) {
      snapshot();
      deleteSubtree(id);
      renderPage();
      setCaretOffset(zoomTitleEl, 'end');
      markDirty();
    }
    return;
  }

  const prev = N(prevCtx.id);
  if (isEmpty) {
    snapshot();
    deleteSubtree(id);
    renderPage();
    focusItem(prevCtx.id, 'text', 'end');
    markDirty();
    return;
  }
  snapshot();
  const joinAt = plainOf(prev.text).length;
  prev.text = prev.text + n.text;
  if (n.note) prev.note = prev.note ? prev.note + '\n' + n.note : n.note;
  const myKids = [...kidsOf(id)];
  if (parentOf(id) === prevCtx.id) {
    const arr = kidsOf(prevCtx.id);
    const idx = arr.indexOf(id);
    arr.splice(idx, 1, ...myKids);
    parentMap.delete(id);
    for (const k of myKids) parentMap.set(k, prevCtx.id);
  } else {
    detach(id);
    for (const k of myKids) { kidsOf(prevCtx.id).push(k); parentMap.set(k, prevCtx.id); }
  }
  N(id).children = [];
  delete doc.nodes[id];
  if (myKids.length) prev.collapsed = false;
  touch(prevCtx.id);
  renderPage();
  focusItem(prevCtx.id, 'text', joinAt);
  markDirty();
}

function opMergeForward(ctx) {
  const { el, id } = ctx;
  if (ctx.field === 'title') return;
  commitActiveText();
  const nextEl = visiblePrevNextContent(el, 1);
  if (!nextEl) return;
  const nextCtx = editableCtx(nextEl);
  if (!nextCtx || nextCtx.field === 'title') return;
  const me = N(id);
  const next = N(nextCtx.id);
  snapshot();
  const joinAt = plainOf(me.text).length;
  me.text = me.text + next.text;
  if (next.note) me.note = me.note ? me.note + '\n' + next.note : next.note;
  const theirKids = [...kidsOf(nextCtx.id)];
  if (parentOf(nextCtx.id) === id) {
    const arr = kidsOf(id);
    const idx = arr.indexOf(nextCtx.id);
    arr.splice(idx, 1, ...theirKids);
    parentMap.delete(nextCtx.id);
    for (const k of theirKids) parentMap.set(k, id);
  } else {
    detach(nextCtx.id);
    for (const k of theirKids) { kidsOf(id).push(k); parentMap.set(k, id); }
  }
  next.children = [];
  delete doc.nodes[nextCtx.id];
  if (theirKids.length) me.collapsed = false;
  touch(id);
  renderPage();
  focusItem(id, 'text', joinAt);
  markDirty();
}

function opIndent(id, focus) {
  const p = parentOf(id);
  if (!p) return;
  const arr = kidsOf(p);
  const i = arr.indexOf(id);
  if (i <= 0) return;
  const newParent = arr[i - 1];
  commitActiveText();
  snapshot();
  N(newParent).collapsed = false;
  moveNode(id, newParent, kidsOf(newParent).length);
  renderPage();
  restoreFocus(focus);
  markDirty();
}

function opOutdent(id, focus) {
  const p = parentOf(id);
  if (!p || p === state.zoom) return;
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
  if (j < 0 || j >= arr.length) return;
  commitActiveText();
  snapshot();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderPage();
  restoreFocus(focus);
  markDirty();
}

function opToggleDone(id) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const n = N(id);
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
  if (!hasKids(id)) return;
  const want = collapse === undefined ? !n.collapsed : collapse;
  if (want === n.collapsed) return;
  commitActiveText();
  n.collapsed = want;
  markDirty();
  const item = elById.get(id);
  if (!item || fmtOf(id) === 'board') { renderPage(); return; }
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

function opDelete(id, { toast = true } = {}) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const n = N(id);
  const label = plainOf(n.text).trim() || 'item';
  const count = countDescendants(id);
  const item = elById.get(id);
  const nf = neighborFocus(item);

  // move to trash before removing
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
    showToast(`Deleted “${label.slice(0, 40)}”${count ? ` and ${count} sub-item${count === 1 ? '' : 's'}` : ''}`,
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
  const id = ctx.id;
  const n = N(id);
  commitActiveText();
  if (n.note === null || n.note === undefined) {
    snapshot();
    n.note = '';
    markDirty();
  }
  if (id === state.zoom) {
    renderZoomHead();
    setCaretOffset(zoomNoteEl, 'end');
    return;
  }
  const item = elById.get(id);
  if (item && !item.querySelector(':scope > .note')) {
    item.querySelector(':scope > .row').after(buildNoteEl(n.note));
  }
  focusItem(id, 'note', 'end');
}

function opRemoveNote(id) {
  const n = N(id);
  if (n.note === null || n.note === undefined) return;
  snapshot();
  n.note = null;
  markDirty();
  if (id === state.zoom) { renderZoomHead(); setCaretOffset(zoomTitleEl, 'end'); return; }
  const item = elById.get(id);
  item?.querySelector(':scope > .note')?.remove();
  focusItem(id, 'text', 'end');
}

function opSetFormat(id, fmt, { focus = true } = {}) {
  if (state.readOnly) return;
  commitActiveText();
  snapshot();
  const n = N(id);
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
  const mid = makeNode('', { mirror: target });
  insertAt(parentOf(id), kidsOf(parentOf(id)).indexOf(id) + 1, mid);
  renderPage();
  elById.get(mid)?.classList.add('entering');
  markDirty();
  showToast('Mirror created — it stays in sync with the original');
}

function opSort(id, dir) {
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

function setCollapseAll(collapsed) {
  commitActiveText();
  snapshot();
  const stack = [...kidsOf(state.zoom)];
  while (stack.length) {
    const id = stack.pop();
    if (hasKids(id)) N(id).collapsed = collapsed;
    stack.push(...kidsOf(id));
  }
  renderPage();
  markDirty();
}

/* ---------------- 13. zoom & routing ---------------- */

function zoomTo(id) {
  if (!doc.nodes[id]) id = HOME;
  if (SHARE_TOKEN && id !== HOME && !isAncestor(HOME, id)) id = HOME;
  if (id === state.zoom) return;
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

function applyHash() {
  const m = location.hash.match(/^#\/n\/([A-Za-z0-9]+)/);
  let target = m && doc.nodes[m[1]] ? m[1] : HOME;
  if (SHARE_TOKEN && target !== HOME && !isAncestor(HOME, target)) target = HOME;
  if (target === state.zoom) return;

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
  for (const id of selIds()) elById.get(id)?.classList.add('selected');
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
    for (const id of ids) deleteSubtree(id);
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
    for (const id of ids) { N(id).done = !allDone; touch(id); }
    renderPage();
    state.sel = sel;
    selRender();
    markDirty();
    return true;
  }
  if (mod && (e.key === 'c' || e.key === 'C')) return true;
  if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); return true; }
  if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) return false;
  if (e.key.length === 1 && !mod && !e.altKey) {
    e.preventDefault();
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
  if (!$('#calendar-overlay').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); $('#calendar-overlay').hidden = true; }
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
  if (mod && e.key === "'") { e.preventDefault(); zoomTo(HOME); return; }
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
      setSearch('');
      searchEl.blur();
      const first = editables()[0];
      if (first) setCaretOffset(first, 'end');
    }
    if (e.key === 'Enter') searchEl.blur();
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
      const map = { '#': 'h1', '##': 'h2', '###': 'h3', '>': 'quote', '[]': 'todo' };
      let fmt = map[before];
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
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0 };
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
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0 };
    opMoveVert(id, e.key === 'ArrowDown' ? 1 : -1, focus);
    return;
  }
  if (e.altKey && e.shiftKey && (e.key === '9' || e.key === '0') && !isTitle) {
    e.preventDefault();
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0 };
    opMoveVert(id, e.key === '0' ? 1 : -1, focus);
    return;
  }

  /* ----- indent aliases ----- */
  if (e.altKey && e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !isTitle && field !== 'zoom-note') {
    e.preventDefault();
    const focus = { id, field, offset: caretOffsetIn(el) ?? 0 };
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

  /* ----- select whole item ----- */
  if (mod && (e.key === 'a' || e.key === 'A') && !isTitle && !isNote) {
    const sel = getSelection();
    const allSelected = sel.rangeCount &&
      sel.toString().replace(/ /g, ' ') === (el.textContent || '').replace(/ /g, ' ') &&
      textLen(el) > 0;
    if (allSelected || textLen(el) === 0) {
      e.preventDefault();
      selEnter(id);
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

  /* ----- vertical navigation ----- */
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.altKey && !e.shiftKey) {
    const info = caretLineInfo(el);
    const up = e.key === 'ArrowUp';
    if ((up && info.first) || (!up && info.last)) {
      const list = editables();
      const i = list.indexOf(el);
      const target = list[i + (up ? -1 : 1)];
      if (target) {
        e.preventDefault();
        const x = navGoalX ?? info.x;
        navGoalX = x;
        setCaretAtX(target, x, up ? 'last' : 'first');
        target.scrollIntoView({ block: 'nearest' });
      } else if (!up && (isTitle || field === 'zoom-note') && !state.readOnly && !kidsOf(state.zoom).length) {
        // ArrowDown off the header of an empty page starts the first bullet
        e.preventDefault();
        opNewAt(state.zoom, 0);
      }
    }
    return;
  }

  /* ----- horizontal hop ----- */
  if (e.key === 'ArrowLeft' && !mod && !e.altKey && !e.shiftKey) {
    const sel = getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed && caretOffsetIn(el) === 0) {
      const list = editables();
      const target = list[list.indexOf(el) - 1];
      if (target) { e.preventDefault(); setCaretOffset(target, 'end'); }
    }
    return;
  }
  if (e.key === 'ArrowRight' && !mod && !e.altKey && !e.shiftKey) {
    const sel = getSelection();
    if (sel.rangeCount && sel.getRangeAt(0).collapsed && caretOffsetIn(el) === textLen(el)) {
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
  if ((ctx.field === 'note' || ctx.field === 'zoom-note') && doc.nodes[ctx.id]) {
    const n = N(ctx.id);
    if (n.note === '' && document.activeElement !== ctx.el) {
      n.note = null;
      markDirty();
      if (ctx.field === 'zoom-note') { zoomNoteEl.hidden = true; }
      else ctx.el.remove();
    }
  }
});

treeEl.addEventListener('dragstart', e => e.preventDefault());

/* ---------------- 17. clicks ---------------- */

treeEl.addEventListener('click', e => {
  const tag = e.target.closest('.tag');
  if (tag) {
    e.preventDefault();
    setSearch(tag.dataset.tag, { append: e.shiftKey || e.ctrlKey });
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
  const mirrorContent = e.target.closest('.item.is-mirror > .row .content');
  if (mirrorContent) {
    const id = mirrorContent.closest('.item').dataset.id;
    const t = mirrorTarget(id);
    if (t) zoomTo(t);
    return;
  }
  if (state.sel && !e.target.closest('.item.selected')) selClear();
});

zoomHeadEl.addEventListener('click', e => {
  const tag = e.target.closest('.tag');
  if (tag) { e.preventDefault(); setSearch(tag.dataset.tag, { append: e.shiftKey || e.ctrlKey }); }
});

emptyHintEl.addEventListener('click', () => {
  if (!kidsOf(state.zoom).length && !state.readOnly) {
    opNewAt(state.zoom, 0);
  }
});

pageEl.addEventListener('click', e => {
  if (e.target !== pageEl || state.readOnly) return;
  const kids = kidsOf(state.zoom);
  if (!kids.length) { opNewAt(state.zoom, 0); return; }
  const last = editables().filter(x => x.classList.contains('content')).pop();
  if (last) {
    const c = editableCtx(last);
    if (c && !plainOf(N(c.id).text).length) { setCaretOffset(last, 'end'); return; }
  }
  opNewAt(state.zoom, kids.length);
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
    if (!plainOf(n.text).length && !hasKids(id)) {
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
  const bullet = e.target.closest('.bullet');
  if (!bullet || e.button !== 0) return;
  const item = bullet.closest('.item');
  const id = item.dataset.id;
  const isTouch = e.pointerType === 'touch';
  drag = {
    id, started: false, allowed: !isTouch && !state.readOnly,
    startX: e.clientX, startY: e.clientY,
    pointerId: e.pointerId, ghost: null, target: null,
  };
  if (isTouch && !state.readOnly) {
    drag.holdTimer = setTimeout(() => { if (drag) drag.allowed = true; }, 350);
  }
  try { bullet.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
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
    const id = drag.id;
    drag = null;
    zoomTo(isMirror(id) ? (mirrorTarget(id) || id) : id);
    return;
  }
  finishDrag();
});

document.addEventListener('pointercancel', () => { if (drag) cancelDrag(); });

function startDrag(e) {
  commitActiveText();
  drag.started = true;
  document.body.classList.add('dragging-item');
  const item = elById.get(drag.id);
  item?.classList.add('dragging');
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  const count = countDescendants(drag.id);
  ghost.textContent = plainOf(N(drag.id).text).trim() || (isMirror(drag.id) ? 'mirror' : 'Untitled');
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
      if (expandedKids && isExpandedInView(id) && hasKids(id)) {
        target = { parent: id, index: 0, top: rc.bottom, left: contentLeftOf(id) + 12 };
      } else if (x > contentLeftOf(id) + 16 && !isMirror(id)) {
        target = { parent: id, index: kidsOf(id).length, top: rc.bottom, left: contentLeftOf(id) + 12 };
      } else {
        let cur = id;
        while (true) {
          const p = parentOf(cur);
          if (!p || p === state.zoom) break;
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

function closeAllPopovers() {
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
    const close = ev => {
      if (!pop.contains(ev.target)) { closeAllPopovers(); document.removeEventListener('mousedown', close); }
    };
    document.addEventListener('mousedown', close);
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

function renderJump(q) {
  jumpItems = searchNodes(q);
  jumpActive = 0;
  jumpResults.innerHTML = '';
  if (!jumpItems.length) {
    jumpResults.innerHTML = '<div class="jump-empty">Nothing found.</div>';
    return;
  }
  jumpItems.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'jump-row' + (i === 0 ? ' active' : '');
    b.innerHTML = `<div class="jr-text${it.done ? ' done' : ''}">${escHtml(it.plain.slice(0, 90))}</div>` +
      (it.path ? `<div class="jr-path">${escHtml(it.path)}</div>` : '');
    b.addEventListener('click', () => { hideJump(); zoomTo(it.id); });
    jumpResults.append(b);
  });
}

jumpInput.addEventListener('input', () => renderJump(jumpInput.value));

function jumpKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); hideJump(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!jumpItems.length) return;
    jumpActive = clamp(jumpActive + (e.key === 'ArrowDown' ? 1 : -1), 0, jumpItems.length - 1);
    $$('.jump-row', jumpResults).forEach((el, i) => el.classList.toggle('active', i === jumpActive));
    $$('.jump-row', jumpResults)[jumpActive]?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const it = jumpItems[jumpActive];
    if (it) { hideJump(); zoomTo(it.id); }
  }
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
    ['Go home', "Ctrl+'"],
    ['Expand / collapse', 'Ctrl+↓ / Ctrl+↑'],
    ['Jump anywhere', 'Ctrl+K'],
    ['Star this page', 'Ctrl+Shift+8'],
    ['Show / hide completed', 'Ctrl+O'],
  ]],
  ['Selection & misc', [
    ['Select item', 'Ctrl+A twice'],
    ['Extend selection', 'Shift+↑ ↓'],
    ['Quick capture to Inbox', 'Ctrl+Shift+Space'],
    ['Undo / redo', 'Ctrl+Z / Ctrl+Shift+Z'],
    ['Filter by tag', 'click · Shift+click adds'],
    ['Search operators', '"…" -x OR is: has: changed:'],
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

function subtreeToText(id, depth) {
  const n = N(id);
  let out = '  '.repeat(depth) + '- ' + plainOf(n.text) + (n.done ? ' ✓' : '') + '\n';
  if (n.note) out += n.note.split('\n').map(l => '  '.repeat(depth + 1) + l).join('\n') + '\n';
  for (const c of n.children) out += subtreeToText(c, depth + 1);
  return out;
}

function subtreeToMarkdown(id, depth) {
  const n = N(id);
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
  for (const c of n.children) out += subtreeToMarkdown(c, depth + 1);
  return out;
}

function subtreeToOpml(id) {
  const n = N(id);
  const attrs = [`text="${escAttr(plainOf(n.text))}"`];
  if (n.note) attrs.push(`_note="${escAttr(n.note)}"`);
  if (n.done) attrs.push(`_complete="true"`);
  if (!n.children.length) return `<outline ${attrs.join(' ')}/>`;
  return `<outline ${attrs.join(' ')}>${n.children.map(subtreeToOpml).join('')}</outline>`;
}

function download(name, mime, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportDoc(format) {
  commitActiveText();
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    download(`tendril-${stamp}.json`, 'application/json', JSON.stringify(doc, null, 1));
  } else if (format === 'txt') {
    download(`tendril-${stamp}.txt`, 'text/plain',
      kidsOf(HOME).map(id => subtreeToText(id, 0)).join(''));
  } else if (format === 'md') {
    download(`tendril-${stamp}.md`, 'text/plain',
      kidsOf(HOME).map(id => subtreeToMarkdown(id, 0)).join('\n'));
  } else if (format === 'opml') {
    const body = kidsOf(HOME).map(subtreeToOpml).join('\n');
    download(`tendril-${stamp}.opml`, 'text/xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Tendril export</title></head><body>\n${body}\n</body></opml>`);
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
      doc = sanitizeDocTexts(incoming); // also normalizes missing children arrays
      rebuildParentMap();
      state.zoom = HOME;
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
      renderPage();
      markDirty();
      showToast(`Imported ${count} top-level item${count === 1 ? '' : 's'} from OPML`);
    } else {
      const forest = parseIndentedText(text);
      if (!forest.length) throw new Error('no items found');
      snapshot();
      materializeForest(forest, state.zoom);
      renderPage();
      markDirty();
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

pageEl.addEventListener('focusin', e => {
  const ctx = editableCtx(e.target);
  if (ctx && ctx.field !== 'title' && ctx.field !== 'zoom-note') lastItemId = ctx.id;
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
  const w = add(ROOT, 'Welcome to <b>Tendril</b> 🌱');
  add(w, 'This is an infinite outline. Every bullet can hold a whole world inside it.');
  const basics = add(w, 'The basics', { collapsed: false });
  add(basics, 'Press <b>Enter</b> to make a new item, <b>Tab</b> to indent, <b>Shift+Tab</b> to outdent');
  add(basics, 'Click a bullet — or press <b>Alt+→</b> — to zoom into it. <b>Alt+←</b> zooms back out');
  add(basics, 'Press <b>Shift+Enter</b> to attach a note to an item', { note: 'Notes look like this. They can run as long as you like.' });
  add(basics, 'Press <b>Ctrl+Enter</b> to complete something', { done: true });
  add(basics, 'Drag any bullet to reorganize. Drop it deeper or shallower by moving sideways');
  const power = add(w, 'Power moves', { collapsed: true });
  add(power, 'Tag things with #tags and @people, then click a tag to filter');
  add(power, '<b>Ctrl+K</b> jumps to any item by name');
  add(power, 'Type <b>/</b> for block types: headings, to-dos, numbered lists, boards, code, dividers…');
  add(power, 'Type a date in plain words — <b>today</b>, <b>next friday</b>, <b>oct 7</b>, <b>in 3 days</b> — then press <b>Tab</b>');
  add(power, 'Type <b>[[</b> to link to any other item; links show up under “Linked from”');
  add(power, '<b>Ctrl+A</b> twice selects whole items — then Tab, move, complete or delete in bulk');
  add(power, 'Select text to format it — colors and highlights included');
  add(power, 'Search supports <code>"phrases"</code>, <code>-not</code>, <code>OR</code>, <code>is:complete</code>, <code>has:note</code>, <code>changed:7d</code>…');
  const sample = add(ROOT, 'Try it: plan something #example', { collapsed: true });
  add(sample, 'A trip, a project, an essay…');
  add(sample, 'Zoom in here and make it yours');
  return d;
}

/* ---------------- 27. login & bootstrap (init lives in app2.js) ---------------- */

async function ensureAuth() {
  const info = await (await fetch('/api/auth')).json();
  state.authRequired = info.required;
  state.aiEnabled = !!info.ai;
  if (!info.required || info.ok) return;
  const screen = $('#login-screen');
  screen.hidden = false;
  if (info.totp) $('#login-code').hidden = false;
  $('#login-password').focus();
  await new Promise(resolve => {
    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#login-error');
      err.hidden = true;
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#login-password').value, code: $('#login-code').value }),
      });
      if (res.ok) { screen.hidden = true; resolve(); }
      else {
        err.textContent = (await res.json()).error || 'Wrong password';
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
  const data = await (await fetch('/api/doc')).json();
  if (data.doc && data.doc.nodes && data.doc.nodes[data.doc.root || ROOT]) {
    doc = data.doc;
    doc.root = doc.root || ROOT;
    state.version = data.version || 0;
    sanitizeDocTexts(doc);
    rebuildParentMap();
  } else {
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
