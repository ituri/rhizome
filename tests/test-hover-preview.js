// Live hover preview: hovering a [[link]] pops up the target's editable outline, and
// editing inside the popup syncs back through the normal op path.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-hp-')); const PORT = 3274; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;

  // page A holds a bullet linking to "Target"; Target has two children
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['pageA', 'target'] },
    pageA: { id: 'pageA', text: 'Page A', children: ['b1'] },
    b1: { id: 'b1', text: 'see <a href="#/n/target">Target</a> here', children: [] },
    target: { id: 'target', text: 'Target', children: ['t1', 't2'] },
    t1: { id: 't1', text: 'child one', children: [] },
    t2: { id: 't2', text: 'child two', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.evaluateOnNewDocument(() => { // headless reports hover:none; force hover:hover before app scripts load
    const orig = window.matchMedia.bind(window);
    window.matchMedia = q => /hover: hover/.test(q) ? { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } } : orig(q);
  });
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/pageA', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  const link = await p.$('#tree a[href="#/n/target"]');
  ok(link !== null, 'link to Target is rendered');

  // hover it → preview appears with the target's outline
  await p.hover('#tree a[href="#/n/target"]');
  await sleep(700);
  const preview = await p.evaluate(() => {
    const el = document.querySelector('.hover-preview');
    return el ? { text: el.textContent, hasTarget: !!el.querySelector('.item[data-id="target"]'), editable: el.querySelector('.item[data-id="target"] .content')?.isContentEditable } : null;
  });
  ok(preview !== null, 'hover preview appears');
  ok(preview && preview.text.includes('child one') && preview.text.includes('child two'), 'preview shows the target subtree');
  ok(preview && preview.hasTarget && preview.editable, 'the target block in the preview is contenteditable');

  // edit the target's text inside the preview, then commit by clicking away
  await p.evaluate(() => {
    const c = document.querySelector('.hover-preview .item[data-id="target"] .content');
    c.focus();
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(c); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); // caret at end
  });
  await p.keyboard.type(' EDITED');
  await sleep(200);
  await p.evaluate(() => document.querySelector('#zoom-title')?.focus()); // blur the preview → commit
  await sleep(1500); // let the op flush to the server

  const saved = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
  ok(/Target EDITED/.test(saved.doc.nodes.target.text), `edit in preview synced to server ("${saved.doc.nodes.target.text}")`);
  ok((saved.doc.nodes.target.children || []).join() === 't1,t2', 'target subtree intact after edit');
  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll hover-preview tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
