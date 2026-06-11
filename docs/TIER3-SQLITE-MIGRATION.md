# Tier 3 — per-node SQLite store: migration & correctness spec

Status: **design** (no code yet). Goal: replace the whole-document JSON model with a
per-node SQLite store so edits, saves, undo, search, and sync are **O(change)**, while
*guaranteeing* — by the implementation, not by convention — that the data is never
stale, inconsistent, corrupt, or lost under crashes, races, reordering, duplication, or
network partition.

This document is the contract. Code follows only once the merge rules and invariants
here are agreed and the verification plan (§9) is in place.

---

## 1. What we guarantee — and what we explicitly don't

**Guaranteed by the implementation:**

1. **Server-local ACID.** Every user action is one SQLite transaction: all-or-nothing,
   durable (WAL + fsync), crash-safe. The on-disk tree is *never* partially applied.
2. **Structural integrity, always.** Single parent, no dangling parent, no cycles, no
   orphans, FTS index in lock-step with content — enforced by schema constraints +
   in-transaction checks (§3, §4), so a violating state *cannot be committed*.
3. **No silently-lost newer write.** A write carrying an older logical timestamp than a
   field's current value is *shadowed*, never applied over the newer one (§7).
4. **Convergence under any condition.** Given the same set of operations, every replica
   (tabs, devices, the server) reaches byte-identical state regardless of delivery order,
   duplication, partition, or crash. This is the CRDT property; the convergence argument
   is §7.6 and is earned by fuzz/property tests (§9).

**Explicit, bounded limitations (not magic — stated up front):**

- **Text fields are last-writer-wins at field granularity.** Two devices editing the
  *same node's text* concurrently → the later logical timestamp wins; the other edit is
  dropped (not character-merged). True concurrent text merge needs a per-field sequence
  CRDT, which is a deliberate later upgrade (§10). For a single-owner outliner this is
  the right cost/complexity trade; we name it rather than pretend otherwise.
- **Offline edits older than the trash-retention window (30 days) may be dropped** if
  their target's tombstone has been garbage-collected (§7.7). The bound is explicit and
  configurable.

---

## 2. Why this topology makes "any condition" tractable

Tendril is **single-owner, self-hosted, one server**. That lets the server be the
**total-order sequencer**: it assigns/respects a single logical order over all ops,
applies a deterministic merge, and broadcasts the authoritative order. We get
CRDT-grade convergence *without* full decentralized peer-to-peer CRDT machinery,
because there is one place that orders everything. Clients are optimistic locally and
reconcile to the server's order. Offline clients buffer ops durably and replay on
reconnect; the server merges them by timestamp. This is the key simplification the
architecture affords, and §7 leans on it.

Engine: **`node:sqlite`** (built into Node 22+, zero runtime dependency), WAL mode,
`PRAGMA foreign_keys=ON`. Fallback `better-sqlite3` if FTS5 isn't compiled into the
target Node build — the code is portable between them (both synchronous).

---

## 3. Schema

```sql
PRAGMA journal_mode = WAL;        -- 1 writer + N readers, snapshot isolation
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;      -- WAL-safe durability

CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES nodes(id) ON DELETE RESTRICT,   -- NULL only for 'root'
  ord        TEXT NOT NULL DEFAULT '',     -- fractional index key (sibling order)
  text       TEXT NOT NULL DEFAULT '',
  note       TEXT,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  collapsed  INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0,1)),
  format     TEXT,
  mirror_of  TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  files      TEXT,                          -- JSON array, or NULL
  comments   TEXT,                          -- JSON array, or NULL
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),  -- tombstone
  deleted_at INTEGER,                       -- ms, for 30-day purge
  -- per-field logical clocks for LWW conflict resolution (HLC strings):
  hlc_text   TEXT NOT NULL DEFAULT '',
  hlc_struct TEXT NOT NULL DEFAULT '',      -- parent_id + ord (the "move" clock)
  hlc_flags  TEXT NOT NULL DEFAULT '',      -- done/collapsed/format
  hlc_meta   TEXT NOT NULL DEFAULT '',      -- note/files/comments/mirror
  created    INTEGER NOT NULL,
  modified   INTEGER NOT NULL,
  UNIQUE (parent_id, ord)                   -- deterministic sibling order
);
CREATE INDEX nodes_parent ON nodes(parent_id) WHERE deleted = 0;
CREATE INDEX nodes_deleted ON nodes(deleted_at) WHERE deleted = 1;

-- full-text search, external-content, kept in lock-step by triggers
CREATE VIRTUAL TABLE nodes_fts USING fts5(text, note, content='nodes', content_rowid='rowid');
CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, text, note) VALUES (new.rowid, new.text, new.note);
END;
CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, text, note) VALUES ('delete', old.rowid, old.text, old.note);
END;
CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, text, note) VALUES ('delete', old.rowid, old.text, old.note);
  INSERT INTO nodes_fts(rowid, text, note) VALUES (new.rowid, new.text, new.note);
END;

-- durable op-log: the source of truth for undo AND sync (append-only)
CREATE TABLE oplog (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,  -- server total order
  op_id    TEXT UNIQUE NOT NULL,               -- client-generated uuid → idempotency
  hlc      TEXT NOT NULL,                       -- logical timestamp (ordering + LWW)
  device   TEXT NOT NULL,
  kind     TEXT NOT NULL,                       -- insert|update|move|delete|restore
  node_id  TEXT NOT NULL,
  payload  TEXT NOT NULL,                       -- JSON: new values + inverse (old values)
  applied  INTEGER NOT NULL DEFAULT 1           -- 0 if shadowed/skipped (kept for audit)
);
CREATE INDEX oplog_node ON oplog(node_id, seq);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- stars, calendar root, schema version
```

**Invariants and how each is *enforced* (not hoped for):**

| Invariant | Enforcement |
|---|---|
| Single parent | one `parent_id` column — structurally impossible to have two |
| No dangling parent / orphan | `FOREIGN KEY (parent_id) REFERENCES nodes(id)`; only `root` is NULL |
| No cycle | `move` runs a descendant-check CTE **inside the transaction**, aborts on cycle (§4) |
| Deterministic sibling order | fractional `ord` + `UNIQUE(parent_id, ord)`; tiebreak by device |
| FTS ⇄ content consistency | triggers; FTS can never drift from `nodes` |
| Atomic multi-step actions | one `BEGIN…COMMIT` per app action (§5) |
| Durability / crash safety | WAL + `synchronous=NORMAL` + transactions |

---

## 4. The operation algebra

Five primitives. Each is **invertible** (carries its inverse for undo), **idempotent**
(keyed by `op_id` + per-field HLC compare), and **transactional**. Every higher-level
action (§5) is a *batch* of these applied in one transaction.

| op | params | transaction body | inverse |
|---|---|---|---|
| `insert` | id, parent, ord, fields, hlc | insert row; FK guarantees parent exists | `delete(id)` |
| `update` | id, field, old, new, hlc | LWW guard then `UPDATE … WHERE id` (§7.3) | `update(id, field, new, old)` |
| `move` | id, newParent, newOrd, oldParent, oldOrd, hlc | **cycle-check** then update parent_id+ord | `move(id, oldParent, oldOrd, …)` |
| `delete` | id, hlc | mark subtree `deleted=1`, stash prior (parent,ord) | `restore(id, parent, ord)` |
| `restore` | id, parent, ord, hlc | clear tombstone, reattach | `delete(id)` |

**Cycle check (the structural guarantee for moves)** — inside the move transaction:

```sql
WITH RECURSIVE sub(id) AS (
  SELECT :id UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
)
SELECT 1 FROM sub WHERE id = :newParent;   -- if any row → newParent is a descendant → ABORT
```

If the target is inside the moved subtree, the op is rejected (deterministically, on
every replica — §7.4). A cycle therefore *cannot be committed*.

Notes:
- `files`/`comments`/`note`/`mirror_of` changes are `update` ops on those columns
  (clock `hlc_meta`). `done`/`collapsed`/`format` use `hlc_flags`. `text` uses
  `hlc_text`. `parent_id`+`ord` use `hlc_struct`. Splitting the clock by field-group
  lets a structural move and a text edit on the same node *both* survive concurrently.
- Insert/delete carry enough to fully invert without reading history → undo is O(change).

---

## 5. App actions → atomic op-batches

Existing outliner ops decompose into primitive batches, applied in **one transaction**
so they are atomic and undoable as a unit:

- **split** (Enter at caret) = `update(text of A)` + `insert(B)` + `move`(A's trailing
  children under B) — one txn, one undo entry.
- **merge** (Backspace at start) = `update(text of keep)` + `move`(gone's children to
  keep) + `delete(gone)`.
- **indent/outdent** = `move`.
- **duplicate** = N× `insert`.
- **delete subtree** = `delete(root of subtree)` (tombstones cascade in the txn).
- **setFormat / toggle done / set date pill** = `update`.

The undo stack becomes a list of **op-batches**; undo = apply each batch's inverses in
reverse order, in a transaction. No `structuredClone`, no whole-doc snapshot — this is
the change that removes the 174 ms-per-edit jank at 100k nodes.

---

## 6. Read paths (replace whole-doc GET)

- **Page render**: `WITH RECURSIVE` subtree fetch rooted at the zoomed node, depth-bounded
  to what's expanded → returns only visible nodes. O(visible), not O(doc).
- **Search**: `SELECT … FROM nodes_fts WHERE nodes_fts MATCH ?` joined to `nodes` for the
  operator filters (`is:`, `has:`, dates) → O(matches), not O(doc) per keystroke.
- **Backlinks / tags / dates**: indexed queries (add `links`, `tags`, `dates` side tables
  populated by triggers, or query FTS/`LIKE` for v1).
- **Export / whole doc** (still needed for JSON export, and Phase-1 compatibility): one
  recursive CTE assembling the legacy shape.

---

## 7. Sync — convergence under any condition

### 7.1 Clock: Hybrid Logical Clock (HLC)

Each device keeps `hlc = (physMs, counter, deviceId)`, serialized as a fixed-width
sortable string. Update rules:

- **local event**: `phys = max(now, last.phys)`; `counter = (phys == last.phys) ? last.counter+1 : 0`.
- **on receiving remote `r`**: `phys = max(now, last.phys, r.phys)`; counter bumped per the
  standard HLC rule; `deviceId` breaks final ties.

HLC gives a **total order** that respects causality and tracks wall-clock, without
requiring synchronized clocks. Every op is stamped with the device's current HLC.

### 7.2 Op envelope (the wire format)

```
{ op_id, hlc, device, kind, node_id, payload }      // payload includes inverse (old values)
```

Sent `POST /api/ops` (batch). Broadcast to peers over SSE in server `seq` order.

### 7.3 Field LWW (update)

Apply `update(field)` **iff** `op.hlc > nodes.hlc_<group>`; then set the value and
`hlc_<group> = op.hlc`. Otherwise *shadow* it (record `applied=0`, change nothing). This
is the compare-and-set that makes "no newer write is ever overwritten" a property of the
apply transaction, not a convention.

### 7.4 Structural ops (move) — the hard case

Concurrent moves can form cycles (A→under→B while B→under→A). Resolution, following
Kleppmann's replicated-tree move, simplified by our single sequencer:

- The server applies moves in **HLC order** (it buffers and orders; clients reconcile).
- A move whose cycle-check (§4) fails at apply time is **skipped** (recorded `applied=0`).
- Because every replica consumes the **same server-ordered, cycle-checked op stream**,
  every replica skips the *same* move → identical result. No cycle, no orphan, ever.

`parent_id`+`ord` are guarded by `hlc_struct` LWW exactly like a field, so a concurrent
move + text edit on one node both survive (different clocks).

### 7.5 Insert ordering

`ord` is a **fractional index**: to insert between neighbors `a` and `b`, generate a key
strictly between them; concurrent inserts at the same gap get distinct keys (device-id
suffix tiebreak) and a deterministic total order — **no sibling renumbering**, which
would otherwise be O(siblings) writes and a sync hazard.

### 7.6 Why it converges (the argument)

1. **Idempotent**: ops are keyed by `op_id`; re-delivery is a no-op (UNIQUE constraint).
2. **Commutative under timestamp ordering**: the apply function is a pure function of the
   *timestamp-ordered* op set — LWW fields (max HLC wins), moves (HLC order + deterministic
   cycle-skip), inserts (fractional order). Order of *arrival* doesn't matter; the server
   re-derives the same ordered set.
3. **Total order exists**: HLC + deviceId is a total order; the server's `seq` realizes it.
4. Therefore any two replicas that have seen the same set of ops compute identical state,
   and a replica that is behind converges once it receives the missing ops — under
   arbitrary reordering, duplication, partition, or crash. ∎

This is asserted *and tested* (§9); the spec is not "trust me," it's "here's the property
and the fuzzer that tries to break it."

### 7.7 Offline, crash, GC

- **Offline**: a device durably queues its ops (client-side, e.g. IndexedDB); on reconnect
  it sends them with their *original* HLC; the server merges by timestamp. Optimistically
  applied local ops are provisional; on reconnect the server's authoritative order wins and
  the client re-applies (rolls back skipped moves).
- **Crash (server)**: SQLite transaction → consistent on restart; the WAL replays. The
  oplog lets a recovering client resync from its last seen `seq`.
- **Tombstone GC**: purge `deleted=1` rows older than the retention window (30 d). An op
  referencing a purged node whose HLC predates the purge horizon is dropped (the bounded
  limitation in §1). This prevents resurrection by very-stale peers.

### 7.8 Backward compat during transition

`PUT /api/doc` (whole doc) is kept through Phase 1–3: the server **diffs** the incoming
doc against SQLite and synthesizes the equivalent op-batch, so old clients keep working
while storage is already incremental.

---

## 8. Migration phases (shippable at every step)

| Phase | Change | Risk | Win |
|---|---|---|---|
| **0** | Add SQLite; migrate `outline.json` → rows; **dual-write** (JSON stays source of truth, mirror to SQLite each save) | none | validates schema + migration with zero behavior change |
| **1** | Server **reads** from SQLite (recursive CTE builds the legacy doc); `PUT /api/doc` diffs→ops→SQLite; FTS5 search endpoint | low (wire protocol unchanged; client untouched) | **kills the whole-file rewrite** → incremental persistence, FTS search, no event-loop block on save |
| **2** | `POST /api/ops` + SSE op broadcast; client gains an **op-log**: optimistic local apply, per-node sync (§7), undo via inverse ops (drop `structuredClone` snapshots) | medium (big client change — gate behind a flag, run beside whole-doc PUT) | **kills the 174 ms/edit undo jank**; real multi-device convergence |
| **3** | Client search → FTS endpoint; **virtualized render** for thousands-visible | low/independent | removes search jank + the "few thousand visible" ceiling |
| **4** | Retire whole-doc `PUT` and snapshots; SQLite is sole source of truth | low | finished |

Phase 1 alone delivers most of the *server-side* win (incremental save, no head-of-line
block, indexed search) with almost no client risk. Phase 2 is where the editing-jank and
the convergence guarantees land — and where the §9 verification is mandatory before ship.

---

## 9. How the guarantee is *earned* (verification — not optional)

1. **Property/fuzz convergence test**: simulate K replicas; generate random op streams
   (inserts/updates/moves/deletes incl. concurrent moves designed to cycle); deliver to
   each replica in random order, with duplicates and drops-then-redelivery; **assert all
   replicas converge to byte-identical state, zero cycles, zero orphans**. This is the
   test that actually buys the §7.6 claim. Run thousands of randomized seeds in CI.
2. **`fsck` invariant checker**: every node reachable from root, exactly one parent, no
   cycle (recursive CTE), `ord` unique per parent, FTS row-count == live node count. Run
   after every fuzz batch and (optionally) periodically in production.
3. **Crash test**: `SIGKILL` the server mid-transaction in a loop; on restart assert
   `fsck` clean and the oplog tail consistent.
4. **Migration round-trip**: `outline.json → SQLite → rebuild doc` must deep-equal the
   original, for the real data and generated 1k/100k docs (reuse `bench/gen.js`).
5. **Bench regression**: re-run `bench/` against the SQLite server — edit and save latency
   at 100k must drop from ~175–365 ms to sub-frame; document the new curve.

Nothing in Phase 2+ ships until 1–4 are green across thousands of seeds.

---

## 10. Risks & open decisions

- **`node:sqlite` FTS5**: verify it's compiled into the target Node build; if not, fall
  back to `better-sqlite3` (one native runtime dep) — code is portable.
- **`node:sqlite` experimental status**: pin a Node version; accept the warning or flag.
- **Text concurrent-merge**: field-level LWW now; per-field sequence CRDT (e.g. RGA) is a
  later, isolated upgrade for `text` only — the op envelope already carries a per-field
  clock, so the seam exists.
- **Client store for offline op queue**: IndexedDB vs localStorage (size). Decide in Ph2.
- **Mirror semantics** under per-node sync: a mirror is a node referencing another; LWW on
  `mirror_of` is fine, but verify backlink derivation stays consistent (rebuild from a
  `links` side table populated by triggers).
- **Effort**: Ph0 ~2–3 d, Ph1 ~1 wk, Ph2 ~2–3 wk (incl. the fuzz harness — that's the bulk
  of the *value* and the *risk*), Ph3 ~1 wk. Ph2 is the real project.

---

## 11. Implementation status

| Piece | State | Evidence |
|---|---|---|
| **Phase 1** — SQLite persistence (incremental rows, FTS5), wire-compatible | **done, shipped** | `db.js`, `tests/test-db.js`; all e2e suites green on the SQLite backend |
| **Phase 2 core** — convergent op-merge engine (HLC + timestamp-ordered replay + cycle-skip + idempotency) | **done, proven** | `ops.js`, `tests/test-converge.js`: byte-identical convergence + zero cycles across 2500 seeds × 400 ops × 4 replicas |
| **Phase 2 integration** — `POST /api/ops` + SSE op broadcast (server), `opsdoc.js` field-LWW + cycle-skip; client HLC + id-stable diff + op delta-sync + remote-op apply | **done, tested** | `opsdoc.js`, `server.js`; `tests/test-ops-server.js` (engine-equivalence, LWW, cycle-skip, idempotency, round-trip), `tests/test-opsync.js` (two browsers converge via ops) |
| **Phase 3** — FTS5-backed quick-jump for large docs | **done** | `tests/test-search.js` |
| **Phase 3** — virtualized render | **deferred** | conflicts with the e2e suite's "every visible item is in the DOM" assumption and is explicitly out-of-scope in FEATURES; a standalone effort |
| **Phase 4** — op delta-sync is the **default** save path (PUT = trash + fallback) | **done** | full e2e suite green with `settings.opSync` default-on |
| **Phase 4** — fully retire PUT (op-based trash) + retire `structuredClone` undo (op-log undo) | **remaining** | the two genuine cutover refinements (see below) |

**Topology simplification that made integration tractable.** The decentralized engine
(`ops.js`) needs full timestamp-ordered replay to converge. But Tendril has a single
self-hosted server, so it can be the **total-order sequencer**: `opsdoc.js` applies ops in
receive order with field-LWW + cycle-skip and broadcasts that order; every client replays
it and converges (ops.js is the stronger proof of the same merge semantics). This is §2's
argument, realized — far less machinery than per-peer CRDT.

**What's live now.** Saves send a minimal op set (`/api/ops`) instead of the whole
document; the server persists only changed rows and broadcasts the ops; other tabs/devices
replay them with no whole-doc transfer. Deletes / trash changes still fall back to the
whole-doc PUT so trash stays consistent.

**The two honest remainders.** (1) *Fully* retiring PUT needs op-based trash —
delete/restore ops carrying the trash entry's timestamp so client and server build
identical trash (today trash uses PUT). (2) Retiring `structuredClone` undo needs op-log
undo — instrumenting client mutations to record inverse ops, which is the per-edit-jank fix
and the larger client refactor. Both are well-bounded follow-ons; neither blocks the
delta-sync win that's already shipping.

## 12. One-line summary

Store nodes as rows, express every edit as an invertible, HLC-stamped, transactional op,
let the single self-hosted server be the total-order sequencer, and **prove convergence
with a fuzzer** — that's how "no stale data, no inconsistency, no cycle, no lost newer
write, under any condition" becomes a property of the code rather than a hope.
