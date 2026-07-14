/* Regression tests for the 2026-06 review fixes: share-merge scoping, files gate,
   sync sanitization, markdown-shortcut marker text, undo burst, operator-only
   search, calendar year boundaries, month-grid rows, import format fidelity. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3211/';
const API = 'http://localhost:3215'; // self-spawned password server
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

const node = (id, text, children = [], extra = {}) =>
  ({ id, text, note: null, done: false, collapsed: false, children, m: Date.now(), ...extra });

(async () => {
  /* ================= Part A: server (own password-protected instance) ================= */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendril-fixes-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '3215', DATA_DIR: dataDir, TENDRIL_PASSWORD: 'pw' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(API + '/api/auth'); break; } catch { await sleep(100); }
    }
    const login = await fetch(API + '/api/login', {
      method: 'POST', body: JSON.stringify({ password: 'pw' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const authed = (url, opts = {}) =>
      fetch(API + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
    const getDoc = async () => (await (await authed('/api/doc')).json());

    // outline: root → [A (shared, child A1), B (private)]
    const doc = {
      root: 'root',
      nodes: {
        root: node('root', '', ['A', 'B']),
        A: node('A', 'shared item', ['A1']),
        A1: node('A1', 'inside the share'),
        B: node('B', 'private item'),
      },
    };
    let res = await authed('/api/doc', { method: 'PUT', body: JSON.stringify({ doc }) });
    assert(res.ok, 'owner can save the seed outline');
    let version = (await res.json()).version;

    const share = await (await authed('/api/shares', {
      method: 'POST', body: JSON.stringify({ nodeId: 'A', mode: 'edit' }),
    })).json();
    assert(!!share.token, 'edit share created for node A');
    const guestPut = body => fetch(`${API}/api/share/${share.token}/doc`, {
      method: 'PUT', body: JSON.stringify(body),
    });

    /* A1. scope escape: guest tries to overwrite B and root */
    res = await guestPut({
      baseVersion: version,
      doc: {
        root: 'A',
        nodes: {
          A: node('A', 'guest edit', ['A1']),
          A1: node('A1', 'guest child edit'),
          B: node('B', 'EVIL overwrite'),
          root: node('root', 'EVIL root', []),
        },
      },
    });
    assert(res.ok, 'guest save inside the share succeeds');
    let d = (await getDoc()).doc;
    assert(d.nodes.B.text === 'private item', 'guest cannot overwrite a node outside the share');
    assert(d.nodes.root.children.length === 2 && d.nodes.root.text === '', 'guest cannot touch the doc root');
    assert(d.nodes.A.text === 'guest edit' && d.nodes.A1.text === 'guest child edit',
      'legitimate guest edits inside the share are applied');
    version = (await getDoc()).version;

    /* A2. guest cannot reparent an outside node into the share */
    res = await guestPut({
      baseVersion: version,
      doc: { root: 'A', nodes: { A: node('A', 'guest edit', ['A1', 'B']), A1: node('A1', 'kid') } },
    });
    d = (await getDoc()).doc;
    assert(!d.nodes.A.children.includes('B'), 'outside node cannot be smuggled in as a child');
    version = (await getDoc()).version;

    /* A3. guest-crafted cycle does not hang the server or persist */
    res = await guestPut({
      baseVersion: version,
      doc: {
        root: 'A',
        nodes: {
          A: node('A', 'guest edit', ['X']),
          X: node('X', 'x', ['Y']),
          Y: node('Y', 'y', ['X']),
        },
      },
    });
    assert(res.ok, 'cyclic guest payload is accepted without hanging');
    const t0 = Date.now();
    const shared = await (await fetch(`${API}/api/share/${share.token}/doc`)).json();
    assert(Date.now() - t0 < 2000, 'share GET returns promptly after cyclic payload');
    d = (await getDoc()).doc;
    assert(!(d.nodes.Y && d.nodes.Y.children.includes('X')), 'cycle is broken on merge (claim-once)');
    version = (await getDoc()).version;

    /* A4. guest deletions land in the trash */
    res = await guestPut({
      baseVersion: version,
      doc: { root: 'A', nodes: { A: node('A', 'guest edit', []) } },
    });
    d = (await getDoc()).doc;
    const trashed = (d.trash || []).some(t => Object.values(t.nodes).some(n => n.id === 'X' || n.id === 'Y'));
    assert(trashed, 'nodes dropped by a guest save are recoverable from the trash');
    version = (await getDoc()).version;

    /* A5. sync writes are sanitized server-side */
    const dirty = (await getDoc()).doc;
    dirty.nodes.B.text = 'hi <script>alert(1)</script><b onclick="x()">bold</b>';
    res = await authed('/api/doc', {
      method: 'PUT', body: JSON.stringify({ baseVersion: version, doc: dirty }),
    });
    d = (await getDoc()).doc;
    assert(!/<script|onclick/.test(d.nodes.B.text) && /<b/.test(d.nodes.B.text),
      'PUT /api/doc strips script/handlers server-side but keeps simple markup');
    version = (await getDoc()).version;

    /* A6. files gate: only files inside a shared subtree are public */
    const up = await (await authed('/api/upload?name=secret.txt', { method: 'POST', body: 'top secret' })).json();
    const cur = (await getDoc()).doc;
    cur.nodes.B.files = [{ url: up.url, name: 'secret.txt', type: 'text/plain' }];
    await authed('/api/doc', { method: 'PUT', body: JSON.stringify({ baseVersion: version, doc: cur }) });
    let anon = await fetch(API + up.url);
    assert(anon.status === 401, 'file on a private node stays 401 even though a share exists');
    version = (await getDoc()).version;
    const cur2 = (await getDoc()).doc;
    cur2.nodes.B.files = [];
    cur2.nodes.A.files = [{ url: up.url, name: 'secret.txt', type: 'text/plain' }];
    await authed('/api/doc', { method: 'PUT', body: JSON.stringify({ baseVersion: version, doc: cur2 }) });
    anon = await fetch(API + up.url);
    assert(anon.status === 200, 'file attached inside the shared subtree is reachable for guests');

    /* A7. static path guard uses a separator-safe prefix check (raw request —
       fetch would normalize the dot segments away client-side) */
    const rawStatus = await new Promise(resolve => {
      require('http').get({ host: 'localhost', port: 3215, path: '/../public2/x' },
        r => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0));
    });
    assert(rawStatus === 403, `traversal toward a sibling "public*" dir is forbidden (got ${rawStatus})`);
  } finally {
    server.kill();
    setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} }, 500);
  }

  /* ================= Part B: browser (standard 3211 test server) ================= */
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(URL + '#/outline', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  const newItem = () => page.evaluate(() => {
    const id = opNewAt('root', kidsOf('root').length);
    return id;
  });
  const modelText = id => page.evaluate(i => doc.nodes[i] ? doc.nodes[i].text : null, id);

  /* B1. markdown shortcuts leave no marker text in the model */
  let id = await newItem();
  await sleep(150);
  await page.keyboard.type('##');
  await page.keyboard.press(' ');
  await sleep(150);
  await page.keyboard.type('My Heading');
  await sleep(700); // let the debounced commit land
  await page.evaluate(() => commitActiveText());
  assert(await page.evaluate(i => doc.nodes[i].format === 'h2', id), '"## " sets the h2 format');
  assert((await modelText(id)) === 'My Heading', `"## " stores clean text (got "${await modelText(id)}")`);

  id = await newItem();
  await sleep(150);
  await page.keyboard.type('1.');
  await page.keyboard.press(' ');
  await sleep(150);
  await page.keyboard.type('Buy milk');
  await sleep(700);
  await page.evaluate(() => commitActiveText());
  assert(await page.evaluate(i => doc.nodes[i].format === 'number', id), '"1. " sets the numbered format');
  assert((await modelText(id)) === 'Buy milk', `"1. " stores clean text (got "${await modelText(id)}")`);

  /* B2. '---' + Enter divider stores empty text */
  id = await newItem();
  await sleep(150);
  await page.keyboard.type('---');
  await page.keyboard.press('Enter');
  await sleep(300);
  assert(await page.evaluate(i => doc.nodes[i].format === 'divider' && doc.nodes[i].text === '', id),
    '"---" divider stores empty text');

  /* B3. ``` code block stores empty text */
  id = await newItem();
  await sleep(150);
  await page.keyboard.type('```');
  await sleep(300);
  assert(await page.evaluate(i => doc.nodes[i].format === 'codeblock' && doc.nodes[i].text === '', id),
    '"```" code block stores empty text');

  /* B4. undo right after undo+retype does not delete the item */
  id = await newItem();
  await sleep(150);
  await page.keyboard.type('CCC');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(50); // stay well inside the 800ms burst window
  await page.keyboard.type('DDD');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(200);
  const burst = await page.evaluate(i => ({ exists: !!doc.nodes[i], text: doc.nodes[i] ? plainOf(doc.nodes[i].text) : null }), id);
  assert(burst.exists, 'undo after a quick retype keeps the item (no over-undo)');
  assert(burst.text === '', `…and returns it to the pre-typing state (got "${burst.text}")`);

  /* B5. operator-only searches do not crash the render */
  for (const q of ['OR', '>', '-']) {
    await page.evaluate(s => setSearch(s), q);
    await sleep(150);
  }
  await page.evaluate(() => setSearch(''));
  await sleep(150);
  assert(pageErrors.length === 0, `operator-only searches render without errors (${pageErrors.join(' | ')})`);
  assert(await page.evaluate(() => document.querySelectorAll('.tree .item').length > 0),
    'outline still renders after operator-only search');

  /* B6. calendar month arrows carry the year */
  await page.evaluate(() => { snapshot(); const m = ensureMonth(2026, 0); markDirty(); zoomTo(m); });
  await sleep(400);
  await page.evaluate(() => { document.querySelector('#cal-strip .cs-nav button').click(); });
  await sleep(400);
  const prevMonth = await page.evaluate(() => ({ cy: N(state.zoom).cy, cm: N(state.zoom).cm }));
  assert(prevMonth.cy === 2025 && prevMonth.cm === 11,
    `‹ from January 2026 lands on December 2025 (got ${prevMonth.cy}-${prevMonth.cm + 1})`);
  await page.evaluate(() => { location.hash = '#/outline'; });
  await sleep(300);

  /* B7. month grid always renders whole weeks */
  await page.evaluate(() => { calMonth = new Date(2026, 5, 1); $('#calendar-overlay').hidden = false; renderCalendar(); });
  await sleep(200);
  const cells = await page.evaluate(() => document.querySelectorAll('#calendar-overlay .cal-day').length);
  assert(cells % 7 === 0 && cells >= 28, `month grid is row-aligned (${cells} cells)`);
  await page.evaluate(() => { $('#calendar-overlay').hidden = true; });

  /* B8. parsed forests keep formats everywhere (import/AI path) */
  const fidelity = await page.evaluate(() => {
    const forest = parseIndentedText('- [x] packed bag\n  ## section');
    materializeForest(forest, 'root');
    const kids = kidsOf('root').map(i => doc.nodes[i]);
    const todo = kids.find(n => plainOf(n.text).includes('packed bag'));
    const h = todo && kidsOf(todo.id).map(i => doc.nodes[i]).find(n => plainOf(n.text).includes('section'));
    return { todo: todo && todo.format === 'todo' && todo.done === true, h: h && h.format === 'h2' };
  });
  assert(fidelity.todo, 'materializeForest keeps todo + done state');
  assert(fidelity.h, 'materializeForest keeps heading formats on children');

  /* B9. duplicating an item keeps its comments */
  const dupe = await page.evaluate(() => {
    const id = opNewAt('root', kidsOf('root').length);
    document.activeElement?.blur(); // opDuplicate commits the focused editor first
    doc.nodes[id].text = 'commented';
    doc.nodes[id].comments = [{ text: 'a comment', ts: Date.now() }];
    opDuplicate(id);
    const sibs = kidsOf('root').map(i => doc.nodes[i]).filter(n => plainOf(n.text).includes('commented'));
    return sibs.length === 2 && sibs.every(n => (n.comments || []).length === 1);
  });
  assert(dupe, 'duplicate copies comments');

  /* B10. selection ladder: Shift+arrows escalate at the text edge, Ctrl+A widens */
  const lids = await page.evaluate(() => {
    const p = makeNode('ladder parent'); insertAt('root', kidsOf('root').length, p);
    const c1 = makeNode('child one'); insertAt(p, 0, c1);
    const c2 = makeNode('child two'); insertAt(p, 1, c2);
    const s = makeNode('ladder sibling'); insertAt('root', kidsOf('root').length, s);
    renderPage();
    return { p, c1, c2, s };
  });
  const shiftPress = async key => {
    await page.keyboard.down('Shift'); await page.keyboard.press(key); await page.keyboard.up('Shift');
    await sleep(60);
  };
  await page.evaluate(ids => focusItem(ids.c1, 'text', 0), lids);
  await shiftPress('ArrowDown');
  let lad = await page.evaluate(() => ({ sel: !!state.sel, native: getSelection().toString() }));
  assert(!lad.sel && lad.native === 'child one', 'Shift+Down mid-text extends the text selection first');
  await shiftPress('ArrowDown');
  lad = await page.evaluate(() => state.sel && selIds());
  assert(lad && lad.length === 1 && lad[0] === lids.c1, 'Shift+Down at the text edge selects the bullet');
  await shiftPress('ArrowDown');
  lad = await page.evaluate(() => selIds());
  assert(lad.length === 2 && lad[1] === lids.c2, 'another Shift+Down extends the range to the next bullet');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await sleep(60);
  lad = await page.evaluate(() => ({ ids: selIds(), parent: state.sel && state.sel.parent }));
  assert(lad.parent === 'root' && lad.ids.includes(lids.p) && lad.ids.includes(lids.s),
    'Ctrl+A on a full sibling range escalates to the level above');
  await page.evaluate(ids => { state.sel = { parent: ids.p, anchor: ids.c2, focus: ids.c2 }; selRender(); }, lids);
  await page.keyboard.type('!');
  await sleep(700);
  await page.evaluate(() => commitActiveText());
  lad = await page.evaluate(ids => ({ sel: !!state.sel, text: plainOf(doc.nodes[ids.c2].text) }), lids);
  assert(!lad.sel && lad.text === 'child two!',
    `typing in selection mode exits and the character lands (got "${lad.text}")`);
  await page.evaluate(ids => focusItem(ids.c2, 'text', 0), lids);
  await shiftPress('ArrowUp');
  lad = await page.evaluate(() => state.sel && selIds());
  assert(lad && lad.length === 1, 'Shift+Up at offset 0 selects the bullet');
  await page.keyboard.press('Escape');
  await sleep(60);

  /* B11. new date/created search operators */
  const dops = await page.evaluate(() => {
    const iso = todayStr();
    const future = (() => { const d = new Date(); d.setDate(d.getDate() + 10); return isoOf(d); })();
    const a = makeNode(`alpha <time datetime="${iso}">today</time>`); insertAt('root', kidsOf('root').length, a);
    const b = makeNode(`beta <time datetime="${future}">soon</time>`); insertAt('root', kidsOf('root').length, b);
    renderPage();
    const has = (q, id) => { setSearch(q); return !!(state.matchSet && state.matchSet.has(id)); };
    const dowNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const [y, m, d] = iso.split('-').map(Number);
    const r = {
      today: has('date:today', a),
      todayNotFuture: has('date:today', b) === false,
      after: has('date-after:today', b),
      afterNotToday: has('date-after:today', a) === false,
      before: has('date-before:next-month', a),
      dow: has('day-of-week:' + dowNames[new Date(y, m - 1, d).getDay()], a),
      created: (setSearch('created:today'), state.matchCount >= 2),
    };
    setSearch('');
    return r;
  });
  assert(dops.today && dops.todayNotFuture, 'date:today matches a today-dated item only');
  assert(dops.after && dops.afterNotToday, 'date-after:today matches the future-dated item only');
  assert(dops.before, 'date-before:next-month matches an earlier-dated item');
  assert(dops.dow, 'day-of-week:<today> matches the today-dated item');
  assert(dops.created, 'created:today matches newly created items');

  /* B12. quick-filter chip row: open, drill, insert, stack, close */
  await page.evaluate(() => { setSearch(''); searchEl.blur(); });
  await page.focus('#search');
  await sleep(80);
  assert(await page.evaluate(() => !document.getElementById('search-dropdown').hidden),
    'focusing the search box opens the quick-filter dropdown');
  const clickOpt = label => page.evaluate(l => {
    const b = [...document.querySelectorAll('#search-panel .search-opt')].find(x => x.textContent === l);
    if (b) b.click();
    return !!b;
  }, label);
  await page.evaluate(() => document.querySelector('.search-chip[data-key="date"]').click());
  await sleep(50);
  let opts = await page.evaluate(() => [...document.querySelectorAll('#search-panel .search-opt')].map(b => b.textContent));
  assert(opts.includes('date:') && opts.includes('today'), 'date chip shows operator prefixes and quick values');
  await clickOpt('date:');
  await sleep(50);
  opts = await page.evaluate(() => [...document.querySelectorAll('#search-panel .search-opt')].map(b => b.textContent));
  assert(opts.some(t => t.startsWith('‹')) && opts.includes('this week'), 'drilling date: shows a back button and span values');
  await clickOpt('today');
  await sleep(60);
  assert(await page.evaluate(() => searchEl.value) === 'date:today', 'clicking a value inserts the complete token');
  await page.evaluate(() => document.querySelector('.search-chip[data-key="more"]').click());
  await sleep(40); await clickOpt('has:'); await sleep(40); await clickOpt('note'); await sleep(60);
  assert(await page.evaluate(() => searchEl.value) === 'date:today has:note', 'filters stack with a separating space');
  await page.evaluate(() => { setSearch(''); searchEl.blur(); });
  await sleep(60);
  assert(await page.evaluate(() => document.getElementById('search-dropdown').hidden),
    'blurring the search box closes the dropdown');

  /* B13. new node commands + slash / item-menu parity */
  const cmd = await page.evaluate(() => {
    const p = makeNode('cmd parent'); insertAt('root', kidsOf('root').length, p);
    const c1 = makeNode('cmd child 1'); insertAt(p, 0, c1);
    const c2 = makeNode('cmd child 2'); insertAt(p, 1, c2);
    const g = makeNode('cmd grandchild'); insertAt(c1, 0, g);
    N(c1).done = true;
    renderPage();
    const wasAI = state.aiEnabled;
    state.aiEnabled = true;
    const slash = slashCommands({ id: p, field: 'text', el: nodeAnchor(p) }).map(c => c.label);
    state.aiEnabled = wasAI;

    opCount(p);
    const countToast = [...document.querySelectorAll('.toast')].some(t => /3 items/.test(t.textContent));

    let exported = null;
    const realDl = window.download;
    window.download = (name, _mime, content) => { exported = { name, content }; };
    exportNode(p, 'md');
    window.download = realDl;

    mirrorItemToDate(p, todayStr());
    const day = findDay(todayStr());
    const mirroredUnderDay = !!day && kidsOf(day).some(k => isMirror(k) && mirrorTarget(k) === p);

    setSubtreeCollapsed(p, true);
    const collapsed = N(c1).collapsed === true && N(p).collapsed === false;

    return {
      slash: ['Count items', 'Export…', 'Mirror to Today', 'Move to Date…', 'Mirror to…', 'Sort A → Z'].every(l => slash.includes(l)),
      slashAI: slash.includes('AI: Summarize'),
      countToast,
      exportedMd: !!exported && /cmd parent/.test(exported.content) && exported.name.endsWith('.md'),
      mirroredUnderDay,
      collapsed,
    };
  });
  assert(cmd.slash, 'slash menu exposes the full item-action set');
  assert(cmd.slashAI, 'slash menu includes canned AI actions when AI is enabled');
  assert(cmd.countToast, 'Count items reports the descendant count');
  assert(cmd.exportedMd, 'per-item Markdown export serializes the subtree');
  assert(cmd.mirroredUnderDay, "Mirror to Today places a mirror under today's calendar day");
  assert(cmd.collapsed, 'Collapse all folds descendants but keeps the item open');

  const menuLabels = await page.evaluate(() => {
    const p = kidsOf('root').find(id => plainOf(N(id).text).includes('cmd parent'));
    closeAllPopovers();
    window.showItemMenu(nodeAnchor(p), p);
    const labels = [...document.querySelectorAll('.popover button')].map(b => b.textContent);
    closeAllPopovers();
    return labels;
  });
  const need = ['Insert template…', 'Count items', 'Export…', 'Mirror to Today', 'Move to Date…', 'Expand all'];
  assert(need.every(l => menuLabels.some(t => t.includes(l))), `item ⋯ menu exposes ${need.join(', ')}`);

  /* B14. topbar pinned so topbar + full-height sidebar fill the viewport exactly
     (the old 52px magic number vs ~54px real topbar left a sub-pixel scroll) */
  const layout = await page.evaluate(() => {
    const tb = document.querySelector('.topbar').offsetHeight;
    const sb = document.querySelector('.sidebar').offsetHeight; // height: calc(100dvh - var(--topbar-h))
    return { tb: Math.round(tb), stack: Math.round(tb + sb), vh: window.innerHeight };
  });
  assert(layout.tb === 52, `topbar pinned to --topbar-h (got ${layout.tb}px)`);
  assert(Math.abs(layout.stack - layout.vh) <= 1, `topbar + sidebar fill the viewport with no overflow (stack ${layout.stack} vs vh ${layout.vh})`);

  /* B15. Ctrl+A selecting a single item opens its menu; manipulating dismisses it */
  await page.evaluate(() => {
    closeAllPopovers();
    const p = makeNode('menu on ctrl-a'); insertAt('root', kidsOf('root').length, p);
    const s = makeNode('a sibling'); insertAt('root', kidsOf('root').length, s);
    renderPage();
    focusItem(p, 'text', 'end');
  });
  await sleep(80);
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await sleep(120);
  let sa = await page.evaluate(() => ({ menu: !!document.querySelector('.popover'), sel: state.sel && selIds().length }));
  assert(sa.menu && sa.sel === 1, `Ctrl+A selects the item and opens its menu (menu=${sa.menu}, sel=${sa.sel})`);
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift');
  await sleep(120);
  sa = await page.evaluate(() => ({ menu: !!document.querySelector('.popover'), sel: selIds().length }));
  assert(!sa.menu && sa.sel === 2, `extending the selection dismisses the menu and grows it (menu=${sa.menu}, sel=${sa.sel})`);
  await page.keyboard.press('Escape');
  await sleep(60);

  assert(pageErrors.length === 0, `no page errors across the suite (${pageErrors.join(' | ')})`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
