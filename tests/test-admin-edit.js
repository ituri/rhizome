/* Admin user editing: PATCH /api/admin/users/:id changes username, email and password,
   with validation (format, uniqueness, length) and admin-only access. Self-contained. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3272;
const base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-adm-'));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b, setCookie: r.headers.get('set-cookie') }; };

const login = async (username, password) => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return { status: r.status, cookie: cookieFrom(r.headers.get('set-cookie')) };
};
const register = async name => {
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'sekret1', invite: 'letmein' }) });
  return { cookie: cookieFrom(r.headers.get('set-cookie')) };
};

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'letmein' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }

  const admin = await login('phil', 'adminpw');
  assert(admin.status === 200 && admin.cookie, 'admin logs in');
  const AH = { Cookie: admin.cookie, 'Content-Type': 'application/json' };

  await register('bob');
  const users = (await J('/api/admin/users', { headers: AH })).body.users;
  const bob = users.find(u => u.username === 'bob');
  assert(bob && bob.email === null, 'new user starts with no email');

  const patch = (id, body, headers = AH) => J('/api/admin/users/' + id, { method: 'PATCH', headers, body: JSON.stringify(body) });

  // change all three at once
  let r = await patch(bob.id, { username: 'bobby', email: 'bob@example.org', password: 'newpass1' });
  assert(r.status === 200, 'PATCH all three fields → 200');
  assert(r.body.user.username === 'bobby' && r.body.user.email === 'bob@example.org', 'response reflects new name + email');

  // the changes stuck: list shows them, old password fails, new one works under the new name
  const after = (await J('/api/admin/users', { headers: AH })).body.users.find(u => u.id === bob.id);
  assert(after.username === 'bobby' && after.email === 'bob@example.org', 'list shows updated name + email');
  assert((await login('bob', 'sekret1')).status === 401, 'old username/password no longer works');
  assert((await login('bobby', 'newpass1')).status === 200, 'new username + password works');

  // clearing the email
  r = await patch(bob.id, { email: '' });
  assert(r.status === 200 && r.body.user.email === null, 'empty email clears it');

  // validation
  assert((await patch(bob.id, { username: 'x' })).status === 400, 'too-short username rejected');
  assert((await patch(bob.id, { email: 'not-an-email' })).status === 400, 'bad email rejected');
  assert((await patch(bob.id, { password: 'short' })).status === 400, 'short password rejected');
  assert((await patch(bob.id, { username: 'phil' })).status === 409, 'username taken by another user rejected');

  // renaming to your own current name is fine (no false "taken" clash)
  assert((await patch(bob.id, { username: 'bobby' })).status === 200, 'renaming to own current name is allowed');

  // 404 + admin-only
  assert((await patch('nosuchid', { email: 'a@b.co' })).status === 404, 'unknown user → 404');
  const nonAdmin = (await register('carol')).cookie;
  assert((await patch(bob.id, { email: 'a@b.co' }, { Cookie: nonAdmin, 'Content-Type': 'application/json' })).status === 403, 'non-admin forbidden');

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURES` : '\nAll admin-edit tests passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
