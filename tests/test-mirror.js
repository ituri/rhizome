/* Mirrors are full interactive instances (Workflowy semantics): every instance — the
   original included — shows the same content + transcluded subtree, edits from any
   instance hit the shared node, all instances wear the diamond bullet while ≥2 exist,
   and deleting the original promotes a mirror (instances are equivalent).
   Also: "Mirror to…" picker styling/feedback and "Mirror here…". Fresh server on 3211. */
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

  // create a source (with one child) and a target the real way (typed, so commits run)
  const src = await page.evaluate(() => { const id = opNewAt(HOME, 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); return id; });
  await page.keyboard.type('Source task xkcd');
  await sleep(600);
  const child = await page.evaluate(s => opNewAt(s, 0), src);
  await page.keyboard.type('subitem one');
  await sleep(600);
  const tgt = await page.evaluate(() => { const id = opNewAt(HOME, 2); document.querySelector(`.item[data-id="${id}"] .content`).focus(); return id; });
  await page.keyboard.type('Target project');
  await sleep(600);

  // 1. the picker input is styled like the quick-jump input (regression: .np-input had no CSS)
  await page.evaluate(id => openNodePicker('Mirror to…', t => mirrorItemTo(id, t), subtreeOf(id)), src);
  await sleep(150);
  const css = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.np-input'));
    const card = getComputedStyle(document.querySelector('.np-input').closest('.jump'));
    return { fullWidth: s.width === card.width, noInsetBorder: s.borderTopWidth === '0px', font: parseFloat(s.fontSize) };
  });
  assert(css.fullWidth && css.noInsetBorder && css.font >= 15, 'picker input styled like the quick-jump input');

  // 2. picker flow → a full instance under the target: same text, diamond on BOTH
  await page.type('.np-input', 'Target');
  await sleep(150);
  await page.keyboard.press('Enter');
  await sleep(400);
  const mid = await page.evaluate(tgt => kidsOf(tgt).find(c => N(c).mirror), tgt);
  const inst = await page.evaluate(({ mid, src }) => {
    const m = document.querySelector(`.item[data-id="${mid}"]`);
    const o = document.querySelector(`.item[data-id="${src}"]`);
    const toast = document.querySelector('.toast .toast-text');
    return {
      linked: N(mid).mirror === src,
      text: m ? m.querySelector(':scope > .row .content').textContent : '',
      editable: m ? m.querySelector(':scope > .row .content').isContentEditable : false,
      diamondMirror: m ? m.classList.contains('is-mirror') : false,
      diamondOriginal: o ? o.classList.contains('mirrored') : false,
      toastNamesTarget: !!toast && toast.textContent.includes('Target project'),
    };
  }, { mid, src });
  assert(inst.linked && inst.text.includes('Source task xkcd'), 'mirror instance shows the shared text');
  assert(inst.editable, 'the mirror row is editable in place');
  assert(inst.diamondMirror && inst.diamondOriginal, 'diamond bullet on the mirror AND the original');
  assert(inst.toastNamesTarget, 'toast names the destination');

  // 3. the subtree is transcluded: the child renders under the mirror too (same data-id, twice)
  const trans = await page.evaluate(({ mid, child }) => ({
    copies: document.querySelectorAll(`.item[data-id="${child}"]`).length,
    underMirror: !!document.querySelector(`.item[data-id="${mid}"] .item[data-id="${child}"]`),
  }), { mid, child });
  assert(trans.copies === 2 && trans.underMirror, `subtree transcluded under the mirror (${trans.copies} DOM instances of the child)`);

  // 4. editing the TRANSCLUDED copy edits the real child (and its original row follows)
  await page.evaluate(({ mid, child }) => {
    document.querySelector(`.item[data-id="${mid}"] .item[data-id="${child}"] > .row .content`).focus();
  }, { mid, child });
  await page.keyboard.press('End');
  await page.keyboard.type(' EDITED-IN-MIRROR');
  await sleep(800);
  const childSync = await page.evaluate(({ src, child }) => ({
    data: plainOf(N(child).text),
    originalRow: document.querySelector(`.item[data-id="${src}"] .item[data-id="${child}"] > .row .content`)?.textContent
      ?? document.querySelector(`.tree > .item[data-id="${src}"] .item[data-id="${child}"] > .row .content`)?.textContent ?? '',
  }), { src, child });
  assert(childSync.data.includes('EDITED-IN-MIRROR'), 'typing in the transcluded copy lands on the real child');
  assert(childSync.originalRow.includes('EDITED-IN-MIRROR'), "…and the child's original row updates live");

  // 5. editing the mirror's TITLE row edits the original
  await page.evaluate(mid => focusItem(mid, 'text', 'end'), mid);
  await page.keyboard.type(' RETITLED');
  await sleep(800);
  const titleSync = await page.evaluate(src => ({
    data: plainOf(N(src).text),
    row: document.querySelector(`.item[data-id="${src}"] > .row .content`).textContent,
  }), src);
  assert(titleSync.data.includes('RETITLED') && titleSync.row.includes('RETITLED'),
    'editing the mirror title edits the original (data + DOM)');

  // 6. completing via the mirror completes every instance
  await page.evaluate(mid => focusItem(mid, 'text', 'end'), mid);
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(300);
  const doneSync = await page.evaluate(({ mid, src }) => ({
    data: !!N(src).done,
    both: document.querySelector(`.item[data-id="${src}"]`).classList.contains('done')
      && document.querySelector(`.item[data-id="${mid}"]`).classList.contains('done'),
  }), { mid, src });
  assert(doneSync.data && doneSync.both, 'Ctrl+Enter on the mirror completes the original (both rows marked done)');
  await page.evaluate(src => opToggleDone(src), src); // un-complete for the rest
  await sleep(200);

  // 7. survives the op-sync save + reload, transclusion intact
  await page.evaluate(async () => { commitActiveText(true); markDirty(); await doSave(); });
  await sleep(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);
  const persisted = await page.evaluate(({ mid, src, child }) => ({
    linked: !!N(mid) && N(mid).mirror === src,
    transcluded: !!document.querySelector(`.item[data-id="${mid}"] .item[data-id="${child}"]`),
  }), { mid, src, child });
  assert(persisted.linked && persisted.transcluded, 'mirror + transclusion survive save and reload');

  // 8. "Mirror here…" on an EMPTY bullet converts it in place
  const emptyId = await page.evaluate(() => { const id = opNewAt(HOME, 0); renderPage(); mirrorHere(id); return id; });
  await sleep(150);
  await page.type('.np-input', 'Target');
  await sleep(150);
  await page.keyboard.press('Enter');
  await sleep(300);
  const here = await page.evaluate(({ emptyId, tgt }) => ({
    converted: N(emptyId)?.mirror === tgt,
    inPlace: kidsOf(HOME)[0] === emptyId,
    shows: document.querySelector(`.item[data-id="${emptyId}"] > .row .content`)?.textContent || '',
  }), { emptyId, tgt });
  assert(here.converted && here.inPlace && here.shows.includes('Target project'),
    'Mirror here on an empty bullet converts it in place into a live instance');

  // 9. "Mirror here…" on a NON-empty bullet inserts the mirror as the next sibling
  const fullId = await page.evaluate(() => {
    const id = opNewAt(HOME, 0); N(id).text = 'keep me'; touch(id); renderPage(); mirrorHere(id); return id;
  });
  await sleep(150);
  await page.type('.np-input', 'Target');
  await sleep(150);
  await page.keyboard.press('Enter');
  await sleep(300);
  const sib = await page.evaluate(({ fullId, tgt }) => {
    const kids = kidsOf(HOME);
    const next = kids[kids.indexOf(fullId) + 1];
    return { kept: plainOf(N(fullId).text) === 'keep me' && !N(fullId).mirror, sibling: !!next && N(next).mirror === tgt };
  }, { fullId, tgt });
  assert(sib.kept && sib.sibling, 'Mirror here on a non-empty bullet adds the instance as its next sibling');

  // 10. equivalence on delete: deleting the ORIGINAL promotes the mirror (content + subtree live on)
  await page.evaluate(src => opDelete(src), src);
  await sleep(400);
  const promoted = await page.evaluate(({ mid, src, child }) => {
    const m = N(mid);
    const el = document.querySelector(`.item[data-id="${mid}"]`);
    return {
      srcGone: !doc.nodes[src],
      isRealNow: !!m && !m.mirror,
      keptText: m ? plainOf(m.text) : '',
      keptChild: m ? kidsOf(mid).includes(child) : false,
      circle: el ? !el.classList.contains('is-mirror') && !el.classList.contains('mirrored') : false,
    };
  }, { mid, src, child });
  assert(promoted.srcGone && promoted.isRealNow, 'deleting the original promotes the mirror to a real node');
  assert(promoted.keptText.includes('RETITLED') && promoted.keptChild, 'the promoted instance inherited text and subtree');
  assert(promoted.circle, 'the last remaining instance reverts to a circle bullet');

  // 11. circle-revert on the other side: delete Target's two mirrors → Target circles back
  const beforeRevert = await page.evaluate(tgt =>
    document.querySelector(`.item[data-id="${tgt}"]`)?.classList.contains('mirrored'), tgt);
  await page.evaluate(({ emptyId }) => opDelete(emptyId), { emptyId });
  await sleep(250);
  const midRevert = await page.evaluate(tgt =>
    document.querySelector(`.item[data-id="${tgt}"]`)?.classList.contains('mirrored'), tgt);
  await page.evaluate(({ fullId }) => { const kids = kidsOf(HOME); const m = kids[kids.indexOf(fullId) + 1]; opDelete(m); }, { fullId });
  await sleep(250);
  const afterRevert = await page.evaluate(tgt =>
    document.querySelector(`.item[data-id="${tgt}"]`)?.classList.contains('mirrored'), tgt);
  assert(beforeRevert === true && midRevert === true && afterRevert === false,
    'the original wears the diamond while any mirror exists and reverts to a circle when the last one goes');

  // 12. offscreen destination → toast names it and offers Show (Mirror to… feedback).
  // Zoom away first: on Home the destination is visible (mirrorItemTo expands it) and
  // the feedback is rightly the scroll/flash, not the Show button.
  await page.evaluate(fullId => { location.hash = '#/n/' + fullId; }, fullId);
  await sleep(350);
  const probe = await page.evaluate(tgt => {
    const id = opNewAt(state.zoom, 0); N(id).text = 'probe'; touch(id); renderPage();
    document.querySelectorAll('.toast').forEach(t => t.remove());
    mirrorItemTo(id, tgt);
    const toast = document.querySelector('.toast');
    return { named: !!toast && toast.textContent.includes('Target project'), hasShow: !!toast && !!toast.querySelector('button') };
  }, tgt);
  assert(probe.named && probe.hasShow, 'offscreen destination → toast names it and offers Show');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nMIRROR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
