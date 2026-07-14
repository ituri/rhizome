/* Navigation & caret-memory tests. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

const caretOffset = () => `(() => {
  const sel = getSelection();
  if (!sel.rangeCount) return -1;
  const el = document.activeElement;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
})()`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  // build a known item with children to zoom into
  const ids = await page.evaluate(() => {
    const a = makeNode('alphabet soup');           // 13 chars
    insertAt('root', 0, a);
    insertAt(a, 0, makeNode('child one'));
    insertAt(a, 1, makeNode('child two'));
    renderPage();
    return { a };
  });

  /* ---- 1. Alt+→ into a bullet, Alt+← back, caret restored ---- */
  await page.evaluate(id => { focusItem(id, 'text', 0); }, ids.a);
  // put caret at offset 5 ("alpha|bet soup")
  await page.evaluate(id => { setCaretOffset(document.querySelector(`.item[data-id="${id}"] .content`), 5); }, ids.a);
  let off = await page.evaluate(caretOffset());
  assert(off === 5, `caret set to offset 5 before zoom (got ${off})`);

  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Alt');
  await sleep(350);
  const zoomState = await page.evaluate(caretOffset());
  const inTitle = await page.evaluate(() => document.activeElement === document.querySelector('#zoom-title'));
  assert(inTitle, 'after zoom-in, focus is on the zoomed item title');
  assert(zoomState === 5, `zoom-in carries the caret offset into the title (got ${zoomState})`);

  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Alt');
  await sleep(350);
  const backState = await page.evaluate(() => ({
    onItem: editableCtx(document.activeElement)?.id,
    text: document.activeElement.textContent,
  }));
  const backOff = await page.evaluate(caretOffset());
  assert(backState.onItem === ids.a && backState.text === 'alphabet soup',
    `zoom-out lands back on the original item (${backState.text})`);
  assert(backOff === 5, `zoom-out restores the exact caret offset (got ${backOff})`);

  /* ---- 2. deeper: zoom in two levels, climb back out restoring each ---- */
  // zoom into A, then into "child two", then climb back
  await page.evaluate(id => { location.hash = '#/n/' + id; }, ids.a);
  await sleep(300);
  const childTwo = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .item')].find(e => e.querySelector('.content').textContent === 'child two').dataset.id);
  await page.evaluate(id => { setCaretOffset(document.querySelector(`.item[data-id="${id}"] .content`), 6); }, childTwo); // "child |two"
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Alt');
  await sleep(300);
  assert(await page.evaluate(() => document.querySelector('#zoom-title').textContent) === 'child two', 'zoomed two levels deep');
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Alt');
  await sleep(300);
  let ok = await page.evaluate(id => editableCtx(document.activeElement)?.id === id, childTwo);
  const o2 = await page.evaluate(caretOffset());
  assert(ok && o2 === 6, `climbing out restores caret on child two at offset 6 (got id-match, offset ${o2})`);

  /* ---- 3. click bullet to zoom, then browser Back restores focus ---- */
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(300);
  await page.evaluate(id => { setCaretOffset(document.querySelector(`.item[data-id="${id}"] .content`), 3); }, ids.a);
  await page.evaluate(id => {
    const b = document.querySelector(`.item[data-id="${id}"] .bullet`);
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.x + 6, clientY: r.y + 6, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  }, ids.a);
  await sleep(300);
  assert(await page.evaluate(() => document.querySelector('#zoom-title').textContent) === 'alphabet soup', 'clicking bullet zooms in');
  await page.goBack();
  await sleep(350);
  ok = await page.evaluate(id => editableCtx(document.activeElement)?.id === id, ids.a);
  assert(ok, 'browser Back restores focus to the item');

  /* ---- 4. search shows grouped results; Esc returns to the editable outline ---- */
  await page.evaluate(() => setSearch('child'));
  await sleep(250);
  ok = await page.evaluate(() => !!document.querySelector('.search-results') &&
    [...document.querySelectorAll('.search-results .ref-row')].some(r => /child/.test(r.textContent)));
  assert(ok, 'search renders whole-outline results grouped by page'); // rhizome
  await page.evaluate(() => document.querySelector('#search').focus());
  await page.keyboard.press('Escape');
  await sleep(250);
  ok = await page.evaluate(() => document.querySelector('#search').value === '' &&
    !document.querySelector('.search-results') &&
    document.querySelectorAll('.tree .item .content').length > 0);
  assert(ok, 'Esc clears the search and returns to the editable outline'); // rhizome

  /* ---- 5. ArrowDown from zoom title enters the first child ---- */
  await page.evaluate(id => { location.hash = '#/n/' + id; }, ids.a);
  await sleep(300);
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await page.keyboard.press('ArrowDown');
  await sleep(150);
  ok = await page.evaluate(() => editableCtx(document.activeElement)?.field === 'text' &&
    document.activeElement.textContent === 'child one');
  assert(ok, 'ArrowDown from the zoomed title moves into the first child');

  /* ---- 6. ArrowUp from first child returns to the title ---- */
  await page.keyboard.press('ArrowUp');
  await sleep(150);
  ok = await page.evaluate(() => document.activeElement === document.querySelector('#zoom-title'));
  assert(ok, 'ArrowUp from the first child returns to the title');

  /* ---- 7. smooth zoom: View Transitions used, then cleaned up ---- */
  const vtSupported = await page.evaluate(() => typeof document.startViewTransition === 'function');
  if (vtSupported) {
    await page.evaluate(() => {
      window.__tendrilForceAnim = true;   // override the webdriver instant-nav guard
      window.__vtCalls = 0;
      const orig = document.startViewTransition.bind(document);
      document.startViewTransition = cb => { window.__vtCalls++; return orig(cb); };
      location.hash = '#/outline';
    });
    await sleep(400);
    await page.evaluate(id => { location.hash = '#/n/' + id; }, ids.a);
    await sleep(600);
    const vt = await page.evaluate(() => ({
      calls: window.__vtCalls,
      leftover: document.querySelectorAll('[style*="view-transition-name"]').length,
      title: document.querySelector('#zoom-title').textContent,
    }));
    assert(vt.calls >= 1, `zoom uses the View Transitions API (${vt.calls} call)`);
    assert(vt.leftover === 0, `no leftover view-transition-name after the morph (${vt.leftover})`);
    assert(vt.title === 'alphabet soup', 'morph still lands on the right view');
  } else {
    console.log('  --  View Transitions API not available in this Chrome; skipped morph checks');
  }

  /* ---- 8. animations toggle off → no view transition, instant + caret memory ---- */
  await page.evaluate(() => { window.__tendrilForceAnim = false; location.hash = '#/outline'; });
  await sleep(400);
  await page.evaluate(() => { settings.animations = false; });
  // clean state: focus `a` at HOME, zoom in, confirm no VT, zoom out, confirm caret back on a
  await page.evaluate(id => { focusItem(id, 'text', 4); }, ids.a);
  await page.evaluate(() => { window.__vtCalls = 0; });
  await page.evaluate(id => { location.hash = '#/n/' + id; }, ids.a);
  await sleep(300);
  ok = await page.evaluate(() => (window.__vtCalls || 0) === 0 &&
    document.querySelector('#zoom-title').textContent === 'alphabet soup');
  assert(ok, 'animations toggle off skips the transition (instant zoom)');
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Alt');
  await sleep(250);
  const off8 = await page.evaluate(() => ({ id: editableCtx(document.activeElement)?.id, zoom: state.zoom }));
  assert(off8.id === ids.a, `caret memory still works with animations off (zoom=${off8.zoom})`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL NAV TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
