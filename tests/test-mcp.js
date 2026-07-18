/* MCP server (JSON-RPC over /mcp) — self-contained: boots its own server on a temp DATA_DIR.
   Exercises the handshake, tool listing, read + write tools, auth, and read-only scope gating. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3223;
const base = `http://localhost:${PORT}`;
const AGENT = 'mcp-agent-secret';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-mcp-'));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let rpcId = 0;
const rpc = async (method, params, token = AGENT) => {
  const r = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  let json = null; try { json = await r.json(); } catch { /* may be empty (notification) */ }
  return { status: r.status, json };
};
const callTool = async (name, args, token = AGENT) => {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  const txt = r.json && r.json.result && r.json.result.content && r.json.result.content[0] && r.json.result.content[0].text;
  let data = null; if (txt) { try { data = JSON.parse(txt); } catch { data = txt; } }
  return { status: r.status, isError: !!(r.json && r.json.result && r.json.result.isError), data, raw: r.json };
};
const J = async (p, opts = {}) => { const r = await fetch(base + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b, setCookie: r.headers.get('set-cookie') }; };
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1',
    RHIZOME_AGENT_TOKEN: AGENT, RHIZOME_ADMIN_PASSWORD: 'adminpw', RHIZOME_INVITE_CODE: 'letmein' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

(async () => {
  // wait for boot
  for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/mcp', { method: 'OPTIONS' }); if (r.status === 204) break; } catch {} await sleep(200); }

  /* ---- auth ---- */
  let r = await rpc('initialize', { protocolVersion: '2025-06-18' }, null);
  assert(r.status === 401, 'no credential → 401');
  r = await rpc('initialize', { protocolVersion: '2025-06-18' }, 'wrong');
  assert(r.status === 401, 'bad token → 401');

  /* ---- handshake ---- */
  r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert(r.status === 200 && r.json.result, 'initialize returns a result');
  assert(r.json.result.serverInfo && r.json.result.serverInfo.name === 'rhizome', 'serverInfo.name is rhizome');
  assert(r.json.result.capabilities && r.json.result.capabilities.tools, 'advertises the tools capability');
  assert(r.json.result.protocolVersion === '2025-06-18', 'echoes the requested protocol version');

  // the initialized notification (no id) → 202, empty body
  const nr = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AGENT }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert(nr.status === 202, 'notifications/initialized → 202 with no body');

  /* ---- tools/list ---- */
  r = await rpc('tools/list', {});
  const tools = (r.json.result.tools || []).map(t => t.name).sort();
  assert(tools.length === 8, `tools/list returns 8 tools (${tools.join(', ')})`);
  assert(tools.includes('search') && tools.includes('create_node') && tools.includes('capture'), 'core tools present');
  assert((r.json.result.tools[0].inputSchema || {}).type === 'object', 'tools carry a JSON-Schema inputSchema');

  /* ---- write + read tools (agent token = write scope) ---- */
  let t = await callTool('create_node', { text: '<b>Groceries</b>' });
  assert(!t.isError && t.data && t.data.id, `create_node returns a node (${t.data && t.data.id})`);
  const groceries = t.data.id;
  assert(t.data.plain === 'Groceries' && t.data.format === 'bullet', 'created node has derived plain + default format');

  t = await callTool('create_node', { parent: groceries, text: 'Oat milk', format: 'todo' });
  const milk = t.data.id;
  assert(t.data.parent === groceries && t.data.format === 'todo', 'create under a parent, with a format');

  t = await callTool('get_node', { id: groceries, tree: true });
  assert(t.data.children[0].id === milk && t.data.children[0].plain === 'Oat milk', 'get_node tree=true returns the subtree');

  t = await callTool('list_pages', {});
  assert(Array.isArray(t.data.pages) && t.data.pages.some(p => p.id === groceries && p.title === 'Groceries'), 'list_pages shows the new top-level page');

  t = await callTool('search', { query: 'oat' });
  assert(t.data.results.some(x => x.id === milk), 'search finds the node by term');

  t = await callTool('update_node', { id: milk, done: true, text: 'Oat milk 1L' });
  assert(!t.isError && t.data.done === true && t.data.plain === 'Oat milk 1L', 'update_node changes text + done');

  t = await callTool('move_node', { id: milk, parent: 'root' });
  assert(!t.isError && t.data.parent === 'root', 'move_node reparents to root');

  t = await callTool('move_node', { id: groceries, parent: groceries });
  assert(t.isError, 'move into itself is rejected as a tool error');

  t = await callTool('capture', { text: 'remember the eggs' });
  assert(!t.isError && t.data.captured >= 1, 'capture lands into today\'s journal');

  t = await callTool('delete_node', { id: groceries });
  assert(!t.isError && t.data.deleted >= 1, 'delete_node removes the subtree');
  t = await callTool('get_node', { id: groceries });
  assert(t.isError, 'the deleted node is gone (tool error on read)');

  t = await callTool('get_node', { id: 'does-not-exist' });
  assert(t.isError && /not found/.test(t.raw.result.content[0].text), 'unknown node → isError with a message');

  /* ---- read-only scope gating (a read-scoped API key) ---- */
  const reg = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reader', password: 'sekret1', invite: 'letmein' }) });
  const cookie = cookieFrom(reg.headers.get('set-cookie'));
  const me = (await J('/api/me', { headers: { Cookie: cookie } })).body;
  const gid = me.graphs[0].id;
  const keyRes = await J('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'ro', graphId: gid, scope: 'read' }) });
  const roKey = keyRes.body.key;
  assert(/^rzk_/.test(roKey || ''), 'created a read-scoped rzk_ key');

  t = await callTool('search', { query: 'anything' }, roKey);
  assert(!t.isError, 'read tool works with a read-only key');
  t = await callTool('create_node', { text: 'nope' }, roKey);
  assert(t.isError && /read-only/.test(t.raw.result.content[0].text), 'write tool blocked for a read-only key');

  /* ---- unknown method → JSON-RPC method-not-found ---- */
  r = await rpc('does/notExist', {});
  assert(r.json.error && r.json.error.code === -32601, 'unknown method → JSON-RPC -32601');

  console.log(failures ? `\n${failures} FAILED` : '\nAll MCP tests passed');
  srv.kill();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(2); });
