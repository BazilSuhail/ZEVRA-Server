# Security

## Authentication

### SRP-6a (Zero-Knowledge Password Proof)

- Password never transmitted or stored
- Server stores only `srp_verifier` (g^x mod N) — cannot reverse to password
- 2-step login: `login/start` (get salt + B) → `login/finish` (send A + M1, receive M2)
- SRP state stored in-memory with 5-minute TTL (prevents replay)

### JWT Access Tokens

- Signed with `JWT_SECRET` (HS256)
- 15-minute expiry
- Payload: `{ sub: userId }`
- Used for both HTTP (`Authorization: Bearer`) and WebSocket (`handshake.auth.token`) auth

### Refresh Tokens

- Opaque random hex (64 characters)
- Stored in `refresh_tokens` table
- 7-day expiry
- **Rotation:** On refresh, old token is deleted and new pair issued
- **Logout:** All refresh tokens for the user are deleted

### Password Hashing (Argon2id)

Used for KEK derivation (not password storage):
- Type: Argon2id (hybrid of Argon2i and Argon2d)
- Memory: 65536 KB (64 MB)
- Time: 3 iterations
- Parallelism: 4 threads
- Hash length: 32 bytes
- Salt: Random 32 bytes per key

---

## Rate Limiting

### Application-Level (Redis Sliding Window)

Per-route limits using Redis sorted sets:

| Endpoint | Window | Max Requests | Key Pattern |
|----------|--------|-------------|-------------|
| `send-message` (WebSocket) | 1 s | 500 | `send:{userId}` |
| `typing:start/stop` (WebSocket) | 1 s | 200 | `typing:{userId}` |
| `get-messages` (WebSocket) | 1 s | 1000 | `getmsg:{userId}` |
| Connection per IP (WebSocket) | 60 s | 2000 | `ip:{ip}` |
| `POST /api/auth/register` | 5 min | 5 | Via NestJS ThrottlerGuard |
| `POST /api/auth/login/*` | 1 min | 10 | Via NestJS ThrottlerGuard |
| `POST /api/auth/refresh` | 1 min | 20 | Via NestJS ThrottlerGuard |

**Fail-open:** If Redis is unavailable, all requests are allowed (no rate limiting).

### Infrastructure-Level (NestJS ThrottlerGuard)

Global `ThrottlerGuard` applied to all HTTP routes. Configurable per controller/method.

---

## Circuit Breaker

Protects against cascading failures when downstream services (Postgres, Redis) are unhealthy.

| State | Behavior |
|-------|----------|
| CLOSED | Normal operation. Failures counted. |
| OPEN | After 5 consecutive failures. Returns fallback immediately. |
| HALF_OPEN | After 30 seconds. Tests one request. |

**Transitions:**
- CLOSED → OPEN: 5 consecutive failures
- OPEN → HALF_OPEN: 30 seconds elapsed
- HALF_OPEN → CLOSED: Test request succeeds
- HALF_OPEN → OPEN: Test request fails

---

## HTTP Security

### Helmet

Applied globally via `app.use(helmet())`. Sets security headers:
- Content-Security-Policy
- X-Frame-Options
- X-Content-Type-Options
- Strict-Transport-Security (HSTS)
- And others (default Helmet config)

### CORS

```typescript
app.enableCors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  allowedHeaders: 'Content-Type, Authorization',
  credentials: true,
});
```

### Validation

```typescript
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,            // Strip unknown properties
    forbidNonWhitelisted: true, // Throw on unknown properties
    transform: true,            // Auto-transform payloads to DTOs
  }),
);
```

### Exception Filter

All HTTP errors return structured JSON:
```json
{
  "statusCode": 403,
  "message": "Not a member of this channel",
  "error": "Forbidden",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## WebSocket Security

### Authentication

`SocketAuthGuard` verifies JWT during handshake:
- Token from `handshake.auth.token` or `Authorization` header
- Rejects: `NO_TOKEN`, `TOKEN_EXPIRED`, `INVALID_TOKEN`, `USER_NOT_FOUND`
- Invalid connections are disconnected immediately

### Single-Session Enforcement

Only one Socket.io connection per user:
- On connect, if user already has a session, old socket receives `forced-disconnect` and is kicked
- Prevents session hijacking and multi-device abuse

### IP Rate Limiting

Connections per IP tracked in-memory (`ipConnections` Map):
- 2000 connections per minute per IP
- Exceeding IPs are rejected with `RATE_LIMITED` error

### Message Size Limiting

- `send-message` events: 10KB max (`Buffer.byteLength` check)
- Oversized messages rejected with `PAYLOAD_TOO_LARGE`

---

## Data Protection

### Encryption at Rest

- Private keys: AES-256-GCM (encrypted with Argon2id-derived KEK)
- Message content: AES-256-GCM (encrypted client-side)
- Database: Neon PostgreSQL (encrypted at rest by provider)

### Encryption in Transit

- HTTPS enforced (Neon requires `sslmode=require`)
- WebSocket: `wss://` in production
- Redis: TLS connection to Redis Labs

### Soft Delete

Messages are soft-deleted (`isDeleted: true`), not hard-deleted. This preserves referential integrity but means deleted data remains in the database. Acceptable for E2EE architecture where the data is ciphertext.

---

## Audit Logging

Every security-relevant event is logged to `audit_log`:

| Action | When |
|--------|------|
| `REGISTER` | New user created |
| `LOGIN` | Successful SRP login |
| `LOGIN_FAILED` | Invalid SRP proof |
| `KEY_ROTATE` | Key material updated |

Each entry includes: `action`, `userId`, `ipAddress`, `details` (JSONB), `createdAt`.

---

## Graceful Shutdown

```typescript
// main.ts
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await app.close();  // NestJS lifecycle hooks
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => { /* log */ });
process.on('uncaughtException', (err) => { process.exit(1); });
```

On shutdown:
- NestJS calls `onModuleDestroy()` on all providers
- Redis connections are closed (`RedisPubSubService.onModuleDestroy()`)
- BullMQ workers are stopped
- HTTP server stops accepting new connections

---

## Environment Security

The `.env` file contains:
- `DATABASE_URL` — Neon PostgreSQL connection string (with password)
- `JWT_SECRET` — Secret for JWT signing
- `REDIS_URL` — Redis Cloud connection string (with password)

**Never commit `.env` to version control.** Use environment variables in production.
