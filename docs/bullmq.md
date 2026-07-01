# BullMQ

Background job processing via BullMQ, integrated with NestJS via `@nestjs/bullmq`.

## Configuration

```typescript
// queues.module.ts
BullModule.forRootAsync({
  useFactory: () => ({
    connection: {
      url: process.env.REDIS_URL,
      clientFactory: createNodeRedisClient,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },  // 1s, 2s, 4s
      timeout: 30_000,                                  // 30 seconds
      removeOnComplete: { age: 3600 },                  // 1 hour
      removeOnFail: { age: 86400 },                     // 24 hours
    },
  }),
});
```

BullMQ uses its own Redis connections (not shared with the application).

## Queues

### 1. `message-delivery`

Fan-out messages to channel members.

| Property | Value |
|----------|-------|
| Concurrency | 10 workers |
| Stalled interval | 30 s |
| Priority | High (priority: 1) |
| Retries | 3, exponential backoff (1s, 2s, 4s) |
| Timeout | 30 s |

**Job payload (`MessageDeliveryJob`):**
```typescript
{
  messageId: string;
  channelId: string;
  senderId: string;
  encryptedContent: string;
  contentIv: string;
  contentTag: string;
  sequenceNumber: number;
  senderKeyEpoch: number;
  messageType: string;
  createdAt: string;  // ISO timestamp
}
```

**Flow:**
```
1. Get channel members
   ├── Try Redis SET (channel:members:{channelId})
   └── Fallback: Postgres query → denormalize into Redis

2. Check online status
   └── Redis MGET presence:{userId} for all members

3. For each member (skip sender):
   ├── ONLINE  → SocketService.emitToUser(userId, 'message:new', payload)
   └── OFFLINE → RedisSessionService.addPendingMessage(userId, payload)

4. Increment unread counts (non-blocking)
   └── Redis INCR cache:unread:{userId}:{channelId} for each member

5. Broadcast to channel room (local Socket.io)
   └── socketService.broadcastToChannel(channelId, 'message:new', payload)

6. Publish to Redis PubSub (cross-node)
   └── pubSubService.publishToGroup(channelId, { event: 'message:new', data: payload })
```

**Return value:** `{ delivered: number, queued: number, totalMembers: number }`

**Tradeoff:** The sync persist path (in `ChatService.sendMessage`) handles the write + cache + ACK. The async worker handles only fan-out. This means:
- Sender gets a fast ACK (<50ms typically)
- Delivery happens asynchronously — slight delay for recipients
- If the worker crashes mid-delivery, BullMQ retries (at-least-once delivery)
- Clients must handle duplicate `message:new` events idempotently

---

### 2. `read-receipt`

Broadcast read receipts to channel members.

| Property | Value |
|----------|-------|
| Concurrency | 5 workers |
| Stalled interval | 15 s |
| Retries | 3, exponential backoff |
| Timeout | 30 s |

**Job payload (`ReadReceiptJob`):**
```typescript
{
  userId: string;
  channelId: string;
  messageId: string;
  readAt: string;  // ISO timestamp
}
```

**Flow:**
```
1. Cache receipt in Redis hash
   └── HSET cache:read_receipts:{channelId} userId messageId
       + EXPIRE 300 (5 min)

2. Broadcast to channel room (local Socket.io)
   └── socketService.broadcastToChannel(channelId, 'message:read', receipt)

3. Publish to Redis PubSub (cross-node)
   └── pubSubService.publishToGroup(channelId, { event: 'message:read', data: receipt })
```

---

### 3. `key-rotation`

Update user key material in Postgres.

| Property | Value |
|----------|-------|
| Concurrency | 1 (default) |
| Retries | 3, exponential backoff |
| Timeout | 30 s |

**Job payload (`KeyRotationJob`):**
```typescript
{
  userId: string;
  newPublicKey: string;
  newEncryptedPrivateKey: string;
  newKeySalt: string;
  newPublicKeySign: string;
  newEncryptedPrivateKeySign: string;
  newKeySaltSign: string;
  newKeyVersion: number;
}
```

**Flow:**
```
1. UPDATE users SET
     publicKey, encryptedPrivateKey, keySalt,
     publicKeySign, encryptedPrivateKeySign, keySaltSign,
     keyVersion, updatedAt
   WHERE id = userId
   RETURNING id, keyVersion
```

**Tradeoff:** Key rotation is async to avoid blocking the HTTP response. The client continues using old keys until the update completes. There's a brief window where the old keys are still valid — this is acceptable because key rotation is infrequent and the window is short (seconds).

---

## Why Sync Persist + Async Fan-out

**Alternative considered:** Pure async (enqueue first, persist in worker)

**Why rejected:**
- Sender needs the assigned `sequenceNumber` in the ACK to maintain client-side ordering
- Persisting in a worker adds latency to the write confirmation
- If the worker fails, the message is lost (unless you add a separate persistence step)
- More complex error handling — the client doesn't know if the message was actually saved

**Chosen approach:**
1. Persist to Postgres synchronously (with `SELECT FOR UPDATE` serialization)
2. Cache in Redis synchronously
3. Return ACK to sender with assigned sequence number
4. Enqueue delivery to BullMQ (non-blocking)
5. Worker handles fan-out asynchronously

**Cost:**
- Slightly higher write latency (Postgres round-trip before ACK)
- Delivery is at-least-once (BullMQ retries) — clients must be idempotent
- If BullMQ is down, messages are persisted but not delivered until the queue recovers

---

## Job Lifecycle

```
                     ┌─────────┐
                     │ PENDING │
                     └────┬────┘
                          │ Worker picks up
                          ▼
                     ┌─────────┐
                     │ ACTIVE  │
                     └────┬────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
         ┌────────┐  ┌────────┐  ┌────────┐
         │COMPLETE│  │ FAILED │  │STALLED │
         └────────┘  └───┬────┘  └───┬────┘
                         │           │
                    Retry?      BullMQ detects
                    (up to 3)   dead worker
                         │           │
                         ▼           ▼
                    ┌────────┐  ┌────────┐
                    │ ACTIVE │  │ WAIT   │
                    └────────┘  └────────┘
```

- **Stalled:** If a worker takes longer than `stalledInterval` without updating the job, BullMQ considers it stalled and requeues the job.
- **Completed jobs** are removed after 1 hour (`removeOnComplete: { age: 3600 }`).
- **Failed jobs** are removed after 24 hours (`removeOnFail: { age: 86400 }`).

---

## Error Handling

- **Worker throws:** Job is retried up to 3 times with exponential backoff (1s, 2s, 4s).
- **Job times out (30s):** Job is killed and retried.
- **All retries exhausted:** Job moves to failed state, removed after 24 hours.
- **Queue add fails:** `ChatService.sendMessage` catches the error and logs a warning — the message is still persisted, just not delivered async.
