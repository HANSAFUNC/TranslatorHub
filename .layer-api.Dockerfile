FROM localehub-api:base
USER root
# `docker import` keeps the filesystem and drops the image config, so everything the real
# docker/api.Dockerfile set has to be restored here — PATH for pnpm, and the entrypoint, without
# which `docker compose up` fails with "no command specified" (api and worker use the image's CMD;
# mcp-remote overrides it in compose.yaml).
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
# `apps/mcp-remote` declared bullmq/ioredis after this image's install layer was built.
RUN cp -a /app/apps/api/node_modules/bullmq /app/apps/api/node_modules/ioredis /app/apps/mcp-remote/node_modules/
RUN pnpm --filter './packages/**' build \
 && pnpm --filter @localehub/api --filter @localehub/worker --filter @localehub/mcp-remote \
      --filter @localehub/cli --filter @localehub/local-sync build
RUN chown -R node:node /app
USER node
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
