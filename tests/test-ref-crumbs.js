// Linked references carry a Roam-style breadcrumb: the path from the grouping page down to the
// referencing block. Without it, two blocks that read the same on one page (the Roadmap's
// "August 4th, 2026" under both Web and App) look like one duplicated row.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-crumb-')); const PORT = 3269; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;

  // Roadmap page with two sections, each holding an identically-worded block linking to Target.
  // Plus a third link sitting directly under a second page (no nesting → no crumb).
  const link = '<a href="#/n/target">Target</a>';
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['road', 'other', 'target'] },
    road: { id: 'road', text: 'Roadmap', children: ['web', 'app'] },
    web: { id: 'web', text: 'Web', children: ['webdone'] },
    webdone: { id: 'webdone', text: 'Completed', children: ['wref'] },
    wref: { id: 'wref', text: link, children: [] },
    app: { id: 'app', text: 'App', children: ['appdone'] },
    appdone: { id: 'appdone', text: 'Completed', children: ['aref'] },
    aref: { id: 'aref', text: link, children: [] },
    other: { id: 'other', text: 'Other page', children: ['oref'] },
    oref: { id: 'oref', text: link, children: [] },
    target: { id: 'target', text: 'Target', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/target', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  const groups = await p.evaluate(() => [...document.querySelectorAll('#backlinks .ref-group')].map(g => ({
    page: g.querySelector('.ref-page')?.textContent || '',
    // crumbs and rows are siblings inside the group, in render order
    kids: [...g.children].filter(c => c.className === 'ref-crumbs' || c.className === 'ref-row')
      .map(c => ({ kind: c.className, text: c.textContent.trim() })),
  })));

  const road = groups.find(g => g.page === 'Roadmap');
  ok(road != null, 'Roadmap erscheint als Referenz-Gruppe');
  const roadCrumbs = road.kids.filter(k => k.kind === 'ref-crumbs').map(k => k.text);
  ok(road.kids.filter(k => k.kind === 'ref-row').length === 2, `zwei referenzierende Blöcke (${road.kids.filter(k => k.kind === 'ref-row').length})`);
  ok(roadCrumbs.length === 2, `beide bekommen einen Pfad (${roadCrumbs.length})`);
  ok(roadCrumbs[0] === 'Web›Completed', `erster Pfad zeigt den Web-Zweig ("${roadCrumbs[0]}")`);
  ok(roadCrumbs[1] === 'App›Completed', `zweiter Pfad zeigt den App-Zweig ("${roadCrumbs[1]}")`);
  ok(roadCrumbs[0] !== roadCrumbs[1], 'die beiden gleichlautenden Zeilen sind jetzt unterscheidbar');
  ok(!roadCrumbs.some(c => c.includes('Roadmap')), 'die Gruppenseite steht nicht doppelt im Pfad');

  const other = groups.find(g => g.page === 'Other page');
  ok(other != null && other.kids.filter(k => k.kind === 'ref-crumbs').length === 0,
    'ein direktes Kind der Seite bekommt KEINEN Pfad');

  // the crumb segments are links into the outline
  const href = await p.evaluate(() => document.querySelector('#backlinks .ref-crumb')?.getAttribute('href'));
  ok(href === '#/n/web', `Pfad-Segmente sind anklickbar (${href})`);
  await p.click('#backlinks .ref-crumb'); await sleep(800);
  ok((await p.evaluate(() => location.hash)) === '#/n/web', 'Klick auf ein Segment zoomt dorthin');

  // crumbs must not pick up the [[…]] decoration that ref-row links carry
  const deco = await p.evaluate(() => {
    const a = document.querySelector('#backlinks .ref-crumb');
    return a ? getComputedStyle(a, '::before').content : 'none';
  });
  await p.goto(base + '/#/n/target', { waitUntil: 'domcontentloaded' }); await sleep(1200);
  ok(deco === 'none' || deco === 'normal' || deco === '""', `keine [[…]]-Klammern am Pfad (${deco})`);

  console.log('PAGE ERRORS:', errs.length ? errs : 'keine'); if (errs.length) fail++;
  console.log(fail ? `\n${fail} FEHL` : '\nReferenz-Breadcrumbs funktionieren');
  await b.close(); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
