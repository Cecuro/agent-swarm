FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY runtime ./runtime
COPY test ./test
RUN npm test \
    && npm run typecheck \
    && npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 swarm \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash swarm

WORKDIR /app
COPY --chown=swarm:swarm package.json package-lock.json ./
COPY --chown=swarm:swarm --from=build /app/node_modules ./node_modules
COPY --chown=swarm:swarm --from=build /app/dist ./dist
COPY --chown=swarm:swarm runtime ./dist/runtime
COPY --chown=swarm:swarm experiments ./experiments
COPY docker/entrypoint.sh /usr/local/bin/agent-swarm-entrypoint

RUN chmod 0755 /usr/local/bin/agent-swarm-entrypoint \
    && mkdir -p /data /contexts \
    && chown swarm:swarm /data /contexts

USER swarm
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agent-swarm-entrypoint"]
CMD ["node", "dist/src/cli.js", "--help"]
