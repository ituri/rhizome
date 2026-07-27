/* Rhizome references: linked references grouped by page, mirror rows,
   lazy unlinked-references scan with one-click linking. */
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
  await page.waitForSelector('.day-section');
  await sleep(400);

  /* ---- setup: two pages, a linking bullet, an unlinked mention ---- */
  await page.evaluate(() => {
    snapshot();
    const alpha = getOrCreatePage('Alpha Projekt');
    const beta = getOrCreatePage('Beta Sammlung');
    window.__alpha = alpha; window.__beta = beta;
    // linked reference: bullet in Beta linking to Alpha
    const linked = makeNode('siehe <a href="#/n/' + alpha + '" rel="noopener">Alpha Projekt</a> für Details');
    insertAt(beta, 0, linked);
    // unlinked mention: plain text, different casing
    const plain = makeNode('das alpha projekt braucht noch Doku');
    insertAt(beta, 1, plain);
    window.__plain = plain;
    // a mention inside Alpha itself — must NOT appear as a reference
    const inner = makeNode('Alpha Projekt interne Notiz');
    insertAt(alpha, 0, inner);
    markDirty();
    zoomTo(alpha);
  });
  await sleep(500);

  /* ---- 1. linked references, grouped by containing page ---- */
  let refs = await page.evaluate(() => ({
    head: document.querySelector('#backlinks h3')?.textContent,
    groups: [...document.querySelectorAll('#backlinks .ref-group')].map(g => ({
      page: g.querySelector('.ref-page')?.textContent,
      rows: [...g.querySelectorAll('.ref-row')].map(r => r.textContent.trim()),
    })),
  }));
  assert(/^1 Linked Reference$/.test(refs.head || ''), `linked header with count ("${refs.head}")`);
  assert(refs.groups.length === 1 && refs.groups[0].page === 'Beta Sammlung', 'reference grouped under its page');
  assert(refs.groups[0].rows[0].includes('für Details'), 'the referencing bullet text is shown');

  /* ---- 2. unlinked references: lazy scan on expand ---- */
  const lazyBefore = await page.evaluate(() => document.querySelector('.unlinked-body').children.length);
  assert(lazyBefore === 0, 'unlinked scan does not run before expanding');
  await page.click('.unlinked-head');
  await sleep(300);
  refs = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.unlinked-row .unlinked-text')].map(r => r.textContent),
  }));
  assert(refs.rows.length === 1 && /alpha projekt braucht/.test(refs.rows[0]),
    `case-insensitive unlinked mention found (${JSON.stringify(refs.rows)})`);
  assert(!refs.rows.some(t => /interne Notiz/.test(t)), "the page's own subtree is excluded");

  /* ---- 3. one-click Link converts the mention ---- */
  await page.evaluate(() => { document.querySelector('.unlinked-link-btn').click(); });
  await sleep(500);
  refs = await page.evaluate(() => ({
    head: document.querySelector('#backlinks h3')?.textContent,
    text: N(window.__plain).text,
    rowCount: [...document.querySelectorAll('#backlinks .ref-group .ref-row')].length,
  }));
  assert(/^2 Linked References$/.test(refs.head || ''), `mention moved to linked (${refs.head})`);
  assert(new RegExp('<a href="#/n/' + await page.evaluate(() => window.__alpha) + '"[^>]*>alpha projekt</a>').test(refs.text),
    `text got an internal link with original casing (${refs.text})`);

  /* ---- 4. mirror rows appear as linked references ---- */
  await page.evaluate(() => {
    snapshot();
    const gamma = getOrCreatePage('Gamma Ablage');
    const m = makeNode('', { mirror: window.__alpha });
    insertAt(gamma, 0, m);
    markDirty();
    renderPage();
  });
  await sleep(400);
  refs = await page.evaluate(() => ({
    head: document.querySelector('#backlinks h3')?.textContent,
    mirrorRow: [...document.querySelectorAll('#backlinks .ref-row')].some(r => /mirrored in/.test(r.textContent)),
  }));
  assert(/^3 Linked References$/.test(refs.head || ''), `mirror counted (${refs.head})`);
  assert(refs.mirrorRow, 'mirror shown as a "mirrored in" row');

  /* ---- 5. day pages get references too; calendar titles are not "mentions" ---- */
  await page.evaluate(() => {
    snapshot();
    const day = ensureDay(todayStr());
    const b = makeNode('heute an <a href="#/n/' + window.__alpha + '" rel="noopener">Alpha Projekt</a> gearbeitet');
    insertAt(day, 0, b);
    markDirty();
    gotoDate(todayStr());
  });
  await sleep(500);
  refs = await page.evaluate(() => ({
    zoomIsDay: N(state.zoom)?.cal === 'day',
    visible: !document.querySelector('#backlinks').hidden,
  }));
  assert(refs.zoomIsDay, 'zoomed into today');
  await page.evaluate(() => zoomTo(window.__alpha));
  await sleep(400);
  refs = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('#backlinks .ref-group .ref-page')].map(a => a.textContent),
  }));
  assert(refs.groups.some(t => /\d{4}/.test(t)), `day page appears as a reference group (${JSON.stringify(refs.groups)})`);

  /* ---- 6. the daily view shows per-day linked references ---- */
  await page.evaluate(() => {
    snapshot();
    const seite = getOrCreatePage('Testseite');
    const day = ensureDay(todayStr());
    const b = makeNode('heute: <a href="#/n/' + day + '" rel="noopener">' + roamDateLabel(todayStr()) + '</a>');
    insertAt(seite, 0, b);
    markDirty();
    location.hash = '#/';
  });
  await sleep(600);
  refs = await page.evaluate(() => {
    const todaySec = [...document.querySelectorAll('.day-section')].find(s => N(s.dataset.day).cd === todayStr());
    const box = todaySec?.querySelector('.day-refs');
    return {
      head: box?.querySelector('h3')?.textContent || null,
      group: box?.querySelector('.ref-page')?.textContent || null,
      bullet: box?.querySelector('.ref-row')?.textContent || null,
    };
  });
  assert(refs.head && /^\d+ Linked Reference/.test(refs.head), `today's day section shows references ("${refs.head}")`);
  assert(refs.group === 'Testseite', `reference grouped under the linking page ("${refs.group}")`);
  assert(/heute:/.test(refs.bullet || ''), 'the referencing bullet renders in the day section');

  /* ---- 7. Roam-style filter bar on the Linked References section ---- */
  await page.evaluate(() => {
    snapshot();
    const tgt = getOrCreatePage('FilterTarget');
    const tagPage = getOrCreatePage('SidePage');
    const src = getOrCreatePage('FilterSrc');
    window.__tgt = tgt;
    const link = t => '<a href="#/n/' + t + '" rel="noopener">x</a>';
    insertAt(src, 0, makeNode('a ' + link(tgt) + ' #done'));                    // done
    insertAt(src, 1, makeNode('b ' + link(tgt) + ' #todo'));                    // todo
    insertAt(src, 2, makeNode('c ' + link(tgt) + ' #done ' + link(tagPage)));   // done + SidePage
    markDirty();
    zoomTo(tgt);
  });
  await sleep(500);

  // filter starts collapsed; the funnel button is present because there are filterable tags
  let f = await page.evaluate(() => ({
    hasBtn: !!document.querySelector('.ref-filter-btn'),
    barOpen: !!document.querySelector('.ref-filter-bar'),
    head: document.querySelector('#backlinks h3')?.textContent,
  }));
  assert(f.hasBtn, 'filter funnel button is shown when tags exist');
  assert(!f.barOpen, 'filter chip bar starts collapsed');
  assert(/^3 Linked References$/.test(f.head || ''), `all 3 refs shown initially (${f.head})`);

  // open the bar → chips for #done (2), #todo (1) and the SidePage link (1), sorted by count
  await page.click('.ref-filter-btn');
  await sleep(200);
  f = await page.evaluate(() => [...document.querySelectorAll('.ref-filter-chip')]
    .map(c => c.textContent.replace(/(\d+)$/, ' ($1)')));
  assert(f.some(t => /^#done \(2\)/.test(t)), `#done chip with count 2 (${JSON.stringify(f)})`);
  assert(f.some(t => /^#todo \(1\)/.test(t)), '#todo chip with count 1');
  assert(f.some(t => /^SidePage \(1\)/.test(t)), 'page-link chip labelled by title');
  assert(!f.some(t => /FilterTarget/.test(t)), "the page's own link is not offered as a filter");

  const clickChip = label => page.evaluate(l => {
    const chip = [...document.querySelectorAll('.ref-filter-chip')].find(c => c.textContent.startsWith(l));
    chip.click();
  }, label);

  // include #done → only the two #done rows remain
  await clickChip('#done'); await sleep(200);
  f = await page.evaluate(() => ({
    head: document.querySelector('#backlinks h3')?.textContent,
    rows: [...document.querySelectorAll('#backlinks .ref-row')].map(r => r.textContent.trim()[0]),
    cls: document.querySelector('.ref-filter-chip')?.className,
  }));
  assert(/^2 Linked References$/.test(f.head || ''), `include #done → 2 refs (${f.head})`);
  assert(f.rows.sort().join('') === 'ac', `only the #done bullets (a, c) shown (${JSON.stringify(f.rows)})`);
  assert(/include/.test(f.cls || ''), 'the #done chip shows the include state');

  // second click → exclude #done → only the #todo row remains
  await clickChip('#done'); await sleep(200);
  f = await page.evaluate(() => ({
    head: document.querySelector('#backlinks h3')?.textContent,
    rows: [...document.querySelectorAll('#backlinks .ref-row')].map(r => r.textContent.trim()[0]),
    cls: document.querySelector('.ref-filter-chip')?.className,
  }));
  assert(/^1 Linked Reference$/.test(f.head || ''), `exclude #done → 1 ref (${f.head})`);
  assert(f.rows.join('') === 'b', `only the non-#done bullet (b) shown (${JSON.stringify(f.rows)})`);
  assert(/exclude/.test(f.cls || ''), 'the #done chip shows the exclude state');

  // third click → cleared → all three again, funnel no longer marked active
  await clickChip('#done'); await sleep(200);
  f = await page.evaluate(() => ({
    head: document.querySelector('#backlinks h3')?.textContent,
    active: !!document.querySelector('.ref-filter-btn.active'),
  }));
  assert(/^3 Linked References$/.test(f.head || ''), `clearing the chip restores all refs (${f.head})`);
  assert(!f.active, 'funnel no longer active once the filter is cleared');

  // navigating away resets the filter
  await clickChip('#done'); await sleep(150);           // set an include filter again
  await page.evaluate(() => zoomTo(window.__alpha));
  await sleep(300);
  await page.evaluate(() => zoomTo(window.__tgt));
  await sleep(300);
  f = await page.evaluate(() => ({
    head: document.querySelector('#backlinks h3')?.textContent,
    barOpen: !!document.querySelector('.ref-filter-bar'),
  }));
  assert(/^3 Linked References$/.test(f.head || ''), `filter reset after navigation (${f.head})`);
  assert(!f.barOpen, 'filter bar collapsed again after navigation');

  /* ---- 8. the filter bar also works inside the daily view's per-day references ---- */
  await page.evaluate(() => {
    snapshot();
    const day = ensureDay(todayStr());
    const src = getOrCreatePage('DayFilterSrc');
    const link = '<a href="#/n/' + day + '">' + roamDateLabel(todayStr()) + '</a>';
    insertAt(src, 0, makeNode('x ' + link + ' #alpha'));
    insertAt(src, 1, makeNode('y ' + link + ' #beta'));
    markDirty();
    location.hash = '#/';
  });
  await sleep(700);
  let dv = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('.day-section')].find(s => N(s.dataset.day).cd === todayStr());
    const box = sec.querySelector('.day-refs');
    return { has: !!box.querySelector('.ref-filter-btn') };
  });
  assert(dv.has, 'daily view per-day references have a filter funnel');
  await page.evaluate(() => {
    const sec = [...document.querySelectorAll('.day-section')].find(s => N(s.dataset.day).cd === todayStr());
    sec.querySelector('.day-refs .ref-filter-btn').click();
  });
  await sleep(200);
  await page.evaluate(() => {
    const sec = [...document.querySelectorAll('.day-section')].find(s => N(s.dataset.day).cd === todayStr());
    [...sec.querySelectorAll('.ref-filter-chip')].find(c => c.textContent.startsWith('#alpha')).click();
  });
  await sleep(300);
  dv = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('.day-section')].find(s => N(s.dataset.day).cd === todayStr());
    const box = sec.querySelector('.day-refs');
    return { head: box.querySelector('h3').textContent, rows: [...box.querySelectorAll('.ref-row')].map(r => r.textContent.trim()[0]) };
  });
  assert(/^1 Linked Reference$/.test(dv.head || ''), `daily filter #alpha → 1 ref (${dv.head})`);
  assert(dv.rows.join('') === 'x', `only the #alpha bullet shown in the day (${JSON.stringify(dv.rows)})`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL REFS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
