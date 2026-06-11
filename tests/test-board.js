/* Kanban board interaction tests: edit cards, add cards, drag cards across columns. */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 940 });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  // build: Project board with To do [task A, task B], Doing [task C], Done []
  await page.evaluate(() => {
    const b = makeNode('Project', { format: 'board' });
    insertAt('root', 0, b);
    const cols = {};
    for (const name of ['To do', 'Doing', 'Done']) {
      const c = makeNode(name);
      insertAt(b, kidsOf(b).length, c);
      cols[name] = c;
    }
    for (const t of ['task A', 'task B']) insertAt(cols['To do'], kidsOf(cols['To do']).length, makeNode(t));
    insertAt(cols['Doing'], 0, makeNode('task C'));
    renderPage();
    window.__board = b;
  });
  await sleep(300);

  const colCount = await page.evaluate(() => document.querySelectorAll('.board > .board-col').length);
  assert(colCount === 3, `board renders 3 columns (${colCount})`);

  // 1. edit a card in place
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.board .content')].find(c => c.textContent === 'task A');
    card.focus();
  });
  await page.keyboard.press('End');
  await page.keyboard.type(' (edited)');
  await sleep(600);
  let ok = await page.evaluate(() =>
    Object.values(doc.nodes).some(n => plainOf(n.text).includes('task A (edited)')));
  assert(ok, 'cards are editable in place');

  // 2. Enter on a card adds a sibling card in the same column
  await page.keyboard.press('Enter');
  await page.keyboard.type('task D');
  await sleep(600);
  ok = await page.evaluate(() => {
    const board = window.__board;
    const todo = kidsOf(board).find(c => plainOf(doc.nodes[c].text) === 'To do');
    return kidsOf(todo).map(id => plainOf(doc.nodes[id].text)).join(',');
  });
  assert(ok.includes('task D') && ok.split(',').length === 3, `Enter adds a card in the same column (${ok})`);

  // 3. drag "task D" from "To do" into "Done"
  const coords = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.board .item')];
    const d = cards.find(c => c.querySelector(':scope > .row .content')?.textContent === 'task D');
    const from = d.querySelector(':scope > .row .bullet').getBoundingClientRect();
    const cols = [...document.querySelectorAll('.board > .board-col')];
    const doneCol = cols.find(c => c.textContent.includes('Done'));
    const doneHead = doneCol.querySelector(':scope > .item > .row').getBoundingClientRect();
    return { fx: from.x + 6, fy: from.y + 6, tx: doneHead.x + 40, ty: doneHead.bottom + 8 };
  });
  await page.mouse.move(coords.fx, coords.fy);
  await page.mouse.down();
  await page.mouse.move(coords.fx + 25, coords.fy + 10, { steps: 5 });
  await page.mouse.move(coords.tx, coords.ty, { steps: 12 });
  await sleep(150);
  const indicatorAt = await page.evaluate(() => {
    const ind = document.querySelector('#drop-indicator');
    if (ind.hidden) return null;
    return { left: parseFloat(ind.style.left), top: parseFloat(ind.style.top) };
  });
  await page.mouse.up();
  await sleep(300);
  const placement = await page.evaluate(() => {
    const board = window.__board;
    const byName = name => kidsOf(board).find(c => plainOf(doc.nodes[c].text) === name);
    const list = col => kidsOf(byName(col)).map(id => plainOf(doc.nodes[id].text)).join(',');
    return { todo: list('To do'), doing: list('Doing'), done: list('Done') };
  });
  console.log('       placement:', JSON.stringify(placement), 'indicator:', JSON.stringify(indicatorAt));
  assert(placement.done.includes('task D') && !placement.todo.includes('task D'),
    'dragging a card moves it between columns');

  // 4. reorder columns: drag "Doing" column before "To do"
  const colDrag = await page.evaluate(() => {
    document.querySelector('.board').scrollLeft = 0;
    const cols = [...document.querySelectorAll('.board > .board-col')];
    const doing = cols.find(c => c.textContent.includes('Doing'));
    const todo = cols.find(c => c.textContent.includes('To do'));
    const from = doing.querySelector(':scope > .item > .row .bullet').getBoundingClientRect();
    const to = todo.getBoundingClientRect();
    const boardRect = document.querySelector('.board').getBoundingClientRect();
    // aim at the visible part of the target column
    const tx = Math.max(to.x + 20, boardRect.x + 12);
    return { fx: from.x + 6, fy: from.y + 6, tx, ty: to.y + 40 };
  });
  await page.evaluate(() => {
    const orig = window.boardDropTarget;
    window.boardDropTarget = (x, y) => {
      const r = orig(x, y);
      window.__dbg = {
        x: Math.round(x), y: Math.round(y),
        els: document.elementsFromPoint(x, y).slice(0, 6).map(e => (e.className + '').slice(0, 25)),
        result: r ? 'hit' : 'null',
      };
      return r;
    };
  });
  await page.mouse.move(colDrag.fx, colDrag.fy);
  await page.mouse.down();
  await page.mouse.move(colDrag.fx + 25, colDrag.fy + 10, { steps: 5 });
  await page.mouse.move(colDrag.tx, colDrag.ty, { steps: 12 });
  await sleep(120);
  console.log('       under pointer:', await page.evaluate(() => JSON.stringify(window.__dbg)));
  const dbg = await page.evaluate(() => {
    const els = document.elementsFromPoint(window.__lastX || 0, window.__lastY || 0).map(e => e.className?.toString?.().slice(0, 30));
    return {
      target: drag?.target ? { parent: plainOf(doc.nodes[drag.target.parent]?.text || '?'), index: drag.target.index } : null,
      colDragId: plainOf(doc.nodes[drag?.id]?.text || '?'),
    };
  });
  console.log('       column drag target:', JSON.stringify(dbg));
  await page.mouse.up();
  await sleep(300);
  ok = await page.evaluate(() => {
    const names = kidsOf(window.__board).map(id => plainOf(doc.nodes[id].text));
    return names.join(',') === 'Doing,To do,Done';
  });
  if (!ok) console.log('       order now:', await page.evaluate(() => kidsOf(window.__board).map(id => plainOf(doc.nodes[id].text)).join(',')));
  assert(ok, 'dragging a column header reorders columns');

  // 5. zoom into a column from the board (real click on bullet)
  const bulletPos = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.board > .board-col')];
    const doing = cols.find(c => c.textContent.includes('Doing'));
    const b = doing.querySelector(':scope > .item > .row .bullet').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.click(bulletPos.x, bulletPos.y);
  await sleep(350);
  const title = await page.evaluate(() => document.querySelector('#zoom-title').textContent);
  assert(title === 'Doing', `clicking a column bullet zooms into it ("${title}")`);

  // 6. drag a card OUT of the board into the plain outline
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(350);
  const outDrag = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.board .item')];
    const c = cards.find(x => x.querySelector(':scope > .row .content')?.textContent === 'task C');
    const from = c.querySelector(':scope > .row .bullet').getBoundingClientRect();
    const welcome = [...document.querySelectorAll('.tree > .item')]
      .find(e => (e.querySelector(':scope > .row .content')?.textContent || '').includes('Welcome'));
    const to = welcome.querySelector(':scope > .row .content').getBoundingClientRect();
    return { fx: from.x + 6, fy: from.y + 6, tx: to.x + 60, ty: to.bottom - 2 };
  });
  await page.mouse.move(outDrag.fx, outDrag.fy);
  await page.mouse.down();
  await page.mouse.move(outDrag.fx + 25, outDrag.fy + 10, { steps: 5 });
  await page.mouse.move(outDrag.tx, outDrag.ty, { steps: 12 });
  await sleep(120);
  await page.mouse.up();
  await sleep(300);
  ok = await page.evaluate(() => {
    const cardInBoard = [...document.querySelectorAll('.board .content')].some(c => c.textContent === 'task C');
    return !cardInBoard && Object.values(doc.nodes).some(n => plainOf(n.text) === 'task C');
  });
  assert(ok, 'cards can be dragged out of the board into the outline');

  // 7. zooming INTO the board keeps the kanban view (Workflowy behavior)
  await page.evaluate(() => { location.hash = '#/n/' + window.__board; });
  await sleep(400);
  ok = await page.evaluate(() => {
    const board = document.querySelector('.tree > .board.board-zoomed');
    return !!board && board.querySelectorAll(':scope > .board-col').length === 3 &&
      document.querySelector('#zoom-title').textContent === 'Project';
  });
  assert(ok, 'zoomed board renders full-page kanban columns');

  // 8. drag a card between columns while zoomed
  const zDrag = await page.evaluate(() => {
    document.querySelector('.board').scrollLeft = 0;
    const cards = [...document.querySelectorAll('.board .item')];
    const c = cards.find(x => x.querySelector(':scope > .row .content')?.textContent === 'task B');
    const from = c.querySelector(':scope > .row .bullet').getBoundingClientRect();
    const cols = [...document.querySelectorAll('.board > .board-col')];
    const doing = cols.find(x => x.textContent.includes('Doing'));
    const head = doing.querySelector(':scope > .item > .row').getBoundingClientRect();
    return { fx: from.x + 6, fy: from.y + 6, tx: head.x + 40, ty: head.bottom + 10 };
  });
  console.log('       zdrag coords:', JSON.stringify(zDrag));
  await page.mouse.move(zDrag.fx, zDrag.fy);
  await page.mouse.down();
  await page.mouse.move(zDrag.fx + 25, zDrag.fy + 10, { steps: 5 });
  await page.mouse.move(zDrag.tx, zDrag.ty, { steps: 12 });
  await sleep(120);
  console.log('       zoomed drag state:', await page.evaluate(() => JSON.stringify({
    started: drag?.started,
    target: drag?.target ? plainOf(doc.nodes[drag.target.parent]?.text || 'ROOT?') + '@' + drag.target.index : null,
    dbg: window.__dbg,
  })));
  await page.mouse.up();
  await sleep(300);
  ok = await page.evaluate(() => {
    const byName = name => kidsOf(window.__board).find(c => plainOf(doc.nodes[c].text) === name);
    return kidsOf(byName('Doing')).map(id => plainOf(doc.nodes[id].text)).includes('task B');
  });
  if (!ok) console.log('       cols now:', await page.evaluate(() =>
    kidsOf(window.__board).map(c => plainOf(doc.nodes[c].text) + ':[' + kidsOf(c).map(k => plainOf(doc.nodes[k].text)).join('|') + ']').join(' ')));
  assert(ok, 'cards drag between columns in the zoomed board too');

  // 9. zooming into a single column shows a plain list
  await page.evaluate(() => {
    const col = kidsOf(window.__board).find(c => plainOf(doc.nodes[c].text) === 'Doing');
    location.hash = '#/n/' + col;
  });
  await sleep(400);
  ok = await page.evaluate(() =>
    !document.querySelector('.tree .board') &&
    document.querySelector('#zoom-title').textContent === 'Doing' &&
    [...document.querySelectorAll('.tree .content')].some(c => c.textContent === 'task B'));
  assert(ok, 'zooming into a column shows its cards as a plain list');

  // 10. Enter on the zoomed board title creates a new first column
  await page.evaluate(() => { location.hash = '#/n/' + window.__board; });
  await sleep(400);
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('Backlog');
  await sleep(600);
  ok = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.tree > .board > .board-col')];
    return cols.length === 4 && cols[0].textContent.includes('Backlog');
  });
  assert(ok, 'Enter on the board title adds a new column');

  // 11. cards are draggable by their body, not only the dot
  const bodyDrag = await page.evaluate(() => {
    document.querySelector('.board').scrollLeft = 0;
    const cols = [...document.querySelectorAll('.board > .board-col')];
    const src = cols.find(c => c.querySelector('.children .item'));
    const dst = cols.find(c => c !== src && !c.classList.contains('collapsed'));
    const card = src.querySelector('.children .item');
    const cont = card.querySelector(':scope > .row .content').getBoundingClientRect();
    const head = dst.querySelector(':scope > .item > .row').getBoundingClientRect();
    return {
      cardId: card.dataset.id, dstId: dst.querySelector(':scope > .item').dataset.id,
      fx: cont.x + 25, fy: cont.y + cont.height / 2, tx: head.x + 40, ty: head.bottom + 12,
    };
  });
  await page.mouse.move(bodyDrag.fx, bodyDrag.fy);
  await page.mouse.down();
  await page.mouse.move(bodyDrag.fx + 22, bodyDrag.fy + 6, { steps: 4 });
  await page.mouse.move(bodyDrag.tx, bodyDrag.ty, { steps: 10 });
  await sleep(120);
  await page.mouse.up();
  await sleep(300);
  ok = await page.evaluate(d => kidsOf(d.dstId).includes(d.cardId), bodyDrag);
  assert(ok, 'a card can be dragged by its body (not only the dot)');

  // 12. columns collapse to a labeled bar and expand again
  const colId = await page.evaluate(() => {
    const col = [...document.querySelectorAll('.board-col')].find(c => c.querySelector('.col-toggle'));
    const id = col.querySelector('.col-toggle').dataset.colToggle;
    col.querySelector('.col-toggle').click();
    return id;
  });
  await sleep(150);
  ok = await page.evaluate(id => {
    const col = [...document.querySelectorAll('.board-col')].find(c => c.querySelector(`[data-col-toggle="${id}"]`));
    return doc.nodes[id].collapsed === true && col.classList.contains('collapsed') &&
      !col.querySelector('.children .item') && !!col.querySelector('.cc-title');
  }, colId);
  assert(ok, 'clicking the column toggle collapses it to a labeled bar');
  await page.evaluate(id => document.querySelector(`[data-col-toggle="${id}"]`).click(), colId);
  await sleep(150);
  ok = await page.evaluate(id => doc.nodes[id].collapsed === false, colId);
  assert(ok, 'clicking again expands the column');

  // 13. Enter on a column header adds a card to that column, not a new lane
  const before13 = await page.evaluate(() => document.querySelectorAll('.board > .board-col').length);
  await page.evaluate(() => {
    const col = [...document.querySelectorAll('.board-col')].find(c => !c.classList.contains('collapsed'));
    const content = col.querySelector(':scope > .item > .row .content');
    content.focus();
    setCaretOffset(content, 'end');
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('keyed card');
  await sleep(500);
  const r13 = await page.evaluate(() => {
    const after = document.querySelectorAll('.board > .board-col').length;
    const cardId = Object.keys(doc.nodes).find(id => plainOf(doc.nodes[id].text) === 'keyed card');
    const parent = Object.keys(doc.nodes).find(id => kidsOf(id).includes(cardId));
    const grand = Object.keys(doc.nodes).find(id => kidsOf(id).includes(parent));
    return { after, isCard: doc.nodes[grand]?.format === 'board' };
  });
  assert(r13.after === before13 && r13.isCard, `Enter on a column header adds a card, not a lane (cols ${before13}→${r13.after}, card=${r13.isCard})`);

  // 14. collapsing the board node hides its columns (inline view)
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(350);
  ok = await page.evaluate(() => {
    N(window.__board).collapsed = true; renderPage();
    const hidden = !document.querySelector(`.item[data-id="${window.__board}"] .board`);
    N(window.__board).collapsed = false; renderPage();
    return hidden;
  });
  assert(ok, 'collapsing the board node hides its columns');

  // 15. collapsing/expanding a board keeps the caret on it (so you can keep toggling)
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);
  await page.evaluate(() => focusItem(window.__board, 'text', 'end'));
  await sleep(60);
  await page.keyboard.down('Control'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Control');
  await sleep(150);
  let kc = await page.evaluate(() => ({
    onBoard: document.activeElement?.closest?.('.item')?.dataset.id === window.__board,
    collapsed: N(window.__board).collapsed === true,
    hidden: !document.querySelector(`.item[data-id="${window.__board}"] .board`),
  }));
  assert(kc.onBoard && kc.collapsed && kc.hidden, `Ctrl+↑ collapses a board and keeps the caret on it (${JSON.stringify(kc)})`);
  await page.keyboard.down('Control'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Control');
  await sleep(150);
  kc = await page.evaluate(() => ({
    onBoard: document.activeElement?.closest?.('.item')?.dataset.id === window.__board,
    expanded: N(window.__board).collapsed === false,
    shown: !!document.querySelector(`.item[data-id="${window.__board}"] .board`),
  }));
  assert(kc.onBoard && kc.expanded && kc.shown, `Ctrl+↓ expands a board and keeps the caret on it (${JSON.stringify(kc)})`);

  // 16. ArrowDown from a zoomed board header reaches the cards even when columns are collapsed
  await page.evaluate(() => {
    location.hash = '#/n/' + window.__board;
    kidsOf(window.__board).forEach(c => N(c).collapsed = true);
    renderPage();
  });
  await sleep(350);
  await page.evaluate(() => setCaretOffset(document.querySelector('#zoom-title'), 'end'));
  await sleep(60);
  await page.keyboard.press('ArrowDown');
  await sleep(150);
  const nav = await page.evaluate(() => {
    const el = document.activeElement;
    const firstCol = kidsOf(window.__board)[0];
    return {
      inFirstCol: el?.closest?.('.item')?.dataset.id === firstCol,
      expanded: N(firstCol).collapsed === false,
    };
  });
  assert(nav.inFirstCol && nav.expanded, `ArrowDown from a collapsed-board header opens the first column and enters it (${JSON.stringify(nav)})`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nBOARD TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
