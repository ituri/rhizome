// @ts-nocheck  — node:sqlite is experimental; its type defs are too immature to check against.
'use strict';
/*
 * Per-node SQLite store (Phase 1).  node:sqlite — zero runtime dependency.
 *
 * Phase 1 keeps the server's in-memory `doc` authoritative and the whole-doc wire
 * protocol unchanged; this module replaces *persistence* with incremental per-node
 * row writes (only changed nodes are written, not a 17 MB file) and adds FTS5 search.
 * The schema + oplog columns are forward-compatible with the Phase 2 op protocol.
 */

// node:sqlite prints an ExperimentalWarning on require — silence just that one.
const _emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite is an experimental') ? undefined : _emit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = _emit;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  ord        INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL,            -- JSON of the node minus its children array
  text       TEXT GENERATED ALWAYS AS (json_extract(data, '$.text')) VIRTUAL,
  note       TEXT GENERATED ALWAYS AS (json_extract(data, '$.note')) VIRTUAL
);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(text, note, content='nodes', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, text, note) VALUES (new.rowid, new.text, new.note);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, text, note) VALUES ('delete', old.rowid, old.text, old.note);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, text, note) VALUES ('delete', old.rowid, old.text, old.note);
  INSERT INTO nodes_fts(rowid, text, note) VALUES (new.rowid, new.text, new.note);
END;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- page version history: one snapshot of a page's subtree per edit-session, with the device name
CREATE TABLE IF NOT EXISTS versions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  device   TEXT,
  doc      TEXT NOT NULL              -- JSON { root, nodes } of the page subtree at that time
);
CREATE INDEX IF NOT EXISTS versions_page ON versions(page_id, id DESC);
`;

class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this._upsert = this.db.prepare('INSERT INTO nodes(id,parent_id,ord,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, ord=excluded.ord, data=excluded.data');
    this._del = this.db.prepare('DELETE FROM nodes WHERE id=?');
    this._getMeta = this.db.prepare('SELECT v FROM meta WHERE k=?');
    this._setMeta = this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    // in-memory shadow of last-persisted rows (id → "parent|ord|data") so diffing
    // the next save never has to read from disk
    this.shadow = new Map();
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  }

  meta(k, v) {
    if (v === undefined) { const r = this._getMeta.get(k); return r ? r.v : null; }
    this._setMeta.run(k, v);
  }

  isEmpty() { return this.db.prepare('SELECT 1 FROM nodes LIMIT 1').get() === undefined; }

  // ---- page version history ----
  historyAdd(pageId, ts, device, docJson) {
    this.db.prepare('INSERT INTO versions(page_id,ts,device,doc) VALUES(?,?,?,?)').run(pageId, ts, device, docJson);
    // keep only the newest 60 versions per page
    this.db.prepare('DELETE FROM versions WHERE page_id=? AND id NOT IN (SELECT id FROM versions WHERE page_id=? ORDER BY id DESC LIMIT 60)').run(pageId, pageId);
  }
  historyLatestDoc(pageId) { const r = this.db.prepare('SELECT doc FROM versions WHERE page_id=? ORDER BY id DESC LIMIT 1').get(pageId); return r ? r.doc : null; }
  historyList(pageId) { return this.db.prepare('SELECT id, ts, device FROM versions WHERE page_id=? ORDER BY id DESC LIMIT 100').all(pageId); }
  historyGet(pageId, id) { const r = this.db.prepare('SELECT doc FROM versions WHERE page_id=? AND id=?').get(pageId, id); return r ? r.doc : null; }

  get version() { return parseInt(this.meta('version') || '0', 10); }

  // flatten an in-memory doc → Map(id → { parent_id, ord, data })
  static flat(doc) {
    const order = new Map();
    for (const [pid, n] of Object.entries(doc.nodes)) {
      const kids = n.children || [];
      for (let i = 0; i < kids.length; i++) order.set(kids[i], { parent: pid, ord: i });
    }
    const out = new Map();
    for (const [id, n] of Object.entries(doc.nodes)) {
      const { children, ...rest } = n; // children is structural → derived from parent_id+ord
      const o = order.get(id);
      out.set(id, { parent_id: o ? o.parent : null, ord: o ? o.ord : 0, data: JSON.stringify(rest) });
    }
    return out;
  }

  // every non-root node's parent must be present → the persisted state is always a
  // valid forest. Refuse to write anything that would orphan a node (integrity by
  // construction, independent of FK-deferral quirks).
  static assertForest(flat) {
    for (const [id, r] of flat) {
      if (r.parent_id != null && !flat.has(r.parent_id)) throw new Error(`refusing orphan: ${id} → missing parent ${r.parent_id}`);
    }
  }

  // write every node as a row (migration / first load). version + side blobs in meta.
  importDoc(doc, version) {
    const flat = Store.flat(doc);
    Store.assertForest(flat);
    this.tx(() => {
      this.db.exec('PRAGMA defer_foreign_keys = ON'); // children may precede parents in iteration
      this.db.exec('DELETE FROM nodes');
      for (const [id, r] of flat) this._upsert.run(id, r.parent_id, r.ord, r.data);
      this.meta('version', String(version || 0));
      this.meta('trash', JSON.stringify(doc.trash || []));
      this.meta('docmeta', JSON.stringify(doc.meta || {}));
    });
    this.shadow = new Map([...flat].map(([id, r]) => [id, `${r.parent_id}|${r.ord}|${r.data}`]));
  }

  // rebuild the legacy in-memory doc from rows
  loadDoc() {
    const rows = this.db.prepare('SELECT id, parent_id, ord, data FROM nodes').all();
    const nodes = {};
    const childrenOf = new Map();
    this.shadow = new Map();
    for (const r of rows) {
      const n = JSON.parse(r.data);
      n.children = [];
      nodes[r.id] = n;
      this.shadow.set(r.id, `${r.parent_id}|${r.ord}|${r.data}`);
      if (r.parent_id != null) {
        if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, []);
        childrenOf.get(r.parent_id).push([r.ord, r.id]);
      }
    }
    for (const [pid, kids] of childrenOf) {
      if (!nodes[pid]) continue;
      kids.sort((a, b) => a[0] - b[0]);
      nodes[pid].children = kids.map(k => k[1]);
    }
    const doc = { root: 'root', nodes };
    const trash = this.meta('trash'); if (trash) doc.trash = JSON.parse(trash);
    const dm = this.meta('docmeta'); if (dm) doc.meta = JSON.parse(dm);
    return { version: this.version, doc };
  }

  // persist a new doc: diff against the shadow, write only changed/removed rows
  sync(doc, version) {
    const next = Store.flat(doc);
    Store.assertForest(next);
    const nextKey = new Map([...next].map(([id, r]) => [id, `${r.parent_id}|${r.ord}|${r.data}`]));
    this.tx(() => {
      this.db.exec('PRAGMA defer_foreign_keys = ON');
      for (const [id, r] of next) {
        if (this.shadow.get(id) !== nextKey.get(id)) this._upsert.run(id, r.parent_id, r.ord, r.data);
      }
      for (const id of this.shadow.keys()) if (!next.has(id)) this._del.run(id);
      this.meta('version', String(version));
      this.meta('trash', JSON.stringify(doc.trash || []));
      this.meta('docmeta', JSON.stringify(doc.meta || {}));
    });
    this.shadow = nextKey;
  }

  // Fast incremental persistence for an already-applied op batch (Route B hot path): write
  // only the rows the ops touched — O(change), not O(doc). The dirty set is derived from the
  // very ops the server just replayed into `doc`, so it cannot drift from the mutation.
  //
  // ord numbers may be left sparse by deletes / moves-out, which is harmless: loadDoc orders
  // a parent's children by ord and a gap still sorts correctly. Any parent that gains or
  // reorders a child is renumbered in full, so duplicate ords never arise. The shadow diff
  // means a touched-but-unchanged row is still skipped, so writes match what sync() would do;
  // only the O(doc) re-flatten is avoided. sync() (run before every hourly backup) re-derives
  // canonical rows and would heal any drift regardless — incremental is never the last word.
  applyOps(doc, version, ops) {
    // A cold DB has no persisted forest for the incremental write to build on (root itself is
    // never a child, so it would never be written). Establish the whole forest once, then every
    // later batch goes incremental.
    if (this.shadow.size === 0) { this.sync(doc, version); return; }

    const reparent = new Set();   // parents whose child list grew or reordered → renumber fully
    const dataOnly = new Set();   // nodes whose data changed but whose position did not
    const removed = new Set();    // rows to delete (whole deleted subtrees)
    let trashTouched = false;
    for (const op of ops) {
      switch (op && op.kind) {
        case 'insert': reparent.add(doc.nodes[op.parent] ? op.parent : 'root'); dataOnly.add(op.node); break;
        case 'update': dataOnly.add(op.node); break;
        case 'move':   reparent.add(doc.nodes[op.parent] ? op.parent : 'root'); break;
        case 'delete': {
          trashTouched = true;
          // the delete just created a trash entry keyed by (root, ts); its node map is the
          // exact set of rows to remove (the whole subtree)
          const e = (doc.trash || []).find(t => t.root === op.node && t.ts === op.ts);
          if (e && e.nodes) for (const id of Object.keys(e.nodes)) removed.add(id);
          else removed.add(op.node);
          break;
        }
        case 'untrash': trashTouched = true; break;   // structurally a no-op; only the trash blob changed
        default: break;
      }
    }

    const rows = [];              // [id, parent_id, ord, data] to upsert
    const seen = new Set();
    for (const pid of reparent) {
      const p = doc.nodes[pid];
      if (!p) continue;           // parent itself was deleted in this batch → its rows are in `removed`
      const kids = p.children || [];
      for (let i = 0; i < kids.length; i++) {
        const id = kids[i], c = doc.nodes[id];
        if (!c || removed.has(id)) continue;
        const { children, ...rest } = c;
        rows.push([id, pid, i, JSON.stringify(rest)]);
        seen.add(id);
      }
    }
    for (const id of dataOnly) {
      if (seen.has(id) || removed.has(id)) continue;   // already rewritten by a reparent pass, or gone
      const c = doc.nodes[id];
      if (!c) continue;
      const { children, ...rest } = c;
      const prev = this.shadow.get(id);                // a data-only edit keeps the row's position
      let pid = null, ord = 0;
      if (prev) { const a = prev.indexOf('|'), b = prev.indexOf('|', a + 1); pid = prev.slice(0, a); ord = +prev.slice(a + 1, b); if (pid === 'null') pid = null; }
      rows.push([id, pid, ord, JSON.stringify(rest)]);
    }

    const wrote = [];   // shadow updates applied only AFTER a successful COMMIT, so a rolled-back
    const erased = [];  // tx can never leave the shadow claiming rows the DB doesn't actually hold
    this.tx(() => {
      this.db.exec('PRAGMA defer_foreign_keys = ON');  // parents/children in one batch checked at COMMIT
      for (const [id, pid, ord, data] of rows) {
        const key = `${pid}|${ord}|${data}`;
        if (this.shadow.get(id) !== key) { this._upsert.run(id, pid, ord, data); wrote.push([id, key]); }
      }
      for (const id of removed) { if (this.shadow.has(id)) { this._del.run(id); erased.push(id); } }
      this.meta('version', String(version));
      if (trashTouched) this.meta('trash', JSON.stringify(doc.trash || []));
    });
    for (const [id, key] of wrote) this.shadow.set(id, key);
    for (const id of erased) this.shadow.delete(id);
  }

  // FTS5 search → ordered node ids (server-side; Phase 3 wires the client to it)
  search(query, limit = 200) {
    const q = String(query || '').trim();
    if (!q) return [];
    try {
      const rows = this.db.prepare(
        'SELECT n.id AS id FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE nodes_fts MATCH ? LIMIT ?',
      ).all(ftsQuery(q), limit);
      return rows.map(r => r.id);
    } catch { return []; } // malformed MATCH expression → no results, never throw
  }

  // structural integrity check — used by tests and an optional periodic guard
  fsck() {
    const problems = [];
    const rows = this.db.prepare('SELECT id, parent_id FROM nodes').all();
    const ids = new Set(rows.map(r => r.id));
    for (const r of rows) {
      if (r.parent_id != null && !ids.has(r.parent_id)) problems.push(`dangling parent: ${r.id} → ${r.parent_id}`);
    }
    // reachability + cycle: walk down from root
    const seen = new Set();
    const stack = ['root'];
    const kids = this.db.prepare('SELECT id FROM nodes WHERE parent_id=?');
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) { problems.push(`cycle at ${id}`); continue; }
      seen.add(id);
      for (const c of kids.all(id)) stack.push(c.id);
    }
    for (const id of ids) if (!seen.has(id) && id !== 'root') problems.push(`unreachable: ${id}`);
    const ftsN = this.db.prepare('SELECT count(*) AS n FROM nodes_fts').get().n;
    if (ftsN !== rows.length) problems.push(`fts drift: ${ftsN} indexed vs ${rows.length} nodes`);
    return problems;
  }

  backup(file) { this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); }
  close() { this.db.close(); }
}

// turn a user query into a safe FTS5 MATCH string (prefix match on each bare term)
function ftsQuery(q) {
  const terms = q.match(/"[^"]+"|\S+/g) || [];
  return terms.map(t => (t.startsWith('"') ? t : `"${t.replace(/"/g, '')}"*`)).join(' ');
}

module.exports = { Store };
