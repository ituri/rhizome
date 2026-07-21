/* GET /api/v1/journal/today: find-or-create today's journal day node (write scope), returns it
   with its children — used by the Firefox clipper to nest a link under a bullet in today. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3283;
const base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-jt-'));
let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) });
  const ck = cookieFrom(login.headers.get('set-cookie'));
  const AH = { Cookie: ck, 'Content-Type': 'application/json' };
  const gid = (await J('/api/me', { headers: AH })).body.graphs[0].id;
  const mkKey = async scope => (await J('/api/keys', { method: 'POST', headers: AH, body: JSON.stringify({ name: scope, graphId: gid, scope }) })).body.key;
  const write = await mkKey('write');
  const read = await mkKey('read');
  const H = k => ({ Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' });

  // write key: ensures + returns today's day node with a children array
  const r1 = await J('/api/v1/journal/today', { headers: H(write) });
  ok(r1.status === 200 && r1.body.id, 'write key gets today’s day node');
  ok(Array.isArray(r1.body.children), 'response carries the day’s children');
  const iso = new Date().toISOString().slice(0, 10);
  ok(new RegExp(', ' + iso.slice(0, 4) + '$').test(r1.body.plain || ''), `day label looks like a Roam date ("${r1.body.plain}")`);

  // idempotent: a second call returns the same node, doesn’t duplicate the day
  const r2 = await J('/api/v1/journal/today', { headers: H(write) });
  ok(r2.body.id === r1.body.id, 'second call returns the same day node');

  // a link nested under a bullet under today survives (the clipper’s write path)
  const bullet = (await J('/api/v1/nodes', { method: 'POST', headers: H(write), body: JSON.stringify({ parent: r1.body.id, text: 'Read' }) })).body;
  const child = (await J('/api/v1/nodes', { method: 'POST', headers: H(write), body: JSON.stringify({ parent: bullet.id, text: '<a href="https://x.example/a">A</a>', index: 0 }) })).body;
  ok(child.plain === 'A' && /href="https:\/\/x\.example\/a"/.test(child.text), 'link nested under the bullet is stored intact');
  const tree = (await J(`/api/v1/nodes/${r1.body.id}?tree=1`, { headers: H(write) })).body;
  ok(tree.children.some(c => c.plain === 'Read'), 'the bullet is a child of today');

  // read key must not create the day node
  ok((await J('/api/v1/journal/today', { headers: H(read) })).status === 403, 'read-scoped key is forbidden');

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll journal-today tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
