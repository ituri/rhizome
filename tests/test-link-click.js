// Internal links stay clickable under reveal-on-focus: clicking a [[link]] navigates instead of
// revealing its markdown source. Covers the main outline, links inside a hover preview, and that
// clicking plain text still focuses it for editing (the pointerdown guard only blocks links).
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-lk-')); const PORT = 3281; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const clickCenter = async (p, el) => { const b = await el.boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['pageA', 'target', 'other'] },
    pageA: { id: 'pageA', text: 'Page A', children: ['b1', 'plain'] },
    b1: { id: 'b1', text: 'go to <a href="#/n/target">Target</a> now', children: [] },
    plain: { id: 'plain', text: 'just some editable text', children: [] },
    target: { id: 'target', text: 'Target', children: ['t1'] },
    t1: { id: 't1', text: 'see <a href="#/n/other">Other</a>', children: [] },
    other: { id: 'other', text: 'Other', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.evaluateOnNewDocument(() => { const o = window.matchMedia.bind(window); window.matchMedia = q => /hover: hover/.test(q) ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : o(q); });
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/pageA', { waitUntil: 'domcontentloaded' }); await sleep(1400);

  // 1) click a [[link]] in the main outline → navigates
  await clickCenter(p, await p.$('#tree a[href="#/n/target"]'));
  await sleep(500);
  ok(await p.evaluate(() => location.hash) === '#/n/target', 'clicking a link in the outline navigates');

  // 2) click a link inside a hover preview → navigates
  await p.evaluate(() => location.hash = '#/n/pageA'); await sleep(500);
  await p.hover('#tree a[href="#/n/target"]'); await sleep(700);
  const inner = await p.$('.hover-preview a[href="#/n/other"]');
  ok(inner !== null, 'preview shows the target’s inner link');
  if (inner) { await clickCenter(p, inner); await sleep(500); }
  ok(await p.evaluate(() => location.hash) === '#/n/other', 'clicking a link inside the preview navigates');

  // 3) clicking plain text still focuses it for editing (guard only blocks links)
  await p.evaluate(() => location.hash = '#/n/pageA'); await sleep(500);
  await clickCenter(p, await p.$('#tree .item[data-id="plain"] .content'));
  await sleep(200);
  ok(await p.evaluate(() => document.activeElement?.closest?.('.item')?.dataset.id === 'plain'), 'clicking plain text focuses it for editing');

  // 4) touch: iOS Safari doesn't fire `click` on links in a contenteditable, so navigation is
  // driven from pointerup. Emulate a touch device and tap the link — it must navigate exactly once.
  const tp = await b.newPage(); const terrs = []; tp.on('pageerror', e => terrs.push(e.message));
  await tp.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await tp.emulate({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  await tp.goto(base + '/#/n/pageA', { waitUntil: 'domcontentloaded' }); await sleep(1400);
  await tp.evaluate(() => { window.__hashes = []; addEventListener('hashchange', () => window.__hashes.push(location.hash)); });
  const box = await tp.evaluate(() => { const r = document.querySelector('#tree a[href="#/n/target"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await tp.touchscreen.tap(box.x, box.y);
  await sleep(600);
  ok(await tp.evaluate(() => location.hash) === '#/n/target', 'tapping a link on touch navigates (pointerup path)');
  ok(await tp.evaluate(() => window.__hashes.filter(h => h === '#/n/target').length) === 1, 'touch tap navigates exactly once (no double-fire)');
  ok(terrs.length === 0, 'no JS errors on touch' + (terrs.length ? ': ' + terrs.join(' | ') : ''));
  await tp.close();

  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll link-click tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
