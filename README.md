# Tendril 🌱

A self-hostable infinite outliner — a Workflowy-class tool that runs entirely on your own machine.
One process, zero dependencies, one JSON file of data.

## Run it

```sh
node server.js
# → http://localhost:3000
```

That's it. No `npm install`, no build step. Requires Node 18+.

### With Docker

```sh
docker compose up -d
```

### Options (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `./data` | Where the outline, attachments + backups live |
| `TENDRIL_PASSWORD` | *(unset)* | If set, the app requires this password |
| `TENDRIL_TOTP_SECRET` | *(unset)* | If set (base32), login also requires a 6-digit TOTP code. Generate with `node server.js --gen-totp` |
| `TENDRIL_CAPTURE_TOKEN` | *(unset)* | Enables `POST /api/capture?token=…` for sending items to your Inbox from anywhere (email automations, iOS Shortcuts, curl) |
| `TENDRIL_AGENT_TOKEN` | *(unset)* | Enables the per-node REST API at `/api/v1` for scripts and AI agents (`Authorization: Bearer …` or `?token=…`) |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables the in-app ✨ Ask AI assistant |
| `TENDRIL_AI_MODEL` | `claude-opus-4-8` | Claude model used by Ask AI |

If you expose Tendril to the internet, set `TENDRIL_PASSWORD` (and ideally TOTP) and put it
behind HTTPS — any reverse proxy (Caddy, nginx, Traefik) works; it's plain HTTP on one port.

## Features

**Outlining** — infinite nesting; zoom into any bullet (click it or `Alt+→`/`Alt+.`) with breadcrumbs, editable page titles, and working browser back/forward; expand/collapse (`Ctrl+↑↓`, expand/collapse-all); notes on any item (`Shift+Enter`); complete & hide completed (`Ctrl+Enter`, `Ctrl+O`); drag & drop with depth control and touch support; multi-item selection (`Ctrl+A` twice) with bulk indent/move/complete/delete; full split/merge editing at the caret; smart multi-line paste; trash with 30-day retention and restore; undo/redo for everything.

**Blocks & formatting** — headings (H1–H3), quotes, code blocks, dividers, paragraphs, **to-do checkboxes**, **numbered lists** (auto-renumber), and **kanban boards** (full-page when zoomed, with +add-card / +add-column); markdown shortcuts (`# `, `## `, `> `, `[] `, `1. `, `---`, ```` ``` ````); a **slash command menu** (`/`); a floating selection toolbar with bold/italic/underline/strikethrough/inline code/links and **8 text colors + 8 highlights**; `Ctrl+K` links selected text to a URL or to another item; **markdown-aware paste**; **Sort A–Z / Z–A**.

**Tags, dates & search** — `#tags`/`@mentions` with **autocomplete**, click to filter (Shift+click adds to the filter); **dates** via `!!` or `/date` with natural-language quick picks, overdue/today styling, and a **calendar view**; search with `"exact phrases"`, `-exclusion`, `OR`, `is:complete|todo|mirror|shared`, `has:note|date|file|comment|link`, `text:bold|code|color`, `highlight:yellow`, `changed:today|7d`, `on:<date>`, and nested `ancestor > term` queries.

**Navigation** — collapsible **sidebar** with the outline tree and **starred pages/searches** (`Ctrl+Shift+8`); `Ctrl+K` jump-anywhere; `Ctrl+'` home; **backlinks** ("Linked from") on every page; deep links to any item.

**Reuse & review** — **mirrors** (`Alt+Shift+M` or *Mirror to…* a chosen node) that stay in sync with their original; **Move to…** any node via a picker; **Move to Today / Tomorrow / Next Week** date stamps; **templates** (save any subtree, insert via `/`); **comments** on any item; **instant presentations** (any node becomes slides); duplicate with optional `#copy` tag; per-item Created/Changed timestamps.

**Files & media** — attach files or **paste images** straight onto items (stored in your data dir); embeds for YouTube, **YouTube Shorts**, **Loom**, and **X/Twitter** link-cards (toggleable, no third-party tracking scripts).

**Capture** — quick capture overlay (`Ctrl+Shift+Space`) into an Inbox node, plus a token-protected **capture API** for email-to-outline style automations:
```sh
curl -X POST "https://your-host/api/capture?token=…" -d "call mom tomorrow"
```

**Sharing** — share any subtree via secret link, **view-only or editable**, revocable, with a blue ring marking shared items; guests see/edit just that subtree and edits flow back live.

**Sync & data** — instant cross-tab sync, **live cross-device sync (SSE)**, offline changes kept and retried (localStorage + service worker shell cache); hourly rotating backups (last 40); export to plain text, **Markdown**, OPML, JSON; import OPML/text/JSON.

**Polish** — light/dark/auto themes, 4 accent colors, 4 font choices, cozy/compact density, reading/full-width pages, configurable date format & week-start, always-show-arrows, capitalize-first-word, rich (emoji) tags; **Print** (`Ctrl+P`); optional ✨ AI assistant (your own Anthropic key); password login with optional **TOTP MFA**; mobile toolbar.

Press `Ctrl+/` in the app for the full keyboard reference.

## Node API (for scripts & AI agents)

Set `TENDRIL_AGENT_TOKEN` to unlock a small per-node REST API at `/api/v1`. It's
designed for an AI agent collaborating with you in real time: it reads context in
one call, writes surgically by node ID (so it doesn't clobber what you're typing),
and every write broadcasts over SSE — so the agent's edits appear in your open tab
instantly. Authenticate with `Authorization: Bearer <token>` or `?token=<token>`.

| Method & path | Does |
|---|---|
| `GET /api/v1/doc` | The whole document (agent context) |
| `GET /api/v1/search?q=&limit=` | Matching nodes with their ancestor path |
| `GET /api/v1/nodes/:id` | One node (`?tree=1&depth=N` for the subtree) |
| `GET /api/v1/nodes/:id/children` | A node's direct children |
| `POST /api/v1/nodes` | Create `{parent, text, note?, done?, format?, index?}` |
| `PATCH /api/v1/nodes/:id` | Update `{text?, note?, done?, collapsed?, format?}` |
| `POST /api/v1/nodes/:id/complete` | `{done?}` (defaults to `true`) |
| `POST /api/v1/nodes/:id/move` | `{parent, index?}` |
| `DELETE /api/v1/nodes/:id` | Delete the subtree (recoverable from Trash) |

```sh
# create a node, then complete it
curl -s -X POST localhost:3000/api/v1/nodes \
  -H "Authorization: Bearer $TENDRIL_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"parent":"root","text":"Drafted by the agent"}'
```

`text` accepts the same inline markup the app uses (`<b>`, `<i>`, `<a href>`, `#tags`);
it's sanitized server-side and again on render. `GET` responses include a derived
`plain` field so an agent never has to parse HTML. Notes: writes use the same
last-writer-wins model as the rest of the app — per-node writes keep the conflict
surface tiny, but it is not a real-time CRDT.

## Where your data lives

Everything is in `data/outline.json` (attachments in `data/files/`, backups in `data/backups/`).
Copy the `data` folder and you've backed up everything.

## Notes on collaboration

Sharing gives others scoped view/edit access to subtrees, and all devices sync live —
but conflict resolution is last-writer-wins (with additive merging), not a real-time CRDT.
For a single person across devices plus occasional shared lists, that's the sweet spot;
it is not Google-Docs-style simultaneous co-typing.
