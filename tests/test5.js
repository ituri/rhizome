/* Natural-language dates + Tab, [[ inline linking, link: operator, date ranges. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  /* ---- 1. the parser itself (unit-style, via the page) ---- */
  const parse = await page.evaluate(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const iso = n => { const d = new Date(t); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    return {
      today: nlDate('buy milk today')?.iso === iso(0),
      tomorrow: nlDate('tomorrow')?.iso === iso(1),
      yesterday: nlDate('call yesterday')?.iso === iso(-1),
      in3: nlDate('ship in 3 days')?.iso === iso(3),
      inThreeWords: nlDate('in three days')?.iso === iso(3),
      in2weeks: nlDate('in 2 weeks')?.iso === iso(14),
      notADate: nlDate('hello world') === null,
      partialWord: nlDate('today') !== null,
      mid: nlDate('meet on oct') === null, // "oct" with no day shouldn't match
    };
  });
  assert(parse.today, 'parses "today"');
  assert(parse.tomorrow, 'parses "tomorrow"');
  assert(parse.yesterday, 'parses "yesterday"');
  assert(parse.in3, 'parses "in 3 days"');
  assert(parse.inThreeWords, 'parses "in three days" (number words)');
  assert(parse.in2weeks, 'parses "in 2 weeks"');
  assert(parse.notADate, 'plain text is not a date');
  assert(parse.mid, '"oct" without a day does not match');

  /* ---- 2. type "today" → hint appears → Tab converts to a pill ---- */
  await page.evaluate(() => opNewAt('root', 0));
  await sleep(150);
  await page.keyboard.type('pay rent today');
  await sleep(300);
  let hint = await page.evaluate(() => {
    const h = document.querySelector('.date-hint');
    return h && !h.hidden && /Tab/.test(h.textContent);
  });
  assert(hint, 'typing "today" shows the Tab→date hint');
  await page.keyboard.press('Tab');
  await sleep(550);
  let pill = await page.evaluate(() => {
    const id = editableCtx(document.activeElement)?.id;
    const n = doc.nodes[id];
    const a = document.querySelector(`.item[data-id="${id}"] a[href^="#/n/"]`);
    const dayId = a?.getAttribute('href').replace('#/n/', '');
    const day = dayId && doc.nodes[dayId];
    return { linked: !!day && day.cal === 'day' && day.cd === todayStr(), noWord: !/today/i.test(n.text), label: a?.textContent || '' };
  });
  assert(pill.linked && pill.noWord, 'Tab replaces "today" with a link to today\'s page'); // rhizome
  assert(/\d{4}/.test(pill.label), 'the inserted date link shows the Roam label');
  // Tab did NOT indent (still a top-level row)
  let indented = await page.evaluate(() => {
    const id = editableCtx(document.activeElement)?.id;
    return parentOf(id) === 'root';
  });
  assert(indented, 'Tab converted the date instead of indenting');

  /* ---- 3. "next friday" converts to the correct weekday ---- */
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('standup next friday');
  await sleep(300);
  await page.keyboard.press('Tab');
  await sleep(550);
  let ok = await page.evaluate(() => {
    const id = editableCtx(document.activeElement)?.id;
    const a = document.querySelector(`.item[data-id="${id}"] a[href^="#/n/"]`);
    const day = a && doc.nodes[a.getAttribute('href').replace('#/n/', '')];
    if (!day || day.cal !== 'day') return false;
    const d = new Date(day.cd + 'T00:00:00');
    return d.getDay() === 5 && d > new Date(); // a friday in the future
  });
  assert(ok, '"next friday" links to a future Friday page'); // rhizome

  /* ---- 4. Tab with no date still indents normally ---- */
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a normal child');
  await sleep(200);
  await page.keyboard.press('Tab');
  await sleep(250);
  ok = await page.evaluate(() => {
    const id = editableCtx(document.activeElement)?.id;
    return plainOf(N(parentOf(id)).text).includes('standup');
  });
  assert(ok, 'Tab still indents when there is no date phrase');

  /* ---- 5. date range "jun 12 - jun 15" ---- */
  await page.evaluate(() => { const id = opNewAt('root', 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('vacation jun 12 - jun 15');
  await sleep(300);
  await page.keyboard.press('Tab');
  await sleep(550);
  ok = await page.evaluate(() => {
    const id = editableCtx(document.activeElement)?.id;
    const el = document.querySelector(`.item[data-id="${id}"] time`);
    const dt = el?.getAttribute('datetime') || '';
    return dt.includes('/') && /–/.test(el.textContent);
  });
  assert(ok, 'date range "jun 12 - jun 15" becomes a range pill');

  /* ---- 6. [[ inline linking ---- */
  // make a target item to link to
  await page.evaluate(() => {
    const t = makeNode('Project Apollo');
    insertAt('root', 0, t);
    renderPage();
    window.__target = t;
  });
  await page.evaluate(() => { const id = opNewAt('root', 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); window.__host = id; });
  await sleep(150);
  await page.keyboard.type('see [[Apollo');
  await sleep(350);
  let popVisible = await page.evaluate(() =>
    !!document.querySelector('.caret-pop') && /Project Apollo/.test(document.querySelector('.caret-pop').textContent));
  assert(popVisible, 'typing "[[" opens an item-link autocomplete');
  await page.keyboard.press('Enter');
  await sleep(550);
  ok = await page.evaluate(() => {
    const n = doc.nodes[window.__host];
    return new RegExp(`<a href="#/n/${window.__target}">Project Apollo</a>`).test(n.text) && !n.text.includes('[[');
  });
  assert(ok, '[[ link inserts an internal <a> link and removes the [[query');
  // clicking it zooms to the target
  await page.evaluate(() => { document.querySelector(`.item[data-id="${window.__host}"] a[href^="#/n/"]`).click(); });
  await sleep(400);
  ok = await page.evaluate(() => document.querySelector('#zoom-title').textContent === 'Project Apollo');
  assert(ok, 'clicking an internal link zooms to the linked item');
  // backlink shows on the target's page
  ok = await page.evaluate(() => !document.querySelector('#backlinks').hidden &&
    document.querySelector('#backlinks').textContent.includes('Linked Reference'));
  assert(ok, 'the [[ link generates a backlink on the target');
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(300);

  /* ---- 7. [[ create-new option ---- */
  await page.evaluate(() => { const id = opNewAt('root', 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('ref [[Brand New Topic');
  await sleep(350);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.caret-pop .pop-item')];
    const create = items.find(b => /Create/.test(b.textContent));
    create.click();
  });
  await sleep(550);
  const createDbg = await page.evaluate(() => {
    const created = Object.values(doc.nodes).find(n => plainOf(n.text).trim() === 'Brand New Topic');
    const linkers = Object.values(doc.nodes).filter(n => /#\/n\//.test(n.text)).map(n => n.text.slice(0, 60));
    return { created: created ? created.id : null, linkers, hostText: (doc.nodes[window.__host]?.text || '').slice(0, 80) };
  });
  ok = createDbg.created && createDbg.linkers.some(t => t.includes('#/n/' + createDbg.created));
  if (!ok) console.log('       create dbg:', JSON.stringify(createDbg));
  assert(ok, '[[ "Create" makes a new item and links to it');

  /* ---- 8. link: search operator ---- */
  await page.evaluate(() => {
    const a = makeNode('docs <a href="https://github.com/me/repo" rel="noopener">the repository</a>');
    insertAt('root', 0, a);
    const b = makeNode('blog <a href="https://example.com/post" rel="noopener">my post</a>');
    insertAt('root', 1, b);
    renderPage();
  });
  await sleep(150);
  const counts = await page.evaluate(() => {
    setSearch('link:github');
    const gh = state.matchCount;
    setSearch('link:example');
    const ex = state.matchCount;
    setSearch('repository');     // the link TEXT does not contain "github"
    const byText = state.matchCount;
    setSearch('');
    return { gh, ex, byText };
  });
  assert(counts.gh === 1 && counts.ex === 1, `link: finds by URL (github=${counts.gh}, example=${counts.ex})`);
  assert(counts.gh === 1, 'link:github matches the href even though the link text says "the repository"');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DATE/LINK TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
