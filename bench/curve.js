'use strict';
/*
 * Size/latency curve: how the whole-doc operations scale with node count.
 * Runs the real server in-process (temp data dir) so process.memoryUsage()
 * reflects the server's in-memory doc. Dependency-free.
 *
 *   node --expose-gc bench/curve.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { makeDoc } = require('./gen');

const PORT = 38217;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tendril-bench-'));
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = DATA;

const realLog = console.log;
console.log = () => {};          // silence the server's "listening" banner
require('../server.js');         // starts the server in THIS process
console.log = realLog;

const ms = (a, b) => Number(b - a) / 1e6;
const MB = b => (b / 1048576).toFixed(1);
const gc = () => { if (global.gc) global.gc(); };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
      res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  await new Promise(r => setTimeout(r, 250));
  const Ns = [1000, 10000, 50000, 100000, 250000];
  const rows = [];
  let version = 0;

  for (const N of Ns) {
    gc();
    let t = process.hrtime.bigint();
    const store = makeDoc(N);
    const genMs = ms(t, process.hrtime.bigint());
    const bytes = Buffer.byteLength(JSON.stringify(store.doc));

    // standalone primitive costs (these back undo + save + sanitize)
    t = process.hrtime.bigint();
    const json = JSON.stringify(store.doc);
    const stringifyMs = ms(t, process.hrtime.bigint());
    t = process.hrtime.bigint();
    JSON.parse(json);
    const parseMs = ms(t, process.hrtime.bigint());
    t = process.hrtime.bigint();
    structuredClone(store.doc);     // this is exactly what snapshot() does per edit
    const cloneMs = ms(t, process.hrtime.bigint());

    // end-to-end through the real HTTP handlers (parse + sanitize + stringify, all sync)
    t = process.hrtime.bigint();
    const put = await req('PUT', '/api/doc', { baseVersion: version, doc: store.doc });
    const putMs = ms(t, process.hrtime.bigint());
    if (put.status === 200) version = JSON.parse(put.body).version;
    else { realLog(`PUT failed at N=${N}: ${put.status} ${put.body}`); break; }

    t = process.hrtime.bigint();
    await req('GET', '/api/doc');
    const getMs = ms(t, process.hrtime.bigint());

    // server memory: drop the harness's own references first
    const u = (() => { gc(); return process.memoryUsage(); })();

    rows.push({ N, bytes, genMs, stringifyMs, parseMs, cloneMs, putMs, getMs, rss: u.rss, heap: u.heapUsed });
    realLog(`  done N=${N}`);
  }

  realLog('\n  N        size     gen    stringify  parse   clone   PUT(e2e)  GET     rss     heap');
  realLog('  ' + '-'.repeat(92));
  for (const r of rows) {
    realLog(
      '  ' +
      String(r.N).padEnd(8) +
      (MB(r.bytes) + 'MB').padEnd(9) +
      (r.genMs.toFixed(0) + 'ms').padEnd(8) +
      (r.stringifyMs.toFixed(0) + 'ms').padEnd(11) +
      (r.parseMs.toFixed(0) + 'ms').padEnd(8) +
      (r.cloneMs.toFixed(0) + 'ms').padEnd(8) +
      (r.putMs.toFixed(0) + 'ms').padEnd(10) +
      (r.getMs.toFixed(0) + 'ms').padEnd(8) +
      (MB(r.rss) + 'MB').padEnd(8) +
      (MB(r.heap) + 'MB'),
    );
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); fs.rmSync(DATA, { recursive: true, force: true }); process.exit(1); });
