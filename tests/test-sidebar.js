/* Right sidebar (shift-click opens a pane) is FULLY editable: a pane reuses mountItem() and the
   shared editing machinery via the shell-level listeners + the mountingSidebar elById guard.
   Verifies: (1) editing a child inside a page pane reaches the server, (2) Enter in a pane creates
   a new bullet that persists under the right parent, (3) a block pane edits the block's own text.
   Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API = 'http://localhost:3211';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

let GRAPH = null;
async function serverDoc() {
  if (!GRAPH) { const me = await (await fetch(API + '/api/me')).json(); GRAPH = me.graphs?.[0]?.id || 'default'; }
  return (await (await fetch(`${API}/api/g/${GRAPH}/doc`)).json()).doc;
}
const serverText = async id => (await serverDoc()).nodes[id]?.text ?? null;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(API + '/#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content', { timeout: 10000 });
  await sleep(500);

  // build a top-level page "SidebarPage" with a child "child one" (replace the onboarding text
  // in the first bullet so the page title is clean)
  await page.evaluate(() => {
    const el = document.querySelector('.tree .item .content');
    el.focus(); getSelection().selectAllChildren(el);
  });
  await sleep(100);
  await page.keyboard.type('SidebarPage', { delay: 8 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');            // indent → child of SidebarPage
  await page.keyboard.type('child one', { delay: 8 });
  await sleep(1200);

  const parentId = await page.evaluate(() => document.querySelector('.tree .item .content').closest('.item').dataset.id);
  const childId = await page.evaluate(pid => doc.nodes[pid].children[0], parentId);

  // open the PAGE in the sidebar → a page pane mounts its children (editable)
  await page.evaluate(pid => window.openInRightbar(pid), parentId);
  await page.waitForSelector('#right-sidebar .rb-entry .item .content', { timeout: 5000 });
  const paneHasChild = await page.evaluate(cid =>
    !!document.querySelector(`#right-sidebar .item[data-id="${cid}"] .content`), childId);
  assert(paneHasChild, 'page pane renders its child as an editable row');

  /* 1. edit the child inside the pane → reaches the server */
  await page.evaluate(cid => {
    const el = document.querySelector(`#right-sidebar .item[data-id="${cid}"] .content`);
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, childId);
  await sleep(100);
  await page.keyboard.type(' EDITED', { delay: 10 });
  await sleep(1400);
  const childLocal = await page.evaluate(cid => doc.nodes[cid].text, childId);
  assert(/EDITED/.test(childLocal) && (await serverText(childId)) === childLocal,
    'editing a child in the sidebar pane reaches the server');

  /* 2. Enter in the pane creates a new bullet that persists under the same parent */
  await page.keyboard.press('Enter');
  await page.keyboard.type('SIDEBARNEW', { delay: 10 });
  await sleep(1400);
  const d = await serverDoc();
  const newId = (d.nodes[parentId].children || []).find(c => d.nodes[c]?.text === 'SIDEBARNEW');
  assert(!!newId, 'Enter in the pane created a new bullet that persisted under the parent');

  /* 3. a BLOCK pane (open the child itself) edits the block's own text */
  await page.evaluate(cid => window.openInRightbar(cid), childId);
  await page.waitForSelector(`#right-sidebar .item[data-id="${childId}"] .content`, { timeout: 5000 });
  await page.evaluate(cid => {
    const el = document.querySelectorAll(`#right-sidebar .item[data-id="${cid}"] .content`);
    const last = el[el.length - 1];
    last.focus();
    const r = document.createRange(); r.selectNodeContents(last); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, childId);
  await sleep(100);
  await page.keyboard.type(' BLOCK', { delay: 10 });
  await sleep(1400);
  const blockLocal = await page.evaluate(cid => doc.nodes[cid].text, childId);
  assert(/EDITED BLOCK/.test(blockLocal) && (await serverText(childId)) === blockLocal,
    'editing a block pane edits the block’s own text on the server');

  await browser.close();
  console.log(failures ? `\n${failures} SIDEBAR TEST(S) FAILING` : '\nSIDEBAR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
