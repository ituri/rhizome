// Web reveal-on-focus: while editing a bullet, links + formatting show their raw markdown
// source ([[Name]], [text](url), **bold**, etc.); on blur they resolve to stored HTML; on
// re-focus they revert to raw source again. Mirrors the iOS RichEditor behaviour.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-rev-')); const PORT = 3266; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;
  // a second top-level page "Foo" so [[Foo]] resolves to an existing page
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['pg', 'foo'] },
    pg: { id: 'pg', text: 'Page', children: ['n1'] },
    foo: { id: 'foo', text: 'Foo', children: [] },
    n1: { id: 'n1', text: '', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });
  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); let errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/pg', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  const content = await p.$('.item[data-id="n1"] .content');
  ok(content !== null, 'editierbares Bullet gefunden');
  await content.click(); await sleep(200);
  await p.keyboard.type('See [Google](https://google.com) and **bold** and [[Foo]] end', { delay: 12 });
  await sleep(700);

  // while editing: NO live conversion — the DOM still shows raw markdown text
  const editing = await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="n1"] .content');
    return { text: el?.textContent || '', anchors: el?.querySelectorAll('a').length ?? -1, bolds: el?.querySelectorAll('b').length ?? -1 };
  });
  ok(editing.text.includes('[Google](https://google.com)'), `[text](url) bleibt roh beim Editieren ("${editing.text}")`);
  ok(editing.text.includes('**bold**'), '**bold** bleibt roh beim Editieren');
  ok(editing.text.includes('[[Foo]]'), '[[Foo]] bleibt roh beim Editieren');
  ok(editing.anchors === 0 && editing.bolds === 0, `keine Live-Anker/Fett-Elemente (a=${editing.anchors}, b=${editing.bolds})`);

  // blur → resolves to stored HTML
  await p.evaluate(() => window.commitActiveText && window.commitActiveText());
  await sleep(400);
  await p.evaluate(() => document.activeElement.blur());
  await sleep(1200);
  const back = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
  const html = (back.doc.nodes.n1 && back.doc.nodes.n1.text) || '';
  ok(/href="https:\/\/google\.com"[^>]*>Google</.test(html), `externer Link persistiert (${JSON.stringify(html)})`);
  ok(/<b>bold<\/b>/.test(html), '**bold** → <b>bold</b> persistiert');
  ok(/href="#\/n\/foo"[^>]*>Foo</.test(html), '[[Foo]] → interner Link auf bestehende Seite Foo');

  // rendered (not editing): shows real formatting/links, not raw markdown
  const rendered = await p.evaluate(() => document.querySelector('.item[data-id="n1"] .content')?.innerHTML || '');
  ok(rendered.includes('<b>bold</b>') && !rendered.includes('**bold**'), 'gerendert zeigt echtes <b> (kein **)');

  // re-focus → reverts to raw markdown source (reveal on focus)
  const c2 = await p.$('.item[data-id="n1"] .content');
  await c2.click(); await sleep(400);
  const refocus = await p.evaluate(() => document.querySelector('.item[data-id="n1"] .content')?.textContent || '');
  ok(refocus.includes('**bold**') && refocus.includes('[[Foo]]') && refocus.includes('[Google](https://google.com)'),
    `Reveal beim erneuten Fokus zeigt Rohquelle ("${refocus}")`);

  console.log('PAGE ERRORS:', errs.length ? errs : 'keine'); if (errs.length) fail++;
  console.log(fail ? `\n${fail} FEHL` : '\nWeb-Reveal (Links + Formatierung) funktioniert');
  await b.close(); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
