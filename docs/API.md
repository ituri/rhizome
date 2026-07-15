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

Login is rate-limited per IP (8 failed attempts → 10 min lockout).

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

Access is denied with **403** for a non-member (or a key bound to another graph), **401** when unauthenticated.

**Data model:** one flat node map. `doc.nodes[id] = {id, text, note, done, collapsed, children:[ids], format?, mirror?, c, m, …}`; the tree is the `children` id-arrays; `doc.root` is the root id. Pages are children of root; the calendar subtree (`cal:'day'` nodes with `cd:'YYYY-MM-DD'`) holds daily notes.

## Files, capture, AI (session required unless noted)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/upload?name=<file>` | raw bytes | `{url:"/files/…", name, size}` (max 32 MB). |
| GET | `/files/<name>` | — | the uploaded file (private unless inside a shared subtree). |
| POST | `/api/capture?token=<token>` | `{text}` or raw text | `{ok, captured}`. Auth via a session, the global capture token, or a **write API key** (`rzk_…`). Session → your first graph; API key → its graph; global token → the admin graph. Lands under today's journal → `Inbox`; indentation (tabs / 2 spaces) nests. |
| POST | `/api/ai` | `{prompt, context?}` | `{text}` (only if `ANTHROPIC_API_KEY` is set). |

## Admin (admin session required)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/admin/users` | — | `{users:[{id,username,isAdmin,lastLogin,created,graphs,notes,bytes}]}` |
| DELETE | `/api/admin/users/:id` | — | delete a user + their owned graphs (not yourself / the last admin). |
| GET | `/api/admin/invite` | — | `{code}` — the effective invite code. |
| PUT | `/api/admin/invite` | `{code}` | set/rotate the invite code (empty → fall back to the env default). |

Example capture (the `r` shell command):
```sh
curl -sS -X POST 'https://rhizome.syslinx.org/api/capture?token=<CAPTURE_TOKEN>' --data-raw '15:10 buy milk'
```

## Sharing (public read of a shared subtree)

| Method | Path | Result |
|---|---|---|
| GET/POST/DELETE | `/api/shares` | list / create `{nodeId, mode:'view'\|'edit'}` → `{token, url:"/s/<token>"}` / revoke. Session required. |
| GET | `/api/share/:token/doc` | `{version, doc, mode, root}` — the shared subtree, no cookie needed. |
| PUT/POST | `/api/share/:token/doc` | edit-mode share save (`{doc, baseVersion?}`). |
| GET | `/s/:token` | the shared outline UI. |

## Node REST API `/api/v1` (agent token)

Enabled when `RHIZOME_AGENT_TOKEN` is set. Auth: `Authorization: Bearer <token>` or `?token=`.
`GET /api/v1/doc`, `GET /api/v1/version`, `GET /api/v1/search?q=&limit=`,
`GET /api/v1/nodes/:id` (`?tree=1&depth=N`), `GET /api/v1/nodes/:id/children`,
`POST /api/v1/nodes {parent,text,note,done,format,index}`,
`PATCH /api/v1/nodes/:id {text,note,done,collapsed,format}`,
`POST /api/v1/nodes/:id/complete {done}`, `POST /api/v1/nodes/:id/move {parent,index}`,
`DELETE /api/v1/nodes/:id`.

## Server environment (ops)

`PORT`, `HOST`, `DATA_DIR`, `RHIZOME_ADMIN_USER` (default `phil`), `RHIZOME_ADMIN_PASSWORD`
(bootstraps the admin on first run), `RHIZOME_INVITE_CODE` (registration gate),
`RHIZOME_CAPTURE_TOKEN`, `RHIZOME_AGENT_TOKEN`, `RHIZOME_TOTP_SECRET`, `ANTHROPIC_API_KEY`,
`RHIZOME_AI_MODEL`.
