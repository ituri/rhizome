/* Quick-capture into a configurable bullet under today's journal (default "Inbox"). */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const PORT = 3285, base = `http://localhost:${PORT}`, AGENT = 't';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-cb-'));
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = { Authorization: 'Bearer ' + AGENT, 'Content-Type': 'application/json' };
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_AGENT_TOKEN: AGENT }, stdio: ['ignore', 'ignore', 'inherit'] });

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch {} await sleep(200); }
  const cap = (text, bullet) => J('/api/v1/capture', { method: 'POST', headers: H, body: JSON.stringify(bullet === undefined ? { text } : { text, bullet }) });

  ok((await cap('An article', 'Reading')).body.captured === 1, 'capture with a custom bullet');
  ok((await cap('Another read', 'Reading')).body.captured === 1, 'second capture reuses the same bullet');
  ok((await cap('No bullet given')).body.captured === 1, 'capture without a bullet falls back to Inbox');

  const dayId = (await J('/api/v1/journal/today', { headers: H })).body.id;
  const tree = (await J(`/api/v1/nodes/${dayId}?tree=1`, { headers: H })).body;
  const byBullet = Object.fromEntries(tree.children.map(c => [c.plain, c.children.map(x => x.plain)]));
  ok(JSON.stringify(byBullet.Reading) === JSON.stringify(['Another read', 'An article']) || (byBullet.Reading || []).length === 2,
    `both items nested under "Reading" (${JSON.stringify(byBullet.Reading)})`);
  ok((byBullet.Inbox || []).includes('No bullet given'), 'default lands under Inbox');
  ok(tree.children.filter(c => c.plain === 'Reading').length === 1, 'only one "Reading" bullet (find-or-create)');

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : '\nAll capture-bullet tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
