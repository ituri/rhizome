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
 *   RHIZOME_AGENT_TOKEN   if set, unlocks the per-node REST API at /api/v1 (Bearer or ?token=)
 *   ANTHROPIC_API_KEY     if set, enables the in-app "Ask AI" assistant
 *   RHIZOME_AI_MODEL      Claude model for Ask AI      (default claude-opus-4-8)
 *   RHIZOME_ENCRYPTION_KEY if set, encrypts backups + uploaded files at rest (AES-256-GCM).
 *                         Keep it OUT of DATA_DIR so backups don't ship the key. Restore a
 *                         backup with: RHIZOME_ENCRYPTION_KEY=… node cryptobox.js <in> <out>
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
const cryptobox = require('./cryptobox');

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
const AGENT_TOKEN = process.env.RHIZOME_AGENT_TOKEN || process.env.TENDRIL_AGENT_TOKEN || '';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.RHIZOME_AI_MODEL || process.env.TENDRIL_AI_MODEL || 'claude-opus-4-8';
// reverse-geocoder for location pages (coords → address). Configurable so you can point it at a
// self-hosted Nominatim/Photon; default is the public OpenStreetMap Nominatim.
const GEOCODER_URL = process.env.RHIZOME_GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse';
const geocodeCache = new Map(); // "lat,lon" → address, so a coordinate is only looked up once
// multi-user: registration invite gate + first-run admin account
const INVITE_CODE = process.env.RHIZOME_INVITE_CODE || '';
const ADMIN_USER = process.env.RHIZOME_ADMIN_USER || 'phil';
const ADMIN_PASSWORD = process.env.RHIZOME_ADMIN_PASSWORD || PASSWORD || '';
const SESSION_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_UPLOAD = 32 * 1024 * 1024;
const BACKUP_EVERY_MS = +(process.env.RHIZOME_BACKUP_EVERY_MS || 60 * 60 * 1000); // lowered in tests
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
  return {
    id, dir, backupDir, db, store, sse: new Set(), seenOps: new Set(), seenOrder: [], lastBackupAt,
    // page history: nodes/pages changed since the last debounced snapshot, + the last device name
    historyNodes: new Set(), historyAll: false, historyTimer: null, historyDevice: '',
  };
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
    const dest = path.join(g.backupDir, `outline-${stamp}.db`);
    if (cryptobox.enabled()) {
      // SQLite must VACUUM to a real file; encrypt that copy at rest, then drop the plaintext temp
      const tmp = dest + '.plain';
      g.db.backup(tmp);
      fs.writeFileSync(dest, cryptobox.encrypt(fs.readFileSync(tmp)));
      fs.unlinkSync(tmp);
    } else {
      g.db.backup(dest);
    }
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

/* ---------- page version history ---------- */

const HISTORY_DEBOUNCE_MS = +process.env.RHIZOME_HISTORY_DEBOUNCE_MS || 45000; // one snapshot per page per ~edit-session

function buildParentMap(doc) {
  const m = new Map();
  for (const nid in doc.nodes) for (const c of doc.nodes[nid].children || []) m.set(c, nid);
  return m;
}
// the page that contains `id`: a journal day node (cal:'day'), else the top-level page (child of
// root, but not the calendar root). null for root / the calendar scaffold / a detached node.
function pageIdOf(doc, id, pm) {
  let cur = id;
  while (cur) {
    const n = doc.nodes[cur];
    if (!n) return null;
    if (n.cal === 'day') return cur;
    const p = pm.get(cur);
    if (!p) return null;
    if (p === doc.root) return n.cal === 'root' ? null : cur;
    cur = p;
  }
  return null;
}
function pageSubtree(doc, pageId) {
  const nodes = {};
  const stack = [pageId];
  while (stack.length) {
    const id = stack.pop(); const n = doc.nodes[id];
    if (!n) continue;
    nodes[id] = n;
    for (const c of n.children || []) stack.push(c);
  }
  return { root: pageId, nodes };
}
function armHistory(g) {
  if (g.historyTimer) return;
  g.historyTimer = setTimeout(() => { g.historyTimer = null; snapshotHistory(g); }, HISTORY_DEBOUNCE_MS);
  g.historyTimer.unref?.();
}
// resolve the changed nodes to their pages and snapshot each page's subtree (deduped by content)
function snapshotHistory(g) {
  const doc = g.store.doc;
  if (!doc) return;
  const pm = buildParentMap(doc);
  const pages = new Set();
  if (g.historyAll) {
    for (const c of doc.nodes[doc.root]?.children || []) { const n = doc.nodes[c]; if (n && n.cal !== 'root') pages.add(c); }
    for (const nid in doc.nodes) if (doc.nodes[nid].cal === 'day') pages.add(nid);
  }
  for (const nid of g.historyNodes) { const p = pageIdOf(doc, nid, pm); if (p) pages.add(p); }
  g.historyNodes = new Set(); g.historyAll = false;
  const now = Date.now(), device = g.historyDevice || '';
  for (const pageId of pages) {
    if (!doc.nodes[pageId]) continue;
    const json = JSON.stringify(pageSubtree(doc, pageId));
    if (json === g.db.historyLatestDoc(pageId)) continue; // nothing changed since the last version
    try { g.db.historyAdd(pageId, now, device, json); } catch (e) { console.error('history snapshot failed:', e); }
  }
}

// restore a page to a stored snapshot: drop nodes added since, overwrite the snapshot's nodes,
// then commit the whole doc (peers refetch). The restore is itself recorded as a new version.
function restorePage(g, pageId, snap, origin) {
  const doc = g.store.doc;
  if (!doc || !doc.nodes[pageId] || !snap.nodes || !snap.nodes[pageId]) return g.store.version;
  const current = Object.keys(pageSubtree(doc, pageId).nodes);
  const snapIds = new Set(Object.keys(snap.nodes));
  for (const id of current) if (!snapIds.has(id)) delete doc.nodes[id]; // added since the snapshot → gone
  for (const id of snapIds) doc.nodes[id] = snap.nodes[id];            // restore content + structure
  return commitDoc(g, doc, origin);
}

function commitDoc(g, doc, origin) {
  g.store = { version: g.store.version + 1, doc };
  persist(g);
  broadcast(g, { version: g.store.version, origin });
  g.historyAll = true; armHistory(g);
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
  for (const op of ops) if (op.node) g.historyNodes.add(op.node); // cheap; pages resolved on snapshot
  armHistory(g);
  return g.store.version;
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
  id = addChild(doc, doc.root, makeNode('Calendar', { cal: 'root' }));
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
function captureText(g, text, device) {
  const dev = String(device || '').slice(0, 60);
  if (dev) g.historyDevice = dev;
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

// the bearer/query/header token on a request (used for the agent token and user API keys)
function reqToken(req, url) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer || new URL(url, 'http://x').searchParams.get('token') || req.headers['x-agent-token'] || req.headers['x-capture-token'] || '';
}
// resolve a request's token to a user API key context { id, userId, graphId, scope } or null
function apiKeyFor(req, url) { return accounts.resolveApiKey(reqToken(req, url)); }

function apiAuthed(req, url) {
  if (isAuthed(req)) return true;
  if (!AGENT_TOKEN) return false;
  return timingSafeEq(reqToken(req, url), AGENT_TOKEN);
}

async function readJson(req) {
  return JSON.parse((await readBody(req)).toString('utf8') || '{}');
}

async function handleV1(req, res, url, g, scope) {
  if (!scope) { // no rzk_ key on the request — fall back to session / agent token (write scope)
    if (!apiAuthed(req, url)) return send(res, 401, { error: 'unauthorized — send Authorization: Bearer <rzk_… API key or agent token>' });
    scope = 'write';
  }
  if (apiRateLimited('v1:' + (reqToken(req, url) || req.socket.remoteAddress))) return send(res, 429, { error: 'rate limited — slow down' });
  if (!g) return send(res, 404, { error: 'no graph available' });
  if (scope !== 'write' && req.method !== 'GET') return send(res, 403, { error: 'read-only key — a write-scoped key is required' });
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
        'GET    /api/v1/events              (SSE: {version} on connect + on every change)',
        'POST   /api/v1/capture             {text} or raw text → today\'s journal Inbox',
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
  if (path === '/api/v1/events' && method === 'GET') {   // SSE — same hub as /api/g/:g/events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ version: g.store.version })}\n\n`);
    g.sse.add(res);
    req.on('close', () => g.sse.delete(res));
    return;
  }
  if (path === '/api/v1/capture' && method === 'POST') {   // → today's journal Inbox
    const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
    let text = raw, deviceName = u.searchParams.get('deviceName') || '';
    try { const j = JSON.parse(raw); if (typeof j.text === 'string') text = j.text; if (typeof j.deviceName === 'string') deviceName = j.deviceName; } catch { /* plain text body */ }
    return send(res, 200, { ok: true, captured: captureText(g, text, deviceName) });
  }
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

/* ---------- MCP server (Model Context Protocol, JSON-RPC 2.0 over Streamable HTTP) ----------
   Hosted at POST /mcp. Lets an MCP client (Claude Desktop/Code, claude.ai connectors) read and
   edit one graph. Auth: an API key (Authorization: Bearer rzk_…) whose scope gates the write
   tools; the agent token or an open instance also work (→ default graph, write). Implemented
   natively — no SDK — so the core server stays zero-dependency. Stateless: no Mcp-Session-Id. */

const MCP_PROTOCOL = '2025-06-18';
const MCP_SERVER = { name: 'rhizome', version: require('./package.json').version };
const MCP_WRITE_TOOLS = new Set(['create_node', 'update_node', 'move_node', 'delete_node', 'capture']);

const MCP_TOOLS = [
  { name: 'search', description: 'Full-text search the graph. Returns matching nodes with their id, plain text, breadcrumb path and done state.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'space-separated terms (AND)' }, limit: { type: 'integer', description: 'max results (default 50, max 200)' } }, required: ['query'] } },
  { name: 'list_pages', description: 'List the top-level pages (direct children of the root). Start here to discover the graph.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_node', description: 'Read a single node by id. With tree=true, returns the whole subtree (optionally limited by depth).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, tree: { type: 'boolean', description: 'include descendants' }, depth: { type: 'integer', description: 'subtree depth limit when tree=true' } }, required: ['id'] } },
  { name: 'create_node', description: 'Create a node under a parent (default root). Text is inline HTML-ish markup; [[Page]] links and #tags work. Returns the new node.',
    inputSchema: { type: 'object', properties: { parent: { type: 'string', description: "parent node id (default 'root')" }, text: { type: 'string' }, note: { type: 'string' }, done: { type: 'boolean' }, format: { type: 'string', description: 'bullet | todo | h1 | h2 | h3 | quote | codeblock | number | board' }, index: { type: 'integer', description: 'position among siblings (default end)' } }, required: ['text'] } },
  { name: 'update_node', description: 'Edit a node in place: change its text, note, done state, format or collapsed flag. Only the fields you pass are changed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, note: { type: 'string' }, done: { type: 'boolean' }, format: { type: 'string' }, collapsed: { type: 'boolean' } }, required: ['id'] } },
  { name: 'move_node', description: 'Move a node (and its subtree) under a new parent, optionally at a given index.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, parent: { type: 'string' }, index: { type: 'integer' } }, required: ['id', 'parent'] } },
  { name: 'delete_node', description: 'Delete a node and its subtree. Returns how many nodes were removed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'capture', description: "Quick-capture text into today's journal under an Inbox bullet (indentation nests). Handy for jotting without picking a location.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

function mcpResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function mcpErr(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

async function handleMcp(req, res, url) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed — POST JSON-RPC to /mcp' }, cors);

  // Resolve the target graph + write scope from the credential.
  const key = apiKeyFor(req, url);
  let g = null, scope = 'read';
  if (key) { g = getGraph(key.graphId); scope = key.scope; }
  else if (AGENT_TOKEN && timingSafeEq(reqToken(req, url), AGENT_TOKEN)) { g = getGraph(defaultGraphId()); scope = 'write'; }
  else if (accounts.userCount() === 0) { g = getGraph(defaultGraphId()); scope = 'write'; } // fresh/open instance
  if (!g) return send(res, 401, { error: 'unauthorized — send Authorization: Bearer <rzk_… API key>' }, { ...cors, 'WWW-Authenticate': 'Bearer' });
  if (apiRateLimited('mcp:' + (key ? key.id : req.socket.remoteAddress))) return send(res, 429, { error: 'rate limited — slow down' }, cors);

  let msg;
  try { msg = await readJson(req); }
  catch { return send(res, 400, mcpErr(null, -32700, 'parse error'), cors); }

  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) { const r = await mcpDispatch(m, g, scope); if (r) out.push(r); }
    if (!out.length) { res.writeHead(202, cors); return res.end(); }
    return send(res, 200, out, cors);
  }
  const resp = await mcpDispatch(msg, g, scope);
  if (!resp) { res.writeHead(202, cors); return res.end(); } // a notification → no body
  return send(res, 200, resp, cors);
}

async function mcpDispatch(m, g, scope) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return mcpErr(m && m.id, -32600, 'invalid request');
  const { id, method, params } = m;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return mcpResult(id, {
        protocolVersion: (params && typeof params.protocolVersion === 'string') ? params.protocolVersion : MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER,
        instructions: 'Rhizome is a page-based outliner. Call list_pages to discover pages, search to find nodes, get_node (tree=true) to read a subtree, then the write tools to edit. Node ids are opaque strings; the tree lives in each node\'s children array.',
      });
    case 'ping': return mcpResult(id, {});
    case 'tools/list': return mcpResult(id, { tools: MCP_TOOLS });
    case 'resources/list': return mcpResult(id, { resources: [] });
    case 'prompts/list': return mcpResult(id, { prompts: [] });
    case 'tools/call': return await mcpCallTool(id, params || {}, g, scope);
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
      return mcpErr(id, -32601, 'method not found: ' + method);
  }
}

async function mcpCallTool(id, params, g, scope) {
  const name = params.name;
  const args = params.arguments || {};
  const doc = ensureDoc(g);
  const ok = obj => mcpResult(id, { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
  const fail = message => mcpResult(id, { content: [{ type: 'text', text: 'Error: ' + message }], isError: true });
  if (MCP_WRITE_TOOLS.has(name) && scope !== 'write') return fail('this API key is read-only; create a write-scoped key to use ' + name);
  try {
    switch (name) {
      case 'search': {
        const q = String(args.query || '');
        return ok({ results: q.trim() ? apiSearch(doc, q, Math.min(parseInt(args.limit, 10) || 50, 200)) : [] });
      }
      case 'list_pages': {
        const root = doc.root || 'root';
        const pages = (doc.nodes[root].children || []).map(cid => {
          const v = nodeView(doc, cid);
          return { id: v.id, title: v.plain || 'Untitled', format: v.format, children: v.children.length };
        });
        return ok({ pages });
      }
      case 'get_node': {
        const nid = String(args.id || '');
        if (!doc.nodes[nid]) return fail('node not found: ' + nid);
        return ok(args.tree ? nodeTree(doc, nid, args.depth != null ? parseInt(args.depth, 10) : undefined) : nodeView(doc, nid));
      }
      case 'create_node': {
        const parent = String(args.parent || 'root');
        if (!doc.nodes[parent]) return fail('unknown parent: ' + parent);
        const now = Date.now();
        const node = { id: uid(), text: sanitizeServerHtml(String(args.text || '')), note: args.note != null ? String(args.note) : null, done: !!args.done, collapsed: false, children: [], c: now, m: now };
        if (args.format) node.format = String(args.format);
        doc.nodes[node.id] = node;
        nodeInsert(doc, parent, args.index, node.id);
        commitDoc(g, doc, 'mcp');
        return ok(nodeView(doc, node.id));
      }
      case 'update_node': {
        const nid = String(args.id || '');
        if (!doc.nodes[nid]) return fail('node not found: ' + nid);
        const n = doc.nodes[contentIdInDoc(doc, nid)]; // content writes hit the owner (mirror-safe)
        if ('text' in args) n.text = sanitizeServerHtml(String(args.text));
        if ('note' in args) n.note = args.note == null ? null : String(args.note);
        if ('done' in args) n.done = !!args.done;
        if ('format' in args) { if (args.format) n.format = String(args.format); else delete n.format; }
        if ('collapsed' in args) doc.nodes[nid].collapsed = !!args.collapsed;
        n.m = Date.now();
        commitDoc(g, doc, 'mcp');
        return ok(nodeView(doc, nid));
      }
      case 'move_node': {
        const nid = String(args.id || '');
        if (!doc.nodes[nid]) return fail('node not found: ' + nid);
        const target = String(args.parent || 'root');
        if (!doc.nodes[target]) return fail('unknown target parent: ' + target);
        if (target === nid || subtreeIds(doc, nid).includes(target)) return fail('cannot move a node into itself or its own subtree');
        nodeDetach(doc, nid);
        nodeInsert(doc, target, args.index, nid);
        doc.nodes[nid].m = Date.now();
        commitDoc(g, doc, 'mcp');
        return ok(nodeView(doc, nid));
      }
      case 'delete_node': {
        const nid = String(args.id || '');
        if (nid === 'root' || nid === doc.root) return fail('cannot delete the root');
        if (!doc.nodes[nid]) return fail('node not found: ' + nid);
        promoteDoomedInDoc(doc, nid); // mirrors of anything inside survive (client parity)
        const count = nodeDelete(doc, nid);
        commitDoc(g, doc, 'mcp');
        return ok({ deleted: count });
      }
      case 'capture': {
        const text = String(args.text || '');
        if (!text.trim()) return fail('nothing to capture');
        return ok({ captured: captureText(g, text, 'mcp') });
      }
      default:
        return fail('unknown tool: ' + name);
    }
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
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
// true when the request reached us over TLS (directly or via a terminating proxy that
// forwards the scheme) — used to set the cookie's Secure flag only when it won't break http dev
const isHttps = req => {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return xf === 'https' || !!req.socket.encrypted;
};
const sessionCookie = (token, secure) => `rz_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}${secure ? '; Secure' : ''}`;
// the signed-in user if they are an admin, else null
function requireAdmin(req) { const u = currentUser(req); return u && u.is_admin ? u : null; }
// the effective registration invite code: an admin-rotated DB value overrides the env default
const currentInviteCode = () => accounts.getSetting('invite_code') ?? INVITE_CODE;

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

// coarse fixed-window rate limit for token/key-authenticated API endpoints (capture, v1, mcp).
// Bounds a leaked key's blast radius; the interactive web client is session-authed and untouched.
const apiHits = new Map();
function apiRateLimited(key, max = 300, windowMs = 60000) {
  const now = Date.now();
  let a = apiHits.get(key);
  if (!a || now > a.resetAt) { a = { count: 0, resetAt: now + windowMs }; apiHits.set(key, a); }
  a.count += 1;
  if (apiHits.size > 5000) for (const [k, v] of apiHits) if (now > v.resetAt) apiHits.delete(k); // cheap GC
  return a.count > max;
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

// does any node in this graph's doc reference the file url?
function graphReferencesUrl(doc, urlPath) {
  if (!doc || !doc.nodes) return false;
  for (const id in doc.nodes) {
    for (const f of (doc.nodes[id].files || [])) if (f && f.url === urlPath) return true;
  }
  return false;
}

// files are global on disk, but access is scoped: readable only if the instance is open, the
// file sits inside a public share, or the requester is a member of a graph that references it.
// (Previously any logged-in user could read any file by guessing its url.)
function userCanReadFile(req, urlPath) {
  if (accounts.userCount() === 0) return true;      // fresh/open instance
  if (fileIsShared(urlPath)) return true;           // inside a public share link
  const u = currentUser(req);
  if (!u) return false;
  if (u.is_admin) return true;                      // admins can read any attachment on their instance
  for (const g of accounts.graphsForUser(u.id)) {
    if (graphReferencesUrl(getGraph(g.id).store.doc, urlPath)) return true;
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

// Reverse-geocode a coordinate to a short address via the configured geocoder (Nominatim-shaped
// response). Cached in memory; a location page geocodes once, so this stays well under any rate
// limit. Returns "" if nothing usable comes back.
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const u = new URL(GEOCODER_URL);
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('zoom', '18');
  u.searchParams.set('addressdetails', '1');
  const r = await fetch(u, { headers: { 'User-Agent': 'Rhizome/1.0 (self-hosted notes app)', Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const a = j.address || {};
  const road = [a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(' ');
  const place = a.city || a.town || a.village || a.municipality || a.suburb || a.county || '';
  const address = [road, place].filter(Boolean).join(', ') || j.display_name || '';
  if (address) geocodeCache.set(key, address);
  return address;
}

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
  if (p === '/privacy') p = '/privacy.html';
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
    const data = cryptobox.decrypt(await fsp.readFile(file)); // transparent for plaintext (pre-encryption) files
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000' });
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

/* ---------- asset management ---------- */

// a stored file name from its /files/<name> url, path-traversal-guarded like serveUserFile
function storedFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/files/')) return null;
  const name = path.basename(decodeURIComponent(url.replace(/^\/files\//, '').split('?')[0]));
  const file = path.normalize(path.join(FILES_DIR, name));
  return file.startsWith(FILES_DIR) ? name : null;
}
function fileStat(name) {
  try { const s = fs.statSync(path.join(FILES_DIR, name)); return { size: s.size, mtime: s.mtimeMs }; }
  catch { return null; }
}
// every file referenced by a graph's notes, with size/mtime + which notes use it (backlinks)
function graphAssets(g) {
  const doc = g.store.doc;
  if (!doc || !doc.nodes) return [];
  const pm = buildParentMap(doc);
  const byUrl = new Map();
  for (const id in doc.nodes) {
    for (const f of (doc.nodes[id].files || [])) {
      if (!f || !f.url) continue;
      let a = byUrl.get(f.url);
      if (!a) { a = { url: f.url, name: f.name || '', type: f.type || '', size: f.size ?? null, refs: [] }; byUrl.set(f.url, a); }
      if (a.size == null && f.size != null) a.size = f.size;
      const page = pageIdOf(doc, id, pm);
      a.refs.push({ node: id, page, pageTitle: page ? (serverPlain(doc.nodes[page]?.text).trim() || 'Untitled') : '' });
    }
  }
  const out = [];
  for (const a of byUrl.values()) {
    const stored = storedFromUrl(a.url);
    const st = stored ? fileStat(stored) : null;
    out.push({ ...a, size: a.size ?? (st ? st.size : null), mtime: st ? st.mtime : null, missing: !st });
  }
  return out.sort((x, y) => (y.mtime || 0) - (x.mtime || 0));
}
// urls referenced by ANY graph (∪ the requesting one) — for orphan detection
function allReferencedUrls(currentGid) {
  const urls = new Set();
  const gids = new Set([...accounts.allGraphIds(), currentGid].filter(Boolean));
  for (const gid of gids) {
    const doc = getGraph(gid).store.doc;
    if (!doc || !doc.nodes) continue;
    for (const id in doc.nodes) for (const f of (doc.nodes[id].files || [])) if (f && f.url) urls.add(f.url);
  }
  return urls;
}

/* ---------- usage stats & storage quota ---------- */

// content-based usage for a user, summed over the graphs they own: page count, note-text bytes,
// and referenced-file bytes (deduped). Pages = top-level nodes (child of root, not the calendar
// container) plus journal days (cal === 'day') — matching the client's page definition.
function userStats(userId) {
  const owned = accounts.graphsForUser(userId).filter(g => g.ownerId === userId);
  let pages = 0, noteBytes = 0, fileBytes = 0;
  const seenFiles = new Set();
  for (const g of owned) {
    const doc = getGraph(g.id).store.doc;
    if (!doc || !doc.nodes) continue;
    const root = doc.root || 'root';
    for (const id in doc.nodes) {
      const n = doc.nodes[id];
      noteBytes += Buffer.byteLength(n.text || '', 'utf8') + Buffer.byteLength(n.note || '', 'utf8');
      for (const f of (n.files || [])) {
        if (!f || !f.url || seenFiles.has(f.url)) continue;
        seenFiles.add(f.url);
        const name = storedFromUrl(f.url);
        const st = name && fileStat(name);
        if (st) fileBytes += st.size;
      }
      if (n.cal === 'day') pages++;
    }
    for (const cid of (doc.nodes[root]?.children || [])) {
      if (doc.nodes[cid] && doc.nodes[cid].cal !== 'root') pages++;
    }
  }
  return { pages, noteBytes, fileBytes, totalBytes: noteBytes + fileBytes };
}

const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' B';

// global quota config (bytes, 0 = unlimited) + a soft-overshoot tolerance in percent
function quotaConfig() {
  return {
    bytes: Number(accounts.getSetting('quotaBytes')) || 0,
    tolerancePct: Number(accounts.getSetting('quotaTolerancePct')) || 0,
  };
}
// the quota that applies to one user: a per-user override (settings key quota:<id>) wins over the
// global default; tolerance stays global. Returns { bytes, tolerancePct, hardCap, source }.
function effectiveQuota(userId) {
  const g = quotaConfig();
  const per = accounts.getSetting('quota:' + userId);
  const overridden = per != null && String(per).trim() !== '';
  const bytes = overridden ? (Number(per) || 0) : g.bytes;
  const hardCap = bytes > 0 ? Math.floor(bytes * (1 + g.tolerancePct / 100)) : 0;
  return { bytes, tolerancePct: g.tolerancePct, hardCap, source: overridden ? 'user' : 'global' };
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  const url = req.url || '/';

  try {
    /* ---- MCP server (JSON-RPC over HTTP): a key/agent-token client reads + edits its graph ---- */
    if (url.split('?')[0] === '/mcp') return await handleMcp(req, res, url);

    /* ---- per-node REST API — agent token / session → the admin's graph; an rzk_ key → its graph at its scope ---- */
    if (url.startsWith('/api/v1')) {
      const key = apiKeyFor(req, url);
      if (key) return await handleV1(req, res, url, getGraph(key.graphId), key.scope);
      return await handleV1(req, res, url, getGraph(defaultGraphId()));
    }

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
          prefs: u ? accounts.getUserPrefs(u.id) : {}, // cross-device preferences
          authRequired: accounts.userCount() > 0,
          inviteRequired: !!currentInviteCode(),
          ai: !!AI_KEY,
        });
      }
      // usage stats + the storage quota that applies to the signed-in user (for the Statistics view)
      if (url === '/api/me/stats' && req.method === 'GET') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'unauthorized' });
        const q = effectiveQuota(u.id);
        return send(res, 200, { ...userStats(u.id), quotaBytes: q.bytes, tolerancePct: q.tolerancePct });
      }
      // cross-device user preferences (shared web ⇄ iOS): a small merged JSON blob
      if (url === '/api/account/prefs') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        if (req.method === 'GET') return send(res, 200, { prefs: accounts.getUserPrefs(u.id) });
        if (req.method === 'PUT') {
          const body = await readJson(req);
          const incoming = (body && typeof body.prefs === 'object' && body.prefs) ? body.prefs : {};
          const merged = Object.assign(accounts.getUserPrefs(u.id), incoming);
          accounts.setUserPrefs(u.id, merged);
          return send(res, 200, { prefs: merged });
        }
      }
      if (url === '/api/register' && req.method === 'POST') {
        if (throttled(ip)) return send(res, 429, { error: 'too many attempts — try again in 10 minutes' });
        const body = await readJson(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const invite = currentInviteCode();
        if (invite && !timingSafeEq(String(body.invite || ''), invite)) {
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
        return send(res, 200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': sessionCookie(token, isHttps(req)) });
      }
      if (url === '/api/login' && req.method === 'POST') {
        if (throttled(ip)) return send(res, 429, { error: 'too many attempts — try again in 10 minutes' });
        const body = await readJson(req);
        const username = String(body.username || '');
        const existing = accounts.userByName(username);
        // per-account lockout (fail2ban): a locked account can't log in even with the right password
        if (existing && accounts.lockedNow(existing)) {
          accounts.recordLoginEvent(username, ip, false);
          const until = existing.locked_until;
          return send(res, 423, { error: until ? 'account locked — try again later or ask an admin' : 'account locked — ask an admin to unlock it' });
        }
        const user = accounts.verifyLogin(username, String(body.password || ''));
        let ok = !!user;
        if (ok && TOTP_SECRET) ok = totpValid(TOTP_SECRET, body.code); // optional global second factor
        recordAttempt(ip, ok);
        accounts.recordLoginEvent(username, ip, ok);
        if (!ok) {
          if (existing) { // count the failure against the account and lock past the threshold
            const n = accounts.noteLoginFailure(existing.id);
            const threshold = parseInt(accounts.getSetting('lockout_threshold') || '5', 10);
            if (threshold > 0 && n >= threshold) {
              const mode = accounts.getSetting('lockout_mode') || 'auto';
              const mins = parseInt(accounts.getSetting('lockout_minutes') || '15', 10);
              accounts.lockUser(existing.id, mode === 'manual' ? 0 : Date.now() + mins * 60000);
            }
          }
          return send(res, 401, { error: user ? 'wrong code' : 'wrong username or password' });
        }
        accounts.unlockUser(user.id); // success clears the failure counter + any timed lock
        accounts.setLastLogin(user.id);
        const token = accounts.newSession(user.id);
        return send(res, 200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': sessionCookie(token, isHttps(req)) });
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
      // self-serve account deletion (App Store 5.1.1(v)): removes the user, the graphs
      // they solely own, and those graphs' files. Confirmed by re-entering the password.
      if (url === '/api/account' && req.method === 'DELETE') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        const body = await readJson(req);
        if (!accounts.verifyLogin(u.username, String(body.password || ''))) return send(res, 403, { error: 'password is wrong' });
        if (u.is_admin && accounts.adminCount() <= 1) return send(res, 400, { error: 'the last admin account cannot be deleted' });
        for (const g of accounts.graphsForUser(u.id).filter(x => x.ownerId === u.id)) {
          accounts.deleteGraph(g.id);
          graphCache.delete(g.id);
          try { fs.rmSync(path.join(GRAPHS_DIR, g.id), { recursive: true, force: true }); } catch { /* already gone */ }
          for (const t of Object.keys(shares)) if (shares[t].graph === g.id) delete shares[t];
        }
        persistShares();
        accounts.deleteUser(u.id);
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'rz_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
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
      // API keys: per-graph scoped tokens the user creates/deletes (plaintext shown once)
      if (url === '/api/keys' && req.method === 'GET') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        return send(res, 200, { keys: accounts.listApiKeys(u.id) });
      }
      if (url === '/api/keys' && req.method === 'POST') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        const body = await readJson(req);
        const gid = String(body.graphId || '');
        if (!accounts.roleOf(u.id, gid)) return send(res, 403, { error: 'no access to that graph' });
        return send(res, 200, accounts.createApiKey(u.id, gid, String(body.name || 'API key'), body.scope));
      }
      const keyDelM = url.match(/^\/api\/keys\/([A-Za-z0-9]+)$/);
      if (keyDelM && req.method === 'DELETE') {
        const u = currentUser(req);
        if (!u) return send(res, 401, { error: 'not signed in' });
        accounts.deleteApiKey(keyDelM[1], u.id);
        return send(res, 200, { ok: true });
      }
      // admin panel (Phase 5): user list with stats, delete users, manage the invite code
      if (url === '/api/admin/users' && req.method === 'GET') {
        if (!requireAdmin(req)) return send(res, 403, { error: 'admin only' });
        const users = accounts.listUsers().map(u => {
          const owned = accounts.graphsForUser(u.id).filter(g => g.ownerId === u.id);
          let notes = 0, bytes = 0;
          for (const g of owned) {
            const doc = getGraph(g.id).store.doc;
            if (doc && doc.nodes) notes += Object.keys(doc.nodes).length;
            const dir = path.join(GRAPHS_DIR, g.id);
            for (const f of ['outline.db', 'outline.db-wal']) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* none */ } }
            try { for (const bk of fs.readdirSync(path.join(dir, 'backups'))) bytes += fs.statSync(path.join(dir, 'backups', bk)).size; } catch { /* none */ }
          }
          const q = effectiveQuota(u.id);
          return { id: u.id, username: u.username, email: u.email || null, isAdmin: !!u.is_admin, lastLogin: u.last_login, created: u.created,
            graphs: owned.length, notes, bytes, used: userStats(u.id).totalBytes, quotaBytes: q.bytes, quotaSource: q.source };
        });
        return send(res, 200, { users });
      }
      const adminUserM = url.match(/^\/api\/admin\/users\/([A-Za-z0-9]+)$/);
      if (adminUserM && req.method === 'PATCH') {
        const admin = requireAdmin(req);
        if (!admin) return send(res, 403, { error: 'admin only' });
        const target = accounts.userById(adminUserM[1]);
        if (!target) return send(res, 404, { error: 'user not found' });
        const body = await readJson(req);
        // username: same rule as registration; must stay unique (case-insensitive)
        if (body.username != null) {
          const username = String(body.username).trim();
          if (!/^[\w.\- ]{2,40}$/.test(username)) return send(res, 400, { error: 'username must be 2–40 chars (letters, numbers, . _ - space)' });
          const clash = accounts.userByName(username);
          if (clash && clash.id !== target.id) return send(res, 409, { error: 'that username is taken' });
          accounts.setUsername(target.id, username);
        }
        // email: optional — empty string clears it, otherwise a light shape check
        if (body.email != null) {
          const email = String(body.email).trim();
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'that email address looks invalid' });
          accounts.setEmail(target.id, email);
        }
        // password: reset without knowing the current one (admin action)
        if (body.password != null) {
          if (String(body.password).length < 6) return send(res, 400, { error: 'password must be at least 6 characters' });
          accounts.setPassword(target.id, String(body.password));
        }
        const u = accounts.userById(target.id);
        return send(res, 200, { user: { id: u.id, username: u.username, email: u.email || null, isAdmin: !!u.is_admin } });
      }
      const adminDelM = adminUserM;
      if (adminDelM && req.method === 'DELETE') {
        const admin = requireAdmin(req);
        if (!admin) return send(res, 403, { error: 'admin only' });
        const targetId = adminDelM[1];
        const target = accounts.userById(targetId);
        if (!target) return send(res, 404, { error: 'user not found' });
        if (targetId === admin.id) return send(res, 400, { error: 'you cannot delete yourself' });
        if (target.is_admin && accounts.adminCount() <= 1) return send(res, 400, { error: 'cannot delete the last admin' });
        for (const g of accounts.graphsForUser(targetId).filter(x => x.ownerId === targetId)) {
          accounts.deleteGraph(g.id);
          graphCache.delete(g.id);
          try { fs.rmSync(path.join(GRAPHS_DIR, g.id), { recursive: true, force: true }); } catch { /* already gone */ }
          for (const t of Object.keys(shares)) if (shares[t].graph === g.id) delete shares[t];
        }
        persistShares();
        accounts.deleteUser(targetId);
        return send(res, 200, { ok: true });
      }
      if (url === '/api/admin/invite') {
        const admin = requireAdmin(req);
        if (!admin) return send(res, 403, { error: 'admin only' });
        if (req.method === 'GET') return send(res, 200, { code: currentInviteCode() });
        if (req.method === 'PUT') {
          const code = String((await readJson(req)).code || '');
          accounts.setSetting('invite_code', code || null); // empty → clear (falls back to the env default)
          return send(res, 200, { code: currentInviteCode() });
        }
      }
      // storage quota: a global default (bytes) + a soft-overshoot tolerance (percent)
      if (url === '/api/admin/quota') {
        const admin = requireAdmin(req);
        if (!admin) return send(res, 403, { error: 'admin only' });
        if (req.method === 'GET') return send(res, 200, quotaConfig());
        if (req.method === 'PUT') {
          const b = await readJson(req);
          accounts.setSetting('quotaBytes', Math.max(0, Math.floor(Number(b.bytes) || 0)) || null);
          accounts.setSetting('quotaTolerancePct', Math.max(0, Math.floor(Number(b.tolerancePct) || 0)) || null);
          return send(res, 200, quotaConfig());
        }
      }
      // per-user quota override (bytes; empty/0 → fall back to the global default)
      const quotaUserM = url.match(/^\/api\/admin\/users\/([A-Za-z0-9]+)\/quota$/);
      if (quotaUserM && req.method === 'PUT') {
        if (!requireAdmin(req)) return send(res, 403, { error: 'admin only' });
        const b = await readJson(req);
        const bytes = Math.max(0, Math.floor(Number(b.bytes) || 0));
        accounts.setSetting('quota:' + quotaUserM[1], bytes > 0 ? bytes : null);
        return send(res, 200, { ...effectiveQuota(quotaUserM[1]) });
      }
      // login security (Phase: fail2ban): lockout policy, locked accounts, the login log
      if (url === '/api/admin/security') {
        if (!requireAdmin(req)) return send(res, 403, { error: 'admin only' });
        if (req.method === 'GET') {
          return send(res, 200, {
            threshold: parseInt(accounts.getSetting('lockout_threshold') || '5', 10),
            mode: accounts.getSetting('lockout_mode') || 'auto',
            minutes: parseInt(accounts.getSetting('lockout_minutes') || '15', 10),
            locked: accounts.lockedUsers(),
            events: accounts.recentLoginEvents(100),
          });
        }
        if (req.method === 'PUT') {
          const body = await readJson(req);
          if ('threshold' in body) accounts.setSetting('lockout_threshold', String(Math.max(0, parseInt(body.threshold, 10) || 0)));
          if ('mode' in body) accounts.setSetting('lockout_mode', body.mode === 'manual' ? 'manual' : 'auto');
          if ('minutes' in body) accounts.setSetting('lockout_minutes', String(Math.max(1, parseInt(body.minutes, 10) || 15)));
          return send(res, 200, { ok: true });
        }
      }
      const unlockM = url.match(/^\/api\/admin\/users\/([A-Za-z0-9]+)\/unlock$/);
      if (unlockM && req.method === 'POST') {
        if (!requireAdmin(req)) return send(res, 403, { error: 'admin only' });
        accounts.unlockUser(unlockM[1]);
        return send(res, 200, { ok: true });
      }
      if (url.startsWith('/api/capture') && req.method === 'POST') {
        const user = currentUser(req);
        const key = user ? null : apiKeyFor(req, url); // a write-scoped API key captures into its graph
        const allowed = !!user || (key && key.scope === 'write') || accounts.userCount() === 0;
        if (!allowed) return send(res, 401, { error: 'unauthorized' });
        if (!user && apiRateLimited('cap:' + (key ? key.id : req.socket.remoteAddress))) return send(res, 429, { error: 'rate limited — slow down' });
        // a session captures into its own first graph; an API key into its graph; open mode → default graph
        const gid = user ? accounts.graphsForUser(user.id)[0]?.id : (key ? key.graphId : defaultGraphId());
        const g = gid && getGraph(gid);
        if (!g) return send(res, 400, { error: 'no graph to capture into' });
        const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
        let text = raw;
        let deviceName = new URL(url, 'http://x').searchParams.get('deviceName') || '';
        try { const j = JSON.parse(raw); if (typeof j.text === 'string') text = j.text; if (typeof j.deviceName === 'string') deviceName = j.deviceName; } catch { /* plain text body */ }
        const count = captureText(g, text, deviceName);
        return send(res, 200, { ok: true, captured: count });
      }

      /* ---- page version history: /api/g/:g/history/:pageId[/:versionId[/restore]] ---- */
      const hm = url.match(/^\/api\/g\/([A-Za-z0-9]+)\/history\/([A-Za-z0-9_-]+)(?:\/(\d+)(\/restore)?)?(?:\?.*)?$/);
      if (hm) {
        const gid = hm[1], pageId = hm[2], versionId = hm[3] ? parseInt(hm[3], 10) : null, restore = !!hm[4];
        const open = accounts.userCount() === 0;
        const user = currentUser(req);
        if (!open && !user) return send(res, 401, { error: 'unauthorized' });
        if (!open && !accounts.roleOf(user.id, gid)) return send(res, 403, { error: 'no access to this graph' });
        const g = getGraph(gid);
        if (versionId == null && req.method === 'GET') {
          return send(res, 200, { versions: g.db.historyList(pageId) });
        }
        if (versionId != null && !restore && req.method === 'GET') {
          const docJson = g.db.historyGet(pageId, versionId);
          return docJson ? send(res, 200, { doc: JSON.parse(docJson) }) : send(res, 404, { error: 'no such version' });
        }
        if (versionId != null && restore && req.method === 'POST') {
          const docJson = g.db.historyGet(pageId, versionId);
          if (!docJson) return send(res, 404, { error: 'no such version' });
          const body = await readJson(req).catch(() => ({}));
          g.historyDevice = String(body.deviceName || '').slice(0, 60) || g.historyDevice;
          const v = restorePage(g, pageId, JSON.parse(docJson), body.device);
          return send(res, 200, { version: v });
        }
        return send(res, 404, { error: 'not found' });
      }

      /* ---- asset management: /api/g/:graphId/assets[/orphans][/delete|/rename] ---- */
      const am = url.match(/^\/api\/g\/([A-Za-z0-9]+)\/assets(\/orphans)?(\/[a-z]+)?(?:\?.*)?$/);
      if (am) {
        const gid = am[1], isOrphans = !!am[2], action = am[3] ? am[3].slice(1) : '', method = req.method;
        const isDelete = action === 'delete', isRename = action === 'rename';
        const open = accounts.userCount() === 0;
        const user = currentUser(req);
        if (!open && !user) return send(res, 401, { error: 'unauthorized' });
        const role = (!open && user) ? accounts.roleOf(user.id, gid) : null;
        if (!open && !role) return send(res, 403, { error: 'no access to this graph' });
        const g = getGraph(gid);
        const isOwner = open || role === 'owner' || (user && user.is_admin);

        if (isOrphans) {
          if (!isOwner) return send(res, 403, { error: 'owner only' });
          if (method === 'GET') {
            const refd = allReferencedUrls(gid);
            const out = [];
            for (const name of fs.readdirSync(FILES_DIR)) {
              const furl = `/files/${encodeURIComponent(name)}`;
              if (refd.has(furl)) continue;
              const st = fileStat(name);
              out.push({ name, url: furl, size: st ? st.size : null, mtime: st ? st.mtime : null });
            }
            return send(res, 200, { orphans: out.sort((x, y) => (y.mtime || 0) - (x.mtime || 0)) });
          }
          if (method === 'POST' && isDelete) {
            const body = await readJson(req);
            const refd = allReferencedUrls(gid);
            let removed = 0;
            for (const name of (Array.isArray(body.names) ? body.names : [])) {
              const stored = storedFromUrl(`/files/${encodeURIComponent(String(name))}`);
              if (!stored || refd.has(`/files/${encodeURIComponent(stored)}`)) continue; // still used → skip
              try { fs.unlinkSync(path.join(FILES_DIR, stored)); removed++; } catch { /* already gone */ }
            }
            return send(res, 200, { removed });
          }
          if (method === 'POST' && isRename) {  // rename an unused file on disk
            const body = await readJson(req);
            const stored = storedFromUrl(`/files/${encodeURIComponent(String(body.name || ''))}`);
            if (!stored) return send(res, 400, { error: 'bad name' });
            if (allReferencedUrls(gid).has(`/files/${encodeURIComponent(stored)}`)) return send(res, 409, { error: 'file is in use' });
            const safe = path.basename(String(body.newName || '')).replace(/[^\w.\- ()]/g, '_').slice(0, 120).trim();
            if (!safe) return send(res, 400, { error: 'bad new name' });
            let dest = safe;
            if (dest !== stored && fs.existsSync(path.join(FILES_DIR, dest))) dest = `${uid()}-${safe}`;
            try { fs.renameSync(path.join(FILES_DIR, stored), path.join(FILES_DIR, dest)); }
            catch { return send(res, 500, { error: 'rename failed' }); }
            return send(res, 200, { name: dest, url: `/files/${encodeURIComponent(dest)}` });
          }
          return send(res, 404, { error: 'not found' });
        }

        if (method === 'GET' && !action) return send(res, 200, { assets: graphAssets(g) });
        if (method === 'POST' && isRename) {
          const body = await readJson(req);
          const furl = String(body.url || '');
          const name = String(body.name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
          if (!furl.startsWith('/files/') || !name) return send(res, 400, { error: 'bad request' });
          const doc = g.store.doc;
          let changed = false;
          if (doc && doc.nodes) {
            for (const id in doc.nodes) {
              const n = doc.nodes[id];
              const match = (n.files || []).find(f => f && f.url === furl);
              if (!match) continue;
              const old = match.name;
              if (match.name !== name) { match.name = name; changed = true; }
              // also rename the bullet's text label if it was the auto file-name label (not a
              // custom caption the user typed), so clicking the image shows the new name
              if (old && serverPlain(n.text).trim() === String(old).trim()) { n.text = escHtml(name); changed = true; }
            }
          }
          const version = changed ? commitDoc(g, doc, 'assets') : g.store.version;
          return send(res, 200, { version });
        }
        if (method === 'POST' && isDelete) {
          const body = await readJson(req);
          const furl = String(body.url || '');
          if (!furl.startsWith('/files/')) return send(res, 400, { error: 'bad url' });
          const doc = g.store.doc;
          let changed = false;
          if (doc && doc.nodes) {
            for (const id in doc.nodes) {
              const n = doc.nodes[id];
              if (!n.files || !n.files.length) continue;
              const kept = n.files.filter(f => f && f.url !== furl);
              if (kept.length !== n.files.length) { if (kept.length) n.files = kept; else delete n.files; changed = true; }
            }
          }
          const version = changed ? commitDoc(g, doc, 'assets') : g.store.version;
          if (!allReferencedUrls(gid).has(furl)) {  // no graph uses it anymore → drop from disk
            const stored = storedFromUrl(furl);
            if (stored) { try { fs.unlinkSync(path.join(FILES_DIR, stored)); } catch { /* already gone */ } }
          }
          return send(res, 200, { version });
        }
        return send(res, 404, { error: 'not found' });
      }

      /* ---- graph-scoped endpoints: /api/g/:graphId/… (membership required) ---- */
      const gm = url.match(/^\/api\/g\/([A-Za-z0-9]+)\/([a-z]+)(\/[a-f0-9]+)?(?:\?.*)?$/);
      if (gm) {
        const gid = gm[1], seg = gm[2], method = req.method;
        const open = accounts.userCount() === 0;
        const user = currentUser(req);
        const key = user ? null : apiKeyFor(req, url); // a session takes precedence over a key
        if (!open && !user && !key) return send(res, 401, { error: 'unauthorized' });
        let g = null, readonly = false;
        if (open) g = getGraph(gid);
        else if (user) { if (accounts.roleOf(user.id, gid)) g = getGraph(gid); }
        else if (key && key.graphId === gid) { g = getGraph(gid); readonly = key.scope !== 'write'; }
        if (!g) return send(res, 403, { error: 'no access to this graph' });
        if (readonly && method !== 'GET') return send(res, 403, { error: 'this API key is read-only' });
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
          g.historyDevice = String(body.deviceName || '').slice(0, 60) || g.historyDevice;
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
          g.historyDevice = String(body.deviceName || '').slice(0, 60) || g.historyDevice;
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
          let deviceName = new URL(url, 'http://x').searchParams.get('deviceName') || '';
          try { const j = JSON.parse(raw); if (typeof j.text === 'string') text = j.text; if (typeof j.deviceName === 'string') deviceName = j.deviceName; } catch { /* plain text body */ }
          return send(res, 200, { ok: true, captured: captureText(g, text, deviceName) });
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
        // storage quota: block a session user's upload once it would push them past the hard cap
        // (quota + tolerance). Notes are never blocked; agent-token / open-instance uploads skip this.
        const upUser = currentUser(req);
        if (upUser) {
          const q = effectiveQuota(upUser.id);
          if (q.hardCap > 0 && userStats(upUser.id).totalBytes + data.length > q.hardCap) {
            return send(res, 413, { error: `storage quota exceeded (${fmtBytes(userStats(upUser.id).totalBytes)} of ${fmtBytes(q.bytes)})` });
          }
        }
        const stored = `${crypto.randomBytes(12).toString('hex')}-${safe}`; // 96-bit unguessable prefix
        await fsp.writeFile(path.join(FILES_DIR, stored), cryptobox.encrypt(data));
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

      if (url.startsWith('/api/geocode') && req.method === 'GET') {
        if (!currentUser(req) && accounts.userCount() > 0) return send(res, 401, { error: 'unauthorized' });
        const p = new URLSearchParams(url.split('?')[1] || '');
        const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return send(res, 400, { error: 'bad coordinates' });
        }
        try {
          return send(res, 200, { address: await reverseGeocode(lat, lon) });
        } catch (err) {
          return send(res, 502, { error: 'geocode failed: ' + err.message });
        }
      }

      return send(res, 404, { error: 'not found' });
    }

    if (url.startsWith('/files/')) {
      // attachments are private: only a member of a graph that references the file (or a
      // public share, or an open instance) may read it — compare the raw url as stored in node.files
      if (!userCanReadFile(req, url.split('?')[0])) {
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
  if (AGENT_TOKEN) console.log('Node API: /api/v1 (agent token enabled)');
  console.log('MCP server: POST /mcp (auth with a write/read-scoped API key)');
  if (AI_KEY) console.log(`Ask AI: enabled (${AI_MODEL})`);
});
