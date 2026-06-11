'use strict';
/*
 * Apply ops to the legacy doc model (children-array tree + trash), in the order the
 * single-owner server receives them, with field-level last-writer-wins by per-node HLC
 * and deterministic cycle-skip for moves. Because the server is the sole sequencer and
 * broadcasts this exact order, every client that replays it converges — and the
 * cycle-skip means a cycle can never appear. (ops.js is the stronger decentralized
 * proof of the same merge semantics; here the server's total order does the linearizing.)
 *
 * Per-node HLC lives in `node.$hlc = { struct, text, flags, meta }` (persisted inside the
 * node's data by Phase 1's row sync). Pure except for the injected `trashFn` for deletes.
 */

const GROUP = { text: 'text', note: 'meta', files: 'meta', comments: 'meta', mirror: 'meta', done: 'flags', collapsed: 'flags', format: 'flags' };

function parentMap(doc) {
  const p = Object.create(null);
  for (const id in doc.nodes) for (const c of (doc.nodes[id].children || [])) p[c] = id;
  return p;
}
// is `a` an ancestor of `b` (walking parents up from b)?
function isAncestor(pm, a, b) {
  let cur = b, guard = 1e7;
  while (cur != null && guard-- > 0) { if (cur === a) return true; cur = pm[cur]; }
  return false;
}
const hlcOf = (n, g) => (n.$hlc && n.$hlc[g]) || '';
const setHlc = (n, g, hlc) => { (n.$hlc || (n.$hlc = {}))[g] = hlc; };
const clamp = (ord, len) => { ord |= 0; return ord < 0 ? 0 : ord > len ? len : ord; };

function applyOpsToDoc(doc, ops, trashFn) {
  const pm = parentMap(doc);
  const out = [];
  for (const op of ops) {
    if (!op || typeof op.node !== 'string' || typeof op.hlc !== 'string') continue;
    const n = doc.nodes[op.node];
    switch (op.kind) {
      case 'insert': {
        if (doc.nodes[op.node]) break;                       // idempotent
        const node = { ...(op.data || {}), id: op.node, children: [] };
        node.$hlc = { struct: op.hlc, text: op.hlc, flags: op.hlc, meta: op.hlc };
        doc.nodes[op.node] = node;
        const par = doc.nodes[op.parent] || doc.nodes.root;
        if (par) { par.children.splice(clamp(op.ord, par.children.length), 0, op.node); pm[op.node] = par.id; }
        out.push(op);
        break;
      }
      case 'update': {
        if (!n) break;
        // Compare every field against its group's HLC as it was BEFORE this op (so multiple
        // fields in one group all apply). `unset` removes a key (delete n.format); `patch`
        // sets one (note = null is a real value, kept distinct from removal).
        const keys = [...Object.keys(op.patch || {}), ...(op.unset || [])];
        const base = {};
        for (const k of keys) { const g = GROUP[k] || 'meta'; if (!(g in base)) base[g] = hlcOf(n, g); }
        let changed = false;
        for (const k in (op.patch || {})) if (op.hlc > base[GROUP[k] || 'meta']) { n[k] = op.patch[k]; changed = true; }
        for (const k of (op.unset || [])) if (op.hlc > base[GROUP[k] || 'meta']) { delete n[k]; changed = true; }
        if (changed) { for (const g in base) if (op.hlc > base[g]) setHlc(n, g, op.hlc); out.push(op); }
        break;
      }
      case 'move': {
        if (!n || !(op.hlc > hlcOf(n, 'struct'))) break;            // LWW
        if (op.parent == null || !doc.nodes[op.parent] || isAncestor(pm, op.node, op.parent)) break; // cycle/invalid → skip
        const oldP = pm[op.node];
        if (oldP && doc.nodes[oldP]) { const a = doc.nodes[oldP].children; const i = a.indexOf(op.node); if (i >= 0) a.splice(i, 1); }
        const par = doc.nodes[op.parent];
        par.children.splice(clamp(op.ord, par.children.length), 0, op.node);
        pm[op.node] = op.parent; setHlc(n, 'struct', op.hlc);
        out.push(op);
        break;
      }
      case 'delete': {
        if (!n || !(op.hlc > hlcOf(n, 'struct'))) break;            // LWW: delete wins concurrent edit
        if (trashFn) trashFn(doc, op.node, pm[op.node] || null, op.ts); // carries the client's trash ts → identical entry
        out.push(op);
        break;
      }
      case 'untrash': {                                             // restore-cleanup or purge: drop a trash entry by ts
        if (!doc.trash || op.ts == null) break;
        const i = doc.trash.findIndex(t => t.ts === op.ts);
        if (i >= 0) { doc.trash.splice(i, 1); out.push(op); }       // idempotent
        break;
      }
      // restore = the removed nodes reappear as normal insert ops + an untrash that clears the entry
      default: break;
    }
  }
  return out;
}

module.exports = { applyOpsToDoc, parentMap, isAncestor, GROUP };
