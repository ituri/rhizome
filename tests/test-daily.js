/* Rhizome daily-notes view: today auto-created, stacked day sections,
   infinite scroll, day-boundary guards, header zoom. */
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
  await page.waitForSelector('.day-section, .tree .item .content');
  await sleep(500);

  const today = await page.evaluate(() => todayStr());

  /* ---- 1. #/ shows today's section and built the calendar hierarchy ---- */
  let info = await page.evaluate(() => {
    const sec = document.querySelector('.day-section');
    const dayId = sec?.dataset.day;
    return {
      view: state.view,
      title: sec?.querySelector('.day-title')?.textContent,
      cd: dayId ? N(dayId).cd : null,
      calBuilt: !!Object.values(doc.nodes).find(n => n.cal === 'root'),
      docTitle: document.title,
    };
  });
  assert(info.view === 'daily', 'landing on #/ activates the daily view');
  assert(info.cd === today, "today's day section is mounted");
  assert(/^\w+ \d{1,2}(st|nd|rd|th), \d{4}$/.test(info.title || ''), `day header is Roam-titled ("${info.title}")`);
  assert(info.calBuilt, 'the calendar hierarchy was auto-created');
  assert(/Daily Notes/.test(info.docTitle), `document title is the view ("${info.docTitle}")`);

  /* ---- 2. writing in today's section persists under the day node ---- */
  await page.click('.day-section .day-empty');
  await sleep(250);
  await page.keyboard.type('erster Gedanke');
  await sleep(300);
  await page.keyboard.press('Enter');
  await page.keyboard.type('zweiter Gedanke');
  await sleep(700);
  info = await page.evaluate(t => {
    const day = findDay(t);
    return { kids: kidsOf(day).map(id => plainOf(N(id).text).trim()), parentOk: parentOf(day) && N(parentOf(day)).cal === 'month' };
  }, today);
  assert(info.kids.join('|') === 'erster Gedanke|zweiter Gedanke', `typing lands under today (${info.kids.join('|')})`);
  assert(info.parentOk, 'day node stays inside the calendar hierarchy');
  await page.waitForFunction(() =>
    document.querySelector('#save-state .save-label')?.textContent === 'saved' && !dirty, { timeout: 8000 });
  const early = await page.evaluate(async () => {
    const { doc: d, version } = await (await fetch('/api/doc')).json();
    return { hits: Object.values(d.nodes).filter(n => /erster Gedanke/.test(n.text || '')).length,
             srvVersion: version, cliVersion: state.version };
  });
  assert(early.hits === 1, `note reached the server right after typing (${JSON.stringify(early)})`);

  /* ---- 3. older days stack below; empty days are skipped; scroll loads more ---- */
  await page.evaluate(() => {
    const iso = n => { const d = new Date(); d.setDate(d.getDate() - n); return isoOf(d); };
    snapshot();
    for (let n = 1; n <= 20; n++) {
      const day = ensureDay(iso(n));
      if (n === 3) continue; // day -3 stays empty → must not appear
      const kid = makeNode('note vom Tag -' + n);
      insertAt(day, 0, kid);
    }
    markDirty();
    location.hash = '#/pages'; // leave and re-enter to reset the scroll window
  });
  await sleep(400);
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(800); // the observer auto-fills the viewport in 4-section steps
  info = await page.evaluate(() => ({
    sections: [...document.querySelectorAll('.day-section')].map(s => N(s.dataset.day).cd),
    sentinel: !!document.querySelector('#daily-sentinel'),
    total: dailyDayList().length,
  }));
  assert(info.total === 20, `20 non-empty days exist (${info.total})`); // 21 seeded, one empty
  assert(info.sections.length >= 4 && info.sections.length < 20,
    `a partial window is mounted and auto-filled (${info.sections.length}/20)`);
  assert(info.sections[0] === today, 'today is on top');
  const isDesc = info.sections.every((cd, i) => i === 0 || info.sections[i - 1] > cd);
  assert(isDesc, 'sections are newest-first');
  assert(info.sentinel, 'scroll sentinel is mounted below the stack');
  const iso3 = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 3); return isoOf(d); });
  const deeper = info.sections.filter(cd => cd < iso3).length;
  assert(deeper > 0 && !info.sections.includes(iso3), 'the empty day is skipped in the stack');

  const before = info.sections.length;
  await page.evaluate(() => { document.querySelector('#daily-sentinel')?.scrollIntoView(); });
  await sleep(700);
  const after = await page.evaluate(() => document.querySelectorAll('.day-section').length);
  assert(after > before, `scrolling the sentinel loads more sections (${before} → ${after})`);

  /* ---- 4. Shift+Tab cannot escape a day section ---- */
  const guard = await page.evaluate(t => {
    const day = findDay(t);
    const first = kidsOf(day)[0];
    const before = parentOf(first);
    opOutdent(first, null);
    return { same: parentOf(first) === before && before === day };
  }, today);
  assert(guard.same, 'outdent on a day-top bullet is a no-op');

  /* ---- 5. Backspace at the start of a day's first bullet never merges into the previous day ---- */
  const merge = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.day-section')];
    const second = secs[1]; // an older day with content
    const dayId = second.dataset.day;
    const firstKid = kidsOf(dayId)[0];
    const el = second.querySelector('.item .content');
    el.focus();
    const ctx = editableCtx(el);
    const textBefore = plainOf(N(firstKid).text);
    opMergeBack(ctx);
    return {
      stillThere: !!doc.nodes[firstKid] && parentOf(firstKid) === dayId,
      textSame: plainOf(N(firstKid).text) === textBefore,
    };
  });
  assert(merge.stillThere && merge.textSame, 'cross-day merge-back is blocked');

  /* ---- 6. blank-space click writes into today, never creates a page ---- */
  info = await page.evaluate(t => {
    const rootKidsBefore = kidsOf(ROOT).length;
    const todayKidsBefore = kidsOf(findDay(t)).length;
    pageEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return new Promise(r => setTimeout(() => r({
      rootDelta: kidsOf(ROOT).length - rootKidsBefore,
      todayDelta: kidsOf(findDay(t)).length - todayKidsBefore,
    }), 300));
  }, today);
  assert(info.rootDelta === 0 && info.todayDelta === 1, `blank click appends to today (root Δ${info.rootDelta}, today Δ${info.todayDelta})`);

  /* ---- 7. day header zooms into the day page; Today button returns to #/ ---- */
  await page.click('.day-section .day-title');
  await sleep(500);
  info = await page.evaluate(() => ({
    zoomIsDay: N(state.zoom)?.cal === 'day',
    strip: !document.querySelector('#cal-strip').hidden,
    view: state.view,
  }));
  assert(info.zoomIsDay && info.view === null, 'clicking a day header zooms into the day page');
  assert(info.strip, 'the calendar strip appears on a zoomed day');
  await page.click('#btn-calendar');
  await sleep(500);
  info = await page.evaluate(() => ({ view: state.view, sections: document.querySelectorAll('.day-section').length }));
  assert(info.view === 'daily' && info.sections >= 1, 'the topbar calendar button returns to Daily Notes');

  /* ---- 8. everything persists across a reload ---- */
  await page.waitForFunction(() =>
    document.querySelector('#save-state .save-label')?.textContent === 'saved' && !dirty, { timeout: 8000 });
  const onServer = await page.evaluate(async () => {
    const { doc: d } = await (await fetch('/api/doc')).json();
    return Object.values(d.nodes).filter(n => /erster Gedanke/.test(n.text || '')).length;
  });
  assert(onServer === 1, `today's note reached the server before reload (${onServer})`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.day-section');
  await sleep(500);
  info = await page.evaluate(t => ({
    kids: kidsOf(findDay(t)).map(id => plainOf(N(id).text).trim()).filter(Boolean),
    sections: document.querySelectorAll('.day-section').length,
  }), today);
  assert(info.kids.includes('erster Gedanke') && info.kids.includes('zweiter Gedanke'), `today’s notes survive a reload (kids: ${JSON.stringify(info.kids)})`);
  assert(info.sections >= 4, `the daily stack renders after reload (${info.sections})`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DAILY TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
