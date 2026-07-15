/* Alt+Shift+↑/↓ move: descending into an expanded neighbour (bug #31). */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR: ' + e.message); failures++; });
  await page.goto(URL + '#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(300);

  const move = (id, dir) => page.evaluate((id, dir) => {
    opMoveVert(id, dir, { id, field: 'text', offset: 0, host: null });
  }, id, dir);

  // --- UP into an expanded previous sibling: B should become A's LAST child (level 2) ---
  let ids = await page.evaluate(() => {
    const A = makeNode('A parent'); insertAt('root', kidsOf('root').length, A);
    const A1 = makeNode('A1'); insertAt(A, 0, A1);
    const A2 = makeNode('A2'); insertAt(A, 1, A2);
    const B = makeNode('B item'); insertAt('root', kidsOf('root').length, B);
    N(A).collapsed = false; renderPage();
    return { A, A2, B };
  });
  await move(ids.B, -1);
  let r = await page.evaluate(ids => ({ parent: parentOf(ids.B), kids: kidsOf(ids.A) }), ids);
  assert(r.parent === ids.A && r.kids[r.kids.length - 1] === ids.B,
    'Alt+Shift+Up descends into the expanded previous sibling as its last child');

  // --- DOWN into an expanded next sibling: X should become D's FIRST child ---
  ids = await page.evaluate(() => {
    const X = makeNode('X item'); insertAt('root', kidsOf('root').length, X);
    const D = makeNode('D parent'); insertAt('root', kidsOf('root').length, D);
    const D1 = makeNode('D1'); insertAt(D, 0, D1);
    N(D).collapsed = false; renderPage();
    return { X, D, D1 };
  });
  await move(ids.X, 1);
  r = await page.evaluate(ids => ({ parent: parentOf(ids.X), kids: kidsOf(ids.D) }), ids);
  assert(r.parent === ids.D && r.kids[0] === ids.X,
    'Alt+Shift+Down descends into the expanded next sibling as its first child');

  // --- a COLLAPSED neighbour is not entered: the two items just swap at the same level ---
  ids = await page.evaluate(() => {
    const P = makeNode('P parent'); insertAt('root', kidsOf('root').length, P);
    const P1 = makeNode('P1'); insertAt(P, 0, P1);
    const Q = makeNode('Q item'); insertAt('root', kidsOf('root').length, Q);
    N(P).collapsed = true; renderPage();
    return { P, Q, root: 'root' };
  });
  const before = await page.evaluate(ids => kidsOf('root').indexOf(ids.Q), ids);
  await move(ids.Q, -1);
  r = await page.evaluate(ids => ({ parent: parentOf(ids.Q), idx: kidsOf('root').indexOf(ids.Q) }), ids);
  assert(r.parent === 'root' && r.idx === before - 1,
    'a collapsed neighbour is swapped past, not entered (item stays at its level)');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nMOVE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
