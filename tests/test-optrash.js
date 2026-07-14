/* Phase-4: op-based trash. Delete / restore / purge sync as ops (delete carries the
   trash ts; untrash drops the entry), so two clients build identical trash and converge
   without any whole-doc PUT.  Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const has = t => `Object.values(doc.nodes).some(n => plainOf(n.text).includes(${JSON.stringify(t)}))`;
const trashSig = () => `(doc.trash || []).map(t => t.ts + ':' + t.root).sort().join(',')`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const A = await browser.newPage();
  const B = await browser.newPage();
  for (const p of [A, B]) p.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await A.goto(URL + '#/outline', { waitUntil: 'domcontentloaded' }); await A.waitForSelector('.tree .item .content');
  await B.goto(URL + '#/outline', { waitUntil: 'domcontentloaded' }); await B.waitForSelector('.tree .item .content');
  await sleep(500);

  // A creates an item and it reaches B
  const id = await A.evaluate(() => { const id = opNewAt(HOME, kidsOf(HOME).length); document.querySelector(`.item[data-id="${id}"] .content`).focus(); return id; });
  await A.keyboard.type('trashme-node');
  await A.evaluate(() => commitActiveText(true));
  await sleep(1200);
  assert(await B.evaluate(has('trashme-node')), 'A→B: item created');

  // A deletes it → goes to trash → B converges (gone + same trash entry)
  await A.evaluate(theId => opDelete(theId, { toast: false }), id);
  await sleep(1200);
  assert(!(await B.evaluate(has('trashme-node'))), 'A delete → B no longer shows the item');
  const aT = await A.evaluate(trashSig()), bT = await B.evaluate(trashSig());
  assert(aT && aT === bT, `trash entry identical across clients (ts:root = ${aT})`);

  // A restores it → B converges (item back + trash empty on both). Mirror the real UI
  // restore handler: snapshot() + recTrash() so the journal emits the insert + untrash ops.
  await A.evaluate(() => { snapshot(); recTrash(); const e = doc.trash[0]; restoreTrashEntry(e); const i = doc.trash.indexOf(e); if (i >= 0) doc.trash.splice(i, 1); rebuildParentMap(); markDirty(); });
  await sleep(1200);
  assert(await B.evaluate(has('trashme-node')), 'A restore → item back on B');
  assert(await A.evaluate(() => (doc.trash || []).length === 0) && await B.evaluate(() => (doc.trash || []).length === 0), 'trash empty on both after restore');

  // live trees byte-identical
  const treeOf = () => `(() => { const pm = {}; for (const id in doc.nodes) for (const c of (doc.nodes[id].children||[])) pm[c]=id;
    return JSON.stringify(Object.keys(doc.nodes).sort().map(id => [id, pm[id]||null, plainOf(doc.nodes[id].text)])); })()`;
  assert(await A.evaluate(treeOf) === await B.evaluate(treeOf), 'live trees byte-identical after delete+restore');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOP-TRASH TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
