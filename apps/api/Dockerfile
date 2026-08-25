# Build context: monorepo root (needs packages/shared)
FROM node:22-slim AS builder

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared/
COPY apps/api/src apps/api/src/
COPY apps/api/tsconfig.json apps/api/
COPY tsconfig.base.json ./

RUN pnpm --filter @infralift/shared build
RUN cd apps/api && npx prisma generate
RUN pnpm --filter @infralift/api build

# --- Runtime ---
FROM node:22-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the full workspace - pnpm's content-addressable store and Prisma's
# generated engine binaries need their internal symlink structure intact.
COPY --from=builder /app ./

ENV NODE_ENV=production
EXPOSE 4000

CMD ["sh", "-c", "cd apps/api && npx prisma migrate deploy && node dist/server.js"]
