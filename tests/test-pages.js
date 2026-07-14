/* Rhizome page layer: find-or-create via Ctrl+K and [[, top-level page
   convention, Roam day titles, page-scoped breadcrumbs. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.day-section');
  await sleep(400);

  /* ---- 1. Ctrl+K offers "Create page" for an unknown title ---- */
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await sleep(150);
  await page.type('#jump-input', 'Gartenplanung');
  await sleep(250);
  const createRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.jump-row')];
    const create = rows.find(r => r.classList.contains('jump-create'));
    return create ? create.textContent : null;
  });
  assert(createRow && /Create page/.test(createRow) && /Gartenplanung/.test(createRow),
    `unknown title offers a create row ("${createRow}")`);

  /* ---- 2. picking it creates a top-level page and zooms in ---- */
  await page.evaluate(() => { document.querySelector('.jump-row.jump-create').click(); });
  await sleep(500);
  let info = await page.evaluate(() => {
    const id = pagesOf().find(p => plainOf(N(p).text).trim() === 'Gartenplanung');
    return id ? {
      topLevel: kidsOf(ROOT).includes(id),
      zoomed: state.zoom === id,
      title: document.querySelector('#zoom-title').textContent.trim(),
    } : null;
  });
  assert(info && info.topLevel, 'created page is a direct child of the root');
  assert(info && info.zoomed && info.title === 'Gartenplanung', 'jump zooms into the fresh page');

  /* ---- 3. Ctrl+K with an existing exact title shows no create row ---- */
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await sleep(150);
  await page.type('#jump-input', 'gartenplanung'); // case-insensitive match
  await sleep(250);
  const dup = await page.evaluate(() => ({
    create: !!document.querySelector('.jump-row.jump-create'),
    hit: [...document.querySelectorAll('.jump-row')].some(r => /Gartenplanung/.test(r.textContent)),
  }));
  assert(!dup.create && dup.hit, 'existing title matches instead of offering a duplicate');
  await page.keyboard.press('Escape');
  await sleep(150);

  /* ---- 4. [[ create makes a top-level page even from a nested zoom ---- */
  await page.evaluate(() => {
    // build a nested spot inside the page and zoom there
    const pid = pagesOf().find(p => plainOf(N(p).text).trim() === 'Gartenplanung');
    const kid = makeNode('Beete');
    insertAt(pid, 0, kid);
    window.__kid = kid;
    zoomTo(kid);
  });
  await sleep(400);
  await page.evaluate(() => { const id = opNewAt(window.__kid, 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('siehe [[Kompost');
  await sleep(350);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.caret-pop .pop-item')];
    items.find(b => /Create/.test(b.textContent)).click();
  });
  await sleep(500);
  info = await page.evaluate(() => {
    const id = Object.values(doc.nodes).find(n => plainOf(n.text).trim() === 'Kompost')?.id;
    return id ? { topLevel: kidsOf(ROOT).includes(id), linked: Object.values(doc.nodes).some(n => n.text?.includes('#/n/' + id)) } : null;
  });
  assert(info && info.topLevel, '[[ create places the new page at the top level');
  assert(info && info.linked, '[[ create links to the new page');

  /* ---- 5. [[ with the existing title reuses the page (no duplicate) ---- */
  await page.evaluate(() => { const id = opNewAt(window.__kid, 0); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('mehr [[Kompost');
  await sleep(350);
  const picked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.caret-pop .pop-item')];
    const hit = items.find(b => !/Create/.test(b.textContent) && /Kompost/.test(b.textContent));
    if (hit) { hit.click(); return 'existing'; }
    items.find(b => /Create/.test(b.textContent))?.click(); return 'create';
  });
  await sleep(500);
  const kompostCount = await page.evaluate(() =>
    Object.values(doc.nodes).filter(n => plainOf(n.text).trim() === 'Kompost').length);
  assert(kompostCount === 1, `no duplicate page for the same title (picked ${picked}, count ${kompostCount})`);

  /* ---- 6. breadcrumbs start at the page, no Home crumb ---- */
  const crumbs = await page.evaluate(() => document.querySelector('#crumbs').textContent);
  assert(/Gartenplanung/.test(crumbs) && !/Home/.test(crumbs),
    `crumbs start at the containing page ("${crumbs}")`);
  const pageCrumbs = await page.evaluate(() => {
    const pid = pagesOf().find(p => plainOf(N(p).text).trim() === 'Gartenplanung');
    zoomTo(pid);
    return new Promise(r => setTimeout(() => r(document.querySelector('#crumbs').style.display), 400));
  });
  assert(pageCrumbs === 'none', 'a top-level page shows no breadcrumb row');

  /* ---- 7. day pages get Roam-style titles ---- */
  const dayTitle = await page.evaluate(() => {
    gotoDate(todayStr());
    return new Promise(r => setTimeout(() => r(document.querySelector('#zoom-title').textContent.trim()), 400));
  });
  assert(/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/.test(dayTitle),
    `today's page is Roam-titled ("${dayTitle}")`);
  const ord = await page.evaluate(() => [roamDateLabel('2026-07-01'), roamDateLabel('2026-07-02'), roamDateLabel('2026-07-03'), roamDateLabel('2026-07-11'), roamDateLabel('2026-07-13')]);
  assert(ord[0] === 'July 1st, 2026' && ord[1] === 'July 2nd, 2026' && ord[2] === 'July 3rd, 2026'
    && ord[3] === 'July 11th, 2026' && ord[4] === 'July 13th, 2026', 'ordinal suffixes (1st/2nd/3rd/11th/13th)');

  /* ---- 8. sidebar: nav entries, page list, no calendar container ---- */
  await page.evaluate(() => { settings.sidebar = true; document.body.classList.add('sidebar-open'); renderSidebar(); });
  await sleep(200);
  const side = await page.evaluate(() => ({
    daily: document.querySelector('#side-daily span')?.textContent,
    all: document.querySelector('#side-pages-link span')?.textContent,
    pages: [...document.querySelectorAll('#side-pages .side-item a')].map(a => a.textContent),
    starsTitle: document.querySelector('#side-stars-section .side-title')?.textContent,
  }));
  assert(side.daily === 'Daily Notes' && side.all === 'All Pages', 'sidebar has Daily Notes and All Pages entries');
  assert(side.pages.includes('Gartenplanung') && side.pages.includes('Kompost'), 'sidebar lists created pages');
  assert(!side.pages.some(t => /Calendar/.test(t)), 'calendar container is not a sidebar page');
  assert(side.starsTitle === 'Shortcuts', 'stars section is titled Shortcuts');

  /* ---- 9. current page is highlighted, from nested zoom too ---- */
  const cur = await page.evaluate(() => {
    zoomTo(window.__kid); // nested node inside Gartenplanung
    return new Promise(r => setTimeout(() => {
      const row = [...document.querySelectorAll('#side-pages .side-item')].find(el => el.classList.contains('current'));
      r(row?.textContent || null);
    }, 400));
  });
  assert(cur === 'Gartenplanung', `containing page is highlighted for nested zooms ("${cur}")`);

  /* ---- 10. #/pages renders the All Pages table ---- */
  await page.evaluate(() => { location.hash = '#/pages'; });
  await sleep(500);
  const all = await page.evaluate(() => ({
    view: state.view,
    titles: [...document.querySelectorAll('.pages-table tbody td:first-child a')].map(a => a.textContent),
    cols: [...document.querySelectorAll('.pages-table thead th')].map(t => t.textContent.trim().split(' ')[0]),
    docTitle: document.title,
    navCurrent: document.querySelector('#side-pages-link')?.classList.contains('current'),
  }));
  assert(all.view === 'pages', '#/pages activates the pages view');
  assert(all.titles.includes('Gartenplanung') && all.titles.includes('Kompost'), 'table lists the pages');
  assert(!all.titles.some(t => /Calendar/.test(t)), 'calendar container is not listed');
  assert(all.cols.join(',') === 'Title,Created,Updated', `table has Title/Created/Updated columns (${all.cols})`);
  assert(all.titles.some(t => /^\w+ \d{1,2}(st|nd|rd|th), \d{4}$/.test(t)), 'journal day pages are listed as pages'); // rhizome
  assert(/All Pages/.test(all.docTitle), `document title reflects the view ("${all.docTitle}")`);
  assert(all.navCurrent, 'sidebar highlights All Pages');

  /* ---- 11. sorting: click Title header sorts A→Z ---- */
  await page.evaluate(() => {
    [...document.querySelectorAll('.pages-table thead th')].find(t => /Title/.test(t.textContent)).click();
  });
  await sleep(300);
  const sorted = await page.evaluate(() =>
    [...document.querySelectorAll('.pages-table tbody td:first-child a')].map(a => a.textContent));
  const isSorted = sorted.every((t, i) => i === 0 || sorted[i - 1].localeCompare(t) <= 0);
  assert(isSorted, `Title header sorts the table (${sorted.slice(0, 3).join(', ')}…)`);

  /* ---- 12. navigating to a page from the table, then back via hash ---- */
  await page.evaluate(() => {
    [...document.querySelectorAll('.pages-table tbody td:first-child a')]
      .find(a => a.textContent === 'Gartenplanung').click();
  });
  await sleep(450);
  const zoomed = await page.evaluate(() => ({
    title: document.querySelector('#zoom-title').textContent.trim(),
    view: state.view,
  }));
  assert(zoomed.title === 'Gartenplanung' && zoomed.view === null, 'table row navigates into the page');

  /* ---- 13. legacy #/n/root redirects to #/ ---- */
  await page.evaluate(() => { location.hash = '#/n/root'; });
  await sleep(400);
  const redirected = await page.evaluate(() => ({ hash: location.hash, zoom: state.zoom }));
  assert(redirected.hash === '#/' && redirected.zoom === 'root', `#/n/root redirects to #/ (${redirected.hash})`);

  /* ---- 14. persistence: everything survives a reload ---- */
  await sleep(900);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 5000 }).catch(() => {});
  await sleep(600);
  const persisted = await page.evaluate(() => ({
    garten: pagesOf().some(p => plainOf(N(p).text).trim() === 'Gartenplanung'),
    kompost: pagesOf().some(p => plainOf(N(p).text).trim() === 'Kompost'),
  }));
  assert(persisted.garten && persisted.kompost, 'created pages survive a reload');

  /* ---- 15. [[ searches pages only, not nested items ---- */
  await page.evaluate(() => {
    snapshot();
    const lab = getOrCreatePage('SlashLab');
    const deep = makeNode('VersteckteNotizXYZ');
    insertAt(lab, 0, deep);
    markDirty();
    zoomTo(lab);
  });
  await sleep(450);
  await page.evaluate(() => { const id = opNewAt(state.zoom, 1); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('x [[Versteckte');
  await sleep(350);
  const pop = await page.evaluate(() => [...document.querySelectorAll('.caret-pop .pop-item')].map(b => b.textContent));
  assert(!pop.some(t => /VersteckteNotizXYZ/.test(t) && !/Create/.test(t)), '[[ does not offer nested items');
  assert(pop.some(t => /Create page/.test(t)), '[[ offers page creation instead');
  await page.keyboard.press('Escape');
  await sleep(150);

  /* ---- 16. [[ finds day pages ---- */
  await page.evaluate(() => { const id = opNewAt(state.zoom, 1); document.querySelector(`.item[data-id="${id}"] .content`).focus(); });
  await sleep(150);
  const dayLabel = await page.evaluate(() => roamDateLabel(todayStr()).slice(0, 6)); // e.g. "July 1"
  await page.keyboard.type('am [[' + dayLabel);
  await sleep(350);
  const dayHit = await page.evaluate(() => [...document.querySelectorAll('.caret-pop .pop-item')].some(b => /📅/.test(b.textContent)));
  assert(dayHit, '[[ offers journal day pages');
  await page.keyboard.press('Escape');
  await sleep(150);

  /* ---- 17. slash "Today" inserts a journal-page link ---- */
  await page.evaluate(() => { const id = opNewAt(state.zoom, 1); document.querySelector(`.item[data-id="${id}"] .content`).focus(); window.__slashHost = id; });
  await sleep(150);
  await page.keyboard.type('/today');
  await sleep(350);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.caret-pop .pop-item')];
    items.find(b => b.querySelector('.pop-label')?.textContent === 'Today').click();
  });
  await sleep(600);
  const jl = await page.evaluate(() => {
    const day = findDay(todayStr());
    const n = N(window.__slashHost);
    return { linked: !!day && (n.text || '').includes('#/n/' + day), plain: plainOf(n.text || '') };
  });
  assert(jl.linked, `slash Today links today's journal page ("${jl.plain}")`);
  assert(!jl.plain.includes('/today'), 'the typed /today query was removed');

  /* ---- 18. slash "Current Time" inserts HH:MM ---- */
  await page.evaluate(() => { const id = opNewAt(state.zoom, 1); document.querySelector(`.item[data-id="${id}"] .content`).focus(); window.__timeHost = id; });
  await sleep(150);
  await page.keyboard.type('/current');
  await sleep(350);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.caret-pop .pop-item')];
    items.find(b => b.querySelector('.pop-label')?.textContent === 'Current Time').click();
  });
  await sleep(500);
  const ct = await page.evaluate(() => plainOf(N(window.__timeHost).text || ''));
  assert(/\d{2}:\d{2}/.test(ct), `slash Current Time inserts a timestamp ("${ct}")`);

  /* ---- 21. existing/imported [[Links]] in text become real links ---- */
  await page.evaluate(() => {
    snapshot();
    const host = getOrCreatePage('WikiHost');
    window.__wikiHost = makeNode('sieh [[Zielseite]] und [[Andere|Alias]] an');
    insertAt(host, 0, window.__wikiHost);
    markDirty();
    migrateWikiLinks(); // the load/import migration
  });
  await sleep(400);
  const mig = await page.evaluate(() => {
    const n = N(window.__wikiHost);
    const ziel = pagesOf().find(p => plainOf(N(p).text).trim() === 'Zielseite');
    const andere = pagesOf().find(p => plainOf(N(p).text).trim() === 'Andere');
    return {
      noBrackets: !/\[\[|\]\]/.test(n.text),
      linksZiel: ziel && n.text.includes('#/n/' + ziel),
      aliasText: andere && new RegExp('#/n/' + andere + '"[^>]*>Alias</a>').test(n.text),
      zielEmpty: ziel ? kidsOf(ziel).length === 0 : false,
    };
  });
  assert(mig.noBrackets && mig.linksZiel, 'literal [[Link]] is converted to a real link');
  assert(mig.aliasText, '[[Target|Alias]] links the target but shows the alias');
  assert(mig.zielEmpty, 'the linked page is created (even empty)');

  /* ---- 22. a #tag is a page (Roam); its references gather every block that tags it ---- */
  await page.evaluate(() => {
    snapshot();
    const a = getOrCreatePage('TagRefA');
    const b = getOrCreatePage('TagRefB');
    insertAt(a, 0, makeNode('etwas #projektx dazu'));
    insertAt(b, 0, makeNode('anderes #projektx hier'));
    markDirty();
    zoomTo(a); // sitting on page A
  });
  await sleep(400);
  await page.evaluate(() => document.querySelector('.tree .tag[data-tag="#projektx"]').click());
  await sleep(500);
  const tagPage = await page.evaluate(() => ({
    onTagPage: plainOf(N(state.zoom).text).trim() === 'projektx',
    isTopLevelPage: kidsOf(ROOT).includes(state.zoom),
    refGroups: [...document.querySelectorAll('#backlinks .ref-group .ref-page')].map(a => a.textContent),
    refRows: [...document.querySelectorAll('#backlinks .ref-row')].length,
  }));
  assert(tagPage.onTagPage && tagPage.isTopLevelPage, 'clicking a #tag opens its own page');
  assert(tagPage.refGroups.includes('TagRefA') && tagPage.refGroups.includes('TagRefB'),
    `the tag page gathers references from every tagging page (${JSON.stringify(tagPage.refGroups)})`);
  assert(tagPage.refRows >= 2, 'both #projektx mentions appear as references');

  /* ---- 19. typing [[Title]] in full auto-links to a (possibly empty) page ---- */
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(500);
  await page.evaluate(() => { window.__wlHost = opNewAt(findDay(todayStr()), 0); });
  await sleep(200);
  await page.evaluate(() => document.querySelector(`.item[data-id="${window.__wlHost}"] .content`)?.focus());
  await sleep(150);
  await page.keyboard.type('ping [[Frisch Angelegt]]');
  await sleep(450);
  const wl = await page.evaluate(() => {
    const n = N(window.__wlHost);
    const pageId = pagesOf().find(p => plainOf(N(p).text).trim() === 'Frisch Angelegt');
    return {
      linked: pageId && (n.text || '').includes('#/n/' + pageId),
      noBrackets: !/\[\[|\]\]/.test(n.text || ''),
      empty: pageId ? kidsOf(pageId).length === 0 : null,
      topLevel: pageId ? kidsOf(ROOT).includes(pageId) : false,
    };
  });
  assert(wl.linked && wl.noBrackets, 'typing [[Title]] converts to a link and drops the brackets');
  assert(wl.topLevel && wl.empty === true, 'the linked page is created top-level and empty');

  /* ---- 20. typing [[Existing]] reuses the page (no duplicate) ---- */
  await page.evaluate(() => { window.__wl2 = opNewAt(findDay(todayStr()), 0); });
  await sleep(200);
  await page.evaluate(() => document.querySelector(`.item[data-id="${window.__wl2}"] .content`)?.focus());
  await sleep(150);
  await page.keyboard.type('again [[frisch angelegt]]'); // different case
  await sleep(450);
  const dupCount = await page.evaluate(() =>
    pagesOf().filter(p => plainOf(N(p).text).trim().toLowerCase() === 'frisch angelegt').length);
  assert(dupCount === 1, `typed [[Existing]] reuses the page (count ${dupCount})`);

  /* ---- 23. renaming a page onto an existing title is blocked ---- */
  await page.evaluate(() => {
    snapshot();
    window.__alpha = getOrCreatePage('AlphaSeite');
    window.__beta = getOrCreatePage('BetaSeite');
    markDirty();
    zoomTo(window.__beta);
  });
  await sleep(450);
  await page.evaluate(() => document.querySelector('#zoom-title').focus());
  await sleep(150);
  await page.evaluate(() => {
    const t = document.querySelector('#zoom-title');
    const r = document.createRange(); r.selectNodeContents(t);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.type('AlphaSeite');
  await sleep(200);
  await page.evaluate(() => document.querySelector('#zoom-title').blur());
  await sleep(450);
  const rename = await page.evaluate(() => ({
    betaTitle: plainOf(N(window.__beta).text).trim(),
    alphaCount: pagesOf().filter(p => plainOf(N(p).text).trim() === 'AlphaSeite').length,
  }));
  assert(rename.betaTitle === 'BetaSeite', `colliding rename reverted (title is now "${rename.betaTitle}")`);
  assert(rename.alphaCount === 1, `no duplicate title was created (${rename.alphaCount} AlphaSeite)`);

  /* ---- 24. a unique rename still goes through ---- */
  await page.evaluate(() => zoomTo(window.__beta));
  await sleep(300);
  await page.evaluate(() => document.querySelector('#zoom-title').focus());
  await sleep(150);
  await page.evaluate(() => {
    const t = document.querySelector('#zoom-title');
    const r = document.createRange(); r.selectNodeContents(t);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.type('GammaSeite');
  await sleep(200);
  await page.evaluate(() => document.querySelector('#zoom-title').blur());
  await sleep(450);
  const unique = await page.evaluate(() => plainOf(N(window.__beta).text).trim());
  assert(unique === 'GammaSeite', `a non-colliding rename is kept ("${unique}")`);

  /* ---- 25. brackets auto-close and type-over completes the link ---- */
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(450);
  await page.evaluate(() => { window.__bk = opNewAt(findDay(todayStr()), 0); document.querySelector(`.item[data-id="${window.__bk}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('x[');
  await sleep(150);
  const single = await page.evaluate(() => document.querySelector(`.item[data-id="${window.__bk}"] .content`).textContent);
  assert(single === 'x[]', `"[" auto-closes to "[]" (got "${single}")`);
  await page.keyboard.type('[');
  await sleep(150);
  const dbl = await page.evaluate(() => document.querySelector(`.item[data-id="${window.__bk}"] .content`).textContent);
  assert(dbl === 'x[[]]', `"[[" auto-closes to "[[]]" (got "${dbl}")`);
  await page.keyboard.type('Zielort');
  await sleep(200);
  await page.keyboard.type(']]'); // type-over the auto-inserted close → completes the link
  await sleep(450);
  const linked = await page.evaluate(() => ({
    text: N(window.__bk).text,
    page: pagesOf().some(p => plainOf(N(p).text).trim() === 'Zielort'),
  }));
  assert(/href="#\/n\//.test(linked.text) && !/\[\[|\]\]/.test(linked.text),
    `typing [[Zielort]] via auto-brackets makes a clean link (${linked.text})`);
  assert(linked.page, 'the [[Zielort]] page was created');

  /* ---- 26. multi-word tags #[[multi word]] link to their page as a tag pill ---- */
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(350);
  await page.evaluate(() => { window.__mwt = opNewAt('root', 0); document.querySelector(`.item[data-id="${window.__mwt}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('siehe #[[Wichtiges Thema');
  await sleep(250);
  await page.keyboard.type(']]');
  await sleep(400);
  await page.evaluate(() => commitActiveText());
  await sleep(200);
  const mwt = await page.evaluate(() => {
    const pid = pagesOf().find(p => plainOf(N(p).text).trim() === 'Wichtiges Thema');
    return {
      isTag: /class="tag"/.test(N(window.__mwt).text),
      linksPage: pid && N(window.__mwt).text.includes('#/n/' + pid),
      pill: document.querySelector(`.item[data-id="${window.__mwt}"] a.tag`)?.textContent,
      pid,
    };
  });
  assert(mwt.isTag && mwt.linksPage, 'typing #[[multi word]] makes a tag linking to that page');
  assert(mwt.pill === '#Wichtiges Thema', `the tag pill shows "#Wichtiges Thema" (got "${mwt.pill}")`);
  await page.evaluate(pid => zoomTo(pid), mwt.pid);
  await sleep(400);
  const mwtRef = await page.evaluate(() => [...document.querySelectorAll('#backlinks .ref-row')].some(r => /siehe/.test(r.textContent)));
  assert(mwtRef, 'the multi-word tag page gathers its reference');

  /* ---- 27. inline block reference (( )) shows the target's live text ---- */
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(350);
  const brTarget = await page.evaluate(() => { const i = opNewAt('root', 0); N(i).text = 'Referenzierter Block XYZ'; markDirty(); renderPage(); return i; });
  await sleep(150);
  await page.evaluate(() => { window.__brHost = opNewAt('root', 0); document.querySelector(`.item[data-id="${window.__brHost}"] .content`).focus(); });
  await sleep(150);
  await page.keyboard.type('ref ((');
  await sleep(250);
  await page.keyboard.type('Referenzierter');
  await sleep(350);
  await page.evaluate(() => { const it = [...document.querySelectorAll('.caret-pop .pop-item')].find(x => /Referenzierter Block/.test(x.textContent)); it && it.click(); });
  await sleep(400);
  await page.evaluate(() => commitActiveText());
  await sleep(200);
  const br = await page.evaluate(t => ({
    empty: /class="block-ref"><\/a>/.test(N(window.__brHost).text),
    refs: N(window.__brHost).text.includes('#/n/' + t),
    shown: document.querySelector(`.item[data-id="${window.__brHost}"] a.block-ref`)?.textContent,
  }), brTarget);
  assert(br.empty && br.refs, 'a (( )) block reference is stored empty and links the target');
  assert(br.shown === 'Referenzierter Block XYZ', `the block ref shows the target's live text (got "${br.shown}")`);
  await page.evaluate(t => { snapshot(); recOld(t); N(t).text = 'Geänderter Blocktext'; touch(t); markDirty(); renderPage(); }, brTarget);
  await sleep(300);
  const brLive = await page.evaluate(() => document.querySelector(`.item[data-id="${window.__brHost}"] a.block-ref`)?.textContent);
  assert(brLive === 'Geänderter Blocktext', `the block ref updates live when the target changes (got "${brLive}")`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGES TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
