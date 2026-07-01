# Architecture

ZEVRA (Zero-knowledge Events Verified Realtime Architecture) is an end-to-end encrypted messaging server. The server never sees plaintext messages, passwords, or private keys.

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        Client (Browser)                       │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ SRP Auth│  │ E2EE Enc │  │ Ed25519  │  │ X25519 Key   │  │
│  │ (no pwd │  │ (AES-GCM)│  │ Sign     │  │ Exchange     │  │
│  │ to srv) │  │          │  │          │  │              │  │
│  └─────────┘  └──────────┘  └──────────┘  └──────────────┘  │
└──────────────┬───────────────────────────────┬───────────────┘
               │ HTTP (REST)                   │ WebSocket (Socket.io)
               ▼                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     NestJS Application                        │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  HTTP Pipeline                                          │ │
│  │  Helmet → CORS → RequestId → ThrottlerGuard → Pipe →   │ │
│  │  Controller → Service → Drizzle ORM → PostgreSQL        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  WebSocket Pipeline                                     │ │
│  │  SocketAuthGuard (JWT) → Gateway → Service              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │ │
│  │  │ Socket   │  │ Chat     │  │ Typing/  │              │ │
│  │  │ Gateway  │  │ Gateway  │  │ Presence │              │ │
│  │  └──────────┘  └──────────┘  └──────────┘              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Async Workers (BullMQ)                                 │ │
│  │  ┌─────────────────┐ ┌──────────────┐ ┌──────────────┐ │ │
│  │  │ message-delivery│ │ read-receipt  │ │ key-rotation │ │ │
│  │  │ (10 workers)    │ │ (5 workers)   │ │ (1 worker)   │ │ │
│  │  └─────────────────┘ └──────────────┘ └──────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────┬────────────────────────────────┬──────────────┘
               │                                │
               ▼                                ▼
┌──────────────────────┐          ┌──────────────────────────┐
│   PostgreSQL (Neon)  │          │   Redis (Redis Labs)      │
│                      │          │                            │
│  users               │          │  Sessions (10min TTL)      │
│  channels            │          │  Presence (30s TTL)        │
│  memberships         │          │  Cache (message, unread)   │
│  messages            │          │  PubSub (cross-node)       │
│  message_reads       │          │  Rate limits (sorted sets) │
│  sender_keys         │          │  Channel members (SET)     │
│  pending_messages    │          │  Pending msgs (sorted set) │
│  refresh_tokens      │          │  Typing (5s TTL)           │
│  audit_log           │          │  Read receipts (5min TTL)  │
└──────────────────────┘          │  Socket.io adapter          │
                                  └──────────────────────────┘
```

## Module Map

```
AppModule (root)
├── DatabaseModule         → PostgreSQL + Drizzle ORM (global)
├── RedisModule            → Redis client + cache/pubsub/session (global)
├── SharedModule           → RateLimit + CircuitBreaker (global)
├── CommonModule           → RequestId middleware, ExceptionFilter, Logger
├── AuthModule             → SRP-6a registration + login, JWT
├── UsersModule            → Profile CRUD, search
├── MessagesModule         → Message persistence, pagination, delete
├── ChannelsModule         → Channel CRUD, membership, typing, receipts
├── KeysModule             → Public keys, sender keys, rotation
├── AuditModule            → Audit log queries
├── ChatModule             → High-level orchestration (cache-first reads, BullMQ dispatch)
├── SocketModule           → WebSocket gateway, sessions, presence, Redis adapter
└── QueuesModule           → BullMQ workers (message-delivery, read-receipt, key-rotation)
```

## Request Lifecycle

### HTTP Request

```
Client → Helmet → CORS → RequestIdMiddleware → ThrottlerGuard
       → ValidationPipe → Controller → Service → Drizzle → PostgreSQL
       → HttpExceptionFilter (on error)
```

- `RequestIdMiddleware`: Extracts `X-Request-Id` header or generates UUID. Attached to every response.
- `ThrottlerGuard`: NestJS global rate limit (configurable per route).
- `ValidationPipe`: `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`.
- `HttpExceptionFilter`: Structured JSON error with `requestId`, `statusCode`, `message`.

### WebSocket Connection

```
Client → SocketAuthGuard (JWT verify) → SocketGateway.handleConnection()
      → IP rate limit check → Single-session enforcement
      → Register session in Redis → Set presence online
      → Subscribe to user PubSub channel → Start 30s heartbeat
      → Emit 'connected' to client
```

- `SocketAuthGuard`: Verifies JWT from `handshake.auth.token` or `Authorization` header. Rejects with `NO_TOKEN`, `TOKEN_EXPIRED`, `INVALID_TOKEN`, `USER_NOT_FOUND`.
- **Single-session**: If user already has a socket, the old one receives `forced-disconnect` and is disconnected.
- **Heartbeat**: Every 30s, renews session TTL (10min) and presence TTL (30s). If heartbeat stops, session expires and user goes offline.

### Message Send Flow

```
Client emits 'send-message'
  → ChatGateway (rate limit + 10KB size check)
  → ChatService.sendMessage()
    → [1] MessagesService.send()          (sync — Postgres)
        → Verify membership
        → Verify Ed25519 signature
        → DB Transaction: SELECT FOR UPDATE channel → next sequence → INSERT → UPDATE lastMessage
    → [2] RedisCacheService.cacheMessage() (sync — Redis LPUSH, keep last 50, 24h TTL)
    → [3] BullMQ 'message-delivery'        (async — non-blocking)
        → MessageDeliveryProcessor
          → Get channel members (Redis SET → Postgres fallback)
          → Check online status (Redis MGET)
          → Online members: SocketService.emitToUser('message:new')
          → Offline members: RedisSessionService.addPendingMessage()
          → Increment unread counts (Redis INCR)
          → broadcastToChannel (Socket.io room)
          → publishToGroup (Redis PubSub for cross-node)
```

### Message Receive Flow

```
Server emits 'message:new' to client
  → Client decrypts with X25519 shared secret
  → Client renders message
```

### Offline Message Delivery Flow

```
Client reconnects → emits 'get-pending'
  → ChatService.deliverPendingMessages()
    → RedisSessionService.getPendingMessages() (ZREVRANGE)
    → Emit 'messages:pending' to user
    → RedisSessionService.clearPendingMessages() (DEL)
```

### Read Receipt Flow

```
Client emits 'mark-read'
  → ChatGateway → ChatService.markAsRead()
    → [1] DB Transaction: verify membership + message, only advance forward
         → UPDATE membership.lastReadMessageId → INSERT messageRead
    → [2] RedisCacheService.resetUnread()
    → [3] BullMQ 'read-receipt' (async)
        → ReadReceiptProcessor
          → Cache receipt in Redis hash
          → broadcastToChannel('message:read')
          → publishToGroup (Redis PubSub for cross-node)
```

## Key Design Decisions & Tradeoffs

### 1. Drizzle ORM over Prisma

**Chosen:** Drizzle ORM  
**Rejected:** Prisma

Drizzle is lighter (no binary), has better Bun compatibility, and generates SQL you can inspect. Prisma has better type safety for raw queries and a more mature migration system, but the binary dependency and Node-only limitations made it a poor fit for this Bun-based project.

**Cost:** No type-safe `findUnique`/`findMany` helpers; raw SQL is more verbose.

### 2. Sync Persist + Async Fan-out

**Chosen:** Persist message to Postgres synchronously, then enqueue delivery via BullMQ.  
**Rejected:** Pure async (enqueue first, persist in worker)

The sync path guarantees the sender gets a confirmation with the assigned sequence number before the ACK returns. The async worker handles fan-out (online push, offline queue, unread counts, cross-node broadcast) without blocking the sender.

**Cost:** Message delivery latency is slightly higher for offline users (worker must pick up the job). Delivery is at-least-once (BullMQ retries 3x with exponential backoff), so clients must handle duplicate `message:new` events idempotently.

### 3. Redis Degraded Mode (Fail-Open)

**Chosen:** All Redis-backed features fail open (allow requests, return empty data) when Redis is unavailable.  
**Rejected:** Fail closed (reject requests when Redis is down)

If Redis goes down, rate limiting is bypassed, presence shows everyone offline, typing indicators stop, and unread counts return 0. This prevents a Redis outage from completely breaking the chat. The circuit breaker (5 failures → OPEN → 30s recovery) prevents cascading retries.

**Cost:** No rate limiting during Redis outage (potential abuse). Presence data becomes stale.

### 4. Single-Device Constraint

**Chosen:** Only one Socket.io connection per user; second connection kicks the first.  
**Rejected:** Multi-device support with separate key sync

The single-device model is the simplest session model. The Redis session mapping (`session:{userId} → socketId`) is a 1:1 relation, making `emitToUser()` a single GET + emit.

**Cost:** Users cannot be logged in on multiple devices simultaneously. Multi-device would require device registration, key synchronization, and multi-socket fan-out.

### 5. Cursor-Based Pagination over Offset

**Chosen:** `WHERE created_at < $cursor ORDER BY created_at DESC LIMIT $limit`  
**Rejected:** `OFFSET $offset LIMIT $limit`

Cursor pagination is stable under concurrent inserts — no rows are skipped or duplicated when new messages arrive between page requests. The cursor is the `createdAt` timestamp of the last returned message.

**Cost:** No "jump to page N" capability. Users can only paginate backward from the most recent message.

### 6. `KEYS` for Typing Indicators

**Chosen:** `KEYS typing:{channelId}:*` to find active typing users.  
**Rejected:** `SCAN` or a Redis SET

Typing keys have a 5-second TTL and the pattern is `typing:{channelId}:{userId}`. In practice, very few users type simultaneously in any given channel, so the key space is tiny. `KEYS` is O(N) but N is near-zero.

**Cost:** At extreme scale (thousands of concurrent typists per channel), `SCAN` would avoid momentary blocking. Not a practical concern for typical chat usage.

### 7. Soft Delete for Messages

**Chosen:** `isDeleted: true` flag, message row remains.  
**Rejected:** Hard delete with `DELETE FROM messages`

Soft delete preserves referential integrity — `sender_keys`, `message_reads`, and `pending_messages` can still join to the message row. It also preserves sequence number ordering (gaps from deleted messages don't collapse).

**Cost:** Storage grows indefinitely. "Deleted" messages are still in the database (only hidden from API responses).

### 8. Argon2id over bcrypt/scrypt

**Chosen:** Argon2id (m=65536, t=3, p=4) for KEK derivation.  
**Rejected:** bcrypt, scrypt

Argon2id is the winner of the Password Hashing Competition and is resistant to both GPU and side-channel attacks. The parameters (64MB memory, 3 iterations, 4 threads) are calibrated for server-side use.

**Cost:** Higher memory usage per login (~64MB). Not suitable for serverless environments with tight memory limits.

### 9. BullMQ over plain Redis queues

**Chosen:** BullMQ with `@nestjs/bullmq` integration.  
**Rejected:** Manual Redis list-based queues, Agenda, Bee

BullMQ provides job priorities, retries with exponential backoff, stalled job detection, rate limiting per worker, and concurrency controls out of the box. The NestJS integration (`@Processor`, `WorkerHost`) fits naturally into the module system.

**Cost:** Additional dependency. Requires a dedicated Redis connection per worker (BullMQ uses its own Redis connections, not the application's).

### 10. Separate Redis Clients for PubSub

**Chosen:** Dedicated publisher + subscriber Redis clients for `RedisPubSubService`, separate from the main application client.  
**Rejected:** Sharing the main Redis client for pub/sub

Redis pub/sub blocks the connection — a subscriber cannot issue other commands. Using separate clients ensures the main client remains available for cache/session operations while pub/sub is active.

**Cost:** 2 additional Redis connections per server instance (publisher + subscriber), on top of the main client, BullMQ connections, and Socket.io adapter connections.
