'use strict';
/*
 * Concurrency / robustness harness. Dependency-free; server in-process.
 *   1. head-of-line blocking: light GETs stall behind big synchronous saves
 *   2. version-conflict storm: N parallel PUTs at the same baseVersion
 *   3. capture-vs-save race: concurrent capture appends must not be lost
 *   4. adversarial payloads: malformed / deep / cyclic docs must not 500 or hang
 *
 *   node bench/load.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { makeDoc } = require('./gen');

const PORT = 38221;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tendril-load-'));
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = DATA;
process.env.TENDRIL_CAPTURE_TOKEN = 'cap';
const realLog = console.log;
console.log = () => {};
require('../server.js');
console.log = realLog;

function req(method, p, body, raw) {
  return new Promise((resolve) => {
    const data = body !== undefined ? (raw ? Buffer.from(body) : Buffer.from(JSON.stringify(body))) : null;
    const t = process.hrtime.bigint();
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
      res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString(), ms: Number(process.hrtime.bigint() - t) / 1e6 })); });
    r.on('error', e => resolve({ status: 0, body: String(e), ms: Number(process.hrtime.bigint() - t) / 1e6 }));
    if (data) r.write(data);
    r.end();
  });
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(250);
  const N = 100000;
  const store = makeDoc(N);
  let version = JSON.parse((await req('PUT', '/api/doc', { baseVersion: 0, doc: store.doc })).body).version;

  // 1. head-of-line blocking ------------------------------------------------
  let saving = true;
  (async () => { while (saving) { const r = await req('PUT', '/api/doc', { baseVersion: version, doc: store.doc }); if (r.status === 200) version = JSON.parse(r.body).version; } })();
  const lat = [];
  const end = Date.now() + 3000;
  while (Date.now() < end) { lat.push((await req('GET', '/api/version')).ms); await sleep(20); }
  saving = false;
  await sleep(500);
  realLog('\n1. Head-of-line blocking — GET /api/version while big PUTs run:');
  realLog(`   p50 ${pct(lat, 0.5).toFixed(1)}ms   p90 ${pct(lat, 0.9).toFixed(1)}ms   p99 ${pct(lat, 0.99).toFixed(1)}ms   max ${Math.max(...lat).toFixed(1)}ms   (n=${lat.length})`);
  realLog('   → a 1-byte read stalls behind the synchronous whole-doc save.');

  // 2. version-conflict storm ----------------------------------------------
  version = JSON.parse((await req('GET', '/api/version')).body).version;
  const small = makeDoc(50);
  const results = await Promise.all(Array.from({ length: 50 }, () => req('PUT', '/api/doc', { baseVersion: version, doc: small.doc })));
  const ok = results.filter(r => r.status === 200).length;
  const conflict = results.filter(r => r.status === 409).length;
  realLog('\n2. Version-conflict storm — 50 parallel PUTs at the same baseVersion:');
  realLog(`   ${ok} committed, ${conflict} got 409, ${results.length - ok - conflict} other. Expect exactly 1 commit (no lost-update).`);

  // 3. capture-vs-save race -------------------------------------------------
  version = JSON.parse((await req('GET', '/api/version')).body).version;
  const before = JSON.parse((await req('GET', '/api/doc')).body).doc;
  const inboxBefore = Object.values(before.nodes).filter(n => /captured-\d+/.test(n.text || '')).length;
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => req('POST', '/api/capture?token=cap', `captured-${i}`, true)),
    req('PUT', '/api/doc', { baseVersion: version, doc: store.doc }),
  ]);
  await sleep(300);
  const after = JSON.parse((await req('GET', '/api/doc')).body).doc;
  const inboxAfter = Object.values(after.nodes).filter(n => /captured-\d+/.test(n.text || '')).length;
  realLog('\n3. Capture-vs-save race — 20 captures concurrent with a full-doc PUT:');
  realLog(`   captured items present afterwards: ${inboxAfter - inboxBefore}/20  (lost = ${20 - (inboxAfter - inboxBefore)})`);

  // 4. adversarial payloads (built with the LIVE version so the doc is actually processed)
  realLog('\n4. Adversarial payloads (server must not 500 / hang; then GET must still work):');
  const cycle = { root: { id: 'root', children: ['a'] }, a: { id: 'a', text: 'x', children: ['a'] } };
  const big = { root: { id: 'root', children: ['big'] }, big: { id: 'big', text: 'x'.repeat(10 * 1024 * 1024), children: [] } };
  const deep = (() => { const nodes = { root: { id: 'root', children: ['d0'] } }; for (let i = 0; i < 50000; i++) nodes['d' + i] = { id: 'd' + i, text: 't', children: i < 49999 ? ['d' + (i + 1)] : [] }; return nodes; })();
  const probes = [
    ['empty body', null],
    ['no nodes', { root: 'root' }],
    ['child → missing id', { root: 'root', nodes: { root: { id: 'root', children: ['ghost'] } } }],
    ['self-cycle node', { root: 'root', nodes: cycle }],
    ['10MB single node', { root: 'root', nodes: big }],
    ['50k-deep chain', { root: 'root', nodes: deep }],
  ];
  for (const [label, doc] of probes) {
    const v = JSON.parse((await req('GET', '/api/version')).body).version;
    const t = Date.now();
    let r; try { r = doc === null ? await req('PUT', '/api/doc', {}) : await req('PUT', '/api/doc', { baseVersion: v, doc }); } catch (e) { r = { status: -1, body: String(e) }; }
    const get = await req('GET', '/api/version'); // server still responsive?
    const okStatus = r.status >= 200 && r.status < 500 && get.status === 200;
    realLog(`   ${okStatus ? 'ok ' : 'BAD'}  ${label.padEnd(20)} → PUT ${r.status} in ${Date.now() - t}ms, GET ${get.status}`);
  }

  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); fs.rmSync(DATA, { recursive: true, force: true }); process.exit(1); });
