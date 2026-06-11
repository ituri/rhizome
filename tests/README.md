# End-to-end tests

Browser-level suites driving the real app in headless Chrome (250+ assertions total).

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

## Running

Requires Chrome and `puppeteer-core` (`npm i puppeteer-core` in this folder — the
app itself stays zero-dependency). Unless noted above, each suite expects a
**fresh** server on port 3211:

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
