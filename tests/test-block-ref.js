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
// several times longer than the clamp, to check the visual cut
const HUGE = Array.from({ length: 9 }, (_, i) => `Satz ${i + 1} eines sehr langen Zielblocks, der über viele Zeilen läuft.`).join(' ');

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;

  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['src', 'page'] },
    src: { id: 'src', text: 'Quelle', children: ['target', 'huge', 'tiny'] },
    target: { id: 'target', text: LONG, children: [] },
    huge: { id: 'huge', text: HUGE, children: [] },
    plain: { id: 'plain', text: 'Ganz normaler Bullet', children: [] },
    tiny: { id: 'tiny', text: 'Kurz.', children: [] },
    small: { id: 'small', text: 'Vorher <a href="#/n/tiny" class="block-ref"></a> nachher.', children: [] },
    page: { id: 'page', text: 'Seite', children: ['ref', 'big', 'plain', 'small'] },
    ref: { id: 'ref', text: 'Problem entdeckt: <a href="#/n/target" class="block-ref"></a>', children: [] },
    big: { id: 'big', text: 'Lang: <a href="#/n/huge" class="block-ref"></a> — Nachsatz.', children: [] },
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

  // a target longer than the clamp: cut VISUALLY (three lines + a real ellipsis), never in the DOM
  const big = await p.evaluate((HUGE) => {
    const ref = document.querySelector('.item[data-id="big"] .block-ref');
    const content = document.querySelector('.item[data-id="big"] .content');
    const lh = parseFloat(getComputedStyle(content).lineHeight);
    return {
      lines: Math.round(ref.getBoundingClientRect().height / lh),
      clamped: ref.scrollHeight > ref.clientHeight + 1,
      whole: ref.textContent === HUGE,
      tail: (content.textContent || '').includes('Nachsatz'),
      plainRow: document.querySelector('.item[data-id="plain"] .content').getBoundingClientRect().height,
      smallRow: document.querySelector('.item[data-id="small"] .content').getBoundingClientRect().height,
      smallOneLine: (() => {
        const c = document.querySelector('.item[data-id="small"] .content');
        const r = c.querySelector('.block-ref');
        return Math.round(r.getBoundingClientRect().top - c.getBoundingClientRect().top);
      })(),
    };
  }, HUGE);
  ok(big.lines === 3, `ein überlanges Ziel wird auf 3 Zeilen geklammert (${big.lines})`);
  ok(big.clamped, 'und zwar sichtbar gekürzt (Auslassungszeichen)');
  ok(big.whole, 'im DOM steht trotzdem der ganze Text — markierbar, kopierbar, durchsuchbar');
  ok(big.tail, 'Text nach der Referenz geht nicht verloren');
  ok(big.smallRow === big.plainRow, `ein kurzer Ref bleibt einzeilig wie jeder andere Bullet (${big.smallRow} vs. ${big.plainRow})`);
  // vertical-align: bottom hängt die Inline-Box an die Grundlinie, ihr Kastenrand darf also um
  // wenige Pixel abweichen — dieselbe Zeile ist es, solange der Versatz unter einer Zeilenhöhe bleibt
  ok(Math.abs(big.smallOneLine) < big.plainRow, `und steht in derselben Zeile wie der Text davor (Versatz ${big.smallOneLine}px)`);

  console.log('PAGE ERRORS:', errs.length ? errs : 'keine'); if (errs.length) fail++;
  console.log(fail ? `\n${fail} FEHL` : '\nBlockrefs zeigen den vollen Zieltext');
  await b.close(); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
