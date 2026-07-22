# Rhizome HTTP API

Reference for building clients (e.g. the iOS app). Kept in sync as the API changes —
update this file whenever an endpoint is added, changed or removed.

- Base URL (prod): `https://rhizome.syslinx.org`; (local dev): `http://localhost:3000`
- All JSON bodies are `Content-Type: application/json`; responses are JSON unless noted.
- **Auth** is a session cookie `rz_session` (HttpOnly, SameSite=Lax, ~90 days), set by
  `/api/login` and `/api/register`. Send it back on every authenticated request.
- With **no accounts yet** (fresh install) the instance is open; once any account exists,
  authenticated endpoints require a valid session.

> **Multi-graph:** every user owns one or more isolated graphs. Document endpoints are
> **scoped per graph** under `/api/g/:graphId/...`; the client picks the active graph from
> `/api/me` (`graphs[0]` by default, remembered in localStorage). Account-level endpoints
> (login, graphs, keys, admin) stay unprefixed. Files and share links are global.

## Auth & account

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/register` | `{username, password, invite}` | `{user:{id,username}}` + sets cookie. 403 wrong invite, 400 bad username/short password, 409 taken. |
| POST | `/api/login` | `{username, password, code?}` | `{user:{id,username}}` + sets cookie. 401 wrong. `code` only if TOTP enabled. |
| POST | `/api/logout` | — | clears the session cookie. |
| GET | `/api/me` | — | `{user:{id,username,isAdmin}|null, graphs:[{id,name,role}], authRequired, inviteRequired, ai}` |
| POST | `/api/account/password` | `{current, next}` | 200 ok. 403 wrong current, 400 `next` < 6 chars. Session required. |
| GET | `/api/auth` | — | legacy: `{required, totp, ok, ai}` |

Login is rate-limited per IP (8 failed attempts → 10 min lockout) **and** per account:
after the admin-configured threshold of consecutive failures an account is locked and further
logins return **423** (even with the right password) until it auto-unlocks (`auto` mode) or an
admin clears it (`manual` mode). Every attempt is written to a login-events audit log. See
`/api/admin/security` below.

## Graphs, members & API keys (session required)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/graphs` | `{name}` | `{id, name, role}` — create a graph you own. |
| PATCH | `/api/graphs/:id` | `{name}` | rename (owner only). |
| DELETE | `/api/graphs/:id` | — | delete a graph + its data/shares (owner only; not your last one). |
| GET | `/api/graphs/:id/members` | — | `{members:[{id,username,role}], isOwner}` |
| POST | `/api/graphs/:id/members` | `{username}` | add an editor by username (owner only). |
| DELETE | `/api/graphs/:id/members/:userId` | — | remove a member (owner removes anyone; a member can leave). |
| GET | `/api/keys` | — | `{keys:[{id,name,graphId,graphName,scope,created,lastUsed}]}` |
| POST | `/api/keys` | `{name, graphId, scope}` | `{id, key}` — **the plaintext `rzk_…` key is returned once**. `scope` = `read`\|`write`. |
| DELETE | `/api/keys/:id` | — | revoke a key. |

**API-key auth:** pass a key as `Authorization: Bearer rzk_…` or `?token=rzk_…`. It grants access
to its bound graph only, at its scope (`read` → GET, `write` → all). Sessions take precedence.

## Document — scoped per graph, at `/api/g/:graphId/…` (member or valid key required)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/g/:g/doc` | — | `{version, doc}` — the full document (`doc.nodes` map + `doc.root`). |
| GET | `/api/g/:g/version` | — | `{version}` |
| PUT/POST | `/api/g/:g/doc` | `{doc, baseVersion?, device?}` | `{version}`. 409 + `{version,doc}` if `baseVersion` is stale. |
| POST | `/api/g/:g/ops` | `{ops:[…], device}` | `{version, applied}`. Delta sync — the preferred save path. Idempotent by `op.id`. |
| GET | `/api/g/:g/events` | — | **SSE** stream. Message: `{version, ops?, origin}`; ignore your own `origin` echo, else replay `ops` or refetch. Heartbeat `:hb` every 25s. |
| GET | `/api/g/:g/search?q=` | — | `{ids:[…]}` — FTS5-backed, up to 500. |
| GET/POST/DELETE | `/api/g/:g/shares[/:token]` | `{nodeId, mode}` | share a subtree by secret link (see below). |
| POST | `/api/g/:g/capture` | `{text}` or raw | `{ok, captured}` — capture into this graph. |
| GET | `/api/g/:g/history/:pageId` | — | `{versions:[{id, ts, device}]}` — page version snapshots, newest first. |
| GET | `/api/g/:g/history/:pageId/:versionId` | — | `{doc}` — the page subtree snapshot at that version. |
| POST | `/api/g/:g/history/:pageId/:versionId/restore` | `{device?, deviceName?}` | `{version}` — restore the page to that snapshot (recorded as a new version). |

Snapshots are taken server-side, debounced ~45s after a page's edits settle (one version per
edit-session per page, newest 60 kept). Each carries the editing device's name — clients send it
as `deviceName` in the `ops`/`doc` bodies (a page also counts a journal day as its own page).

Access is denied with **403** for a non-member (or a key bound to another graph), **401** when unauthenticated.

**Data model:** one flat node map. `doc.nodes[id] = {id, text, note, done, collapsed, children:[ids], format?, mirror?, geo?, c, m, …}`; the tree is the `children` id-arrays; `doc.root` is the root id. Pages are children of root; the calendar subtree (`cal:'day'` nodes with `cd:'YYYY-MM-DD'`) holds daily notes. A location page may carry `geo:"raw"` — the user tagged it coordinates-only, so clients must not reverse-geocode/retitle it.

## Files, capture, AI (session required unless noted)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/upload?name=<file>` | raw bytes | `{url:"/files/…", name, size}` (max 32 MB). |
| GET | `/files/<name>` | — | the uploaded file (private unless inside a shared subtree). |
| POST | `/api/capture?token=<rzk_…>` | `{text, bullet?, html?}` or raw text | `{ok, captured}`. Auth via a session or a **write-scoped API key** (`rzk_…`). Session → your first graph; API key → its graph. Lands under today's journal → the `bullet` bullet (default `Inbox`, find-or-created); indentation (tabs / 2 spaces) nests. `html:true` stores `text` as one **sanitized** inline-HTML line (e.g. a titled `<a href>` link) instead of splitting/escaping it. |
| POST | `/api/ai` | `{prompt, context?}` | `{text}` (only if `ANTHROPIC_API_KEY` is set). |
| GET | `/api/geocode?lat=&lon=` | — | `{address}` — reverse-geocode a coordinate to a short address (for location pages). Server-side + cached; geocoder configurable via `RHIZOME_GEOCODER_URL` (default public Nominatim). |

## Admin (admin session required)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/admin/users` | — | `{users:[{id,username,isAdmin,lastLogin,created,graphs,notes,bytes}]}` |
| DELETE | `/api/admin/users/:id` | — | delete a user + their owned graphs (not yourself / the last admin). |
| GET | `/api/admin/invite` | — | `{code}` — the effective invite code. |
| PUT | `/api/admin/invite` | `{code}` | set/rotate the invite code (empty → fall back to the env default). |
| GET | `/api/admin/security` | — | `{policy:{threshold,mode,minutes}, locked:[{id,username,until}], events:[{username,ip,ok,ts}]}` — lockout policy, currently-locked accounts, recent login events. |
| PUT | `/api/admin/security` | `{threshold, mode, minutes}` | set the lockout policy. `mode` = `auto` (unlock after `minutes`) \| `manual` (admin only). |
| POST | `/api/admin/users/:id/unlock` | — | clear a locked account's failure count + lock. |

Example capture (the `r` shell command) — authenticate with a **write-scoped API
key** (`rzk_…`, created under Account → API keys) or a logged-in session:
```sh
curl -sS -X POST 'https://rhizome.syslinx.org/api/capture?token=rzk_…' --data-raw '15:10 buy milk'
```

## Sharing (public read of a shared subtree)

| Method | Path | Result |
|---|---|---|
| GET/POST/DELETE | `/api/shares` | list / create `{nodeId, mode:'view'\|'edit'}` → `{token, url:"/s/<token>"}` / revoke. Session required. |
| GET | `/api/share/:token/doc` | `{version, doc, mode, root}` — the shared subtree, no cookie needed. |
| PUT/POST | `/api/share/:token/doc` | edit-mode share save (`{doc, baseVersion?}`). |
| GET | `/s/:token` | the shared outline UI. |

## Node REST API `/api/v1` (agent token or API key)

Auth: `Authorization: Bearer <token>` or `?token=`. The token is either the instance
`RHIZOME_AGENT_TOKEN` (→ the admin's default graph, write scope) or a per-graph API key
`rzk_…` (→ its bound graph; a `read` key may only GET, a `write` key may call everything —
non-GET with a read key → **403**). A logged-in session also works (default graph).
`GET /api/v1/doc`, `GET /api/v1/version`, `GET /api/v1/events` (**SSE** — `{version}` on
connect and on every change, heartbeat `:hb`), `POST /api/v1/capture` (`{text}` or raw text
→ today's journal, under the `bullet` bullet (default `Inbox`)), `GET /api/v1/journal/today` (find-or-create today's day node, returns
it + its children; write scope), `GET /api/v1/search?q=&limit=`,
`GET /api/v1/nodes/:id` (`?tree=1&depth=N`), `GET /api/v1/nodes/:id/children`,
`POST /api/v1/nodes {parent,text,note,done,format,index}`,
`PATCH /api/v1/nodes/:id {text,note,done,collapsed,format}`,
`POST /api/v1/nodes/:id/complete {done}`, `POST /api/v1/nodes/:id/move {parent,index}`,
`DELETE /api/v1/nodes/:id`.

## MCP server `/mcp` (Model Context Protocol)

A hosted [MCP](https://modelcontextprotocol.io) endpoint so an MCP client (Claude Desktop,
Claude Code, claude.ai connectors) can read **and** edit one graph. JSON-RPC 2.0 over the
Streamable-HTTP transport, implemented natively (no SDK — the core server stays zero-dependency).

- **Endpoint:** `POST /mcp` (a single JSON-RPC request or a batch array). Stateless — no
  `Mcp-Session-Id`. `GET`/SSE is not offered (no server-initiated messages); `OPTIONS` is
  answered for CORS.
- **Auth:** `Authorization: Bearer rzk_…` — a per-graph API key (Account → API keys). The key's
  scope gates writes: a `read` key may only call the read tools; a `write` key may call all of
  them. The instance agent token (`RHIZOME_AGENT_TOKEN`) and a fresh open instance also work
  (→ the default graph, write scope). No/invalid credential → **401**.
- **Methods:** `initialize`, `ping`, `tools/list`, `tools/call`, empty `resources/list` /
  `prompts/list`; notifications (`notifications/initialized`, …) get `202` with no body.

**Tools** (all operate on the key's graph):

| Tool | Scope | Arguments | Does |
|---|---|---|---|
| `search` | read | `{query, limit?}` | full-text search → `{id, plain, path, done}[]` |
| `list_pages` | read | — | top-level pages (children of root) |
| `get_node` | read | `{id, tree?, depth?}` | one node, or its subtree with `tree:true` |
| `create_node` | write | `{parent?, text, note?, done?, format?, index?}` | create a node (text is inline HTML-ish; `[[Page]]`/`#tag` work) |
| `update_node` | write | `{id, text?, note?, done?, format?, collapsed?}` | edit in place (only the fields you pass) |
| `move_node` | write | `{id, parent, index?}` | reparent a node + its subtree |
| `delete_node` | write | `{id}` | delete a node + subtree → `{deleted}` |
| `capture` | write | `{text}` | quick-capture into today's journal Inbox |

Tool failures (unknown node, read-only key, move into own subtree) come back as a normal
`tools/call` result with `isError:true` and a text message, not a transport error.

Connect from Claude Code:
```sh
claude mcp add --transport http rhizome https://rhizome.syslinx.org/mcp \
  --header "Authorization: Bearer rzk_…"
```

## Server environment (ops)

`PORT`, `HOST`, `DATA_DIR`, `RHIZOME_ADMIN_USER` (default `phil`), `RHIZOME_ADMIN_PASSWORD`
(bootstraps the admin on first run), `RHIZOME_INVITE_CODE` (registration gate),
`RHIZOME_AGENT_TOKEN`, `RHIZOME_TOTP_SECRET`, `ANTHROPIC_API_KEY`,
`RHIZOME_AI_MODEL`.

**Encryption at rest** — set `RHIZOME_ENCRYPTION_KEY` to a passphrase to AES-256-GCM-encrypt
the artifacts that leave the machine: **backups** and **uploaded files**. The live SQLite DB
stays plaintext (FTS5 needs a plaintext index; `node:sqlite` can't open an encrypted file), so
search/capture/sharing/AI keep working. Keep the key **out of `DATA_DIR`** so backups don't ship
it. Turning it on is backward-compatible — existing plaintext backups/files stay readable, new
writes are encrypted. Restore a backup with `RHIZOME_ENCRYPTION_KEY=… node cryptobox.js <in> <out>`.
