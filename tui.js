#!/usr/bin/env node
'use strict';
/*
 * rz-tui — proof-of-concept ncurses-style terminal client for Rhizome.
 * Zero dependencies, Node 22+, raw ANSI (alt screen, box drawing, reverse-video bars).
 * Talks to the /api/v1 node REST API — auth via a per-graph rzk_… API key
 * (Account → API keys), the instance RHIZOME_AGENT_TOKEN, or an open instance.
 *
 *   RHIZOME_URL=http://localhost:3000 RHIZOME_TOKEN=<rzk_… key or agent token> node tui.js
 *
 *   Tab focus panes · j/k/↑/↓ move · Enter open page / zoom into node · u/Backspace zoom out
 *   h/l collapse/expand · Space toggle done · e edit · o new sibling · O new child
 *   d delete (confirm) · / search · r refresh · g/G top/bottom · q quit
 *
 *   --smoke renders one frame to stdout and exits (for testing without a TTY).
 */

const BASE = (process.env.RHIZOME_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.RHIZOME_TOKEN || '';
const SMOKE = process.argv.includes('--smoke');

// ---------------------------------------------------------------- api client

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + path, { ...opts, headers });
  if (!res.ok) {
    let msg = res.status + '';
    try { msg += ' ' + ((await res.json()).error || ''); } catch { /* not json */ }
    throw new Error(msg.trim());
  }
  return res.json();
}

const plain = html => String(html || '').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- state

const S = {
  doc: null, version: 0, parent: {},          // doc + parent map
  pages: [], pageSel: 0, pageScroll: 0,       // left pane
  zoom: [],                                   // outline zoom stack (node ids, under page)
  rows: [], sel: 0, scroll: 0,                // right pane (visible rows)
  expand: new Set(), collapse: new Set(),     // local overrides of node.collapsed
  focus: 'pages',                             // 'pages' | 'outline'
  mode: 'normal',                             // 'normal' | 'input' | 'confirm' | 'results'
  input: null,                                // {label, value, cursor, submit(value)}
  confirm: null,                              // {label, yes()}
  results: null,                              // {items, sel}
  msg: '',
};

const node = id => S.doc?.nodes?.[id];
// mirrors: content (text/note/done) lives on the owner node
const content = id => { const n = node(id); return n?.mirror && node(n.mirror) ? node(n.mirror) : n; };
const title = id => plain(content(id)?.text) || 'Untitled';

function indexDoc() {
  S.parent = {};
  for (const [id, n] of Object.entries(S.doc.nodes)) {
    for (const c of n.children || []) S.parent[c] = id;
  }
  S.pages = (node(S.doc.root)?.children || []).filter(id => node(id));
}

async function loadDoc() {
  const { version, doc } = await api('/api/v1/doc');
  S.doc = doc; S.version = version;
  indexDoc();
  if (S.pageSel >= S.pages.length) S.pageSel = Math.max(0, S.pages.length - 1);
  S.zoom = S.zoom.filter(id => node(id));
  buildRows();
}

// ---------------------------------------------------------------- outline rows

const outlineRoot = () => S.zoom.length ? S.zoom[S.zoom.length - 1] : S.pages[S.pageSel];
const isCollapsed = id =>
  S.collapse.has(id) ? true : S.expand.has(id) ? false : !!node(id)?.collapsed;

function buildRows(keepId) {
  keepId = keepId ?? S.rows[S.sel]?.id;
  S.rows = [];
  const walk = (id, depth) => {
    if (!node(id)) return;
    S.rows.push({ id, depth });
    if (!isCollapsed(id)) for (const c of node(id).children || []) walk(c, depth + 1);
  };
  for (const c of node(outlineRoot())?.children || []) walk(c, 0);
  const i = S.rows.findIndex(r => r.id === keepId);
  S.sel = i >= 0 ? i : Math.min(S.sel, Math.max(0, S.rows.length - 1));
}

function revealNode(id) {
  // expand every ancestor, select the page it lives under, put selection on it
  const chain = [];
  for (let p = S.parent[id]; p && p !== S.doc.root; p = S.parent[p]) chain.push(p);
  const top = chain.length ? chain[chain.length - 1] : id;
  const pi = S.pages.indexOf(top);
  if (pi >= 0) S.pageSel = pi;
  S.zoom = [];
  for (const a of chain) { S.expand.add(a); S.collapse.delete(a); }
  buildRows(id);
  S.focus = 'outline';
}

// ---------------------------------------------------------------- actions

const wrap = fn => (...a) => Promise.resolve(fn(...a))
  .catch(e => { S.msg = '✗ ' + e.message; })
  .then(draw);

const refresh = wrap(async () => { await loadDoc(); S.msg = 'refreshed (v' + S.version + ')'; });

const toggleDone = wrap(async () => {
  const id = S.rows[S.sel]?.id; if (!id) return;
  await api(`/api/v1/nodes/${id}/complete`, { method: 'POST', body: JSON.stringify({ done: !content(id).done }) });
  await loadDoc();
});

function editSelected() {
  const id = S.rows[S.sel]?.id; if (!id) return;
  openInput('edit', plain(content(id).text), wrap(async v => {
    await api(`/api/v1/nodes/${id}`, { method: 'PATCH', body: JSON.stringify({ text: escapeHtml(v) }) });
    await loadDoc();
  }));
}

function addNode(asChild) {
  const cur = S.rows[S.sel];
  let parent = outlineRoot(), index;
  if (cur && asChild) { parent = cur.id; index = 0; }
  else if (cur) {
    parent = S.parent[cur.id] ?? outlineRoot();
    index = (node(parent).children || []).indexOf(cur.id) + 1;
  }
  openInput(asChild ? 'new child' : 'new item', '', wrap(async v => {
    if (!v.trim()) return;
    const created = await api('/api/v1/nodes', { method: 'POST', body: JSON.stringify({ parent, index, text: escapeHtml(v) }) });
    if (asChild && cur) { S.expand.add(cur.id); S.collapse.delete(cur.id); }
    await loadDoc(); buildRows(created.id);
  }));
}

function deleteSelected() {
  const id = S.rows[S.sel]?.id; if (!id) return;
  S.mode = 'confirm';
  S.confirm = {
    label: `delete "${fit(title(id), 40).trimEnd()}" + subtree? [y/n]`,
    yes: wrap(async () => {
      await api('/api/v1/nodes/' + id, { method: 'DELETE' });
      await loadDoc();
    }),
  };
}

function startSearch() {
  openInput('search', '', wrap(async q => {
    if (!q.trim()) return;
    const { results } = await api('/api/v1/search?q=' + encodeURIComponent(q) + '&limit=50');
    if (!results.length) { S.msg = 'no matches for "' + q + '"'; return; }
    S.mode = 'results'; S.results = { items: results, sel: 0 };
  }));
}

// ---------------------------------------------------------------- prompt / input

function openInput(label, value, submit) {
  S.mode = 'input';
  S.input = { label, value, cursor: [...value].length, submit };
}

function inputKey(key) {
  const inp = S.input, cs = [...inp.value];
  if (key.name === 'escape') { S.mode = 'normal'; S.input = null; }
  else if (key.name === 'enter') { S.mode = 'normal'; const { value, submit } = inp; S.input = null; submit(value); return; }
  else if (key.name === 'left') inp.cursor = Math.max(0, inp.cursor - 1);
  else if (key.name === 'right') inp.cursor = Math.min(cs.length, inp.cursor + 1);
  else if (key.name === 'home') inp.cursor = 0;
  else if (key.name === 'end') inp.cursor = cs.length;
  else if (key.name === 'backspace') { if (inp.cursor > 0) { cs.splice(inp.cursor - 1, 1); inp.cursor--; inp.value = cs.join(''); } }
  else if (key.name === 'delete') { if (inp.cursor < cs.length) { cs.splice(inp.cursor, 1); inp.value = cs.join(''); } }
  else if (key.ch) { cs.splice(inp.cursor, 0, key.ch); inp.cursor += [...key.ch].length; inp.value = cs.join(''); }
  draw();
}

// ---------------------------------------------------------------- key handling

function parseKeys(buf) {
  // split a raw stdin chunk into key events {name?, ch?}
  const s = buf.toString('utf8'), keys = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const rest = s.slice(i);
      const m = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/) || rest.match(/^\x1bO([A-Z])/);
      if (m) {
        const code = m[2] || m[1];
        const name = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
          '~': { 1: 'home', 3: 'delete', 4: 'end', 5: 'pgup', 6: 'pgdn' }[m[1]] }[code];
        if (name) keys.push({ name });
        i += m[0].length; continue;
      }
      keys.push({ name: 'escape' }); i++; continue;
    }
    const c = s[i];
    if (c === '\r' || c === '\n') keys.push({ name: 'enter' });
    else if (c === '\x7f' || c === '\b') keys.push({ name: 'backspace' });
    else if (c === '\t') keys.push({ name: 'tab' });
    else if (c === '\x03') keys.push({ name: 'ctrl-c' });
    else if (c >= ' ') keys.push({ ch: c });
    i++;
  }
  return keys;
}

function onKey(key) {
  S.msg = '';
  if (key.name === 'ctrl-c') return quit();
  if (S.mode === 'input') return inputKey(key);

  if (S.mode === 'confirm') {
    const c = S.confirm; S.mode = 'normal'; S.confirm = null;
    if (key.ch === 'y' || key.ch === 'Y') return c.yes();
    return draw();
  }

  if (S.mode === 'results') {
    const r = S.results;
    if (key.name === 'escape' || key.ch === 'q') { S.mode = 'normal'; S.results = null; }
    else if (key.name === 'down' || key.ch === 'j') r.sel = Math.min(r.items.length - 1, r.sel + 1);
    else if (key.name === 'up' || key.ch === 'k') r.sel = Math.max(0, r.sel - 1);
    else if (key.name === 'enter') { S.mode = 'normal'; revealNode(r.items[r.sel].id); S.results = null; }
    return draw();
  }

  // normal mode
  if (key.ch === 'q') return quit();
  if (key.ch === 'r') return refresh();
  if (key.ch === '/') { startSearch(); return draw(); }
  if (key.name === 'tab') { S.focus = S.focus === 'pages' ? 'outline' : 'pages'; return draw(); }

  if (S.focus === 'pages') {
    if (key.name === 'down' || key.ch === 'j') S.pageSel = Math.min(S.pages.length - 1, S.pageSel + 1);
    else if (key.name === 'up' || key.ch === 'k') S.pageSel = Math.max(0, S.pageSel - 1);
    else if (key.ch === 'g' || key.name === 'home') S.pageSel = 0;
    else if (key.ch === 'G' || key.name === 'end') S.pageSel = S.pages.length - 1;
    else if (key.name === 'enter' || key.ch === 'l' || key.name === 'right') { S.zoom = []; S.focus = 'outline'; }
    if (['down', 'up', 'home', 'end'].includes(key.name) || 'jkgG'.includes(key.ch || '·')) { S.zoom = []; S.sel = 0; S.scroll = 0; }
    buildRows();
    return draw();
  }

  // outline pane
  const cur = S.rows[S.sel];
  if (key.name === 'down' || key.ch === 'j') S.sel = Math.min(S.rows.length - 1, S.sel + 1);
  else if (key.name === 'up' || key.ch === 'k') S.sel = Math.max(0, S.sel - 1);
  else if (key.name === 'pgdn') S.sel = Math.min(S.rows.length - 1, S.sel + contentHeight());
  else if (key.name === 'pgup') S.sel = Math.max(0, S.sel - contentHeight());
  else if (key.ch === 'g' || key.name === 'home') S.sel = 0;
  else if (key.ch === 'G' || key.name === 'end') S.sel = Math.max(0, S.rows.length - 1);
  else if (key.ch === 'l' || key.name === 'right') { if (cur) { S.expand.add(cur.id); S.collapse.delete(cur.id); buildRows(); } }
  else if (key.ch === 'h' || key.name === 'left') {
    if (cur && (node(cur.id).children || []).length && !isCollapsed(cur.id)) { S.collapse.add(cur.id); S.expand.delete(cur.id); buildRows(); }
    else if (cur && cur.depth > 0) buildRows(S.parent[cur.id]);
    else S.focus = 'pages';
  }
  else if (key.name === 'enter') { if (cur && (node(cur.id).children || []).length) { S.zoom.push(cur.id); S.sel = 0; S.scroll = 0; buildRows(); } }
  else if (key.ch === 'u' || key.name === 'backspace') {
    if (S.zoom.length) { const from = S.zoom.pop(); buildRows(from); } else S.focus = 'pages';
  }
  else if (key.ch === ' ') return toggleDone();
  else if (key.ch === 'e') { editSelected(); }
  else if (key.ch === 'o') { addNode(false); }
  else if (key.ch === 'O') { addNode(true); }
  else if (key.ch === 'd') { deleteSelected(); }
  draw();
}

// ---------------------------------------------------------------- drawing

const out = process.stdout;
const cols = () => out.columns || 80;
const rowsN = () => out.rows || 24;
const contentHeight = () => rowsN() - 3;

const REV = '\x1b[7m', DIM = '\x1b[2m', BOLD = '\x1b[1m', DONE = '\x1b[2;9m', RESET = '\x1b[0m';

function fit(s, w) {
  const c = [...String(s).replace(/[\r\n\t]/g, ' ')];
  if (c.length > w) return c.slice(0, Math.max(0, w - 1)).join('') + (w > 0 ? '…' : '');
  return s + ' '.repeat(w - c.length);
}

function bullet(id) {
  const kids = (node(id).children || []).length;
  return kids ? (isCollapsed(id) ? '▸' : '▾') : '•';
}

function breadcrumb() {
  const parts = [title(S.pages[S.pageSel] || '')].concat(S.zoom.map(title));
  return parts.join(' › ');
}

function draw() {
  const W = cols(), H = rowsN(), CH = contentHeight();
  const PW = Math.max(16, Math.min(30, Math.floor(W * 0.28)));   // pages pane width
  const OW = W - PW - 1;                                          // outline pane width

  // keep selections scrolled into view
  S.pageScroll = Math.min(S.pageSel, Math.max(S.pageScroll, S.pageSel - CH + 1));
  S.scroll = Math.min(S.sel, Math.max(S.scroll, S.sel - CH + 1));

  const lines = [];
  const host = BASE.replace(/^https?:\/\//, '');
  lines.push(REV + fit(` rhizome ⌁ ${host}`, W - 10) + fit(`v${S.version} `, 10) + RESET);
  lines.push(BOLD + fit(' Pages', PW) + RESET + DIM + '│' + RESET + BOLD + fit(' ' + breadcrumb(), OW) + RESET);

  for (let i = 0; i < CH; i++) {
    // left: pages
    const pi = S.pageScroll + i;
    let left;
    if (pi < S.pages.length) {
      const id = S.pages[pi];
      const mark = node(id).cal ? '◷ ' : '▪ ';
      const selStyle = pi === S.pageSel ? (S.focus === 'pages' ? REV : BOLD) : '';
      left = selStyle + fit(' ' + mark + title(id), PW) + RESET;
    } else left = ' '.repeat(PW);

    // right: outline
    const ri = S.scroll + i;
    let right;
    if (ri < S.rows.length) {
      const { id, depth } = S.rows[ri];
      const n = content(id);
      const noteMark = n.note ? ' ≣' : '';
      const mirror = node(id).mirror ? DIM + ' ⧉' + RESET : '';
      let style = '';
      if (n.done) style += DONE;
      if (/^h[123]$/.test(n.format || '')) style += BOLD;
      const text = ' ' + '  '.repeat(depth) + bullet(id) + ' ' + (n.done ? '✓ ' : '') + plain(n.text) + noteMark;
      const selStyle = ri === S.sel && S.focus === 'outline' ? REV : '';
      right = selStyle + style + fit(text, OW) + RESET + mirror;
    } else right = ~~(ri) === 0 && !S.rows.length ? DIM + fit('   (empty page — press o to add an item)', OW) + RESET : ' '.repeat(OW);
    lines.push(left + DIM + '│' + RESET + right);
  }

  // status bar
  let bar;
  if (S.mode === 'input') bar = ` ${S.input.label}: ${S.input.value}`;
  else if (S.mode === 'confirm') bar = ' ' + S.confirm.label;
  else if (S.msg) bar = ' ' + S.msg;
  else bar = S.focus === 'pages'
    ? ' j/k move · Enter open · Tab outline · / search · r refresh · q quit'
    : ' j/k move · h/l fold · Enter zoom · u back · Spc done · e edit · o/O new · d del · / search · q quit';
  lines.push(REV + fit(bar, W) + RESET);

  out.write('\x1b[?25l\x1b[H' + lines.join('\r\n'));

  if (S.mode === 'results') drawResults(W, H);
  if (S.mode === 'input') {
    // real cursor into the prompt on the status bar
    const col = 2 + [...S.input.label].length + 2 + S.input.cursor;
    out.write(`\x1b[${H};${Math.min(col, W)}H\x1b[?25h`);
  }
}

function drawResults(W, H) {
  const r = S.results;
  const bw = Math.min(W - 6, 90);
  const bh = Math.min(r.items.length + 2, H - 6);
  const top = Math.floor((H - bh) / 2), leftC = Math.floor((W - bw) / 2);
  const inner = bw - 2;
  const put = (row, s) => out.write(`\x1b[${row};${leftC}H` + s);
  const view = Math.max(0, Math.min(r.sel - (bh - 3), r.items.length - (bh - 2)));

  put(top, '┌' + fit('─ search results (' + r.items.length + ') ', inner).replace(/ +$/, m => '─'.repeat(m.length)) + '┐');
  for (let i = 0; i < bh - 2; i++) {
    const it = r.items[view + i];
    let body = ' '.repeat(inner);
    if (it) {
      const t = ` ${it.done ? '✓ ' : ''}${it.plain}` + (it.path ? DIM + '  · ' + it.path : '');
      const styled = view + i === r.sel ? REV + fit(` ${it.done ? '✓ ' : ''}${it.plain}  · ${it.path}`, inner) + RESET
        : fit(t, inner + (it.path ? DIM.length : 0)) + RESET;
      body = styled;
    }
    put(top + 1 + i, '│' + body + '│');
  }
  put(top + bh - 1, '└' + fit(DIM + ' Enter jump · Esc close ' + RESET, inner + DIM.length + RESET.length).replace(/ +($|(?=\x1b\[0m$))/g, m => '─'.repeat(m.length)) + '┘');
}

// ---------------------------------------------------------------- lifecycle

function quit() {
  out.write('\x1b[?25h\x1b[?1049l');
  process.exit(0);
}

async function main() {
  try { await loadDoc(); } catch (e) {
    console.error(`rz-tui: cannot reach ${BASE}/api/v1 — ${e.message}`);
    console.error('       set RHIZOME_URL and RHIZOME_TOKEN (an rzk_… API key or the RHIZOME_AGENT_TOKEN)');
    process.exit(1);
  }

  if (SMOKE) { S.focus = 'outline'; buildRows(); draw(); out.write('\n'); process.exit(0); }

  out.write('\x1b[?1049h\x1b[2J\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', buf => { for (const k of parseKeys(buf)) onKey(k); });
  out.on('resize', draw);
  process.on('SIGTERM', quit);

  // light polling keeps the view live (SSE would be the non-PoC way)
  setInterval(async () => {
    try {
      const { version } = await api('/api/v1/version');
      if (version !== S.version && S.mode === 'normal') { await loadDoc(); draw(); }
    } catch { /* transient */ }
  }, 15000).unref();

  draw();
}

main();
