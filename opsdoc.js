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
        let changed = false;
        for (const k in (op.patch || {})) {
          const g = GROUP[k] || 'meta';
          if (op.hlc > hlcOf(n, g)) { n[k] = op.patch[k]; setHlc(n, g, op.hlc); changed = true; }
        }
        if (changed) out.push(op);
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
        if (trashFn) trashFn(doc, op.node, pm[op.node] || null);
        out.push(op);
        break;
      }
      // 'restore' is not part of the op wire yet — trash-restore still goes through PUT /api/doc.
      default: break;
    }
  }
  return out;
}

module.exports = { applyOpsToDoc, parentMap, isAncestor, GROUP };
