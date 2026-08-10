/* Two devices creating the same journal day at the same moment must end up with ONE day.
   Each client only checks its own copy of the doc before creating today, so a web PUT and an
   iOS insert op seconds apart both produce a "August 9th, 2026" node (that is exactly how the
   duplicate on 2026-08-09 happened). The server is the single sequencer and heals it:
   same calendar slot → oldest node wins, the duplicate's bullets move over. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3287;
const base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-daydup-'));
let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

let srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const ISO = '2026-08-09';
const stamp = (ms, c, dev) => `${String(ms).padStart(13, '0')}:${String(c).padStart(5, '0')}:${dev}`;

(async () => {
  const boot = async () => { for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) return; } catch { } await sleep(200); } };
  await boot();
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) });
  const AH = { Cookie: cookieFrom(login.headers.get('set-cookie')), 'Content-Type': 'application/json' };
  const J = async (p, opts = {}) => { const r = await fetch(base + p, { ...opts, headers: { ...AH, ...(opts.headers || {}) } }); let b = null; try { b = await r.json(); } catch { } return { status: r.status, body: b }; };
  const gid = (await J('/api/me')).body.graphs[0].id;
  const G = '/api/g/' + gid;
  const getDoc = async () => (await J(G + '/doc')).body.doc;
  const daysWithCd = doc => Object.values(doc.nodes).filter(n => n.cal === 'day' && n.cd === ISO);
  const plainOf = doc => id => (doc.nodes[id].text || '').replace(/<[^>]*>/g, '');

  /* ---- 1. the real race: iOS emits insert ops, the web PUTs its whole doc ---- */

  // web (10:32:04.893): builds its own calendar chain and pushes the whole document
  const now = Date.now();
  const node = (id, text, extra = {}) => ({ id, text, note: null, done: false, collapsed: false, children: [], c: now, m: now, ...extra });
  const webDoc = {
    root: 'root', meta: {},
    nodes: {
      root: node('root', '', { children: ['webCal'] }),
      webCal: node('webCal', 'Calendar', { cal: 'root', children: ['webYear'] }),
      webYear: node('webYear', '2026', { cal: 'year', cy: 2026, children: ['webMonth'] }),
      webMonth: node('webMonth', 'August', { cal: 'month', cy: 2026, cm: 7, children: ['webDay'] }),
      webDay: node('webDay', 'August 9th, 2026', { cal: 'day', cd: ISO, children: ['webBullet'] }),
      webBullet: node('webBullet', 'written in the browser'),
    },
  };
  const r0 = await J(G + '/doc', { method: 'PUT', body: JSON.stringify({ doc: webDoc, device: 'web' }) });
  ok(r0.status === 200, 'web whole-doc PUT accepted');
  let doc = await getDoc();
  ok(daysWithCd(doc).length === 1, 'after the web PUT there is exactly one August 9th');

  // iOS (10:32:05, hadn't seen the web day): its own calendar chain + day + bullet, as insert ops
  const iosOps = [
    { kind: 'insert', node: 'iosCal', hlc: stamp(1786264324089, 1, 'o0hc5mdh'), parent: doc.root, ord: 1, data: { text: 'Calendar', cal: 'root' } },
    { kind: 'insert', node: 'iosYear', hlc: stamp(1786264324089, 2, 'o0hc5mdh'), parent: 'iosCal', ord: 0, data: { text: '2026', cal: 'year', cy: 2026 } },
    { kind: 'insert', node: 'iosMonth', hlc: stamp(1786264324089, 3, 'o0hc5mdh'), parent: 'iosYear', ord: 0, data: { text: 'August', cal: 'month', cy: 2026, cm: 7 } },
    { kind: 'insert', node: 'iosDay', hlc: stamp(1786264324089, 4, 'o0hc5mdh'), parent: 'iosMonth', ord: 0, data: { text: 'August 9th, 2026', cal: 'day', cd: ISO } },
    { kind: 'insert', node: 'iosBullet', hlc: stamp(1786264324089, 5, 'o0hc5mdh'), parent: 'iosDay', ord: 0, data: { text: 'written on the phone' } },
  ];
  const r1 = await J(G + '/ops', { method: 'POST', body: JSON.stringify({ ops: iosOps, device: 'ios' }) });
  ok(r1.status === 200, 'iOS ops accepted');
  doc = await getDoc();
  const days = daysWithCd(doc);
  ok(days.length === 1, `the concurrent creates collapse into one day (found ${days.length})`);
  ok(days[0].id === 'webDay', 'the older (web) day node is the survivor');
  const kids = (days[0].children || []).map(plainOf(doc));
  ok(kids.includes('written in the browser') && kids.includes('written on the phone'),
    `both devices' bullets live under it (${JSON.stringify(kids)})`);
  ok(Object.values(doc.nodes).filter(n => n.cal === 'month' && n.cm === 7).length === 1, 'only one August month node');
  ok(Object.values(doc.nodes).filter(n => n.cal === 'year' && n.cy === 2026).length === 1, 'only one 2026 year node');
  ok(Object.values(doc.nodes).filter(n => n.cal === 'root').length === 1, 'only one calendar root');
  ok(!doc.nodes.iosDay && !doc.nodes.iosMonth, 'the duplicate scaffold nodes are gone');

  /* ---- 2. a stray duplicate that predates the fix is healed when the graph loads ---- */

  doc = await getDoc();
  const dayId = daysWithCd(doc)[0].id;
  const monthId = Object.values(doc.nodes).find(n => (n.children || []).includes(dayId)).id;
  doc.nodes.oldDup = { id: 'oldDup', text: 'August 9th, 2026', note: null, done: false, collapsed: false, children: ['oldKid'], cal: 'day', cd: ISO, c: 1, m: 1 };
  doc.nodes.oldKid = { id: 'oldKid', text: 'from the legacy duplicate', note: null, done: false, collapsed: false, children: [] };
  doc.nodes[monthId].children.push('oldDup');
  // write it straight into the store, bypassing the healing write paths, so the graph on disk
  // looks like Phil's did before this fix
  const { Store } = require(path.join(__dirname, '..', 'db.js'));
  await J(G + '/doc', { method: 'PUT', body: JSON.stringify({ doc: { root: doc.root, nodes: { root: doc.nodes.root } }, device: 'reset' }) });
  srv.kill(); await sleep(600);
  const db = new Store(path.join(DATA, 'graphs', gid, 'outline.db'));
  db.sync(doc, 999);
  db.close?.();

  srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await boot();
  const login2 = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) });
  AH.Cookie = cookieFrom(login2.headers.get('set-cookie'));
  doc = await getDoc();
  const healed = daysWithCd(doc);
  ok(healed.length === 1, `an existing duplicate is merged on graph load (found ${healed.length})`);
  const healedKids = (healed[0].children || []).map(plainOf(doc));
  ok(healedKids.includes('from the legacy duplicate'), 'the old duplicate’s bullets moved to the survivor');
  ok(!healedKids.some(t => !t.trim()), 'the spare empty starter bullets are gone');

  srv.kill();
  console.log(fail ? `\n${fail} DAY-DUP TESTS FAILING` : '\nDAY-DUP TESTS PASSED');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { srv.kill(); } catch { } process.exit(1); });
