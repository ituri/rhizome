/* Multi-select spans indentation levels: a parent and its children can be selected together
   (Shift+click / Shift+↓ over the visible order), then completed/deleted/moved in bulk. */
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
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);

  // build:  PARENT / CHILDA / CHILDB (children of PARENT) / SIBQ (sibling of PARENT).
  // replace the onboarding bullet's text so the structure is clean.
  await page.evaluate(() => { const el = document.querySelector('.tree .item .content'); el.focus(); getSelection().selectAllChildren(el); });
  await page.keyboard.type('PARENT', { delay: 6 });
  await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  await page.keyboard.type('CHILDA', { delay: 6 });
  await page.keyboard.press('Enter'); await page.keyboard.type('CHILDB', { delay: 6 });
  await page.keyboard.press('Enter');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  await page.keyboard.type('SIBQ', { delay: 6 });
  await sleep(500);
  await page.evaluate(() => document.activeElement.blur());

  const ids = await page.evaluate(() => {
    const find = t => Object.keys(doc.nodes).find(id => plainOf(doc.nodes[id].text).trim() === t);
    const r = { P: find('PARENT'), C1: find('CHILDA'), C2: find('CHILDB'), Q: find('SIBQ') };
    return { ...r, c1parent: parentOf(r.C1), c2parent: parentOf(r.C2), qparent: parentOf(r.Q) };
  });
  ok(ids.c1parent === ids.P && ids.c2parent === ids.P, 'structure: CHILDA/CHILDB are children of PARENT');
  ok(ids.qparent !== ids.P, 'structure: SIBQ is a sibling of PARENT (not a child)');

  // Shift+↓ over the visible order: from PARENT it descends INTO its children
  const range = await page.evaluate(P => { selEnter(P); selExtend(1); selExtend(1); return selIds(); }, ids.P);
  ok(JSON.stringify(range) === JSON.stringify([ids.P, ids.C1, ids.C2]), `selection spans levels (parent+children): ${JSON.stringify(range.map(x=>({[ids.P]:'P',[ids.C1]:'C1',[ids.C2]:'C2'}[x]||x)))}`);

  // Shift+click wiring: focus PARENT, Shift+click CHILDB → same cross-level range
  await page.evaluate(() => selClear());
  await page.click(`.item[data-id="${ids.P}"] .content`);
  await page.keyboard.down('Shift');
  await page.click(`.item[data-id="${ids.C2}"] .content`);
  await page.keyboard.up('Shift');
  await sleep(150);
  const clickRange = await page.evaluate(() => selIds());
  ok(JSON.stringify(clickRange) === JSON.stringify([ids.P, ids.C1, ids.C2]), 'Shift+click selects the cross-level range');

  // bulk complete (Ctrl+Enter) marks all selected done
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
  await sleep(200);
  const done = await page.evaluate(i => [i.P, i.C1, i.C2].map(id => !!doc.nodes[id].done), ids);
  ok(done.every(Boolean), 'Ctrl+Enter completes every selected item (parent + children)');

  // bulk delete of a parent+child selection removes the whole subtree, keeps the sibling
  await page.evaluate(P => { selEnter(P); selExtend(1); }, ids.P);   // PARENT + CHILDA
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
  await sleep(300);
  const after = await page.evaluate(i => ({ P: !!doc.nodes[i.P], C1: !!doc.nodes[i.C1], C2: !!doc.nodes[i.C2], Q: !!doc.nodes[i.Q] }), ids);
  ok(!after.P && !after.C1 && !after.C2 && after.Q, `deleting parent+child removes the subtree, keeps the sibling (${JSON.stringify(after)})`);

  await browser.close();
  console.log(fl ? `\n${fl} MULTISELECT TESTS FAILING` : '\nMULTISELECT TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
