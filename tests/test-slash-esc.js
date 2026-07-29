/* The slash menu (and the other caret popovers) close on Escape — as the top-priority key handler,
   so nothing else can swallow it. Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };
const open = p => p.evaluate(() => window.caretPopOpen());

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1200, height: 800 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);
  const focusClear = async () => {
    await page.evaluate(() => { const el = document.querySelector('.tree .item .content'); el.focus(); getSelection().selectAllChildren(el); });
    await page.keyboard.press('Backspace');
  };

  // slash menu: opens on "/", closes on Escape (element gone too)
  await focusClear();
  await page.keyboard.type('/', { delay: 20 });
  await sleep(200);
  ok(await open(page) === true, 'typing "/" opens the slash menu');
  ok(!!(await page.$('.caret-pop')), 'the slash popover is in the DOM');
  await page.keyboard.press('Escape');
  await sleep(150);
  ok(await open(page) === false, 'Escape closes the slash menu');
  ok(!(await page.$('.caret-pop')), 'the popover element is removed from the DOM');
  const stillFocused = await page.evaluate(() => !!document.activeElement?.classList?.contains('content'));
  ok(stillFocused, 'focus stays in the editor after Escape (only the menu closed)');

  // filtered slash query (no match) also closes on Escape
  await focusClear();
  await page.keyboard.type('/zzzq', { delay: 20 });
  await sleep(200);
  ok(await open(page) === true, 'slash menu stays open while filtering (even with no match)');
  await page.keyboard.press('Escape');
  await sleep(150);
  ok(await open(page) === false, 'Escape closes the slash menu while filtering');

  // tag autocomplete popover: same Escape behavior (shares the caret-pop path)
  await focusClear();
  await page.keyboard.type('#', { delay: 20 });
  await sleep(200);
  if (await open(page)) {
    await page.keyboard.press('Escape');
    await sleep(150);
    ok(await open(page) === false, 'Escape also closes the tag autocomplete popover');
  } else {
    ok(true, 'tag popover not offered here — skipped');
  }

  await browser.close();
  console.log(fl ? `\n${fl} SLASH-ESC TESTS FAILING` : '\nSLASH-ESC TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
