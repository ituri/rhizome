/* Rhizome PWA / offline test — drives the real app in headless Chrome.
   Proves: (1) the app is installable (manifest + icons + iOS metas), and
   (2) it cold-boots offline from the IndexedDB cache (SW serves the shell,
   app.js falls back to the cached /api/me + doc) showing your last content. */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else { console.log('FAIL  ' + msg); failures++; }
};

const readCachedDoc = page => page.evaluate(() => new Promise(res => {
  const r = indexedDB.open('rhizome', 1);
  r.onsuccess = () => {
    const t = r.result.transaction('kv', 'readonly').objectStore('kv').get('doc:default');
    t.onsuccess = () => res(t.result || null);
    t.onerror = () => res(null);
  };
  r.onerror = () => res(null);
}));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', e => { console.log('PAGEERROR: ' + e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });

  await page.goto(URL + '#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(400);

  // --- 1. installable: manifest + icons + iOS metas
  const manifestHref = await page.$eval('link[rel="manifest"]', el => el.getAttribute('href'));
  assert(manifestHref === '/manifest.webmanifest', 'a web app manifest is linked');
  const manifest = await page.evaluate(async h => (await fetch(h)).json(), manifestHref);
  assert(manifest.name === 'Rhizome' && manifest.display === 'standalone', 'manifest is standalone-installable');
  assert(Array.isArray(manifest.icons) && manifest.icons.some(i => i.sizes === '512x512') &&
         manifest.icons.some(i => (i.purpose || '').includes('maskable')), 'manifest ships 512px + maskable icons');
  const themeColor = await page.$eval('meta[name="theme-color"]', el => el.getAttribute('content')).catch(() => null);
  assert(!!themeColor, 'a theme-color is set');
  const appleIcon = await page.$eval('link[rel="apple-touch-icon"]', el => el.getAttribute('href')).catch(() => null);
  const appleCap = await page.$eval('meta[name="apple-mobile-web-app-capable"]', el => el.getAttribute('content')).catch(() => null);
  assert(!!appleIcon && appleCap === 'yes', 'iOS home-screen metas present (apple-touch-icon + capable)');
  const iconOk = await page.evaluate(async () => (await fetch('/icon-192.png')).ok);
  assert(iconOk, 'the PNG icon is served');

  // --- 2. service worker takes control (needed to serve the shell offline)
  await page.evaluate(() => navigator.serviceWorker.ready);
  for (let i = 0; i < 40 && !(await page.evaluate(() => !!navigator.serviceWorker.controller)); i++) await sleep(100);
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  assert(controlled, 'the service worker controls the page');

  // --- 3. make an edit and let it save (which caches the doc for offline boot)
  const MARK = 'pwaMarker' + Date.now();
  await page.click('.tree .item .content');
  await page.keyboard.press('End');
  await page.keyboard.type(' ' + MARK);
  await sleep(1500); // text commit + debounced save + doc cache write
  const cached = await readCachedDoc(page);
  const cachedHasMark = !!cached && JSON.stringify(cached.doc).includes(MARK);
  assert(cachedHasMark, 'the edited doc is cached in IndexedDB for offline boot');

  // --- 4. go offline and reload cold: the shell + content must come back
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const booted = await page.waitForSelector('.tree .item .content', { timeout: 10000 }).then(() => true).catch(() => false);
  assert(booted, 'the app cold-boots offline (SW served the shell, no network)');
  await sleep(300);
  const shownOffline = await page.evaluate(m => document.body.innerText.includes(m), MARK);
  assert(shownOffline, 'the last-synced content is shown while fully offline');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nPWA/OFFLINE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
