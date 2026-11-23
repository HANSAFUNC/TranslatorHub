# Rebuild the api/worker/mcp-remote image on a machine that cannot run a cold build.
#
# The real thing is `docker/api.Dockerfile`. A cold build of it needs the registry (≈25 MB of pi SDK
# plus everything else) and this machine's network drops that often enough to be unusable, so what
# actually happens here is a **layer build**: copy the current sources onto an image that already has
# `node_modules` and a generated Prisma client, and compile.
#
# Three things about that are easy to get wrong, and all three have bitten:
#
#   * **The base image accumulates layers.** Every layer build adds a few, and Docker refuses to
#     prepare a layer past the depth limit — `max depth exceeded`, on a *copy* of all things. When it
#     happens, `scripts/deploy-local.sh` flattens the current image into `localehub-api:base` first
#     (`docker export` | `docker import`), which is why this file starts from that tag.
#   * **Flattening drops the image config.** `docker import` keeps the filesystem and forgets ENV,
#     ENTRYPOINT and CMD, so they are restored below. Without the CMD, compose fails with
#     "no command specified" — api and worker rely on the image's CMD; mcp-remote overrides it.
#   * **`COPY` merges.** Anything moved or deleted in the sources survives in `/app`, and the build
#     then compiles a tree that no longer exists. Hence the `rm -rf` before the copies.
FROM localehub-api:base
USER root
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN rm -rf /app/apps/api/src /app/apps/api/dist \
           /app/apps/worker/src /app/apps/worker/dist \
           /app/apps/mcp-remote/src /app/apps/mcp-remote/dist \
           /app/apps/cli/src /app/apps/cli/dist \
           /app/apps/e2e-demo/src /app/apps/e2e-demo/dist \
           /app/packages/*/src /app/packages/*/dist
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# `apps/mcp-remote` declared bullmq/ioredis after this image's install layer was built, and a layer
# build never runs `pnpm install`, so the symlinks are copied in from the app that does have them.
RUN cp -a /app/apps/api/node_modules/bullmq /app/apps/api/node_modules/ioredis /app/apps/mcp-remote/node_modules/
RUN pnpm --filter './packages/**' build \
 && pnpm --filter @localehub/api --filter @localehub/worker --filter @localehub/mcp-remote \
      --filter @localehub/cli --filter @localehub/local-sync build
RUN chown -R node:node /app
USER node
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
