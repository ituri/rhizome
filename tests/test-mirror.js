/* Mirrors are full interactive instances (Workflowy semantics): every instance — the
   original included — shows the same content + transcluded subtree, edits from any
   instance hit the shared node, all instances wear the diamond bullet while ≥2 exist,
   and deleting the original promotes a mirror (instances are equivalent).
   Also: "Mirror to…" picker styling/feedback and "Mirror here…". Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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

  // 2b. the sidebar shows the target's text for a mirror, never a "(mirror)" placeholder
  const side = await page.evaluate(tgt => {
    settings.sidebar = true; document.body.classList.add('with-sidebar');
    sideOpen.add(tgt); window.renderSidebar?.();
    const labels = [...document.querySelectorAll('#side-pages .side-item a')].map(a => a.textContent);
    return { hasPlaceholder: labels.some(l => l.includes('(mirror)')), hasTargetText: labels.some(l => l.includes('Source task xkcd')) };
  }, tgt);
  assert(!side.hasPlaceholder && side.hasTargetText, "sidebar lists a mirror by its target's text, not a placeholder");

  // 3. a new mirror starts COLLAPSED (no subtree wall); expanding transcludes the subtree
  const startState = await page.evaluate(mid => ({
    collapsed: !!N(mid).collapsed,
    noCopiesYet: !document.querySelector(`.item[data-id="${mid}"] .item`),
  }), mid);
  assert(startState.collapsed && startState.noCopiesYet, 'a freshly created mirror starts collapsed');
  await page.evaluate(mid => opToggleCollapse(mid, false), mid); // journaled → also syncs/persists (regression: collapse ops were never emitted)
  await sleep(150);
  const trans = await page.evaluate(({ mid, child }) => ({
    copies: document.querySelectorAll(`.item[data-id="${child}"]`).length,
    underMirror: !!document.querySelector(`.item[data-id="${mid}"] .item[data-id="${child}"]`),
  }), { mid, child });
  assert(trans.copies === 2 && trans.underMirror, `expanded mirror transcludes the subtree (${trans.copies} DOM instances of the child)`);

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

  // ── deep-review regression fixes ──
  await page.evaluate(() => { location.hash = '#/'; }); // section 12 zoomed away — come home
  await sleep(350);

  // 13. Tab-indent below a mirror row goes into the SHARED subtree (never buried invisibly)
  const ind = await page.evaluate(() => {
    const orig = makeNode('ind-orig'); insertAt(HOME, 0, orig);
    const m = makeNode('', { mirror: orig, collapsed: false }); insertAt(HOME, 1, m);
    const b = makeNode('ind-victim'); insertAt(HOME, 2, b);
    renderPage();
    opIndent(b, { id: b, field: 'text', offset: 0 });
    return {
      parent: parentOf(b), expectTarget: orig,
      rendered: document.querySelectorAll(`.item[data-id="${b}"]`).length, // under original AND mirror
      ids: { orig, m, b },
    };
  });
  assert(ind.parent === ind.expectTarget, 'Tab under a mirror row indents into the shared subtree');
  assert(ind.rendered === 2, `…and the row stays visible at every instance (${ind.rendered} copies)`);

  // 14. multi-line paste onto a mirror row inserts BELOW it — the instance survives
  const pasted = await page.evaluate(ids => {
    const { m } = ids;
    const el = document.querySelector(`.item[data-id="${m}"] > .row .content`);
    el.focus();
    snapshot();
    insertForest({ id: m, field: 'text', el }, parseIndentedText('paste-a\npaste-b'));
    return { mirrorSurvives: !!doc.nodes[m], inserted: Object.values(doc.nodes).some(n => plainOf(n.text) === 'paste-a') };
  }, ind.ids);
  assert(pasted.mirrorSurvives && pasted.inserted, 'multi-line paste onto a mirror inserts as siblings, never deletes the instance');

  // 15. deleting an ANCESTOR of a mirrored original promotes the mirror (+ honest toast)
  const anc = await page.evaluate(() => {
    const folder = makeNode('Folder'); insertAt(HOME, 0, folder);
    const orig = makeNode('deep-original'); insertAt(folder, 0, orig);
    const okid = makeNode('deep-kid'); insertAt(orig, 0, okid);
    const m = makeNode('', { mirror: orig }); insertAt(HOME, 1, m);
    renderPage();
    document.querySelectorAll('.toast').forEach(t => t.remove());
    opDelete(folder);
    const toast = document.querySelector('.toast .toast-text');
    return {
      promoted: !!N(m) && !N(m).mirror && plainOf(N(m).text) === 'deep-original',
      keptKid: !!N(m) && kidsOf(m).includes(okid),
      toastHonest: !!toast && toast.textContent.includes('lives on'),
      mid: m,
    };
  });
  assert(anc.promoted && anc.keptKid, 'deleting an ancestor of the original promotes the outside mirror (content + subtree)');
  assert(anc.toastHonest, 'the delete toast says the content lives on');

  // 16. restoring the trashed original after promotion yields a live MIRROR, not a duplicate
  const dup = await page.evaluate(() => {
    const orig = makeNode('resto-orig'); insertAt(HOME, 0, orig);
    const m = makeNode('', { mirror: orig }); insertAt(HOME, 1, m);
    renderPage();
    opDelete(orig, { toast: false });                        // promotes m; trash entry = mirror-of-m
    const entry = (doc.trash || []).find(t => t.root === orig);
    snapshot(); recTrash(); restoreTrashEntry(entry); renderPage();
    const copies = Object.values(doc.nodes).filter(n => plainOf(n.text) === 'resto-orig');
    return { restoredIsMirror: N(orig)?.mirror === m, contentCopies: copies.length };
  });
  assert(dup.restoredIsMirror && dup.contentCopies === 1,
    `restore-after-promotion gives a live mirror, not a duplicate (${dup.contentCopies} content copy)`);

  // 17. a trashed mirror heals its pointer through the promotion chain on restore
  const heal = await page.evaluate(() => {
    const orig = makeNode('heal-orig'); insertAt(HOME, 0, orig);
    const m1 = makeNode('', { mirror: orig }); insertAt(HOME, 1, m1);
    const m2 = makeNode('', { mirror: orig }); insertAt(HOME, 2, m2);
    renderPage();
    opDelete(m2, { toast: false });                          // m2 → trash (points at orig)
    opDelete(orig, { toast: false });                        // m1 promoted; orig → trash as mirror-of-m1
    const entry = (doc.trash || []).find(t => t.root === m2);
    snapshot(); recTrash(); restoreTrashEntry(entry); renderPage();
    return { pointer: N(m2)?.mirror, live: !!doc.nodes[N(m2)?.mirror], expected: m1 };
  });
  assert(heal.pointer === heal.expected && heal.live, 'a restored mirror re-points through the promotion chain to the live heir');

  // 18. search matches mirror INSTANCES too (target text matches → instance shows)
  await page.evaluate(() => {
    const orig = makeNode('searchable-zebra'); insertAt(HOME, 0, orig);
    const m = makeNode('', { mirror: orig }); insertAt(HOME, 1, m);
    window.__searchIds = { orig, m };
    renderPage();
    setSearch('searchable-zebra');
  });
  await sleep(300);
  const srch = await page.evaluate(() => ({
    origShown: !!document.querySelector(`.item[data-id="${window.__searchIds.orig}"]`),
    mirrorShown: !!document.querySelector(`.item[data-id="${window.__searchIds.m}"]`),
    bothMatched: state.matchSet?.has(window.__searchIds.orig) && state.matchSet?.has(window.__searchIds.m),
  }));
  assert(srch.origShown && srch.mirrorShown && srch.bothMatched, 'search shows the original AND its mirror instances');
  await page.evaluate(() => setSearch(''));
  await sleep(200);

  // 19. selection highlights the transcluded copy you actually selected (all instances)
  const selv = await page.evaluate(() => {
    const orig = makeNode('sel-orig'); insertAt(HOME, 0, orig);
    const k = makeNode('sel-kid'); insertAt(orig, 0, k);
    const m = makeNode('', { mirror: orig, collapsed: false }); insertAt(HOME, 1, m);
    renderPage();
    selEnter(k);
    const sel = [...document.querySelectorAll('.item.selected')];
    return {
      highlighted: sel.length,
      includesCopyUnderMirror: sel.some(e => e.closest(`.item[data-id="${m}"]`) && e.dataset.id === k),
      ids: { orig, k, m },
    };
  });
  assert(selv.highlighted === 2 && selv.includesCopyUnderMirror, `selecting a duplicated row highlights every instance (${selv.highlighted})`);
  await page.evaluate(() => selClear());

  // 20. Enter inside a transcluded copy keeps the caret under the mirror
  await page.evaluate(ids => {
    document.querySelector(`.item[data-id="${ids.m}"] .item[data-id="${ids.k}"] > .row .content`).focus();
    setCaretOffset(document.activeElement, 'end');
  }, selv.ids);
  await page.keyboard.press('Enter');
  await sleep(250);
  const caret = await page.evaluate(ids => ({
    underMirror: !!document.activeElement?.closest?.(`.item[data-id="${ids.m}"]`),
  }), selv.ids);
  assert(caret.underMirror, 'Enter inside a transcluded copy keeps the caret in that copy');

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nMIRROR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
