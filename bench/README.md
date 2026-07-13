# Benchmarks & load harnesses

Dependency-free Node scripts (built-in `http` + `inspector` only) that scale the
document and concurrency to find where the architecture degrades. They run the
**real** `server.js` in-process against a temp data dir.

```
npm run bench:curve     # size → latency/memory curve  (node --expose-gc)
npm run bench:profile   # CPU profile of the save path at 100k nodes
npm run bench:load      # head-of-line blocking · version races · adversarial payloads
```

> **Historical note.** The findings below characterize the **legacy whole-doc `PUT /api/doc`
> save path** and predate the Tier-3 SQLite migration. That migration has since shipped:
> saves, undo, and search are now **O(change)**, not O(whole document). The persistence and
> undo costs measured here have been eliminated (per-save `247 ms → 0.2 ms` at 100k nodes;
> per-edit undo `64.8 ms → 0.1 ms` at 50k) — see
> [`docs/TIER3-SQLITE-MIGRATION.md`](../docs/TIER3-SQLITE-MIGRATION.md) §11. The scripts still
> run: `PUT /api/doc` survives as a fallback path, so these harnesses remain useful as a
> regression guard on it.

## Why these, not generic tools

In the legacy model every expensive operation was **O(whole document)** — one JSON doc was
the unit of save, sync, and undo — so the bottlenecks were predictable; these scripts quantify
them and find the cliff. (That whole-doc model is what the Tier-3 migration replaced.)

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

These runs found the app **correct and robust** under load, with the ceiling sitting purely
in the whole-doc synchronous operations. That diagnosis is what motivated the Tier-3 SQLite
migration, which addressed the architectural items directly:

1. ✅ **Incremental/delta save instead of whole-doc PUT** — the normal save path is now
   `POST /api/ops`, and the server persists only the rows a batch touched (`db.applyOps`).
   Per-doc `JSON.stringify` and the per-save re-sanitize are off the hot path.
2. ✅ **Op-log undo instead of `structuredClone` snapshots** — each edit journals only the
   nodes it touched (`64.8 ms → 0.1 ms` per edit at 50k).
3. ⏳ **Virtualized client-side render** — still deferred: it conflicts with the e2e suite's
   "every visible item is in the DOM" assumption and is out of scope in
   [`docs/FEATURES.md`](../docs/FEATURES.md).

See [`docs/TIER3-SQLITE-MIGRATION.md`](../docs/TIER3-SQLITE-MIGRATION.md) §11 for the shipped
work and its measured wins.
