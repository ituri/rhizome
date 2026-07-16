/* Persistence safety nets for the recurring "typed in the web, green, but it never reached
   the server / iOS showed a truncated prefix" bug. Two guarantees:
   1. doSave: a node mutation that emits NO op (e.g. a debounced text commit that lands after
      its undo transaction already closed) must still reach the server via the whole-doc PUT
      instead of being reported "saved" and stranded on this device only.
   2. visibilitychange:hidden / pagehide flush the live edit via a beacon, so backgrounding
      the app on mobile (which freezes the commit/save debounce timers) can't drop the tail
      of what was just typed.
   Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

let GRAPH = null;
async function serverText(id) {
  if (!GRAPH) { const me = await (await fetch(API + '/api/me')).json(); GRAPH = me.graphs?.[0]?.id || 'default'; }
  const d = await (await fetch(`${API}/api/g/${GRAPH}/doc`)).json();
  return d.doc.nodes[id]?.text ?? null;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(500);

  // baseline: type into a bullet through the real editing flow (clean commit → op → save)
  await page.evaluate(() => document.querySelector('.tree .item .content').focus());
  await sleep(100);
  await page.keyboard.type('History einer Sei', { delay: 12 });
  await sleep(1600);
  const { id, local } = await page.evaluate(() => {
    const id = document.querySelector('.tree .item .content').closest('.item').dataset.id;
    return { id, local: doc.nodes[id].text };
  });
  assert(id && (await serverText(id)) === local, 'baseline: typed text reaches the server');

  /* 1. an op-less node mutation still syncs (no false "saved") */
  const full = local + 'te — der ganze Rest';
  await page.evaluate((id, full) => {
    document.activeElement?.blur?.();
    doc.nodes[id].text = full; // change node state without opening an undo txn → emits no op
    markDirty();
  }, id, full);
  await sleep(1600);
  assert((await serverText(id)) === full, 'op-less change persisted via whole-doc PUT (not a false green)');

  /* 2. visibilitychange:hidden flushes the edit via beacon (mobile app-switch safety) */
  const tail = local + ' — beim App-Wechsel getippt';
  await page.evaluate((id, tail) => { doc.nodes[id].text = tail; markDirty(); }, id, tail);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  let hit = false;
  for (let i = 0; i < 12 && !hit; i++) { await sleep(60); hit = (await serverText(id)) === tail; }
  assert(hit, 'visibilitychange:hidden beacon persisted the just-typed tail');

  await browser.close();
  console.log(failures ? `\n${failures} PERSIST TESTS FAILING` : '\nPERSIST TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
