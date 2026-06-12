/* "Mirror to…" end-to-end: styled picker input, picker flow creates a linked mirror,
   live sync from the original, persistence through save+reload, broken state on delete,
   and the created-mirror feedback (scroll/flash when visible, named toast when not).
   Fresh server on 3211. */
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

  // create a source and a target the real way (typed, so the commit path runs)
  const src = await page.evaluate(() => { const id = opNewAt(HOME, 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); return id; });
  await page.keyboard.type('Source task xkcd');
  await sleep(600);
  const tgt = await page.evaluate(() => { const id = opNewAt(HOME, 1); document.querySelector(`.item[data-id="${id}"] .content`).focus(); return id; });
  await page.keyboard.type('Target project');
  await sleep(600);

  // 1. the picker input is styled like the quick-jump input (regression: .np-input had no CSS rule)
  await page.evaluate(id => openNodePicker('Mirror to…', t => mirrorItemTo(id, t), subtreeOf(id)), src);
  await sleep(150);
  const css = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.np-input'));
    const card = getComputedStyle(document.querySelector('.np-input').closest('.jump'));
    return { fullWidth: s.width === card.width, noInsetBorder: s.borderTopWidth === '0px', font: parseFloat(s.fontSize) };
  });
  assert(css.fullWidth, 'picker input spans the dialog card');
  assert(css.noInsetBorder && css.font >= 15, `picker input styled, not browser-default (font ${css.font}px)`);

  // 2. real flow: type the target name, Enter → mirror under the target, pointing at the source
  await page.type('.np-input', 'Target');
  await sleep(150);
  await page.keyboard.press('Enter');
  await sleep(400);
  const after = await page.evaluate(({ src, tgt }) => {
    const mid = kidsOf(tgt).find(c => N(c).mirror);
    const el = mid && document.querySelector(`.item[data-id="${mid}"] > .row .content`);
    const toast = document.querySelector('.toast .toast-text');
    return {
      created: !!mid, points: mid ? N(mid).mirror === src : false,
      text: el ? el.textContent : '', badge: el ? !!el.querySelector('.mirror-badge') : false,
      sourceInPlace: kidsOf(HOME).includes(src),
      toastNamesTarget: !!toast && toast.textContent.includes('Target project'),
      flashed: el ? el.closest('.item').classList.contains('entering') : false,
    };
  }, { src, tgt });
  assert(after.created && after.points, 'picker flow creates a mirror under the target, linked to the source');
  assert(after.text.includes('Source task xkcd') && after.badge, 'mirror renders the original text + badge');
  assert(after.sourceInPlace, 'the original did not move');
  assert(after.toastNamesTarget, 'toast names the destination');
  assert(after.flashed, 'visible mirror gets the entering flash');

  // 3. live sync: edit the original → the mirror row updates after the commit debounce
  await page.evaluate(id => focusItem(id, 'text', 'end'), src);
  await page.keyboard.type(' EDITED');
  await sleep(800);
  const live = await page.evaluate(tgt => {
    const mid = kidsOf(tgt).find(c => N(c).mirror);
    return document.querySelector(`.item[data-id="${mid}"] > .row .content`).textContent;
  }, tgt);
  assert(live.includes('Source task xkcd EDITED'), 'mirror updates live when the original is edited');

  // 4. persistence: survives the op-sync save + a reload
  await page.evaluate(async () => { commitActiveText(true); markDirty(); await doSave(); });
  await sleep(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);
  const persisted = await page.evaluate(({ src, tgt }) => {
    const mid = kidsOf(tgt).find(c => N(c).mirror);
    const el = mid && document.querySelector(`.item[data-id="${mid}"] > .row .content`);
    return { ok: !!mid && N(mid).mirror === src, text: el ? el.textContent : '' };
  }, { src, tgt });
  assert(persisted.ok && persisted.text.includes('EDITED'), 'mirror survives save + reload, still linked');

  // 5. offscreen destination → toast offers a Show action that zooms there
  await page.evaluate(({ src, tgt }) => { N(tgt).collapsed = true; renderPage(); zoomTo(src); }, { src, tgt });
  await sleep(200);
  const inner = await page.evaluate(src => { const id = opNewAt(src, 0); N(id).text = 'inner item'; touch(id); renderPage(); return id; }, src);
  await page.evaluate(({ inner, tgt }) => { document.querySelectorAll('.toast').forEach(t => t.remove()); mirrorItemTo(inner, tgt); }, { inner, tgt });
  await sleep(200);
  const offscreen = await page.evaluate(() => {
    const toast = document.querySelector('.toast');
    return { named: !!toast && toast.textContent.includes('Target project'), hasShow: !!toast && !!toast.querySelector('button') };
  });
  assert(offscreen.named && offscreen.hasShow, 'offscreen destination → toast names it and offers Show');

  // 6. deleting the original leaves an explicit broken mirror
  await page.evaluate(() => zoomTo(HOME));
  await sleep(200);
  await page.evaluate(src => opDelete(src), src);
  await sleep(300);
  const broken = await page.evaluate(tgt => {
    const mid = kidsOf(tgt).find(c => N(c).mirror);
    const item = mid && document.querySelector(`.item[data-id="${mid}"]`);
    return !!item && item.classList.contains('broken') && item.querySelector('.content').textContent.includes('original was deleted');
  }, tgt);
  assert(broken, 'deleting the original flips the mirror to the broken state');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nMIRROR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
