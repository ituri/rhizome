// Live {{query}} engine: field-filter operators lifted from the search DSL ({is:todo}, ref
// matches) plus the result views ({view:table|board|calendar}).
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-q-')); const PORT = 3276; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;

  // A day page holds a todo and a bullet linking to "Projekt X"; a Queries page holds the query blocks.
  const doc = { root: 'root', nodes: {
    root: { id: 'root', text: '', children: ['projekt', 'day', 'queries'] },
    projekt: { id: 'projekt', text: 'Projekt X', children: [] },
    day: { id: 'day', cal: 'day', cd: '2026-07-20', text: 'July 20th, 2026', children: ['t1', 't2'] },
    t1: { id: 't1', text: 'buy milk', format: 'todo', children: [] },
    t2: { id: 't2', text: 'call Anna about <a href="#/n/projekt">Projekt X</a>', children: [] },
    queries: { id: 'queries', text: 'Queries', children: ['q1', 'q2', 'q3', 'q4', 'q5'] },
    q1: { id: 'q1', text: '{{query: {is:todo}}}', children: [] },
    q2: { id: 'q2', text: '{{query: <a href="#/n/projekt">Projekt X</a>}}', children: [] },
    q3: { id: 'q3', text: '{{query: {is:todo}}} {view:table}', children: [] },
    q4: { id: 'q4', text: '{{query: {is:todo}}} {view:board}', children: [] },
    q5: { id: 'q5', text: '{{query: {is:todo}}} {view:calendar}', children: [] },
  } };
  await fetch(`${base}/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ doc }) });

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/n/queries', { waitUntil: 'domcontentloaded' }); await sleep(1500);

  const q = async (id) => p.evaluate(sel => {
    const el = document.querySelector(`.item[data-id="${sel}"] .query-block`);
    if (!el) return null;
    return {
      head: el.querySelector('.query-head')?.textContent || '',
      text: el.textContent,
      table: !!el.querySelector('table.query-table'),
      tableRow: el.querySelector('table.query-table tbody tr td')?.textContent || '',
      board: !!el.querySelector('.query-board .qb-col'),
      calendar: !!el.querySelector('.query-calendar .qc-grid'),
      chip: el.querySelector('.qc-chip')?.textContent || '',
    };
  }, id);

  // field filter {is:todo}
  const r1 = await q('q1');
  ok(r1 !== null, 'q1 renders a query-block');
  ok(r1 && /1 result/.test(r1.head), `{is:todo} → 1 result (head "${r1 && r1.head}")`);
  ok(r1 && r1.text.includes('buy milk'), '{is:todo} lists the todo bullet');
  ok(r1 && !r1.text.includes('call Anna'), '{is:todo} excludes the non-todo bullet');

  // page-ref match
  const r2 = await q('q2');
  ok(r2 && /1 result/.test(r2.head), `ref [[Projekt X]] → 1 result (head "${r2 && r2.head}")`);
  ok(r2 && r2.text.includes('call Anna'), 'ref query lists the bullet linking the page');

  // table view
  const r3 = await q('q3');
  ok(r3 && r3.table, '{view:table} renders a table');
  ok(r3 && r3.tableRow.includes('buy milk'), 'table has the result row');
  ok(r3 && /table/.test(r3.head), 'head notes the table view');

  // board view
  const r4 = await q('q4');
  ok(r4 && r4.board, '{view:board} renders board columns');

  // calendar view
  const r5 = await q('q5');
  ok(r5 && r5.calendar, '{view:calendar} renders a month grid');
  ok(r5 && r5.chip.includes('buy milk'), 'calendar places the dated result on its day');
  ok(r5 && /July 2026/.test(r5.text), 'calendar shows the result month');

  // visual builder: open it, tick "is a to-do", insert, and confirm a working query block appears
  await p.evaluate(() => window.showQueryBuilder());
  await sleep(150);
  ok(await p.$('.qbuild') !== null, 'query builder modal opens');
  await p.evaluate(() => document.querySelector('.qb-todo').click());
  const preview = await p.evaluate(() => document.querySelector('.qb-preview').textContent);
  ok(/\{\{query: \{is:todo\}\}\}/.test(preview), `builder preview reflects the condition ("${preview}")`);
  await p.evaluate(() => document.querySelector('.qb-insert').click());
  await sleep(400);
  const inserted = await p.evaluate(() => [...document.querySelectorAll('.item')].some(it =>
    /\{\{query: \{is:todo\}\}\}/.test(it.querySelector('.content')?.textContent || '') && it.querySelector('.query-block .query-head')));
  ok(inserted, 'builder inserted a live query block that renders results');

  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll query tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
