# End-to-end encrypted graphs — design & security spec (draft)

Status: **design sketch, not implemented.** Open decisions are marked **[DECIDE]**.

Goal: an opt-in **encrypted graph** type where the server stores only ciphertext of the
*content*, and only clients holding the graph password can read/write it — Roam's model, adapted
to Rhizome's op-sync.

---

## 1. Why this is tractable here

Rhizome's sync is already **content-agnostic**: the op algebra (`opsdoc.js`) treats a node's
`text`/`note` as opaque strings (`n[k] = op.patch[k]`), and convergence is driven by ids, `ord`
and HLCs — never by content. So if the client encrypts content fields *before* they enter an op
patch (or a whole-doc PUT), the entire sync/merge/versioning machinery works **unchanged**; the
server stores and LWW-merges ciphertext.

The in-memory client doc is always **plaintext** (decrypted on load), so rendering, backlinks,
`{{query}}`, tag filtering and client-side search keep working. Encryption lives only at the
**network + local-cache boundary**.

## 2. Threat model

**Protects:** content confidentiality against the server operator, the host/disk, database dumps,
backups, and network. Decryption needs the password, which never leaves the client.

**Does NOT hide (metadata leakage — same as Roam):** graph *structure* (tree shape, node count),
per-field ciphertext *length* (≈ plaintext length), timestamps (`c`/`m`), and structural flags
(`format`, `done`, `collapsed`, calendar `cal/cd/cy/cm`). An observer can infer activity patterns
and rough sizes, not content. **[DECIDE]** whether to pad ciphertext lengths (adds complexity;
default: no).

Also out of scope: a compromised *client* (malware/root on your device sees the key in memory).

## 3. What is encrypted

Encrypt the **content** fields; keep **structure/flags** plaintext so server-side structural
convergence still works.

| Field | Encrypted? | Why |
|---|---|---|
| `text`, `note` | **yes** | the actual content |
| `comments[].text` | **yes** | content |
| attachment file bytes + display name (`files`) | **yes (Phase 2)** | content; see §8 |
| `children`, `ord`, `id`, `parent` | no | structure — server needs it to merge move/insert |
| `format`, `done`, `collapsed`, `mirror`, `geo` | no | small enums/flags; needed for structure/render |
| `cal`, `cd`, `cy`, `cm` | no | calendar skeleton (day exists ≠ its content) |
| `c`, `m` | no | timestamps (server-set) |

Ciphertext envelope for a field: `"" + base64url(iv ‖ ciphertext‖tag)` (a leading ``
marks "encrypted" so mixed/legacy values are unambiguous and never double-encrypted).

## 4. Keys & crypto

Zero-dependency: **WebCrypto (SubtleCrypto)** in the browser, **CryptoKit** on iOS. No crypto lib.

- **Cipher:** AES-256-**GCM**, random 96-bit IV per encryption (authenticated → tamper-evident).
- **Envelope-key design** (so password changes don't re-encrypt the whole graph):
  1. Random **DEK** (data-encryption key, AES-256) generated once when the graph is created.
  2. **KEK** (key-encryption key) derived from the password: **PBKDF2-HMAC-SHA-256**, per-graph random
     salt, ≥ 600k iterations. **[DECIDE]** PBKDF2 (zero-dep) vs **Argon2id** (stronger vs GPU
     cracking, needs a small wasm module — a dependency).
  3. `wrappedDEK = AES-GCM(KEK, DEK)`. Stored server-side. Wrong password → GCM auth fails →
     serves as the password **verifier** (no separate verifier needed).
- **Per-graph crypto metadata** stored on the server (opaque to it):
  `{ v:1, kdf:{algo,salt,iters}, wrappedDEK, ivFmt }`.
- **Key lifetime:** DEK held in memory for the session; **[DECIDE]** whether to cache the wrapped
  DEK + a device-unlock (biometric/passphrase) for convenience, or require the password each open
  (Roam-style).

## 5. Recovery **[DECIDE]**

- **(a) None** — Roam model: lose the password, lose the graph. Simplest, riskiest.
- **(b) Optional recovery key (recommended)** — at creation, generate a random recovery key, show
  it **once**, and store a second wrap `wrappedDEK_recovery = AES-GCM(recoveryKEK, DEK)`. Never sent
  to the server as plaintext. Restores access without weakening E2E.
- **(c) Escrow** — rejected (defeats E2E).

## 6. Client architecture

A thin **crypto boundary** module, e.g. `public/crypto.js` (+ iOS `Crypto.swift`):

- **Unlock:** prompt password → derive KEK → unwrap DEK → keep DEK in memory. Cache nothing
  sensitive unencrypted.
- **Outbound** (before `POST /ops` / `PUT /doc`): for each op, encrypt `patch.text`/`patch.note`
  (and `data.text`/`data.note`); same for a full-doc PUT.
- **Inbound** (`GET /doc`, SSE ops): decrypt those fields into the in-memory doc.
- **Local cache (IndexedDB):** store **ciphertext** (else plaintext leaks to disk). Offline boot
  requires unlock. **[DECIDE]** accept "no offline until unlocked".
- Everything above the boundary (editor, search `searchNodes`, backlinks) sees plaintext and is
  untouched.

## 7. Server changes

Storage/sync are unchanged (opaque strings). The server must (a) know a graph is encrypted and
(b) refuse or skip everything that needs plaintext.

- **Schema:** `graphs.encrypted INTEGER`, plus a `graph_crypto(graph_id, meta JSON)` row (§4).
- **FTS:** skip populating `nodes_fts` for encrypted graphs (indexing ciphertext is useless and
  wasteful); `GET /api/g/:g/search` → `409 encrypted` (client searches locally).
- **Gate these on encrypted graphs** (they require server plaintext) → `409 encrypted`:
  `/api/capture`, `/api/g/:g/capture`, `/api/v1/*`, `/mcp`, `/api/ai`, and share **creation**
  (`/api/g/:g/shares`). The Firefox clipper / share extension / MCP simply don't work on an
  encrypted graph.
- **Untouched & still working:** `/ops`, `/doc`, `/events` (SSE), version history (server stores
  *encrypted* snapshots; the client decrypts + diffs), `/api/geocode` (coords only).

## 8. Attachments (Phase 2)

`/api/upload` stores raw bytes at `/files/<hash>`. For a real E2E graph these must be encrypted
client-side before upload (AES-GCM under a per-file key wrapped by the DEK; the node stores the
wrapped key + IV). Until then: **[DECIDE]** disallow attachments on encrypted graphs, or accept
that file bytes are unencrypted (a leak). Recommend: disallow in Phase 1, encrypt in Phase 2.

## 9. Coexistence & migration

- Encrypted vs normal graphs live side by side; only new graphs (or an explicit one-time
  **"encrypt this graph"** client action that re-writes every node's content via ops) are encrypted.
- Sharing an encrypted subtree to a non-key-holder is impossible by design. **[DECIDE, Phase 2]** a
  "share with key in the URL `#fragment`" mode (fragment never reaches the server) for opt-in
  link-sharing that stays E2E.

## 10. Phasing

- **Phase 1 (web-only MVP):** graph flag + crypto metadata; `crypto.js` boundary; encrypt
  `text`/`note`; ciphertext IndexedDB; client search; gate server features; recovery key. No
  attachments.
- **Phase 2:** iOS (CryptoKit), encrypted attachments, key-in-fragment sharing.
- **Phase 3:** revisit extensions/MCP (stay disabled, or a client-side bridge).

## 11. Security checklist (for implementation review)

- No plaintext to server logs, FTS, or the `serverPlain`/`apiSearch` paths (skip on encrypted graphs).
- Fresh random IV per field encryption; never reuse. Consider DEK rotation if a graph exceeds ~2³²
  field-writes (unlikely).
- KDF cost tuned (≥ 600k PBKDF2 iters or Argon2id) so `wrappedDEK` isn't cheaply brute-forced.
- GCM auth (tag) verified on every decrypt; a failure = wrong key or tampering → surface, don't
  silently drop.
- Password change re-wraps the DEK only (no bulk re-encryption).
- Backups: encrypted-graph ciphertext in backups is fine (and double-encrypted if
  `RHIZOME_ENCRYPTION_KEY` is set).

## 12. Open decisions (need your call before build)

1. **Recovery:** none (Roam) vs optional recovery key *(recommended)*.
2. **KDF:** PBKDF2 (zero-dep) vs Argon2id (stronger, +wasm dep).
3. **Scope/order:** web-only first *(recommended)* vs web + iOS + attachments together.
4. **Attachments in Phase 1:** disallow *(recommended)* vs allow-but-unencrypted.
5. **Metadata:** accept structure/length/timing leakage *(default)* vs pad lengths.
6. **Offline before unlock:** accept "locked until password" *(default)*.
