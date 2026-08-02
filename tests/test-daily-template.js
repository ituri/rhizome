/* Daily template: the children of a bullet tagged #daily-template seed every freshly
   created journal day — in the server's capture path AND the web client's ensureDay.
   Self-contained: boots its own open-mode server with an agent token. */
'use strict';
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';

const PORT = 3247;
const base = `http://localhost:${PORT}`;
const AGENT = 'tpl-agent';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-tpl-'));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')],
  { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_AGENT_TOKEN: AGENT }, stdio: 'ignore' });

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { /* boot */ } await sleep(200); }

  // seed a doc with a template: Daily #daily-template → #Log → (empty)
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['tpl'] },
    tpl: { id: 'tpl', text: 'Daily <span class="tag" data-tag="#daily-template">#daily-template</span>', children: ['log'] },
    log: { id: 'log', text: '<span class="tag" data-tag="#Log">#Log</span>', children: ['sub'] },
    sub: { id: 'sub', text: '', children: [] },
  } };
  await fetch(base + '/api/g/default/doc', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc }) });

  /* ---- server path: capture creates today WITH the template ---- */
  const cap = await (await fetch(base + '/api/v1/capture', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AGENT },
    body: JSON.stringify({ text: 'captured line' }),
  })).json();
  ok(cap.captured === 1, 'capture created content');
  const d1 = (await (await fetch(base + '/api/g/default/doc')).json()).doc;
  const today = Object.keys(d1.nodes).find(k => d1.nodes[k].cal === 'day');
  ok(!!today, 'capture created the journal day');
  const dayKids = (d1.nodes[today].children || []).map(id => d1.nodes[id]);
  const logClone = dayKids.find(n => /#Log/.test(n.text || ''));
  ok(!!logClone && logClone.id !== 'log', `the day got a COPY of the template's #Log (${logClone && logClone.id})`);
  ok((logClone.children || []).length === 1, 'the template sub-bullet came along');
  ok(dayKids.some(n => /Inbox/.test(n.text || '')), 'the capture Inbox still lands next to it');
  ok((d1.nodes.tpl.children || []).length === 1 && d1.nodes.log.children.length === 1, 'the template itself is untouched');

  /* ---- web path: ensureDay on a fresh date applies it too ---- */
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1300, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });
  await page.goto(base + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);
  const web = await page.evaluate(() => {
    commitActiveText(); snapshot();
    const day = ensureDay('2031-05-05');
    markDirty();
    const kids = kidsOf(day).map(id => ({ id, text: plainOf(N(id).text), sub: kidsOf(id).length }));
    return { kids, tplKids: kidsOf('tpl').length };
  });
  ok(web.kids.some(k => /#Log/.test(k.text) && k.sub === 1), `web ensureDay seeds a fresh day from the template (${JSON.stringify(web.kids)})`);
  ok(web.tplKids === 1, 'web: template untouched');
  await browser.close();

  console.log(fl ? `\n${fl} DAILY-TEMPLATE TESTS FAILING` : '\nDAILY-TEMPLATE TESTS PASSED');
  srv.kill();
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
