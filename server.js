/*
 * Tendril — self-hostable infinite outliner.
 * Zero-dependency Node.js server: static files + JSON document API + live sync.
 *
 *   node server.js
 *   node server.js --gen-totp     # generate a TOTP secret for MFA
 *
 * Environment:
 *   PORT                  port to listen on            (default 3000)
 *   HOST                  interface to bind            (default 0.0.0.0)
 *   DATA_DIR              where the outline is stored  (default ./data)
 *   TENDRIL_PASSWORD      if set, the app requires this password to log in
 *   TENDRIL_TOTP_SECRET   if set (base32), login additionally requires a TOTP code
 *   TENDRIL_CAPTURE_TOKEN if set, POST /api/capture with this token appends to the Inbox
 *   TENDRIL_AGENT_TOKEN   if set, unlocks the per-node REST API at /api/v1 (Bearer or ?token=)
 *   ANTHROPIC_API_KEY     if set, enables the in-app "Ask AI" assistant
 *   TENDRIL_AI_MODEL      Claude model for Ask AI      (default claude-opus-4-8)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOC_FILE = path.join(DATA_DIR, 'outline.json');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const FILES_DIR = path.join(DATA_DIR, 'files');
const PASSWORD = process.env.TENDRIL_PASSWORD || '';
const TOTP_SECRET = process.env.TENDRIL_TOTP_SECRET || '';
const CAPTURE_TOKEN = process.env.TENDRIL_CAPTURE_TOKEN || '';
const AGENT_TOKEN = process.env.TENDRIL_AGENT_TOKEN || '';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.TENDRIL_AI_MODEL || 'claude-opus-4-8';
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
  console.log('TOTP secret (set as TENDRIL_TOTP_SECRET):\n  ' + secret);
  console.log('\nAdd to your authenticator app with this URI:');
  console.log(`  otpauth://totp/Tendril?secret=${secret}&issuer=Tendril`);
  process.exit(0);
}

/* ---------- storage ---------- */

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

function authToken() {
  return crypto.createHmac('sha256', SECRET).update('auth:' + PASSWORD + ':' + TOTP_SECRET).digest('hex');
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
 * @typedef {{ version:number, doc:Doc|null }} Store
 */

/** @type {Store} */
let store = { version: 0, doc: null };
try {
  store = JSON.parse(fs.readFileSync(DOC_FILE, 'utf8'));
  if (typeof store.version !== 'number') store.version = 0;
} catch { /* fresh install */ }

let shares = {};
try { shares = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); } catch { /* none */ }

function persistShares() {
  fs.writeFileSync(SHARES_FILE, JSON.stringify(shares, null, 1));
}

let lastBackupAt = 0;
try {
  const entries = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  if (entries.length) lastBackupAt = fs.statSync(path.join(BACKUP_DIR, entries[entries.length - 1])).mtimeMs;
} catch { /* ignore */ }

let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(store);
  writeChain = writeChain.then(async () => {
    const tmp = DOC_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, DOC_FILE);
    const now = Date.now();
    if (now - lastBackupAt > BACKUP_EVERY_MS) {
      lastBackupAt = now;
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      await fsp.writeFile(path.join(BACKUP_DIR, `outline-${stamp}.json`), snapshot, 'utf8');
      const all = (await fsp.readdir(BACKUP_DIR)).filter(f => f.endsWith('.json')).sort();
      for (const stale of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
        await fsp.unlink(path.join(BACKUP_DIR, stale)).catch(() => {});
      }
    }
  }).catch(err => console.error('persist failed:', err));
  return writeChain;
}

/* ---------- live sync (SSE) ---------- */

const sseClients = new Set();

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try { res.write(':hb\n\n'); } catch { sseClients.delete(res); }
  }
}, 25000).unref();

function commitDoc(doc) {
  store = { version: store.version + 1, doc };
  persist();
  broadcast({ version: store.version });
  return store.version;
}

/* ---------- doc helpers (server-side mutations: capture, share merge) ---------- */

const uid = () => Date.now().toString(36).slice(-6) + crypto.randomBytes(4).toString('hex').slice(0, 6);

/** @param {string} text @returns {Node} */
function makeNode(text) {
  return { id: uid(), text, note: null, done: false, collapsed: false, children: [], m: Date.now() };
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

function captureText(text) {
  const doc = ensureDoc();
  let inboxId = doc.nodes.root.children.find(id => {
    const t = (doc.nodes[id]?.text || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
    return t === 'inbox';
  });
  if (!inboxId) {
    const inbox = makeNode('Inbox');
    doc.nodes[inbox.id] = inbox;
    doc.nodes.root.children.unshift(inbox.id);
    inboxId = inbox.id;
  }
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
  if (count) commitDoc(doc);
  return count;
}

/* ---------- per-node API (v1) ---------- */

/** @returns {Doc} */
function ensureDoc() {
  if (!store.doc || !store.doc.nodes || !store.doc.nodes.root) {
    store.doc = { root: 'root', nodes: { root: { id: 'root', text: '', note: null, done: false, collapsed: false, children: [] } } };
  }
  return store.doc;
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

function nodeParent(id) {
  for (const pid of Object.keys(store.doc.nodes)) {
    if ((store.doc.nodes[pid].children || []).includes(id)) return pid;
  }
  return null;
}
function nodeDetach(id) {
  const p = nodeParent(id);
  if (p) { const a = store.doc.nodes[p].children; const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); }
}
function nodeInsert(parent, index, id) {
  const a = store.doc.nodes[parent].children;
  if (!Number.isInteger(index) || index < 0 || index > a.length) index = a.length;
  a.splice(index, 0, id);
}
const TRASH_CAP = 200;
// move a subtree into the trash (newest first, capped); returns its node ids
function pushTrash(doc, id, parent, index) {
  const ids = subtreeIds(doc, id);
  const nodes = {};
  for (const x of ids) nodes[x] = doc.nodes[x];
  if (!doc.trash) doc.trash = [];
  doc.trash.unshift({ ts: Date.now(), parent, index, root: id, nodes });
  if (doc.trash.length > TRASH_CAP) doc.trash = doc.trash.slice(0, TRASH_CAP);
  return ids;
}

function nodeDelete(id) {
  const parent = nodeParent(id);
  const ids = pushTrash(store.doc, id, parent, parent ? store.doc.nodes[parent].children.indexOf(id) : 0);
  nodeDetach(id);
  for (const x of ids) delete store.doc.nodes[x];
  return ids.length;
}
// `children` is polymorphic by design: child *ids* in the flat view, nested node
// objects under ?tree=1 (filled in by nodeTree). Hence the any[] in the contract.
/** @param {string} id @returns {{id:string,text:string,plain:string,note:string|null,done:boolean,collapsed:boolean,format:string,children:any[],created:number|null,modified:number|null,parent:string|null}} */
function nodeView(id) {
  const n = store.doc.nodes[id];
  return {
    id, text: n.text || '', plain: serverPlain(n.text), note: n.note ?? null,
    done: !!n.done, collapsed: !!n.collapsed, format: n.format || 'bullet',
    children: n.children || [], created: n.c ?? null, modified: n.m ?? null,
    parent: nodeParent(id),
  };
}
function nodeTree(id, depth) {
  const v = nodeView(id);
  if (depth === undefined || depth > 0) {
    v.children = (store.doc.nodes[id].children || []).map(c => nodeTree(c, depth === undefined ? undefined : depth - 1));
  }
  return v;
}
function apiSearch(q, limit) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const walk = (id, path) => {
    for (const c of (store.doc.nodes[id].children || [])) {
      const n = store.doc.nodes[c];
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

async function handleV1(req, res, url) {
  if (!apiAuthed(req, url)) return send(res, 401, { error: 'unauthorized — set TENDRIL_AGENT_TOKEN and send Authorization: Bearer <token>' });
  ensureDoc();
  const path = url.split('?')[0];
  const method = req.method;
  const u = new URL(url, 'http://x');

  if (path === '/api/v1' || path === '/api/v1/') {
    return send(res, 200, {
      name: 'Tendril node API', version: store.version,
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
  if (path === '/api/v1/version' && method === 'GET') return send(res, 200, { version: store.version });
  if (path === '/api/v1/doc' && method === 'GET') return send(res, 200, { version: store.version, doc: store.doc });
  if (path === '/api/v1/search' && method === 'GET') {
    const q = u.searchParams.get('q') || '';
    const lim = parseInt(u.searchParams.get('limit') || '50', 10);
    return send(res, 200, { results: q.trim() ? apiSearch(q, lim) : [] });
  }
  if (path === '/api/v1/nodes' && method === 'POST') {
    const body = await readJson(req);
    const parent = body.parent || 'root';
    if (!store.doc.nodes[parent]) return send(res, 400, { error: 'unknown parent node' });
    const now = Date.now();
    const node = {
      id: uid(), text: sanitizeServerHtml(body.text || ''),
      note: body.note != null ? String(body.note) : null,
      done: !!body.done, collapsed: false, children: [], c: now, m: now,
    };
    if (body.format) node.format = String(body.format);
    store.doc.nodes[node.id] = node;
    nodeInsert(parent, body.index, node.id);
    commitDoc(store.doc);
    return send(res, 201, nodeView(node.id));
  }

  const m = path.match(/^\/api\/v1\/nodes\/([A-Za-z0-9]+)(\/tree|\/children|\/move|\/complete)?$/);
  if (m) {
    const id = m[1], sub = m[2];
    if (!store.doc.nodes[id]) return send(res, 404, { error: 'node not found' });

    if (!sub && method === 'GET') {
      if (u.searchParams.get('tree')) {
        const d = u.searchParams.get('depth');
        return send(res, 200, nodeTree(id, d != null ? parseInt(d, 10) : undefined));
      }
      return send(res, 200, nodeView(id));
    }
    if (sub === '/children' && method === 'GET') {
      return send(res, 200, { children: (store.doc.nodes[id].children || []).map(nodeView) });
    }
    if (!sub && method === 'PATCH') {
      const body = await readJson(req);
      const n = store.doc.nodes[id];
      if ('text' in body) n.text = sanitizeServerHtml(String(body.text));
      if ('note' in body) n.note = body.note == null ? null : String(body.note);
      if ('done' in body) n.done = !!body.done;
      if ('collapsed' in body) n.collapsed = !!body.collapsed;
      if ('format' in body) { if (body.format) n.format = String(body.format); else delete n.format; }
      n.m = Date.now();
      commitDoc(store.doc);
      return send(res, 200, nodeView(id));
    }
    if (sub === '/complete' && method === 'POST') {
      const body = await readJson(req);
      store.doc.nodes[id].done = body.done === undefined ? true : !!body.done;
      store.doc.nodes[id].m = Date.now();
      commitDoc(store.doc);
      return send(res, 200, nodeView(id));
    }
    if (sub === '/move' && method === 'POST') {
      const body = await readJson(req);
      const target = body.parent || 'root';
      if (!store.doc.nodes[target]) return send(res, 400, { error: 'unknown target parent' });
      if (target === id || subtreeIds(store.doc, id).includes(target)) {
        return send(res, 400, { error: 'cannot move a node into itself or its own subtree' });
      }
      nodeDetach(id);
      nodeInsert(target, body.index, id);
      store.doc.nodes[id].m = Date.now();
      commitDoc(store.doc);
      return send(res, 200, nodeView(id));
    }
    if (!sub && method === 'DELETE') {
      if (id === 'root') return send(res, 400, { error: 'cannot delete the root' });
      const count = nodeDelete(id);
      commitDoc(store.doc);
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

function isAuthed(req) {
  if (!PASSWORD) return true;
  return timingSafeEq(cookies(req).tendril_auth || '', authToken());
}

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

function fileIsShared(urlPath) {
  const doc = store.doc;
  if (!doc) return false;
  return Object.values(shares).some(share =>
    doc.nodes[share.id] && subtreeIds(doc, share.id).some(id =>
      (doc.nodes[id].files || []).some(f => f && f.url === urlPath)));
}

function shareDocFor(share) {
  const doc = store.doc;
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
    files: Array.isArray(n.files) ? n.files.filter(f => f && safeFileUrl(f.url)) : undefined,
    comments: Array.isArray(n.comments) ? n.comments : undefined,
    m: Date.now(),
  };
}

function mergeShareDoc(share, incoming) {
  const doc = store.doc;
  if (!doc || !doc.nodes[share.id] || !incoming.nodes || !incoming.nodes[share.id]) return false;
  // a guest may only touch ids reachable from the share root in its own doc
  const allowed = new Set(subtreeIds(incoming, share.id));
  const before = subtreeIds(doc, share.id);

  // nodes the guest dropped go to the trash, not the void (one entry per detached subtree)
  const removed = new Set(before.filter(id => id !== share.id && !allowed.has(id)));
  for (const id of removed) {
    const p = nodeParent(id);
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
  commitDoc(doc);
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
    /* ---- per-node REST API (agent token or session cookie) ---- */
    if (url.startsWith('/api/v1')) return await handleV1(req, res, url);

    /* ---- share access (token-scoped, no cookie needed) ---- */
    const shareMatch = url.match(/^\/api\/share\/([a-f0-9]{24,})\/doc(\?.*)?$/);
    if (shareMatch) {
      const share = shares[shareMatch[1]];
      if (!share) return send(res, 404, { error: 'share not found or revoked' });
      if (req.method === 'GET') {
        const doc = shareDocFor(share);
        if (!doc) return send(res, 410, { error: 'shared item was deleted' });
        return send(res, 200, { version: store.version, doc, mode: share.mode, root: share.id });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (share.mode !== 'edit') return send(res, 403, { error: 'this share is view-only' });
        const body = await readJson(req);
        if (typeof body.baseVersion === 'number' && body.baseVersion !== store.version) {
          const doc = shareDocFor(share);
          return send(res, 409, { version: store.version, doc });
        }
        if (!mergeShareDoc(share, body.doc || {})) return send(res, 400, { error: 'malformed share document' });
        return send(res, 200, { version: store.version });
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    if (url.startsWith('/api/')) {
      /* ---- auth-free endpoints ---- */
      if (url === '/api/auth' && req.method === 'GET') {
        return send(res, 200, {
          required: !!PASSWORD,
          totp: !!(PASSWORD && TOTP_SECRET),
          ok: isAuthed(req),
          ai: !!AI_KEY,
        });
      }
      if (url === '/api/login' && req.method === 'POST') {
        if (throttled(ip)) return send(res, 429, { error: 'too many attempts — try again in 10 minutes' });
        const body = await readJson(req);
        let ok = !!PASSWORD && timingSafeEq(body.password || '', PASSWORD);
        if (ok && TOTP_SECRET) ok = totpValid(TOTP_SECRET, body.code);
        recordAttempt(ip, ok);
        if (!ok) return send(res, 401, { error: TOTP_SECRET ? 'wrong password or code' : 'wrong password' });
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `tendril_auth=${authToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
        });
      }
      if (url === '/api/logout' && req.method === 'POST') {
        return send(res, 200, { ok: true }, {
          'Set-Cookie': 'tendril_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
        });
      }
      if (url.startsWith('/api/capture') && req.method === 'POST') {
        const token = new URL(url, 'http://x').searchParams.get('token')
          || req.headers['x-capture-token'] || '';
        const allowed = (CAPTURE_TOKEN && timingSafeEq(token, CAPTURE_TOKEN)) || isAuthed(req);
        if (!allowed) return send(res, 401, { error: 'unauthorized' });
        const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
        let text = raw;
        try { const j = JSON.parse(raw); if (typeof j.text === 'string') text = j.text; } catch { /* plain text body */ }
        const count = captureText(text);
        return send(res, 200, { ok: true, captured: count });
      }

      /* ---- everything below requires auth ---- */
      if (!isAuthed(req)) return send(res, 401, { error: 'unauthorized' });

      if (url === '/api/doc' && req.method === 'GET') return send(res, 200, store);
      if (url === '/api/version' && req.method === 'GET') return send(res, 200, { version: store.version });
      if (url === '/api/doc' && (req.method === 'PUT' || req.method === 'POST')) {
        const body = await readJson(req);
        if (!body.doc || typeof body.doc !== 'object' || !body.doc.nodes) {
          return send(res, 400, { error: 'malformed document' });
        }
        if (typeof body.baseVersion === 'number' && body.baseVersion !== store.version) {
          return send(res, 409, store);
        }
        const v = commitDoc(sanitizeDocNodes(body.doc));
        return send(res, 200, { version: v });
      }

      if (url === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ version: store.version })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (url === '/api/shares' && req.method === 'GET') {
        return send(res, 200, Object.entries(shares).map(([token, s]) => ({ token, ...s })));
      }
      if (url === '/api/shares' && req.method === 'POST') {
        const body = await readJson(req);
        if (!store.doc?.nodes?.[body.nodeId]) return send(res, 400, { error: 'unknown node' });
        const token = crypto.randomBytes(16).toString('hex');
        shares[token] = { id: body.nodeId, mode: body.mode === 'edit' ? 'edit' : 'view', created: Date.now() };
        persistShares();
        return send(res, 200, { token, url: `/s/${token}` });
      }
      const delShare = url.match(/^\/api\/shares\/([a-f0-9]+)$/);
      if (delShare && req.method === 'DELETE') {
        delete shares[delShare[1]];
        persistShares();
        return send(res, 200, { ok: true });
      }

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
  console.log(`Tendril listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(PASSWORD ? `Password protection: ON${TOTP_SECRET ? ' + TOTP MFA' : ''}` : 'Password protection: off (set TENDRIL_PASSWORD to enable)');
  if (CAPTURE_TOKEN) console.log('Capture API: POST /api/capture?token=…');
  if (AGENT_TOKEN) console.log('Node API: /api/v1 (agent token enabled)');
  if (AI_KEY) console.log(`Ask AI: enabled (${AI_MODEL})`);
});
