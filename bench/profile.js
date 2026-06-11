'use strict';
/*
 * CPU profile of the save path at scale, to break down where PUT time goes
 * (JSON.parse vs sanitize vs JSON.stringify). Uses the built-in inspector —
 * no dependencies. Server runs in-process; we profile while driving heavy PUTs.
 *
 *   node bench/profile.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const inspector = require('inspector');
const { makeDoc } = require('./gen');

const PORT = 38219;
const N = 100000;
const PUTS = 40;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tendril-prof-'));
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = DATA;
const realLog = console.log;
console.log = () => {};
require('../server.js');
console.log = realLog;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
      res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function topSelfTime(profile) {
  const { nodes, samples, timeDeltas } = profile;
  const self = new Map();         // nodeId → microseconds
  for (let i = 0; i < samples.length; i++) {
    self.set(samples[i], (self.get(samples[i]) || 0) + (timeDeltas[i] || 0));
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const rows = [...self.entries()].map(([id, us]) => {
    const n = byId.get(id);
    const cf = n ? n.callFrame : { functionName: '?', url: '' };
    const name = cf.functionName || '(anonymous)';
    const where = (cf.url || '').replace(/.*[\\/]/, '') + (cf.lineNumber >= 0 ? ':' + (cf.lineNumber + 1) : '');
    return { label: `${name} ${where}`.trim(), us };
  });
  const agg = new Map();
  for (const r of rows) agg.set(r.label, (agg.get(r.label) || 0) + r.us);
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
}

(async () => {
  await new Promise(r => setTimeout(r, 250));
  const store = makeDoc(N);
  let version = 0;
  // prime
  let put = await req('PUT', '/api/doc', { baseVersion: version, doc: store.doc });
  version = JSON.parse(put.body).version;

  const session = new inspector.Session();
  session.connect();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => e ? rej(e) : res(r)));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 100 }); // 100µs
  await post('Profiler.start');

  const t0 = Date.now();
  for (let i = 0; i < PUTS; i++) {
    put = await req('PUT', '/api/doc', { baseVersion: version, doc: store.doc });
    version = JSON.parse(put.body).version;
  }
  const elapsed = Date.now() - t0;

  const { profile } = await post('Profiler.stop');
  realLog(`\n  Profiled ${PUTS} PUTs of a ${N}-node doc in ${elapsed}ms (${(elapsed / PUTS).toFixed(0)}ms/PUT)\n`);
  realLog('  self-time  frame');
  realLog('  ' + '-'.repeat(60));
  for (const [label, us] of topSelfTime(profile)) {
    realLog('  ' + (us / 1000).toFixed(0).padStart(6) + 'ms   ' + label);
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); fs.rmSync(DATA, { recursive: true, force: true }); process.exit(1); });
