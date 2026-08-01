/* {{table}} block (Roam-style): a bullet containing {{table}} renders its children as a
   table — children are rows, nesting levels are columns, a parent cell rowspans its leaf
   paths. Source bullets stay editable below; cell click focuses the underlying bullet.
   Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1300, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  //   {{table}}
  //     Zeile A → A2 → A3
  //     Zeile B → B2a / B2b     (B spans two leaf rows)
  const t = await page.evaluate(() => {
    // makeNode/insertAt, not opNewAt: the latter focuses the (empty) bullet and the next
    // commit would wipe a directly-assigned text
    snapshot();
    const mk = (text, parent, i) => { const id = makeNode(text); insertAt(parent, i, id); return id; };
    const tb = mk('Preise {{table}}', 'root', 0);
    const a = mk('Zeile A', tb, 0);
    const a2 = mk('A2', a, 0);
    mk('A3', a2, 0);
    const bRow = mk('Zeile B', tb, 1);
    const b2a = mk('B2a', bRow, 0);
    mk('B2b', bRow, 1);
    rebuildParentMap(); markDirty(); renderPage();
    return { tb, a, bRow, b2a };
  });
  await sleep(400);

  const shape = await page.evaluate(t => {
    const box = document.querySelector(`.item[data-id="${t.tb}"] > .rz-table-block`);
    if (!box) return null;
    const trs = [...box.querySelectorAll('tr')];
    return {
      rows: trs.length,
      cells: trs.map(tr => [...tr.querySelectorAll('td')].map(td => ({ text: td.textContent, span: td.rowSpan }))),
      sourceStillThere: !!document.querySelector(`.item[data-id="${t.a}"] .content`),
    };
  }, t);
  ok(!!shape, 'the {{table}} block renders a table under the bullet');
  ok(shape.rows === 3, `three leaf rows (${shape.rows})`);
  ok(shape.cells[0].map(c => c.text).join('|') === 'Zeile A|A2|A3', `row 1 walks the nesting into columns (${shape.cells[0].map(c => c.text).join('|')})`);
  ok(shape.cells[1][0].text === 'Zeile B' && shape.cells[1][0].span === 2, `a branching parent cell rowspans its leaves (span ${shape.cells[1][0].span})`);
  ok(shape.cells[2].length === 1 && shape.cells[2][0].text === 'B2b', 'the continuation row holds only the sibling cell');
  ok(shape.sourceStillThere, 'the source bullets stay mounted (editable) below the table');

  // cell click focuses the underlying bullet
  await page.evaluate(t => {
    const td = document.querySelector(`.rz-table td[data-id="${t.b2a}"]`);
    td.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, t);
  await sleep(300);
  const focused = await page.evaluate(t => {
    const ctx = editableCtx(document.activeElement);
    return ctx ? ctx.id : null;
  }, t);
  ok(focused === t.b2a, `clicking a cell focuses its bullet (${focused})`);

  // live update: editing a source bullet refreshes the rendered table without a re-render
  await page.evaluate(t => document.querySelector(`.item[data-id="${t.b2a}"] .content`)?.focus(), t);
  await sleep(200);
  await page.keyboard.press('End');
  await page.keyboard.type(' NEU');
  await sleep(700);   // past the commit debounce
  const liveCell = await page.evaluate(t => document.querySelector(`.rz-table td[data-id="${t.b2a}"]`)?.textContent, t);
  ok(/B2a NEU/.test(liveCell || ''), `editing a source bullet live-updates its cell (${liveCell})`);
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(300);

  // empty table shows the hint
  await page.evaluate(() => {
    snapshot();
    const e = makeNode('{{table}}'); insertAt('root', 0, e);
    rebuildParentMap(); markDirty(); renderPage(); window.__empty = e;
  });
  await sleep(300);
  ok(await page.evaluate(() => !!document.querySelector(`.item[data-id="${window.__empty}"] .rz-table-block .ref-none`)),
    'an empty {{table}} explains how to fill it');

  await browser.close();
  console.log(fl ? `\n${fl} TABLE TESTS FAILING` : '\nTABLE TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
