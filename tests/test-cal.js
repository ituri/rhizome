/* Journal storage: Year/Month/Day hierarchy under the calendar container, day
   pages behaving as normal pages, dated items surfacing as linked references.
   (Rhizome removed the calendar strip/overview — dates are day-page links.) */
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
  const [Y, M] = today.split('-').map(Number);

  /* ---- 1. gotoDate builds Calendar > Year > Month > Day and zooms in ---- */
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
  assert(built && /Calendar/.test(built.rootText), 'gotoDate creates a "Calendar" root node');
  assert(built.year === Y && built.month === M - 1 && built.dayIso === today,
    `Calendar › ${Y} › ${M} › ${today} hierarchy built`);
  assert(built.zoomedDay === today, 'gotoDate zooms into today\'s day node');
  assert(/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/.test(built.title),
    `day title is a Roam date ("${built.title}")`);

  /* ---- 2. a day page is a normal page: no calendar crumbs, no strip ---- */
  const dayChrome = await page.evaluate(() => ({
    crumbs: document.querySelector('#crumbs').style.display,
    strip: document.querySelector('#cal-strip').hidden,
    calPage: document.querySelector('#page').classList.contains('cal-page'),
  }));
  assert(dayChrome.crumbs === 'none', 'day pages show no calendar breadcrumbs');
  assert(dayChrome.strip && !dayChrome.calPage, 'day pages carry no strip or cal-page chrome');

  /* ---- 3. each day keeps its own content across navigation ---- */
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await page.keyboard.press('ArrowDown');     // start a bullet under today (empty-page nav)
  await page.keyboard.type('Daily standup notes');
  await sleep(500);
  // navigate to another day, then back — the note stays on today's page
  await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); gotoDate(isoOf(d)); });
  await sleep(450);
  const other = await page.evaluate(() => ({
    isDay: N(state.zoom)?.cal === 'day',
    iso: N(state.zoom)?.cd,
    empty: kidsOf(state.zoom).every(id => !plainOf(N(id).text).trim()),
  }));
  assert(other.isDay && other.iso !== today, `gotoDate opens a fresh day page (${other.iso})`);
  await page.evaluate(() => gotoDate(todayStr()));
  await sleep(450);
  let ok = await page.evaluate(() =>
    kidsOf(state.zoom).some(id => plainOf(doc.nodes[id].text).includes('Daily standup notes')));
  assert(ok, 'each day keeps its own content (today still has its note)');

  /* ---- 4. items linked to a day surface under that day's Linked References ---- */
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(350);
  await page.evaluate(t => {
    snapshot();
    const day = ensureDay(t);
    const n = makeNode(`Renew passport <a href="#/n/${day}" rel="noopener">${roamDateLabel(t)}</a>`);
    insertAt('root', 0, n);
    markDirty();
  }, today);
  await sleep(200);
  await page.evaluate(() => gotoDate(todayStr()));
  await sleep(450);
  ok = await page.evaluate(() =>
    [...document.querySelectorAll('#backlinks .ref-row')].some(r => /Renew passport/.test(r.textContent)));
  assert(ok, 'items linked to today surface under today\'s Linked References');

  /* ---- 5. date search still finds day-linked items ---- */
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(300);
  ok = await page.evaluate(() => {
    setSearch('date:today');
    return state.matchCount >= 1;
  });
  assert(ok, 'date:today search matches items linked to today');
  await page.evaluate(() => setSearch(''));
  await sleep(120);

  /* ---- 6. the Calendar container stays out of the sidebar; topbar button opens Daily Notes ---- */
  await page.evaluate(() => { settings.sidebar = true; applyTheme(); renderSidebar(); });
  await sleep(200);
  ok = await page.evaluate(() =>
    ![...document.querySelectorAll('#side-pages .side-item')].some(el => /Calendar/.test(el.textContent)));
  assert(ok, 'the Calendar container stays out of the sidebar page list');
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(350);
  await page.click('#btn-calendar');
  await sleep(300);
  ok = await page.evaluate(() => !!document.querySelector('.datepick .dp-day'));
  assert(ok, 'the topbar button opens a date picker'); // rhizome
  await page.evaluate(() => document.querySelector('.datepick .dp-day.today').click());
  await sleep(450);
  ok = await page.evaluate(() => N(state.zoom)?.cal === 'day' && N(state.zoom)?.cd === todayStr());
  assert(ok, 'picking today jumps to today\'s journal page');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CALENDAR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
