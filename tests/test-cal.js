/* Calendar hierarchy: Today button, Year/Month/Day nodes, navigation strip,
   day navigation, dated-items surfacing. */
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
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  const today = await page.evaluate(() => todayStr());
  const [Y, M, D] = today.split('-').map(Number);

  /* ---- 1. Today button builds Calendar > Year > Month > Day and zooms in ---- */
  await page.click('#btn-calendar');
  await sleep(450);
  const built = await page.evaluate(() => {
    const root = Object.values(doc.nodes).find(n => n.cal === 'root');
    if (!root) return null;
    const year = root.children.map(id => doc.nodes[id]).find(n => n.cal === 'year');
    const month = year && year.children.map(id => doc.nodes[id]).find(n => n.cal === 'month');
    const day = month && month.children.map(id => doc.nodes[id]).find(n => n.cal === 'day');
    return {
      rootText: plainOf(root.text),
      year: year?.cy, month: month?.cm, dayIso: day?.cd,
      zoomedDay: doc.nodes[state.zoom]?.cal === 'day' && doc.nodes[state.zoom]?.cd,
      title: document.querySelector('#zoom-title').textContent,
    };
  });
  assert(built && /Calendar/.test(built.rootText), 'Today creates a "Calendar" root node');
  assert(built.year === Y && built.month === M - 1 && built.dayIso === today,
    `Calendar › ${Y} › ${M} › ${today} hierarchy built`);
  assert(built.zoomedDay === today, 'Today zooms into today\'s day node');
  assert(/,/.test(built.title), `day title is a weekday label ("${built.title}")`);

  /* ---- 2. breadcrumb is Calendar › Year › Month › Day ---- */
  const crumbs = await page.evaluate(() => document.querySelector('#crumbs').textContent);
  assert(/Calendar/.test(crumbs) && new RegExp(String(Y)).test(crumbs), `breadcrumb shows the calendar path (${crumbs})`);

  /* ---- 3. the day navigation strip renders with today highlighted ---- */
  let strip = await page.evaluate(() => {
    const el = document.querySelector('#cal-strip');
    if (el.hidden) return null;
    const days = [...el.querySelectorAll('.cs-day')];
    const current = el.querySelector('.cs-day.current');
    const todayCell = el.querySelector('.cs-day.today');
    const hasMonthLabel = !!el.querySelector('.cs-day[data-mon]');
    return { count: days.length, current: !!current, today: !!todayCell, hasMonthLabel, arrows: !!el.querySelector('.cs-nav') };
  });
  assert(strip && strip.count > 14, `day strip renders a row of days (${strip?.count})`);
  assert(strip.current && strip.today, 'the current/today day is highlighted in the strip');
  assert(strip.hasMonthLabel && strip.arrows, 'strip has month labels and ‹ › navigation');

  /* ---- 4. write under today, then navigate to another day via the strip ---- */
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await page.keyboard.press('ArrowDown');     // start a bullet under today (empty-page nav)
  await page.keyboard.type('Daily standup notes');
  await sleep(500);
  // click the next day in the strip
  const before = await page.evaluate(() => Object.keys(doc.nodes).length);
  await page.evaluate(() => {
    const cur = document.querySelector('.cs-day.current');
    let nxt = cur.nextElementSibling;
    while (nxt && !nxt.classList.contains('cs-day')) nxt = nxt.nextElementSibling;
    nxt.click();
  });
  await sleep(450);
  const navd = await page.evaluate(() => {
    const z = doc.nodes[state.zoom];
    return { isDay: z?.cal === 'day', iso: z?.cd, nodeCount: Object.keys(doc.nodes).length };
  });
  assert(navd.isDay && navd.iso > today, `clicking the next day navigates to a new day node (${navd.iso})`);
  assert(navd.nodeCount > before, 'the new day node was created on demand');
  // today's note is preserved on its own day
  await page.click('#btn-calendar');
  await sleep(450);
  let ok = await page.evaluate(() =>
    kidsOf(state.zoom).some(id => plainOf(doc.nodes[id].text).includes('Daily standup notes')));
  assert(ok, 'each day keeps its own content (today still has its note)');

  /* ---- 5. zoom to the Year node → month tabs ---- */
  await page.evaluate(() => {
    const root = Object.values(doc.nodes).find(n => n.cal === 'root');
    const year = root.children.find(id => doc.nodes[id].cal === 'year');
    location.hash = '#/n/' + year;
  });
  await sleep(450);
  ok = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#cal-strip .cs-mon-tab')];
    return tabs.length === 12 && tabs.some(t => t.textContent === 'Jan') && tabs.some(t => t.textContent === 'Dec');
  });
  assert(ok, 'the Year node shows Jan–Dec month tabs');
  // click a month tab → navigate to that month
  await page.evaluate(() => {
    [...document.querySelectorAll('#cal-strip .cs-mon-tab')].find(t => t.textContent === 'Dec').click();
  });
  await sleep(450);
  ok = await page.evaluate(() => { const z = doc.nodes[state.zoom]; return z?.cal === 'month' && z?.cm === 11; });
  assert(ok, 'clicking a month tab navigates to that month node');

  /* ---- 6. items dated elsewhere surface under their day ---- */
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(350);
  await page.evaluate(t => {
    const n = makeNode(`Renew passport <time datetime="${t}">x</time>`);
    insertAt('root', 0, n);
    markDirty();
  }, today);
  await sleep(200);
  await page.click('#btn-calendar');
  await sleep(450);
  ok = await page.evaluate(() => {
    const sec = document.querySelector('#cal-strip .cal-dated');
    return sec && /Renew passport/.test(sec.textContent) && /Items dated to this day/.test(sec.textContent);
  });
  assert(ok, 'items dated to today surface under today in the calendar');

  /* ---- 7. the Calendar node + Today button work from the sidebar ---- */
  await page.evaluate(() => { settings.sidebar = true; applyTheme(); renderSidebar(); });
  await sleep(200);
  ok = await page.evaluate(() =>
    [...document.querySelectorAll('#side-tree .side-item')].some(el => /Calendar/.test(el.textContent)));
  assert(ok, 'the Calendar node shows in the sidebar outline');
  // navigate away, then use the sidebar Today button
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(350);
  await page.click('#side-today');
  await sleep(450);
  ok = await page.evaluate(() => doc.nodes[state.zoom]?.cal === 'day' && doc.nodes[state.zoom]?.cd === todayStr());
  assert(ok, 'the sidebar Today button jumps to today');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CALENDAR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
