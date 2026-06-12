'use strict';
/* Server-side mirror semantics: the v1 REST API routes content ops to the target and
   promotes on delete (client parity), and an edit-share merge round-trip preserves the
   mirror field. Pure Node — boots its own server on a private port.
   node tests/test-mirror-server.js */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const PORT = 38247;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tendril-msrv-'));
  process.env.PORT = String(PORT); process.env.HOST = '127.0.0.1'; process.env.DATA_DIR = DATA;
  const log = console.log; console.log = () => {}; require('../server.js'); console.log = log;
  const req = (m, p, b) => new Promise(res => {
    const d = b ? Buffer.from(JSON.stringify(b)) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m, headers: d ? { 'content-type': 'application/json', 'content-length': d.length } : {} },
      x => { const c = []; x.on('data', q => c.push(q)); x.on('end', () => res({ s: x.statusCode, j: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return null; } })() })); });
    if (d) r.write(d); r.end();
  });
  await new Promise(r => setTimeout(r, 300));

  // seed: root → [holder → [orig → [kid], m(mirror→orig)]]
  const doc = {
    root: 'root',
    nodes: {
      root: { id: 'root', text: '', note: null, done: false, collapsed: false, children: ['holder'] },
      holder: { id: 'holder', text: 'Holder', note: null, done: false, collapsed: false, children: ['orig', 'm'] },
      orig: { id: 'orig', text: 'Alpha', note: 'a note', done: false, collapsed: false, children: ['kid'] },
      kid: { id: 'kid', text: 'kid one', note: null, done: false, collapsed: false, children: [] },
      m: { id: 'm', text: '', note: null, done: false, collapsed: true, children: [], mirror: 'orig' },
    },
  };
  let r = await req('PUT', '/api/doc', { doc, baseVersion: 0 });
  ok(r.s === 200, `seed doc accepted (v${r.j?.version})`);

  /* ---- v1 API is mirror-aware (fix 9) ---- */
  r = await req('GET', '/api/v1/nodes/m');
  ok(r.j?.mirror === 'orig' && r.j?.text === 'Alpha' && r.j?.plain === 'Alpha',
    `GET on a mirror presents the target's content (mirror=${r.j?.mirror}, text=${r.j?.text})`);
  ok(Array.isArray(r.j?.children) && r.j.children.includes('kid'), "…and the target's children");

  r = await req('PATCH', '/api/v1/nodes/m', { text: 'Beta', done: true });
  ok(r.s === 200, 'PATCH on a mirror accepted');
  r = await req('GET', '/api/v1/nodes/orig');
  ok(r.j?.text === 'Beta' && r.j?.done === true, `PATCH routed to the target (text=${r.j?.text}, done=${r.j?.done})`);

  r = await req('POST', '/api/v1/nodes/m/complete', { done: false });
  r = await req('GET', '/api/v1/nodes/orig');
  ok(r.j?.done === false, 'complete on a mirror routes to the target');

  // collapsed stays per-instance
  await req('PATCH', '/api/v1/nodes/m', { collapsed: false });
  r = await req('GET', '/api/v1/nodes/m');
  const rOrig = await req('GET', '/api/v1/nodes/orig');
  ok(r.j?.collapsed === false && rOrig.j?.collapsed === false, 'collapsed is written per-instance');

  // DELETE the original → the mirror is promoted (content + subtree live on)
  r = await req('DELETE', '/api/v1/nodes/orig');
  ok(r.s === 200, 'DELETE original accepted');
  r = await req('GET', '/api/v1/nodes/m');
  ok(r.j && r.j.mirror === null && r.j.text === 'Beta' && r.j.children.includes('kid'),
    `deleting the original promotes the mirror (text=${r.j?.text}, kids=${r.j?.children?.length})`);
  r = await req('GET', '/api/v1/nodes/orig');
  ok(r.s === 404, 'the original row itself is gone');

  /* ---- edit-share merge preserves mirrors (fix 4) ---- */
  // rebuild: holder2 → [o2, m2(mirror→o2)], share holder2, PUT the share doc back verbatim
  const v = (await req('GET', '/api/version')).j.version;
  const doc2 = (await req('GET', '/api/doc')).j.doc;
  doc2.nodes.holder2 = { id: 'holder2', text: 'Shared', note: null, done: false, collapsed: false, children: ['o2', 'm2'] };
  doc2.nodes.o2 = { id: 'o2', text: 'Inside', note: null, done: false, collapsed: false, children: [] };
  doc2.nodes.m2 = { id: 'm2', text: '', note: null, done: false, collapsed: true, children: [], mirror: 'o2' };
  doc2.nodes.root.children.push('holder2');
  r = await req('PUT', '/api/doc', { doc: doc2, baseVersion: v });
  ok(r.s === 200, 'doc with shared mirror accepted');

  r = await req('POST', '/api/shares', { nodeId: 'holder2', mode: 'edit' });
  const token = r.j?.token;
  ok(!!token, `edit share created (${String(token).slice(0, 8)}…)`);

  const shareDoc = (await req('GET', `/api/share/${token}/doc`)).j;
  ok(!!shareDoc?.doc?.nodes?.m2, 'share doc contains the mirror node');
  r = await req('PUT', `/api/share/${token}/doc`, { doc: shareDoc.doc, baseVersion: shareDoc.version });
  ok(r.s === 200, 'guest round-trip PUT accepted');

  const after = (await req('GET', '/api/doc')).j.doc;
  ok(after.nodes.m2 && after.nodes.m2.mirror === 'o2',
    `mirror survived the guest edit round-trip (mirror=${after.nodes.m2?.mirror})`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nMIRROR-SERVER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
