'use strict';
/*
 * Convergent op-merge engine (Phase 2).  Pure, dependency-free, no I/O.
 *
 * The state is, by definition, the result of folding ALL ops in Hybrid-Logical-Clock
 * order. We keep that fold incremental: applying an op inserts it into the
 * timestamp-sorted log and undo/redo's the tail around it (Kleppmann's replicated-tree
 * technique). Because every replica folds the same op set in the same (total) order,
 * every replica converges to byte-identical state — under any delivery order,
 * duplication, or partition. Concurrent MOVES that would form a cycle are skipped
 * deterministically (same decision on every replica, since the order is fixed), so a
 * cycle can never appear.
 *
 * Ops (each carries `id` for idempotency and `hlc` for ordering):
 *   insert  {id, hlc, node, parent, ord, data}
 *   update  {id, hlc, node, patch}            // shallow field merge of `data`
 *   move    {id, hlc, node, parent, ord}
 *   delete  {id, hlc, node}                    // tombstone
 *   restore {id, hlc, node, parent, ord}
 */

/* ---------------- Hybrid Logical Clock ---------------- */
// serialized as "<13-digit ms>:<5-digit counter>:<device>" → lexicographic = causal order
function pad(n, w) { return String(n).padStart(w, '0'); }

class HLC {
  constructor(device, now = () => Date.now()) { this.device = device; this.now = now; this.p = 0; this.c = 0; }
  tick() {
    const wall = this.now();
    if (wall > this.p) { this.p = wall; this.c = 0; } else { this.c++; }
    return `${pad(this.p, 13)}:${pad(this.c, 5)}:${this.device}`;
  }
  recv(stamp) {
    const [rp, rc] = stamp.split(':');
    const wall = this.now();
    const p = Math.max(wall, this.p, +rp);
    if (p === this.p && p === +rp) this.c = Math.max(this.c, +rc) + 1;
    else if (p === this.p) this.c = this.c + 1;
    else if (p === +rp) this.c = +rc + 1;
    else this.c = 0;
    this.p = p;
  }
}
const hlcCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // fixed-width → string compare is correct

/* ---------------- Replica (materialized state + ordered log) ---------------- */

class Replica {
  constructor() {
    this.nodes = new Map();   // id → { id, parent, ord, deleted, data }
    this.log = [];            // [{ op, undo }] sorted ascending by op.hlc
    this.seen = new Set();    // op.id → idempotency
  }

  // is `b` inside the subtree rooted at `a` (walking parent pointers up from b)?
  _inSubtree(b, a) {
    let cur = b, guard = this.nodes.size + 1;
    while (cur != null && guard-- > 0) {
      if (cur === a) return true;
      cur = this.nodes.get(cur)?.parent;
    }
    return false;
  }

  _do(op) {
    const n = this.nodes.get(op.node);
    switch (op.kind) {
      case 'insert': {
        if (this.nodes.has(op.node)) return { t: 'noop' };
        this.nodes.set(op.node, { id: op.node, parent: op.parent, ord: op.ord, deleted: false, data: op.data });
        return { t: 'ins', id: op.node };
      }
      case 'update': {
        if (!n) return { t: 'noop' };
        const old = {};
        for (const k of Object.keys(op.patch)) old[k] = n.data[k];
        Object.assign(n.data, op.patch);
        return { t: 'data', id: op.node, old };
      }
      case 'move': {
        if (!n) return { t: 'noop' };
        // skip if it would put the node inside its own subtree (cycle) — deterministic
        if (op.parent != null && this._inSubtree(op.parent, op.node)) return { t: 'noop' };
        const old = { parent: n.parent, ord: n.ord };
        n.parent = op.parent; n.ord = op.ord;
        return { t: 'pos', id: op.node, old };
      }
      case 'delete': {
        if (!n) return { t: 'noop' };
        const old = { deleted: n.deleted };
        n.deleted = true;
        return { t: 'flag', id: op.node, old };
      }
      case 'restore': {
        if (!n) return { t: 'noop' };
        const old = { deleted: n.deleted, parent: n.parent, ord: n.ord };
        n.deleted = false;
        // reattach only if it wouldn't form a cycle (same guard as move) — deterministic
        if (op.parent !== undefined && !(op.parent != null && this._inSubtree(op.parent, op.node))) {
          n.parent = op.parent; n.ord = op.ord;
        }
        return { t: 'restore', id: op.node, old };
      }
      default: return { t: 'noop' };
    }
  }

  _undo(u) {
    if (u.t === 'noop') return;
    const n = this.nodes.get(u.id);
    if (u.t === 'ins') { this.nodes.delete(u.id); return; }
    if (!n) return;
    if (u.t === 'data') Object.assign(n.data, u.old);
    else if (u.t === 'pos') { n.parent = u.old.parent; n.ord = u.old.ord; }
    else if (u.t === 'flag') n.deleted = u.old.deleted;
    else if (u.t === 'restore') { n.deleted = u.old.deleted; n.parent = u.old.parent; n.ord = u.old.ord; }
  }

  // apply one op; idempotent; keeps the log timestamp-sorted via undo/redo of the tail
  apply(op) {
    if (this.seen.has(op.id)) return false;
    this.seen.add(op.id);
    let i = this.log.length;
    while (i > 0 && hlcCmp(this.log[i - 1].op.hlc, op.hlc) > 0) i--;
    for (let j = this.log.length - 1; j >= i; j--) this._undo(this.log[j].undo);   // undo tail
    this.log.splice(i, 0, { op, undo: null });                                      // insert
    for (let j = i; j < this.log.length; j++) this.log[j].undo = this._do(this.log[j].op); // redo tail
    return true;
  }

  applyAll(ops) { for (const op of ops) this.apply(op); }

  // a canonical, comparable snapshot of the FULL state (incl. tombstones), order-independent
  snapshot() {
    const all = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return JSON.stringify(all.map(n => ({ id: n.id, parent: n.parent, ord: n.ord, deleted: n.deleted, data: n.data })));
  }

  // structural check: no cycle among live nodes
  hasCycle() {
    for (const n of this.nodes.values()) {
      if (n.deleted) continue;
      const slow = n.id;
      let fast = n.parent, steps = 0;
      while (fast != null && steps++ <= this.nodes.size) {
        if (fast === slow) return true;
        fast = this.nodes.get(fast)?.parent;
      }
      if (steps > this.nodes.size) return true;
    }
    return false;
  }
}

module.exports = { HLC, Replica, hlcCmp };
