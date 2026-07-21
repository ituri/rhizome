// @ts-nocheck  — node:sqlite is experimental; its type defs are too immature to check against.
'use strict';
/*
 * Accounts store — users, sessions, graphs and memberships.  node:sqlite, zero runtime
 * dependency (same pattern as db.js).  Lives in DATA_DIR/accounts.db, separate from the
 * per-graph document databases (DATA_DIR/graphs/<id>/outline.db).
 *
 * A user owns one or more graphs and may be a member (owner|editor) of graphs shared
 * with them.  Sessions are opaque random tokens stored server-side.
 */

// node:sqlite prints an ExperimentalWarning on require — silence just that one.
const _emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite is an experimental') ? undefined : _emit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = _emit;
const crypto = require('node:crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  created    INTEGER NOT NULL,
  last_login INTEGER,
  is_admin   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS graphs (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id  TEXT NOT NULL REFERENCES users(id),
  graph_id TEXT NOT NULL REFERENCES graphs(id),
  role     TEXT NOT NULL DEFAULT 'editor',
  created  INTEGER NOT NULL,
  PRIMARY KEY (user_id, graph_id)
);
CREATE INDEX IF NOT EXISTS memberships_graph ON memberships(graph_id);
CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created INTEGER NOT NULL,
  seen    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS api_keys (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id),
  graph_id  TEXT NOT NULL REFERENCES graphs(id),
  name      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  scope     TEXT NOT NULL DEFAULT 'read',
  created   INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_hash ON api_keys(hash);
CREATE TABLE IF NOT EXISTS login_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  ip       TEXT,
  ok       INTEGER NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_events_ts ON login_events(ts);
`;

const now = () => Date.now();
const uid = () => Date.now().toString(36).slice(-6) + crypto.randomBytes(5).toString('hex');

// scrypt password hashing — built-in, no dependency. Returns { hash, salt } (hex).
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

class Accounts {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this._migrate();
  }

  // add columns introduced after the first release to an already-created users table
  _migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
    if (!cols.has('last_login')) this.db.exec('ALTER TABLE users ADD COLUMN last_login INTEGER');
    if (!cols.has('is_admin')) this.db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('failed_count')) this.db.exec('ALTER TABLE users ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('locked_until')) this.db.exec('ALTER TABLE users ADD COLUMN locked_until INTEGER'); // 0 = manual lock, >now = timed, null/past = open
    if (!cols.has('email')) this.db.exec('ALTER TABLE users ADD COLUMN email TEXT'); // optional, admin-editable
  }

  /* ---------------- users ---------------- */

  userCount() { return this.db.prepare('SELECT COUNT(*) AS c FROM users').get().c; }
  userByName(username) { return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username)); }
  userById(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id); }

  createUser(username, password, isAdmin = false) {
    const { hash, salt } = hashPassword(password);
    const id = uid();
    this.db.prepare('INSERT INTO users(id,username,pass_hash,pass_salt,created,is_admin) VALUES(?,?,?,?,?,?)')
      .run(id, String(username).trim(), hash, salt, now(), isAdmin ? 1 : 0);
    return this.userById(id);
  }

  setLastLogin(userId) { this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), userId); }
  setAdmin(userId, on) { this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(on ? 1 : 0, userId); }
  // rename a user (caller validates format + uniqueness); the UNIQUE index is the backstop
  setUsername(userId, username) { this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(String(username).trim(), userId); }
  setEmail(userId, email) { this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email ? String(email).trim() : null, userId); }
  deleteUser(userId) {
    this.db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM memberships WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
  // for the admin panel — note/storage stats are added by the server (per-graph)
  listUsers() {
    return this.db.prepare('SELECT id, username, email, is_admin, last_login, created FROM users ORDER BY created').all();
  }
  adminCount() { return this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c; }

  /* ---------------- settings (runtime-editable, e.g. the invite code) ---------------- */

  getSetting(k) { const r = this.db.prepare('SELECT v FROM settings WHERE k = ?').get(k); return r ? r.v : null; }
  setSetting(k, v) {
    if (v == null) this.db.prepare('DELETE FROM settings WHERE k = ?').run(k);
    else this.db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  }

  // per-user cross-device preferences (a small JSON blob), stored in the settings table
  // under a namespaced key so no schema change is needed
  getUserPrefs(userId) { try { return JSON.parse(this.getSetting('uprefs:' + userId) || '{}'); } catch { return {}; } }
  setUserPrefs(userId, obj) { this.setSetting('uprefs:' + userId, JSON.stringify(obj || {})); }

  /* ---------------- API keys (per-graph, scoped) ---------------- */

  // returns { id, key } — the plaintext key is shown once; only its sha256 is stored
  createApiKey(userId, graphId, name, scope) {
    const plaintext = 'rzk_' + crypto.randomBytes(24).toString('hex');
    const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
    const id = uid();
    this.db.prepare('INSERT INTO api_keys(id,user_id,graph_id,name,hash,scope,created) VALUES(?,?,?,?,?,?,?)')
      .run(id, userId, graphId, String(name).slice(0, 60), hash, scope === 'write' ? 'write' : 'read', now());
    return { id, key: plaintext };
  }
  listApiKeys(userId) {
    return this.db.prepare(
      `SELECT k.id, k.name, k.graph_id AS graphId, g.name AS graphName, k.scope, k.created, k.last_used AS lastUsed
         FROM api_keys k JOIN graphs g ON g.id = k.graph_id WHERE k.user_id = ? ORDER BY k.created`).all(userId);
  }
  deleteApiKey(id, userId) { this.db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId); }

  /* ---------------- login security (fail2ban + audit log) ---------------- */

  recordLoginEvent(username, ip, ok) {
    this.db.prepare('INSERT INTO login_events(username,ip,ok,ts) VALUES(?,?,?,?)')
      .run(username ? String(username).slice(0, 60) : null, ip ? String(ip).slice(0, 60) : null, ok ? 1 : 0, now());
    this.db.prepare('DELETE FROM login_events WHERE id <= (SELECT MAX(id) FROM login_events) - 2000').run();
  }
  recentLoginEvents(limit = 100) {
    return this.db.prepare('SELECT username, ip, ok, ts FROM login_events ORDER BY id DESC LIMIT ?').all(Math.min(limit, 500));
  }
  noteLoginFailure(userId) {
    this.db.prepare('UPDATE users SET failed_count = failed_count + 1 WHERE id = ?').run(userId);
    return this.userById(userId).failed_count;
  }
  lockUser(userId, until) { this.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(until, userId); }
  unlockUser(userId) { this.db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?').run(userId); }
  // locked_until: null/past = open, 0 = manual (stays until unlocked), >now = timed
  lockedNow(user) { return !!user && (user.locked_until === 0 || (user.locked_until && user.locked_until > now())); }
  lockedUsers() {
    return this.db.prepare('SELECT id, username, failed_count, locked_until FROM users WHERE locked_until = 0 OR locked_until > ?').all(now());
  }
  // resolve a plaintext key → { id, userId, graphId, scope } (and stamp last_used), or null
  resolveApiKey(plaintext) {
    if (!plaintext || !plaintext.startsWith('rzk_')) return null;
    const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
    const r = this.db.prepare('SELECT id, user_id AS userId, graph_id AS graphId, scope FROM api_keys WHERE hash = ?').get(hash);
    if (!r) return null;
    this.db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(now(), r.id);
    return r;
  }

  // returns the user row on success, null on wrong username/password (constant-time compare)
  verifyLogin(username, password) {
    const u = this.userByName(username);
    if (!u) return null;
    const { hash } = hashPassword(password, u.pass_salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(u.pass_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return u;
  }

  setPassword(userId, password) {
    const { hash, salt } = hashPassword(password);
    this.db.prepare('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?').run(hash, salt, userId);
  }

  /* ---------------- sessions ---------------- */

  newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO sessions(token,user_id,created,seen) VALUES(?,?,?,?)').run(token, userId, now(), now());
    return token;
  }

  // resolve a session token → user row; drops & rejects sessions older than maxAgeMs
  sessionUser(token, maxAgeMs) {
    if (!token) return null;
    const s = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s) return null;
    if (maxAgeMs && now() - s.created > maxAgeMs) { this.dropSession(token); return null; }
    return this.userById(s.user_id) || null;
  }

  dropSession(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
  dropUserSessions(userId) { this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); }

  /* ---------------- graphs & memberships ---------------- */

  createGraph(name, ownerId, role = 'owner') {
    const id = uid();
    this.db.prepare('INSERT INTO graphs(id,name,owner_id,created) VALUES(?,?,?,?)').run(id, String(name), ownerId, now());
    this.db.prepare('INSERT INTO memberships(user_id,graph_id,role,created) VALUES(?,?,?,?)').run(ownerId, id, role, now());
    return this.graphById(id);
  }
  graphById(id) { return this.db.prepare('SELECT * FROM graphs WHERE id = ?').get(id); }
  allGraphIds() { return this.db.prepare('SELECT id FROM graphs').all().map(r => r.id); }
  renameGraph(id, name) { this.db.prepare('UPDATE graphs SET name = ? WHERE id = ?').run(String(name), id); }
  deleteGraph(id) {
    this.db.prepare('DELETE FROM api_keys WHERE graph_id = ?').run(id);
    this.db.prepare('DELETE FROM memberships WHERE graph_id = ?').run(id);
    this.db.prepare('DELETE FROM graphs WHERE id = ?').run(id);
  }

  // graphs a user can open (owned or shared with them), with their role
  graphsForUser(userId) {
    return this.db.prepare(
      `SELECT g.id, g.name, g.owner_id AS ownerId, g.created, m.role
         FROM graphs g JOIN memberships m ON m.graph_id = g.id
        WHERE m.user_id = ? ORDER BY g.created`).all(userId);
  }
  roleOf(userId, graphId) {
    const r = this.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND graph_id = ?').get(userId, graphId);
    return r ? r.role : null;
  }
  membersOf(graphId) {
    return this.db.prepare(
      `SELECT u.id, u.username, m.role FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.graph_id = ? ORDER BY m.created`).all(graphId);
  }
  addMember(userId, graphId, role = 'editor') {
    this.db.prepare('INSERT OR IGNORE INTO memberships(user_id,graph_id,role,created) VALUES(?,?,?,?)').run(userId, graphId, role, now());
  }
  removeMember(userId, graphId) {
    this.db.prepare('DELETE FROM memberships WHERE user_id = ? AND graph_id = ?').run(userId, graphId);
  }
}

module.exports = { Accounts };
