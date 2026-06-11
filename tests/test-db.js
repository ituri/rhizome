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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nDB TESTS PASSED');
process.exit(failures ? 1 : 0);
