// Pure-node multi-graph isolation test. Run against a server started with:
//   RHIZOME_ADMIN_PASSWORD=adminpw RHIZOME_INVITE_CODE=letmein PORT=3217 DATA_DIR=<fresh>
const base = `http://localhost:${process.env.PORT || 3217}`;
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };
const J = async (path, opts = {}) => {
  const r = await fetch(base + path, opts);
  let body = null; try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body, setCookie: r.headers.get('set-cookie') };
};
const post = (path, obj, cookie) => J(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(obj),
});
const cookieFrom = sc => { const m = (sc || '').match(/rz_session=([^;]+)/); return m ? 'rz_session=' + m[1] : ''; };
const register = async name => {
  const r = await post('/api/register', { username: name, password: 'sekret1', invite: 'letmein' });
  const cookie = cookieFrom(r.setCookie);
  const me = (await J('/api/me', { headers: { Cookie: cookie } })).body;
  return { cookie, gid: me.graphs[0].id, me };
};

(async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  assert(alice.gid && bob.gid && alice.gid !== bob.gid, 'each user gets their own distinct graph');
  assert(alice.me.graphs.length === 1 && bob.me.graphs.length === 1, 'a fresh user sees exactly one graph');

  // alice writes into her graph
  const doc = { root: 'root', nodes: { root: { id: 'root', text: '', children: ['n1'] }, n1: { id: 'n1', text: 'alice secret', children: [] } } };
  let r = await J(`/api/g/${alice.gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie }, body: JSON.stringify({ doc }) });
  assert(r.status === 200, 'alice can write to her own graph');
  r = await J(`/api/g/${alice.gid}/doc`, { headers: { Cookie: alice.cookie } });
  assert(JSON.stringify(r.body).includes('alice secret'), 'alice reads back her own data');

  // bob cannot touch alice's graph
  r = await J(`/api/g/${alice.gid}/doc`, { headers: { Cookie: bob.cookie } });
  assert(r.status === 403, "bob is denied read access to alice's graph (403)");
  r = await J(`/api/g/${alice.gid}/doc`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie }, body: JSON.stringify({ doc }) });
  assert(r.status === 403, "bob is denied write access to alice's graph (403)");
  r = await J(`/api/g/${alice.gid}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie }, body: JSON.stringify({ ops: [] }) });
  assert(r.status === 403, "bob is denied ops on alice's graph (403)");

  // bob's own graph is empty of alice's data (isolation)
  r = await J(`/api/g/${bob.gid}/doc`, { headers: { Cookie: bob.cookie } });
  assert(!JSON.stringify(r.body).includes('alice secret'), "alice's data never leaks into bob's graph");

  // an unauthenticated request is rejected
  r = await J(`/api/g/${alice.gid}/doc`);
  assert(r.status === 401, 'an unauthenticated graph request is rejected (401)');

  /* ---- sharing (Phase 4): alice shares her graph with bob ---- */
  r = await post(`/api/graphs/${alice.gid}/members`, { username: 'bob' }, bob.cookie);
  assert(r.status === 403, 'a non-owner cannot add members');
  r = await post(`/api/graphs/${alice.gid}/members`, { username: 'nobody' }, alice.cookie);
  assert(r.status === 404, 'sharing with an unknown username fails');
  r = await post(`/api/graphs/${alice.gid}/members`, { username: 'bob' }, alice.cookie);
  assert(r.status === 200, 'the owner shares the graph with bob');
  r = await J(`/api/g/${alice.gid}/doc`, { headers: { Cookie: bob.cookie } });
  assert(r.status === 200 && JSON.stringify(r.body).includes('alice secret'), 'bob can now read the shared graph');
  r = await J('/api/me', { headers: { Cookie: bob.cookie } });
  assert(r.body.graphs.length === 2 && r.body.graphs.some(g => g.id === alice.gid && g.role === 'editor'),
    "the shared graph appears in bob's list as editor");
  // bob (editor) can write to the shared graph — collaboration
  r = await J(`/api/g/${alice.gid}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie }, body: JSON.stringify({ ops: [] }) });
  assert(r.status === 200, 'an editor can post ops to the shared graph');

  /* ---- revoke ---- */
  const members = (await J(`/api/graphs/${alice.gid}/members`, { headers: { Cookie: alice.cookie } })).body.members;
  const bobId = members.find(m => m.username === 'bob').id;
  r = await J(`/api/graphs/${alice.gid}/members/${bobId}`, { method: 'DELETE', headers: { Cookie: alice.cookie } });
  assert(r.status === 200, 'the owner removes bob');
  r = await J(`/api/g/${alice.gid}/doc`, { headers: { Cookie: bob.cookie } });
  assert(r.status === 403, 'bob loses access after being removed (403)');

  /* ---- API keys (scoped, per-graph) ---- */
  let kr = await post('/api/keys', { name: 'writer', graphId: alice.gid, scope: 'write' }, alice.cookie);
  assert(kr.status === 200 && (kr.body.key || '').startsWith('rzk_'), 'alice creates a write API key');
  const wkey = kr.body.key;
  const bearer = k => ({ Authorization: 'Bearer ' + k });
  r = await J(`/api/g/${alice.gid}/doc`, { headers: bearer(wkey) });
  assert(r.status === 200 && JSON.stringify(r.body).includes('alice secret'), 'a write key reads its graph');
  r = await J(`/api/g/${alice.gid}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(wkey) }, body: JSON.stringify({ ops: [] }) });
  assert(r.status === 200, 'a write key can post ops');
  r = await J('/api/capture?token=' + wkey, { method: 'POST', body: 'via key' });
  assert(r.status === 200 && r.body.captured === 1, 'a write key captures into its graph');
  kr = await post('/api/keys', { name: 'reader', graphId: alice.gid, scope: 'read' }, alice.cookie);
  const rkey = kr.body.key;
  r = await J(`/api/g/${alice.gid}/doc`, { headers: bearer(rkey) });
  assert(r.status === 200, 'a read key can GET');
  r = await J(`/api/g/${alice.gid}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(rkey) }, body: JSON.stringify({ ops: [] }) });
  assert(r.status === 403, 'a read key is denied writes (403)');
  r = await J(`/api/g/${bob.gid}/doc`, { headers: bearer(wkey) });
  assert(r.status === 403, "a key bound to alice's graph cannot reach bob's (403)");
  const keys = (await J('/api/keys', { headers: { Cookie: alice.cookie } })).body.keys;
  assert(keys.length === 2, 'alice lists her two keys');
  await J('/api/keys/' + keys[0].id, { method: 'DELETE', headers: { Cookie: alice.cookie } });
  r = await J(`/api/g/${alice.gid}/doc`, { headers: bearer(wkey) });
  assert(r.status === 401 || r.status === 403, 'a revoked key no longer works');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nGRAPH ISOLATION + SHARING + KEYS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
