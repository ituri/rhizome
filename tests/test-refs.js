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
  assert(/Linked References \(1\)/.test(refs.head), `linked header with count ("${refs.head}")`);
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
  assert(/Linked References \(2\)/.test(refs.head), `mention moved to linked (${refs.head})`);
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
  assert(/Linked References \(3\)/.test(refs.head), `mirror counted (${refs.head})`);
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

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL REFS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
