'use strict';
/* Phase-2 server op path: opsdoc semantics (LWW, cycle-skip, idempotency) + a real
   round-trip through POST /api/ops → GET /api/doc → persistence. Pure Node.
   node tests/test-ops-server.js */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { applyOpsToDoc, parentMap } = require('../opsdoc');
const { Replica } = require('../ops');

let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const freshDoc = () => ({ root: 'root', nodes: { root: { id: 'root', text: '', children: [], $hlc: { struct: '0', text: '0', flags: '0', meta: '0' } } } });
let H = 0; const hlc = () => String(++H).padStart(8, '0') + ':d'; // monotonic stamps

// 1. structural equivalence with the proven engine (parents + fields + live set)
{
  H = 0;
  const ops = [];
  const ids = ['root'];
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const pick = () => ids[(rng() * ids.length) | 0];
  for (let k = 0; k < 1500; k++) {
    const r = rng();
    if (r < 0.4 || ids.length < 4) { const id = 'n' + k; ops.push({ id: 'o' + k, hlc: hlc(), kind: 'insert', node: id, parent: pick(), ord: (rng() * 4) | 0, data: { text: 't' + id } }); ids.push(id); }
    else if (r < 0.65) ops.push({ id: 'o' + k, hlc: hlc(), kind: 'update', node: pick(), patch: { text: 'u' + k } });
    else ops.push({ id: 'o' + k, hlc: hlc(), kind: 'move', node: pick(), parent: pick(), ord: (rng() * 4) | 0 });
    // delete differs by design (doc cascades a subtree; engine tombstones one node) — tested separately below
  }
  const doc = freshDoc();
  const trashed = new Set();
  applyOpsToDoc(doc, ops, (d, id) => { for (const x of subtreeIds(d, id)) { trashed.add(x); delete d.nodes[x]; } detach(d, id); });
  const rep = new Replica();
  rep.apply({ id: 'root', hlc: '00000000:d', kind: 'insert', node: 'root', parent: null, ord: 0, data: { text: '' } });
  rep.applyAll(ops);

  const pm = parentMap(doc);
  let mismatch = null;
  for (const [id, n] of rep.nodes.entries()) {
    if (id === 'root') continue;
    const liveInDoc = !!doc.nodes[id];
    const liveInRep = !n.deleted;
    if (liveInDoc !== liveInRep) { mismatch = `live mismatch ${id}: doc=${liveInDoc} rep=${liveInRep}`; break; }
    if (liveInDoc) {
      if ((pm[id] || null) !== n.parent) { mismatch = `parent mismatch ${id}: doc=${pm[id]} rep=${n.parent}`; break; }
      if (doc.nodes[id].text !== n.data.text) { mismatch = `text mismatch ${id}`; break; }
    }
  }
  ok(!mismatch, mismatch || 'opsdoc parent/field/live structure matches the proven engine (insert/update/move, 1500 ops)');
}

// 1b. delete cascades to the whole subtree (the doc model's deleteSubtree semantics)
{
  const doc = freshDoc();
  const trash = (d, id) => { for (const x of subtreeIds(d, id)) delete d.nodes[x]; detach(d, id); };
  applyOpsToDoc(doc, [
    { id: 'i1', hlc: '00000010:d', kind: 'insert', node: 'a', parent: 'root', ord: 0, data: {} },
    { id: 'i2', hlc: '00000011:d', kind: 'insert', node: 'b', parent: 'a', ord: 0, data: {} },
    { id: 'i3', hlc: '00000012:d', kind: 'insert', node: 'c', parent: 'b', ord: 0, data: {} },
  ], trash);
  applyOpsToDoc(doc, [{ id: 'del', hlc: '00000020:d', kind: 'delete', node: 'a' }], trash);
  ok(!doc.nodes.a && !doc.nodes.b && !doc.nodes.c && !doc.nodes.root.children.includes('a'),
    'delete removes the whole subtree from the live tree');
}

// 2. field LWW — an older-hlc update is shadowed, newer wins regardless of arrival
{
  const doc = freshDoc();
  applyOpsToDoc(doc, [{ id: 'i', hlc: '00000010:d', kind: 'insert', node: 'a', parent: 'root', ord: 0, data: { text: 'orig' } }]);
  applyOpsToDoc(doc, [{ id: 'u2', hlc: '00000030:d', kind: 'update', node: 'a', patch: { text: 'newer' } }]);
  applyOpsToDoc(doc, [{ id: 'u1', hlc: '00000020:d', kind: 'update', node: 'a', patch: { text: 'older' } }]); // arrives later, lower hlc
  ok(doc.nodes.a.text === 'newer', `LWW: newer write survives a later-arriving older write (${doc.nodes.a.text})`);
}

// 3. move cycle-skip — moving an ancestor under its own descendant is refused
{
  const doc = freshDoc();
  applyOpsToDoc(doc, [
    { id: 'i1', hlc: '00000010:d', kind: 'insert', node: 'a', parent: 'root', ord: 0, data: {} },
    { id: 'i2', hlc: '00000011:d', kind: 'insert', node: 'b', parent: 'a', ord: 0, data: {} },
  ]);
  applyOpsToDoc(doc, [{ id: 'm', hlc: '00000020:d', kind: 'move', node: 'a', parent: 'b', ord: 0 }]); // a under b (its child) → cycle
  const pm = parentMap(doc);
  ok(pm.a === 'root' && pm.b === 'a', `cycle-forming move skipped (a→${pm.a}, b→${pm.b})`);
}

// 4. idempotency — replaying ops changes nothing
{
  const doc = freshDoc();
  const ops = [{ id: 'i', hlc: '00000010:d', kind: 'insert', node: 'a', parent: 'root', ord: 0, data: { text: 'x' } }];
  applyOpsToDoc(doc, ops);
  const before = JSON.stringify(doc);
  applyOpsToDoc(doc, ops); applyOpsToDoc(doc, ops);
  ok(JSON.stringify(doc) === before, 'insert is idempotent on replay');
}

// helpers mirroring the server's trash semantics
function subtreeIds(doc, id) { const out = []; const st = [id]; const seen = new Set(); while (st.length) { const x = st.pop(); if (!doc.nodes[x] || seen.has(x)) continue; seen.add(x); out.push(x); st.push(...(doc.nodes[x].children || [])); } return out; }
function detach(doc, id) { for (const k in doc.nodes) { const a = doc.nodes[k].children || []; const i = a.indexOf(id); if (i >= 0) { a.splice(i, 1); return; } } }

// 5. real server round-trip: POST /api/ops, GET /api/doc reflects + persists
(async () => {
  const PORT = 38241;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tendril-ops-'));
  process.env.PORT = String(PORT); process.env.HOST = '127.0.0.1'; process.env.DATA_DIR = DATA;
  const log = console.log; console.log = () => {}; require('../server.js'); console.log = log;
  const req = (m, p, b) => new Promise(res => { const d = b ? Buffer.from(JSON.stringify(b)) : null; const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m, headers: d ? { 'content-type': 'application/json', 'content-length': d.length } : {} }, x => { const c = []; x.on('data', q => c.push(q)); x.on('end', () => res({ s: x.statusCode, b: Buffer.concat(c).toString() })); }); if (d) r.write(d); r.end(); });
  await new Promise(r => setTimeout(r, 300));

  const ops = [
    { id: 'a1', hlc: '00000100:dz', kind: 'insert', node: 'x', parent: 'root', ord: 0, data: { text: 'hello <b>ops</b>' } },
    { id: 'a2', hlc: '00000101:dz', kind: 'insert', node: 'y', parent: 'x', ord: 0, data: { text: 'child' } },
    { id: 'a3', hlc: '00000102:dz', kind: 'update', node: 'x', patch: { text: 'edited <script>bad</script>' } },
  ];
  let r = await req('POST', '/api/ops', { ops });
  ok(r.s === 200 && JSON.parse(r.b).applied === 3, `POST /api/ops applied 3 (${r.b})`);
  let doc = JSON.parse((await req('GET', '/api/doc')).b).doc;
  ok(doc.nodes.x && doc.nodes.root.children.includes('x') && doc.nodes.x.children.includes('y'), 'tree built via ops');
  ok(/edited/.test(doc.nodes.x.text) && !/<script/i.test(doc.nodes.x.text), `server stripped the <script> tag from op text (${doc.nodes.x.text})`);
  r = await req('POST', '/api/ops', { ops }); // replay
  ok(JSON.parse(r.b).applied === 0, 'replaying the same ops is a no-op (idempotent at the endpoint)');

  // reopen the DB to prove persistence
  const { Store } = require('../db');
  await new Promise(r2 => setTimeout(r2, 200));
  const s2 = new Store(path.join(DATA, 'outline.db'));
  const reloaded = s2.loadDoc().doc;
  ok(reloaded.nodes.x && reloaded.nodes.x.children.includes('y'), 'op changes persisted to SQLite');
  s2.close();

  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* server still holds the WAL on Windows; harmless */ }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOPS-SERVER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
