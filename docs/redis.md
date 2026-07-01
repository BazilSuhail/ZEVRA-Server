# Redis

Redis serves 8 distinct roles in ZEVRA. All backed by a single Redis Cloud instance (Redis Labs).

## Key Naming Convention

```
{role}:{identifier}
```

Examples: `session:uuid`, `presence:uuid`, `cache:messages:uuid`, `typing:channelId:userId`

---

## 1. Session Management

Bidirectional userId ↔ socketId mapping. Used for single-session enforcement and `emitToUser()`.

| Key | Value | TTL | Operation |
|-----|-------|-----|-----------|
| `session:{userId}` | socketId | 10 min | `SET` + `EXPIRE` via pipeline |
| `socket:{socketId}` | userId | 10 min | `SET` + `EXPIRE` via pipeline |

**Operations:**
- `registerSession(userId, socketId)` — pipeline: `SETEX session:{userId} 600 socketId`, `SETEX socket:{socketId} 600 userId`
- `getSession(userId)` — `GET session:{userId}`
- `getUserIdBySocket(socketId)` — `GET socket:{socketId}`
- `removeSession(userId, socketId)` — pipeline: `DEL session:{userId}`, `DEL socket:{socketId}`
- `renewSession(userId, socketId)` — pipeline: `EXPIRE session:{userId} 600`, `EXPIRE socket:{socketId} 600`

**Tradeoff:** 10-minute TTL means a dead client's session lingers for up to 10 minutes. The heartbeat (every 30s) keeps it alive; if heartbeat stops, session naturally expires.

---

## 2. Presence Tracking

Online/offline status with automatic expiry.

| Key | Value | TTL |
|-----|-------|-----|
| `presence:{userId}` | `"online"` | 30 s |

**Operations:**
- `setOnline(userId)` — `SETEX presence:{userId} 30 "online"`
- `setOffline(userId)` — `DEL presence:{userId}`
- `isOnline(userId)` — `GET presence:{userId}` → check if `"online"`
- `getOnlineUsers(userIds[])` — `MGET presence:{id1} presence:{id2} ...` → filter for `"online"`

**Tradeoff:** 30-second TTL means presence expires quickly if heartbeat stops. This is intentional — it detects network partitions faster than session expiry. The heartbeat renews both session (10min) and presence (30s) simultaneously.

---

## 3. Message Cache

Recently messages per channel, used for cache-first reads.

| Key | Type | TTL | Max Items |
|-----|------|-----|-----------|
| `cache:messages:{channelId}` | List | 24 h | 50 |

**Operations:**
- `cacheMessage(channelId, message)` — `LPUSH` + `LTRIM` (keep newest 50) + `EXPIRE 86400`
- `getRecentMessages(channelId, limit)` — `LRANGE 0 limit-1`
- `invalidateMessages(channelId)` — `DEL`

**Tradeoff:** `LPUSH` + `LTRIM` is atomic-ish (not in a transaction) but race conditions only cause slight over-counting, which is acceptable for a cache. The 24-hour TTL ensures stale data is eventually evicted.

---

## 4. Unread Counts

Per-user, per-channel unread message counters.

| Key | Type | TTL |
|-----|------|-----|
| `cache:unread:{userId}:{channelId}` | String (integer) | 7 days |

**Operations:**
- `incrementUnread(userId, channelId)` — `INCR` + `EXPIRE 604800`
- `getUnreadCount(userId, channelId)` — `GET`
- `getUnreadCounts(userId, channelIds[])` — `MGET` (batch)
- `resetUnread(userId, channelId)` — `DEL`
- `resetUnreads(userId, channelIds[])` — `DEL` (batch)

**Tradeoff:** `INCR` is atomic and fast. The 7-day TTL means unread counts persist across reconnections. Resetting is a simple `DEL`, which is correct because the client fetches fresh counts on reconnect.

---

## 5. Typing Indicators

Per-user, per-channel typing status with auto-expiry.

| Key | Type | TTL |
|-----|------|-----|
| `typing:{channelId}:{userId}` | String (`"1"`) | 5 s |

**Operations:**
- `setTyping(channelId, userId)` — `SETEX typing:{channelId}:{userId} 5 "1"`
- `clearTyping(channelId, userId)` — `DEL typing:{channelId}:{userId}`
- `getTypingUsers(channelId)` — `KEYS typing:{channelId}:*` → extract userId from key suffix

**Tradeoff:** Uses `KEYS` instead of `SCAN` because the key space is tiny (active typists per channel, 5s TTL). At scale (thousands of concurrent typists per channel), `SCAN` would avoid momentary blocking. Not a practical concern for typical chat.

---

## 6. Read Receipts Cache

Per-channel, per-user read receipt mapping.

| Key | Type | TTL |
|-----|------|-----|
| `cache:read_receipts:{channelId}` | Hash (userId → messageId) | 5 min |

**Operations:**
- `cacheReadReceipt(channelId, userId, messageId)` — `HSET` + `EXPIRE 300`
- `getReadReceipts(channelId)` — `HGETALL`

**Tradeoff:** 5-minute TTL is short because read receipts are frequently updated. The hash structure allows O(1) lookups per user and O(N) retrieval for all users in a channel.

---

## 7. Channel Membership Denormalization

Cached member lists for fast delivery fan-out.

| Key | Type | TTL |
|-----|------|-----|
| `channel:members:{channelId}` | Set (userId values) | None |

**Operations:**
- `addChannelMember(channelId, userId)` — `SADD`
- `removeChannelMember(channelId, userId)` — `SREM`
- `getChannelMembers(channelId)` — `SMEMBERS`
- `isChannelMember(channelId, userId)` — `SISMEMBER`

**Tradeoff:** No TTL — membership is persisted in Postgres and this is a denormalized cache. If Redis is lost, the BullMQ worker falls back to a Postgres query and re-populates the SET. The SET is updated on every add/remove membership operation.

---

## 8. Pending Messages (Offline Queue)

Messages queued for offline users, delivered on reconnect.

| Key | Type | TTL | Score |
|-----|------|-----|-------|
| `pending:{userId}` | Sorted Set | 7 days | sequenceNumber |

**Operations:**
- `addPendingMessage(userId, message)` — `ZADD` with score = sequenceNumber + `EXPIRE 604800`
- `getPendingMessages(userId)` — `ZRANGE 0 -1 WITHSCORES` → parse JSON values
- `clearPendingMessages(userId)` — `DEL`
- `getPendingCount(userId)` — `ZCARD`

**Tradeoff:** Sorted set scored by sequence number ensures messages are delivered in order. 7-day TTL means offline messages expire eventually — this prevents unbounded storage for users who never reconnect.

---

## 9. Socket.io Adapter

`@socket.io/redis-adapter` uses Redis pub/sub internally to synchronize Socket.io room operations across multiple server instances.

- Uses the main Redis client as publisher
- Duplicates the client for the subscriber
- Attached via `server.adapter(createSocketRedisAdapter(pubClient, subClient))`

**Tradeoff:** Uses the same Redis instance as application data. In production, a separate Redis instance for the adapter would prevent pub/sub traffic from competing with cache/session operations.

---

## 10. Rate Limiting

Sliding window rate limiter using sorted sets.

| Key | Type | TTL |
|-----|------|-----|
| `ratelimit:{key}:{windowBucket}` | Sorted Set | windowMs + 1s |

**Operations (pipeline):**
1. `ZREMRANGEBYSCORE` — remove expired entries
2. `ZADD` — add current request with timestamp score
3. `ZCARD` — count requests in window
4. `PEXPIRE` — set TTL

**Tradeoff:** Sorted sets provide accurate sliding window counting. The tradeoff is slightly more memory than a simple counter, but it handles burst patterns correctly (unlike fixed-window counters).

---

## Pub/Sub (Separate Clients)

`RedisPubSubService` uses **dedicated** publisher + subscriber Redis clients, separate from the main application client.

| Pattern | Purpose |
|---------|---------|
| `group:{groupId}:channel` | Channel-level message broadcast (message:new, message:read) |
| `user:{userId}:channel` | User-level targeted messages (cross-node) |

**Tradeoff:** Redis pub/sub blocks the subscriber connection — it cannot issue other commands. Using separate clients ensures the main client remains available for cache/session operations.

---

## Graceful Degradation

Every Redis service method follows this pattern:

```typescript
async someMethod(...args) {
  if (!this.client) return <safe-default>;  // No Redis → degrade gracefully
  try {
    // ... Redis operation ...
  } catch {
    return <safe-default>;  // Redis error → degrade gracefully
  }
}
```

When Redis is unavailable:
- Sessions: no single-session enforcement, `emitToUser()` falls back to broadcast
- Presence: everyone appears offline
- Cache: all reads fall back to Postgres
- Typing: indicators stop working
- Unread counts: return 0
- Rate limiting: all requests allowed (fail-open)
- Channel members: BullMQ worker queries Postgres directly

---

## Connection Architecture

```
NestJS Application
├── RedisService (main client)
│   └── Used by: RedisCacheService, RedisSessionService, RateLimitService
├── RedisPubSubService
│   ├── Publisher client (dedicated)
│   └── Subscriber client (dedicated)
└── Socket.io Redis Adapter
    ├── pubClient (shared with RedisService)
    └── subClient (duplicate of main client)
```

BullMQ uses its own Redis connections (configured in `queues.module.ts` via `createNodeRedisClient`).
