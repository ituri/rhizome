'use strict';
/*
 * Property/fuzz proof of the convergent op-merge engine (Phase 2).
 *
 * For many seeds: D fully-partitioned devices generate a random concurrent op
 * stream (inserts/updates/moves-incl-cycles/deletes/restores, HLC-stamped). The
 * SAME op set is delivered to K replicas in DIFFERENT shuffled orders, with
 * duplicates. We assert every replica converges to byte-identical state and no
 * replica has a cycle — under any delivery order/duplication. A failing seed is
 * printed so it is exactly reproducible.
 *
 *   node tests/test-converge.js [seeds] [opsPerSeed]
 */
const { HLC, Replica, hlcCmp } = require('../ops');

const SEEDS = parseInt(process.argv[2] || '600', 10);
const NOPS = parseInt(process.argv[3] || '250', 10);
const DEVICES = 4;
const REPLICAS = 4;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// generate a concurrent but CAUSALLY-VALID op stream from D devices. Concurrency is
// real (devices act independently on shared nodes), but a device can only reference a
// node it has "seen" — so before referencing one, its clock recv's that node's creation
// stamp (exactly what a real client does on receiving the node). That rules out the
// impossible "act on a node that doesn't exist yet" case while preserving full concurrency.
function genOps(rng, nOps) {
  let wall = 1_000_000_000_000;
  const now = () => wall;
  const devs = Array.from({ length: DEVICES }, (_, i) => new HLC('d' + i, now));
  const ops = [];
  const ids = ['root'];
  const bornAt = { root: '0000000000000:00000:d0' };
  let counter = 0;
  const ref = (dev, id) => { dev.recv(bornAt[id]); return id; };          // "I've seen this node"
  const pick = dev => ref(dev, ids[(rng() * ids.length) | 0]);
  ops.push({ id: 'op0', hlc: devs[0].tick(), kind: 'insert', node: 'root', parent: null, ord: 0, data: { text: '' } });
  for (let k = 1; k < nOps; k++) {
    if (rng() < 0.35) wall += 1; // mix concurrent (same ms) and sequential events
    const dev = devs[(rng() * DEVICES) | 0];
    const r = rng();
    if (r < 0.35 || ids.length < 4) {
      const parent = pick(dev);
      const id = 'n' + (counter++);
      const hlc = dev.tick();
      ops.push({ id: 'op' + k, hlc, kind: 'insert', node: id, parent, ord: (rng() * 5) | 0, data: { text: 't' + id } });
      bornAt[id] = hlc; ids.push(id);
    } else if (r < 0.6) {
      ops.push({ id: 'op' + k, kind: 'update', node: pick(dev), patch: { text: 'u' + k, done: rng() < 0.5 }, hlc: dev.tick() });
    } else if (r < 0.85) {
      const node = pick(dev), parent = pick(dev);
      ops.push({ id: 'op' + k, kind: 'move', node, parent, ord: (rng() * 5) | 0, hlc: dev.tick() }); // may cycle → must be skipped
    } else if (r < 0.95) {
      ops.push({ id: 'op' + k, kind: 'delete', node: pick(dev), hlc: dev.tick() });
    } else {
      const node = pick(dev), parent = pick(dev);
      ops.push({ id: 'op' + k, kind: 'restore', node, parent, ord: 0, hlc: dev.tick() });
    }
  }
  return ops;
}

let failures = 0, cycles = 0, moves = 0, skippedMoves = 0;
for (let s = 0; s < SEEDS; s++) {
  const rng = mulberry32(s + 1);
  const ops = genOps(rng, NOPS);
  moves += ops.filter(o => o.kind === 'move').length;

  // reference = ops applied in true HLC order
  const ref = new Replica();
  ref.applyAll([...ops].sort((a, b) => hlcCmp(a.hlc, b.hlc)));
  const refSnap = ref.snapshot();

  // K replicas, each fed the ops (plus duplicates) in a different random order
  for (let r = 0; r < REPLICAS; r++) {
    const dupes = ops.filter(() => rng() < 0.15);          // redeliver ~15%
    const order = shuffle([...ops, ...dupes], mulberry32(s * 131 + r * 977 + 7));
    const rep = new Replica();
    rep.applyAll(order);
    if (rep.snapshot() !== refSnap) {
      failures++;
      console.log(`FAIL seed ${s}: replica ${r} diverged (order-dependent merge!)`);
      break;
    }
    if (rep.hasCycle()) { cycles++; console.log(`FAIL seed ${s}: cycle present`); break; }
  }
}
// how often a move was genuinely cycle-skipped (proves the path is exercised)
{
  const rng = mulberry32(42);
  const ops = genOps(rng, NOPS);
  const rep = new Replica();
  for (const op of ops) {
    if (op.kind === 'move') { const before = rep.nodes.get(op.node); const bp = before && before.parent; rep.apply(op); const af = rep.nodes.get(op.node); if (af && af.parent === bp && bp !== op.parent) skippedMoves++; }
    else rep.apply(op);
  }
}

console.log(`\n  seeds=${SEEDS} ops/seed=${NOPS} devices=${DEVICES} replicas=${REPLICAS}`);
console.log(`  total moves exercised ~${moves}, cycle-skips observed in sample: ${skippedMoves}`);
console.log(failures || cycles
  ? `\n${failures} divergence(s), ${cycles} cycle(s) — CONVERGENCE BROKEN`
  : `\nCONVERGENCE HOLDS across ${SEEDS} seeds — identical state under every delivery order, zero cycles`);
process.exit(failures || cycles ? 1 : 0);
