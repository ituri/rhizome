/* Map view: the left-sidebar "Map" item shows every geocoded page as a clickable Leaflet marker.
   Handles both storage styles — a page titled with raw coords, and an address-titled page whose
   first bullet holds the coords. Clicking a marker navigates to that page. Fresh server on 3211. */
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

  // two location pages: one titled with coordinates, one titled with an address + a coords bullet.
  const ids = await page.evaluate(() => {
    snapshot();
    // A: coord-titled page
    const a = getOrCreatePage('52.5200, 13.4050');
    // B: address-titled page with the coords in its first bullet
    const b = getOrCreatePage('Marienplatz, München');
    insertAt(b, 0, makeNode(escHtml('48.1371, 11.5754')));
    markDirty(); renderPage();
    return { a, b };
  });
  await sleep(300);

  // the left sidebar carries a Map nav link pointing at #/map
  const link = await page.evaluate(() => { const a = document.querySelector('#side-map'); return a ? { href: a.getAttribute('href'), label: a.textContent.trim() } : null; });
  ok(link && link.href === '#/map' && /Map/.test(link.label), `sidebar has a Map nav link → #/map (${JSON.stringify(link)})`);

  // navigate to the Map view
  await page.evaluate(() => { location.hash = '#/map'; });
  await page.waitForSelector('.map-view .map-canvas', { timeout: 5000 });
  await page.waitForSelector('.map-canvas.leaflet-container .leaflet-interactive', { timeout: 8000 });
  await sleep(500);

  ok(await page.$('#side-map.current') !== null, 'sidebar Map link is highlighted as current');
  ok((await page.title()) === 'Map — Rhizome', 'document title is "Map — Rhizome"');

  const markerCount = await page.evaluate(() => document.querySelectorAll('.map-canvas .leaflet-interactive').length);
  ok(markerCount === 2, `both geocoded pages get a marker (got ${markerCount})`);

  // click the first marker → navigates to a page
  await page.evaluate(() => document.querySelector('.map-canvas .leaflet-interactive').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(300);
  const wentToPage = await page.evaluate(i => location.hash === '#/n/' + i.a || location.hash === '#/n/' + i.b, ids);
  ok(wentToPage, `clicking a marker navigates to its page (hash=${await page.evaluate(() => location.hash)})`);

  await browser.close();
  console.log(fl ? `\n${fl} MAP TESTS FAILING` : '\nMAP TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
