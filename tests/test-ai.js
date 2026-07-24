/* POST /api/ai: backend-agnostic Ask AI proxy — Anthropic (/v1/messages) and any
 * OpenAI-compatible (/v1/chat/completions, e.g. a local Ollama) endpoint, plus the
 * "not configured" guard. Uses a mock upstream so no real model is called. */
const { spawn } = require('child_process');
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path');
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

// mock upstream: records the last request, answers in the shape the requested API expects
let last = null;
const upstream = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    last = { path: req.url, auth: req.headers.authorization || null, xkey: req.headers['x-api-key'] || null, body: JSON.parse(b || '{}') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.includes('/messages')
      ? JSON.stringify({ content: [{ type: 'text', text: 'root\n  child' }] })
      : JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'root\n  child' } }] }));
  });
});

function startServer(port, env) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-ai-'));
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(port), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'pw', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return { srv, DATA };
}
async function login(base) {
  return cookieFrom((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'phil', password: 'pw' }) })).headers.get('set-cookie'));
}
async function waitUp(base) { for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/auth')).ok) return; } catch {} await sleep(150); } }
async function ai(base, ck) {
  const r = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ prompt: 'expand', context: '- seed' }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  await new Promise(r => upstream.listen(11599, r));
  const upURL = 'http://127.0.0.1:11599';

  // 1) not configured → the endpoint refuses
  {
    const { srv, DATA } = startServer(3811, {}); const base = 'http://localhost:3811';
    await waitUp(base); const ck = await login(base);
    ok((await ai(base, ck)).status === 400, 'without a backend → 400 not configured');
    ok(JSON.parse((await (await fetch(base + '/api/auth')).text())).ai === false, '/api/auth reports ai:false');
    srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  }

  // 2) OpenAI-compatible backend (e.g. Ollama): base URL alone enables it, bearer only when keyed
  {
    last = null;
    const { srv, DATA } = startServer(3812, { RHIZOME_AI_BASE_URL: upURL, RHIZOME_AI_KEY: 'sk-test', RHIZOME_AI_MODEL: 'qwen2.5:3b' }); const base = 'http://localhost:3812';
    await waitUp(base); const ck = await login(base);
    const r = await ai(base, ck);
    ok(r.status === 200 && r.body.text.includes('child'), 'openai backend returns the model text');
    ok(last.path === '/v1/chat/completions', 'openai → /v1/chat/completions');
    ok(last.auth === 'Bearer sk-test', 'openai sends Bearer auth when a key is set');
    ok(last.body.messages.map(m => m.role).join('+') === 'system+user' && last.body.stream === false, 'openai body: system+user, stream:false');
    ok(JSON.parse((await (await fetch(base + '/api/auth')).text())).ai === true, '/api/auth reports ai:true');
    srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  }

  // 3) OpenAI backend without a key (local Ollama) → still enabled, no auth header
  {
    last = null;
    const { srv, DATA } = startServer(3813, { RHIZOME_AI_BASE_URL: upURL, RHIZOME_AI_MODEL: 'llama3.2' }); const base = 'http://localhost:3813';
    await waitUp(base); const ck = await login(base);
    ok((await ai(base, ck)).status === 200, 'keyless local backend works');
    ok(last.auth === null, 'no Authorization header when keyless');
    srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  }

  // 4) Anthropic backend: /v1/messages with x-api-key, single user turn
  {
    last = null;
    const { srv, DATA } = startServer(3814, { RHIZOME_AI_BASE_URL: upURL, RHIZOME_AI_API: 'anthropic', RHIZOME_AI_KEY: 'ak-test', RHIZOME_AI_MODEL: 'claude-x' }); const base = 'http://localhost:3814';
    await waitUp(base); const ck = await login(base);
    const r = await ai(base, ck);
    ok(r.status === 200 && r.body.text.includes('child'), 'anthropic backend returns the model text');
    ok(last.path === '/v1/messages' && last.xkey === 'ak-test' && last.auth === null, 'anthropic → /v1/messages with x-api-key');
    ok(last.body.messages.map(m => m.role).join('+') === 'user' && typeof last.body.system === 'string', 'anthropic body: single user turn + system field');
    srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  }

  upstream.close();
  console.log(fail ? `\n${fail} FAILURES` : '\nAll AI-backend tests passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
