/* Sidebar hover peek (Roam-style): hovering the toggle floats the sidebar over the page,
   moving onto the panel keeps it open and usable, leaving folds it, and a click docks it
   for good (sidebar-open, no peek). Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1300, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });
  // headless Chromium reports no hover capability; the app gates the peek on (hover:hover)
  await page.evaluateOnNewDocument(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = q => /hover:\s*hover/.test(q)
      ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} }
      : orig(q);
  });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);

  // make sure the sidebar starts undocked
  await page.evaluate(() => {
    if (document.body.classList.contains('sidebar-open')) document.querySelector('#btn-sidebar').click();
  });
  await sleep(100);

  // the Home button now lives on the right, between the search box and the calendar icon
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector('.topbar-right').children].map(e => e.id || e.className.split(' ')[0]);
    return { kids, leftHome: !!document.querySelector('.topbar-left #btn-home') };
  });
  ok(!order.leftHome, 'Home button no longer in the left topbar');
  ok(order.kids.indexOf('searchbox') < order.kids.indexOf('btn-home')
    && order.kids.indexOf('btn-home') < order.kids.indexOf('btn-calendar'),
  `Home sits between search and calendar (${order.kids.join(' · ')})`);

  // hover the toggle → peek opens as an overlay (no layout dock)
  await page.hover('#btn-sidebar');
  await sleep(120);
  let cls = await page.evaluate(() => [document.body.classList.contains('sidebar-peek'), document.body.classList.contains('sidebar-open')]);
  ok(cls[0] && !cls[1], `hovering the toggle peeks the sidebar (peek=${cls[0]}, open=${cls[1]})`);
  const overlay = await page.evaluate(() => getComputedStyle(document.querySelector('#sidebar')).position);
  ok(overlay === 'fixed', `peeked sidebar floats over the page (position: ${overlay})`);

  // move onto the panel → stays open, and its links are clickable
  const box = await page.evaluate(() => { const r = document.querySelector('#sidebar').getBoundingClientRect(); return { x: r.left + 60, y: r.top + 60 }; });
  await page.mouse.move(box.x, box.y);
  await sleep(400);
  ok(await page.evaluate(() => document.body.classList.contains('sidebar-peek')), 'panel keeps the peek open while hovered');
  const labelShown = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#side-map span')).display !== 'none');
  ok(labelShown, 'nav labels (Map …) are visible while peeked');
  await page.click('#side-pages-link');
  await sleep(300);
  ok(await page.evaluate(() => location.hash.startsWith('#/pages')), `a peeked sidebar is fully usable (navigated to ${await page.evaluate(() => location.hash)})`);

  // leave the panel → slides out after the grace period
  await page.mouse.move(900, 500);
  await sleep(800);
  ok(await page.evaluate(() => !document.body.classList.contains('sidebar-peek')), 'leaving the panel folds the peek');

  // Roam's edge summon: touching the left screen edge peeks it too
  await page.mouse.move(3, 450);
  await sleep(150);
  ok(await page.evaluate(() => document.body.classList.contains('sidebar-peek')), 'hovering the left screen edge peeks the sidebar');
  await page.mouse.move(900, 500);
  await sleep(800);
  ok(await page.evaluate(() => !document.body.classList.contains('sidebar-peek')), 'leaving the edge folds it again');

  // click → docked full-height sidebar, peek gone
  await page.click('#btn-sidebar');
  await sleep(200);
  cls = await page.evaluate(() => [document.body.classList.contains('sidebar-open'), document.body.classList.contains('sidebar-peek')]);
  ok(cls[0] && !cls[1], `clicking the toggle docks the sidebar (open=${cls[0]}, peek=${cls[1]})`);

  // docked (Roam layout): full viewport height, topbar shifted right, toggle moves inside
  const dock = await page.evaluate(() => {
    const sb = getComputedStyle(document.querySelector('#sidebar'));
    return {
      pos: sb.position, top: sb.top,
      topbarShift: getComputedStyle(document.querySelector('.topbar')).marginLeft,
      topToggle: getComputedStyle(document.querySelector('#btn-sidebar')).display,
      sideToggle: getComputedStyle(document.querySelector('#side-collapse')).display,
    };
  });
  ok(dock.pos === 'fixed' && dock.top === '0px', `docked sidebar owns the full left height (${dock.pos}, top ${dock.top})`);
  ok(dock.topbarShift === '252px', `topbar starts right of the sidebar (margin-left ${dock.topbarShift})`);
  ok(dock.topToggle === 'none' && dock.sideToggle !== 'none',
    `toggle lives in the sidebar's top row while docked (topbar: ${dock.topToggle}, sidebar: ${dock.sideToggle})`);

  // the in-sidebar toggle collapses it again
  await page.click('#side-collapse');
  await sleep(200);
  ok(await page.evaluate(() => !document.body.classList.contains('sidebar-open')), 'the in-sidebar toggle collapses the docked sidebar');

  await browser.close();
  console.log(fl ? `\n${fl} PEEK TESTS FAILING` : '\nPEEK TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
