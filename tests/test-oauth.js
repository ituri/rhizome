/* OAuth 2.1 for MCP (oauth.js): the flow claude.ai custom connectors run. Pure Node:
   discovery → dynamic client registration → authorize (consent via the normal session) →
   decision → token with PKCE → the access token is a working rzk_ key against /mcp.
   Negatives: wrong PKCE verifier, code reuse, foreign graph. */
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3231;
const base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-oauth-'));
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'x' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/me'); if (r.status) break; } catch { /* boot */ } await sleep(200); }

  /* ---- discovery ---- */
  const prm = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
  ok(prm.resource === base + '/mcp' && prm.authorization_servers?.[0] === base, `protected-resource metadata (${prm.resource})`);
  const asm = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  ok(asm.authorization_endpoint === base + '/oauth/authorize' && asm.registration_endpoint === base + '/oauth/register'
    && asm.code_challenge_methods_supported?.includes('S256'), 'authorization-server metadata advertises the endpoints + PKCE');
  const www = (await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).headers.get('www-authenticate') || '';
  ok(/resource_metadata=/.test(www), `401 advertises the resource metadata (${www})`);

  /* ---- dynamic client registration ---- */
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  let r = await fetch(base + '/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }),
  });
  const client = await r.json();
  ok(r.status === 201 && /^rzc_/.test(client.client_id || ''), `DCR returns a client_id (${client.client_id})`);
  r = await fetch(base + '/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['http://evil.example/cb'] }),
  });
  ok(r.status === 400, 'non-https redirect_uri is rejected');

  /* ---- authorize: consent page ---- */
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const authUrl = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}`
    + `&redirect_uri=${encodeURIComponent(redirect)}&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;
  r = await fetch(authUrl, { redirect: 'follow' });
  const html = await r.text();
  // the page shows the name client-side from the query — the server redirect injects it there
  ok(r.status === 200 && /Authorize access/.test(html) && /client_name=Claude/.test(r.url),
    `consent page renders, redirect carries the client name (${r.url.split('?')[0]})`);
  r = await fetch(`${base}/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(redirect)}`);
  ok(r.status === 400, 'unknown client_id is rejected at /authorize');

  /* ---- login + decision ---- */
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'phil', password: 'adminpw' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json();
  const gid = me.graphs[0].id;
  const decide = body => fetch(base + '/oauth/decision', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ client_id: client.client_id, redirect_uri: redirect, state: 'xyz', code_challenge: challenge, ...body }),
  });
  r = await fetch(base + '/oauth/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(r.status === 401, 'decision without a session is rejected');
  r = await decide({ graph_id: 'not-my-graph', scope: 'write', approve: true });
  ok(r.status === 403, 'a foreign graph_id is rejected');
  r = await decide({ graph_id: gid, scope: 'write', approve: false });
  let j = await r.json();
  ok(/error=access_denied/.test(j.redirect || '') && /state=xyz/.test(j.redirect), 'deny redirects with access_denied + state');
  r = await decide({ graph_id: gid, scope: 'write', approve: true });
  j = await r.json();
  const code = new URL(j.redirect).searchParams.get('code');
  ok(!!code && /state=xyz/.test(j.redirect), 'approve redirects with a code + state');

  /* ---- token (form-encoded, like real clients) ---- */
  const tok = (params) => fetch(base + '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  r = await tok({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: 'wrong' });
  ok(r.status === 400, 'a wrong PKCE verifier is rejected');
  // the code is single-use even after a failed attempt → get a fresh one
  r = await decide({ graph_id: gid, scope: 'write', approve: true });
  const code2 = new URL((await r.json()).redirect).searchParams.get('code');
  r = await tok({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier });
  const t = await r.json();
  ok(r.status === 200 && /^rzk_/.test(t.access_token || '') && t.token_type === 'Bearer', `token exchange yields an rzk_ key (scope ${t.scope})`);
  r = await tok({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier });
  ok(r.status === 400, 'a code cannot be redeemed twice');

  /* ---- the access token works against /mcp ---- */
  r = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.access_token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
  });
  const tools = (await r.json()).result?.tools?.length || 0;
  ok(r.status === 200 && tools >= 8, `the OAuth token drives the MCP endpoint (${tools} tools)`);
  // and it shows up as a revocable API key
  const keys = await (await fetch(base + '/api/keys', { headers: { Cookie: cookie } })).json().catch(() => null);
  if (Array.isArray(keys)) ok(keys.some(k => /OAuth/.test(k.name)), 'the token is listed as a revocable API key');

  console.log(failures ? `\n${failures} OAUTH TESTS FAILING` : '\nOAUTH TESTS PASSED');
  srv.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
