/* OAuth 2.1 for the MCP endpoint — the flow claude.ai custom connectors insist on.
   Implements just enough of the MCP authorization spec, zero-dependency:

     GET  /.well-known/oauth-protected-resource      RFC 9728 resource metadata
     GET  /.well-known/oauth-authorization-server    RFC 8414 server metadata
     POST /oauth/register                            RFC 7591 dynamic client registration
     GET  /oauth/authorize                           consent page (login via the normal session)
     POST /oauth/decision                            approve/deny → authorization code
     POST /oauth/token                               code + PKCE(S256) → a real rzk_ API key

   The access token IS a per-graph rzk_ API key (Account → API keys), so it can be inspected
   and revoked like any other key, and /mcp needs no new auth path. Public clients only
   (token_endpoint_auth_method "none"), PKCE required, exact redirect_uri match, single-use
   codes with a 10-minute TTL. Registered clients persist in DATA_DIR/oauth-clients.json. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODE_TTL = 10 * 60e3;

function createOAuth({ accounts, dataDir }) {
  const clientsFile = path.join(dataDir, 'oauth-clients.json');
  let clients = {};
  try { clients = JSON.parse(fs.readFileSync(clientsFile, 'utf8')); } catch { /* first run */ }
  const saveClients = () => {
    try { fs.writeFileSync(clientsFile, JSON.stringify(clients, null, 1)); }
    catch (e) { console.error('oauth: persisting clients failed:', e); }
  };
  const codes = new Map();   // code → { clientId, redirectUri, codeChallenge, userId, graphId, scope, exp }

  const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const originOf = req => {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host || 'localhost'}`;
  };
  const okRedirect = u => {
    try { const p = new URL(u); return p.protocol === 'https:' || p.hostname === 'localhost' || p.hostname === '127.0.0.1'; }
    catch { return false; }
  };

  // token/register bodies arrive as form-urlencoded (per spec) or JSON
  async function readAnyBody(req) {
    const chunks = [];
    for await (const c of req) { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024) throw new Error('too large'); }
    const raw = Buffer.concat(chunks).toString('utf8');
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
    try { return JSON.parse(raw || '{}'); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
  }

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  /* Consent page: logs in through the normal /api/login (incl. the optional TOTP field) and
     lists the user's graphs from /api/me — all same-origin with the session cookie. */
  const consentHtml = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize — Rhizome</title>
<style>
  body { font-family: Inter, system-ui, sans-serif; background: #f7f6f2; color: #26221c; display: flex; justify-content: center; padding: 48px 16px; }
  .card { background: #fffefa; border: 1px solid #ddd8cd; border-radius: 12px; padding: 28px; max-width: 380px; width: 100%; box-shadow: 0 12px 36px -12px rgba(60,50,30,.22); }
  h1 { font-size: 19px; margin: 0 0 6px; } p { font-size: 14px; color: #5c554b; margin: 6px 0 16px; }
  label { display: block; font-size: 13px; color: #5c554b; margin: 10px 0 4px; }
  input, select { width: 100%; box-sizing: border-box; font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid #ddd8cd; border-radius: 8px; background: #fff; }
  .row { display: flex; gap: 10px; margin-top: 20px; }
  button { flex: 1; font: inherit; font-size: 14px; padding: 9px 0; border-radius: 8px; border: 1px solid #ddd8cd; background: #fff; cursor: pointer; }
  button.primary { background: #bf562f; border-color: #bf562f; color: #fff; font-weight: 600; }
  .err { color: #b3261e; font-size: 13px; margin-top: 10px; min-height: 1em; }
  .hidden { display: none; }
</style></head><body><div class="card">
  <h1>Authorize access</h1>
  <p id="who">An application asks to access your Rhizome graph.</p>
  <div id="login">
    <label>Username</label><input id="u" autocomplete="username">
    <label>Password</label><input id="p" type="password" autocomplete="current-password">
    <label id="totp-label" class="hidden">One-time code</label><input id="c" class="hidden" inputmode="numeric" autocomplete="one-time-code">
    <div class="row"><button class="primary" id="login-btn">Sign in</button></div>
  </div>
  <div id="grant" class="hidden">
    <label>Graph</label><select id="graph"></select>
    <label>Access</label><select id="scope"><option value="write">Read &amp; write</option><option value="read">Read only</option></select>
    <div class="row"><button id="deny">Deny</button><button class="primary" id="approve">Approve</button></div>
  </div>
  <div class="err" id="err"></div>
</div><script>
const q = Object.fromEntries(new URLSearchParams(location.search));
const el = id => document.getElementById(id);
const err = m => { el('err').textContent = m || ''; };
if (q.client_name) el('who').textContent = '\\u201C' + q.client_name + '\\u201D asks to access your Rhizome graph.';
async function refresh() {
  const me = await (await fetch('/api/me')).json();
  if (me.user) {
    el('login').classList.add('hidden');
    el('grant').classList.remove('hidden');
    el('graph').innerHTML = '';
    for (const g of me.graphs || []) {
      const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; el('graph').append(o);
    }
    if (!(me.graphs || []).length) err('This account has no graphs.');
  }
}
el('login-btn').addEventListener('click', async () => {
  err('');
  const body = { username: el('u').value, password: el('p').value };
  if (!el('c').classList.contains('hidden')) body.code = el('c').value;
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) return refresh();
  const e = (await r.json().catch(() => ({}))).error || 'sign-in failed';
  if (/code/i.test(e)) { el('totp-label').classList.remove('hidden'); el('c').classList.remove('hidden'); }
  err(e);
});
async function decide(approve) {
  err('');
  const r = await fetch('/oauth/decision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state,
      code_challenge: q.code_challenge, code_challenge_method: q.code_challenge_method,
      graph_id: el('graph').value, scope: el('scope').value, approve,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.redirect) location.href = j.redirect; else err(j.error || 'authorization failed');
}
el('approve').addEventListener('click', () => decide(true));
el('deny').addEventListener('click', () => decide(false));
refresh();
</script></body></html>`;

  /* Returns true when the request was handled. `helpers` = { send, currentUser, rateLimited }. */
  async function handle(req, res, url, helpers) {
    const { send, currentUser, rateLimited } = helpers;
    const pathOnly = url.split('?')[0];
    const origin = originOf(req);

    if (pathOnly.startsWith('/.well-known/oauth-protected-resource')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
      send(res, 200, {
        resource: origin + '/mcp',
        authorization_servers: [origin],
        scopes_supported: ['read', 'write'],
        bearer_methods_supported: ['header'],
      }, CORS);
      return true;
    }
    if (pathOnly.startsWith('/.well-known/oauth-authorization-server')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
      send(res, 200, {
        issuer: origin,
        authorization_endpoint: origin + '/oauth/authorize',
        token_endpoint: origin + '/oauth/token',
        registration_endpoint: origin + '/oauth/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['read', 'write'],
      }, CORS);
      return true;
    }

    if (pathOnly === '/oauth/register') {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
      if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }, CORS); return true; }
      if (rateLimited('oauth:' + (req.socket.remoteAddress || ''))) { send(res, 429, { error: 'rate limited' }, CORS); return true; }
      let body;
      try { body = await readAnyBody(req); } catch { send(res, 400, { error: 'invalid_client_metadata' }, CORS); return true; }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.slice(0, 10) : [];
      if (!uris.length || !uris.every(okRedirect)) {
        send(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or localhost)' }, CORS);
        return true;
      }
      const clientId = 'rzc_' + crypto.randomBytes(16).toString('hex');
      clients[clientId] = { client_name: String(body.client_name || 'MCP client').slice(0, 100), redirect_uris: uris, created: Date.now() };
      saveClients();
      send(res, 201, {
        client_id: clientId,
        client_name: clients[clientId].client_name,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }, CORS);
      return true;
    }

    if (pathOnly === '/oauth/authorize') {
      if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
      const p = new URL(url, origin).searchParams;
      const client = clients[p.get('client_id') || ''];
      const uri = p.get('redirect_uri') || '';
      if (!client || !client.redirect_uris.includes(uri)) { send(res, 400, { error: 'unknown client_id or redirect_uri' }); return true; }
      if (p.get('response_type') !== 'code' || !p.get('code_challenge') || p.get('code_challenge_method') !== 'S256') {
        send(res, 400, { error: 'response_type=code with PKCE S256 required' });
        return true;
      }
      // hand the (validated) client_name to the page for display
      const withName = new URL(url, origin);
      if (!withName.searchParams.get('client_name')) withName.searchParams.set('client_name', client.client_name);
      if (withName.toString() !== new URL(url, origin).toString()) {
        res.writeHead(302, { Location: withName.pathname + withName.search }); res.end(); return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(consentHtml());
      return true;
    }

    if (pathOnly === '/oauth/decision') {
      if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      const user = currentUser(req);
      if (!user) { send(res, 401, { error: 'sign in first' }); return true; }
      let body;
      try { body = await readAnyBody(req); } catch { send(res, 400, { error: 'bad request' }); return true; }
      const client = clients[body.client_id || ''];
      const uri = String(body.redirect_uri || '');
      if (!client || !client.redirect_uris.includes(uri)) { send(res, 400, { error: 'unknown client_id or redirect_uri' }); return true; }
      const back = new URL(uri);
      if (body.state) back.searchParams.set('state', String(body.state));
      if (!body.approve) {
        back.searchParams.set('error', 'access_denied');
        send(res, 200, { redirect: back.toString() });
        return true;
      }
      const graphId = String(body.graph_id || '');
      if (!accounts.roleOf(user.id, graphId)) { send(res, 403, { error: 'no access to this graph' }); return true; }
      if (!body.code_challenge) { send(res, 400, { error: 'missing code_challenge' }); return true; }
      const scope = body.scope === 'read' ? 'read' : 'write';
      const code = b64url(crypto.randomBytes(32));
      codes.set(code, {
        clientId: body.client_id, redirectUri: uri, codeChallenge: String(body.code_challenge),
        userId: user.id, graphId, scope, exp: Date.now() + CODE_TTL,
      });
      back.searchParams.set('code', code);
      send(res, 200, { redirect: back.toString() });
      return true;
    }

    if (pathOnly === '/oauth/token') {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
      if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }, CORS); return true; }
      if (rateLimited('oauth:' + (req.socket.remoteAddress || ''))) { send(res, 429, { error: 'rate limited' }, CORS); return true; }
      let body;
      try { body = await readAnyBody(req); } catch { send(res, 400, { error: 'invalid_request' }, CORS); return true; }
      if (body.grant_type !== 'authorization_code') { send(res, 400, { error: 'unsupported_grant_type' }, CORS); return true; }
      const grant = codes.get(String(body.code || ''));
      codes.delete(String(body.code || ''));   // single use, even on failure
      for (const [k, v] of codes) if (v.exp < Date.now()) codes.delete(k);
      if (!grant || grant.exp < Date.now()) { send(res, 400, { error: 'invalid_grant' }, CORS); return true; }
      if (body.client_id && body.client_id !== grant.clientId) { send(res, 400, { error: 'invalid_grant' }, CORS); return true; }
      if (body.redirect_uri && body.redirect_uri !== grant.redirectUri) { send(res, 400, { error: 'invalid_grant' }, CORS); return true; }
      const verifier = String(body.code_verifier || '');
      if (!verifier || b64url(crypto.createHash('sha256').update(verifier).digest()) !== grant.codeChallenge) {
        send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }, CORS);
        return true;
      }
      const client = clients[grant.clientId];
      const name = `OAuth: ${client ? client.client_name : 'MCP client'}`;
      const { key } = accounts.createApiKey(grant.userId, grant.graphId, name, grant.scope);
      send(res, 200, { access_token: key, token_type: 'Bearer', scope: grant.scope }, CORS);
      return true;
    }

    return false;
  }

  return { handle };
}

module.exports = { createOAuth };
