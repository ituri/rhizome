# Tests

Two families of suites, both exercising the **real** `server.js`:

- **Browser e2e** — puppeteer-core + headless Chrome, driving the app UI (250+ assertions).
- **Convergence, persistence & op-sync** — the Tier-3 SQLite / op-merge suites, launched via
  `npm run test:*`. Some are pure Node; the rest are puppeteer-driven.

## Browser e2e suites

| Suite | Covers |
|---|---|
| `test.js` | Core outlining: typing, split/merge, indent, zoom, search, jump, selection, drag & drop, persistence |
| `test2.js` | Search operators, blocks, slash menu, dates, tags, stars, trash, mirrors, comments, capture, SSE, sharing, presentation, calendar grid |
| `test3.js` | Formatting shortcuts, link dialog, imports/exports, attachments, embeds, templates, appearance, share revoke, XSS sanitization, popover viewport-fit |
| `test4.js` | Numbered lists, sort, board buttons, move/mirror-to, date stamps, date formats, rich tags, markdown paste, extra embeds |
| `test5.js` | Natural-language dates + Tab, date ranges, `[[` inline linking, `link:` operator |
| `test-board.js` | Kanban: render, edit, cross-column drag, column reorder, zoomed board view |
| `test-nav.js` | Caret memory across zoom/search, smooth View-Transition zoom + its toggle |
| `test-ui.js` | Animation gating, header-to-bullet nav, calendar button, explicit date hint, delete focus placement, quick-capture QoL |
| `test-cal.js` | Calendar journal: Today button, Year/Month/Day hierarchy, date strip, dated-item surfacing |
| `test-api.js` | Per-node REST API + live SSE pickup — run the server with `TENDRIL_AGENT_TOKEN=agent-secret-xyz TENDRIL_PASSWORD=pw PORT=3214` |
| `test-auth.js` | Password login flow — run the server with `TENDRIL_PASSWORD=s3cret PORT=3212` |
| `test-fixes.js` | Regressions from the 2026-06 review: share-merge subtree scoping (+cycle/trash), files gate, server-side sync sanitization, static-path guard (spawns its own server on 3215), markdown-shortcut marker text, undo burst, operator-only search, calendar year carry, month-grid rows, import format fidelity |

## Convergence, persistence & op-sync suites (`npm run test:*`)

The Tier-3 SQLite store and op-merge engine are proven by their own suites, run from the
repo root. The **pure-Node** ones need nothing but Node; the **browser** ones need Chrome +
`puppeteer-core` and a fresh server on 3211, like the e2e suites above.

| Script | File | Kind | Proves |
|---|---|---|---|
| `npm run test:db` | `test-db.js` | Node | Store: migration round-trip, incremental sync, FTS5 search, `fsck` |
| `npm run test:converge` | `test-converge.js` | Node | Op-merge convergence — byte-identical across partitioned replicas (fuzz) |
| `npm run test:ops` | `test-ops-server.js` | Node | `POST /api/ops` round-trip: field-LWW, cycle-skip, idempotency |
| `npm run test:rbconverge` | `test-rb-converge.js` | Node | Route B converges under dropped / duplicated / reordered broadcasts |
| `npm run test:mirrorserver` | `test-mirror-server.js` | Node | Server-side mirror routing + share-merge round-trip |
| `npm run test:optrash` | `test-optrash.js` | Browser | Op-based trash: delete / restore / purge converge across clients |
| `npm run test:undo` | `test-undo.js` | Browser | Op-log undo/redo oracle (every mutation is journaled) |
| `npm run test:emit` | `test-emit.js` | Browser | Journal → op → server-apply reproduces the client tree |
| `npm run test:opsync` | `test-opsync.js` | Browser | Two browsers converge via `/api/ops` + SSE, no whole-doc transfer |
| `npm run test:search` | `test-search.js` | Browser | Quick-jump backed by the SQLite FTS5 index |
| `npm run test:mirror` | `test-mirror.js` | Browser | Mirror instance semantics (shared node, diamond bullet, promote-on-delete) |
| `npm run test:worker` | `test-worker.js` | Browser | Off-thread serialization is byte-identical to `JSON.stringify` |

## Running the browser e2e suites

Requires Chrome and `puppeteer-core` (`npm i` in this folder — it has its own
`package.json` so the app itself stays zero-dependency). Unless noted above,
each suite expects a **fresh** server on port 3211:

```powershell
# per suite: reset data, start server, run, stop
$env:PORT='3211'; $env:DATA_DIR="$env:TEMP\tendril-test-data"
Remove-Item -Recurse -Force $env:DATA_DIR -ErrorAction SilentlyContinue
$s = Start-Process node -ArgumentList "..\server.js" -PassThru -WindowStyle Hidden
node test.js
Stop-Process -Id $s.Id -Force
```

Suites are stateful within a run but must not share server state with each other —
always restart with a clean `DATA_DIR` between suites.

Update `CHROME` at the top of each file if Chrome lives elsewhere.
