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
  await page.goto('http://localhost:3211/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  const today = await page.evaluate(() => todayStr());
  const [Y, M, D] = today.split('-').map(Number);

  /* ---- 1. gotoToday() builds Calendar > Year > Month > Day and zooms in ---- */
  await page.evaluate(() => gotoDate(todayStr()));
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
  assert(built && /Calendar/.test(built.rootText), 'gotoToday creates a "Calendar" root node');
  assert(built.year === Y && built.month === M - 1 && built.dayIso === today,
    `Calendar › ${Y} › ${M} › ${today} hierarchy built`);
  assert(built.zoomedDay === today, 'gotoToday zooms into today\'s day node');
  assert(/,/.test(built.title), `day title is a weekday label ("${built.title}")`);

  /* ---- 2. a day page is a normal page: no calendar crumbs, no strip ---- */
  const dayChrome = await page.evaluate(() => ({
    crumbs: document.querySelector('#crumbs').style.display,
    strip: document.querySelector('#cal-strip').hidden,
    calPage: document.querySelector('#page').classList.contains('cal-page'),
  }));
  assert(dayChrome.crumbs === 'none', 'day pages show no calendar breadcrumbs'); // rhizome
  assert(dayChrome.strip && !dayChrome.calPage, 'day pages carry no strip or cal-page chrome'); // rhizome

  /* ---- 3. the month node keeps the day navigation strip ---- */
  let strip = await page.evaluate(() => {
    const root = Object.values(doc.nodes).find(n => n.cal === 'root');
    const year = root.children.map(id => doc.nodes[id]).find(n => n.cal === 'year');
    const month = year.children.find(id => doc.nodes[id].cal === 'month');
    zoomTo(month);
    return new Promise(r => setTimeout(() => {
      const el = document.querySelector('#cal-strip');
      if (el.hidden) return r(null);
      r({
        count: el.querySelectorAll('.cs-day').length,
        today: !!el.querySelector('.cs-day.today'),
        hasMonthLabel: !!el.querySelector('.cs-day[data-mon]'),
        arrows: !!el.querySelector('.cs-nav'),
      });
    }, 450));
  });
  assert(strip && strip.count > 14, `month view renders a row of days (${strip?.count})`);
  assert(strip.today, 'today is highlighted in the month strip');
  assert(strip.hasMonthLabel && strip.arrows, 'strip has month labels and ‹ › navigation');

  /* ---- 4. write under today, then navigate to another day via the month strip ---- */
  await page.evaluate(() => gotoDate(todayStr()));
  await sleep(450);
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await page.keyboard.press('ArrowDown');     // start a bullet under today (empty-page nav)
  await page.keyboard.type('Daily standup notes');
  await sleep(500);
  // from the month view, click a neighboring day cell
  const before = await page.evaluate(() => Object.keys(doc.nodes).length);
  await page.evaluate(() => {
    const root = Object.values(doc.nodes).find(n => n.cal === 'root');
    const year = root.children.map(id => doc.nodes[id]).find(n => n.cal === 'year');
    const month = year.children.find(id => doc.nodes[id].cal === 'month');
    zoomTo(month);
  });
  await sleep(450);
  await page.evaluate(() => {
    const cur = document.querySelector('.cs-day.today');
    let pick = cur?.nextElementSibling;
    while (pick && !pick.classList.contains('cs-day')) pick = pick.nextElementSibling;
    if (!pick) { pick = cur?.previousElementSibling; while (pick && !pick.classList.contains('cs-day')) pick = pick.previousElementSibling; }
    pick.click();
  });
  await sleep(450);
  const navd = await page.evaluate(() => {
    const z = doc.nodes[state.zoom];
    return { isDay: z?.cal === 'day', iso: z?.cd, nodeCount: Object.keys(doc.nodes).length };
  });
  assert(navd.isDay && navd.iso !== today, `clicking a neighboring day navigates to its day node (${navd.iso})`);
  assert(navd.nodeCount > before, 'the new day node was created on demand');
  // today's note is preserved on its own day
  await page.evaluate(() => gotoDate(todayStr()));
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
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(350);
  await page.evaluate(t => {
    const n = makeNode(`Renew passport <time datetime="${t}">x</time>`);
    insertAt('root', 0, n);
    markDirty();
  }, today);
  await sleep(200);
  await page.evaluate(() => gotoDate(todayStr()));
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
    ![...document.querySelectorAll('#side-pages .side-item')].some(el => /Calendar/.test(el.textContent)));
  assert(ok, 'the Calendar container stays out of the sidebar page list'); // rhizome
  // navigate away, then use the topbar Today button
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(350);
  await page.click('#btn-calendar');
  await sleep(450);
  ok = await page.evaluate(() => state.view === 'daily' && [...document.querySelectorAll('.day-section')].some(s => N(s.dataset.day).cd === todayStr()));
  assert(ok, 'the topbar Today button opens Daily Notes with today on top'); // rhizome

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CALENDAR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
