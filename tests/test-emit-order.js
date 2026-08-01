/* Regression: opsFromJournal must emit inserts topologically (a parent's insert before its
   new child's), even when the child's parent was touched FIRST in the txn. That is exactly
   the ensureDay shape on the first day of a month (ensureMonth creates the month, then the
   day) — the old walk emitted [insert day, insert month] and the server root-fell-back the
   day, duplicating the daily page. Needs a server on 3211 (started here). Deterministic. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const PORT = 3213;

let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-emit-order-'));
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')],
    { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
    await page.goto(`http://localhost:${PORT}/#/outline`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tree .item .content');

    // 1. the raw txn shape: new child under new parent, parent touched first
    const chain = await page.evaluate(() => {
      commitActiveText(); resetHistory();
      snapshot();
      const a = makeNode('order-parent');            // touched first (recOld a)
      insertAt(HOME, 0, a);
      const b = makeNode('order-child');             // then the chained child
      insertAt(a, 0, b);
      rebuildParentMap();
      const ops = window.__opsFromJournal();
      return { a, b, kinds: ops.map(o => ({ kind: o.kind, node: o.node, parent: o.parent })) };
    });
    const inserts = chain.kinds.filter(o => o.kind === 'insert').map(o => o.node);
    ok(inserts.includes(chain.a) && inserts.includes(chain.b), `both inserts emitted (${inserts.length})`);
    ok(inserts.indexOf(chain.a) < inserts.indexOf(chain.b),
      `parent's insert emitted before the child's (${inserts.indexOf(chain.a)} < ${inserts.indexOf(chain.b)})`);

    // 2. the real thing: ensureDay for a date in a month that doesn't exist yet
    const day = await page.evaluate(() => {
      commitActiveText(); resetHistory();
      snapshot();
      const id = ensureDay('2031-02-01');            // brand-new year+month+day chain
      rebuildParentMap();
      const ops = window.__opsFromJournal();
      const emitted = ops.filter(o => o.kind === 'insert').map(o => o.node);
      const parentIdx = {};
      ops.filter(o => o.kind === 'insert').forEach((o, i) => { parentIdx[o.node] = { i, parent: o.parent }; });
      return { id, emitted, parentIdx };
    });
    let topological = true;
    for (const [node, { i, parent }] of Object.entries(day.parentIdx)) {
      if (day.parentIdx[parent] && day.parentIdx[parent].i > i) topological = false;
      void node;
    }
    ok(day.emitted.length >= 2, `ensureDay on a fresh month emits an insert chain (${day.emitted.length})`);
    ok(topological, 'every insert is emitted after its parent\'s insert (year → month → day)');
  } finally {
    await browser.close();
    srv.kill();
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* fine */ }
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nEMIT-ORDER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
