FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable 2>/dev/null || npm install -g pnpm@10.30.3
RUN npm install -g pnpm@10.30.3 || true
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/core/db/migrations ./src/core/db/migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./
RUN mkdir -p .data
EXPOSE 3000
CMD ["pnpm", "start"]
