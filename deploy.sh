#!/usr/bin/env bash
# Pull the latest code and rebuild the container, stamping the build with the current commit SHA
# (read by the app for its version/update check). Run manually, or triggered by the in-app admin
# "Update" button via the rhizome-update.path systemd unit (which watches DATA_DIR/.update-request).
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only
GIT_COMMIT="$(git rev-parse HEAD)" docker compose up -d --build
echo "Deployed $(git rev-parse --short HEAD)"
