/* Collapse animation gating, header-to-bullet nav, calendar button,
   explicit date hint, discoverability placeholder. */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); // user-like
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  /* ---- 1. animations are NOT gated by reduced-motion (the bug we fixed) ---- */
  let noAnim = await page.evaluate(() => document.documentElement.classList.contains('no-anim'));
  assert(!noAnim, 'with reduced-motion on but the setting on, animations are NOT disabled');
  const transOk = await page.evaluate(() => {
    // a real (non-0.01ms) transition is in effect on the collapse wrapper rule
    const probe = document.createElement('div');
    probe.className = 'children-anim';
    document.body.append(probe);
    const d = getComputedStyle(probe).transitionDuration;
    probe.remove();
    return parseFloat(d) > 0.05;
  });
  assert(transOk, 'collapse/expand transition has a real (animated) duration under reduced-motion');

  /* ---- 2. toggling animations off adds .no-anim and zeroes the transition ---- */
  await page.evaluate(() => { settings.animations = false; applyTheme(); });
  noAnim = await page.evaluate(() => document.documentElement.classList.contains('no-anim'));
  const transOff = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'children-anim';
    document.body.append(probe);
    const d = getComputedStyle(probe).transitionDuration;
    probe.remove();
    return parseFloat(d) < 0.01;
  });
  assert(noAnim && transOff, 'turning the toggle off disables transitions via .no-anim');
  await page.evaluate(() => { settings.animations = true; applyTheme(); });

  /* ---- 3. collapse still builds the animation wrapper and removes children ---- */
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const basics = els.find(e => e.querySelector(':scope > .row .content')?.textContent === 'The basics');
    window.__basics = basics.dataset.id;
    opToggleCollapse(window.__basics);
  });
  await sleep(450); // let the close animation finish + wrapper removal
  let collapsed = await page.evaluate(() => {
    const it = document.querySelector(`.item[data-id="${window.__basics}"]`);
    return it.classList.contains('collapsed') && !it.querySelector(':scope > .children-anim');
  });
  assert(collapsed, 'collapse hides children (wrapper removed after the animation)');
  await page.evaluate(() => opToggleCollapse(window.__basics));
  await sleep(450);
  let expanded = await page.evaluate(() => {
    const it = document.querySelector(`.item[data-id="${window.__basics}"]`);
    return !it.classList.contains('collapsed') && !!it.querySelector(':scope > .children-anim > .children .item');
  });
  assert(expanded, 'expand re-shows the children');

  /* ---- 4. ArrowDown off the header of an EMPTY page starts a bullet ---- */
  await page.evaluate(() => {
    const leaf = makeNode('a leaf page');   // no children
    insertAt('root', 0, leaf);
    renderPage();
    location.hash = '#/n/' + leaf;
  });
  await sleep(400);
  let before = await page.evaluate(() => kidsOf(state.zoom).length);
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await page.keyboard.press('ArrowDown');
  await sleep(250);
  let after = await page.evaluate(() => ({
    kids: kidsOf(state.zoom).length,
    focusedBullet: editableCtx(document.activeElement)?.field === 'text',
  }));
  assert(before === 0 && after.kids === 1 && after.focusedBullet,
    'ArrowDown on an empty page header creates a bullet and focuses it');

  /* ---- 5. ArrowDown from header WITH children still reaches the first child ---- */
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(350);
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const w = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('Welcome'));
    location.hash = '#/n/' + w.dataset.id;
  });
  await sleep(400);
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  let ok = await page.evaluate(() => editableCtx(document.activeElement)?.field === 'text' &&
    document.activeElement.textContent.includes('infinite outline'));
  assert(ok, 'ArrowDown from a populated header still reaches the first bullet');
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(350);

  /* ---- 6. calendar header button opens the calendar ---- */
  ok = await page.evaluate(() => !!document.querySelector('#btn-calendar'));
  assert(ok, 'calendar button exists in the header');
  await page.click('#btn-calendar');
  await sleep(450);
  ok = await page.evaluate(() => doc.nodes[state.zoom]?.cal === 'day' && !document.querySelector('#cal-strip').hidden);
  assert(ok, 'header calendar button jumps to today\'s calendar page (with the day strip)');
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);

  /* ---- 7. date hint is explicit and clickable ---- */
  await page.evaluate(() => { const id = opNewAt('root', 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('finish the deck tomorrow');
  await sleep(300);
  const hint = await page.evaluate(() => {
    const h = document.querySelector('.date-hint');
    return h && !h.hidden ? { text: h.textContent, hasCal: !!h.querySelector('.dh-cal') } : null;
  });
  assert(hint && /Press/.test(hint.text) && /Tab/.test(hint.text) && /click here/.test(hint.text),
    'date hint reads "Press Tab or click here"');
  assert(hint.hasCal, 'date hint has a calendar icon to open the picker');
  // click the hint body to convert (not the calendar icon)
  await page.evaluate(() => {
    const h = document.querySelector('.date-hint');
    h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    h.querySelector('.dh-date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(550);
  ok = await page.evaluate(() => {
    const id = editableCtx(document.activeElement)?.id || [...document.querySelectorAll('.tree .item')].map(e => e.dataset.id).find(i => /<time/.test(doc.nodes[i].text));
    return Object.values(doc.nodes).some(n => /finish the deck/.test(plainOf(n.text)) && /<time datetime="/.test(n.text) && !/tomorrow/i.test(n.text));
  });
  assert(ok, 'clicking the date hint converts the phrase to a pill');

  /* ---- 8. empty focused bullet shows a discoverability placeholder ---- */
  await page.evaluate(() => { const id = opNewAt('root', 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  const ph = await page.evaluate(() => {
    const el = document.activeElement;
    return getComputedStyle(el, '::before').content;
  });
  assert(/menu|link|Type/.test(ph), `empty focused bullet shows a hint placeholder (${ph.slice(0, 40)})`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL UI TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
