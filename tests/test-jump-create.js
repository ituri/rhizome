// Ctrl+K quick-jump: Shift+Enter creates (or jumps to) a page named exactly by the typed text,
// without arrowing down to the "Create page" row. The create row also shows a Shift+↵ hint.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-jc-')); const PORT = 3282; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['existing'] },
    existing: { id: 'existing', text: 'Existing Page', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/outline', { waitUntil: 'domcontentloaded' }); await sleep(1200);

  const openJump = async () => { await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control'); await p.waitForSelector('#jump-overlay:not([hidden])'); };

  // 1) typing a new title shows a create row carrying the Shift+↵ hint
  await openJump();
  await p.type('#jump-input', 'Brand New Page');
  await sleep(300);
  const createRow = await p.evaluate(() => {
    const r = document.querySelector('.jump-row.jump-create');
    return r ? { text: r.querySelector('.jr-text')?.textContent, kbd: r.querySelector('.jr-kbd')?.textContent } : null;
  });
  ok(createRow && /Create page/.test(createRow.text || ''), 'a "Create page" row is offered for a new title');
  ok(createRow && /Shift\+↵ to create/.test(createRow.kbd || ''), 'the create row shows the Shift+↵ hint');

  // 2) Shift+Enter creates the page and navigates to it — even though the create row isn't highlighted
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await sleep(500);
  const made = await p.evaluate(() => {
    const id = state.zoom;
    const n = N(id);
    return { hidden: document.querySelector('#jump-overlay').hidden, title: plainOf(n?.text || '').trim(), isPage: (doc.nodes[doc.root].children || []).includes(id) };
  });
  ok(made.hidden, 'the jump overlay closes after creating');
  ok(made.title === 'Brand New Page' && made.isPage, `navigated into the newly created page (${JSON.stringify(made)})`);

  // 3) Shift+Enter on an existing title jumps to it instead of duplicating
  await openJump();
  await p.type('#jump-input', 'Existing Page');
  await sleep(300);
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await sleep(500);
  const jumped = await p.evaluate(() => ({
    zoom: state.zoom,
    existingCount: Object.values(doc.nodes).filter(n => plainOf(n.text).trim() === 'Existing Page').length,
  }));
  ok(jumped.zoom === 'existing', 'Shift+Enter on an existing title jumps to that page');
  ok(jumped.existingCount === 1, 'no duplicate page was created');

  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll jump-create tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
