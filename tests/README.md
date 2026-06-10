# End-to-end tests

129 browser-level assertions driving the real app in headless Chrome.

| Suite | Covers |
|---|---|
| `test.js` | Core outlining: typing, split/merge, indent, zoom, search, jump, selection, drag & drop, persistence (41) |
| `test2.js` | v2 features: search operators, blocks, slash menu, dates, tags, stars, trash, mirrors, comments, capture, SSE, sharing, presentation, calendar (41) |
| `test3.js` | Gap coverage: formatting shortcuts, link dialog, imports/exports, attachments, embeds, templates, appearance, share revoke, XSS sanitization (36) |
| `test-board.js` | Kanban: render, edit, cross-column drag, column reorder, zoomed board view (11) |
| `test-auth.js` | Password login flow (run the server with `TENDRIL_PASSWORD` set) |

## Running

Requires Chrome and `puppeteer-core` (`npm i puppeteer-core` in this folder — the
app itself stays zero-dependency). Each suite expects a **fresh** server on port 3211:

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
