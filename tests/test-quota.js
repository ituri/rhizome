/* Usage stats + storage quota (global default, per-user override, soft tolerance, upload block).
   Self-contained — boots its own server on a temp DATA_DIR. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3231;
const base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-quota-'));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b, setCookie: r.headers.get('set-cookie') }; };
const post = (p, obj, cookie) => J(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(obj) });
const put = (p, obj, cookie) => J(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(obj) });

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'letmein' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const login = async (u, p) => cookieFrom((await post('/api/login', { username: u, password: p })).setCookie);
  const admin = await login('phil', 'adminpw');
  // a normal user
  const reg = await post('/api/register', { username: 'nora', password: 'sekret1', invite: 'letmein' });
  const nora = cookieFrom(reg.setCookie);
  const me = (await J('/api/me', { headers: { Cookie: nora } })).body;
  const gid = me.graphs[0].id;

  /* ---- stats reflect content ---- */
  const doc = { root: 'root', nodes: { root: { id: 'root', text: '', children: ['p1', 'p2'] },
    p1: { id: 'p1', text: 'Page One', note: 'a note', children: [] },
    p2: { id: 'p2', text: 'Page Two', children: [] } } };
  await J(`/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nora }, body: JSON.stringify({ doc }) });
  let s = (await J('/api/me/stats', { headers: { Cookie: nora } })).body;
  assert(s.pages === 2, `stats: 2 top-level pages (got ${s.pages})`);
  assert(s.noteBytes === Buffer.byteLength('Page One') + Buffer.byteLength('a note') + Buffer.byteLength('Page Two'), `noteBytes counts text + notes (${s.noteBytes})`);
  assert(s.fileBytes === 0 && s.totalBytes === s.noteBytes, 'no files yet → fileBytes 0');
  assert(s.quotaBytes === 0, 'no quota set → quotaBytes 0 (unlimited)');

  /* ---- upload counts toward fileBytes ---- */
  const up = await fetch(`${base}/api/upload?name=pic.bin`, { method: 'POST', headers: { Cookie: nora }, body: Buffer.alloc(5000, 1) });
  const { url: fileUrl } = await up.json();
  doc.nodes.p1.files = [{ url: fileUrl, name: 'pic.bin' }];
  await J(`/api/g/${gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: nora }, body: JSON.stringify({ doc }) });
  s = (await J('/api/me/stats', { headers: { Cookie: nora } })).body;
  assert(s.fileBytes >= 5000, `fileBytes reflects the upload (${s.fileBytes})`);

  /* ---- admin sets a global quota + tolerance ---- */
  let r = await put('/api/admin/quota', { bytes: 10000, tolerancePct: 20 }, admin);
  assert(r.status === 200 && r.body.bytes === 10000 && r.body.tolerancePct === 20, 'admin sets global quota + tolerance');
  r = await put('/api/admin/quota', { bytes: 10000, tolerancePct: 20 }, nora);
  assert(r.status === 403, 'a non-admin cannot set the quota (403)');
  s = (await J('/api/me/stats', { headers: { Cookie: nora } })).body;
  assert(s.quotaBytes === 10000 && s.tolerancePct === 20, 'user stats now report the effective quota');

  /* ---- soft tolerance: upload allowed between quota and hard cap, blocked past it ---- */
  // used so far ~ noteBytes + 5000. quota 10000, hardCap 12000. A 4000-byte upload should push
  // us over 10000 (soft, allowed); a huge one past 12000 must be blocked.
  const soft = await fetch(`${base}/api/upload?name=soft.bin`, { method: 'POST', headers: { Cookie: nora }, body: Buffer.alloc(4000, 1) });
  assert(soft.status === 200, 'upload within the soft-tolerance band is allowed');
  const hard = await fetch(`${base}/api/upload?name=big.bin`, { method: 'POST', headers: { Cookie: nora }, body: Buffer.alloc(50000, 1) });
  assert(hard.status === 413, 'upload past quota+tolerance is blocked (413)');

  /* ---- per-user override raises the cap ---- */
  r = await put(`/api/admin/users/${me.user.id}/quota`, { bytes: 10_000_000 }, admin);
  assert(r.status === 200 && r.body.bytes === 10_000_000 && r.body.source === 'user', 'admin sets a per-user override');
  const after = await fetch(`${base}/api/upload?name=big2.bin`, { method: 'POST', headers: { Cookie: nora }, body: Buffer.alloc(50000, 1) });
  assert(after.status === 200, 'the same big upload now succeeds under the per-user override');
  s = (await J('/api/me/stats', { headers: { Cookie: nora } })).body;
  assert(s.quotaBytes === 10_000_000, 'stats reflect the per-user override');

  /* ---- admin users list carries usage + quota ---- */
  const users = (await J('/api/admin/users', { headers: { Cookie: admin } })).body.users;
  const nu = users.find(x => x.username === 'nora');
  assert(nu && nu.used > 0 && nu.quotaBytes === 10_000_000 && nu.quotaSource === 'user', 'admin users list shows per-user usage + quota');

  console.log(failures ? `\n${failures} FAILED` : '\nAll quota tests passed');
  srv.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
