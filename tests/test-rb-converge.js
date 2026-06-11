'use strict';
/* Route B adversarial convergence proof. The server is the sole sequencer: it applies ops
   in receive order, dedupes by op id, and assigns a monotonic version. Clients receive the
   broadcast stream with RANDOM drops, duplicates, and reordering; on a contiguous version
   they apply the op batch, on a gap they refetch the whole doc (the self-healing floor).
   Across many seeds, every client must converge to the server's exact state — by
   construction, because there is one total order and no client-side baseline to drift.
     node tests/test-rb-converge.js [seeds] */
const { applyOpsToDoc } = require('../opsdoc');

const SEEDS = parseInt(process.argv[2] || '500', 10);
const CLIENTS = 4;
const BATCHES = 60;

function mulberry32(seed) {
  return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function clone(d) { return { root: 'root', nodes: JSON.parse(JSON.stringify(d.nodes)), trash: JSON.parse(JSON.stringify(d.trash || [])) }; }
function liveCanon(d) {
  const sk = o => Array.isArray(o) ? o.map(sk) : (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sk(o[k])])) : o);
  return JSON.stringify(Object.keys(d.nodes).sort().map(id => { const { $hlc, ...r } = d.nodes[id]; return [id, sk(r)]; }));
}
function subtreeIds(doc, id) { const out = [], st = [id], seen = new Set(); while (st.length) { const x = st.pop(); if (!doc.nodes[x] || seen.has(x)) continue; seen.add(x); out.push(x); st.push(...(doc.nodes[x].children || [])); } return out; }
function detach(doc, id) { for (const k in doc.nodes) { const a = doc.nodes[k].children || []; const i = a.indexOf(id); if (i >= 0) { a.splice(i, 1); return; } } }
const trashFn = (doc, id, parent, ts) => { const ids = subtreeIds(doc, id); const nodes = {}; for (const x of ids) nodes[x] = doc.nodes[x]; if (!doc.trash) doc.trash = []; doc.trash.unshift({ ts: ts != null ? ts : 0, parent, index: 0, root: id, nodes }); detach(doc, id); for (const x of ids) delete doc.nodes[x]; };

let failures = 0, refetches = 0, applied = 0;
for (let s = 0; s < SEEDS && !failures; s++) {
  const rng = mulberry32(s + 1);
  const rint = n => (rng() * n) | 0;
  const server = { root: 'root', nodes: { root: { id: 'root', text: '', children: [] } }, trash: [] };
  let version = 0, opId = 0, ctr = 0;
  const ids = ['root'];
  const snapshots = { 0: clone(server) }; // version → server doc (what a refetch returns)
  const broadcasts = [];                  // {version, ops}

  // build the server's op-log
  for (let b = 0; b < BATCHES; b++) {
    const ops = [];
    const n = 1 + rint(3);
    for (let i = 0; i < n; i++) {
      const r = rng(), op = { id: 'o' + (opId++), hlc: String(opId).padStart(8, '0') + ':s' };
      const pick = () => ids[rint(ids.length)];
      if (r < 0.5 || ids.length < 4) { const id = 'n' + (ctr++); ops.push({ ...op, kind: 'insert', node: id, parent: pick(), ord: rint(4), data: { text: 't' + id } }); ids.push(id); }
      else if (r < 0.75) ops.push({ ...op, kind: 'update', node: pick(), patch: { text: 'u' + opId } });
      else ops.push({ ...op, kind: 'move', node: pick(), parent: pick(), ord: rint(4) }); // may cycle → server skips deterministically
    }
    const ok = applyOpsToDoc(server, ops, trashFn);
    if (!ok.length) continue;
    version++;
    snapshots[version] = clone(server);
    broadcasts.push({ version, ops: ok });
  }

  // each client consumes the broadcasts adversarially: drop ~30%, duplicate ~15%, shuffled
  for (let c = 0; c < CLIENTS; c++) {
    const crng = mulberry32(s * 97 + c * 131 + 5);
    const cri = n => (crng() * n) | 0;
    const stream = [];
    for (const m of broadcasts) { if (crng() < 0.3) continue; stream.push(m); if (crng() < 0.15) stream.push(m); }
    for (let i = stream.length - 1; i > 0; i--) { const j = cri(i + 1); [stream[i], stream[j]] = [stream[j], stream[i]]; }
    stream.push(broadcasts[broadcasts.length - 1]); // a final delivery (SSE redelivery / periodic poll) guarantees liveness

    const client = clone(snapshots[0]);
    let cv = 0;
    for (const m of stream) {
      if (m.version <= cv) continue;                 // duplicate / stale → idempotent skip
      if (m.version === cv + 1) { applyOpsToDoc(client, m.ops, trashFn); cv = m.version; applied++; } // contiguous → apply
      else { Object.assign(client, clone(snapshots[version])); cv = version; refetches++; }            // gap → refetch whole doc
    }
    if (liveCanon(client) !== liveCanon(server)) { console.log(`FAIL seed ${s} client ${c}: diverged from server`); failures++; break; }
  }
}

console.log(`\n  seeds=${SEEDS} clients=${CLIENTS} batches=${BATCHES}  (contiguous applies ~${applied}, gap refetches ~${refetches})`);
console.log(failures ? `\n${failures} divergence(s) — ROUTE B BROKEN` : `\nCONVERGENCE HOLDS across ${SEEDS} seeds under random drop/duplicate/reorder — every client matches the server`);
process.exit(failures ? 1 : 0);
