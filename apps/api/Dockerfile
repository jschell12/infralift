# Build context: monorepo root (needs packages/shared)
FROM node:22-slim AS builder

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

WORKDIR /app

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared packages/shared/
COPY --from=builder /app/apps/api/dist apps/api/dist/
COPY --from=builder /app/apps/api/prisma apps/api/prisma/
COPY --from=builder /app/apps/api/node_modules apps/api/node_modules/
COPY --from=builder /app/apps/api/package.json apps/api/

ENV NODE_ENV=production
EXPOSE 4000

CMD ["sh", "-c", "cd apps/api && npx prisma migrate deploy && node dist/server.js"]
