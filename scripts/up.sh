#!/usr/bin/env bash
# Bring the stack up (or run any compose command) with the workspace's environment file.
#
# `localehub.env` is not `.env` — this workspace forbids that name — so Docker Compose never picks it
# up on its own. Without `--env-file`, every `${VAR:-default}` in compose.yaml silently resolves to
# its default, and the containers come up looking fine with the wrong configuration: a stack that had
# CORS origins, an AI provider and storage settings lost all three to one `docker compose up -d` of a
# single service, and nothing in the output said so. The symptom showed up much later, in a browser,
# as "Origin ... is not allowed to call this API".
#
# Usage: scripts/up.sh up -d --no-build api
#        scripts/up.sh logs -f worker
#        scripts/up.sh ps
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f localehub.env ]; then
  echo "localehub.env is missing — copy env.example to localehub.env first." >&2
  exit 1
fi

exec docker compose --env-file localehub.env "$@"
