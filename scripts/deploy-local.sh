#!/usr/bin/env bash
# Rebuild and redeploy api / worker / mcp-remote on this machine, and **prove it happened**.
#
# Why this exists rather than a documented one-liner: the one-liner failed quietly three times in one
# afternoon, each time looking like success.
#
#   1. `docker buildx build … | tail -2` — the pipeline's exit status is `tail`'s, so a failed build
#      fell through to the deploy step and the deploy then found the container already running the
#      old image and did nothing. The log ended with a build-details link either way.
#   2. The image had reached Docker's layer-depth limit, so every layer build failed at a `COPY`.
#      (Flattened automatically below.)
#   3. After flattening, `docker import` had dropped the image's CMD, so compose refused to recreate
#      with "no command specified" — and a half-recreated stack left containers holding the names.
#
# So: `set -e` and no pipes around the build, flatten when the depth is too high, and **check the
# built image contains what was just changed** before touching the running stack. Pass the marker as
# an argument — e.g. `scripts/deploy-local.sh 'resolveGlossary:/app/apps/mcp-remote/dist/server.js'` —
# and a build that compiled nothing new fails here instead of on the next user request.
#
# Usage: scripts/deploy-local.sh [--web] [<needle>:<path-inside-image>] [services…]
set -euo pipefail
cd "$(dirname "$0")/.."

WEB=0
if [ "${1:-}" = "--web" ]; then WEB=1; shift; fi
MARKER="${1:-}"
if [ -n "$MARKER" ]; then shift; fi
SERVICES=("$@")

if [ "$WEB" = 1 ]; then
  # The web image is its own thing: a Next build, and `API_BASE_URL_INTERNAL` is baked in at build
  # time (see docker/local-layer-web.Dockerfile).
  IMAGE=localehub-web
  DOCKERFILE=docker/local-layer-web.Dockerfile
  LABEL=localehub-web
  SERVICES=("${SERVICES[@]:-web}")
else
  IMAGE=localehub-api
  DOCKERFILE=docker/local-layer.Dockerfile
  LABEL=localehub-api
  if [ ${#SERVICES[@]} -eq 0 ]; then SERVICES=(api worker mcp-remote); fi
fi
DEPTH_LIMIT=100   # Docker's own limit is 125; flatten well before it so the build has room

layers() { docker image inspect "$IMAGE:latest" --format '{{len .RootFS.Layers}}' 2>/dev/null || echo 0; }

echo "== current image: $(layers) layers"
if [ "$(layers)" -ge "$DEPTH_LIMIT" ]; then
  echo "== flattening (layer builds cannot go deeper without hitting Docker's limit)"
  docker rm -f localehub-flatten >/dev/null 2>&1 || true
  docker create --name localehub-flatten "$IMAGE:latest" >/dev/null
  docker export localehub-flatten | docker import - "$IMAGE:base" >/dev/null
  docker rm localehub-flatten >/dev/null
  echo "== flattened into $IMAGE:base ($(docker image inspect "$IMAGE:base" --format '{{len .RootFS.Layers}}') layer)"
fi

echo "== building"
docker buildx build --network host -f "$DOCKERFILE" -t "$IMAGE:next" .

if [ -n "$MARKER" ]; then
  NEEDLE="${MARKER%%:*}"; IN_IMAGE="${MARKER#*:}"
  echo "== the build contains what we just changed? ($NEEDLE in $IN_IMAGE)"
  docker run --rm --entrypoint sh "$IMAGE:next" -c "grep -q '$NEEDLE' '$IN_IMAGE'"
fi

echo "== tagging and deploying"
if [ "$WEB" = 1 ]; then
  docker tag "$IMAGE:next" "$LABEL"
else
  for service in api worker mcp-remote; do docker tag "$IMAGE:next" "localehub-$service"; done
fi
# Containers left half-created by an earlier failed recreate hold the names and block this one.
for stale in $(docker ps -a --filter 'name=_localehub-' --format '{{.Names}}'); do
  echo "   removing stale container $stale"
  docker rm -f "$stale" >/dev/null
done
./scripts/up.sh up -d --no-build "${SERVICES[@]}"

for service in "${SERVICES[@]}"; do
  until docker inspect "localehub-$service-1" --format '{{.State.Running}}' 2>/dev/null | grep -q true; do sleep 1; done
  started=$(docker inspect "localehub-$service-1" --format '{{.State.StartedAt}}')
  image=$(docker inspect "localehub-$service-1" --format '{{.Image}}' | cut -c1-19)
  echo "== $service running, started $started, image $image"
done

until curl -sf http://localhost:3001/api/v1/health >/dev/null; do sleep 1; done
echo "== api healthy"
if [ "$WEB" = 1 ]; then
  until curl -sf -o /dev/null http://localhost:3000/; do sleep 1; done
  echo "== web serving"
fi

# Every build retags the image and leaves the previous one untagged on disk, and nothing collects them:
# at 1.7 GB a build, one afternoon of deploys reached the Docker VM's 58 GB. The symptom was not a build
# failure — it was Postgres, which PANIC-loops on "could not write to file pg_logical/…: No space left on
# device" during checkpoint and never reaches a consistent state, so every API call failed while
# `docker ps` still showed the database "healthy".
docker image prune -f >/dev/null
echo "== dangling images pruned ($(docker system df --format '{{.Size}}' 2>/dev/null | head -1) in images)"
