/* Sync popover: hovering the save-state chip shows the Roam-style status card
   (online state, pending local changes, doc version, last server change). Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1300, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });
  await page.evaluateOnNewDocument(() => {   // headless reports no hover capability
    const orig = window.matchMedia.bind(window);
    window.matchMedia = q => /hover:\s*hover/.test(q)
      ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} }
      : orig(q);
  });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(400);

  await page.hover('#save-state');
  await sleep(200);
  const popped = await page.evaluate(() => {
    const p = document.querySelector('.sync-pop');
    return p ? p.textContent : null;
  });
  ok(!!popped, 'hovering the save chip shows the sync popover');
  ok(/synced|Syncing/i.test(popped || ''), `popover carries a status headline (${(popped || '').slice(0, 40)}…)`);
  ok(/online|offline/.test(popped || ''), 'popover states online/offline');
  ok(/pending local change/.test(popped || ''), 'popover counts pending local changes');
  ok(/Last change in server/.test(popped || ''), 'popover shows the last server change');

  await page.mouse.move(400, 500);
  await sleep(150);
  ok(await page.evaluate(() => !document.querySelector('.sync-pop')), 'leaving the chip hides the popover');

  await browser.close();
  console.log(fl ? `\n${fl} SYNCPOP TESTS FAILING` : '\nSYNCPOP TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
