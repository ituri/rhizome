/* Phase-3: quick-jump uses the SQLite FTS5 index for large docs (O(matches), not an
   O(n) walk per keystroke).  Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');

  // seed filler nodes directly (their text doesn't matter), then a marker typed the real way
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++) { const id = 'fill' + i; doc.nodes[id] = { id, text: 'filler item ' + i, children: [] }; doc.nodes[HOME].children.push(id); }
    rebuildParentMap(); renderPage();
  });
  const markerId = await page.evaluate(() => { const id = opNewAt(HOME, 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); return id; });
  await page.keyboard.type('quokkazzz the unique marker');
  await page.evaluate(async () => { commitActiveText(true); markDirty(); await doSave(); }); // DOM → data → PUT → FTS5
  await sleep(400);
  void markerId;

  // reload so the client holds the authoritative server doc (the real scenario: open a
  // large outline and search it), then force the FTS path and count its calls
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await page.evaluate(() => {
    jumpFtsThreshold = 5;
    window.__ftsCalls = 0;
    const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/api/search')) window.__ftsCalls++; return f(u, o); };
  });

  // open quick-jump and type the unique word
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await page.waitForSelector('#jump-overlay:not([hidden])');
  await page.type('#jump-input', 'quokkazzz');
  await sleep(500);

  const ftsUsed = await page.evaluate(() => window.__ftsCalls > 0);
  assert(ftsUsed, 'large-doc quick-jump queried the FTS endpoint');
  const rows = await page.evaluate(() => $$('#jump-results .jump-row').map(b => b.textContent));
  assert(rows.some(t => /unique marker/.test(t)), `FTS result shown in the jump list (${rows.length} row(s))`);

  // a small doc should NOT call FTS (local walk is instant)
  await page.evaluate(() => { window.__ftsCalls = 0; jumpFtsThreshold = 100000; });
  await page.evaluate(() => { $('#jump-input').value = ''; });
  await page.type('#jump-input', 'filler');
  await sleep(300);
  assert(await page.evaluate(() => window.__ftsCalls === 0), 'small-doc quick-jump stays local (no FTS call)');

  // ── in-tree search bar: large docs filter via the FTS index, not an O(n) per-render walk ──
  await page.keyboard.press('Escape');                       // ensure quick-jump is closed
  await page.evaluate(() => { window.__ftsCalls = 0; treeFtsThreshold = 5; if (searchActive()) setSearch(''); });
  await page.focus('#search');
  await page.type('#search', 'quokkazzz');
  await sleep(600);                                          // 160ms debounce + FTS round-trip + re-render
  const tree = await page.evaluate(() => ({
    fts: window.__ftsCalls,
    cacheOk: !!(state.ftsCandidates && state.ftsCandidates.ok && Array.isArray(state.ftsCandidates.ids)),
    count: state.matchCount,
    hasMarker: !!(state.matchSet && [...state.matchSet].some(id => /unique marker/.test(plainOf(N(id).text)))),
    rendered: $$('.tree .item').length,
    total: Object.keys(doc.nodes).length,
  }));
  assert(tree.fts > 0, 'large-doc in-tree search queried the FTS endpoint');
  assert(tree.cacheOk, 'FTS candidate set was fetched and cached (candidate path, not the walk fallback)');
  assert(tree.hasMarker && tree.count >= 1, `the unique marker matched via FTS candidates (${tree.count} match)`);
  assert(tree.rendered < tree.total, `non-matching nodes were filtered out of the tree (${tree.rendered} shown of ${tree.total})`);
  // operators still work over the FTS candidate set: -<term> excludes
  await page.evaluate(() => setSearch('quokkazzz -nonexistentword'));
  await sleep(300);
  assert(await page.evaluate(() => state.matchCount >= 1), 'negation operator still applies over FTS candidates');
  await page.evaluate(() => setSearch(''));

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nSEARCH TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
