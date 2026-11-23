# Rebuild the web image on a machine that cannot run a cold build.
#
# The counterpart to `docker/local-layer.Dockerfile`, and the same three traps apply — see that file.
# What is different here is the two things the real `docker/web.Dockerfile` has to get right, both of
# which have gone wrong on this machine:
#
#   * **`API_BASE_URL_INTERNAL` is a build-time constant.** `rewrites()` bakes the proxy destination
#     into `routes-manifest.json`, so a build without it produces a container whose every API call
#     500s while curl against the API works fine. It defaults to `http://api:3001/api/v1`, which is
#     the compose service name — pass the real one if the stack renames it.
#   * **`WORKDIR` must end at `/app/apps/web`.** The runtime CMD is relative
#     (`node node_modules/next/dist/bin/next start`), and this file has to `WORKDIR /app` to build.
#     Forgetting to set it back produced a container that started, then died with MODULE_NOT_FOUND.
FROM localehub-web:latest
USER root
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN rm -rf /app/apps/web/src /app/apps/web/.next /app/packages/contracts/src /app/packages/contracts/dist
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
ARG API_BASE_URL_INTERNAL=http://api:3001/api/v1
ENV API_BASE_URL_INTERNAL=$API_BASE_URL_INTERNAL
RUN pnpm --filter @localehub/contracts build \
 && cd /app/apps/web && node node_modules/next/dist/bin/next build
RUN chown -R node:node /app
WORKDIR /app/apps/web
