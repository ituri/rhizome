// Geocode retitle must not create duplicate page titles: when a fresh coordinate page
// geocodes to an address that already has a page, it is merged into that page instead —
// bullets move over, links are re-pointed and relabeled, the empty duplicate is trashed.
const { spawn } = require('child_process');
const http = require('http');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-geo-')); const PORT = 3268; const base = `http://localhost:${PORT}`;
const GEO_PORT = 3269;

// stub geocoder: every coordinate resolves to the same address (Nominatim-shaped)
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

  // "old" is the already-geocoded page for the address; "fresh" is a second geo capture
  // at the same place (jittered coords in the title) with a bullet and an incoming link
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['old', 'fresh', 'journal'] },
    old: { id: 'old', text: 'Falkstraße 116, Duisburg', children: ['oldc'] },
    oldc: { id: 'oldc', text: '51.43121, 6.76453', children: [] },
    fresh: { id: 'fresh', text: '51.43125, 6.76458', children: ['note'] },
    note: { id: 'note', text: 'Paket abgeholt', children: [] },
    journal: { id: 'journal', text: 'Notizen', children: ['ref'] },
    ref: { id: 'ref', text: 'war bei <a href="#/n/fresh">51.43125, 6.76458</a>', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/fresh', { waitUntil: 'domcontentloaded' });   // opening it triggers the geocode
  await sleep(2500);

  const ui = await p.evaluate(() => ({
    hash: location.hash,
    heading: document.querySelector('#zoom-title, .zoom-title, h1')?.textContent?.trim() || '',
    toast: document.querySelector('.toast')?.textContent || '',
  }));
  ok(ui.hash === '#/n/old', `die Ansicht ist zur bestehenden Seite navigiert (${ui.hash})`);

  // the merge round-trips through save: re-check server-side state
  await sleep(1500);
  const saved = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
  const sn = saved.doc.nodes;
  const titles = sn.root.children.map(id => sn[id].text);
  ok(!sn.fresh, 'die Koordinaten-Seite ist weg (in den Trash gemerged)');
  ok(titles.filter(t => t === 'Falkstraße 116, Duisburg').length === 1, `genau eine Adress-Seite (${JSON.stringify(titles)})`);
  ok(sn.old.children.includes('note'), 'das Bullet der neuen Seite wurde in die bestehende verschoben');
  ok((sn.ref?.text || '').includes('#/n/old'), `der Link zeigt auf die bestehende Seite ("${sn.ref?.text}")`);
  ok((sn.ref?.text || '').includes('Falkstraße 116, Duisburg'), 'das Link-Label ist die Adresse statt Koordinaten');

  ok(errs.length === 0, 'keine JS-Fehler' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close();
  srv.kill(); geo.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll geo-merge tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); geo.close(); process.exit(1); });
