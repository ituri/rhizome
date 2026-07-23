/* GET /api/admin/status: admin-only server status (uptime, cpu, ram, disk, storage, health). */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const PORT = 3287, base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-st-'));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }

  ok((await J('/api/admin/status')).status === 403, 'unauthenticated → 403');

  // a non-admin user is forbidden
  await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'sekret1', invite: 'x' }) });
  const bobCk = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'sekret1' }) })).headers.get('set-cookie'));
  ok((await J('/api/admin/status', { headers: { Cookie: bobCk } })).status === 403, 'non-admin → 403');

  // admin gets the status
  const ck = cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) })).headers.get('set-cookie'));
  const s = (await J('/api/admin/status', { headers: { Cookie: ck } })).body;

  ok(typeof s.uptimeSec === 'number' && s.uptimeSec >= 0, 'reports uptime');
  ok(typeof s.lastUpdate === 'number', 'reports last-update time');
  ok(s.cpu && s.cpu.cores > 0 && typeof s.cpu.loadPct === 'number', 'reports CPU (cores + load)');
  ok(s.memory && s.memory.rss > 0 && s.memory.systemTotal > 0, 'reports memory (process + system)');
  ok(s.disk && s.disk.total > 0 && s.disk.free >= 0, 'reports disk usage');
  ok(s.storage && s.storage.dataBytes >= 0 && typeof s.storage.graphs === 'number', 'reports storage footprint');
  ok(Array.isArray(s.health) && s.health.some(h => h.name === 'Database (SQLite)' && h.ok), 'health includes a healthy database');
  ok(s.health.some(h => h.name === 'Data directory') && s.health.some(h => h.name === 'Disk space') && s.health.some(h => h.name === 'Ask AI'), 'health covers the dependencies');

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll server-status tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
