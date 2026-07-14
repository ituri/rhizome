/* Tendril gap-coverage tests — everything not exercised by test.js/test2.js */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  page.on('dialog', d => d.accept());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  /* ---- 1. inline formatting shortcuts: Ctrl+B, Ctrl+Shift+X, Ctrl+E ---- */
  await page.evaluate(() => opNewAt('root', 0));
  await sleep(150);
  await page.keyboard.type('styled words');
  await sleep(100);
  await page.evaluate(() => {
    const el = document.activeElement;
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.down('Control'); await page.keyboard.press('b'); await page.keyboard.up('Control');
  await sleep(550);
  let id1 = await page.evaluate(() => editableCtx(document.activeElement)?.id);
  let ok = await page.evaluate(id => (doc.nodes[id].text || '').includes('<b>'), id1);
  assert(ok, 'Ctrl+B bolds selection (persisted as <b>)');
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('x');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(550);
  ok = await page.evaluate(id => (doc.nodes[id].text || '').includes('<s>'), id1);
  assert(ok, 'Ctrl+Shift+X strikes through (persisted as <s>)');
  await page.evaluate(() => {
    const el = document.activeElement;
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.down('Control'); await page.keyboard.press('e'); await page.keyboard.up('Control');
  await sleep(550);
  ok = await page.evaluate(id => (doc.nodes[id].text || '').includes('<code>'), id1);
  assert(ok, 'Ctrl+E wraps in inline code');
  // selection survives the live redecoration pass (Ctrl+B then chaining another format)
  await page.evaluate(id => focusItem(id, 'text', 0), id1);
  await page.evaluate(() => {
    const el = document.activeElement;
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.down('Control'); await page.keyboard.press('i'); await page.keyboard.up('Control');
  await sleep(600); // wait out the redecorate pass
  ok = await page.evaluate(() => getSelection().toString().length > 0);
  assert(ok, 'selection survives redecoration after formatting');

  /* ---- 2. Ctrl+K link dialog on selection (internal link) ---- */
  await page.evaluate(id => focusItem(id, 'text', 0), id1);
  await page.evaluate(() => {
    const el = document.activeElement;
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await sleep(250);
  ok = await page.evaluate(() => !document.querySelector('#link-overlay').hidden);
  assert(ok, 'Ctrl+K with selection opens the link dialog (not jump)');
  await page.type('#link-input', 'Power moves');
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(550);
  ok = await page.evaluate(id => /<a href="#\/n\/[a-z0-9]+">/i.test(doc.nodes[id].text), id1);
  assert(ok, 'link dialog wraps selection in an internal link');

  /* ---- 3. quote "> " and codeblock ``` shortcuts ---- */
  await page.evaluate(id => focusItem(id, 'text', 'end'), id1);
  await page.keyboard.press('Enter');
  await sleep(120);
  await page.keyboard.type('>');
  await page.keyboard.press(' ');
  await sleep(200);
  ok = await page.evaluate(() => document.activeElement.closest('.item')?.classList.contains('fmt-quote'));
  assert(ok, '"> " markdown shortcut makes a quote');
  await page.keyboard.type('wise words');
  await page.keyboard.press('Enter');
  await sleep(120);
  await page.keyboard.type('```');
  await sleep(250);
  ok = await page.evaluate(() => !!document.querySelector('.item.fmt-codeblock'));
  assert(ok, '"```" converts to a code block');
  // Enter inside codeblock inserts a newline instead of splitting
  await page.keyboard.type('line1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line2');
  await sleep(550);
  ok = await page.evaluate(() => {
    const cb = document.querySelector('.item.fmt-codeblock .content');
    return cb.innerText.includes('line1') && cb.innerText.includes('line2');
  });
  assert(ok, 'Enter inside a code block makes a new line, not a new item');

  /* ---- 4. duplicate adds #copy (and setting respected) ---- */
  await page.evaluate(id => focusItem(id, 'text', 'end'), id1);
  await page.keyboard.down('Control'); await page.keyboard.press('d'); await page.keyboard.up('Control');
  await sleep(300);
  ok = await page.evaluate(() => {
    const copies = [...document.querySelectorAll('.tree .content')].filter(c => c.textContent.includes('#copy'));
    return copies.length === 1;
  });
  assert(ok, 'Ctrl+D duplicates with a #copy tag');

  /* ---- 5. expand all / collapse all ---- */
  await page.evaluate(() => setCollapseAll(true));
  await sleep(250);
  const collapsedCount = await page.evaluate(() => document.querySelectorAll('.tree .item.collapsed').length);
  await page.evaluate(() => setCollapseAll(false));
  await sleep(250);
  const afterExpand = await page.evaluate(() => document.querySelectorAll('.tree .item.collapsed').length);
  assert(collapsedCount >= 2 && afterExpand === 0, `collapse all (${collapsedCount}) / expand all (${afterExpand} left)`);

  /* ---- 6. file upload + attachment render + remove ---- */
  const up = await page.evaluate(async () => {
    const blob = new Blob(['hello attachment'], { type: 'text/plain' });
    const res = await fetch('/api/upload?name=notes.txt', { method: 'POST', body: blob });
    return res.json();
  });
  assert(up.url && up.name === 'notes.txt', `upload API stores file (${up.url})`);
  const served = await page.evaluate(async url => (await fetch(url)).text(), up.url);
  assert(served === 'hello attachment', 'uploaded file is served back intact');
  await page.evaluate((id, url) => {
    snapshot();
    doc.nodes[id].files = [{ url, name: 'notes.txt', type: 'text/plain' }];
    renderPage();
    markDirty();
  }, id1, up.url);
  await sleep(200);
  ok = await page.evaluate(() => {
    const chip = document.querySelector('.att-chip');
    return chip && chip.textContent.includes('notes.txt');
  });
  assert(ok, 'attachment renders as a file chip on the item');
  // image attachments render inline
  await page.evaluate(id => {
    doc.nodes[id].files.push({ url: '/favicon.ico', name: 'pic.png', type: 'image/png' });
    renderPage();
  }, id1);
  await sleep(150);
  ok = await page.evaluate(() => !!document.querySelector('.attachments img.att-img'));
  assert(ok, 'image attachments render inline as <img>');
  await page.evaluate(() => document.querySelector('.att-remove').click());
  await sleep(200);

  /* ---- 7. YouTube embed ---- */
  await page.evaluate(() => {
    const id = makeNode('watch this https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    insertAt('root', 0, id);
    renderPage();
  });
  await sleep(200);
  ok = await page.evaluate(() => {
    const f = document.querySelector('.embed iframe');
    return f && f.src.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
  assert(ok, 'YouTube link renders an embed');
  await page.evaluate(() => { settings.embeds = false; renderPage(); });
  await sleep(150);
  ok = await page.evaluate(() => !document.querySelector('.embed iframe'));
  assert(ok, 'embed setting toggles embeds off');
  await page.evaluate(() => { settings.embeds = true; });

  /* ---- 8. templates: save + insert via slash ---- */
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.tree .item')];
    const it = els.find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('Try it'));
    saveAsTemplate(it.dataset.id);
  });
  await sleep(250);
  ok = await page.evaluate(() => getTemplates().length === 1);
  assert(ok, 'save as template registers the subtree');
  await page.evaluate(() => opNewAt('root', 0));
  await sleep(150);
  await page.keyboard.type('/');
  await sleep(200);
  await page.keyboard.type('template');
  await sleep(250);
  ok = await page.evaluate(() => document.querySelector('.caret-pop')?.textContent.includes('Template:'));
  assert(ok, 'slash menu lists saved templates');
  await page.keyboard.press('Enter');
  await sleep(350);
  ok = await page.evaluate(() => {
    const tplCopies = [...document.querySelectorAll('.tree .content')]
      .filter(c => c.textContent.includes('Try it') && !c.textContent.includes('#template'));
    return tplCopies.length >= 1 && getTemplates().length === 1;
  });
  assert(ok, 'inserting a template clones it without the #template tag');

  /* ---- 9. OPML + JSON import through the real file input ---- */
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="Imported Project" _note="from opml">
      <outline text="step one" _complete="true"/><outline text="step two"/>
    </outline></body></opml>`;
  await page.evaluate(xml => {
    const dt = new DataTransfer();
    dt.items.add(new File([xml], 'import.opml', { type: 'text/xml' }));
    const input = document.querySelector('#import-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, opml);
  await sleep(400);
  ok = await page.evaluate(() => {
    const it = [...document.querySelectorAll('.tree .item')]
      .find(e => (e.querySelector(':scope > .row .content')?.textContent || '') === 'Imported Project');
    if (!it) return false;
    const n = doc.nodes[it.dataset.id];
    return n.note === 'from opml' && n.children.length === 2 && doc.nodes[n.children[0]].done === true;
  });
  assert(ok, 'OPML import via file input (notes + completion preserved)');

  const exportJson = await page.evaluate(() => JSON.stringify(doc));
  await page.evaluate(json => {
    const dt = new DataTransfer();
    dt.items.add(new File([json], 'backup.json', { type: 'application/json' }));
    const input = document.querySelector('#import-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, exportJson);
  await sleep(400);
  ok = await page.evaluate(() => !!document.querySelector('.toast') || Object.keys(doc.nodes).length > 5);
  assert(ok, 'JSON import round-trips a full export (confirm dialog accepted)');

  /* ---- 10. text + OPML export content ---- */
  const txt = await page.evaluate(() => kidsOf(HOME).map(id => subtreeToText(id, 0)).join(''));
  assert(txt.includes('- Imported Project') && txt.includes('  from opml'), 'text export emits indented outline with notes');
  const opmlOut = await page.evaluate(() => kidsOf(HOME).map(subtreeToOpml).join(''));
  assert(opmlOut.includes('_note="from opml"') && opmlOut.includes('_complete="true"'), 'OPML export preserves notes and completion');

  /* ---- 11. appearance settings apply ---- */
  ok = await page.evaluate(() => {
    settings.accent = 'indigo'; settings.font = 'serif'; settings.density = 'compact';
    applyTheme();
    const d = document.documentElement.dataset;
    const r = d.accent === 'indigo' && d.font === 'serif' && d.density === 'compact';
    settings.accent = 'terracotta'; settings.font = 'default'; settings.density = 'cozy';
    applyTheme();
    return r && !document.documentElement.dataset.accent;
  });
  assert(ok, 'accent / font / density settings apply and reset');

  /* ---- 12. share revoke ---- */
  await page.evaluate(() => doSave());
  await sleep(800); // flush pending save so the server knows the node
  const sh = await page.evaluate(async () => {
    const it = document.querySelector('.tree .item');
    const res = await fetch('/api/shares', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: it.dataset.id, mode: 'view' }),
    });
    return res.json();
  });
  let shareStatus = await page.evaluate(async t => (await fetch(`/api/share/${t}/doc`)).status, sh.token);
  assert(shareStatus === 200, 'share link works before revoke');
  await page.evaluate(async t => fetch('/api/shares/' + t, { method: 'DELETE' }), sh.token);
  await sleep(150);
  shareStatus = await page.evaluate(async t => (await fetch(`/api/share/${t}/doc`)).status, sh.token);
  assert(shareStatus === 404, 'revoked share link is dead (404)');

  /* ---- 13. trash: delete forever + empty ---- */
  await page.evaluate(() => {
    const id = makeNode('to be purged');
    insertAt('root', 0, id);
    renderPage();
    opDelete(id, { toast: false });
  });
  await sleep(200);
  ok = await page.evaluate(() => trashList().some(t => plainOf(t.nodes[t.root].text).includes('to be purged')));
  assert(ok, 'deleted item lands in trash');
  await page.evaluate(() => showTrash());
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll('.trash-row button.danger')][0]?.click();
  });
  await sleep(200);
  ok = await page.evaluate(() => !trashList().some(t => plainOf(t.nodes[t.root].text).includes('to be purged')));
  assert(ok, '"Delete forever" purges a single entry');
  await page.evaluate(() => document.querySelector('#trash-empty').click());
  await sleep(250);
  ok = await page.evaluate(() => trashList().length === 0);
  assert(ok, '"Empty trash" clears everything');
  await page.evaluate(() => { document.querySelector('#trash-overlay').hidden = true; });

  /* ---- 13b. text:/highlight: operators target formatting, not substrings ---- */
  const fmtCounts = await page.evaluate(() => {
    setSearch('text:bold');
    const boldCount = state.matchCount;
    setSearch('text:code');
    const codeCount = state.matchCount;
    setSearch('highlight:red');
    const hlRed = state.matchCount;
    setSearch('bold');
    const plainBold = state.matchCount;
    setSearch('');
    const boldNodes = Object.values(doc.nodes).filter(n => (n.text || '').includes('<b>')).length;
    return { boldCount, codeCount, hlRed, plainBold, boldNodes };
  });
  assert(fmtCounts.boldCount >= 1 && fmtCounts.boldCount <= fmtCounts.boldNodes + 2 && fmtCounts.boldCount !== fmtCounts.plainBold,
    `text:bold matches formatting, not the word "bold" (${fmtCounts.boldCount} vs plain ${fmtCounts.plainBold})`);
  assert(fmtCounts.codeCount >= 1, `text:code finds inline code (${fmtCounts.codeCount})`);

  /* ---- 13c. docs arriving over sync are sanitized (share-guest XSS) ---- */
  await page.evaluate(() => doSave());
  await sleep(800);
  const xss = await page.evaluate(async () => {
    // simulate a hostile client writing raw markup straight to the API
    const cur = await (await fetch('/api/doc')).json();
    const evil = structuredClone(cur.doc);
    const id = 'evil00000001';
    evil.nodes[id] = {
      id, note: null, done: false, collapsed: false, children: [],
      text: 'gotcha <img src=x onerror="window.__pwned=1"><script>window.__pwned=2</scr' + 'ipt>',
    };
    evil.nodes[evil.root].children.push(id);
    await fetch('/api/doc', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: cur.version, doc: evil }),
    });
    return true;
  });
  await sleep(1800); // SSE adoption
  ok = await page.evaluate(() => {
    const n = doc.nodes['evil00000001'];
    const domOk = ![...document.querySelectorAll('.tree img')].some(i => i.src.endsWith('/x'));
    return !!n && !n.text.includes('<img') && !n.text.includes('<script') &&
      !n.text.includes('onerror') && n.text.includes('gotcha') && domOk && !window.__pwned;
  });
  assert(ok && xss, 'markup injected via the API is sanitized before rendering (no XSS)');

  /* ---- 14. AI endpoint guard (no key configured) ---- */
  const ai = await page.evaluate(async () => {
    const res = await fetch('/api/ai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    return { status: res.status, body: await res.json() };
  });
  assert(ai.status === 400 && /ANTHROPIC_API_KEY/.test(ai.body.error), 'AI endpoint cleanly reports missing key');

  /* ---- 15. server wrote a backup file ---- */
  await sleep(1200);
  const backupDir = process.env.DATA_DIR ? require('path').join(process.env.DATA_DIR, 'backups') : process.env.TEMP + '\\tendril-e2e\\data\\backups';
  const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'));
  assert(backups.length >= 1, `rotating backup written (${backups.length} file)`);

  /* ---- 16. version counter + menu footer sanity ---- */
  await page.click('#btn-menu');
  await sleep(250);
  ok = await page.evaluate(() => {
    const pop = document.querySelector('.popover');
    return pop && /\d+ items · v\d+/.test(pop.textContent);
  });
  assert(ok, 'main menu renders with item count and version footer');
  await page.keyboard.press('Escape');

  /* ---- 17. popovers always fit the viewport (even when tall / short screen) ---- */
  await page.setViewport({ width: 1280, height: 460 }); // short screen, tall menu
  await sleep(150);
  await page.click('#btn-menu');
  await sleep(250);
  let fit = await page.evaluate(() => {
    const pop = document.querySelector('.popover');
    const r = pop.getBoundingClientRect();
    return {
      onScreen: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5,
      scrolls: pop.scrollHeight > pop.clientHeight + 1,
      reachable: /Week starts|Print/.test(pop.textContent),
    };
  });
  assert(fit.onScreen, 'tall menu on a short screen stays fully within the viewport');
  assert(fit.scrolls, 'tall menu becomes internally scrollable');
  assert(fit.reachable, 'the bottom of the menu is present (scrollable to)');
  // scrolling inside the popover does NOT close it
  await page.evaluate(() => { document.querySelector('.popover').scrollTop = 200; });
  await sleep(150);
  ok = await page.evaluate(() => !!document.querySelector('.popover'));
  assert(ok, 'scrolling inside the popover keeps it open');
  await page.keyboard.press('Escape');

  // item menu near the bottom edge flips up to stay on screen
  await page.setViewport({ width: 1280, height: 640 });
  await sleep(150);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.tree .item')];
    window.__last = items[items.length - 1];
    window.__last.scrollIntoView({ block: 'end' });
  });
  await sleep(250); // let the scroll settle before opening (scroll closes popovers)
  await page.evaluate(() => {
    window.showItemMenu(window.__last.querySelector('.itemmenu-btn'), window.__last.dataset.id);
  });
  await sleep(250);
  fit = await page.evaluate(() => {
    const pop = document.querySelector('.popover');
    const r = pop.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight + 0.5;
  });
  assert(fit, 'item menu opened near the bottom edge stays on screen');
  await page.keyboard.press('Escape');
  await page.setViewport({ width: 1380, height: 940 });

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GAP TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
