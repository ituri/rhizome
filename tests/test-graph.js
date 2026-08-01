/* Graph view: the left-sidebar "Graph" item renders a force-directed canvas of pages, with
   edges from [[links]] and #tags. Hover/zoom are visual; here we assert the data (nodes,
   edges built from real references), the wiring (route, sidebar, title) and that clicking a
   node navigates to its page. Fresh server on 3211. */
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

  // three pages: Alpha links to Beta (anchor) and tags #Gamma → two edges from Alpha
  const ids = await page.evaluate(() => {
    snapshot();
    const a = getOrCreatePage('Alpha');
    const b = getOrCreatePage('Beta');
    const c = getOrCreatePage('Gamma');
    insertAt(a, 0, makeNode(`linked <a href="#/n/${b}">Beta</a> and tagged <span class="tag" data-tag="#Gamma">#Gamma</span>`));
    markDirty(); renderPage();
    return { a, b, c };
  });
  await sleep(300);

  // the data layer: nodes for the pages, edges for both reference styles
  const data = await page.evaluate(i => {
    const d = buildGraphData(false);
    const idx = Object.fromEntries(d.nodes.map((n, k) => [n.id, k]));
    const has = (x, y) => d.edges.some(e => (e.a === idx[x] && e.b === idx[y]) || (e.a === idx[y] && e.b === idx[x]));
    return {
      n: d.nodes.length,
      hasAll: [i.a, i.b, i.c].every(id => idx[id] !== undefined),
      linkEdge: has(i.a, i.b),
      tagEdge: has(i.a, i.c),
      noDays: d.nodes.every(n => !n.day),
    };
  }, ids);
  ok(data.hasAll, 'all three pages are graph nodes');
  ok(data.linkEdge, 'a resolved [[link]] becomes an edge');
  ok(data.tagEdge, 'a #tag of a page title becomes an edge');
  ok(data.noDays, 'journal days are excluded when the toggle is off');

  // with daily notes on, day pages (with content) join the graph
  const withDays = await page.evaluate(() => {
    snapshot();
    const day = ensureDay(todayStr());
    insertAt(day, 0, makeNode('a journal thought'));
    markDirty();
    return buildGraphData(true).nodes.some(n => n.day);
  });
  ok(withDays, 'the Daily-notes toggle adds journal days as nodes');

  // wiring: sidebar link, route, title, canvas
  const link = await page.evaluate(() => { const a = document.querySelector('#side-graph'); return a ? a.getAttribute('href') : null; });
  ok(link === '#/graph', `sidebar has a Graph nav link → #/graph (${link})`);
  await page.evaluate(() => { location.hash = '#/graph'; });
  await page.waitForSelector('.graph-view .graph-canvas', { timeout: 5000 });
  await sleep(600);   // let the simulation settle a little
  ok(await page.$('#side-graph.current') !== null, 'sidebar Graph link is highlighted as current');
  ok((await page.title()) === 'Graph — Rhizome', 'document title is "Graph — Rhizome"');
  const painted = await page.evaluate(() => {
    const cv = document.querySelector('.graph-canvas');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true;   // any non-transparent pixel
    return false;
  });
  ok(painted, 'the canvas actually drew something');

  // clicking a node navigates to its page: synthesize a tap on a known node's screen position
  const nav = await page.evaluate(i => {
    const cv = document.querySelector('.graph-canvas');
    const inst = window.__graphProbe?.();
    if (!inst) return 'no probe';
    const n = inst.nodes.find(x => x.id === i.a);
    const p = inst.screenOf(n);
    const r = cv.getBoundingClientRect();
    const ev = t => new PointerEvent(t, { bubbles: true, pointerId: 1, clientX: r.left + p.x, clientY: r.top + p.y });
    cv.dispatchEvent(ev('pointerdown'));
    cv.dispatchEvent(ev('pointerup'));
    return location.hash;
  }, ids);
  ok(nav === '#/n/' + ids.a, `clicking the Alpha node navigates to it (${nav})`);

  await browser.close();
  console.log(fl ? `\n${fl} GRAPH TESTS FAILING` : '\nGRAPH TESTS PASSED');
  process.exit(fl ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
