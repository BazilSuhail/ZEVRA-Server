# ZEVRA Server API

This file is the authoritative API reference. Where `docs/*.md` or older notes disagree, this file wins.
It was written from the controllers, DTOs and gateways in `src/`.

- [Basics](#basics)
- [Authentication](#authentication)
- [Errors](#errors)
- [REST endpoints](#rest-endpoints)
- [Socket.IO](#socketio)
- [Redis keys](#redis-keys)
- [Environment variables](#environment-variables)
- [Migrations and deploy](#migrations-and-deploy)

---

## Basics

| Item | Value |
|------|-------|
| Base URL (dev) | `http://localhost:3000` (`PORT`, default 3000) |
| Client config | web `NEXT_PUBLIC_API_URL`, mobile `EXPO_PUBLIC_API_URL` |
| Content type | `application/json` (uploads: `multipart/form-data`) |
| JSON body limit | Express default (100 KB); larger bodies → 413 `PAYLOAD_TOO_LARGE` |
| CORS | Explicit origins from `CORS_ORIGIN` (comma list). `*` is rejected at startup. Outside production the default is `http://localhost:3001, http://localhost:8081, http://localhost:19006`; in production the default is no origins. |
| Request id | Send `X-Request-Id` (`[A-Za-z0-9._-]{8,128}`) or the server generates a UUID. It is echoed in the response header and in error bodies. |
| Exposed headers | `X-Request-Id`, `Retry-After` |
| Unknown fields | The global validation pipe uses `whitelist` + `forbidNonWhitelisted`, so unknown body **and query** fields return 400 (this includes cache-buster params). |

Route prefixes are not uniform: auth, users and audit live under `/api/...`; everything else is at the root (`/channels`, `/messages`, ...). This is how the controllers are declared.

### Health

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET/HEAD | `/` | none | `{ status: 'ok' }` |
| GET/HEAD | `/health` | none | Liveness. `{ status: 'ok' }` |
| GET/HEAD | `/health/ready` | none | Readiness. Runs DB `SELECT 1` and Redis `PING` (2 s timeout each). 200 `{ status:'ok', db:'up', redis:'up' }` or 503 `{ status:'error', db:'up'|'down', redis:'up'|'down' }` |

Health routes are not rate limited. `/health/detail` no longer exists.

---

## Authentication

### Registration

`POST /api/auth/register` with `{ username, email, password }`.

The password is sent to the server over TLS. The server derives the SRP verifier, generates the X25519 and Ed25519 key pairs, derives two KEKs with Argon2id (`m=65536, t=3, p=4`, separate salts), seals both private keys (AES-256-GCM, `iv:tag:ct` base64) and stores only the verifier and sealed keys. The server therefore sees the password and the private keys once, at registration. Moving key generation to the client needs a product decision and is not done.

### Login (SRP-6a)

Group: RFC 5054 2048-bit prime, `g = 2`, hash SHA-256. Big integers are hex; when hashed they are left-padded to 256 bytes.

```
x  = SHA256(srpSalt + password)            (string concatenation, srpSalt is hex text)
k  = H(N, g)
u  = H(A, B)
K  = H(S)
M1 = H(H(N) xor H(g), H(srpSalt bytes), A, B, K)
M2 = H(A, M1 bytes, K)
```

1. `POST /api/auth/login/start` `{ username }` → `{ success, username, srpSalt, B }`.
   The server stores `{ b, B, userId }` in Redis `zevra:srp:{username}` (TTL 120 s).
   Unknown or inactive usernames get a deterministic decoy salt and a real-looking `B`, so this step never reveals whether an account exists. `userId` is no longer returned.
2. `POST /api/auth/login/finish` `{ username, A, M1 }`.
   The SRP state is consumed with GETDEL (single use). `A` must be hex, at most 1024 chars, and `A mod N ≠ 0`. `M1` must be 64 hex chars and is compared in constant time.
   Success → `{ success, user:{id,username,email}, accessToken, refreshToken, expiresIn, keys:{publicKey, publicKeySign, encryptedPrivateKey, keySalt, encryptedPrivateKeySign, keySaltSign, argon2Params, keyVersion}, M2 }`.
   Any failure → 401 `Invalid username or password`. Expired/missing state → 401 `Login session expired. Please try again.`
3. The client must verify `M2` before trusting the response, then derive the KEKs with Argon2id and unseal its private keys.

### Tokens

| Token | Format | Lifetime | Storage on server |
|-------|--------|----------|-------------------|
| Access | JWT HS256, `{ sub: userId }` | `JWT_ACCESS_TTL`, default **15 min**. `expiresIn` (seconds) is returned with every token pair. | not stored |
| Refresh | 64 hex chars | 7 days | SHA-256 hash in `refresh_tokens.token_hash` |

Rules:

- Send the access token as `Authorization: Bearer <token>`.
- On 401, call `POST /api/auth/refresh` `{ refreshToken }` → `{ success, accessToken, refreshToken, expiresIn }`.
- Refresh tokens are **single use**. The old token is deleted in the same statement that reads it (`DELETE … RETURNING`), so two concurrent refreshes with one token cannot both succeed. Clients must serialise refresh (single-flight) and store the new refresh token every time.
- Refresh fails with 401 if the token is unknown, expired, or the user is deactivated (all of that user's refresh tokens are then deleted).
- `POST /api/auth/logout` deletes **all** refresh tokens of the user (every device) and marks the user offline.
- Deactivated users (`is_active = false`) are rejected by the JWT strategy and the socket handshake.

### Rate limits

All limits use atomic Redis counters (Lua `INCR` + `PEXPIRE`). If Redis is unavailable the limiters fail open and log once. A rejected HTTP request gets 429 `RATE_LIMITED` and a `Retry-After` header (route limits).

| Scope | Limit | Keyed by |
|-------|-------|----------|
| All HTTP routes (global) | 300/min (`API_RATE_LIMIT_PER_MIN`) | verified JWT `sub`, else IP. One counter across all routes. |
| `POST /api/auth/register` | 5/min | IP |
| `POST /api/auth/login/start` | 10/min | IP **and** username |
| `POST /api/auth/login/finish` | 10/min | IP **and** username |
| `POST /api/auth/refresh` | 30/min | IP |
| `POST /uploads` | 20/min | user |
| Socket connections | 120/min | IP (`x-forwarded-for` only when `TRUST_PROXY=true`) |
| Socket `send-message` | 20/s | user |
| Socket `typing:start` / `typing:stop` | 10/s | user |
| Socket `get-messages`, `get-pending` | 30/s | user |
| Socket `reaction:*` | 20/s | user |
| Socket `call:invite`, `call:initiate`, `call:livekit-fallback` | 10 per 5 s | user |
| Socket call signalling relays | 50/s | user |

---

## Errors

### HTTP error shape

Every HTTP error (validation, auth, DB, unknown) has this body:

```json
{
  "success": false,
  "statusCode": 400,
  "error": "VALIDATION_ERROR",
  "message": "human readable",
  "details": ["optional per-field messages"],
  "path": "/channels",
  "timestamp": "2026-11-03T10:00:00.000Z",
  "requestId": "uuid"
}
```

Clients should display `message`. Raw database or driver text is never sent; unknown errors are logged with a stack trace and returned as `Internal server error`.

| Code | Status | When |
|------|--------|------|
| `VALIDATION_ERROR` | 400, 422 (and other unmapped 4xx) | DTO validation (`details` lists fields), malformed JSON, bad UUID, Postgres `22P02/22001/22003/23502/23514` |
| `UNAUTHORIZED` | 401 | missing/expired/invalid token, bad credentials |
| `FORBIDDEN` | 403 | not a member, not an admin, not your message |
| `NOT_FOUND` | 404 | missing resource, Postgres `23503` |
| `CONFLICT` | 409 | username/email taken, already a member, Postgres `23505` |
| `RATE_LIMITED` | 429 | any rate limit |
| `PAYLOAD_TOO_LARGE` | 413 | body too large, message > 10 KB, metadata > 64 KB, upload > 10 MB |
| `INTERNAL_ERROR` | 500, 503 | unexpected errors; 503 is used when Cloudinary or LiveKit is not configured or fails |

### Socket ack shape

Every client→server event that takes an ack callback replies with:

- success: `{ success: true, ...data }`
- failure: `{ success: false, error: CODE, message }`

| Ack code | Meaning |
|----------|---------|
| `VALIDATION_ERROR` | bad payload (also HTTP 400/409/422 raised inside a handler) |
| `NOT_AUTHENTICATED` | no user on the socket, or token expired |
| `NOT_MEMBER` | not a member of the channel (HTTP 403 inside a handler) |
| `NOT_FOUND` | message/channel/user missing |
| `RATE_LIMITED` | socket rate limit hit |
| `PAYLOAD_TOO_LARGE` | message > 10 KB or metadata > 64 KB |
| `INTERNAL_ERROR` | anything else (`Internal server error`) |

Call events can also return `ALREADY_IN_CALL`, `TARGET_BUSY`, `TARGET_OFFLINE`, `INVALID_CALL`, `NO_TARGET`, `CHANNEL_REQUIRED`, `LIVEKIT_NOT_CONFIGURED`, `TOKEN_FAILED` (always with `message`).

---

## REST endpoints

"JWT" = `Authorization: Bearer <accessToken>` required. All routes are also subject to the global 300/min limit unless noted.

### Auth — `/api/auth`

| Method | Path | Auth | Request | Response | Status | Limit |
|--------|------|------|---------|----------|--------|-------|
| POST | `/api/auth/register` | none | `{ username, email, password }` | `{ success, user:{id,username,email,createdAt} }` | 201; 409 if username/email taken | 5/min/IP |
| POST | `/api/auth/login/start` | none | `{ username }` | `{ success, username, srpSalt, B }` | 200 | 10/min IP + username |
| POST | `/api/auth/login/finish` | none | `{ username, A, M1 }` | see [Login](#login-srp-6a) | 200; 401 | 10/min IP + username |
| GET | `/api/auth/me` | JWT | – | `{ success, user:{id,username,email,status,createdAt,lastLoginAt,keyVersion} }` | 200 | – |
| POST | `/api/auth/refresh` | none | `{ refreshToken }` (64 hex) | `{ success, accessToken, refreshToken, expiresIn }` | 200; 401 | 30/min/IP |
| POST | `/api/auth/logout` | JWT | – | `{ success, message:'Logged out' }` | 200 | – |

Field rules: `username` trimmed, 3–32 chars, `[A-Za-z0-9_]` (same rule on login). `email` trimmed + lower-cased, valid, ≤255. `password` 8–128.

### Users — `/api/users` (all JWT)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| PUT | `/api/users/me` | `{ username }` (register rules) | `{ id, username, email, status, createdAt, ... }` (caller's own view). 409 `Username already taken` |
| GET | `/api/users/search?q=&limit=` | `q` trimmed 1–64; `limit` 1–25 (default 20) | `[{ id, username, status, keyVersion, createdAt }]` — username match only (case-insensitive substring, LIKE-escaped), active users only, excludes caller. No email. |
| GET | `/api/users/online?ids=` | `ids` comma list or repeated, UUIDs, max 200 | `{ online: string[] }` |
| GET | `/api/users/:id` | `:id` UUID | `{ id, username, status, keyVersion, createdAt, lastLoginAt }`. No email. 404 if missing. |

Only `/api/auth/me` and the caller's own `PUT /api/users/me` response include `email`.

### Keys — `/keys` (all JWT)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/keys/me` | – | `{ id, publicKey, encryptedPrivateKey, keySalt, publicKeySign, encryptedPrivateKeySign, keySaltSign, keyVersion, argon2Params }` (sealed; used to unlock keys on a new device/session) |
| GET | `/keys/public?userIds=` | 1–100 UUIDs, repeated or comma-separated | `{ [userId]: { publicKey, publicKeySign, keyVersion } }` |
| POST | `/keys/rotate` | `{ newPublicKey, newEncryptedPrivateKey, newKeySalt, newPublicKeySign, newEncryptedPrivateKeySign, newKeySaltSign, newKeyVersion }` — public keys 32-byte base64, sealed keys `iv:tag:ct` base64, salts base64 16–128 chars, `newKeyVersion` int ≥2 | 200 `{ success, keyVersion }`. Applied synchronously; 400 if `newKeyVersion` ≤ current. Audited as `KEY_ROTATE`. |
| POST | `/keys/sender-keys` | `{ groupId, epoch ≥0, items:[{ receiverId, encryptedKey ≤4096, keySignature ≤1024 }] }` (1–500 items, no duplicate receivers) | `{ success, message:'Sender keys uploaded' }`. Caller and every receiver must be members. Replaces caller's keys for that group/epoch in one transaction. |
| GET | `/keys/sender-keys/:groupId?epoch=` | `groupId` UUID, `epoch` int ≥0 optional | `[{ id, groupId, epoch, encryptedKey, keySignature, ownerId, createdAt }]` addressed to the caller |

### Channels — `/channels` (all JWT)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/channels` | `{ type:'DIRECT'|'GROUP', name? (≤64), participantIds: UUID[] (1–50) }` | channel row + `created: boolean`. DMs are idempotent (same pair → existing channel, `created:false`). Self-DM → 400; unknown participant → 404. Emits `channel:created`. |
| GET | `/channels` | – | `[{ id, name, type, isArchived, lastMessageId, lastMessageAt, lastMessageContent, lastMessageSenderId, lastMessageSenderName, lastMessageIv, lastMessageTag, lastMessageMetadata, lastMessageSenderKeyEpoch, createdAt, lastReadMessageId, dmPeerId, unreadCount }]` sorted by `lastMessageAt` desc |
| POST | `/channels/mark-read` | `{ channelId, lastReadMessageId }` | `{ success, advanced }`. Watermark never moves backwards; unread counter is always reset; `message:read` is emitted when it advances. |
| GET | `/channels/:channelId` | – | channel row + `role` + `members:[{ id, username, status, role, joinedAt }]` |
| POST | `/channels/:channelId/members` | `{ userId, role?: 'MEMBER'|'ADMIN' }` | `{ membershipId, user }`. Admin only; GROUP only (DM → 400); cap 51 members; 409 if already a member. Emits `channel:member-added`. |
| DELETE | `/channels/:channelId/members/:targetUserId` | – | `{ success, promotedUserId }`. Admins remove others; anyone can remove themselves. If the last admin leaves, the oldest member is promoted. Emits `channel:member-removed`. |
| POST | `/channels/:channelId/archive` | – | `{ isArchived }` (toggles). Admin only. Archived channels reject new messages (400 `Channel is archived`). |
| GET | `/channels/:channelId/typing` | – | `string[]` user ids currently typing (excluding caller) |
| GET | `/channels/:channelId/read-receipts` | – | `{ [userId]: lastReadMessageId }` |

### Messages — `/messages` (all JWT)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/messages` | `SendMessage` (below) | message payload (same shape as `message:new`). Same pipeline as socket `send-message`: broadcast, cache, offline queue, unread counters. |
| GET | `/messages/channel/:channelId?limit=&cursor=&mode=` | `limit` 1–100 (default 50); `cursor` = sequence number; `mode` `latest`\|`before`\|`since` (default `before`) | `{ messages: HistoryMessage[], nextCursor: number|null, hasMore, source: 'cache'|'database' }`. Messages are ascending by `sequenceNumber`. `before`+cursor = older than cursor; `since`+cursor = newer than cursor. |
| DELETE | `/messages/:messageId` | – | `{ success, messageId, channelId }`. Own messages only (403). Wipes `encryptedContent` to `''` and `metadata` to null, deletes its reactions, emits `message:deleted`. |

`SendMessage`:

| Field | Rule |
|-------|------|
| `channelId` | UUID, caller must be a member |
| `encryptedContent` | non-empty string, ≤10 KB UTF-8 (413) |
| `contentIv`, `contentTag` | 1–32 chars |
| `signature` | ≤256 chars, base64 Ed25519 over `${channelId}:${encryptedContent}`; verified against the sender's `publicKeySign` when present (400 `Invalid message signature`) |
| `sequenceNumber`, `senderKeyEpoch` | int ≥0 (the server assigns the stored sequence number) |
| `messageType` | `TEXT` \| `IMAGE` \| `FILE` \| `SYSTEM` (optional) |
| `metadata` | object, ≤64 KB JSON (413). E2EE envelopes live in `metadata.env`. |

`HistoryMessage` = message payload + `reactions: [{ emoji, userId, username }]`. Deleted messages come back with `isDeleted: true`, `encryptedContent: ''`.

There is no idempotency key: a send that times out on the client and is retried can be stored twice.

### Reactions — `/reactions` (all JWT)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/reactions` | `{ channelId, messageId, emoji (1–16 UTF-16 units) }` | `{ success, action:'added'|'already_exists', replaced: string[] }`. One reaction per user per message: a different existing emoji is replaced. Deleted message → 400; message not in that channel → 404. |
| DELETE | `/reactions` | same body | `{ success, action:'removed'|'not_found' }` |
| GET | `/reactions?messageId=&channelId=` | UUIDs | `[{ emoji, userIds, count }]` |

REST and socket paths emit the same events (`reaction:removed` for replaced emoji, then `reaction:added`), excluding the actor's sockets.

### Uploads — `/uploads` (JWT)

`POST /uploads`, multipart, field `file`, one file, ≤10 MB (413). 20/min per user.

The type is detected from the file bytes, not the client MIME: JPEG, PNG, GIF, WebP, PDF; DOC/DOCX only when the container signature matches the declared type; `text/plain` only if valid UTF-8 with no NUL bytes. Anything else → 400.

Response (image): `{ url, publicId, format, resourceType, bytes, width, height, thumbnailUrl }`. Response (file): `{ url, publicId, format, resourceType, bytes }`.
Cloudinary not configured or failing → 503 with a generic message.

Files are stored **unencrypted** on Cloudinary. Only the message that references them is end-to-end encrypted.

### Calls history — `/calls` (JWT)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/calls/history?page=&limit=` | `page` 1–1000 (default 1), `limit` 1–50 (default 20) | `{ calls, page, hasMore }` |
| GET | `/calls/history/:userId?limit=` | `userId` UUID, `limit` 1–50 | `{ calls }` |

### LiveKit — `/livekit`

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/livekit/token` | JWT | `{ roomName: 'dm-…'|'group-…', participantName? (ignored) }` | 200 `{ serverUrl, token, roomName }`. 403 if not allowed in the room; 503 if LiveKit is not configured. The token always uses the authenticated username. |
| POST | `/livekit/webhook` | LiveKit signature (`Authorization` header, raw body) | LiveKit event (`application/webhook+json`) | 200 `{}`; 401 if the signature is invalid |

### Audit — `/api/audit` (JWT, caller's own events)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/api/audit/logs?action=&from=&to=&limit=&offset=` | `action` `[A-Z_]+` ≤64; `from`/`to` ISO dates; `limit` 1–100 (50); `offset` 0–10000 | `{ success, logs }` |
| GET | `/api/audit/security` | – | `{ success, events }` |

---

## Socket.IO

Socket.IO v4 on the same port, default namespace. All three gateways (`SocketGateway`, `ChatGateway`, `CallsGateway`) share one server and use the same CORS list as HTTP. With Redis available the Socket.IO Redis adapter is attached (multi-node); otherwise it runs single-node.

### Connection

- Token: `io(url, { auth: { token: accessToken } })` (preferred; may be a callback that returns a fresh token) or header `Authorization: Bearer <token>`.
- The handshake verifies the JWT (HS256) and requires an active user. On failure the server emits `error { code, message }` and disconnects. Codes: `RATE_LIMITED`, `TOKEN_EXPIRED`, `NOT_AUTHENTICATED`, `INTERNAL_ERROR`; the per-event guard can also send `NO_TOKEN`, `INVALID_TOKEN`, `USER_NOT_FOUND`.
- Before `connected` is emitted the socket has joined `user:{userId}` and `channel:{id}` for every channel the user belongs to, so nothing sent after `connected` is missed.
- **Multiple sockets per user are allowed** (tabs, devices). There is no forced disconnect. Live sockets are tracked in `zevra:sockets:{userId}`; the user goes offline only when the last socket leaves.
- The server refreshes liveness every 30 s. The JWT `exp` is checked on that timer, on client `heartbeat`, and in the per-event guard. Once expired the server emits `error { code:'TOKEN_EXPIRED' }` and disconnects; the client should refresh its token and reconnect.
- **Offline messages are not pushed on connect.** After connecting (and attaching listeners) the client calls `get-pending` until `hasMore` is false, and `get-unread` for counters.

### Client → server

All payloads are validated (UUIDs, lengths, enums). Acks follow the [socket ack shape](#socket-ack-shape).

| Event | Payload | Success ack |
|-------|---------|-------------|
| `heartbeat` | – | `{ success, timestamp }` (also emits `heartbeat-ack`) |
| `presence:bulk` | `{ userIds?: UUID[] (≤500) }` — empty = caller's DM peers | `{ success, online: string[] }` |
| `create-or-join` | `{ type, name?, participantIds }` (same as `POST /channels`) | `{ success, channelId, created }` |
| `join-channel` | `{ channelId }` (must be a member) | `{ success }` |
| `leave-channel` | `{ channelId }` (must be a member) | `{ success }` — leaves the room only, not the channel |
| `typing:start` | `{ channelId }` | `{ success }`. Server auto-stops after 6 s or on disconnect. |
| `typing:stop` | `{ channelId }` | `{ success }` |
| `send-message` | `SendMessage` (see REST) | `{ success, message }` (message payload). The sending socket does not get `message:new`; the sender's other sockets do. |
| `get-messages` | `{ channelId, limit?, cursor?, mode? }` | `{ success, messages, nextCursor, hasMore, source }` |
| `mark-read` | `{ channelId, messageId }` | `{ success, advanced }` |
| `get-unread` | – | `{ success, counts: { [channelId]: number } }` |
| `get-pending` | – | `{ success, count, messages, hasMore }`. Pops up to 100 queued messages (message payload shape); call again while `hasMore`. |
| `reaction:add` | `{ channelId, messageId, emoji }` | `{ success, action:'added'|'already_exists', replaced: string[] }` |
| `reaction:remove` | `{ channelId, messageId, emoji }` | `{ success, action:'removed'|'not_found' }` |
| `reaction:removed` | same | Legacy alias of `reaction:remove` for old client builds |

Calls (1:1 WebRTC signalling and LiveKit):

| Event | Payload | Success ack |
|-------|---------|-------------|
| `call:invite` | `{ targetUserId }` | `{ success, callId, callLogId }` |
| `call:initiate` | `{ targetUserIds: UUID[] (≤50), type:'DM'|'GROUP', channelId? }` (GROUP requires `channelId` and membership) | DM: `{ success, method:'WEBRTC', callId, callLogId }`. GROUP: `{ success, method:'LIVEKIT', roomName, serverUrl, token, callLogId }`. Offline DM target: `{ success:false, error:'TARGET_OFFLINE', message, fallback:'LIVEKIT' }` |
| `call:accept` | `{ callId }` | `{ success }` |
| `call:reject` | `{ callId }` | `{ success }` |
| `call:hangup` | `{ callId }` | `{ success }` |
| `call:offer` | `{ callId, sdp (≤64 KB) }` | no ack (relayed; invalid payloads are dropped) |
| `call:answer` | `{ callId, sdp (≤64 KB) }` | no ack |
| `call:ice-candidate` | `{ callId, candidate (≤4 KB JSON) }` | no ack |
| `call:livekit-fallback` | `{ targetUserIds, channelId? }` | `{ success, method:'LIVEKIT', roomName, serverUrl, token, callLogId }` |
| `call:livekit-active` | `{ channelId }` | `{ success, active, participantCount, roomName? }` |
| `call:livekit-join-group` | `{ roomName }` | `{ success, serverUrl, token, roomName }` |

A user's call survives a socket disconnect while another socket of the same user is still connected.

### Server → client

| Event | Payload | Sent to |
|-------|---------|---------|
| `connected` | `{ userId, username, socketId }` | the new socket |
| `error` | `{ code, message }` | the socket, before a forced disconnect (auth/rate limit/token expiry) |
| `heartbeat-ack` | `{ timestamp }` | the socket |
| `presence:bulk` | `{ online: string[] }` | the new socket (online DM peers) |
| `user:joined` | `{ userId, username }` | online DM peers, on the user's first socket only |
| `user:left` | `{ userId, username }` | DM peers, when the user's last socket disconnects |
| `message:new` | `{ id, messageId (same value, legacy), channelId, senderId, senderUsername, encryptedContent, contentIv, contentTag, signature, sequenceNumber, senderKeyEpoch, messageType, metadata, isDeleted:false, createdAt }` | `channel:{id}` except the sending socket |
| `message:deleted` | `{ messageId, channelId }` | `channel:{id}` (incl. sender's other sockets) |
| `message:read` | `{ userId, messageId, channelId, readAt }` | `channel:{id}`, for socket and REST mark-read |
| `reaction:added` | `{ userId, username, messageId, emoji, channelId }` | `channel:{id}` except the actor's sockets |
| `reaction:removed` | `{ userId, username, messageId, emoji, channelId }` | same; for a replaced emoji it is sent before `reaction:added` |
| `typing:start` / `typing:stop` | `{ userId, username, channelId }` | `channel:{id}` except the actor's sockets |
| `channel:created` | `{ channel:{ id, type, name, createdAt }, memberIds, createdBy }` | every member's sockets (already joined to the room) |
| `channel:member-added` | `{ channelId, userId }` | room + the added user (whose sockets are joined first) |
| `channel:member-removed` | `{ channelId, userId }` | room + the removed user (whose sockets then leave the room) |
| `call:incoming` | `{ callId, callerId, callerUsername }` | target |
| `call:method-selected` | `{ callId, method:'WEBRTC', targetUserId, targetUsername }` | caller |
| `call:accepted` | `{ callId, calleeId, calleeUsername }` | caller |
| `call:rejected` | `{ callId }` | other party |
| `call:hangup` | `{ callId, reason?: 'disconnected'|'caller_disconnected' }` | other party |
| `call:offer` | `{ callId, offer:{ type:'offer', sdp }, callerId, callerUsername }` | other party |
| `call:answer` | `{ callId, answer:{ type:'answer', sdp }, calleeId, calleeUsername }` | other party |
| `call:ice-candidate` | `{ callId, candidate, from }` | other party |
| `livekit:incoming` | `{ roomName, serverUrl, token, callerId, callerUsername }` | DM target (LiveKit fallback) |
| `livekit:group-invite` | `{ roomName, serverUrl, token, creatorId, creatorUsername }` | each channel member listed in `targetUserIds` |

No longer emitted: `forced-disconnect`, `messages:pending`, `presence-updates`. `join-channel`/`leave-channel` no longer emit `user:joined`/`user:left`.

### Delivery model

`send-message` / `POST /messages`: validate → store (sequence number per channel) → emit `message:new` to the room → push to the Redis message cache → enqueue a BullMQ `message-delivery` job (inline fallback if the queue is down). The job increments unread counters and adds the message to `zevra:pending:{userId}` for every recipient who had no live socket in the channel room at send time (checked cluster-wide with `fetchSockets`; if that check fails, every recipient is queued).

---

## Redis keys

Every key is `zevra:{domain}:{id}[:{subid}]` and every key written by the server has a TTL. No `KEYS`; typing uses a per-channel sorted set instead of `SCAN`. Each client has a reconnect strategy and an error listener; the offline queue is disabled so commands fail fast when Redis is down.

| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `zevra:sockets:{userId}` | zset (socketId → last heartbeat ms) | 120 s, refreshed every heartbeat; entries older than 95 s count as dead | live sockets per user |
| `zevra:presence:{userId}` | string | 90 s | online flag |
| `zevra:channel:members:{channelId}` | set | 1 h; rebuilt from DB on miss; invalidated on membership change | membership checks |
| `zevra:cache:messages:{channelId}` | list of message payloads | 24 h; last 50 messages; invalidated on delete | newest-page history |
| `zevra:unread:{userId}:{channelId}` | counter | 30 days | unread count |
| `zevra:typing:{channelId}` | zset (userId → expiry ms) | 10 s key; entries 6 s | who is typing |
| `zevra:pending:{userId}` | zset (scored by sequence) | 7 days | offline message queue (`get-pending`) |
| `zevra:srp:{username}` | string (JSON) | 120 s; consumed with GETDEL | SRP login state |
| `zevra:ratelimit:{scope}:{key}` | counter | the window | rate limits. HTTP global: `http-default:{user:<id>|ip:<ip>}`; routes: `{register|login-start|login-finish|refresh|upload}:{ip:<hash>|username:<hash>|user:<id>}`; socket: `send:`, `typing:`, `getmsg:`, `pending:`, `reaction:`, `conn-ip:`, `call:`, `call-signal:` + id |
| `zevra:call:room:{callId}` | hash | 120 s while ringing, 4 h once accepted | active 1:1 call state |
| `zevra:call:user:{userId}` | string (callId) | same as the call | user → active call |

BullMQ (queue `message-delivery`) and the Socket.IO Redis adapter use their own key/channel names.
The Postgres advisory lock `zevra:dm:{a}:{b}` (not a Redis key) makes DM creation idempotent.

---

## Environment variables

Validated at startup by `validateEnv()` in `src/common/config/env.ts`; the process exits with a list of problems if any check fails.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `DATABASE_URL` | yes | – | Postgres connection string |
| `JWT_SECRET` | yes | – | ≥32 characters. Also seeds SRP decoys. |
| `REDIS_URL` | yes | – | |
| `PORT` | no | `3000` | digits only |
| `NODE_ENV` | no | – | `production` changes CORS and DB TLS defaults |
| `CORS_ORIGIN` | in production | dev origins (see Basics) | comma list; `*` rejected |
| `JWT_ACCESS_TTL` | no | `15m` | seconds or `\d+[smhd]` |
| `API_RATE_LIMIT_PER_MIN` | no | `300` | global HTTP limit |
| `TRUST_PROXY` | no | – | Express `trust proxy` (number, `true`, or a value). Socket.IO only trusts `x-forwarded-for` when `true`. |
| `DB_SSL` | no | – | `true` enables TLS (also enabled by `sslmode=` in the URL; ssl params are stripped from the URL) |
| `DB_SSL_REJECT_UNAUTHORIZED` | no | `true` in production, else `false` | certificate verification |
| `DB_POOL_MAX` | no | `10` | pg pool size |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | for uploads | – | uploads return 503 without them |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | for LiveKit calls | – | LiveKit features return `LIVEKIT_NOT_CONFIGURED` / 503 without them |

---

## Migrations and deploy

- Apply migrations with **`bun run db:migrate`** (`drizzle-kit migrate`). Do **not** use `drizzle-kit push`: migration `0003` converts `refresh_tokens.token` to `token_hash` by hashing existing tokens in SQL, and `push` would drop the column instead (every user would have to log in again).
- Migrations: `0002_add_call_logs_call_participants.sql` (recreated, idempotent), `0003_hardening_tokens_sender_keys_emoji.sql` (reactions.emoji → varchar(32), sender_keys unique index now includes `owner_id`, refresh token hashing, index on `refresh_tokens.user_id`).
- Drizzle snapshot JSON for 0002/0003 was not generated. The next `bun run db:generate` diffs against `0001_snapshot.json` and may re-emit these changes; review its output before committing.
- Docker: the image sets `NODE_ENV=production PORT=3000`, exposes 3000 and health-checks `GET /health`. Use `/health/ready` for load-balancer readiness.
- `bun.lock` still lists `@types/helmet`; run `bun install` once so `bun install --frozen-lockfile` (Dockerfile/CI) passes.
- Shutdown: SIGTERM/SIGINT close HTTP, Socket.IO, Redis clients and the pg pool. An uncaught exception attempts a clean close with a 10 s hard timeout, then exits 1.
- Scripts: `bun run typecheck`, `bun run build`, `bun test` (jest via `bun run test` needs the MSVC runtime on Windows), `bun run db:generate`, `bun run db:migrate`.
