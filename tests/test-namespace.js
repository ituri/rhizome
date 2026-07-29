/* Roam-style namespaces ("Foo/Bar" page titles): inline refs show only the leaf with a dimmed/
   hideable prefix span, All-Pages groups by top-level namespace, the sidebar marks namespaced
   pages, and {{query: {namespace:Foo}}} / search "namespace:Foo" list a namespace. Server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fl = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fl++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1300, height: 900 } });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); fl++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);

  // pure helper: splitNamespace
  const split = await page.evaluate(() => ({
    plain: window.splitNamespace('Just A Page'),
    ns: window.splitNamespace('Book/How To Take Smart Notes'),
    nested: window.splitNamespace('A/B/C'),
    lead: window.splitNamespace('/leading'),
    trail: window.splitNamespace('trailing/'),
  }));
  ok(split.plain === null, 'splitNamespace: a plain title has no namespace');
  ok(split.ns && split.ns.prefix === 'Book/' && split.ns.leaf === 'How To Take Smart Notes' && split.ns.top === 'Book', 'splitNamespace: Foo/Bar → prefix "Book/", leaf, top "Book"');
  ok(split.nested && split.nested.prefix === 'A/B/' && split.nested.leaf === 'C' && split.nested.top === 'A', 'splitNamespace: nested A/B/C → leaf C, top A');
  ok(split.lead === null && split.trail === null, 'splitNamespace: leading/trailing slash is not a namespace');

  // build three namespaced pages + one plain, and a block that links [[Book/How To Take Smart Notes]]
  const ids = await page.evaluate(() => {
    snapshot();
    const b1 = getOrCreatePage('Book/How To Take Smart Notes');
    const b2 = getOrCreatePage('Book/Deep Work');
    getOrCreatePage('Article/Chaos Engineering');
    getOrCreatePage('Plain Page');
    // a bullet on the daily note that links to a namespaced page
    const day = ensureDayId(todayStr());
    const link = makeNode(`See <a href="#/n/${b1}">Book/How To Take Smart Notes</a> today`);
    insertAt(day, 0, link);
    markDirty(); renderPage();
    return { b1, b2, link, day };
  });
  await sleep(300);

  // inline ref (rendered as a normal bullet on the day page): leaf shown, prefix in a dimmed span
  await page.evaluate(i => { location.hash = '#/n/' + i.day; }, ids);
  await page.waitForSelector('.tree .item .content', { timeout: 5000 });
  await sleep(300);
  const ref = await page.evaluate(() => {
    const a = document.querySelector('.tree .content a.ns-ref[href^="#/n/"]');
    if (!a) return null;
    const pre = a.querySelector('.ns-prefix'), leaf = a.querySelector('.ns-leaf');
    return { ns: a.getAttribute('data-ns'), pre: pre?.textContent, leaf: leaf?.textContent, preHidden: pre ? getComputedStyle(pre).display === 'none' : null };
  });
  ok(ref && ref.pre === 'Book/' && ref.leaf === 'How To Take Smart Notes', `inline ref splits into prefix "Book/" + leaf (${JSON.stringify(ref)})`);
  ok(ref && ref.preHidden === false, 'inline ref: prefix is visible (dimmed) by default');

  // "Abbreviate namespaces" setting hides the prefix entirely
  await page.evaluate(() => { settings.nsAbbrev = true; applyTheme(); renderPage(); });
  await sleep(200);
  const hidden = await page.evaluate(() => { const p = document.querySelector('.content a.ns-ref .ns-prefix'); return p ? getComputedStyle(p).display === 'none' : null; });
  ok(hidden === true, 'setting nsAbbrev=true hides the "Foo/" prefix (leaf-only display)');
  await page.evaluate(() => { settings.nsAbbrev = false; applyTheme(); renderPage(); });

  // All Pages: a group header per top-level namespace when sorted by title, children indented
  await page.evaluate(() => { location.hash = '#/pages'; });
  await page.waitForSelector('.pages-table', { timeout: 5000 });
  // force title sort (click the Title header)
  await page.evaluate(() => { const th = [...document.querySelectorAll('.pages-table th')].find(t => /Title/.test(t.textContent)); th.click(); });
  await sleep(200);
  const groups = await page.evaluate(() => [...document.querySelectorAll('.pages-table tr.ns-group td')].map(td => td.textContent));
  ok(groups.includes('Article/') && groups.includes('Book/'), `All Pages shows namespace group headers (${JSON.stringify(groups)})`);
  const childLeaf = await page.evaluate(() => { const a = document.querySelector('.pages-table tr.ns-child a.ns-ref .ns-leaf'); return a?.textContent; });
  ok(!!childLeaf, `All Pages namespaced rows render a leaf label (${childLeaf})`);

  // sidebar marks namespaced pages
  const sideNs = await page.evaluate(() => document.querySelectorAll('#side-pages .side-page.ns-child').length);
  ok(sideNs >= 2, `sidebar marks namespaced pages with .ns-child (${sideNs})`);

  // query filter: {{query: {namespace:Book}}} lists exactly the two Book/* pages
  const q = await page.evaluate(() => {
    const ok1 = window.nodeMatchesCond(findPageByTitle('Book/Deep Work'), { kind: 'namespace', value: 'book', neg: false });
    const ok2 = window.nodeMatchesCond(findPageByTitle('Book/How To Take Smart Notes'), { kind: 'namespace', value: 'book/', neg: false });
    const no = window.nodeMatchesCond(findPageByTitle('Article/Chaos Engineering'), { kind: 'namespace', value: 'book', neg: false });
    const plainNo = window.nodeMatchesCond(findPageByTitle('Plain Page'), { kind: 'namespace', value: 'book', neg: false });
    const ast = window.parseLiveQuery('{{query: {namespace:Book}}}');
    const res = window.evalLiveQuery(ast, 'nope').map(id => plainOf(doc.nodes[id].text).trim()).filter(t => /^Book\//.test(t)).sort();
    return { ok1, ok2, no, plainNo, res };
  });
  ok(q.ok1 && q.ok2 && !q.no && !q.plainNo, 'namespace cond matches Book/* titles, rejects Article/* and plain pages (accepts "Book" and "Book/")');
  ok(JSON.stringify(q.res) === JSON.stringify(['Book/Deep Work', 'Book/How To Take Smart Notes']), `{{query:{namespace:Book}}} lists both Book pages (${JSON.stringify(q.res)})`);

  await browser.close();
  console.log(fl ? `\n${fl} NAMESPACE TESTS FAILING` : '\nNAMESPACE TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
