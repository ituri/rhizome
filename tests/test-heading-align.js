/* Headings (h1/h2/h3): the bullet dot must sit on the centre of the heading's first text line
   (bullet-box height = content first-line box). Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
  await page.keyboard.type('Heading', { delay: 8 });
  await sleep(300);
  const id = await page.evaluate(() => document.querySelector('.tree .item').dataset.id);

  const measure = () => page.evaluate(() => {
    const item = document.querySelector('.tree .item');
    const dot = item.querySelector('.bullet .dot');
    const content = item.querySelector('.content');
    const dr = dot.getBoundingClientRect(), cr = content.getBoundingClientRect();
    const cs = getComputedStyle(content);
    const lh = parseFloat(cs.lineHeight), pad = parseFloat(cs.paddingTop);
    const dotCenter = dr.top + dr.height / 2;
    const firstLineCenter = cr.top + pad + lh / 2;
    return { diff: Math.round((dotCenter - firstLineCenter) * 10) / 10 };
  });

  for (const fmt of ['h1', 'h2', 'h3']) {
    await page.evaluate((id, fmt) => { doc.nodes[id].format = fmt; markDirty(); renderPage(); }, id, fmt);
    await sleep(150);
    const { diff } = await measure();
    assert(Math.abs(diff) <= 2, `${fmt}: dot centred on the first line (off by ${diff}px)`);
  }

  await browser.close();
  console.log(failures ? `\n${failures} HEADING-ALIGN TESTS FAILING` : '\nHEADING-ALIGN TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
