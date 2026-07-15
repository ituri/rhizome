# Rhizome HTTP API

Reference for building clients (e.g. the iOS app). Kept in sync as the API changes —
update this file whenever an endpoint is added, changed or removed.

- Base URL (prod): `https://rhizome.syslinx.org`; (local dev): `http://localhost:3000`
- All JSON bodies are `Content-Type: application/json`; responses are JSON unless noted.
- **Auth** is a session cookie `rz_session` (HttpOnly, SameSite=Lax, ~90 days), set by
  `/api/login` and `/api/register`. Send it back on every authenticated request.
- With **no accounts yet** (fresh install) the instance is open; once any account exists,
  authenticated endpoints require a valid session.

> **Phase 2 (in progress, branch `phase2-graphs`):** the document endpoints move under a
> per-graph prefix `/api/g/:graphId/...` (doc, ops, events, version, search, shares, upload,
> capture, ai). Account-level endpoints below stay unprefixed. This section will be updated
> when that lands.

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

## Document (session required)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/doc` | — | `{version, doc}` — the full document (`doc.nodes` map + `doc.root`). |
| GET | `/api/version` | — | `{version}` |
| PUT/POST | `/api/doc` | `{doc, baseVersion?, device?}` | `{version}`. 409 + `{version,doc}` if `baseVersion` is stale. Whole-doc save. |
| POST | `/api/ops` | `{ops:[…], device}` | `{version, applied}`. Delta sync — the preferred save path. Ops are idempotent by `op.id`. |
| GET | `/api/events` | — | **SSE** stream. Each message: `{version, ops?, origin}`. On an op-batch commit, `ops` is the applied batch tagged with the originating `device` (ignore your own echo); otherwise refetch `/api/doc`. Heartbeat `:hb` every 25s. |
| GET | `/api/search?q=` | — | `{ids:[…]}` — FTS5-backed, up to 500. |

**Data model:** one flat node map. `doc.nodes[id] = {id, text, note, done, collapsed, children:[ids], format?, mirror?, c, m, …}`; the tree is the `children` id-arrays; `doc.root` is the root id. Pages are children of root; the calendar subtree (`cal:'day'` nodes with `cd:'YYYY-MM-DD'`) holds daily notes.

## Files, capture, AI (session required unless noted)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/upload?name=<file>` | raw bytes | `{url:"/files/…", name, size}` (max 32 MB). |
| GET | `/files/<name>` | — | the uploaded file (private unless inside a shared subtree). |
| POST | `/api/capture?token=<CAPTURE_TOKEN>` | `{text}` or raw text | `{ok, captured}`. Auth via the capture token **or** a session. Lands under today's journal → `Inbox`. Indentation (tabs / 2 spaces) nests. |
| POST | `/api/ai` | `{prompt, context?}` | `{text}` (only if `ANTHROPIC_API_KEY` is set). |

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
