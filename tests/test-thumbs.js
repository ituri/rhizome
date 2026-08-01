/* Client-generated thumbnails: POST /api/thumb writes <stored>.thumb.webp next to an
   existing upload; the sidecar is served, never listed as an orphan, and dies with its
   original. Pure Node, open-mode server. */
'use strict';
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3241;
const base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-thumbs-'));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')],
  { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { /* boot */ } await sleep(200); }

  // upload a fake image
  const up = await (await fetch(base + '/api/upload?name=foto.png', { method: 'POST', body: Buffer.from('fake-png-bytes') })).json();
  ok(/^\/files\//.test(up.url || ''), `upload stored (${up.url})`);
  const stored = decodeURIComponent(up.url.replace('/files/', ''));

  // sidecar thumb: post, then it serves
  let r = await fetch(base + '/api/thumb?name=' + encodeURIComponent(stored), { method: 'POST', body: Buffer.from('fake-webp-bytes') });
  const tj = await r.json();
  ok(r.status === 200 && tj.url === `/files/${encodeURIComponent(stored + '.thumb.webp')}`, `thumb accepted (${tj.url})`);
  r = await fetch(base + tj.url);
  ok(r.status === 200 && (r.headers.get('content-type') || '').includes('image/webp'), `thumb serves as webp (${r.headers.get('content-type')})`);

  // guards: unknown original, thumb-of-thumb
  r = await fetch(base + '/api/thumb?name=does-not-exist.png', { method: 'POST', body: Buffer.from('x') });
  ok(r.status === 404, 'thumb for an unknown file is rejected');
  r = await fetch(base + '/api/thumb?name=' + encodeURIComponent(stored + '.thumb.webp'), { method: 'POST', body: Buffer.from('x') });
  ok(r.status === 400, 'a thumb of a thumb is rejected');

  // orphans: the original shows up (unreferenced), the sidecar never does
  const orphans = (await (await fetch(base + '/api/g/default/assets/orphans')).json()).orphans || [];
  ok(orphans.some(o => o.name === stored), 'the unreferenced original is listed as an orphan');
  ok(!orphans.some(o => /\.thumb\.webp$/.test(o.name)), 'the sidecar thumb is not listed');

  // deleting the original sweeps the sidecar
  r = await fetch(base + '/api/g/default/assets/orphans/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: [stored] }),
  });
  ok((await r.json()).removed === 1, 'orphan delete removes the original');
  const gone = await fetch(base + tj.url);
  ok(gone.status === 404, `…and its thumb dies with it (${gone.status})`);

  console.log(fl ? `\n${fl} THUMB TESTS FAILING` : '\nTHUMB TESTS PASSED');
  srv.kill();
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
