// Shift+Enter breaks the line INSIDE a bullet (it no longer adds a note), and Home jumps to the
// start of the whole bullet rather than the start of the visual line. The content box is
// white-space: pre-wrap, so the break is a real "\n" that survives serialize → store → re-render.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-ml-')); const PORT = 3268; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json(); const gid = me.graphs[0].id;
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['pg'] },
    pg: { id: 'pg', text: 'Page', children: ['n1', 'n2'] },
    n1: { id: 'n1', text: '', children: [] },
    n2: { id: 'n2', text: '', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });
  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/pg', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  const html = id => p.evaluate(i => document.querySelector(`.item[data-id="${i}"] .content`)?.innerHTML ?? null, id);
  const text = id => p.evaluate(i => document.querySelector(`.item[data-id="${i}"] .content`)?.textContent ?? null, id);
  const stored = async id => ((await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json()).doc.nodes[id] || {}).text ?? null;
  const caret = id => p.evaluate(i => {
    const el = document.querySelector(`.item[data-id="${i}"] .content`);
    const s = getSelection(); if (!s.rangeCount || !el.contains(s.getRangeAt(0).startContainer)) return null;
    const r = document.createRange(); r.selectNodeContents(el); r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset);
    return r.toString().length;
  }, id);

  /* ---- 1. Shift+Enter makes a line, not a note ---- */
  await (await p.$('.item[data-id="n1"] .content')).click(); await sleep(150);
  await p.keyboard.type('erste zeile', { delay: 8 });
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await p.keyboard.type('zweite zeile', { delay: 8 });
  await sleep(700);

  ok(await text('n1') === 'erste zeile\nzweite zeile', `beide Zeilen im selben Bullet (${JSON.stringify(await text('n1'))})`);
  ok((await p.$('.item[data-id="n1"] .note')) === null, 'Shift+Enter hat KEINE Notiz angelegt');
  const twoLines = await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="n1"] .content');
    return { h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) };
  });
  ok(twoLines.h > twoLines.lh * 1.6, `wird zweizeilig gerendert (${Math.round(twoLines.h)}px bei ${Math.round(twoLines.lh)}px Zeilenhöhe)`);

  /* ---- 2. Home → start of the BULLET, not of the visual line ---- */
  // caret sits at the very end (line 2); Home must land on offset 0, i.e. before "erste"
  await p.keyboard.press('Home'); await sleep(120);
  ok(await caret('n1') === 0, `Home springt an den Bullet-Anfang, nicht an den Zeilenanfang (Offset ${await caret('n1')})`);
  // typing there proves it is really the caret position, not just a reported offset
  await p.keyboard.type('X', { delay: 8 }); await sleep(500);
  ok(await text('n1') === 'Xerste zeile\nzweite zeile', `Eingabe landet am Bullet-Anfang (${JSON.stringify(await text('n1'))})`);

  // Shift+Home from the end of line 2 selects back to offset 0 (across the line break)
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="n1"] .content');
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await p.keyboard.down('Shift'); await p.keyboard.press('Home'); await p.keyboard.up('Shift'); await sleep(120);
  const sel = await p.evaluate(() => getSelection().toString());
  ok(sel === 'Xerste zeile\nzweite zeile', `Shift+Home markiert bis zum Bullet-Anfang (${JSON.stringify(sel)})`);

  /* ---- 3. survives commit → store → reload ---- */
  await p.evaluate(() => window.commitActiveText && window.commitActiveText());
  await sleep(300);
  await p.evaluate(() => document.activeElement.blur());
  await sleep(1200);
  const s1 = await stored('n1');
  ok(s1 === 'Xerste zeile\nzweite zeile', `gespeichert mit echtem Zeilenumbruch (${JSON.stringify(s1)})`);
  ok(!/<br/i.test(s1 || ''), 'kein <br> im gespeicherten Text (serializeChildren wirft die weg)');

  await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500);
  ok(await text('n1') === 'Xerste zeile\nzweite zeile', `nach Reload weiterhin zweizeilig (${JSON.stringify(await text('n1'))})`);

  /* ---- 4. formatting and links survive around a line break ---- */
  await (await p.$('.item[data-id="n2"] .content')).click(); await sleep(150);
  await p.keyboard.type('**fett** oben', { delay: 8 });
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await p.keyboard.type('und [[Page]] unten', { delay: 8 });
  await sleep(600);
  await p.evaluate(() => window.commitActiveText && window.commitActiveText());
  await sleep(300);
  await p.evaluate(() => document.activeElement.blur());
  await sleep(1200);
  const s2 = await stored('n2');
  ok(/<b>fett<\/b>/.test(s2 || ''), `**fett** vor dem Umbruch wird zu <b> (${JSON.stringify(s2)})`);
  ok(/\n/.test(s2 || ''), 'der Umbruch selbst bleibt erhalten');
  ok(/href="#\/n\/pg"/.test(s2 || ''), '[[Page]] nach dem Umbruch wird zum Seitenlink');

  /* ---- 5. re-focus reveals the source WITH the break, caret stays put ---- */
  await (await p.$('.item[data-id="n2"] .content')).click(); await sleep(400);
  const reveal = await text('n2');
  ok(reveal.includes('**fett**') && reveal.includes('[[Page]]') && reveal.includes('\n'),
    `Reveal beim Fokus zeigt Rohquelle inkl. Umbruch (${JSON.stringify(reveal)})`);
  // a redecorate pass must not fight the caret across the break
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="n2"] .content');
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  const before = await caret('n2');
  await p.keyboard.type('!', { delay: 8 }); await sleep(800);   // triggers the debounced redecorate
  ok(await caret('n2') === before + 1, `Caret bleibt nach dem Redecorate hinter dem Umbruch (${before} → ${await caret('n2')})`);

  /* ---- 6. Shift+Enter then leaving straight away doesn't store a phantom line ---- */
  // the browser keeps a trailing "\n" placeholder in the live DOM so the caret has somewhere to
  // sit; what gets stored must be what the user actually wrote
  await p.evaluate(() => {
    const el = document.querySelector('.item[data-id="n1"] .content');
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    el.focus();
  });
  await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
  await sleep(900);   // let the debounced commit fire FIRST, so only the focusout path can fix it
  await p.evaluate(() => document.activeElement.blur());
  await sleep(1200);
  const s3 = await stored('n1');
  ok(!/\n\n$/.test(s3 || ''), `kein doppelter Umbruch am Ende gespeichert (${JSON.stringify(s3)})`);

  /* ---- 7. plain Enter still splits a multi-line bullet at the caret ---- */
  await (await p.$('.item[data-id="n2"] .content')).click(); await sleep(300);
  await p.evaluate(() => {   // caret right after "oben", i.e. before the line break
    const el = document.querySelector('.item[data-id="n2"] .content');
    const t = el.textContent, at = t.indexOf('\n');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let seen = 0, node;
    while ((node = w.nextNode())) {
      if (seen + node.nodeValue.length >= at) {
        const r = document.createRange(); r.setStart(node, at - seen); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); return;
      }
      seen += node.nodeValue.length;
    }
  });
  await p.keyboard.press('Enter'); await sleep(900);
  await p.evaluate(() => { window.commitActiveText?.(); document.activeElement.blur(); });
  await sleep(1200);
  const after = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
  const kids = after.doc.nodes.pg.children.map(i => after.doc.nodes[i].text);
  ok(kids.length === 3, `Enter teilt das mehrzeilige Bullet in zwei (${kids.length} Bullets)`);
  ok(/oben$/.test(kids[1] || ''), `obere Hälfte endet bei "oben" (${JSON.stringify(kids[1])})`);
  ok(/^\n?und /.test(kids[2] || ''), `untere Hälfte beginnt mit dem Rest (${JSON.stringify(kids[2])})`);

  console.log('PAGE ERRORS:', errs.length ? errs : 'keine'); if (errs.length) fail++;
  console.log(fail ? `\n${fail} FEHL` : '\nShift+Enter (Zeilenumbruch) und Home (Bullet-Anfang) funktionieren');
  await b.close(); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
