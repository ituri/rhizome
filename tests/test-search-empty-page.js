// A page with no bullet and no note exists only as a link target ([[Foo]] has to materialise a
// node, links need an id). All Pages and the sidebar hide those; search keeps them findable —
// an orphaned one would be unreachable otherwise — but marks them "Empty" instead of "Page".
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-empty-')); const PORT = 3270; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;

  // "Semantik voll" has a bullet; "Semantik leer" is a bare link target
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['full', 'empty', 'host'] },
    full: { id: 'full', text: 'Semantik voll', children: ['fkid'] },
    fkid: { id: 'fkid', text: 'etwas Inhalt', children: [] },
    empty: { id: 'empty', text: 'Semantik leer', children: [] },
    host: { id: 'host', text: 'Woanders', children: ['mention'] },
    mention: { id: 'mention', text: 'ein Block über Semantik', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/outline', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  // All Pages: the empty one is not listed
  await p.goto(base + '/#/pages', { waitUntil: 'domcontentloaded' }); await sleep(1200);
  const listed = await p.evaluate(() => document.body.innerText);
  ok(listed.includes('Semantik voll'), 'All Pages listet die Seite mit Inhalt');
  ok(!listed.includes('Semantik leer'), 'All Pages listet die leere Seite NICHT');

  // search finds both, but tells them apart
  await p.goto(base + '/#/outline', { waitUntil: 'domcontentloaded' }); await sleep(1000);
  await p.evaluate(() => window.setSearch('Semantik'));
  await sleep(1500);
  const hits = await p.evaluate(() => [...document.querySelectorAll('.search-page')].map(a => ({
    title: a.querySelector('.sp-title')?.textContent || '',
    chip: a.querySelector('.chip')?.textContent || '',
    empty: a.classList.contains('page-empty'),
    accentChip: !!a.querySelector('.chip.accent'),
    opacity: getComputedStyle(a).opacity,
  })));
  const full = hits.find(h => h.title === 'Semantik voll');
  const empty = hits.find(h => h.title === 'Semantik leer');
  ok(full != null, 'die Seite mit Inhalt erscheint in der Suche');
  ok(empty != null, 'die leere Seite bleibt über die Suche auffindbar (sonst wäre eine Waise unerreichbar)');
  ok(full?.chip === 'Page' && full.accentChip, `volle Seite: Accent-Chip "Page" (${full?.chip})`);
  ok(empty?.chip === 'Empty' && !empty.accentChip, `leere Seite: gedämpfter Chip "Empty" (${empty?.chip})`);
  ok(empty?.empty === true, 'leere Seite trägt .page-empty');
  ok(parseFloat(empty?.opacity) < 1, `und wird gedimmt gerendert (opacity ${empty?.opacity})`);
  ok(parseFloat(full?.opacity) === 1, `die volle Seite nicht (opacity ${full?.opacity})`);

  // it stays reachable: clicking the hit opens the page
  await p.evaluate(() => [...document.querySelectorAll('.search-page')].find(a => a.textContent.includes('Semantik leer')).click());
  await sleep(900);
  ok((await p.evaluate(() => location.hash)) === '#/n/empty', 'Klick öffnet die leere Seite trotzdem');

  console.log('PAGE ERRORS:', errs.length ? errs : 'keine'); if (errs.length) fail++;
  console.log(fail ? `\n${fail} FEHL` : '\nLeere Seiten sind in der Suche markiert statt versteckt');
  await b.close(); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
