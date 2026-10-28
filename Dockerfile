# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# AI BRAIN
#
# NOTE: this image has not been built on the machine where the project was
# developed, which has no Docker installed. It is written against the
# documented behaviour of each tool and reviewed, but `docker compose up` has
# not been executed. See docs/self-hosting.md. If it fails, please open an
# issue — the non-Docker path is the one that was verified end to end.
# ---------------------------------------------------------------------------

# Node 22.6+ is required: node:sqlite and TypeScript type stripping both need it.
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json              apps/web/
COPY packages/core/package.json         packages/core/
COPY tools/cli/package.json             tools/cli/
COPY tools/mcp-server/package.json      tools/mcp-server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build -----------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
# The build must not need a real secret or a real database.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# --- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV AI_BRAIN_DB=/data/brain.db

COPY --from=build /app/node_modules            ./node_modules
COPY --from=build /app/apps/web/node_modules   ./apps/web/node_modules
COPY --from=build /app/apps/web/.next          ./apps/web/.next
COPY --from=build /app/apps/web/public         ./apps/web/public
COPY --from=build /app/apps/web/package.json   ./apps/web/
COPY --from=build /app/apps/web/next.config.mjs ./apps/web/
COPY --from=build /app/packages                ./packages
COPY --from=build /app/tools                   ./tools
COPY --from=build /app/package.json            ./
COPY --from=build /app/pnpm-workspace.yaml     ./

# The database lives on a volume, owned by the unprivileged node user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
