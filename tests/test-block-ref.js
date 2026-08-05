// A block reference ((id)) is a transclusion: it shows the target block's CURRENT text, in full.
// It used to be cut at 140 characters — mid-word, without an ellipsis — so a reference to any
// normal-length paragraph quietly lied about what it referenced.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-bref-')); const PORT = 3272; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

// 166 characters — the length that first showed the bug (cut landed after "wurde der n")
const LONG = 'Habe eine Adresse in iOS hinzugefügt per Button aus der Toolbar. Dann umbenannt. '
  + 'Dort wo sie ursprünglich per Link verlinkt war, wurde der neue Name nicht übernommen.';

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;

  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['src', 'page'] },
    src: { id: 'src', text: 'Quelle', children: ['target'] },
    target: { id: 'target', text: LONG, children: [] },
    page: { id: 'page', text: 'Seite', children: ['ref'] },
    ref: { id: 'ref', text: 'Problem entdeckt: <a href="#/n/target" class="block-ref"></a>', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/page', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  const shown = await p.evaluate(() => document.querySelector('.item[data-id="ref"] .block-ref')?.textContent || '');
  ok(shown === LONG, `der Blockref zeigt den ganzen Zieltext (${shown.length}/${LONG.length} Zeichen)`);
  ok(!shown.endsWith('wurde der n'), 'nicht mehr mitten im Wort abgeschnitten');

  // still live: editing the target updates the reference
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="ref"] .content');
    el.focus();
  });
  await sleep(300);
  const raw = await p.evaluate(() => document.querySelector('.item[data-id="ref"] .content')?.textContent || '');
  ok(raw.includes('((target))'), `beim Editieren zeigt die Zeile wieder die Rohquelle (${raw.slice(0, 40)!== undefined ? raw.slice(0, 40) : ''}…)`);
  await p.evaluate(() => document.activeElement.blur());
  await sleep(900);
  const back = await p.evaluate(() => document.querySelector('.item[data-id="ref"] .block-ref')?.textContent || '');
  ok(back === LONG, 'nach dem Verlassen steht der volle Text wieder da');

  const stored = (await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json()).doc.nodes.ref.text;
  ok(/class="block-ref"><\/a>/.test(stored), `gespeichert bleibt der Ref leer, der Text lebt am Ziel (${stored})`);

  console.log('PAGE ERRORS:', errs.length ? errs : 'keine'); if (errs.length) fail++;
  console.log(fail ? `\n${fail} FEHL` : '\nBlockrefs zeigen den vollen Zieltext');
  await b.close(); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
