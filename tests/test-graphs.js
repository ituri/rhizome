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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nGRAPH ISOLATION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
