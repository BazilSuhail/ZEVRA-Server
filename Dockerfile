# Stage 1: Install dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 2: Build
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Stage 3: Production
FROM oven/bun:1-alpine
RUN apk add --no-cache curl
RUN addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
USER app
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl -f http://localhost:5000/health || exit 1
CMD ["bun", "run", "dist/main.js"]
