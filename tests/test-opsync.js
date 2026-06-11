/* Phase-2 client op-sync: two browser clients converge through the real server via
   /api/ops + the SSE op broadcast (no whole-doc transfer).  Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const hasText = t => `Object.values(doc.nodes).some(n => plainOf(n.text).includes(${JSON.stringify(t)}))`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const A = await browser.newPage();
  const B = await browser.newPage();
  for (const p of [A, B]) { p.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; }); }
  await A.goto(URL, { waitUntil: 'domcontentloaded' }); await A.waitForSelector('.tree .item .content');
  await B.goto(URL, { waitUntil: 'domcontentloaded' }); await B.waitForSelector('.tree .item .content');
  await sleep(500);
  // enable op delta-sync on both clients
  await A.evaluate(() => { settings.opSync = true; });
  await B.evaluate(() => { settings.opSync = true; });

  // 1. A creates + types an item → propagates to B via an op broadcast (not a refetch)
  await A.evaluate(() => { const id = opNewAt('root', kidsOf('root').length); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await A.keyboard.type('alpha-from-A');
  await sleep(1200); // debounced save → POST /api/ops → SSE → B applies
  assert(await B.evaluate(hasText('alpha-from-A')), 'A→B: an op-synced edit reached B');

  // 2. B creates an item → propagates to A
  await B.evaluate(() => { const id = opNewAt('root', kidsOf('root').length); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await B.keyboard.type('beta-from-B');
  await sleep(1200);
  assert(await A.evaluate(hasText('beta-from-B')), 'B→A: an op-synced edit reached A');

  // 3. both converged: each has both items
  const countBoth = () => Object.values(doc.nodes).filter(n => /alpha-from-A|beta-from-B/.test(plainOf(n.text))).length;
  const bothA = await A.evaluate(countBoth);
  const bothB = await B.evaluate(countBoth);
  assert(bothA === 2 && bothB === 2, `both clients hold both items (A=${bothA}, B=${bothB})`);

  // 4. an edit to an existing node (update op) converges
  await A.evaluate(() => {
    const id = Object.keys(doc.nodes).find(k => plainOf(doc.nodes[k].text).includes('beta-from-B'));
    const el = document.querySelector(`.item[data-id="${id}"] .content`); el.focus();
    setCaretOffset(el, 'end');
  });
  await A.keyboard.type('-edited');
  await sleep(1200);
  assert(await B.evaluate(hasText('beta-from-B-edited')), 'update op on A converged to B');

  // 5. the live trees match exactly (id → parent → text), proving convergence
  const treeOf = () => `(() => { const pm = {}; for (const id in doc.nodes) for (const c of (doc.nodes[id].children||[])) pm[c]=id;
    return JSON.stringify(Object.keys(doc.nodes).sort().map(id => [id, pm[id]||null, plainOf(doc.nodes[id].text)])); })()`;
  const ta = await A.evaluate(treeOf), tb = await B.evaluate(treeOf);
  assert(ta === tb, 'live trees are byte-identical across the two clients');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOP-SYNC TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
