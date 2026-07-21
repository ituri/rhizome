// Global command palette: Alt+Shift+P opens it, fuzzy-filters commands, and Enter runs one.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-cmd-')); const PORT = 3275; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['pageA'] },
    pageA: { id: 'pageA', text: 'Page A', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  // Alt+Shift+P opens the palette
  await p.keyboard.down('Alt'); await p.keyboard.down('Shift');
  await p.keyboard.press('P');
  await p.keyboard.up('Shift'); await p.keyboard.up('Alt');
  await sleep(300);
  ok(await p.evaluate(() => !document.getElementById('cmd-overlay').hidden), 'Alt+Shift+P opens the palette');
  ok(await p.evaluate(() => document.querySelectorAll('#cmd-results .cmd-row').length > 5), 'palette lists commands');
  ok(await p.evaluate(() => !!document.querySelector('#cmd-results .cmd-group')), 'commands are grouped when unfiltered');

  // fuzzy filter: "allpg" should surface "Go to All Pages" as the top row
  await p.focus('#cmd-input');
  await p.keyboard.type('allpg');
  await sleep(250);
  const top = await p.evaluate(() => {
    const r = document.querySelector('#cmd-results .cmd-row.active .jr-text') || document.querySelector('#cmd-results .cmd-row .jr-text');
    return r ? r.textContent : null;
  });
  ok(top === 'Go to All Pages', `fuzzy "allpg" ranks "Go to All Pages" first (got "${top}")`);

  // Enter runs it → navigates to #/pages
  await p.keyboard.press('Enter');
  await sleep(500);
  ok(await p.evaluate(() => location.hash === '#/pages'), `Enter runs the command (hash="${await p.evaluate(() => location.hash)}")`);
  ok(await p.evaluate(() => document.getElementById('cmd-overlay').hidden), 'palette closes after running');

  // reopen (confirms Alt+Shift+P works a second time), then Escape closes without running
  await p.keyboard.down('Alt'); await p.keyboard.down('Shift'); await p.keyboard.press('P'); await p.keyboard.up('Shift'); await p.keyboard.up('Alt');
  await sleep(200);
  ok(await p.evaluate(() => !document.getElementById('cmd-overlay').hidden), 'Alt+Shift+P reopens the palette');
  await p.keyboard.press('Escape');
  await sleep(200);
  ok(await p.evaluate(() => document.getElementById('cmd-overlay').hidden), 'Escape closes the palette');

  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll command-palette tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
