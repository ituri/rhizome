/* Security hardening: per-graph file access, Secure cookie over TLS, API rate limiting.
   Self-contained — boots its own server on a temp DATA_DIR. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3229;
const base = `http://localhost:${PORT}`;
const AGENT = 'sec-agent-token';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-sec-'));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b, setCookie: r.headers.get('set-cookie') }; };
const register = async name => {
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'sekret1', invite: 'letmein' }) });
  const cookie = cookieFrom(r.headers.get('set-cookie'));
  const me = (await J('/api/me', { headers: { Cookie: cookie } })).body;
  return { cookie, gid: me.graphs[0].id };
};

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_AGENT_TOKEN: AGENT, RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'letmein' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }

  /* ---- Secure cookie only over (forwarded) TLS ---- */
  let r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) });
  assert(/;\s*Secure/i.test(r.headers.get('set-cookie') || ''), 'login over X-Forwarded-Proto: https sets a Secure cookie');
  r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) });
  assert(!/;\s*Secure/i.test(r.headers.get('set-cookie') || ''), 'plain-http login omits Secure (so http dev still works)');

  /* ---- per-graph file access ---- */
  const alice = await register('alice');
  const bob = await register('bob');
  // alice uploads a file and references it from a node in her graph
  const up = await fetch(`${base}/api/upload?name=secret.txt`, { method: 'POST', headers: { Cookie: alice.cookie }, body: Buffer.from('alice private bytes') });
  const { url: fileUrl } = await up.json();
  assert(/^\/files\/[0-9a-f]{24}-/.test(fileUrl), `stored name has a 96-bit random prefix (${fileUrl})`);
  const doc = { root: 'root', nodes: { root: { id: 'root', text: '', children: ['n1'] }, n1: { id: 'n1', text: 'has a file', children: [], files: [{ url: fileUrl, name: 'secret.txt' }] } } };
  r = await J(`/api/g/${alice.gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie }, body: JSON.stringify({ doc }) });
  assert(r.status === 200, 'alice references the file from her graph');

  const getFile = cookie => fetch(base + fileUrl, cookie ? { headers: { Cookie: cookie } } : {}).then(x => x.status);
  assert(await getFile(alice.cookie) === 200, 'alice (member of the referencing graph) can read the file');
  assert(await getFile(bob.cookie) === 401, 'bob (logged in, but not a member) is DENIED the file (401)');
  assert(await getFile(null) === 401, 'an unauthenticated request is denied the file (401)');

  /* ---- API rate limiting on token-authed endpoints ---- */
  let got429 = false;
  for (let i = 0; i < 320; i++) {
    const s = (await fetch(`${base}/api/v1/version`, { headers: { Authorization: 'Bearer ' + AGENT } })).status;
    if (s === 429) { got429 = true; break; }
  }
  assert(got429, '/api/v1 rate-limits a token client past the window cap (429)');
  // a normal session request is NOT subject to the token limiter
  r = await J('/api/me', { headers: { Cookie: alice.cookie } });
  assert(r.status === 200, 'session-authed requests are unaffected by the token rate limiter');

  console.log(failures ? `\n${failures} FAILED` : '\nAll security tests passed');
  srv.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
