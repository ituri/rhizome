/* Setting "Show rhizome logo" toggles the .brand wordmark next to the sidebar toggle. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let f = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) f++; };
const visible = page => page.evaluate(() => { const b = document.querySelector('.brand'); return !!(b && b.offsetParent !== null); });
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1200, height: 800 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); f++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree', { timeout: 10000 }); await sleep(300);
  ok(await visible(page), 'logo shown by default');
  await page.evaluate(() => { settings.showLogo = false; applyTheme(); }); await sleep(100);
  ok(!(await visible(page)), 'logo hidden when showLogo = false');
  await page.evaluate(() => { settings.showLogo = true; applyTheme(); }); await sleep(100);
  ok(await visible(page), 'logo shown again when showLogo = true');
  await browser.close();
  console.log(f ? `\n${f} FAIL` : '\nLOGO TESTS PASSED'); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
