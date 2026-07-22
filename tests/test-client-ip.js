/* Behind a reverse proxy the login audit log must record the real client IP from
   X-Forwarded-For (rightmost = what the trusted edge proxy saw), not the proxy/Docker socket IP. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const PORT = 3286, base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-ip-'));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const badLogin = (xff) => fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) },
  body: JSON.stringify({ username: 'ghost', password: 'nope' }),
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { } await sleep(200); }

  await badLogin('203.0.113.9');               // Caddy sets the real client IP
  await badLogin('6.6.6.6, 203.0.113.9');       // client spoofed 6.6.6.6, proxy appended the real one
  await badLogin(null);                          // direct connection, no XFF

  // admin reads the audit log
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'adminpw' }) });
  const ck = cookieFrom(login.headers.get('set-cookie'));
  const sec = await (await fetch(base + '/api/admin/security', { headers: { Cookie: ck } })).json();
  const ghostIPs = sec.events.filter(e => e.username === 'ghost').map(e => e.ip);

  ok(ghostIPs.includes('203.0.113.9'), `real forwarded IP recorded (${JSON.stringify(ghostIPs)})`);
  ok(!ghostIPs.includes('6.6.6.6'), 'spoofed left-most X-Forwarded-For entry is ignored');
  ok(ghostIPs.filter(ip => ip === '203.0.113.9').length >= 2, 'both proxied attempts recorded the rightmost (trusted) IP');
  ok(ghostIPs.some(ip => ip === '127.0.0.1' || ip === '::1'), 'direct connection falls back to the socket IP');
  ok(!ghostIPs.some(ip => (ip || '').startsWith('172.')), 'no Docker/proxy gateway IP leaks into the log');

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll client-ip tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
