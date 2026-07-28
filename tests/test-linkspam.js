/* Typing a [[wiki link]] must NOT create a page for every prefix while typing (auto-closed brackets
   make the link "complete" at each keystroke). Pages are created only when the link is finalised
   (caret leaves the line). Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const titles = page => page.evaluate(() => pagesOf().map(id => plainOf(N(id).text).trim()));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(400);

  await page.evaluate(() => document.querySelector('.tree .item .content').focus());
  // type the link in chunks with pauses > the commit debounce, so a naive impl commits partials
  for (const chunk of ['[[SO', 'TA', '-Apps']) {
    await page.keyboard.type(chunk, { delay: 20 });
    await sleep(700);
  }

  // still editing: no prefix pages should exist yet
  const during = await titles(page);
  const junk = during.filter(t => ['SO', 'SOTA', 'SOTA-'].includes(t));
  assert(junk.length === 0, `no prefix pages created while typing (found: ${JSON.stringify(junk)})`);

  // leave the line → the link finalises
  await page.evaluate(() => document.activeElement.blur());
  await sleep(800);

  const after = await titles(page);
  assert(after.filter(t => t === 'SOTA-Apps').length === 1, 'exactly one "SOTA-Apps" page after blur');
  assert(!after.some(t => ['SO', 'SOTA', 'SOTA-'].includes(t)), `still no prefix pages after blur (${JSON.stringify(after)})`);

  await browser.close();
  console.log(failures ? `\n${failures} LINK-SPAM TESTS FAILING` : '\nLINK-SPAM TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
