# Tendril — feature inventory

Status as of 2026-06-11. ✅ implemented (covered by the e2e suites in [`tests/`](../tests/README.md)) · 🟡 partial · ❌ pending.

| Category | Feature | Status | Notes |
|---|---|---|---|
| **Outlining** | Infinite nesting | ✅ | |
| | Zoom into any bullet (click, `Alt+→`/`Alt+↓`/`Alt+.`) | ✅ | Smooth morph animation, toggleable |
| | Breadcrumbs, editable page titles, browser back/forward | ✅ | URL per node |
| | Caret memory across zoom/search | ✅ | Returning to a view restores the exact caret |
| | Expand/collapse (`Ctrl+↑↓`), expand/collapse all | ✅ | Animated |
| | Notes (`Shift+Enter`), one-line clamp until focused | ✅ | |
| | Complete (`Ctrl+Enter`), show/hide completed (`Ctrl+O`) | ✅ | |
| | Drag & drop with depth control, touch long-press | ✅ | Board-aware |
| | Split/merge at caret (Enter/Backspace/Delete at edges) | ✅ | Children reparent correctly |
| | Multi-select (`Shift+↑↓` past the text edge; repeated `Ctrl+A` widens text → item → siblings → levels) + bulk ops | ✅ | Indent, move, complete, delete, copy; typing exits into the item |
| | Click-drag multi-select across bullets | ❌ | Workflowy also supports mouse-drag selection |
| | Smart multi-line paste (indentation → hierarchy) | ✅ | |
| | Trash with restore, 30-day retention | ✅ | Per-entry restore, delete-forever, empty |
| | Undo/redo for everything | ✅ | Snapshot-based, 200 steps |
| | Focus lands sensibly after delete/complete | ✅ | Prev bullet → next bullet → page title |
| **Blocks & formatting** | Headings H1–H3, quote, code block, divider, paragraph | ✅ | |
| | To-do checkboxes | ✅ | |
| | Numbered lists (auto-renumber) | ✅ | `1. ` shortcut, Enter continues |
| | Kanban boards | ✅ | Inline + full-page when zoomed; +card/+column; drag across columns; column reorder |
| | Markdown shortcuts (`# `, `## `, `### `, `> `, `[] `, `1. `, `---`, triple-backtick) | ✅ | |
| | Slash command menu (`/`) | ✅ | Block types, dates, actions, templates |
| | Selection toolbar (B/I/U/S/code/link) | ✅ | Plus `Ctrl+B/I/U`, `Ctrl+Shift+X`, `Ctrl+E` |
| | 8 text colors + 8 highlights | ✅ | |
| | Link selection to URL or item (`Ctrl+K`) | ✅ | |
| | Markdown-aware paste | ✅ | Toggleable |
| | Sort children A–Z / Z–A | ✅ | |
| **Tags & dates** | `#tags` / `@mentions`, styled live, click to filter | ✅ | Shift/Ctrl+click adds to filter |
| | Tag autocomplete | ✅ | Existing tags only |
| | Rich (emoji) tags | ✅ | Toggleable |
| | Natural-language dates + Tab (`today`, `next friday`, `oct 7`, `in 3 days`) | ✅ | Explicit "Press Tab or click here" hint |
| | Date ranges (`jun 12 - jun 15`) | ✅ | Single range pill |
| | `!!` / `/date` picker | ✅ | Quick picks + calendar input |
| | Configurable date format & week start | ✅ | Reformats existing pills live |
| | Overdue / today styling on pills | ✅ | |
| | Times of day ("3pm") | ❌ | Dates only; low value without reminders |
| | Reminders / recurring dates | ❌ | Needs notification backend; Workflowy doesn't do recurring either |
| **Calendar** | Month-grid calendar view | ✅ | Menu + strip's ▦ button |
| | Calendar journal (`Calendar › Year › Month › Day` nodes) | ✅ | Created on demand, kept sorted |
| | Today button (sidebar + header) | ✅ | |
| | Date-navigation strip (days / month tabs) | ✅ | Full-width, centered on current day |
| | Items dated elsewhere surface under their day | ✅ | |
| | Content indicator (dot) on populated strip days | ❌ | Cheap add if wanted |
| **Search** | Live search scoped to zoom, highlights, ancestor context | ✅ | |
| | `"phrase"`, `-not`, `OR` | ✅ | |
| | `is:` `has:` `text:` `highlight:` `changed:` `on:` `link:` `in:note:` | ✅ | |
| | Nested search (`ancestor > term`) | ✅ | |
| | Quick jump (`Ctrl+K`) | ✅ | |
| **Navigation** | Sidebar with outline tree + starred section | ✅ | |
| | Starring pages and searches (`Ctrl+Shift+8`) | ✅ | |
| | `Ctrl+'` home | ✅ | |
| | Backlinks ("Linked from") | ✅ | From any internal link (`[[ ]]`, Ctrl+K, pasted) and mirrors |
| | `[[inline linking]]` with autocomplete + create-new | ✅ | |
| | Starred-page switcher (`Ctrl+;`) | ❌ | Covered by sidebar + `Ctrl+K` |
| **Reuse & review** | Mirrors (`Alt+Shift+M`, Mirror to…) | 🟡 | Live read-only views; click opens original. Workflowy's are editable in place |
| | Move to… node picker | ✅ | |
| | Move to Today / Tomorrow / Next Week | ✅ | Date stamps |
| | Templates (save subtree, insert via `/`) | ✅ | |
| | Comments on any item | 🟡 | Flat list; Workflowy's are infinitely threaded |
| | Instant presentations | ✅ | Any node becomes slides |
| | Duplicate with optional `#copy` tag | ✅ | |
| | Created/Changed timestamps (item menu) | ✅ | |
| **Files & media** | Attach files, paste images | ✅ | Stored in `data/files/` |
| | YouTube / Shorts / Loom embeds, X link-card | ✅ | Toggleable; X card avoids the tracking widget |
| | Image thumbnail size setting | ❌ | Cosmetic |
| | Bulk "download all files" | ❌ | Per-file download works |
| **Capture** | Quick capture overlay (`Ctrl+Shift+Space`) → Inbox | ✅ | Tab indents; trailing dates become pills; markdown todos kept |
| | Capture API (`POST /api/capture?token=…`) | ✅ | Email-automation equivalent; stores plain text (no date conversion, unlike the overlay) |
| | Rich editor inside the capture box | ❌ | Deliberate: capture is a plain transcription surface |
| **Sharing** | Per-subtree secret links, view-only or editable, revocable | ✅ | Ring marks shared items; guest edits flow back live |
| | Multi-account collaboration (named users, permissions) | ❌ | Single-owner model by design |
| | Real-time co-typing (CRDT/OT) | ❌ | Last-writer-wins with additive merging |
| **Sync & data** | Cross-tab sync (BroadcastChannel) | ✅ | |
| | Live cross-device sync (SSE push) | ✅ | |
| | Offline stash & retry (localStorage) | ✅ | |
| | Service-worker shell cache | 🟡 | HTTPS only |
| | Hourly rotating backups (last 40) | ✅ | |
| | Export: text, Markdown, OPML, JSON; Print | ✅ | |
| | Import: OPML, indented text, JSON | ✅ | |
| **Appearance** | Light/dark/auto, 4 accents, 4 fonts, density, page width | ✅ | |
| | Always-show arrows, capitalize-first-word | ✅ | |
| | Smooth animations toggle | ✅ | Single off-switch for zoom + collapse motion |
| | Mobile toolbar, responsive layout | ✅ | No native apps |
| | Discoverability hints (empty-bullet placeholder, date hint) | ✅ | |
| **Security & auth** | Password login with lockout throttle | ✅ | |
| | TOTP MFA (`--gen-totp`) | ✅ | |
| | Server-side + render-side HTML sanitization | ✅ | Including docs arriving over sync |
| **API & AI** | Per-node REST API (`/api/v1`) | ✅ | CRUD, move, complete, search, tree; SSE-visible writes |
| | Self-describing endpoint index (`GET /api/v1`) | ✅ | |
| | OpenAPI spec + Swagger-style docs page | ❌ | Discussed; decided to keep as-is for now |
| | MCP server | ❌ | Declined — REST API is sufficient |
| | ✨ Ask AI (Anthropic key, server proxy) | ✅ | Results insert as sub-items |
| **Out of scope** (Workflowy parity) | Tables, Side Pane, Dashboard (Workflowy Labs) | ❌ | Sizable features; Dashboard abandoned upstream |
| | Daily email summaries / mention emails | ❌ | Needs SMTP; contradicts zero-dependency |
| | Third-party integrations (Slack, Google Calendar…) | ❌ | Capture + REST API are the integration surface |
| | Virtualized rendering for very large pages | ❌ | Full re-render is fine to a few thousand visible items |
