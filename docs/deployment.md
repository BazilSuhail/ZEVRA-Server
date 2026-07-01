# Deployment

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Neon](https://neon.tech) PostgreSQL account
- [Redis Cloud](https://redis.com/redis-enterprise-cloud) instance

## Environment Variables

Create `.env` in the project root:

```env
# Server
PORT=3000
NODE_ENV=development

# Database (Neon PostgreSQL)
DATABASE_URL="postgresql://user:password@host/database?sslmode=require"

# JWT Authentication
JWT_SECRET=your-strong-random-secret-min-32-chars
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Redis Cloud
REDIS_URL="redis://default:password@host:port"

# CORS (optional, defaults to *)
CORS_ORIGIN=http://localhost:3000

# Argon2id parameters (optional, defaults shown)
ARGON2ID_MEM=65536
ARGON2ID_TIME=3
ARGON2ID_PARALLELISM=4
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP server port |
| `DATABASE_URL` | Yes | | Neon PostgreSQL connection string (pooler, port 5432) |
| `JWT_SECRET` | Yes | | Secret key for JWT signing (min 32 chars) |
| `JWT_EXPIRES_IN` | No | `15m` | Access token expiry |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Refresh token expiry |
| `REDIS_URL` | Yes | | Redis Cloud connection string |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin |
| `NODE_ENV` | No | `development` | Environment mode |

---

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Neon and Redis Cloud credentials
```

### 3. Push Database Schema

```bash
bunx drizzle-kit push
```

This creates all 9 tables in your Neon database. No manual SQL required.

### 4. Run Development Server

```bash
bun run start:dev
```

Server runs at `http://localhost:3000`.

---

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `start:dev` | `bun --watch src/main.ts` | Development with hot reload |
| `start:debug` | `bunx --bun tsx watch src/main.ts` | Debug mode |
| `build` | `bun run tsc` | Compile TypeScript |
| `start` | `bun run dist/main.js` | Production |
| `start:prod` | `bun run dist/main.js` | Production (alias) |

---

## Production Build

```bash
bun run build
bun run start
```

The build compiles TypeScript to `dist/` using `tsc`.

---

## Health Check

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "healthy": true,
  "degraded": false,
  "timestamp": "2026-08-27T23:00:00.000Z",
  "checks": {
    "database": "up",
    "redis": "up"
  }
}
```

- `healthy: true` — both Postgres and Redis are reachable
- `healthy: false, degraded: true` — one service is down but server is running
- `healthy: false, degraded: false` — server is failing

---

## Graceful Shutdown

The server handles shutdown signals:

| Signal | Behavior |
|--------|----------|
| `SIGTERM` | Graceful shutdown (Kubernetes/Docker) |
| `SIGINT` | Graceful shutdown (Ctrl+C) |

On shutdown:
1. Stops accepting new HTTP connections
2. Drains in-flight requests
3. Calls `onModuleDestroy()` on all NestJS providers
4. Closes Redis connections
5. Stops BullMQ workers
6. Exits with code 0

Unhandled exceptions cause `process.exit(1)`. Unhandled rejections are logged but don't crash the process.

---

## Architecture for Production

```
                    ┌─────────────┐
                    │ Load Balancer│
                    │ (optional)   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌─────────┐ ┌─────────┐ ┌─────────┐
         │ NestJS  │ │ NestJS  │ │ NestJS  │
         │ Node 1  │ │ Node 2  │ │ Node 3  │
         └────┬────┘ └────┬────┘ └────┬────┘
              │            │            │
              └────────────┼────────────┘
                           │
              ┌────────────┼────────────┐
              ▼                         ▼
     ┌──────────────┐         ┌──────────────┐
     │ PostgreSQL   │         │ Redis        │
     │ (Neon)       │         │ (Redis Labs) │
     └──────────────┘         └──────────────┘
```

**Multi-node considerations:**
- Socket.io Redis adapter synchronizes rooms across nodes
- Redis PubSub handles cross-node message fan-out
- BullMQ workers can run on any node (Redis coordinates)
- Sessions stored in Redis (shared across nodes)
- Presence stored in Redis (shared across nodes)

---

## Neon PostgreSQL

### Connection

Use the **pooler** connection string (port 5432), not the direct connection:

```
postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/database?sslmode=require
```

The `sslmode=require` parameter is mandatory — Neon requires SSL.

### Schema Management

```bash
# Push schema changes (dev)
bunx drizzle-kit push

# Generate migration file
bunx drizzle-kit generate

# Pull schema from database
bunx drizzle-kit pull
```

---

## Redis Cloud

### Connection

Standard Redis URL format:
```
redis://default:password@host:port
```

### Used For

- Session management (10-min TTL)
- Presence tracking (30s TTL)
- Message caching (24h TTL)
- Unread counts (7-day TTL)
- Typing indicators (5s TTL)
- Read receipts (5-min TTL)
- Rate limiting (sorted sets)
- Channel membership denormalization
- Pending message queue (7-day TTL)
- Socket.io multi-node adapter
- BullMQ job queues

---

## Testing

```bash
bunx jest --no-coverage
```

9 test suites, 116 tests covering:
- Socket authentication guard
- Redis session/cache services
- Rate limiting
- Circuit breaker
- Request ID middleware
- Chat gateway handlers
- Channel service logic
- Edge cases
