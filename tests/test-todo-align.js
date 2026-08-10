/* A to-do hides its bullet and puts a checkbox there instead — so the checkbox has to occupy the
   bullet's exact column. It didn't: `padding-left: 2px` plus a narrower marker put every to-do
   ~4px left of its own siblings, and a page whose lists are mostly to-dos read as un-indented.
   Fresh server on 3211. */
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
  await sleep(300);

  // a plain bullet and a to-do as siblings, plus a to-do one level deeper
  const ids = await page.evaluate(() => {
    const top = opNewAt(state.zoom, 0, 'Packliste');
    const plain = opNewAt(top, 0, 'Hygiene');
    const todo = opNewAt(top, 1, 'Zahnbürste');
    const deep = opNewAt(plain, 0, 'Zahnpasta');
    doc.nodes[todo].format = 'todo';
    doc.nodes[deep].format = 'todo';
    markDirty(); renderPage();
    return { plain, todo, deep };
  });
  await sleep(300);

  for (const skin of ['paper', 'roam']) {
    await page.evaluate(s => document.documentElement.setAttribute('data-skin', s), skin);
    await sleep(150);
    const m = await page.evaluate(ids => {
      const rect = (id, sel) => {
        const e = document.querySelector(`.item[data-id="${id}"] > .row ${sel}`);
        return e ? e.getBoundingClientRect() : null;
      };
      const centre = r => r.left + r.width / 2;
      return {
        plainText: rect(ids.plain, '.content').left,
        todoText: rect(ids.todo, '.content').left,
        deepText: rect(ids.deep, '.content').left,
        plainDot: centre(rect(ids.plain, '.bullet .dot')),
        todoBox: centre(rect(ids.todo, '.todo-box')),
        hiddenBullet: !(rect(ids.todo, '.bullet') || { width: 0 }).width,
      };
    }, ids);
    assert(Math.abs(m.todoText - m.plainText) < 0.6,
      `${skin}: a to-do's text starts in the same column as a sibling bullet's (off by ${Math.round((m.todoText - m.plainText) * 10) / 10}px)`);
    assert(Math.abs(m.todoBox - m.plainDot) < 1.1,
      `${skin}: the checkbox is centred on the bullet's axis (off by ${Math.round((m.todoBox - m.plainDot) * 10) / 10}px)`);
    assert(m.deepText > m.plainText + 20,
      `${skin}: a nested to-do is still indented a full level (${Math.round(m.deepText - m.plainText)}px)`);
    assert(m.hiddenBullet, `${skin}: the bullet itself is hidden on a to-do row`);
  }

  await browser.close();
  console.log(failures ? `\n${failures} TODO-ALIGN TESTS FAILING` : '\nTODO-ALIGN TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
