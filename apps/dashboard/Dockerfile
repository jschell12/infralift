# Build context: monorepo root (needs packages/shared)
FROM node:22-slim AS builder

RUN corepack enable pnpm

# No NEXT_PUBLIC_API_URL — api.ts defaults to /api which is proxied to
# the Express backend via next.config.ts rewrites.

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/dashboard/package.json apps/dashboard/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared/
COPY apps/dashboard apps/dashboard/
COPY tsconfig.base.json ./

RUN pnpm --filter @infralift/shared build
# Where /api is proxied to. Read by next.config.ts at build time and baked
# into the rewrites, so it is a build argument, not a runtime variable.
ARG API_BACKEND_URL
ENV API_BACKEND_URL=$API_BACKEND_URL
RUN pnpm --filter @infralift/dashboard build

# --- Runtime ---
FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static apps/dashboard/.next/static/

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "apps/dashboard/server.js"]
