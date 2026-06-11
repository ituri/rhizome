'use strict';
// Deterministic document generator for benchmarks. Builds a balanced fanout-5
// tree of `n` nodes with realistic text (tags, mentions, dates, some notes/done).

function sampleText(i) {
  const base = `Task item ${i} — some descriptive words to make this realistic`;
  if (i % 7 === 0) return `${base} #project${i % 20}`;
  if (i % 11 === 0) return `${base} <time datetime="2026-06-${String((i % 27) + 1).padStart(2, '0')}">Jun ${(i % 27) + 1}</time>`;
  if (i % 5 === 0) return `${base} @person${i % 10}`;
  return base;
}

function makeDoc(n) {
  const nodes = { root: { id: 'root', text: '', note: null, done: false, collapsed: false, children: [], c: 0, m: 0 } };
  const ids = ['root'];
  for (let i = 0; i < n; i++) {
    const nid = 'n' + i.toString(36);
    const parent = ids[Math.floor(i / 5)]; // fanout 5 → balanced, ~8 deep at 100k
    nodes[nid] = {
      id: nid,
      text: sampleText(i),
      note: i % 13 === 0 ? 'a short note attached to this item' : null,
      done: i % 4 === 0,
      collapsed: false,
      children: [],
      c: 1, m: 1,
    };
    nodes[parent].children.push(nid);
    ids.push(nid);
  }
  return { version: 1, doc: { root: 'root', nodes } };
}

module.exports = { makeDoc };
