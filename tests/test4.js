/* Parity additions: numbered lists, sort, board buttons, move/mirror-to,
   move-to-today, date formats, full-width, rich tags, markdown paste, embeds. */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  /* ---- 1. numbered list via "1. " and auto-renumber ---- */
  await page.evaluate(() => opNewAt('root', 0));
  await sleep(120);
  await page.keyboard.type('1.');
  await page.keyboard.press(' ');
  await sleep(150);
  await page.keyboard.type('first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await page.keyboard.press('Enter');
  await page.keyboard.type('third');
  await sleep(550);
  let nums = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .item.fmt-number .num')].slice(0, 3).map(e => e.textContent));
  assert(nums.join('') === '1.2.3.', `numbered list renders 1. 2. 3. (${nums.join(' ')})`);
  // delete the middle one → renumbers
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.tree .item.fmt-number')];
    const second = items.find(i => i.querySelector('.content').textContent === 'second');
    opDelete(second.dataset.id, { toast: false });
  });
  await sleep(250);
  nums = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .item.fmt-number .num')].slice(0, 2).map(e => e.textContent));
  assert(nums.join('') === '1.2.', `numbered list renumbers after delete (${nums.join(' ')})`);

  /* ---- 2. sort A-Z / Z-A ---- */
  await page.evaluate(() => {
    const p = opNewAt('root', 0);
    doc.nodes[p].text = 'fruits';
    for (const f of ['cherry', 'apple', 'banana']) insertAt(p, kidsOf(p).length, makeNode(f));
    renderPage();
    window.__sortParent = p;
  });
  await sleep(200);
  await page.evaluate(() => opSort(window.__sortParent, 1));
  await sleep(200);
  let order = await page.evaluate(() => kidsOf(window.__sortParent).map(id => plainOf(doc.nodes[id].text)).join(','));
  assert(order === 'apple,banana,cherry', `Sort A→Z (${order})`);
  await page.evaluate(() => opSort(window.__sortParent, -1));
  await sleep(200);
  order = await page.evaluate(() => kidsOf(window.__sortParent).map(id => plainOf(doc.nodes[id].text)).join(','));
  assert(order === 'cherry,banana,apple', `Sort Z→A (${order})`);

  /* ---- 3. board add-card / add-column buttons ---- */
  await page.evaluate(() => {
    const b = makeNode('Pipeline', { format: 'board' });
    insertAt('root', 0, b);
    const c = makeNode('To do');
    insertAt(b, 0, c);
    insertAt(c, 0, makeNode('existing card'));
    renderPage();
    window.__board = b;
    window.__col = c;
  });
  await sleep(250);
  let hasButtons = await page.evaluate(() =>
    !!document.querySelector('.board .board-add[data-add-card]') &&
    !!document.querySelector('.board .board-add-col'));
  assert(hasButtons, 'board shows + New card and + add-column affordances');
  await page.evaluate(() => document.querySelector('.board .board-add[data-add-card]').click());
  await sleep(150);
  await page.keyboard.type('typed via add-card');
  await sleep(550);
  let ok = await page.evaluate(() =>
    kidsOf(window.__col).map(id => plainOf(doc.nodes[id].text)).includes('typed via add-card'));
  assert(ok, '+ New card adds a card to that column');
  await page.evaluate(() => document.querySelector('.board .board-add-col').click());
  await sleep(150);
  await page.keyboard.type('Doing');
  await sleep(550);
  ok = await page.evaluate(() =>
    kidsOf(window.__board).map(id => plainOf(doc.nodes[id].text)).includes('Doing'));
  assert(ok, '+ add-column adds a new column to the board');

  /* ---- 4. Move to… picker ---- */
  await page.evaluate(() => {
    const a = makeNode('movable');
    insertAt('root', 0, a);
    const dest = makeNode('destination');
    insertAt('root', 1, dest);
    renderPage();
    window.__movable = a;
    window.__dest = dest;
  });
  await sleep(200);
  await page.evaluate(() => openNodePicker('Move to…', t => moveItemTo(window.__movable, t), subtreeOf(window.__movable)));
  await sleep(200);
  await page.type('.np-input', 'destination');
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(300);
  ok = await page.evaluate(() => parentOf(window.__movable) === window.__dest);
  assert(ok, 'Move to… relocates the item under the chosen node');

  /* ---- 5. Mirror to… picker ---- */
  await page.evaluate(() => openNodePicker('Mirror to…', t => mirrorItemTo(window.__dest, t), subtreeOf(window.__dest)));
  await sleep(200);
  await page.type('.np-input', 'fruits');
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(300);
  ok = await page.evaluate(() =>
    kidsOf(window.__sortParent).some(id => doc.nodes[id].mirror === window.__dest));
  assert(ok, 'Mirror to… creates a mirror under the chosen node');

  /* ---- 6. Move to Today sets a date ---- */
  await page.evaluate(() => {
    const t = makeNode('do laundry');
    insertAt('root', 0, t);
    renderPage();
    window.__dated = t;
    setItemDate(t, todayStr());
  });
  await sleep(300);
  ok = await page.evaluate(() => {
    const n = doc.nodes[window.__dated];
    return n.text.includes('<time datetime="' + todayStr());
  });
  assert(ok, 'Move to Today stamps the item with today\'s date');

  /* ---- 7. date format setting reformats live ---- */
  const before = await page.evaluate(() =>
    document.querySelector(`.item[data-id="${window.__dated}"] time`).textContent);
  await page.evaluate(() => { settings.dateFormat = 'iso'; renderPage(); });
  await sleep(200);
  const fmtCheck = await page.evaluate(() => {
    const txt = document.querySelector(`.item[data-id="${window.__dated}"] time`).textContent;
    return { txt, iso: todayStr(), match: txt === todayStr() };
  });
  assert(fmtCheck.match && fmtCheck.txt !== before, `date format setting reformats existing pills (${before} → ${fmtCheck.txt})`);
  await page.evaluate(() => { settings.dateFormat = 'medium'; renderPage(); });

  /* ---- 8. full-width setting ---- */
  ok = await page.evaluate(() => {
    settings.width = 'full'; applyTheme();
    const r = document.documentElement.dataset.width === 'full';
    settings.width = 'reading'; applyTheme();
    return r;
  });
  assert(ok, 'full-width page setting toggles');

  /* ---- 9. rich tags allow emoji ---- */
  await page.evaluate(() => {
    settings.richTags = true;
    const t = makeNode('ship it #v1\u{1F680} now');
    insertAt('root', 0, t);
    renderPage();
    window.__emojiTag = t;
  });
  await sleep(200);
  ok = await page.evaluate(() => {
    const el = document.querySelector(`.item[data-id="${window.__emojiTag}"] .tag`);
    return el && el.dataset.tag.includes('\u{1F680}');
  });
  assert(ok, 'rich tags include emoji in the tag (#v1🚀)');
  await page.evaluate(() => { settings.richTags = false; });

  /* ---- 10. markdown paste conversion ---- */
  await page.evaluate(() => {
    const host = opNewAt('root', 0);
    document.querySelector(`.item[data-id="${host}"] .content`).focus();
  });
  await sleep(150);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '# Heading\n- [ ] a task\n- **bold** and `code`\n  - nested *italic*');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(350);
  ok = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('.tree .item.fmt-h1 .content')].some(c => c.textContent === 'Heading');
    const todo = [...document.querySelectorAll('.tree .item.fmt-todo .content')].some(c => c.textContent === 'a task');
    const bold = Object.values(doc.nodes).some(n => /<b>bold<\/b>/.test(n.text) && /<code>code<\/code>/.test(n.text));
    const italic = Object.values(doc.nodes).some(n => /<i>italic<\/i>/.test(n.text));
    return heading && todo && bold && italic;
  });
  assert(ok, 'markdown paste converts headings, todos, bold/italic/code, nesting');

  /* ---- 11. YouTube Shorts + Loom embeds ---- */
  await page.evaluate(() => {
    insertAt('root', 0, makeNode('clip https://www.youtube.com/shorts/abcdefghijk'));
    insertAt('root', 1, makeNode('demo https://www.loom.com/share/abc123def456'));
    insertAt('root', 2, makeNode('hot take https://x.com/jack/status/20'));
    renderPage();
  });
  await sleep(250);
  ok = await page.evaluate(() => {
    const short = !!document.querySelector('.embed.embed-short iframe');
    const loom = [...document.querySelectorAll('.embed iframe')].some(f => f.src.includes('loom.com/embed'));
    const tweet = !!document.querySelector('.embed.embed-tweet a');
    return short && loom && tweet;
  });
  assert(ok, 'YouTube Shorts, Loom embeds and X link-card render');

  /* ---- 12. created/changed timestamps in item menu ---- */
  await page.evaluate(() => {
    const it = document.querySelector('.tree .item');
    window.showItemMenu(it.querySelector('.itemmenu-btn'), it.dataset.id);
  });
  await sleep(250);
  ok = await page.evaluate(() => {
    const f = document.querySelector('.popover .pop-foot');
    return f && /Changed/.test(f.textContent) && /Created/.test(f.textContent);
  });
  assert(ok, 'item menu shows Created / Changed timestamps');
  await page.keyboard.press('Escape');

  /* ---- 13. Turn-into menu includes Numbered ---- */
  await page.evaluate(() => {
    const it = document.querySelector('.tree .item');
    window.showItemMenu(it.querySelector('.itemmenu-btn'), it.dataset.id);
  });
  await sleep(200);
  ok = await page.evaluate(() =>
    [...document.querySelectorAll('.popover .seg button')].some(b => b.textContent === '1.'));
  assert(ok, 'Turn into menu offers numbered list');
  await page.keyboard.press('Escape');

  /* ---- 14. Alt+Down / Alt+Up zoom aliases ---- */
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.tree .item')].find(e => plainOf(doc.nodes[e.dataset.id].text) === 'fruits');
    it.querySelector('.content').focus();
  });
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Alt');
  await sleep(350);
  ok = await page.evaluate(() => document.querySelector('#zoom-title').textContent === 'fruits');
  assert(ok, 'Alt+Down zooms in');
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Alt');
  await sleep(350);
  ok = await page.evaluate(() => document.querySelector('#zoom-head').style.display === 'none');
  assert(ok, 'Alt+Up zooms out');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PARITY TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
