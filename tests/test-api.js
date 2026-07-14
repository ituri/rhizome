/* Per-node REST API tests + live SSE pickup into the browser. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:3214';
const TOKEN = 'agent-secret-xyz';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

(async () => {
  /* ---- auth ---- */
  let r = await fetch(BASE + '/api/v1/version');
  assert(r.status === 401, 'API rejects requests with no token (401)');
  r = await fetch(BASE + '/api/v1/version', { headers: { Authorization: 'Bearer wrong' } });
  assert(r.status === 401, 'API rejects a wrong token (401)');
  r = await api('GET', '/api/v1/version');
  assert(r.status === 200 && typeof r.json.version === 'number', 'valid token unlocks the API');

  // query-param token also works
  r = await fetch(`${BASE}/api/v1/version?token=${TOKEN}`);
  assert(r.status === 200, '?token= query param authenticates too');

  /* ---- create / read ---- */
  let res = await api('POST', '/api/v1/nodes', { parent: 'root', text: 'Groceries' });
  assert(res.status === 201 && res.json.id, `create returns the new node (${res.json.id})`);
  const groceries = res.json.id;
  assert(res.json.parent === 'root' && res.json.format === 'bullet', 'created node reports parent and default format');

  res = await api('POST', '/api/v1/nodes', { parent: groceries, text: '<b>Milk</b> 2%', done: false });
  const milk = res.json.id;
  res = await api('POST', '/api/v1/nodes', { parent: groceries, text: 'Bread' });
  const bread = res.json.id;
  assert(res.status === 201, 'can create children under a node');

  res = await api('GET', `/api/v1/nodes/${groceries}`);
  assert(res.json.children.length === 2 && res.json.plain === 'Groceries', 'GET node returns children ids + plain text');

  res = await api('GET', `/api/v1/nodes/${milk}`);
  assert(res.json.text.includes('<b>Milk</b>') && res.json.plain === 'Milk 2%', 'inline markup preserved; plain derived');

  res = await api('GET', `/api/v1/nodes/${groceries}?tree=1`);
  assert(res.json.children[0].id === milk && res.json.children[0].plain === 'Milk 2%', 'tree=1 returns the nested subtree');

  /* ---- update / complete ---- */
  res = await api('PATCH', `/api/v1/nodes/${milk}`, { text: 'Oat milk', note: 'the barista blend', format: 'todo' });
  assert(res.json.plain === 'Oat milk' && res.json.note === 'the barista blend' && res.json.format === 'todo',
    'PATCH updates text, note, and format');

  res = await api('POST', `/api/v1/nodes/${milk}/complete`, {});
  assert(res.json.done === true, 'complete marks the node done');
  res = await api('POST', `/api/v1/nodes/${milk}/complete`, { done: false });
  assert(res.json.done === false, 'complete {done:false} un-completes');

  /* ---- move ---- */
  res = await api('POST', '/api/v1/nodes', { parent: 'root', text: 'Errands' });
  const errands = res.json.id;
  res = await api('POST', `/api/v1/nodes/${bread}/move`, { parent: errands, index: 0 });
  assert(res.json.parent === errands, 'move relocates a node under a new parent');
  res = await api('GET', `/api/v1/nodes/${groceries}`);
  assert(!res.json.children.includes(bread), 'moved node left its old parent');

  // illegal move guarded
  res = await api('POST', `/api/v1/nodes/${groceries}/move`, { parent: milk });
  assert(res.status === 400, 'moving a node into its own subtree is rejected (400)');

  /* ---- search ---- */
  res = await api('GET', '/api/v1/search?q=oat');
  assert(res.json.results.some(x => x.id === milk && x.path.includes('Groceries')),
    'search finds nodes with their ancestor path');

  /* ---- delete (to trash) ---- */
  res = await api('DELETE', `/api/v1/nodes/${errands}`);
  assert(res.json.ok && res.json.deleted === 2, `delete removes the subtree (errands + bread = ${res.json.deleted})`);
  res = await api('GET', `/api/v1/nodes/${errands}`);
  assert(res.status === 404, 'deleted node is gone (404)');
  // it went to the trash, restorable in the app
  const doc = (await api('GET', '/api/v1/doc')).json.doc;
  assert(doc.trash && doc.trash.some(t => t.root === errands), 'deleted node is recoverable from the trash');

  /* ---- live SSE pickup into an open browser tab ---- */
  // server is password-protected, so authenticate the browser via /api/login first
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const cookieVal = cookie.split('=')[1];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setCookie({ name: 'tendril_auth', value: cookieVal, domain: 'localhost', path: '/' });
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(500);
  const vBefore = await page.evaluate(() => state.version);
  // agent creates a node via the API while the tab is open
  res = await api('POST', '/api/v1/nodes', { parent: 'root', text: 'added by the agent' });
  await sleep(1600); // SSE round-trip
  const picked = await page.evaluate(() =>
    Object.values(doc.nodes).some(n => (n.text || '').includes('added by the agent')) && state.version);
  assert(picked && picked > vBefore, `agent's API edit appears live in the open tab via SSE (v${vBefore}→${picked})`);
  await browser.close();

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL API TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
