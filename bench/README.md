# Benchmarks & load harnesses

Dependency-free Node scripts (built-in `http` + `inspector` only) that scale the
document and concurrency to find where the architecture degrades. They run the
**real** `server.js` in-process against a temp data dir.

```
npm run bench:curve     # size → latency/memory curve  (node --expose-gc)
npm run bench:profile   # CPU profile of the save path at 100k nodes
npm run bench:load      # head-of-line blocking · version races · adversarial payloads
```

## Why these, not generic tools

Every expensive operation in Tendril is **O(whole document)** — by design (one JSON
doc is the unit of save, sync, and undo). So the bottlenecks are predictable; these
scripts just quantify them and find the cliff.

## Findings (typical run, mid-range laptop)

### Size → latency curve (`curve.js`)

| nodes | doc size | JSON.stringify | structuredClone (undo) | PUT e2e |
|------:|---------:|---------------:|-----------------------:|--------:|
| 1k    | 0.2 MB   | 1 ms           | 4 ms                   | 10 ms   |
| 10k   | 1.7 MB   | 5 ms           | 17 ms                  | 31 ms   |
| 50k   | 8.6 MB   | 37 ms          | 84 ms                  | 165 ms  |
| 100k  | 17 MB    | 81 ms          | 174 ms                 | 365 ms  |
| 250k  | 44 MB    | 183 ms         | 458 ms                 | 871 ms  |

Everything is linear in node count. "Noticeable" (>100 ms) around **50k**, "janky"
(>300 ms event-loop block per save) around **100k**.

### Save-path CPU profile (`profile.js`, 100k nodes)

A single `PUT /api/doc` does **three synchronous O(n) passes**, all blocking the one
event loop:

```
3807ms  persist  → JSON.stringify(store)        (biggest single cost)
2853ms  readJson → JSON.parse(body)
2551ms  sanitizeDocNodes + sanitizeServerHtml    (re-scans EVERY node on every save)
```

`sanitizeDocNodes` is ~15% of save time and is **redundant work** — it re-sanitizes
the entire document on every full-doc PUT even though only changed nodes need it
(and the client re-sanitizes on render anyway). Best optimization target.

### Concurrency & robustness (`load.js`, 100k nodes)

- **Head-of-line blocking (the real issue):** while a client streams big saves, a
  1-byte `GET /api/version` sees **p50 ≈ 224 ms, max ≈ 340 ms**. One client saving a
  large doc stalls *every* other client/tab, because the save work is synchronous on
  the single thread.
- **Version integrity:** 50 parallel PUTs at the same `baseVersion` → exactly **1
  commit, 49× 409**. No lost-update.
- **Capture vs save race:** 20 captures concurrent with a full-doc PUT → **0 lost**.
  The version check serializes correctly.
- **Adversarial payloads** (cycle, missing-id child, 10 MB node, 50k-deep chain):
  no 500s, no hangs; server stays responsive. The version check gates the doc-replace
  path before deep processing, and `subtreeIds` has a visited-set so cycles can't loop.

## Takeaways

The app is **correct and robust** under load; the ceiling is purely the whole-doc
synchronous operations. Concrete, ordered improvements if you want to raise it:

1. **Don't re-sanitize the whole doc per save** — sanitize only changed nodes (or trust
   render-side sanitization and drop server-side for the bulk path). ~15% off every save.
2. **Move `JSON.stringify` for persistence off the request path** — stringify in the
   async `writeChain` tick, not synchronously inside `persist()`.
3. **Beyond ~50k nodes** the real fixes are architectural (incremental/delta save instead
   of whole-doc PUT; op-log instead of `structuredClone` snapshots; virtualized render
   client-side). Know the ceiling before committing to them.
