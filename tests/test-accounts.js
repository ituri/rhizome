// Pure-node auth flow test. Run against a server started with:
//   RHIZOME_ADMIN_PASSWORD=adminpw RHIZOME_INVITE_CODE=letmein PORT=3215 DATA_DIR=<fresh>
const base = `http://localhost:${process.env.PORT || 3215}`;
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const J = async (path, opts = {}) => {
  const r = await fetch(base + path, opts);
  let body = null; try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body, setCookie: r.headers.get('set-cookie') };
};
const post = (path, obj, cookie) => J(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(obj),
});
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

(async () => {
  let r = await J('/api/me');
  assert(r.status === 200 && r.body.user === null && r.body.authRequired === true && r.body.inviteRequired === true,
    'me: logged out, auth + invite required');
  r = await J('/api/doc');
  assert(r.status === 401, 'doc rejected without a session');

  r = await post('/api/login', { username: 'phil', password: 'wrong' });
  assert(r.status === 401, 'wrong password rejected');
  r = await post('/api/login', { username: 'phil', password: 'adminpw' });
  assert(r.status === 200 && r.body.user.username === 'phil', 'admin login succeeds');
  const cookie = cookieFrom(r.setCookie);
  assert(/rz_session=\w/.test(cookie), 'login sets a session cookie');

  r = await J('/api/me', { headers: { Cookie: cookie } });
  assert(r.body.user && r.body.user.username === 'phil', 'me returns the logged-in user');
  assert(r.body.user.isAdmin === true, 'the bootstrap admin is flagged as admin');
  assert(Array.isArray(r.body.graphs) && r.body.graphs.length === 1 && r.body.graphs[0].role === 'owner',
    'the admin owns exactly one graph');
  r = await J('/api/doc', { headers: { Cookie: cookie } });
  assert(r.status === 200, 'doc accessible with a session');

  // self-service password change
  r = await post('/api/account/password', { current: 'wrong', next: 'newpass' }, cookie);
  assert(r.status === 403, 'password change rejects a wrong current password');
  r = await post('/api/account/password', { current: 'adminpw', next: 'sk' }, cookie);
  assert(r.status === 400, 'password change rejects a too-short new password');
  r = await post('/api/account/password', { current: 'adminpw', next: 'newadminpw' }, cookie);
  assert(r.status === 200, 'password change succeeds with the right current password');
  r = await post('/api/login', { username: 'phil', password: 'adminpw' });
  assert(r.status === 401, 'the old password no longer works');
  r = await post('/api/login', { username: 'phil', password: 'newadminpw' });
  assert(r.status === 200, 'the new password works');

  r = await post('/api/register', { username: 'bob', password: 'sekret' });
  assert(r.status === 403, 'register without invite rejected');
  r = await post('/api/register', { username: 'bob', password: 'sk', invite: 'letmein' });
  assert(r.status === 400, 'short password rejected');
  r = await post('/api/register', { username: 'bob', password: 'sekret', invite: 'letmein' });
  assert(r.status === 200 && r.body.user.username === 'bob', 'valid registration creates an account');
  const bobCookie = cookieFrom(r.setCookie);
  r = await post('/api/register', { username: 'phil', password: 'sekret', invite: 'letmein' });
  assert(r.status === 409, 'duplicate username rejected');
  r = await J('/api/me', { headers: { Cookie: bobCookie } });
  assert(r.body.user && r.body.user.username === 'bob', 'registration logs the new user in');
  assert(!r.body.user.isAdmin, 'a self-registered user is not an admin');
  assert(r.body.graphs.length === 1 && r.body.graphs[0].name === 'Home', 'registration creates the user their own graph');

  r = await post('/api/logout', {}, cookie);
  assert(r.status === 200, 'logout ok');
  r = await J('/api/doc', { headers: { Cookie: cookie } });
  assert(r.status === 401, 'session invalid after logout');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nACCOUNTS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
