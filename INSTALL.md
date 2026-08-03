# Installing & operating Rhizome

This guide covers running your own Rhizome instance and — at the end — wiring up the
**in-app self-update** button in the admin panel. For the feature tour and the full
environment-variable reference, see [README.md](README.md).

---

## Requirements

- **Node 22+** (the outline is stored with Node's built-in `node:sqlite`), *or*
- **Docker** + the Docker Compose plugin.

There is no `npm install` and no build step for the app itself.

---

## Option A — run it directly with Node

```sh
git clone https://github.com/ituri/rhizome.git
cd rhizome
node server.js
```

Open **http://localhost:3000**. Data is written to `./data` (override with `DATA_DIR`).

## Option B — run it with Docker Compose (recommended for servers)

```sh
git clone https://github.com/ituri/rhizome.git
cd rhizome
docker compose up -d --build
```

The bundled `docker-compose.yml` is a minimal starting point. For a real deployment,
copy it and set your own port binding, a named volume, and the environment below. A
typical locked-down service looks like:

```yaml
services:
  rhizome:
    build:
      context: .
      args:
        GIT_COMMIT: ${GIT_COMMIT:-unknown}   # stamps the build for the update check (see below)
    container_name: rhizome
    restart: unless-stopped
    ports:
      - "127.0.0.1:3011:3000"                # bind to localhost; terminate TLS in a reverse proxy
    volumes:
      - rhizome-data:/data
    environment:
      DATA_DIR: /data
      RHIZOME_ADMIN_PASSWORD: change-me      # creates the admin account + requires login
      RHIZOME_INVITE_CODE: some-invite       # gate self-registration
      RHIZOME_ENCRYPTION_KEY: <32+ chars>    # optional: encrypt backups + uploads at rest

volumes:
  rhizome-data:
```

> **Bind to `127.0.0.1`.** Docker publishes ports *past* the host firewall. Bind the
> container to localhost and let your reverse proxy (Caddy, nginx, Traefik) handle HTTPS
> and the public port.

---

## Configuration

Rhizome runs with zero configuration; everything is an environment variable. The full
table lives in the [README](README.md#️-configuration-environment-variables). The
essentials for an internet-facing instance:

| Variable | Purpose |
|---|---|
| `RHIZOME_ADMIN_PASSWORD` | Bootstraps the admin account and requires login. **Set this if exposed.** |
| `RHIZOME_INVITE_CODE` | Required for self-registration. |
| `RHIZOME_ENCRYPTION_KEY` | Encrypts backups and uploaded files at rest. |
| `DATA_DIR` | Where the outline, accounts, attachments and backups live (default `./data`). |

Two variables are specific to the update check (both optional):

| Variable | Default | Purpose |
|---|---|---|
| `RHIZOME_REPO` | `ituri/rhizome` | `owner/repo` on GitHub used to look up the latest commit. |
| `RHIZOME_BRANCH` | `main` | Branch to compare against. |

---

## Optional: semantic search (runs entirely on your machine)

Normal search matches words. Semantic search matches *meaning* — "how do I back up my
data" finds a note that only ever says "Verschlüsselung bei kompromittiertem Server".
It is off unless you point Rhizome at an embedding endpoint.

Rhizome deliberately does **not** call a hosted AI API for this: your notes are the last
thing you want to ship to a third party. Instead you run a small embedding model next to
the app — a ~640 MB CPU container, no GPU, fine on a 2-core VPS.

### 1. Add the embedder to your Compose file

```yaml
services:
  rhizome:
    # …your existing service…
    environment:
      DATA_DIR: /data
      RHIZOME_EMBEDDINGS_URL: http://embedder:8080
      # Qwen3-Embedding wants an instruction prefix on the QUERY side only:
      RHIZOME_EMBED_QUERY_PREFIX: "Instruct: Given a search query, retrieve relevant notes\nQuery: "

  embedder:
    image: ghcr.io/ggml-org/llama.cpp:server
    container_name: rhizome-embedder
    restart: unless-stopped
    command: >
      --hf-repo Qwen/Qwen3-Embedding-0.6B-GGUF
      --hf-file Qwen3-Embedding-0.6B-Q8_0.gguf
      --embedding -c 4096 -ub 1024
      --host 0.0.0.0 --port 8080 --threads 2
    volumes:
      - embedder-models:/root/.cache     # keeps the model across restarts
    mem_limit: 2g
    # NO ports: — llama.cpp has no auth; reachable only inside the Compose network

volumes:
  rhizome-data:
  embedder-models:
```

```sh
docker compose up -d
```

The first start downloads the model (~640 MB) — watch `docker compose logs -f embedder`
until it says `model loaded`. Indexing then starts by itself: Rhizome embeds every node
with enough text (~4s after each change, and once when a graph is first opened after a
restart) and stores the vectors in that graph's SQLite. Only changed nodes are re-embedded.

### 2. Use it

In the web UI, prefix a query with `~`:

```
~wo übernachten wir in norwegen
```

Admin → Server status shows a **Semantic search** row (`ready · N vectors · <model> ·
local, no data leaves this host`), so you can see the index growing.

### Tuning

| Variable | Default | Purpose |
|---|---|---|
| `RHIZOME_EMBEDDINGS_URL` | — | OpenAI-shaped `/v1/embeddings` endpoint. **Unset = feature off.** |
| `RHIZOME_EMBED_QUERY_PREFIX` | — | Prompt prefix for queries (model-specific; see above for Qwen3). |
| `RHIZOME_EMBED_DOC_PREFIX` | — | Prompt prefix for documents (e5-style models want `passage: `). |
| `RHIZOME_EMBED_BATCH` | `16` | Texts per embedding request. |
| `RHIZOME_EMBED_MAX_CHARS` | `1000` | Truncation per node — must stay inside the model's context. |
| `RHIZOME_SEMANTIC_MIN_SCORE` | `0.4` | Absolute cosine floor. Cosine always ranks *something* first; this is what makes an unanswerable query return nothing instead of noise. |
| `RHIZOME_SEMANTIC_REL_SCORE` | `0.75` | Relative floor — drop hits far below the best one. |

**If results look random,** check the score floor first: run
`GET /api/g/<graph>/semantic?q=<question>` and look at the scores. With
Qwen3-Embedding-0.6B, real answers land around 0.50–0.57 and noise around 0.30–0.34, so
`0.4` separates them. A different model has a different scale — recalibrate rather than
guess.

Other models work as long as they speak the OpenAI embeddings API (Ollama, TEI, a hosted
provider). Note that swapping models invalidates the index: delete the `embeddings` table
in each `graphs/<id>/outline.db`, or just let it re-embed by touching the notes.

---

## Where your data lives

Everything is under `DATA_DIR` (`/data` in Docker): per-graph SQLite databases under
`graphs/<id>/`, hourly rotating backups under `graphs/<id>/backups/`, `accounts.db`, and
uploaded `files/`. Back up that one directory (or the Docker volume) and you've backed up
everything.

---

## Enabling in-app updates

The admin panel (**Account → Admin panel → Updates**) can check whether a newer version is
available and, with one click, pull it and rebuild — **if** the host is set up for it. This
is opt-in because it lets an admin trigger a host-level rebuild.

### How it works

The container is deliberately isolated (unprivileged user, no `git`, no Docker socket), so
it **cannot update itself**. Instead:

1. The running commit is **baked into the image at build time** (`Dockerfile` `ARG
   GIT_COMMIT`, passed by Compose). The server exposes it; `GET /api/admin/version` compares
   it against the latest commit from the GitHub API.
2. When you click **Update now**, `POST /api/admin/update` just writes a flag file,
   `DATA_DIR/.update-request`, inside the data volume. Both endpoints are admin-only.
3. A **systemd path unit on the host** watches that file and runs a fixed deploy script
   (`git pull` + rebuild). The web app never gets Docker or host access — it only signals
   intent, and only your script runs.

### Prerequisites

- The instance runs from a **git checkout on the host** (so `git pull` works).
- Compose builds from that checkout with the `GIT_COMMIT` build arg (see the compose
  example above — the `build.args.GIT_COMMIT` line is what stamps the version).
- The user the deploy runs as can use Docker (in the `docker` group) and owns the checkout.

### 1. Deploy with the version stamp

Always deploy via the bundled [`deploy.sh`](deploy.sh) so the commit stamp is set:

```sh
./deploy.sh
# equivalently: git pull --ff-only && GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
```

A build without `GIT_COMMIT` still runs, but the panel shows *"no version stamp"* and hides
the update button.

### 2. Find the flag-file path

The flag is written inside the data volume. Resolve the host path once:

```sh
docker volume inspect <project>_rhizome-data -f '{{ .Mountpoint }}'
# → e.g. /var/lib/docker/volumes/rhizome_rhizome-data/_data
```

The watched file is that path + `/.update-request`.

### 3. Install the systemd units

Create `/etc/systemd/system/rhizome-update.service` (adjust `User` and the checkout path):

```ini
[Unit]
Description=Rhizome in-app self-update (git pull + docker rebuild)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=youruser
WorkingDirectory=/path/to/rhizome
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/path/to/rhizome/deploy.sh
```

Create `/etc/systemd/system/rhizome-update.path` (use the path from step 2):

```ini
[Unit]
Description=Watch for Rhizome in-app update requests

[Path]
PathModified=/var/lib/docker/volumes/rhizome_rhizome-data/_data/.update-request
Unit=rhizome-update.service

[Install]
WantedBy=multi-user.target
```

Enable the watcher:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now rhizome-update.path
```

Test the chain end-to-end (this triggers a real rebuild):

```sh
# simulate the button, then watch the deploy run
docker exec rhizome sh -c 'echo probe > "$DATA_DIR/.update-request"'
journalctl -u rhizome-update.service -f
```

### Notes & gotchas

- **Let the container create the flag.** It's written by the app's (unprivileged) user. If
  you ever create it as `root`, the app can't overwrite it afterwards (`EACCES`) — delete it
  and let the app recreate it: `sudo rm -f <mountpoint>/.update-request`.
- The deploy script does **not** delete the flag (it lives in a root-owned volume dir the
  service user can't reach). That's fine: `PathModified` fires again on the next write.
- A failed `docker compose up --build` leaves the **old** container running, so a broken
  build won't take the site down.
- To disable in-app updates, `sudo systemctl disable --now rhizome-update.path`. The button
  will still write the flag, but nothing will act on it.

---

## Updating manually

Without (or instead of) the button, from the host checkout:

```sh
./deploy.sh
```

---

## Running the tests

The test suites drive a headless Chromium via Puppeteer and spin up throwaway servers.

```sh
CHROME=/usr/bin/chromium npm run test:update      # the self-update endpoints
CHROME=/usr/bin/chromium npm run test:stress      # typing/data-loss stress suite
```

See `package.json` for the full list of `test:*` scripts.
