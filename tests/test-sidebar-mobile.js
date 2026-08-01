/* Mobile sidebar: the overlay must CLOSE when you navigate from it (roadmap bug: picking a
   page left the overlay covering the page). Non-navigating controls (pin) keep it open.
   Narrow viewport → the toggle enters sidebar-mobile overlay mode. Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 480, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);

  const openMobile = async () => {
    await page.evaluate(() => { if (!document.body.classList.contains('sidebar-open')) document.querySelector('#btn-sidebar').click(); });
    await sleep(150);
  };

  await openMobile();
  let cls = await page.evaluate(() => [document.body.classList.contains('sidebar-open'), document.body.classList.contains('sidebar-mobile')]);
  ok(cls[0] && cls[1], `narrow viewport opens the mobile overlay (open=${cls[0]}, mobile=${cls[1]})`);

  // navigating from the sidebar closes the overlay
  await page.evaluate(() => document.querySelector('#side-pages-link').click());
  await sleep(300);
  cls = await page.evaluate(() => [location.hash, document.body.classList.contains('sidebar-open')]);
  ok(cls[0].startsWith('#/pages'), `sidebar nav link navigated (${cls[0]})`);
  ok(!cls[1], 'the overlay closed after navigating');

  // a page row link closes it too
  await openMobile();
  const hadPage = await page.evaluate(() => {
    const a = document.querySelector('.side-page a');
    if (!a) return false;
    a.click();
    return true;
  });
  await sleep(300);
  if (hadPage) {
    ok(await page.evaluate(() => !document.body.classList.contains('sidebar-open')), 'picking a page closes the overlay');
  } else {
    ok(false, 'no page row in the sidebar to click');
  }

  // a non-navigating control (pin) keeps the overlay open
  await openMobile();
  const pinned = await page.evaluate(() => {
    const p = document.querySelector('.side-page .side-pin');
    if (!p) return false;
    p.click();
    return true;
  });
  await sleep(200);
  ok(pinned && await page.evaluate(() => document.body.classList.contains('sidebar-open')),
    'pinning a page does NOT close the overlay');

  await browser.close();
  console.log(fl ? `\n${fl} SIDEBAR-MOBILE TESTS FAILING` : '\nSIDEBAR-MOBILE TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
