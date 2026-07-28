/* Sidebar Pages: each row shows a compact relative last-edited time (now / 5min / 4h / 9d …). */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);
  await page.evaluate(() => document.querySelector('.tree .item .content').focus());
  await page.keyboard.type('A fresh page', { delay: 8 });
  await sleep(400);
  await page.evaluate(() => { renderSidebar(); });
  const r = await page.evaluate(() => {
    const times = [...document.querySelectorAll('#side-pages .side-time')].map(s => s.textContent);
    return { count: times.length, times };
  });
  assert(r.count > 0, `sidebar rows carry a .side-time span (${r.count} rows)`);
  const re = /^(now|\d+(min|h|d|w|mo|y))$/;
  assert(r.times.every(t => re.test(t)), `all times are compact relative format (${JSON.stringify(r.times)})`);
  assert(r.times.includes('now'), 'the just-edited page shows "now"');
  await browser.close();
  console.log(failures ? `\n${failures} FAIL` : '\nSIDEBAR-TIME TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
