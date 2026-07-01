# WebSocket API (Socket.io)

ZEVRA uses Socket.io v4 for real-time communication. The WebSocket server runs alongside the HTTP server on the same port.

## Connection

### Handshake

```
Client connects to: ws://localhost:3000
Auth: { token: "jwt-access-token" } or Header: Authorization: Bearer <jwt>
```

The `SocketAuthGuard` verifies the JWT during handshake. If invalid, the connection is rejected with an error event and disconnected.

**Rejection events:**
| Code | Condition |
|------|-----------|
| `NO_TOKEN` | No token provided |
| `TOKEN_EXPIRED` | JWT has expired |
| `INVALID_TOKEN` | JWT signature invalid |
| `USER_NOT_FOUND` | User not in database |

### Connection Lifecycle

```
1. Client connects with JWT
2. SocketAuthGuard verifies token
3. SocketGateway.handleConnection():
   a. IP rate limit check (2000 connections/min per IP)
   b. Single-session enforcement (kicks old socket if exists)
   c. Register session in Redis (session:{userId} ↔ socket:{socketId}, 10min TTL)
   d. Set presence online in Redis (30s TTL)
   e. Subscribe to user PubSub channel (cross-node messages)
   f. Start 30-second heartbeat interval
   g. Emit 'connected' to client
4. Client is ready
```

### Heartbeat

Every 30 seconds, the server:
1. Renews session TTL (10 minutes)
2. Renews presence TTL (30 seconds)

If the heartbeat stops (client disconnects or network issue), the session expires after 10 minutes and presence expires after 30 seconds.

The client can also send a `heartbeat` event to trigger an immediate renewal.

### Disconnection

```
1. Heartbeat interval cleared
2. IP tracking cleaned up
3. If current session matches this socket:
   a. Remove session from Redis
   b. Set presence offline
   c. Unsubscribe from user PubSub channel
```

---

## Client → Server Events

### `join-channel`

Join a Socket.io room for a channel. Must be a member.

**Payload:**
```json
{ "channelId": "uuid" }
```

**Response:** `{ "success": true }` or `{ "success": false, "error": "NOT_MEMBER" }`

**Side effects:** Broadcasts `user:joined` to all other members in the channel.

---

### `leave-channel`

Leave a Socket.io room.

**Payload:**
```json
{ "channelId": "uuid" }
```

**Response:** `{ "success": true }`

**Side effects:** Broadcasts `user:left` to all other members.

---

### `typing:start`

Indicate the user is typing. Rate-limited (200/second per user).

**Payload:**
```json
{ "channelId": "uuid" }
```

**Side effects:**
- Stores in Redis with 5-second TTL (`typing:{channelId}:{userId}`)
- Broadcasts `typing:start` to all other members in the channel room

---

### `typing:stop`

Indicate the user stopped typing. Rate-limited.

**Payload:**
```json
{ "channelId": "uuid" }
```

**Side effects:**
- Deletes from Redis
- Broadcasts `typing:stop` to all other members

---

### `send-message`

Send an E2EE message. Rate-limited (500/second per user). Max payload size: 10KB.

**Payload:**
```json
{
  "channelId": "uuid",
  "encryptedContent": "base64-ciphertext",
  "contentIv": "base64-iv",
  "contentTag": "base64-tag",
  "signature": "base64-ed25519-signature",
  "sequenceNumber": 42,
  "senderKeyEpoch": 1,
  "messageType": "TEXT",
  "metadata": {}
}
```

**Response (success):**
```json
{
  "success": true,
  "message": {
    "id": "uuid",
    "senderId": "uuid",
    "channelId": "uuid",
    "encryptedContent": "base64",
    "contentIv": "base64",
    "contentTag": "base64",
    "signature": "base64",
    "sequenceNumber": 42,
    "senderKeyEpoch": 1,
    "messageType": "TEXT",
    "metadata": null,
    "isDeleted": false,
    "createdAt": "2026-08-27T23:00:00.000Z"
  }
}
```

**Response (error):**
```json
{ "success": false, "error": "RATE_LIMITED", "message": "Too many messages" }
{ "success": false, "error": "PAYLOAD_TOO_LARGE", "message": "Message exceeds 10KB limit" }
{ "success": false, "error": "NOT_MEMBER", "message": "Not a member of this channel" }
{ "success": false, "error": "SEND_FAILED", "message": "..." }
```

---

### `get-messages`

Fetch messages for a channel. Rate-limited (1000/second per user).

**Payload:**
```json
{
  "channelId": "uuid",
  "limit": 50,
  "cursor": "2026-08-27T22:55:00.000Z"
}
```

- `limit`: optional, default 50
- `cursor`: optional ISO timestamp for pagination

**Response:**
```json
{
  "success": true,
  "messages": [...],
  "nextCursor": "2026-08-27T22:50:00.000Z",
  "hasMore": true,
  "source": "cache" | "database"
}
```

---

### `mark-read`

Mark messages as read up to a specific message.

**Payload:**
```json
{
  "channelId": "uuid",
  "messageId": "uuid"
}
```

**Response:**
```json
{ "success": true, "advanced": true }
```

`advanced: false` if the read watermark was already at or past this message.

---

### `get-unread`

Get unread message counts for all channels.

**Payload:** None

**Response:**
```json
{
  "success": true,
  "counts": {
    "channel-uuid-1": 5,
    "channel-uuid-2": 0
  }
}
```

---

### `get-pending`

Deliver pending offline messages and clear the queue.

**Payload:** None

**Response:**
```json
{
  "success": true,
  "count": 3,
  "messages": [
    {
      "messageId": "uuid",
      "channelId": "uuid",
      "senderId": "uuid",
      "encryptedContent": "base64",
      "contentIv": "base64",
      "contentTag": "base64",
      "sequenceNumber": 42,
      "senderKeyEpoch": 1,
      "messageType": "TEXT",
      "createdAt": "2026-08-27T23:00:00.000Z"
    }
  ]
}
```

---

### `heartbeat`

Client-initiated heartbeat (optional — server also sends heartbeats automatically).

**Payload:** None

**Response:** `heartbeat-ack` with `{ "timestamp": 1693168800000 }`

---

## Server → Client Events

### `connected`

Emitted on successful connection.

```json
{
  "userId": "uuid",
  "username": "alice",
  "socketId": "socket-id"
}
```

---

### `error`

Emitted on various error conditions.

```json
{
  "code": "RATE_LIMITED" | "NOT_MEMBER" | "NO_TOKEN" | "TOKEN_EXPIRED" | "INVALID_TOKEN" | "USER_NOT_FOUND",
  "message": "description"
}
```

---

### `forced-disconnect`

Emitted when another device connects for the same user (single-session enforcement).

```json
{
  "reason": "Another device connected"
}
```

The old socket is then disconnected.

---

### `heartbeat-ack`

Response to heartbeat.

```json
{ "timestamp": 1693168800000 }
```

---

### `message:new`

New message delivered to a user (from BullMQ worker or cross-node PubSub).

```json
{
  "messageId": "uuid",
  "channelId": "uuid",
  "senderId": "uuid",
  "encryptedContent": "base64",
  "contentIv": "base64",
  "contentTag": "base64",
  "sequenceNumber": 42,
  "senderKeyEpoch": 1,
  "messageType": "TEXT",
  "createdAt": "2026-08-27T23:00:00.000Z"
}
```

---

### `message:read`

Read receipt broadcast.

```json
{
  "userId": "uuid",
  "messageId": "uuid",
  "channelId": "uuid",
  "readAt": "2026-08-27T23:00:00.000Z"
}
```

---

### `user:joined`

User joined a channel room.

```json
{
  "userId": "uuid",
  "username": "alice",
  "channelId": "uuid"
}
```

---

### `user:left`

User left a channel room.

```json
{
  "userId": "uuid",
  "username": "alice",
  "channelId": "uuid"
}
```

---

### `typing:start`

User started typing.

```json
{
  "userId": "uuid",
  "username": "alice",
  "channelId": "uuid"
}
```

---

### `typing:stop`

User stopped typing.

```json
{
  "userId": "uuid",
  "username": "alice",
  "channelId": "uuid"
}
```

---

### `messages:pending`

Pending offline messages delivered on reconnect.

```json
{
  "messageId": "uuid",
  "channelId": "uuid",
  "senderId": "uuid",
  "encryptedContent": "base64",
  "contentIv": "base64",
  "contentTag": "base64",
  "sequenceNumber": 42,
  "senderKeyEpoch": 1,
  "messageType": "TEXT",
  "createdAt": "2026-08-27T23:00:00.000Z"
}
```

---

### `user:message`

Cross-node user-targeted message via Redis PubSub.

```json
{ "event": "...", "data": { ... } }
```

---

## Multi-Node Architecture

With the Redis adapter attached, Socket.io rooms are synchronized across server instances:

- **Within a node:** Socket.io rooms (`channel:{id}`) for local broadcast
- **Across nodes:** `@socket.io/redis-adapter` syncs room joins/leaves/broadcasts via Redis pub/sub
- **Application-level:** `RedisPubSubService` handles `group:{id}:channel` and `user:{id}:channel` patterns for custom cross-node fan-out

When a message is sent:
1. The BullMQ worker on the originating node broadcasts to the local Socket.io room
2. The worker also publishes to Redis PubSub (`group:{channelId}:channel`)
3. Other nodes receive the PubSub message and broadcast to their local Socket.io rooms
