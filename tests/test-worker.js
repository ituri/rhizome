/* Off-thread serialization: serializeAsync (Web Worker) produces byte-identical JSON to a
   main-thread JSON.stringify, and actually runs in the worker. Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  const r = await page.evaluate(async () => {
    // grow the doc so serialization is non-trivial
    for (let i = 0; i < 3000; i++) doc.nodes['w' + i] = { id: 'w' + i, text: 'worker node ' + i, note: null, done: false, collapsed: false, children: [] };
    doc.nodes[HOME].children.push(...Array.from({ length: 3000 }, (_, i) => 'w' + i));
    const viaWorker = await serializeAsync(doc, 1);
    const main = JSON.stringify(doc, null, 1);
    return { usedWorker: !!serializeWorker, equal: viaWorker === main, len: main.length };
  });
  assert(r.usedWorker, 'serialization runs in a Web Worker');
  assert(r.equal, `worker output is byte-identical to JSON.stringify (${r.len} bytes)`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nWORKER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
