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
  deleteUser(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM memberships WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
  // for the admin panel — note/storage stats are added by the server (per-graph)
  listUsers() {
    return this.db.prepare('SELECT id, username, is_admin, last_login, created FROM users ORDER BY created').all();
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
  renameGraph(id, name) { this.db.prepare('UPDATE graphs SET name = ? WHERE id = ?').run(String(name), id); }
  deleteGraph(id) {
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
