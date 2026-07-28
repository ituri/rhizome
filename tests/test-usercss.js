/* Custom CSS (Roam-style theming): codeblocks on the "rhizome/css" page are injected as a
   <style id="rz-user-css">, live. Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(400);

  // build a "rhizome/css" page with a codeblock via the app's own API, then reload
  await page.evaluate(() => {
    snapshot();
    const pid = getOrCreatePage('rhizome/css');
    const cb = makeNode(escHtml('.brand { color: rgb(1, 2, 3); }'), { format: 'codeblock' });
    insertAt(pid, 0, cb);
    markDirty();
    renderPage();
  });
  await sleep(400);

  const injected = await page.evaluate(() => {
    const el = document.getElementById('rz-user-css');
    return el ? el.textContent : null;
  });
  assert(injected && injected.includes('.brand { color: rgb(1, 2, 3); }'), 'codeblock CSS is injected into <style id=rz-user-css>');

  const applied = await page.evaluate(() => {
    const b = document.querySelector('.brand');
    return b ? getComputedStyle(b).color : null;
  });
  assert(applied === 'rgb(1, 2, 3)', 'the injected CSS actually styles the app (.brand color)');

  // editing the codeblock updates the style live (no reload)
  await page.evaluate(() => {
    const pid = findPageByTitle('rhizome/css');
    const cb = doc.nodes[pid].children[0];
    doc.nodes[cb].text = escHtml('.brand { color: rgb(9, 8, 7); }');
    markDirty(); renderPage();
  });
  await sleep(200);
  const applied2 = await page.evaluate(() => getComputedStyle(document.querySelector('.brand')).color);
  assert(applied2 === 'rgb(9, 8, 7)', 'editing the codeblock re-applies the CSS live');

  await browser.close();
  console.log(failures ? `\n${failures} USER-CSS TESTS FAILING` : '\nUSER-CSS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
