// Regression: a node.text change that lands WITHOUT emitting an op (a debounced commit outside an
// undo txn — e.g. a save fired mid-word) must still reach the server. Before the fix the op path
// sent the pending insert op and cleared `dirty`, stranding the full text locally: you typed
// "Queries" in the browser but only "Q" synced.
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const puppeteer = require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-lu-')); const PORT = 3283; const base = `http://localhost:${PORT}`;
const srv = spawn('node', ['/home/phil/dev/rhizome/server.js'], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const gid = (await (await fetch(base + '/api/me', { headers: { Cookie: ck } })).json()).graphs[0].id;

  const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setCookie({ name: 'rz_session', value: ck.split('=')[1], domain: 'localhost', path: '/' });
  await p.goto(base + '/#/outline', { waitUntil: 'domcontentloaded' }); await sleep(1200);

  // Build the exact state: an insert op is queued AND a text change is committed with no open undo
  // txn (so no op carries it). This is what happens when a save fires mid-word: commitUndoTxn closes
  // the burst txn, then a later commit lands outside a txn.
  const id = await p.evaluate(() => {
    const nid = opNewAt(state.zoom, 0);      // new bullet → insert op in pendingOps + an open txn
    commitUndoTxn();                         // close the txn (simulates a mid-edit save) → undoTxn = null
    const el = document.querySelector(`.item[data-id="${nid}"] .content`);
    el.focus();
    el.textContent = 'Queries';              // set text directly (no keystroke → no snapshot/txn)
    commitActiveText();                      // commit it → node.text = 'Queries' but no op emitted
    return nid;
  });
  await p.evaluate(() => doSave());
  await sleep(700);

  const saved = await (await fetch(`${base}/api/g/${gid}/doc`, { headers: { Cookie: ck } })).json();
  const text = saved.doc.nodes[id]?.text;
  ok(text === 'Queries', `full text synced to the server (got "${text}")`);
  ok(errs.length === 0, 'no JS errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await b.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll lost-update tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
