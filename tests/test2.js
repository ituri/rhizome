/* Tendril v2 feature tests — operators, blocks, slash, dates, stars, trash,
   mirrors, comments, colors, capture, sharing, presentation, calendar, boards. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

const focusByText = text => `(() => {
  const els = [...document.querySelectorAll('.tree .item')];
  const el = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.querySelector(':scope > .row .content').focus();
  return true;
})()`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  /* ---- 1. search operators ---- */
  const count = async q => {
    await page.evaluate(q2 => window.setSearch ? setSearch(q2) : null, q);
    await page.evaluate(q2 => { searchEl.value = q2; }, q);
    await page.evaluate(q2 => setSearch(q2), q);
    await sleep(120);
    return page.evaluate(() => state.matchCount);
  };
  assert(await count('is:complete') >= 1, `is:complete finds done items (${await count('is:complete')})`);
  const phrase = await count('"complete something"');
  assert(phrase === 1, `quoted phrase match (${phrase})`);
  const orCount = await count('drag OR zoom');
  assert(orCount >= 2, `OR operator (${orCount})`);
  const plain = await count('press');
  const minus = await count('press -shift');
  assert(minus < plain && minus >= 1, `NOT operator narrows (${plain} → ${minus})`);
  const hasNote = await count('has:note');
  assert(hasNote >= 1, `has:note (${hasNote})`);
  const changed = await count('changed:today');
  assert(changed >= 5, `changed:today (${changed})`);
  const nested = await count('basics > note');
  const allNote = await count('note');
  assert(nested >= 1 && nested <= allNote, `nested search a > b (${nested} ≤ ${allNote})`);
  await page.evaluate(() => setSearch(''));
  await sleep(150);

  /* ---- 2. markdown shortcut → heading ---- */
  await page.evaluate(() => {
    const last = kidsOf('root').length;
    opNewAt('root', last);
  });
  await sleep(150);
  await page.keyboard.type('##');
  await page.keyboard.press(' ');
  await sleep(150);
  await page.keyboard.type('My Heading');
  await sleep(550);
  let ok = await page.evaluate(() => {
    const item = document.activeElement.closest('.item');
    return item?.classList.contains('fmt-h2');
  });
  assert(ok, '"## " markdown shortcut turns item into Heading 2');

  /* ---- 3. slash menu → to-do ---- */
  await page.keyboard.press('Enter');
  await sleep(150);
  await page.keyboard.type('buy milk ');
  await page.keyboard.type('/');
  await sleep(200);
  let popVisible = await page.evaluate(() => !!document.querySelector('.caret-pop'));
  assert(popVisible, 'slash opens the command menu');
  await page.keyboard.type('to-do');
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(250);
  ok = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('buy milk'));
    return it?.classList.contains('fmt-todo') && !!it.querySelector('.todo-box') &&
      !(it.querySelector(':scope > .row .content').textContent.includes('/'));
  });
  assert(ok, 'slash command converts to to-do with checkbox and removes "/to-do" text');

  // checkbox click completes
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('buy milk'));
    it.querySelector('.todo-box').click();
  });
  await sleep(150);
  ok = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('buy milk'));
    return it.classList.contains('done');
  });
  assert(ok, 'to-do checkbox click completes the item');

  /* ---- 4. divider via --- ---- */
  await page.evaluate(focusByText('buy milk'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await sleep(120);
  await page.keyboard.type('---');
  await page.keyboard.press('Enter');
  await sleep(200);
  ok = await page.evaluate(() => !!document.querySelector('.item.fmt-divider'));
  assert(ok, '"---" + Enter creates a divider');

  /* ---- 5. date via !! ---- */
  await page.keyboard.type('pay rent ');
  await page.keyboard.type('!!');
  await sleep(250);
  popVisible = await page.evaluate(() => !!document.querySelector('.datepick'));
  assert(popVisible, '"!!" opens the date picker');
  await page.evaluate(() => {
    [...document.querySelectorAll('.datepick .quick button')].find(b => b.textContent === 'Today')?.click();
  });
  await sleep(550);
  const dateInfo = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('pay rent'));
    const t = it?.querySelector('time[datetime]');
    return t ? { iso: t.getAttribute('datetime'), today: t.classList.contains('today') } : null;
  });
  assert(dateInfo && dateInfo.today, `date pill inserted and styled as today (${dateInfo?.iso})`);

  // clicking the date filters by on:
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('time[datetime]')][0];
    t.click();
  });
  await sleep(250);
  ok = await page.evaluate(() => state.search.startsWith('on:') && state.matchCount >= 1);
  assert(ok, 'clicking a date filters by on:<date>');
  await page.evaluate(() => setSearch(''));
  await sleep(120);

  /* ---- 6. tag autocomplete ---- */
  await page.evaluate(focusByText('pay rent'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await sleep(120);
  await page.keyboard.type('see #exa');
  await sleep(250);
  popVisible = await page.evaluate(() =>
    !!document.querySelector('.caret-pop') && document.querySelector('.caret-pop').textContent.includes('#example'));
  assert(popVisible, 'tag autocomplete suggests existing #example');
  await page.keyboard.press('Enter');
  await sleep(450);
  ok = await page.evaluate(() => document.activeElement.textContent.includes('#example'));
  assert(ok, 'picking a suggestion completes the tag');

  /* ---- 7. star + sidebar ---- */
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('8');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(200);
  ok = await page.evaluate(() => document.querySelector('#btn-star').classList.contains('starred'));
  assert(ok, 'Ctrl+Shift+8 stars the page');
  await page.click('#btn-sidebar');
  await sleep(350);
  ok = await page.evaluate(() =>
    document.body.classList.contains('sidebar-open') &&
    !document.querySelector('#side-stars-section').hidden &&
    document.querySelectorAll('#side-tree .side-item').length >= 2);
  assert(ok, 'sidebar shows starred section and outline tree');
  await page.evaluate(() => window.toggleStar());
  await sleep(120);

  /* ---- 8. trash + restore ---- */
  await page.evaluate(focusByText('pay rent'));
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('Backspace');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(250);
  ok = await page.evaluate(() => doc.trash?.length >= 1 &&
    ![...document.querySelectorAll('.tree .content')].some(c => c.textContent.includes('pay rent')));
  assert(ok, 'Ctrl+Shift+Backspace moves item to trash');
  await page.evaluate(() => showTrash());
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll('.trash-row button')].find(b => b.textContent === 'Restore')?.click();
  });
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#trash-overlay').hidden = true; });
  ok = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .content')].some(c => c.textContent.includes('pay rent')));
  assert(ok, 'trash restore brings the item back');

  /* ---- 9. mirror + backlinks ---- */
  await page.evaluate(focusByText('My Heading'));
  await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
  await page.keyboard.press('m');
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  await sleep(300);
  const mirrorInfo = await page.evaluate(() => {
    const m = document.querySelector('.item.is-mirror');
    if (!m) return null;
    const orig = document.querySelector(`.item[data-id="${m.dataset.mirror}"]`);
    return { text: m.querySelector('.content').textContent, diamonds: !!orig && orig.classList.contains('mirrored') };
  });
  assert(mirrorInfo && mirrorInfo.text.includes('My Heading') && mirrorInfo.diamonds,
    'Alt+Shift+M creates a live mirror showing original text (diamond on both instances)');
  // mirror stays in sync when original edited
  await page.evaluate(focusByText('My Heading'));
  await page.keyboard.press('End');
  await page.keyboard.type(' v2');
  await sleep(600);
  ok = await page.evaluate(() =>
    document.querySelector('.item.is-mirror .content').textContent.includes('My Heading v2'));
  assert(ok, 'mirror updates live as the original is edited');
  // backlinks on the original's page
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item:not(.is-mirror)')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('My Heading'));
    location.hash = '#/n/' + it.dataset.id;
  });
  await sleep(350);
  ok = await page.evaluate(() => !document.querySelector('#backlinks').hidden &&
    document.querySelector('#backlinks').textContent.includes('Linked from'));
  assert(ok, 'backlinks panel lists where the item is mirrored');
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);

  /* ---- 10. comments ---- */
  const cid = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('buy milk'));
    window.showComments(it.querySelector(':scope > .row'), it.dataset.id);
    return it.dataset.id;
  });
  await sleep(250);
  await page.evaluate(() => {
    const ta = document.querySelector('.comments-panel textarea');
    ta.value = 'remember oat milk';
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('.comments-panel button')].find(b => b.textContent === 'Add')?.click();
  });
  await sleep(250);
  ok = await page.evaluate(id => {
    const n = doc.nodes[id];
    const chip = document.querySelector(`.item[data-id="${id}"] .comment-chip`);
    return n.comments?.length === 1 && chip?.textContent.includes('1');
  }, cid);
  assert(ok, 'comments can be added and show a count chip');
  await page.evaluate(() => closeAllPopovers());

  /* ---- 11. text color via fmtbar ---- */
  await page.evaluate(focusByText('buy milk'));
  await page.evaluate(() => {
    const el = document.activeElement;
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await sleep(400);
  ok = await page.evaluate(() => !document.querySelector('#fmtbar').hidden);
  assert(ok, 'format toolbar appears on text selection');
  await page.evaluate(() => document.querySelector('#fmtbar [data-cmd="color"]').click());
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll('.swatch')].find(s => s.title === 'red')?.click();
  });
  await sleep(550);
  ok = await page.evaluate(id => (doc.nodes[id].text || '').includes('tc-red'), cid);
  assert(ok, 'color swatch wraps selection in a color span (persisted)');

  /* ---- 12. quick capture ---- */
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('Space');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(200);
  ok = await page.evaluate(() => !document.querySelector('#capture-overlay').hidden);
  assert(ok, 'Ctrl+Shift+Space opens quick capture');
  await page.type('#capture-input', 'call the bank\n  ask about fees');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(300);
  ok = await page.evaluate(() => {
    const inbox = kidsOf('root').find(id => plainOf(doc.nodes[id].text).trim() === 'Inbox');
    if (!inbox) return false;
    const kid = kidsOf(inbox).find(id => plainOf(doc.nodes[id].text).includes('call the bank'));
    return kid && kidsOf(kid).length === 1;
  });
  assert(ok, 'capture creates nested items under Inbox');

  /* ---- 13. capture API + SSE live sync ---- */
  await sleep(900); // let save settle
  const before = await page.evaluate(() => state.version);
  const cap = await page.evaluate(async () => {
    const res = await fetch('/api/capture', { method: 'POST', body: JSON.stringify({ text: 'from the API' }) });
    return res.json();
  });
  assert(cap.captured === 1, 'capture API accepts items');
  await sleep(1500);
  ok = await page.evaluate(() => {
    const inbox = kidsOf('root').find(id => plainOf(doc.nodes[id].text).trim() === 'Inbox');
    return state.version > 0 && kidsOf(inbox).some(id => plainOf(doc.nodes[id].text).includes('from the API'));
  });
  assert(ok, `SSE pushes API-captured items into the open tab (v${before}→${await page.evaluate(() => state.version)})`);

  /* ---- 14. share links: view + edit ---- */
  const share = await page.evaluate(async () => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('Welcome'));
    const res = await fetch('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: it.dataset.id, mode: 'view' }),
    });
    return res.json();
  });
  const viewPage = await browser.newPage();
  viewPage.on('pageerror', e => { console.log('SHARE PAGEERROR:', e.message); failures++; });
  await viewPage.goto(URL.replace(/\/$/, '') + share.url, { waitUntil: 'domcontentloaded' });
  await viewPage.waitForSelector('.tree .item .content', { timeout: 8000 });
  await sleep(300);
  ok = await viewPage.evaluate(() =>
    document.querySelector('#zoom-title').textContent.includes('Welcome') &&
    !document.querySelector('#share-banner').hidden &&
    document.querySelector('.tree .content').isContentEditable === false);
  assert(ok, 'view-only share renders the subtree read-only with banner');
  await viewPage.close();

  const shareEdit = await page.evaluate(async () => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('Try it'));
    const res = await fetch('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: it.dataset.id, mode: 'edit' }),
    });
    return res.json();
  });
  const editPage = await browser.newPage();
  await editPage.goto(URL.replace(/\/$/, '') + shareEdit.url, { waitUntil: 'domcontentloaded' });
  await editPage.waitForSelector('.tree .item .content');
  await sleep(300);
  await editPage.click('.tree .item .content');
  await editPage.keyboard.press('End');
  await editPage.keyboard.press('Enter');
  await editPage.keyboard.type('added by a guest');
  await sleep(1400); // commit + save
  ok = await editPage.evaluate(() => !document.querySelector('.save-state').classList.contains('offline'));
  assert(ok, 'editable share saves without error');
  await editPage.close();
  await sleep(1600); // owner SSE pickup
  ok = await page.evaluate(() =>
    Object.values(doc.nodes).some(n => (n.text || '').includes('added by a guest')));
  assert(ok, 'guest edits flow back into the owner document live');

  /* ---- 15. presentation mode ---- */
  await page.evaluate(() => startPresent());
  await sleep(250);
  ok = await page.evaluate(() => !document.querySelector('#present-overlay').hidden &&
    document.querySelector('#present-slide h1') !== null);
  assert(ok, 'presentation mode renders slides');
  await page.keyboard.press('ArrowRight');
  await sleep(150);
  const pos = await page.evaluate(() => document.querySelector('#present-pos').textContent);
  assert(pos.startsWith('2'), `arrow advances slides (${pos})`);
  await page.keyboard.press('Escape');
  await sleep(150);

  /* ---- 16. calendar shows dated item ---- */
  await page.evaluate(() => showCalendar());
  await sleep(250);
  ok = await page.evaluate(() => {
    const grid = document.querySelector('#cal-grid');
    return !document.querySelector('#calendar-overlay').hidden &&
      grid.querySelector('.cal-day.today') &&
      [...grid.querySelectorAll('.cal-item')].some(a => a.textContent.includes('pay rent'));
  });
  assert(ok, 'calendar shows the dated item on today');
  await page.keyboard.press('Escape');
  await sleep(150);

  /* ---- 17. Ctrl+O hides completed ---- */
  await page.evaluate(focusByText('My Heading'));
  await page.keyboard.down('Control'); await page.keyboard.press('o'); await page.keyboard.up('Control');
  await sleep(200);
  ok = await page.evaluate(() => document.querySelector('.tree').classList.contains('hide-done'));
  assert(ok, 'Ctrl+O hides completed items');
  await page.keyboard.down('Control'); await page.keyboard.press('o'); await page.keyboard.up('Control');
  await sleep(150);

  /* ---- 18. board view ---- */
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('The basics'));
    opSetFormat(it.dataset.id, 'board');
  });
  await sleep(300);
  const boardCols = await page.evaluate(() => document.querySelectorAll('.board > .board-col').length);
  assert(boardCols >= 4, `board format renders children as columns (${boardCols})`);
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item.fmt-board')];
    if (els[0]) opSetFormat(els[0].dataset.id, 'bullet');
  });
  await sleep(200);

  /* ---- 19. markdown export sanity ---- */
  const md = await page.evaluate(() => kidsOf(HOME).map(id => subtreeToMarkdown(id, 0)).join('\n'));
  assert(md.includes('- [x] buy milk') || md.includes('- [ ] buy milk'), 'markdown export emits checkbox syntax');

  /* ---- 20. multi-tag append (shift+click) ---- */
  await page.evaluate(() => setSearch('#example'));
  await sleep(150);
  const q2 = await page.evaluate(() => {
    setSearch('#copy', { append: true });
    return state.search;
  });
  assert(q2.includes('#example') && q2.includes('#copy'), `multi-tag search appends (${q2})`);
  await page.evaluate(() => setSearch(''));

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL V2 TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
