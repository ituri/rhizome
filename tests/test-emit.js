/* Route B op-emission oracle. For random real operations, the ops the CLIENT derives from
   its undo journal (opsFromJournal), when applied by the SERVER's proven applier
   (opsdoc.applyOpsToDoc), must reproduce the client's live tree. This is the fidelity
   guarantee: a user edit survives the journal→op→server-apply round-trip unchanged.
   Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const { applyOpsToDoc } = require('../opsdoc');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

// live nodes only, $hlc stripped, keys sorted — comparable across client and server
function liveCanon(nodes) {
  const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o);
  const out = {};
  for (const id of Object.keys(nodes).sort()) { const { $hlc, ...rest } = nodes[id]; out[id] = sortKeys(rest); }
  return JSON.stringify(out);
}
function subtreeIds(doc, id) { const out = [], st = [id], seen = new Set(); while (st.length) { const x = st.pop(); if (!doc.nodes[x] || seen.has(x)) continue; seen.add(x); out.push(x); st.push(...(doc.nodes[x].children || [])); } return out; }
function detach(doc, id) { for (const k in doc.nodes) { const a = doc.nodes[k].children || []; const i = a.indexOf(id); if (i >= 0) { a.splice(i, 1); return; } } }
const trashFn = (doc, id, parent, ts) => { const ids = subtreeIds(doc, id); const nodes = {}; for (const x of ids) nodes[x] = doc.nodes[x]; if (!doc.trash) doc.trash = []; doc.trash.unshift({ ts: ts != null ? ts : 0, parent, index: 0, root: id, nodes }); detach(doc, id); for (const x of ids) delete doc.nodes[x]; };

const FUZZ = `(${function fuzz(seed, steps) {
  let s = seed >>> 0;
  const rng = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rint = n => (rng() * n) | 0;
  const ids = () => Object.keys(doc.nodes).filter(x => x !== HOME);
  const pick = () => { const a = ids(); return a.length ? a[rint(a.length)] : HOME; };
  const pickP = () => { const a = Object.keys(doc.nodes); return a[rint(a.length)]; };
  const snap = () => { const o = {}; for (const id in doc.nodes) { const { $hlc, ...r } = doc.nodes[id]; o[id] = structuredClone(r); } return o; }; // deep — must not share live arrays
  commitActiveText(); resetHistory();
  let cnt = 0;
  const ops = [
    () => { const p = pickP(); snapshot(); const id = makeNode('f' + (cnt++)); insertAt(p, rint(3), id); rebuildParentMap(); markDirty(); },
    () => opToggleDone(pick()),
    () => opSetFormat(pick(), ['bullet', 'todo', 'h1', 'quote'][rint(4)]),
    () => opIndent(pick()),
    () => opOutdent(pick()),
    () => { snapshot(); const id = pick(), p = pickP(); if (id !== HOME && id !== p && !isAncestor(id, p)) { moveNode(id, p, rint(3)); rebuildParentMap(); markDirty(); } },
    () => { const id = pick(); if (id !== HOME) opDelete(id, { toast: false }); },
  ];
  const out = [];
  let done = 0, tries = 0;
  while (done < steps && tries < steps * 6) {
    tries++;
    const before = snap();
    const k = rint(ops.length);
    try { ops[k](); } catch (e) { /* skip */ }
    const after = snap();
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    done++;
    out.push({ before, ops: window.__opsFromJournal(), after });
  }
  return out;
} })`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  let cases = 0;
  for (let seed = 1; seed <= 80 && !failures; seed++) {
    const steps = await page.evaluate(`(${FUZZ})(${seed}, 25)`);
    for (const step of steps) {
      cases++;
      const doc = { root: 'root', nodes: JSON.parse(JSON.stringify(step.before)) };
      applyOpsToDoc(doc, step.ops, trashFn);
      const got = liveCanon(doc.nodes), want = liveCanon(step.after);
      if (got !== want) {
        console.log(`FAIL seed ${seed}: emitted ops didn't reproduce the edit`);
        console.log('  ops:', JSON.stringify(step.ops.map(o => ({ k: o.kind, n: o.node, p: o.parent, o: o.ord }))));
        const badNode = (() => { for (const id of new Set([...Object.keys(JSON.parse(got)), ...Object.keys(JSON.parse(want))])) { if (JSON.stringify(JSON.parse(got)[id]) !== JSON.stringify(JSON.parse(want)[id])) return id; } })();
        console.log('  before[bad].children:', JSON.stringify(step.before[badNode] && step.before[badNode].children), '→ after:', JSON.stringify(step.after[badNode] && step.after[badNode].children));
        // first differing node
        const G = JSON.parse(got || '{}'), W = JSON.parse(want);
        for (const id of new Set([...Object.keys(JSON.parse(got)), ...Object.keys(JSON.parse(want))])) { if (JSON.stringify(JSON.parse(got)[id]) !== JSON.stringify(JSON.parse(want)[id])) { console.log(`  node ${id}: got ${JSON.stringify(JSON.parse(got)[id])} want ${JSON.stringify(JSON.parse(want)[id])}`); break; } }
        failures++; break;
      }
    }
  }
  assert(!failures, `client-emitted ops reproduce the edit via the server applier (${cases} ops checked)`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nEMIT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
