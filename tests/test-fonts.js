/* Self-contained fonts: the app must load NO external fonts. Verifies no request goes to Google
   Fonts, the local /fonts/fonts.css + a woff2 are served, and the UI font resolves to Inter.
   Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1200, height: 800 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });

  const external = [];
  const fontReqs = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.origin !== API && !/^data:|^blob:/.test(r.url())) external.push(u.host);
    if (/\/fonts\//.test(u.pathname) || /\.woff2?($|\?)/.test(u.pathname)) fontReqs.push(u.pathname);
  });

  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(400);

  const googleHits = external.filter(h => /googleapis|gstatic/.test(h));
  ok(googleHits.length === 0, `no requests to Google Fonts (external hosts seen: ${JSON.stringify([...new Set(external)])})`);

  ok(fontReqs.some(p => p === '/fonts/fonts.css'), 'local /fonts/fonts.css was requested');
  ok(fontReqs.some(p => /^\/fonts\/inter-.*\.woff2$/.test(p)), `a self-hosted Inter woff2 was fetched (${JSON.stringify(fontReqs.filter(p => /woff2/.test(p)).slice(0, 3))})`);

  // fonts.css + a woff2 respond 200 from our own origin
  const cssStatus = await page.evaluate(async () => (await fetch('/fonts/fonts.css')).status);
  ok(cssStatus === 200, 'fonts.css served 200 by the app server');
  const woffStatus = await page.evaluate(async () => (await fetch('/fonts/inter-400-normal-latin.woff2')).status);
  ok(woffStatus === 200, 'a woff2 file is served 200 by the app server');

  // the effective UI font is Inter (self-hosted), and it actually loaded
  const fam = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  ok(/^inter/i.test(fam.trim()), `body font-family resolves to Inter first (${fam})`);
  const loaded = await page.evaluate(() => document.fonts.check('16px Inter'));
  ok(loaded === true, 'Inter is loaded and available (document.fonts.check)');

  // no leftover Google <link> in the shipped HTML
  const hasGoogleLink = await page.evaluate(() => !!document.querySelector('link[href*="googleapis"], link[href*="gstatic"]'));
  ok(!hasGoogleLink, 'no Google Fonts <link> remains in the document');

  await browser.close();
  console.log(fl ? `\n${fl} FONT TESTS FAILING` : '\nFONT TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
