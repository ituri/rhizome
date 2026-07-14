/* Tendril end-to-end smoke test — drives the real app in headless Chrome. */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else { console.log('FAIL  ' + msg); failures++; }
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', e => { console.log('PAGEERROR: ' + e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);

  // --- 1. welcome doc seeded & rendered
  const count = await page.$$eval('.tree .item', els => els.length);
  assert(count >= 8, `welcome document rendered (${count} items visible)`);

  // --- 2. Enter at end of first item creates a new item (first child, since it has expanded children)
  await page.click('.tree > .item > .row > .content');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('My new task #urgent');
  await sleep(700); // text commit + live decoration
  let active = await page.evaluate(() => document.activeElement.textContent);
  assert(active.includes('My new task'), `typing lands in the new item ("${active}")`);
  const hasTag = await page.evaluate(() => !!document.activeElement.querySelector('.tag'));
  assert(hasTag, 'hashtag decorated live while editing');
  const caretAtEnd = await page.evaluate(() => {
    const sel = getSelection();
    const el = document.activeElement;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length === el.textContent.length;
  });
  assert(caretAtEnd, 'caret preserved at end after live redecoration');

  // --- 3. Enter again -> sibling; Tab indents under "My new task"
  await page.keyboard.press('Enter');
  await page.keyboard.type('child item');
  await sleep(100);
  await page.keyboard.press('Tab');
  await sleep(150);
  let parentText = await page.evaluate(() => {
    const item = document.activeElement.closest('.item');
    return item.parentElement.closest('.item')?.querySelector('.content')?.textContent ?? '(none)';
  });
  assert(parentText.includes('My new task'), `Tab indents under previous sibling ("${parentText}")`);
  const caretKept = await page.evaluate(() => document.activeElement.textContent === 'child item');
  assert(caretKept, 'focus stays in the item across indent');

  // --- 4. Shift+Tab outdents back
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  await sleep(150);
  parentText = await page.evaluate(() => {
    const item = document.activeElement.closest('.item');
    return item.parentElement.closest('.item')?.querySelector('.content')?.textContent ?? '(none)';
  });
  assert(parentText.includes('Welcome'), `Shift+Tab outdents ("${parentText}")`);

  // --- 5. Ctrl+Enter completes
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(120);
  let done = await page.evaluate(() => document.activeElement.closest('.item').classList.contains('done'));
  assert(done, 'Ctrl+Enter marks item complete');

  // --- 6. Ctrl+Z undoes the completion
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(150);
  done = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const el = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'child item');
    return el ? el.classList.contains('done') : null;
  });
  assert(done === false, 'Ctrl+Z undoes completion');

  // --- 7. note via Shift+Enter
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const el = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'child item');
    const c = el.querySelector(':scope > .row > .content');
    c.focus();
  });
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.keyboard.type('a note about this');
  await sleep(600);
  const noteText = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const el = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'child item');
    return el.querySelector(':scope > .note')?.textContent ?? '(none)';
  });
  assert(noteText === 'a note about this', `Shift+Enter note ("${noteText}")`);
  await page.keyboard.press('Escape'); // back to content
  await sleep(80);
  const backInContent = await page.evaluate(() => document.activeElement.classList.contains('content'));
  assert(backInContent, 'Escape moves from note back to item text');

  // --- 8. zoom in via Alt+ArrowRight, breadcrumbs appear, zoom out
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Alt');
  await sleep(350);
  let title = await page.$eval('#zoom-title', el => el.textContent);
  let crumbs = await page.$eval('#crumbs', el => el.textContent);
  assert(title === 'child item', `zoom shows item as title ("${title}")`);
  assert(crumbs.includes('Welcome'), `breadcrumbs start at the containing page ("${crumbs}")`); // rhizome: no Home crumb
  const hash = await page.evaluate(() => location.hash);
  assert(/^#\/n\//.test(hash), `zoom updates URL (${hash})`);
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Alt');
  await sleep(350);
  title = await page.$eval('#zoom-title', el => el.textContent);
  assert(title.includes('Welcome'), `zoom out goes to parent ("${title}")`);

  // --- 9. browser back returns into the zoomed node
  await page.goBack();
  await sleep(350);
  const backTitle = await page.$eval('#zoom-title', el => el.textContent);
  assert(backTitle === 'child item', 'browser back re-zooms');
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(350);
  const atRoot = await page.evaluate(() => document.querySelector('#zoom-head').style.display);
  assert(atRoot === 'none', 'navigating to #/ returns to root');

  // --- 10. search filters and highlights
  await page.click('#search');
  await page.keyboard.type('child item');
  await sleep(500);
  const banner = await page.$eval('#search-banner', el => el.textContent);
  assert(/1 match/.test(banner), `search banner counts matches ("${banner.trim()}")`);
  const markCount = await page.$$eval('mark', els => els.length);
  assert(markCount > 0, `search highlights matches (${markCount} marks)`);
  const visibleItems = await page.$$eval('.tree .item', els => els.length);
  assert(visibleItems < count, `search filters the tree (${visibleItems} visible)`);
  await page.keyboard.press('Escape');
  await sleep(300);
  const cleared = await page.$eval('#search', el => el.value);
  assert(cleared === '', 'Esc clears search');

  // --- 11. quick jump (Ctrl+K)
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await sleep(150);
  let jumpVisible = await page.$eval('#jump-overlay', el => !el.hidden);
  assert(jumpVisible, 'Ctrl+K opens quick jump');
  await page.keyboard.type('Power');
  await sleep(200);
  const jumpRows = await page.$$eval('.jump-row', els => els.map(e => e.textContent));
  assert(jumpRows.some(t => t.includes('Power moves')), `jump finds items (${jumpRows.length} results)`);
  await page.keyboard.press('Enter');
  await sleep(350);
  const jumpedTitle = await page.$eval('#zoom-title', el => el.textContent);
  assert(jumpedTitle.includes('Power moves'), `Enter zooms to result ("${jumpedTitle}")`);
  await page.evaluate(() => location.hash = '#/');
  await sleep(350);

  // --- 12. backspace at start merges with previous item
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const el = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'child item');
    el.querySelector(':scope > .row > .content').focus();
  });
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await sleep(200);
  const merged = await page.evaluate(() => document.activeElement.textContent);
  assert(merged.endsWith('child item') && merged.length > 'child item'.length,
    `Backspace at start merges into previous ("${merged.slice(0, 50)}…")`);
  const caretAtJoin = await page.evaluate(() => {
    const sel = getSelection(); const el = document.activeElement;
    const r = sel.getRangeAt(0); const pre = document.createRange();
    pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length === el.textContent.length - 'child item'.length;
  });
  assert(caretAtJoin, 'caret sits at the join point after merge');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(200);

  // --- 13. multi-line paste becomes an outline
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const el = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'child item');
    el.querySelector(':scope > .row > .content').focus();
  });
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Groceries\n  Milk\n  Bread\nErrands');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(300);
  const pasted = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const g = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'Groceries');
    if (!g) return null;
    return [...g.querySelectorAll(':scope > .children-anim > .children > .item > .row > .content')].map(e => e.textContent);
  });
  assert(pasted && pasted.join(',') === 'Milk,Bread', `multi-line paste builds hierarchy (${JSON.stringify(pasted)})`);

  // --- 14. collapse toggle
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const g = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'Groceries');
    g.querySelector(':scope > .row .toggle').click();
  });
  await sleep(400);
  const collapsed = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const g = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'Groceries');
    return g.classList.contains('collapsed') && !g.querySelector(':scope > .children-anim');
  });
  assert(collapsed, 'toggle collapses children (with removal after animation)');

  // --- 15. selection mode: Ctrl+A twice, extend, bulk complete
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const g = els.find(e => e.querySelector(':scope > .row > .content')?.textContent === 'Groceries');
    g.querySelector(':scope > .row > .content').focus();
  });
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await sleep(120);
  let selCount = await page.$$eval('.item.selected', els => els.length);
  assert(selCount === 1, `Ctrl+A twice selects the item (${selCount})`);
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift');
  await sleep(120);
  selCount = await page.$$eval('.item.selected', els => els.length);
  assert(selCount === 2, `Shift+Down extends selection (${selCount})`);
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(150);
  const bothDone = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .item')]
      .filter(e => ['Groceries', 'Errands'].includes(e.querySelector(':scope > .row > .content')?.textContent))
      .every(e => e.classList.contains('done')));
  assert(bothDone, 'bulk complete works on selection');
  await page.keyboard.press('Escape');

  // --- 16. drag & drop: drag "Errands" bullet onto a deeper position
  const dragInfo = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const find = t => els.find(e => e.querySelector(':scope > .row > .content')?.textContent === t);
    const from = find('Errands').querySelector(':scope > .row > .bullet').getBoundingClientRect();
    const row = find('Groceries').querySelector(':scope > .row').getBoundingClientRect();
    const content = find('Groceries').querySelector(':scope > .row > .content').getBoundingClientRect();
    return { fx: from.x + 8, fy: from.y + 8, tx: content.x + 40, ty: row.bottom - 3 };
  });
  await page.mouse.move(dragInfo.fx, dragInfo.fy);
  await page.mouse.down();
  await page.mouse.move(dragInfo.fx + 30, dragInfo.fy - 10, { steps: 5 });
  await page.mouse.move(dragInfo.tx, dragInfo.ty, { steps: 8 });
  await sleep(120);
  const indicatorShown = await page.$eval('#drop-indicator', el => !el.hidden);
  await page.mouse.up();
  await sleep(250);
  assert(indicatorShown, 'drop indicator appears during drag');
  const droppedAsChild = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const e = els.find(x => x.querySelector(':scope > .row > .content')?.textContent === 'Errands');
    return e?.parentElement.closest('.item')?.querySelector('.content')?.textContent;
  });
  assert(droppedAsChild === 'Groceries', `drag-drop reparents item (now under "${droppedAsChild}")`);

  // --- 17. persistence round-trip
  await sleep(1200);
  const saved = await page.evaluate(async () => (await (await fetch('/api/doc')).json()));
  const savedJson = JSON.stringify(saved.doc);
  assert(saved.version >= 1, `document saved to server (v${saved.version})`);
  assert(savedJson.includes('My new task'), 'typed text persisted');
  assert(savedJson.includes('a note about this'), 'note persisted');
  const savedState = await page.$eval('#save-state .save-label', el => el.textContent);
  assert(savedState === 'saved', `save indicator shows "${savedState}"`);

  // --- 18. arrow key navigation across items
  await page.evaluate(() => document.querySelector('.tree > .item > .row > .content').focus());
  await page.keyboard.press('Home');
  const firstText = await page.evaluate(() => document.activeElement.textContent);
  await page.keyboard.press('ArrowDown');
  await sleep(80);
  const secondText = await page.evaluate(() => document.activeElement.textContent);
  assert(secondText !== firstText, `ArrowDown moves to next item ("${secondText.slice(0, 30)}")`);
  await page.keyboard.press('ArrowUp');
  await sleep(80);
  const backText = await page.evaluate(() => document.activeElement.textContent);
  assert(backText === firstText, 'ArrowUp moves back');

  // --- 19. help overlay
  await page.keyboard.down('Control'); await page.keyboard.press('/'); await page.keyboard.up('Control');
  await sleep(120);
  const helpShown = await page.$eval('#help-overlay', el => !el.hidden);
  assert(helpShown, 'Ctrl+/ opens shortcut help');
  await page.keyboard.press('Escape');

  // --- 20. theme toggle via menu
  await page.click('#btn-menu');
  await sleep(150);
  await page.evaluate(() => {
    [...document.querySelectorAll('.popover .seg button')].find(b => b.textContent === 'Dark')?.click();
  });
  await sleep(100);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(theme === 'dark', 'theme switches to dark');
  await page.evaluate(() => {
    [...document.querySelectorAll('.popover .seg button')].find(b => b.textContent === 'Auto')?.click();
  });
  await page.keyboard.press('Escape');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
