/* In-app self-update: GET /api/admin/version (running commit vs latest) + POST /api/admin/update
   (drops the flag file the host's systemd watcher acts on). Both admin-only. Points RHIZOME_REPO at
   a non-existent repo so the GitHub check fails fast and deterministically (no network dependency on
   the result); the meaningful integration is the auth gating, the version stamp, and the flag write. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const PORT = 3291, base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-up-'));
const COMMIT = 'deadbeefcafe1234';
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1',
    RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x',
    GIT_COMMIT: COMMIT, RHIZOME_REPO: 'ituri/does-not-exist-xyz-000', RHIZOME_BRANCH: 'main' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }

  // gating
  ok((await J('/api/admin/version')).status === 403, 'version: unauthenticated → 403');
  ok((await J('/api/admin/update', { method: 'POST' })).status === 403, 'update: unauthenticated → 403');
  await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'sekret1', invite: 'x' }) });
  const bobCk = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'sekret1' }) })).headers.get('set-cookie'));
  ok((await J('/api/admin/version', { headers: { Cookie: bobCk } })).status === 403, 'version: non-admin → 403');
  ok((await J('/api/admin/update', { method: 'POST', headers: { Cookie: bobCk } })).status === 403, 'update: non-admin → 403');

  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));

  // version check reports the baked-in commit; latest fails (bad repo) → error set, no false update
  const v = (await J('/api/admin/version', { headers: { Cookie: ck } })).body;
  ok(v.current === COMMIT, 'version: reports the running commit from GIT_COMMIT');
  ok(v.repo === 'ituri/does-not-exist-xyz-000' && v.branch === 'main', 'version: echoes repo/branch');
  ok(typeof v.updateAvailable === 'boolean' && v.updateAvailable === false, 'version: no update when latest is unknown');
  ok(!!v.error, 'version: surfaces the check error');

  // update writes the flag file the host watcher acts on
  const flag = path.join(DATA, '.update-request');
  fs.rmSync(flag, { force: true });
  const up = await J('/api/admin/update', { method: 'POST', headers: { Cookie: ck } });
  ok(up.status === 202 && up.body && up.body.ok === true, 'update: admin → 202 ok');
  ok(fs.existsSync(flag), 'update: dropped the flag file in DATA_DIR');
  let flagJson = {}; try { flagJson = JSON.parse(fs.readFileSync(flag, 'utf8')); } catch {}
  ok(flagJson.by === 'phil' && typeof flagJson.at === 'number', 'update: flag records who/when');

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll self-update tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
