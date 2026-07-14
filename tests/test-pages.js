/* Rhizome page layer: find-or-create via Ctrl+K and [[, top-level page
   convention, Roam day titles, page-scoped breadcrumbs. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  /* ---- 1. Ctrl+K offers "Create page" for an unknown title ---- */
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await sleep(150);
  await page.type('#jump-input', 'Gartenplanung');
  await sleep(250);
  const createRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.jump-row')];
    const create = rows.find(r => r.classList.contains('jump-create'));
    return create ? create.textContent : null;
  });
  assert(createRow && /Create page/.test(createRow) && /Gartenplanung/.test(createRow),
    `unknown title offers a create row ("${createRow}")`);

  /* ---- 2. picking it creates a top-level page and zooms in ---- */
  await page.evaluate(() => { document.querySelector('.jump-row.jump-create').click(); });
  await sleep(500);
  let info = await page.evaluate(() => {
    const id = pagesOf().find(p => plainOf(N(p).text).trim() === 'Gartenplanung');
    return id ? {
      topLevel: kidsOf(ROOT).includes(id),
      zoomed: state.zoom === id,
      title: document.querySelector('#zoom-title').textContent.trim(),
    } : null;
  });
  assert(info && info.topLevel, 'created page is a direct child of the root');
  assert(info && info.zoomed && info.title === 'Gartenplanung', 'jump zooms into the fresh page');

  /* ---- 3. Ctrl+K with an existing exact title shows no create row ---- */
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await sleep(150);
  await page.type('#jump-input', 'gartenplanung'); // case-insensitive match
  await sleep(250);
  const dup = await page.evaluate(() => ({
    create: !!document.querySelector('.jump-row.jump-create'),
    hit: [...document.querySelectorAll('.jump-row')].some(r => /Gartenplanung/.test(r.textContent)),
  }));
  assert(!dup.create && dup.hit, 'existing title matches instead of offering a duplicate');
  await page.keyboard.press('Escape');
  await sleep(150);

  /* ---- 4. [[ create makes a top-level page even from a nested zoom ---- */
  await page.evaluate(() => {
    // build a nested spot inside the page and zoom there
    const pid = pagesOf().find(p => plainOf(N(p).text).trim() === 'Gartenplanung');
    const kid = makeNode('Beete');
    insertAt(pid, 0, kid);
    window.__kid = kid;
    zoomTo(kid);
  });
  await sleep(400);
  await page.evaluate(() => { const id = opNewAt(window.__kid, 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('siehe [[Kompost');
  await sleep(350);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.caret-pop .pop-item')];
    items.find(b => /Create/.test(b.textContent)).click();
  });
  await sleep(500);
  info = await page.evaluate(() => {
    const id = Object.values(doc.nodes).find(n => plainOf(n.text).trim() === 'Kompost')?.id;
    return id ? { topLevel: kidsOf(ROOT).includes(id), linked: Object.values(doc.nodes).some(n => n.text?.includes('#/n/' + id)) } : null;
  });
  assert(info && info.topLevel, '[[ create places the new page at the top level');
  assert(info && info.linked, '[[ create links to the new page');

  /* ---- 5. [[ with the existing title reuses the page (no duplicate) ---- */
  await page.evaluate(() => { const id = opNewAt(window.__kid, 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('mehr [[Kompost');
  await sleep(350);
  const picked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.caret-pop .pop-item')];
    const hit = items.find(b => !/Create/.test(b.textContent) && /Kompost/.test(b.textContent));
    if (hit) { hit.click(); return 'existing'; }
    items.find(b => /Create/.test(b.textContent))?.click(); return 'create';
  });
  await sleep(500);
  const kompostCount = await page.evaluate(() =>
    Object.values(doc.nodes).filter(n => plainOf(n.text).trim() === 'Kompost').length);
  assert(kompostCount === 1, `no duplicate page for the same title (picked ${picked}, count ${kompostCount})`);

  /* ---- 6. breadcrumbs start at the page, no Home crumb ---- */
  const crumbs = await page.evaluate(() => document.querySelector('#crumbs').textContent);
  assert(/Gartenplanung/.test(crumbs) && !/Home/.test(crumbs),
    `crumbs start at the containing page ("${crumbs}")`);
  const pageCrumbs = await page.evaluate(() => {
    const pid = pagesOf().find(p => plainOf(N(p).text).trim() === 'Gartenplanung');
    zoomTo(pid);
    return new Promise(r => setTimeout(() => r(document.querySelector('#crumbs').style.display), 400));
  });
  assert(pageCrumbs === 'none', 'a top-level page shows no breadcrumb row');

  /* ---- 7. day pages get Roam-style titles ---- */
  const dayTitle = await page.evaluate(() => {
    gotoDate(todayStr());
    return new Promise(r => setTimeout(() => r(document.querySelector('#zoom-title').textContent.trim()), 400));
  });
  assert(/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/.test(dayTitle),
    `today's page is Roam-titled ("${dayTitle}")`);
  const ord = await page.evaluate(() => [roamDateLabel('2026-07-01'), roamDateLabel('2026-07-02'), roamDateLabel('2026-07-03'), roamDateLabel('2026-07-11'), roamDateLabel('2026-07-13')]);
  assert(ord[0] === 'July 1st, 2026' && ord[1] === 'July 2nd, 2026' && ord[2] === 'July 3rd, 2026'
    && ord[3] === 'July 11th, 2026' && ord[4] === 'July 13th, 2026', 'ordinal suffixes (1st/2nd/3rd/11th/13th)');

  /* ---- 8. persistence: everything survives a reload ---- */
  await sleep(900);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 5000 }).catch(() => {});
  await sleep(600);
  const persisted = await page.evaluate(() => ({
    garten: pagesOf().some(p => plainOf(N(p).text).trim() === 'Gartenplanung'),
    kompost: pagesOf().some(p => plainOf(N(p).text).trim() === 'Kompost'),
  }));
  assert(persisted.garten && persisted.kompost, 'created pages survive a reload');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGES TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
