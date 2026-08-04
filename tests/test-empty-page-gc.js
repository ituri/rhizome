// A page that is empty AND unlinked is debris: [[Foo]] has to materialise a node, and once the
// link that made it is edited away nothing is left — no content to lose, no link to break. It is
// collected on the way out of the block. Empty-but-linked and unlinked-but-written pages stay.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-gc-')); const PORT = 3271; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;

  const old = Date.now() - 60 * 60 * 1000;   // older than the "just created" grace period
  const link = id => `Siehe <a href="#/n/${id}">${id}</a> dazu`;
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['host', 'orphan', 'kept', 'written', 'twice'] },
    host: { id: 'host', text: 'Host', children: ['b1', 'b2', 'b3'] },
    b1: { id: 'b1', text: link('orphan'), children: [], c: old },   // sole link to the empty page
    b2: { id: 'b2', text: link('kept'), children: [], c: old },     // sole link to another empty page
    b3: { id: 'b3', text: link('twice'), children: [], c: old },    // one of TWO links
    orphan: { id: 'orphan', text: 'Leer und gleich unverlinkt', children: [], c: old },
    kept: { id: 'kept', text: 'Leer, aber verlinkt', children: [], c: old },
    written: { id: 'written', text: 'Unverlinkt, aber beschrieben', children: ['w1'], c: old },
    w1: { id: 'w1', text: 'Inhalt', children: [], c: old },
    twice: { id: 'twice', text: 'Leer, zweimal verlinkt', children: [], c: old },
  } };
  doc.nodes.host.children.push('b4');
  doc.nodes.b4 = { id: 'b4', text: link('twice'), children: [], c: old };   // the second link
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/host', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  const alive = id => p.evaluate(i => !!doc.nodes[i], id);
  const candidates = () => p.evaluate(() => window.emptyOrphanPages());

  ok(await alive('orphan'), 'Ausgangslage: die leere Seite existiert noch');
  ok((await candidates()).length === 0, 'solange verlinkt, ist sie kein Sammel-Kandidat');

  // wipe the only link to `orphan`, then leave the block
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="b1"] .content');
    el.focus();
  });
  await sleep(300);
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="b1"] .content');
    el.textContent = 'Der Link ist weg';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await sleep(300);
  await p.evaluate(() => document.activeElement.blur());
  await sleep(1200);

  ok(!(await alive('orphan')), 'der entlinkte, leere Knoten ist eingesammelt');
  ok(await alive('kept'), 'die leere, aber noch verlinkte Seite bleibt');
  ok(await alive('written'), 'die unverlinkte, aber beschriebene Seite bleibt');
  ok(await alive('twice'), 'eine Seite mit einem zweiten Link bleibt');
  const trashed = await p.evaluate(() => (doc.trash || []).some(t => t.root === 'orphan'));
  ok(trashed, 'sie liegt im Papierkorb, nicht im Nichts');

  // Undo brings it back — the collection is its own step (the toast's Undo restores the page,
  // a second Undo the edit that orphaned it), so each state on the way back is consistent
  await p.evaluate(() => undo());
  await sleep(800);
  ok(await alive('orphan'), 'Undo stellt die Seite wieder her');
  await p.evaluate(() => undo());
  await sleep(800);
  ok(await p.evaluate(() => (doc.nodes.b1.text || '').includes('#/n/orphan')), 'ein zweites Undo bringt auch den Link zurück');
  ok(await alive('orphan'), 'und die Seite ist dabei nicht wieder verschwunden');

  // removing one of two links leaves the page alone
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="b3"] .content');
    el.focus();
    el.textContent = 'nur noch Text';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await sleep(300);
  await p.evaluate(() => document.activeElement.blur());
  await sleep(1200);
  ok(await alive('twice'), 'ein verbleibender zweiter Link hält die Seite am Leben');

  // the page you are standing on is never collected
  await p.goto(base + '/#/n/kept', { waitUntil: 'domcontentloaded' }); await sleep(1200);
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="b2"] .content');
    if (el) { el.focus(); el.textContent = 'entlinkt'; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
  });
  await sleep(300);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(1200);
  ok(await alive('kept'), 'die gerade geöffnete Seite wird nie eingesammelt');

  console.log('PAGE ERRORS:', errs.length ? errs : 'keine'); if (errs.length) fail++;
  console.log(fail ? `\n${fail} FEHL` : '\nLeere, unverlinkte Seiten werden eingesammelt — und nur die');
  await b.close(); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
