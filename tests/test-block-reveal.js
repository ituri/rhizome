/* Block-marker reveal (Roam/Logseq-style source editing): focusing a h1/h2/h3/quote line
   reveals its "# / ## / ### / > " marker; editing the marker re-formats on leaving the line;
   deleting it demotes to a bullet. Markers are view-only — node.text never stores them.
   Also: default-colour highlights reveal as ==…== and round-trip. Fresh server on 3211. */
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
  await page.waitForSelector('.tree .item .content');
  await sleep(400);
  const state = id => page.evaluate(id => ({ text: N(id).text, fmt: N(id).format || 'bullet' }), id);
  const focus = id => page.evaluate(id => document.querySelector(`.item[data-id="${id}"] .content`).focus(), id);
  const domOf = id => page.evaluate(id => document.querySelector(`.item[data-id="${id}"] .content`).textContent, id);
  const blur = () => page.evaluate(() => document.activeElement?.blur());

  const h2 = await page.evaluate(() => { const id = opNewAt('root', 0); N(id).text = 'Meine Überschrift'; N(id).format = 'h2'; markDirty(); renderPage(); return id; });
  await sleep(300);

  await focus(h2); await sleep(400);
  ok(await domOf(h2) === '## Meine Überschrift', 'focusing a h2 reveals its "## " marker');
  await blur(); await sleep(400);
  let s = await state(h2);
  ok(s.fmt === 'h2' && s.text === 'Meine Überschrift', `an untouched heading survives focus+blur (${JSON.stringify(s)})`);

  // promote ## → ### by typing a '#', pausing past the commit debounce, then leaving
  await focus(h2); await sleep(250);
  await page.keyboard.press('Home'); await page.keyboard.type('#');
  await sleep(700);
  ok(await domOf(h2) === '### Meine Überschrift', 'mid-edit redecorate keeps the edited marker');
  await blur(); await sleep(500);
  s = await state(h2);
  ok(s.fmt === 'h3' && s.text === 'Meine Überschrift', `editing the marker re-formats on blur, text stays clean (${JSON.stringify(s)})`);

  // deleting the marker demotes to a bullet
  await focus(h2); await sleep(250);
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Delete');
  await sleep(700); await blur(); await sleep(500);
  s = await state(h2);
  ok(s.fmt === 'bullet' && s.text === 'Meine Überschrift', `deleting the marker demotes to a bullet (${JSON.stringify(s)})`);

  // fast blur (before the debounce) formats through the commit path
  await focus(h2); await sleep(250);
  await page.keyboard.press('Home'); await page.keyboard.type('## ');
  await sleep(120); await blur(); await sleep(700);
  s = await state(h2);
  ok(s.fmt === 'h2' && s.text === 'Meine Überschrift', `a marker typed just before blur still formats (${JSON.stringify(s)})`);

  // quote marker reveals too
  const q = await page.evaluate(() => { const id = opNewAt('root', 0); N(id).text = 'Zitat'; N(id).format = 'quote'; markDirty(); renderPage(); return id; });
  await sleep(250);
  await focus(q); await sleep(300);
  ok(await domOf(q) === '> Zitat', 'focusing a quote reveals "> "');
  await blur(); await sleep(400);
  s = await state(q);
  ok(s.fmt === 'quote' && s.text === 'Zitat', `quote survives untouched (${JSON.stringify(s)})`);

  // highlights: yellow reveals as ==…==, coloured ones keep their span
  const hl = await page.evaluate(() => { const id = opNewAt('root', 0); N(id).text = 'mit <span class="hl-yellow">gelb</span> und <span class="hl-green">gruen</span>'; markDirty(); renderPage(); return id; });
  await sleep(250);
  await focus(hl); await sleep(300);
  ok(await domOf(hl) === 'mit ==gelb== und gruen', `highlight reveal: yellow as ==…==, green untouched (${await domOf(hl)})`);
  await blur(); await sleep(500);
  s = await state(hl);
  ok(/<span class="hl-yellow">gelb<\/span>/.test(s.text) && /<span class="hl-green">gruen<\/span>/.test(s.text),
    `highlight round-trip keeps both spans (${s.text})`);

  await browser.close();
  console.log(fl ? `\n${fl} BLOCK-REVEAL TESTS FAILING` : '\nBLOCK-REVEAL TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
