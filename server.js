/*
 * Rhizome — self-hostable, page-based outliner (a Roam-flavored fork of Tendril).
 * Zero-dependency Node.js server: static files + JSON document API + live sync.
 *
 *   node server.js
 *   node server.js --gen-totp     # generate a TOTP secret for MFA
 *
 * Environment (RHIZOME_* preferred; the legacy TENDRIL_* names still work as fallbacks):
 *   PORT                  port to listen on            (default 3000)
 *   HOST                  interface to bind            (default 0.0.0.0)
 *   DATA_DIR              where data is stored          (default ./data)
 *   RHIZOME_ADMIN_USER    bootstrapped admin username   (default phil)
 *   RHIZOME_ADMIN_PASSWORD if set, creates the admin on first run and requires login
 *   RHIZOME_INVITE_CODE   if set, self-registration requires this invite code
 *   RHIZOME_TOTP_SECRET   if set (base32), login additionally requires a TOTP code
 *   RHIZOME_CAPTURE_TOKEN if set, POST /api/capture with this token appends to today's Inbox
 *   RHIZOME_AGENT_TOKEN   if set, unlocks the per-node REST API at /api/v1 (Bearer or ?token=)
 *   ANTHROPIC_API_KEY     if set, enables the in-app "Ask AI" assistant
 *   RHIZOME_AI_MODEL      Claude model for Ask AI      (default claude-opus-4-8)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./db');
const { Accounts } = require('./accounts');
const { applyOpsToDoc } = require('./opsdoc');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOC_FILE = path.join(DATA_DIR, 'outline.json');
const DB_FILE = path.join(DATA_DIR, 'outline.db');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const FILES_DIR = path.join(DATA_DIR, 'files');
// RHIZOME_* preferred; legacy TENDRIL_* names still honored as fallbacks
const PASSWORD = process.env.RHIZOME_PASSWORD || process.env.TENDRIL_PASSWORD || '';
const TOTP_SECRET = process.env.RHIZOME_TOTP_SECRET || process.env.TENDRIL_TOTP_SECRET || '';
const CAPTURE_TOKEN = process.env.RHIZOME_CAPTURE_TOKEN || process.env.TENDRIL_CAPTURE_TOKEN || '';
const AGENT_TOKEN = process.env.RHIZOME_AGENT_TOKEN || process.env.TENDRIL_AGENT_TOKEN || '';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.RHIZOME_AI_MODEL || process.env.TENDRIL_AI_MODEL || 'claude-opus-4-8';
// multi-user: registration invite gate + first-run admin account
const INVITE_CODE = process.env.RHIZOME_INVITE_CODE || '';
const ADMIN_USER = process.env.RHIZOME_ADMIN_USER || 'phil';
const ADMIN_PASSWORD = process.env.RHIZOME_ADMIN_PASSWORD || PASSWORD || '';
const SESSION_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_UPLOAD = 32 * 1024 * 1024;
const BACKUP_EVERY_MS = 60 * 60 * 1000;
const BACKUP_KEEP = 40;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
};

/* ---------- TOTP (RFC 6238, zero-dep) ---------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s) {
  s = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpCode(secret, step) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

function totpValid(secret, code) {
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now, now - 1, now + 1]) {
    if (timingSafeEq(totpCode(secret, step), String(code || '').trim())) return true;
  }
  return false;
}

if (process.argv.includes('--gen-totp')) {
  const raw = crypto.randomBytes(20);
  let secret = '';
  let bits = 0, value = 0;
  for (const byte of raw) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { secret += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  console.log('TOTP secret (set as RHIZOME_TOTP_SECRET):\n  ' + secret);
  console.log('\nAdd to your authenticator app with this URI:');
  console.log(`  otpauth://totp/Rhizome?secret=${secret}&issuer=Rhizome`);
  process.exit(0);
}

/* ---------- storage ---------- */

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

// Accounts (users, sessions, graphs, memberships) — separate DB from the doc store.
const accounts = new Accounts(path.join(DATA_DIR, 'accounts.db'));
// first run with an admin password configured bootstraps the admin account
if (accounts.userCount() === 0 && ADMIN_PASSWORD) {
  const u = accounts.createUser(ADMIN_USER, ADMIN_PASSWORD, true);
  console.log(`Created admin account "${u.username}"`);
}
// keep the configured admin flagged as admin (covers accounts created before is_admin existed)
const adminRow = accounts.userByName(ADMIN_USER);
if (adminRow && !adminRow.is_admin) accounts.setAdmin(adminRow.id, true);
// every user owns at least one graph; the admin's existing single-graph data migrates into
// theirs in the doc layer (Phase 2). Give the admin their graph up front.
if (adminRow && accounts.graphsForUser(adminRow.id).length === 0) {
  accounts.createGraph('Rhizome', adminRow.id);
}

/**
 * The outline's data model — one flat node map; the tree lives in the children id-arrays.
 * @typedef {Object} Node
 * @property {string} id
 * @property {string} text
 * @property {string|null} [note]
 * @property {boolean} [done]
 * @property {boolean} [collapsed]
 * @property {string[]} children
 * @property {string} [format]
 * @property {string} [mirror]
 * @property {Array<{url:string,name?:string,type?:string}>} [files]
 * @property {Array<object>} [comments]
 * @property {number} [c]
 * @property {number} [m]
 *
 * @typedef {Object} Doc
 * @property {string} root
 * @property {Record<string, Node>} nodes
 * @property {Array<{ts:number,parent:string|null,index:number,root:string,nodes:Record<string,Node>}>} [trash]
 * @property {{stars?:string[], calendar?:string}} [meta]
 *
 * @typedef {{ version:number, doc:Doc|null }} DocStore
 */

/* ---------- global (cross-graph) state ----------
 * Uploaded files and share links stay global: files are content-addressed by a unique name,
 * and a share record carries the graph id it points into. Only the document itself — nodes,
 * op-log, SSE clients and backups — is isolated per graph (see GraphContext below).
 */
let shares = {};
try { shares = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); } catch { /* none */ }
function persistShares() {
  fs.writeFileSync(SHARES_FILE, JSON.stringify(shares, null, 1));
}

/* ---------- per-graph runtime (Phase 2) ----------
 * A GraphContext bundles one graph's isolated state; getGraph(id) loads/caches it. The doc
 * layer, persistence and sync all take a context `g` — no shared mutable document globals.
 */
const GRAPHS_DIR = path.join(DATA_DIR, 'graphs');
fs.mkdirSync(GRAPHS_DIR, { recursive: true });
const SEEN_MAX = 20000;
const graphCache = new Map(); // graphId → GraphContext

function loadGraph(id) {
  const dir = path.join(GRAPHS_DIR, id);
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const db = new Store(path.join(dir, 'outline.db'));
  const store = db.isEmpty() ? { version: 0, doc: null } : /** @type {DocStore} */ (db.loadDoc());
  let lastBackupAt = 0;
  try {
    const es = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
    if (es.length) lastBackupAt = fs.statSync(path.join(backupDir, es[es.length - 1])).mtimeMs;
  } catch { /* none */ }
  return { id, dir, backupDir, db, store, sse: new Set(), seenOps: new Set(), seenOrder: [], lastBackupAt };
}
function getGraph(id) {
  let g = graphCache.get(id);
  if (!g) { g = loadGraph(id); graphCache.set(id, g); }
  return g;
}

function maybeBackup(g) {
  const now = Date.now();
  if (now - g.lastBackupAt <= BACKUP_EVERY_MS) return;
  g.lastBackupAt = now;
  // a full reconcile before the snapshot: backups are always canonical, and any drift the
  // O(change) op path could have left (sparse ords, a mis-derived row) self-heals hourly.
  try { g.db.sync(g.store.doc, g.store.version); } catch (e) { console.error('pre-backup resync failed:', e); }
  try {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    g.db.backup(path.join(g.backupDir, `outline-${stamp}.db`));
    const all = fs.readdirSync(g.backupDir).filter(f => f.endsWith('.db')).sort();
    for (const stale of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
      try { fs.unlinkSync(path.join(g.backupDir, stale)); } catch { /* ignore */ }
    }
  } catch (e) { console.error('backup failed:', e); }
}

// whole-doc path (PUT, share merge, capture, v1 API): diff the full doc against the shadow
function persist(g) {
  try { g.db.sync(g.store.doc, g.store.version); maybeBackup(g); }
  catch (err) { console.error('persist failed:', err); }
}

// Route B hot path: persist only the rows the op batch touched (O(change)). If anything goes
// wrong, fall back to a full reconcile so disk can never silently diverge from memory.
function persistOps(g, ops) {
  try { g.db.applyOps(g.store.doc, g.store.version, ops); maybeBackup(g); }
  catch (err) {
    console.error('persistOps failed — falling back to full resync:', err);
    try { g.db.sync(g.store.doc, g.store.version); } catch (e2) { console.error('full resync failed:', e2); }
  }
}

/* ---------- live sync (SSE), per graph ---------- */

function broadcast(g, payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of g.sse) {
    try { res.write(msg); } catch { g.sse.delete(res); }
  }
}

setInterval(() => {
  for (const g of graphCache.values()) {
    for (const res of g.sse) { try { res.write(':hb\n\n'); } catch { g.sse.delete(res); } }
  }
}, 25000).unref();

function commitDoc(g, doc, origin) {
  g.store = { version: g.store.version + 1, doc };
  persist(g);
  broadcast(g, { version: g.store.version, origin });
  return g.store.version;
}

// commit after an op-batch: same version bump + persist, but broadcast the applied ops
// (tagged with the originating device) so peers converge by replaying them. `seenOps`
// makes application idempotent — a re-sent op is dropped by id, so nothing double-applies.
function markSeen(g, id) {
  if (id == null || g.seenOps.has(id)) return;
  g.seenOps.add(id); g.seenOrder.push(id);
  if (g.seenOrder.length > SEEN_MAX) g.seenOps.delete(g.seenOrder.shift());
}
function commitOps(g, ops, origin) {
  g.store = { version: g.store.version + 1, doc: g.store.doc };
  for (const op of ops) markSeen(g, op.id);
  persistOps(g, ops);                                // O(change) incremental write, not an O(doc) re-flatten
  broadcast(g, { version: g.store.version, ops, origin });
  return g.store.version;
}

// resolve which graph a request targets, checking membership. Returns the GraphContext or null.
function graphForUser(user, graphId) {
  if (!user || !graphId) return null;
  if (!accounts.roleOf(user.id, graphId)) return null; // not a member → no access
  return getGraph(graphId);
}
// the admin's first graph — target for the capture token and the /api/v1 agent API.
// falls back to a fixed 'default' graph in open mode (no accounts configured).
function defaultGraphId() {
  const admin = accounts.userByName(ADMIN_USER);
  const g = admin && accounts.graphsForUser(admin.id)[0];
  return g ? g.id : 'default';
}

// one-time migration: move the legacy single-graph DB (DATA_DIR/outline.db, or a seed
// outline.json) into the admin's first graph. Guarded — runs once, then the file is gone.
function migrateLegacyGraph() {
  const admin = accounts.userByName(ADMIN_USER);
  // account mode → the admin's first graph; open mode (no accounts) → a fixed 'default' graph
  const target = (admin && accounts.graphsForUser(admin.id)[0]) || { id: 'default', name: 'default' };
  const destDb = path.join(GRAPHS_DIR, target.id, 'outline.db');
  if (fs.existsSync(destDb)) return; // graph already has its own data
  if (fs.existsSync(DB_FILE)) {
    fs.mkdirSync(path.join(GRAPHS_DIR, target.id, 'backups'), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const src = DB_FILE + suffix;
      if (fs.existsSync(src)) fs.renameSync(src, destDb + suffix);
    }
    for (const t of Object.keys(shares)) if (!shares[t].graph) shares[t].graph = target.id;
    persistShares();
    console.log(`Migrated legacy outline into graph "${target.name}" (${target.id})`);
    return;
  }
  try {
    const seed = JSON.parse(fs.readFileSync(DOC_FILE, 'utf8'));
    if (seed && seed.doc && seed.doc.nodes) {
      getGraph(target.id).db.importDoc(seed.doc, typeof seed.version === 'number' ? seed.version : 0);
      graphCache.delete(target.id); // reload from the imported rows on next access
      fs.renameSync(DOC_FILE, DOC_FILE + '.migrated');
      console.log(`Seeded graph "${target.name}" from outline.json`);
    }
  } catch { /* nothing to seed */ }
}
migrateLegacyGraph();

// remove a subtree into the trash (the doc-model equivalent of a tombstone). The op's
// `ts` is used for the trash entry so client and server build an identical entry.
function trashSubtreeInDoc(doc, id, parent, ts) {
  const ids = pushTrash(doc, id, parent, parent && doc.nodes[parent] ? doc.nodes[parent].children.indexOf(id) : 0, ts);
  if (parent && doc.nodes[parent]) { const a = doc.nodes[parent].children; const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); }
  for (const x of ids) delete doc.nodes[x];
}

/* ---------- doc helpers (server-side mutations: capture, share merge) ---------- */

const uid = () => Date.now().toString(36).slice(-6) + crypto.randomBytes(4).toString('hex').slice(0, 6);

/** @param {string} text @param {object} [extra] @returns {Node} */
function makeNode(text, extra) {
  return { id: uid(), text, note: null, done: false, collapsed: false, children: [], m: Date.now(), ...(extra || {}) };
}

/** @param {Doc} doc @param {string} rootId @returns {string[]} */
function subtreeIds(doc, rootId) {
  const out = [];
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    const n = doc.nodes[id];
    if (!n || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(n.children || []));
  }
  return out;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- server-side calendar (mirrors the client's ensureDay, app2.js:1352) ---------- */

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = n => String(n).padStart(2, '0');
function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function ordinal(n) { const h = n % 100, t = n % 10; return n + (h >= 11 && h <= 13 ? 'th' : t === 1 ? 'st' : t === 2 ? 'nd' : t === 3 ? 'rd' : 'th'); }
function roamDateLabel(iso) { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${ordinal(d)}, ${y}`; }

function calSortKey(doc, id) { const n = doc.nodes[id]; return n.cal === 'year' ? n.cy : n.cal === 'month' ? n.cm : n.cal === 'day' ? n.cd : 0; }
function sortCalChildren(doc, parent) {
  doc.nodes[parent].children.sort((a, b) => { const ka = calSortKey(doc, a), kb = calSortKey(doc, b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
}
function addChild(doc, parent, node) { doc.nodes[node.id] = node; doc.nodes[parent].children.push(node.id); return node.id; }
function ensureCalChild(doc, parent, pred, make) {
  const found = doc.nodes[parent].children.find(pred);
  if (found) return found;
  const id = addChild(doc, parent, make());
  sortCalChildren(doc, parent);
  return id;
}
function calRootInDoc(doc) {
  if (!doc.meta) doc.meta = {};
  let id = doc.meta.calendar;
  if (id && doc.nodes[id] && doc.nodes[id].cal === 'root') return id;
  id = Object.keys(doc.nodes).find(k => doc.nodes[k].cal === 'root');
  if (id) { doc.meta.calendar = id; return id; }
  id = addChild(doc, doc.root, makeNode('📅 Calendar', { cal: 'root' }));
  doc.meta.calendar = id;
  return id;
}
// find-or-create today's journal day node in the calendar subtree (same layout as the client)
function ensureDayInDoc(doc, iso) {
  const [y, m] = iso.split('-').map(Number);
  const yr = ensureCalChild(doc, calRootInDoc(doc), id => doc.nodes[id].cal === 'year' && doc.nodes[id].cy === y,
    () => makeNode(String(y), { cal: 'year', cy: y }));
  const mo = ensureCalChild(doc, yr, id => doc.nodes[id].cal === 'month' && doc.nodes[id].cm === m - 1,
    () => makeNode(MONTHS_LONG[m - 1], { cal: 'month', cy: y, cm: m - 1 }));
  return ensureCalChild(doc, mo, id => doc.nodes[id].cal === 'day' && doc.nodes[id].cd === iso,
    () => makeNode(roamDateLabel(iso), { cal: 'day', cd: iso }));
}

// quick-capture lands under today's journal in an "Inbox" bullet: today → Inbox → line(s)
function captureText(g, text) {
  const doc = ensureDoc(g);
  const dayId = ensureDayInDoc(doc, todayIso());
  // drop stray empty bullets (e.g. an unused daily-note placeholder) so capture never
  // strands a blank line above the Inbox
  for (const cid of [...doc.nodes[dayId].children]) {
    const c = doc.nodes[cid];
    if (c && !(c.children || []).length && !serverPlain(c.text).trim()) {
      doc.nodes[dayId].children = doc.nodes[dayId].children.filter(x => x !== cid);
      delete doc.nodes[cid];
    }
  }
  let inboxId = doc.nodes[dayId].children.find(id => {
    const t = (doc.nodes[id]?.text || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
    return t === 'inbox';
  });
  if (!inboxId) inboxId = addChild(doc, dayId, makeNode('Inbox'));
  const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim());
  let count = 0;
  // indentation-aware: tabs/2-spaces nest under the previous shallower line
  const stack = []; // { depth, id }
  for (const line of lines) {
    const indent = line.match(/^[\t ]*/)[0];
    const depth = [...indent].reduce((d, ch) => d + (ch === '\t' ? 2 : 1), 0);
    const node = makeNode(escHtml(line.trim().replace(/^([-*•]|\d+[.)])\s+/, '')));
    doc.nodes[node.id] = node;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].id : inboxId;
    doc.nodes[parent].children.push(node.id);
    stack.push({ depth, id: node.id });
    count++;
  }
  if (count) commitDoc(g, doc);
  return count;
}

/* ---------- per-node API (v1) ---------- */

/** @returns {Doc} */
function ensureDoc(g) {
  if (!g.store.doc || !g.store.doc.nodes || !g.store.doc.nodes.root) {
    g.store.doc = { root: 'root', nodes: { root: { id: 'root', text: '', note: null, done: false, collapsed: false, children: [] } } };
  }
  return g.store.doc;
}

// strip the obvious dangerous bits server-side; the client applies a full
// inline-tag whitelist on render, so simple <b>/<i>/<a> markup survives
function sanitizeServerHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<\/?(?:script|style|iframe|object|embed|link|meta|svg|img)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1="#"');
}

const safeFileUrl = u => typeof u === 'string' && /^(\/files\/|https?:)/i.test(u.trim());

function sanitizeDocNodes(doc) {
  if (!doc || !doc.nodes) return doc;
  for (const n of Object.values(doc.nodes)) {
    if (!n || typeof n !== 'object') continue;
    if (typeof n.text === 'string') n.text = sanitizeServerHtml(n.text);
    if (!Array.isArray(n.children)) n.children = [];
    if (n.files) n.files = (Array.isArray(n.files) ? n.files : []).filter(f => f && safeFileUrl(f.url));
  }
  return doc;
}

const serverPlain = html => String(html || '').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();

// mirrors are interactive instances: content reads/writes route to the node that owns
// the content; structural ops act on the instance (same rule as the client)
function contentIdInDoc(doc, id) {
  const t = doc.nodes[id]?.mirror;
  return t && doc.nodes[t] ? t : id;
}

// deleting a node that has surviving mirrors hands its content + children to the oldest
// one and converts the node into a mirror of the heir (mirrors stay alive — client parity)
function promoteDoomedInDoc(doc, rootId) {
  for (let guard = 0; guard < 1000; guard++) {
    const doomed = new Set(subtreeIds(doc, rootId));
    const heirsOf = new Map();
    for (const k of Object.keys(doc.nodes)) {
      const t = doc.nodes[k].mirror;
      if (t && doomed.has(t) && !doomed.has(k) && !doc.nodes[t].mirror) {
        if (!heirsOf.has(t)) heirsOf.set(t, []);
        heirsOf.get(t).push(k);
      }
    }
    if (!heirsOf.size) return;
    const [t, heirs] = heirsOf.entries().next().value;
    const hid = heirs[0], h = doc.nodes[hid], o = doc.nodes[t];
    for (const k of ['text', 'note', 'done', 'format', 'files', 'comments', 'cal', 'c', 'm']) {
      if (o[k] !== undefined) h[k] = o[k]; else delete h[k];
    }
    delete h.mirror;
    for (const c of [...(o.children || [])]) {
      const i = o.children.indexOf(c);
      if (i >= 0) o.children.splice(i, 1);
      h.children.push(c);
    }
    for (const m of heirs.slice(1)) doc.nodes[m].mirror = hid;
    o.text = ''; o.note = null; o.done = false;
    delete o.format; delete o.files; delete o.comments; delete o.cal;
    o.mirror = hid;
    h.m = Date.now();
  }
}

function nodeParent(doc, id) {
  for (const pid of Object.keys(doc.nodes)) {
    if ((doc.nodes[pid].children || []).includes(id)) return pid;
  }
  return null;
}
function nodeDetach(doc, id) {
  const p = nodeParent(doc, id);
  if (p) { const a = doc.nodes[p].children; const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); }
}
function nodeInsert(doc, parent, index, id) {
  const a = doc.nodes[parent].children;
  if (!Number.isInteger(index) || index < 0 || index > a.length) index = a.length;
  a.splice(index, 0, id);
}
const TRASH_CAP = 200;
// move a subtree into the trash (newest first, capped); returns its node ids
function pushTrash(doc, id, parent, index, ts) {
  const ids = subtreeIds(doc, id);
  const nodes = {};
  for (const x of ids) nodes[x] = doc.nodes[x];
  if (!doc.trash) doc.trash = [];
  doc.trash.unshift({ ts: ts != null ? ts : Date.now(), parent, index, root: id, nodes });
  if (doc.trash.length > TRASH_CAP) doc.trash = doc.trash.slice(0, TRASH_CAP);
  return ids;
}

function nodeDelete(doc, id) {
  const parent = nodeParent(doc, id);
  const ids = pushTrash(doc, id, parent, parent ? doc.nodes[parent].children.indexOf(id) : 0);
  nodeDetach(doc, id);
  for (const x of ids) delete doc.nodes[x];
  return ids.length;
}
// `children` is polymorphic by design: child *ids* in the flat view, nested node
// objects under ?tree=1 (filled in by nodeTree). Hence the any[] in the contract.
/** @param {string} id @returns {{id:string,mirror:string|null,text:string,plain:string,note:string|null,done:boolean,collapsed:boolean,format:string,children:any[],created:number|null,modified:number|null,parent:string|null}} */
function nodeView(doc, id) {
  const inst = doc.nodes[id];
  const n = doc.nodes[contentIdInDoc(doc, id)]; // a mirror presents its target's content
  return {
    id, mirror: inst.mirror || null,
    text: n.text || '', plain: serverPlain(n.text), note: n.note ?? null,
    done: !!n.done, collapsed: !!inst.collapsed, format: n.format || 'bullet',
    children: n.children || [], created: n.c ?? null, modified: n.m ?? null,
    parent: nodeParent(doc, id),
  };
}
function nodeTree(doc, id, depth) {
  const v = nodeView(doc, id);
  if (depth === undefined || depth > 0) {
    v.children = (doc.nodes[id].children || []).map(c => nodeTree(doc, c, depth === undefined ? undefined : depth - 1));
  }
  return v;
}
function apiSearch(doc, q, limit) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const walk = (id, path) => {
    for (const c of (doc.nodes[id].children || [])) {
      const n = doc.nodes[c];
      if (!n) continue;
      const plain = serverPlain(n.text);
      const hay = (plain + ' ' + (n.note || '')).toLowerCase();
      if (plain && terms.every(t => hay.includes(t))) {
        out.push({ id: c, plain, path: path.join(' > '), done: !!n.done });
      }
      walk(c, [...path, plain || 'Untitled']);
    }
  };
  walk('root', []);
  return out.slice(0, limit || 50);
}

function apiAuthed(req, url) {
  if (isAuthed(req)) return true;
  if (!AGENT_TOKEN) return false;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const qtoken = new URL(url, 'http://x').searchParams.get('token') || req.headers['x-agent-token'] || '';
  return timingSafeEq(bearer || qtoken, AGENT_TOKEN);
}

async function readJson(req) {
  return JSON.parse((await readBody(req)).toString('utf8') || '{}');
}

async function handleV1(req, res, url, g) {
  if (!apiAuthed(req, url)) return send(res, 401, { error: 'unauthorized — set RHIZOME_AGENT_TOKEN and send Authorization: Bearer <token>' });
  if (!g) return send(res, 404, { error: 'no graph available' });
  const doc = ensureDoc(g);
  const path = url.split('?')[0];
  const method = req.method;
  const u = new URL(url, 'http://x');

  if (path === '/api/v1' || path === '/api/v1/') {
    return send(res, 200, {
      name: 'Rhizome node API', version: g.store.version,
      endpoints: [
        'GET    /api/v1/doc',
        'GET    /api/v1/version',
        'GET    /api/v1/search?q=&limit=',
        'GET    /api/v1/nodes/:id            (?tree=1&depth=N for the subtree)',
        'GET    /api/v1/nodes/:id/children',
        'POST   /api/v1/nodes                {parent,text,note,done,format,index}',
        'PATCH  /api/v1/nodes/:id            {text,note,done,collapsed,format}',
        'POST   /api/v1/nodes/:id/complete   {done}',
        'POST   /api/v1/nodes/:id/move       {parent,index}',
        'DELETE /api/v1/nodes/:id',
      ],
    });
  }
  if (path === '/api/v1/version' && method === 'GET') return send(res, 200, { version: g.store.version });
  if (path === '/api/v1/doc' && method === 'GET') return send(res, 200, { version: g.store.version, doc });
  if (path === '/api/v1/search' && method === 'GET') {
    const q = u.searchParams.get('q') || '';
    const lim = parseInt(u.searchParams.get('limit') || '50', 10);
    return send(res, 200, { results: q.trim() ? apiSearch(doc, q, lim) : [] });
  }
  if (path === '/api/v1/nodes' && method === 'POST') {
    const body = await readJson(req);
    const parent = body.parent || 'root';
    if (!doc.nodes[parent]) return send(res, 400, { error: 'unknown parent node' });
    const now = Date.now();
    const node = {
      id: uid(), text: sanitizeServerHtml(body.text || ''),
      note: body.note != null ? String(body.note) : null,
      done: !!body.done, collapsed: false, children: [], c: now, m: now,
    };
    if (body.format) node.format = String(body.format);
    doc.nodes[node.id] = node;
    nodeInsert(doc, parent, body.index, node.id);
    commitDoc(g, doc);
    return send(res, 201, nodeView(doc, node.id));
  }

  const m = path.match(/^\/api\/v1\/nodes\/([A-Za-z0-9]+)(\/tree|\/children|\/move|\/complete)?$/);
  if (m) {
    const id = m[1], sub = m[2];
    if (!doc.nodes[id]) return send(res, 404, { error: 'node not found' });

    if (!sub && method === 'GET') {
      if (u.searchParams.get('tree')) {
        const d = u.searchParams.get('depth');
        return send(res, 200, nodeTree(doc, id, d != null ? parseInt(d, 10) : undefined));
      }
      return send(res, 200, nodeView(doc, id));
    }
    if (sub === '/children' && method === 'GET') {
      return send(res, 200, { children: (doc.nodes[id].children || []).map(c => nodeView(doc, c)) });
    }
    if (!sub && method === 'PATCH') {
      const body = await readJson(req);
      const n = doc.nodes[contentIdInDoc(doc, id)]; // content writes hit the owner
      if ('text' in body) n.text = sanitizeServerHtml(String(body.text));
      if ('note' in body) n.note = body.note == null ? null : String(body.note);
      if ('done' in body) n.done = !!body.done;
      if ('collapsed' in body) doc.nodes[id].collapsed = !!body.collapsed; // expansion is per-instance
      if ('format' in body) { if (body.format) n.format = String(body.format); else delete n.format; }
      n.m = Date.now();
      commitDoc(g, doc);
      return send(res, 200, nodeView(doc, id));
    }
    if (sub === '/complete' && method === 'POST') {
      const body = await readJson(req);
      const n = doc.nodes[contentIdInDoc(doc, id)]; // completing a mirror completes every instance
      n.done = body.done === undefined ? true : !!body.done;
      n.m = Date.now();
      commitDoc(g, doc);
      return send(res, 200, nodeView(doc, id));
    }
    if (sub === '/move' && method === 'POST') {
      const body = await readJson(req);
      const target = body.parent || 'root';
      if (!doc.nodes[target]) return send(res, 400, { error: 'unknown target parent' });
      if (target === id || subtreeIds(doc, id).includes(target)) {
        return send(res, 400, { error: 'cannot move a node into itself or its own subtree' });
      }
      nodeDetach(doc, id);
      nodeInsert(doc, target, body.index, id);
      doc.nodes[id].m = Date.now();
      commitDoc(g, doc);
      return send(res, 200, nodeView(doc, id));
    }
    if (!sub && method === 'DELETE') {
      if (id === 'root') return send(res, 400, { error: 'cannot delete the root' });
      promoteDoomedInDoc(doc, id); // mirrors of anything inside survive (client parity)
      const count = nodeDelete(doc, id);
      commitDoc(g, doc);
      return send(res, 200, { ok: true, deleted: count });
    }
  }
  return send(res, 404, { error: 'not found' });
}

/* ---------- helpers ---------- */

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': headers['Content-Type'] || 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// the logged-in user for a request, or null (session cookie → accounts store)
function currentUser(req) {
  return accounts.sessionUser(cookies(req).rz_session || '', SESSION_MAX_AGE);
}
// access gate: with no accounts yet (fresh install / tests) the app is open; once any
// account exists, a valid session is required
function isAuthed(req) {
  if (accounts.userCount() === 0) return true;
  return !!currentUser(req);
}
const sessionCookie = token => `rz_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}`;

const attempts = new Map();
function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(ip); return false; }
  return a.count >= 8;
}
function recordAttempt(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  a.until = Date.now() + 10 * 60 * 1000;
  attempts.set(ip, a);
}

/* ---------- share helpers ---------- */

// a file is shared if it sits inside any shared subtree — check each share against its own graph
function fileIsShared(urlPath) {
  for (const share of Object.values(shares)) {
    const g = share.graph && getGraph(share.graph);
    const doc = g && g.store.doc;
    if (!doc || !doc.nodes[share.id]) continue;
    if (subtreeIds(doc, share.id).some(id => (doc.nodes[id].files || []).some(f => f && f.url === urlPath))) return true;
  }
  return false;
}

function shareDocFor(g, share) {
  const doc = g && g.store.doc;
  if (!doc || !doc.nodes[share.id]) return null;
  const nodes = {};
  for (const id of subtreeIds(doc, share.id)) nodes[id] = doc.nodes[id];
  return { root: share.id, nodes };
}

function cleanIncomingNode(n) {
  return {
    text: sanitizeServerHtml(n.text),
    note: typeof n.note === 'string' ? sanitizeServerHtml(n.note) : null,
    done: !!n.done,
    collapsed: !!n.collapsed,
    children: Array.isArray(n.children) ? n.children.filter(c => typeof c === 'string') : [],
    format: typeof n.format === 'string' ? n.format : undefined,
    mirror: typeof n.mirror === 'string' ? n.mirror : undefined, // mirrors survive a guest edit round-trip
    files: Array.isArray(n.files) ? n.files.filter(f => f && safeFileUrl(f.url)) : undefined,
    comments: Array.isArray(n.comments) ? n.comments : undefined,
    m: Date.now(),
  };
}

function mergeShareDoc(g, share, incoming) {
  const doc = g && g.store.doc;
  if (!doc || !doc.nodes[share.id] || !incoming.nodes || !incoming.nodes[share.id]) return false;
  // a guest may only touch ids reachable from the share root in its own doc
  const allowed = new Set(subtreeIds(incoming, share.id));
  const before = subtreeIds(doc, share.id);

  // nodes the guest dropped go to the trash, not the void (one entry per detached subtree)
  const removed = new Set(before.filter(id => id !== share.id && !allowed.has(id)));
  for (const id of removed) {
    const p = nodeParent(doc, id);
    if (p && removed.has(p)) continue; // covered by an ancestor's entry
    pushTrash(doc, id, p, 0);
  }

  for (const id of before) {
    if (id !== share.id) delete doc.nodes[id];
  }
  const written = new Set([share.id]);
  for (const id of allowed) {
    const n = incoming.nodes[id];
    if (!n || typeof n !== 'object') continue;
    if (id === share.id) {
      Object.assign(doc.nodes[share.id], cleanIncomingNode(n));
    } else if (!doc.nodes[id]) { // never clobber a node that lives outside the share
      doc.nodes[id] = { id, ...cleanIncomingNode(n) };
      written.add(id);
    }
  }
  // children may only point at nodes written in this merge (blocks smuggling an
  // outside id, e.g. the doc root, in as a child), and each node gets at most one
  // parent (claim-once ⇒ no cycles, so traversals and renders always terminate)
  const claimed = new Set();
  for (const id of written) {
    const n = doc.nodes[id];
    n.children = n.children.filter(c => {
      if (!written.has(c) || c === share.id || claimed.has(c)) return false;
      claimed.add(c);
      return true;
    });
  }
  commitDoc(g, doc);
  return true;
}

/* ---------- AI proxy ---------- */

function askClaude(prompt, context) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_MODEL,
      max_tokens: 4096,
      system: 'You are an assistant inside an outliner app. The user gives you an outline excerpt and an instruction. ' +
        'Respond ONLY with outline items: one item per line, using two-space indentation for nesting. ' +
        'No prose, no preamble, no markdown headers — just the indented list of items.',
      messages: [{
        role: 'user',
        content: `Outline context:\n${context || '(empty)'}\n\nInstruction: ${prompt}`,
      }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': AI_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 120000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(json.error?.message || `API error ${res.statusCode}`));
          const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('AI request timed out')); });
    req.end(body);
  });
}

/* ---------- static ---------- */

async function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || /^\/s\/[a-f0-9]+\/?$/.test(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    if (!path.extname(p)) {
      try { data = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html')); }
      catch { return send(res, 404, { error: 'not found' }); }
      return send(res, 200, data, { 'Content-Type': MIME['.html'] });
    }
    return send(res, 404, { error: 'not found' });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const cache = /\.(css|js|svg|png|woff2)$/.test(file) ? 'no-cache' : 'no-store';
  send(res, 200, data, { 'Content-Type': type, 'Cache-Control': cache });
}

async function serveUserFile(req, res, urlPath) {
  const name = path.basename(decodeURIComponent(urlPath.replace(/^\/files\//, '').split('?')[0]));
  const file = path.normalize(path.join(FILES_DIR, name));
  if (!file.startsWith(FILES_DIR)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await fsp.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000' });
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  const url = req.url || '/';

  try {
    /* ---- per-node REST API (agent token or session cookie) — targets the admin's graph ---- */
    if (url.startsWith('/api/v1')) return await handleV1(req, res, url, getGraph(defaultGraphId()));

    /* ---- share access (token-scoped, no cookie needed) ---- */
    const shareMatch = url.match(/^\/api\/share\/([a-f0-9]{24,})\/doc(\?.*)?$/);
    if (shareMatch) {
      const share = shares[shareMatch[1]];
      if (!share) return send(res, 404, { error: 'share not found or revoked' });
      const g = getGraph(share.graph || defaultGraphId()); // legacy shares fall back to the admin graph
      if (req.method === 'GET') {
        const doc = shareDocFor(g, share);
        if (!doc) return send(res, 410, { error: 'shared item was deleted' });
        return send(res, 200, { version: g.store.version, doc, mode: share.mode, root: share.id });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (share.mode !== 'edit') return send(res, 403, { error: 'this share is view-only' });
        const body = await readJson(req);
        if (typeof body.baseVersion === 'number' && body.baseVersion !== g.store.version) {
          const doc = shareDocFor(g, share);
          return send(res, 409, { version: g.store.version, doc });
        }
        if (!mergeShareDoc(g, share, body.doc || {})) return send(res, 400, { error: 'malformed share document' });
        return send(res, 200, { version: g.store.version });
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    if (url.startsWith('/api/')) {
      /* ---- auth-free endpoints ---- */
      if (url === '/api/auth' && req.method === 'GET') {
        return send(res, 200, {
          required: accounts.userCount() > 0,
          totp: !!TOTP_SECRET,
          ok: isAuthed(req),
          ai: !!AI_KEY,
        });
      }
      if (url === '/api/me' && req.method === 'GET') {
        const u = currentUser(req);
        return send(res, 200, {
          user: u ? { id: u.id, username: u.username, isAdmin: !!u.is_admin } : null,
          graphs: u ? accounts.graphsForUser(u.id) : [],
          authRequired: accounts.userCount() > 0,
          inviteRequired: !!INVITE_CODE,
          ai: !!AI_KEY,
        });
      }
      if (url === '/api/register' && req.method === 'POST') {
        if (throttled(ip)) return send(res, 429, { error: 'too many attempts — try again in 10 minutes' });
        const body = await readJson(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (INVITE_CODE && !timingSafeEq(String(body.invite || ''), INVITE_CODE)) {
          recordAttempt(ip, false);
          return send(res, 403, { error: 'invalid invite code' });
        }
        if (!/^[\w.\- ]{2,40}$/.test(username)) return send(res, 400, { error: 'username must be 2–40 chars (letters, numbers, . _ - space)' });
        if (password.length < 6) return send(res, 400, { error: 'password must be at least 6 characters' });
        if (accounts.userByName(username)) return send(res, 409, { error: 'that username is taken' });
        const user = accounts.createUser(username, password);
        accounts.createGraph('Home', user.id); // every new user starts with their own graph
        accounts.setLastLogin(user.id);
        const token = accounts.newSession(user.id);
        recordAttempt(ip, true);
        return send(res, 200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': sessionCookie(token) });
      }
      if (url === '/api/login' && req.method === 'POST') {
        if (throttled(ip)) return send(res, 429, { error: 'too many attempts — try again in 10 minutes' });
        const body = await readJson(req);
        const user = accounts.verifyLogin(String(body.username || ''), String(body.password || ''));
        let ok = !!user;
        if (ok && TOTP_SECRET) ok = totpValid(TOTP_SECRET, body.code); // optional global second factor
        recordAttempt(ip, ok);
        if (!ok) return send(res, 401, { error: user ? 'wrong code' : 'wrong username or password' });
        accounts.setLastLogin(user.id);
        const token = accounts.newSession(user.id);
        return send(res, 200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': sessionCookie(token) });
      }
      if (url === '/api/logout' && req.method === 'POST') {
        accounts.dropSession(cookies(req).rz_session || '');
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'rz_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      }
      if (url === '/api/account/password' && req.method === 'POST') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        const body = await readJson(req);
        if (!accounts.verifyLogin(u.username, String(body.current || ''))) return send(res, 403, { error: 'current password is wrong' });
        if (String(body.next || '').length < 6) return send(res, 400, { error: 'new password must be at least 6 characters' });
        accounts.setPassword(u.id, String(body.next));
        return send(res, 200, { ok: true });
      }
      // graph management (Phase 3): create / rename / delete the signed-in user's graphs
      if (url === '/api/graphs' && req.method === 'POST') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        const name = String((await readJson(req)).name || '').trim().slice(0, 60);
        if (!name) return send(res, 400, { error: 'a graph name is required' });
        const g = accounts.createGraph(name, u.id);
        return send(res, 200, { id: g.id, name: g.name, role: 'owner' });
      }
      const graphIdM = url.match(/^\/api\/graphs\/([A-Za-z0-9]+)$/);
      if (graphIdM) {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        const gid = graphIdM[1];
        const graph = accounts.graphById(gid);
        if (!graph) return send(res, 404, { error: 'graph not found' });
        if (graph.owner_id !== u.id) return send(res, 403, { error: 'only the owner can change a graph' });
        if (req.method === 'PATCH') {
          const name = String((await readJson(req)).name || '').trim().slice(0, 60);
          if (!name) return send(res, 400, { error: 'a graph name is required' });
          accounts.renameGraph(gid, name);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (accounts.graphsForUser(u.id).length <= 1) return send(res, 400, { error: 'you cannot delete your only graph' });
          accounts.deleteGraph(gid);
          graphCache.delete(gid);
          try { fs.rmSync(path.join(GRAPHS_DIR, gid), { recursive: true, force: true }); } catch { /* already gone */ }
          for (const t of Object.keys(shares)) if (shares[t].graph === gid) delete shares[t];
          persistShares();
          return send(res, 200, { ok: true });
        }
      }
      // graph members (Phase 4): list / add / remove collaborators
      const memM = url.match(/^\/api\/graphs\/([A-Za-z0-9]+)\/members$/);
      if (memM) {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        const gid = memM[1];
        const graph = accounts.graphById(gid);
        if (!graph) return send(res, 404, { error: 'graph not found' });
        if (!accounts.roleOf(u.id, gid)) return send(res, 403, { error: 'no access to this graph' });
        if (req.method === 'GET') {
          return send(res, 200, { members: accounts.membersOf(gid), isOwner: graph.owner_id === u.id });
        }
        if (req.method === 'POST') {
          if (graph.owner_id !== u.id) return send(res, 403, { error: 'only the owner can share a graph' });
          const target = accounts.userByName(String((await readJson(req)).username || '').trim());
          if (!target) return send(res, 404, { error: 'no user with that name' });
          if (target.id === u.id) return send(res, 400, { error: 'you already own this graph' });
          accounts.addMember(target.id, gid, 'editor');
          return send(res, 200, { ok: true });
        }
      }
      const memDelM = url.match(/^\/api\/graphs\/([A-Za-z0-9]+)\/members\/([A-Za-z0-9]+)$/);
      if (memDelM && req.method === 'DELETE') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        const gid = memDelM[1], targetId = memDelM[2];
        const graph = accounts.graphById(gid);
        if (!graph) return send(res, 404, { error: 'graph not found' });
        // the owner may remove anyone; a member may remove themselves (leave)
        if (graph.owner_id !== u.id && targetId !== u.id) return send(res, 403, { error: 'not allowed' });
        if (targetId === graph.owner_id) return send(res, 400, { error: 'the owner cannot be removed' });
        accounts.removeMember(targetId, gid);
        return send(res, 200, { ok: true });
      }
      if (url.startsWith('/api/capture') && req.method === 'POST') {
        const token = new URL(url, 'http://x').searchParams.get('token')
          || req.headers['x-capture-token'] || '';
        const user = currentUser(req);
        const allowed = (CAPTURE_TOKEN && timingSafeEq(token, CAPTURE_TOKEN)) || !!user || accounts.userCount() === 0;
        if (!allowed) return send(res, 401, { error: 'unauthorized' });
        // a session captures into its own first graph; the capture token targets the admin's graph
        const gid = user ? accounts.graphsForUser(user.id)[0]?.id : defaultGraphId();
        const g = gid && getGraph(gid);
        if (!g) return send(res, 400, { error: 'no graph to capture into' });
        const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
        let text = raw;
        try { const j = JSON.parse(raw); if (typeof j.text === 'string') text = j.text; } catch { /* plain text body */ }
        const count = captureText(g, text);
        return send(res, 200, { ok: true, captured: count });
      }

      /* ---- graph-scoped endpoints: /api/g/:graphId/… (membership required) ---- */
      const gm = url.match(/^\/api\/g\/([A-Za-z0-9]+)\/([a-z]+)(\/[a-f0-9]+)?(?:\?.*)?$/);
      if (gm) {
        const user = currentUser(req);
        const open = accounts.userCount() === 0;
        if (!open && !user) return send(res, 401, { error: 'unauthorized' });
        const g = open ? getGraph(gm[1]) : graphForUser(user, gm[1]);
        if (!g) return send(res, 403, { error: 'no access to this graph' });
        const seg = gm[2], method = req.method;
        if (seg === 'doc' && method === 'GET') return send(res, 200, g.store);
        if (seg === 'version' && method === 'GET') return send(res, 200, { version: g.store.version });
        if (seg === 'search' && method === 'GET') {
          const q = new URL(url, 'http://x').searchParams.get('q') || '';
          return send(res, 200, { ids: g.db.search(q, 500) });
        }
        if (seg === 'doc' && (method === 'PUT' || method === 'POST')) {
          const body = await readJson(req);
          if (!body.doc || typeof body.doc !== 'object' || !body.doc.nodes) return send(res, 400, { error: 'malformed document' });
          if (typeof body.baseVersion === 'number' && body.baseVersion !== g.store.version) return send(res, 409, g.store);
          const v = commitDoc(g, sanitizeDocNodes(body.doc), body.device);
          return send(res, 200, { version: v });
        }
        if (seg === 'ops' && method === 'POST') {
          const body = await readJson(req);
          if (!Array.isArray(body.ops)) return send(res, 400, { error: 'ops array required' });
          if (!g.store.doc) g.store.doc = { root: 'root', nodes: { root: { id: 'root', text: '', note: null, done: false, collapsed: false, children: [] } } };
          const fresh = body.ops.filter(op => op && (op.id == null || !g.seenOps.has(op.id))); // idempotent: drop re-sends
          for (const op of fresh) { // sanitize incoming text/note server-side (same guarantee as the doc path)
            if (op.data) { if (typeof op.data.text === 'string') op.data.text = sanitizeServerHtml(op.data.text); if (typeof op.data.note === 'string') op.data.note = sanitizeServerHtml(op.data.note); }
            if (op.patch) { if (typeof op.patch.text === 'string') op.patch.text = sanitizeServerHtml(op.patch.text); if (typeof op.patch.note === 'string') op.patch.note = sanitizeServerHtml(op.patch.note); }
          }
          const applied = applyOpsToDoc(g.store.doc, fresh, trashSubtreeInDoc);
          for (const op of fresh) markSeen(g, op.id);
          const v = applied.length ? commitOps(g, applied, body.device) : g.store.version;
          return send(res, 200, { version: v, applied: applied.length });
        }
        if (seg === 'events' && method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
          });
          res.write(`data: ${JSON.stringify({ version: g.store.version })}\n\n`);
          g.sse.add(res);
          req.on('close', () => g.sse.delete(res));
          return;
        }
        if (seg === 'shares' && method === 'GET') {
          return send(res, 200, Object.entries(shares).filter(([, s]) => s.graph === g.id).map(([token, s]) => ({ token, ...s })));
        }
        if (seg === 'shares' && method === 'POST') {
          const body = await readJson(req);
          if (!g.store.doc?.nodes?.[body.nodeId]) return send(res, 400, { error: 'unknown node' });
          const token = crypto.randomBytes(16).toString('hex');
          shares[token] = { id: body.nodeId, graph: g.id, mode: body.mode === 'edit' ? 'edit' : 'view', created: Date.now() };
          persistShares();
          return send(res, 200, { token, url: `/s/${token}` });
        }
        if (seg === 'shares' && method === 'DELETE' && gm[3]) {
          const t = gm[3].slice(1);
          if (shares[t] && shares[t].graph === g.id) { delete shares[t]; persistShares(); }
          return send(res, 200, { ok: true });
        }
        if (seg === 'capture' && method === 'POST') {
          const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
          let text = raw;
          try { const j = JSON.parse(raw); if (typeof j.text === 'string') text = j.text; } catch { /* plain text body */ }
          return send(res, 200, { ok: true, captured: captureText(g, text) });
        }
        return send(res, 404, { error: 'not found' });
      }

      /* ---- global authed endpoints (files, AI) ---- */
      if (!isAuthed(req)) return send(res, 401, { error: 'unauthorized' });

      if (url.startsWith('/api/upload') && req.method === 'POST') {
        const rawName = new URL(url, 'http://x').searchParams.get('name') || 'file';
        const safe = path.basename(rawName).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
        const data = await readBody(req, MAX_UPLOAD);
        if (!data.length) return send(res, 400, { error: 'empty upload' });
        const stored = `${uid()}-${safe}`;
        await fsp.writeFile(path.join(FILES_DIR, stored), data);
        return send(res, 200, { url: `/files/${encodeURIComponent(stored)}`, name: safe, size: data.length });
      }

      if (url === '/api/ai' && req.method === 'POST') {
        if (!AI_KEY) return send(res, 400, { error: 'AI is not configured — set ANTHROPIC_API_KEY on the server' });
        const body = await readJson(req);
        if (!body.prompt) return send(res, 400, { error: 'missing prompt' });
        try {
          const text = await askClaude(String(body.prompt).slice(0, 4000), String(body.context || '').slice(0, 100000));
          return send(res, 200, { text });
        } catch (err) {
          return send(res, 502, { error: 'AI request failed: ' + err.message });
        }
      }

      return send(res, 404, { error: 'not found' });
    }

    if (url.startsWith('/files/')) {
      // attachments are private unless they sit inside a shared subtree
      if (!isAuthed(req) && !fileIsShared(decodeURIComponent(url.split('?')[0]))) {
        return send(res, 401, { error: 'unauthorized' });
      }
      return serveUserFile(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Rhizome listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  const users = accounts.userCount();
  console.log(users ? `Accounts: ${users} user(s), login required${TOTP_SECRET ? ' + TOTP MFA' : ''}${INVITE_CODE ? ', registration by invite code' : ''}` : 'Accounts: none yet — open access (set RHIZOME_ADMIN_PASSWORD to lock down)');
  if (CAPTURE_TOKEN) console.log('Capture API: POST /api/capture?token=…');
  if (AGENT_TOKEN) console.log('Node API: /api/v1 (agent token enabled)');
  if (AI_KEY) console.log(`Ask AI: enabled (${AI_MODEL})`);
});
