// Command palette "Delete this page…": confirms, deletes the current page to the trash, and
// jumps back to the journal.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-pd-')); const PORT = 3284; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const openPalette = async p => { await p.keyboard.down('Alt'); await p.keyboard.down('Shift'); await p.keyboard.press('P'); await p.keyboard.up('Shift'); await p.keyboard.up('Alt'); await sleep(250); };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['pageA', 'pageB'] },
    pageA: { id: 'pageA', text: 'Doomed Page', children: ['a1'] },
    a1: { id: 'a1', text: 'some content', children: [] },
    pageB: { id: 'pageB', text: 'Keep Me', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  let dialogMsg = '';
  p.on('dialog', async d => { dialogMsg = d.message(); await d.accept(); });   // accept the confirm
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/pageA', { waitUntil: 'domcontentloaded' }); await sleep(1400);

  // the command is offered and ranks for "delete"
  await openPalette(p);
  await p.focus('#cmd-input'); await p.keyboard.type('delete this'); await sleep(200);
  const top = await p.evaluate(() => document.querySelector('#cmd-results .cmd-row .jr-text')?.textContent);
  ok(top === 'Delete this page…', `"delete this" ranks the delete command first (got "${top}")`);

  // run it → confirm dialog appears, then it deletes + jumps to the journal
  await p.keyboard.press('Enter');
  await sleep(1500);
  ok(/Doomed Page/.test(dialogMsg), `a confirmation with the page title appeared ("${dialogMsg}")`);
  ok(await p.evaluate(() => location.hash === '#/' || location.hash === ''), `jumped back to the journal (hash="${await p.evaluate(() => location.hash)}")`);

  // server: the page is gone from the outline (moved to trash), siblings untouched
  await sleep(800);
  const saved = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
  const kids = saved.doc.nodes.root.children;
  ok(!kids.includes('pageA'), 'deleted page removed from the outline');
  ok(kids.includes('pageB'), 'other pages untouched');
  ok((saved.doc.trash || []).some(t => t.root === 'pageA'), 'deleted page is recoverable in the trash');
  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll palette-delete tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
