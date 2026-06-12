'use strict';
/* Phase-1 store tests: migration round-trip, incremental sync, FTS search, fsck.
   Pure Node (no browser).   node tests/test-db.js */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Store } = require('../db');
const { makeDoc } = require('../bench/gen');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok  ' : 'FAIL  ') + msg); if (!cond) failures++; };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tendril-db-')), 'outline.db');

// 1. migration round-trip: import a doc, read it back, must be deep-equal
{
  const file = tmp();
  const { doc } = makeDoc(2000);
  const s = new Store(file);
  s.importDoc(doc, 7);
  const loaded = s.loadDoc();
  ok(loaded.version === 7, `version round-trips (${loaded.version})`);
  try { assert.deepStrictEqual(loaded.doc.nodes, doc.nodes); ok(true, 'nodes + child order round-trip deep-equal (2000 nodes)'); }
  catch (e) { ok(false, 'round-trip deep-equal: ' + e.message.split('\n')[0]); }
  ok(s.fsck().length === 0, 'fsck clean after import');
  s.close();
}

// 2. incremental sync: a small change writes only that, and reads back correctly
{
  const file = tmp();
  const { doc } = makeDoc(500);
  const s = new Store(file);
  s.importDoc(doc, 1);
  doc.nodes.n1.text = 'edited via sync';
  const fresh = 'zz' + Date.now().toString(36);
  doc.nodes[fresh] = { id: fresh, text: 'brand new node', note: null, done: false, collapsed: false, children: [], c: 1, m: 1 };
  doc.nodes.root.children.push(fresh);
  // delete a leaf (no children) and detach it — a valid whole-subtree removal
  const leaf = Object.keys(doc.nodes).find(k => k !== 'root' && (doc.nodes[k].children || []).length === 0);
  const par = Object.keys(doc.nodes).find(k => (doc.nodes[k].children || []).includes(leaf));
  doc.nodes[par].children = doc.nodes[par].children.filter(c => c !== leaf);
  delete doc.nodes[leaf];
  s.sync(doc, 2);
  const s2 = new Store(file); // reopen to prove it persisted, not just cached
  const loaded = s2.loadDoc();
  ok(loaded.version === 2, 'sync bumped persisted version');
  ok(loaded.doc.nodes.n1.text === 'edited via sync', 'edited field persisted');
  ok(!!loaded.doc.nodes[fresh] && loaded.doc.nodes.root.children.includes(fresh), 'inserted node persisted + linked');
  ok(!loaded.doc.nodes[leaf], 'deleted leaf gone');
  ok(s2.fsck().length === 0, 'fsck clean after incremental sync');
  s.close(); s2.close();
}

// 3. FTS5 search finds content and respects prefix
{
  const file = tmp();
  const { doc } = makeDoc(50);
  doc.nodes.find1 = { id: 'find1', text: 'xylophone serendipity', note: null, children: [] };
  doc.nodes.root.children.push('find1');
  const s = new Store(file);
  s.importDoc(doc, 1);
  ok(s.search('xylophone').includes('find1'), 'FTS finds a whole word');
  ok(s.search('seren').includes('find1'), 'FTS prefix match works');
  ok(s.search('nonexistentzzz').length === 0, 'FTS no false matches');
  ok(s.search('"a b c" OR (((').length >= 0, 'malformed MATCH never throws');
  s.close();
}

// 4. fsck catches a structural break
{
  const file = tmp();
  const { doc } = makeDoc(100);
  const s = new Store(file);
  s.importDoc(doc, 1);
  // forge a dangling parent by writing a row directly
  s.db.exec("PRAGMA foreign_keys=OFF");
  s.db.prepare("INSERT INTO nodes(id,parent_id,ord,data) VALUES('orphan','ghost',0,'{\"id\":\"orphan\",\"text\":\"x\"}')").run();
  const problems = s.fsck();
  ok(problems.some(p => p.includes('dangling parent')), `fsck reports the dangling parent (${problems.length} problem(s))`);
  s.close();
}

// 5. applyOps incremental persistence (Route B hot path): apply an insert/update/move/delete
//    batch, persist only the touched rows, and prove a fresh reopen is identical to memory
{
  const { applyOpsToDoc } = require('../opsdoc');
  const file = tmp();
  const { doc } = makeDoc(800);
  const s = new Store(file);
  s.importDoc(doc, 1);
  // a server-style trashFn that records a (root, ts, nodes) entry like pushTrash, then detaches
  const trashFn = (d, id, parent, ts) => {
    const ids = []; const stack = [id];
    while (stack.length) { const x = stack.pop(); const n = d.nodes[x]; if (!n) continue; ids.push(x); stack.push(...(n.children || [])); }
    const nodes = {}; for (const x of ids) nodes[x] = d.nodes[x];
    (d.trash || (d.trash = [])).unshift({ ts, parent, root: id, nodes });
    if (parent && d.nodes[parent]) { const a = d.nodes[parent].children; const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); }
    for (const x of ids) delete d.nodes[x];
  };
  const someParent = doc.nodes.root.children[0];
  const moveTarget = doc.nodes.root.children[1];
  const victim = Object.keys(doc.nodes).find(k => k !== 'root' && k !== someParent && k !== moveTarget && (doc.nodes[k].children || []).length === 0);
  ok(!!someParent && !!moveTarget && someParent !== moveTarget && !!victim, 'fixture has two top-level parents and a deletable leaf');
  const ops = [
    { id: 'o1', kind: 'insert', node: 'new1', parent: someParent, ord: 0, hlc: 'h1', data: { id: 'new1', text: 'inserted alpha', note: null, done: false, collapsed: false } },
    { id: 'o2', kind: 'update', node: moveTarget, patch: { text: 'updated beta' }, hlc: 'h2' },
    { id: 'o3', kind: 'move', node: 'new1', parent: moveTarget, ord: 0, hlc: 'h3' },
    { id: 'o4', kind: 'delete', node: victim, ts: 1717171717, hlc: 'h4' },
  ];
  const applied = applyOpsToDoc(doc, ops, trashFn);
  ok(applied.length === 4, `all four ops applied (${applied.length})`);
  s.applyOps(doc, 2, applied);
  const s2 = new Store(file); // reopen to prove it persisted, not just cached in the shadow
  const loaded = s2.loadDoc();
  ok(loaded.version === 2, 'applyOps bumped the persisted version');
  try { assert.deepStrictEqual(loaded.doc.nodes, doc.nodes); ok(true, 'incremental rows reopen deep-equal to the in-memory doc (800 nodes)'); }
  catch (e) { ok(false, 'applyOps round-trip deep-equal: ' + e.message.split('\n')[0]); }
  ok(loaded.doc.nodes.new1 && loaded.doc.nodes[moveTarget].children.includes('new1'), 'inserted-then-moved node landed under its new parent');
  ok(loaded.doc.nodes[moveTarget].text === 'updated beta', 'field update persisted');
  ok(!loaded.doc.nodes[victim], 'deleted leaf gone');
  ok(s2.fsck().length === 0, 'fsck clean after applyOps (no dangling/cycle/FTS drift)');
  ok(s2.search('alpha').includes('new1'), 'FTS index updated by applyOps (inserted node searchable)');
  ok(s2.search('beta').includes(moveTarget), 'FTS index updated by applyOps (updated text searchable)');
  s.close(); s2.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nDB TESTS PASSED');
process.exit(failures ? 1 : 0);
