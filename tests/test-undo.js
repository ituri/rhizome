/* Op-log undo correctness oracle. Runs random real operations, recording the canonical
   doc after each, then undoes the whole sequence (each step must return to the prior
   state) and redoes it (each step must return to the next state). A mismatch means some
   operation's mutation wasn't journaled. Fresh server on 3211. */
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

const FUZZ = `(${function fuzz(seed, steps) {
  // deterministic RNG
  let s = seed >>> 0;
  const rng = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rint = n => (rng() * n) | 0;
  const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o);
  const canon = () => JSON.stringify(sortKeys({ n: Object.fromEntries(Object.keys(doc.nodes).sort().map(id => [id, doc.nodes[id]])), t: doc.trash || [], m: doc.meta || {} }));
  const ids = () => Object.keys(doc.nodes).filter(x => x !== HOME);
  const pick = () => { const a = ids(); return a.length ? a[rint(a.length)] : HOME; };
  const pickP = () => { const a = Object.keys(doc.nodes); return a[rint(a.length)]; };

  // start clean
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

  const names = ['create', 'toggleDone', 'setFormat', 'indent', 'outdent', 'move', 'delete'];
  const firstDiff = (a, b) => { const A = JSON.parse(a), B = JSON.parse(b); for (const id of new Set([...Object.keys(A.n), ...Object.keys(B.n)])) { if (JSON.stringify(A.n[id]) !== JSON.stringify(B.n[id])) return `node ${id}: got ${JSON.stringify(A.n[id])} vs want ${JSON.stringify(B.n[id])}`; } if (JSON.stringify(A.t) !== JSON.stringify(B.t)) return 'trash differs'; if (JSON.stringify(A.m) !== JSON.stringify(B.m)) return 'meta differs'; return '?'; };

  // (A) each op in isolation: apply → undo (revert to `before`) → redo (reach `after`).
  let done = 0, tries = 0;
  while (done < steps && tries < steps * 6) {
    tries++;
    const before = canon();
    const k = rint(ops.length);
    try { ops[k](); } catch (e) { /* invalid target → ignore */ }
    const after = canon();
    if (after === before) continue;
    done++;
    undo();
    if (canon() !== before) return { ok: false, phase: 'undo1', op: names[k], step: done, diff: firstDiff(canon(), before) };
    redo();
    if (canon() !== after) return { ok: false, phase: 'redo1', op: names[k], step: done, diff: firstDiff(canon(), after) };
  }

  // (B) multi-level: run a fresh sequence, then undo EVERYTHING (must reach the initial
  // state) and redo everything (must reach the final state). Robust to coalescing, and it
  // catches any op that mutates the doc without journaling (its change would survive undo).
  resetHistory();
  const initial = canon();
  let n2 = 0, t2 = 0;
  while (n2 < steps && t2 < steps * 6) { t2++; const b = canon(); try { ops[rint(ops.length)](); } catch (e) { /* skip */ } if (canon() !== b) n2++; }
  const final = canon();
  let g = 0; while (undoStack.length && g++ < 5000) undo();
  if (canon() !== initial) return { ok: false, phase: 'undoAll', step: n2, diff: firstDiff(canon(), initial) };
  g = 0; while (redoStack.length && g++ < 5000) redo();
  if (canon() !== final) return { ok: false, phase: 'redoAll', step: n2, diff: firstDiff(canon(), final) };

  return { ok: true, total: done + n2 };
} })`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3211/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tree .item .content');
  await sleep(400);

  let worst = null, runs = 0;
  for (let seed = 1; seed <= 60 && !failures; seed++) {
    const r = await page.evaluate(`(${FUZZ})(${seed}, 40)`);
    runs++;
    if (!r.ok) { console.log(`FAIL seed ${seed}: ${r.phase} '${r.op}' step ${r.step}/${r.total} — ${r.diff}`); failures++; worst = r; break; }
  }
  assert(!failures, `undo/redo round-trips for ${runs} random op sequences (40 steps each)`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nUNDO TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
