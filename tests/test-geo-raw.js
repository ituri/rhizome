// A location page flagged geo:"raw" must never be reverse-geocoded/retitled on view — the
// user tagged it coordinates-only (e.g. the iOS location button's long-press). A normal
// coordinate page (no flag) must still auto-geocode, so existing behaviour is preserved.
const { spawn } = require('child_process');
const http = require('http');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-graw-')); const PORT = 3270; const base = `http://localhost:${PORT}`;
const GEO_PORT = 3271;

// stub geocoder: any coordinate resolves to the same address (Nominatim-shaped)
const geo = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ address: { road: 'Falkstraße', house_number: '116', city: 'Duisburg' } }));
}).listen(GEO_PORT);

const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1',
    RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x',
    RHIZOME_GEOCODER_URL: `http://127.0.0.1:${GEO_PORT}/reverse` },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;

  // two coordinate pages with the same jittered-coord shape: one flagged raw, one plain
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['raw', 'plain'] },
    raw: { id: 'raw', text: '51.43121, 6.76453', geo: 'raw', children: [] },
    plain: { id: 'plain', text: '51.43125, 6.76458', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });

  // open the flagged page — must NOT geocode
  await p.goto(base + '/#/n/raw', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  // open the plain page — must geocode
  await p.goto(base + '/#/n/plain', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  // the flag on `raw` survives a full round-trip through the server (custom node field kept)
  await sleep(1000);

  const saved = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
  const sn = saved.doc.nodes;
  ok(sn.raw.text === '51.43121, 6.76453', `raw page keeps its coordinate title ("${sn.raw.text}")`);
  ok(sn.raw.geo === 'raw', 'raw page keeps its geo:"raw" flag through save');
  ok((sn.raw.children || []).length === 0, 'raw page got no coordinates bullet (no retitle happened)');
  ok(sn.plain.text === 'Falkstraße 116, Duisburg', `plain page was geocoded ("${sn.plain.text}")`);
  ok(errs.length === 0, 'keine JS-Fehler' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close();
  srv.kill(); geo.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll geo-raw tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); geo.close(); process.exit(1); });
