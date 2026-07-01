# REST API

All endpoints return JSON. Errors follow the format:
```json
{
  "statusCode": 403,
  "message": "Not a member of this channel",
  "error": "Forbidden",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Rate limits are enforced per-route. When exceeded, returns `429 Too Many Requests`.

---

## Health

### `GET /health`

**Auth:** None  
**Rate limit:** None

**Response:**
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

---

## Auth

### `POST /api/auth/register`

**Auth:** None  
**Rate limit:** 5 per 5 minutes

**Body:**
```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "securepassword"
}
```

**Response:** `201 Created`
```json
{
  "user": {
    "id": "uuid",
    "username": "alice",
    "email": "alice@example.com",
    "createdAt": "2026-08-27T23:00:00.000Z"
  }
}
```

**Errors:** `409 Conflict` — username or email already taken.

---

### `POST /api/auth/login/start`

**Auth:** None  
**Rate limit:** 10 per minute

**Body:**
```json
{
  "username": "alice"
}
```

**Response:** `200 OK`
```json
{
  "userId": "uuid",
  "username": "alice",
  "srpSalt": "hex-string",
  "B": "hex-string"
}
```

Returns the SRP salt and server public ephemeral (B). Client uses these + password to compute M1.

---

### `POST /api/auth/login/finish`

**Auth:** None  
**Rate limit:** 10 per minute

**Body:**
```json
{
  "username": "alice",
  "A": "hex-string",
  "M1": "hex-string"
}
```

**Response:** `200 OK`
```json
{
  "user": {
    "id": "uuid",
    "username": "alice",
    "email": "alice@example.com"
  },
  "accessToken": "jwt-token",
  "refreshToken": "hex-string",
  "keys": {
    "publicKey": "base64",
    "publicKeySign": "base64",
    "encryptedPrivateKey": "iv:tag:ciphertext",
    "keySalt": "base64",
    "encryptedPrivateKeySign": "iv:tag:ciphertext",
    "keySaltSign": "base64",
    "argon2Params": { "m": 65536, "t": 3, "p": 4 },
    "keyVersion": 1
  },
  "M2": "hex-string"
}
```

Server verifies M1, returns server proof M2, JWT, refresh token, and encrypted key material.

**Errors:** `401 Unauthorized` — invalid SRP proof or expired session.

---

### `POST /api/auth/refresh`

**Auth:** None (uses refresh token in body)  
**Rate limit:** 20 per minute

**Body:**
```json
{
  "refreshToken": "hex-string"
}
```

**Response:** `200 OK`
```json
{
  "accessToken": "new-jwt",
  "refreshToken": "new-hex"
}
```

Old refresh token is deleted (rotation). Returns new pair.

**Errors:** `401 Unauthorized` — invalid or expired refresh token.

---

### `POST /api/auth/logout`

**Auth:** Bearer JWT  
**Rate limit:** None

**Response:** `200 OK`
```json
{ "success": true }
```

Deletes all refresh tokens, sets user status to OFFLINE, removes Redis presence.

---

### `GET /api/auth/me`

**Auth:** Bearer JWT  
**Rate limit:** None

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "username": "alice",
  "email": "alice@example.com",
  "status": "ONLINE",
  "createdAt": "2026-08-27T23:00:00.000Z",
  "lastLoginAt": "2026-08-27T23:00:00.000Z",
  "keyVersion": 1
}
```

---

## Users

### `GET /api/users/search?q=query`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Query params:** `q` (required) — search term (ILIKE on username/email)

**Response:** `200 OK`
```json
[
  {
    "id": "uuid",
    "username": "bob",
    "email": "bob@example.com",
    "status": "ONLINE"
  }
]
```

Excludes the requesting user from results.

---

### `GET /api/users/:id`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "username": "bob",
  "email": "bob@example.com",
  "status": "OFFLINE",
  "createdAt": "2026-08-27T23:00:00.000Z"
}
```

**Errors:** `404 Not Found`

---

### `GET /api/users/me`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Same as `GET /api/auth/me`.

---

## Messages

### `POST /messages`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Body:**
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

**Response:** `201 Created`
```json
{
  "id": "uuid",
  "senderId": "uuid",
  "channelId": "uuid",
  "encryptedContent": "base64-ciphertext",
  "contentIv": "base64-iv",
  "contentTag": "base64-tag",
  "signature": "base64-ed25519-signature",
  "sequenceNumber": 42,
  "senderKeyEpoch": 1,
  "messageType": "TEXT",
  "metadata": null,
  "isDeleted": false,
  "createdAt": "2026-08-27T23:00:00.000Z"
}
```

**Server-side processing:**
1. Verifies channel membership
2. Verifies Ed25519 signature against sender's `public_key_sign`
3. Assigns monotonic `sequence_number` (with retry on collision)
4. Updates `channels.last_message_id`
5. Auto-marks sender's read position
6. Caches in Redis (last 50 messages)
7. Enqueues BullMQ `message-delivery` for async fan-out

**Errors:** `403 Forbidden` — not a member. `400 Bad Request` — invalid signature.

---

### `GET /messages/channel/:channelId`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Query params:**
- `limit` (optional, default 50, max 100)
- `cursor` (optional) — ISO timestamp for pagination

**Response:** `200 OK`
```json
{
  "messages": [
    {
      "id": "uuid",
      "messageType": "TEXT",
      "encryptedContent": "base64",
      "contentIv": "base64",
      "contentTag": "base64",
      "signature": "base64",
      "sequenceNumber": 42,
      "senderKeyEpoch": 1,
      "metadata": null,
      "isDeleted": false,
      "createdAt": "2026-08-27T23:00:00.000Z",
      "senderId": "uuid"
    }
  ],
  "nextCursor": "2026-08-27T22:55:00.000Z",
  "hasMore": true
}
```

**Cache strategy:** If no cursor and Redis cache has enough messages, returns from cache (`source: 'cache'`). Otherwise queries Postgres with cursor pagination.

---

### `DELETE /messages/:id`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Soft-deletes a message (sets `isDeleted: true`). Only the sender can delete their own messages.

**Response:** `200 OK`
```json
{ "success": true }
```

**Errors:** `403 Forbidden` — not the sender. `404 Not Found`.

---

### `POST /messages/channel/:channelId/read/:msgId`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Marks all messages up to `msgId` as read. Advances the read watermark (never regresses).

**Response:** `200 OK`
```json
{ "success": true, "advanced": true }
```

`advanced: false` if the watermark was already at or past this message.

---

### `GET /messages/unread`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Response:** `200 OK`
```json
{
  "channelId1": 5,
  "channelId2": 0,
  "channelId3": 12
}
```

Returns unread counts per channel from Redis cache.

---

## Channels

### `POST /channels`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Body:**
```json
{
  "type": "DIRECT",
  "name": null,
  "participantIds": ["uuid-of-other-user"]
}
```

- `type`: `DIRECT` or `GROUP`
- For DMs: exactly 1 participant, cannot DM yourself. If DM already exists, returns the existing channel.
- For GROUPs: any number of participants. Creator becomes ADMIN.

**Response:** `201 Created`
```json
{
  "id": "uuid",
  "type": "DIRECT",
  "name": null,
  "createdAt": "2026-08-27T23:00:00.000Z"
}
```

---

### `GET /channels`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Returns the user's inbox — all channels with last message preview, ordered by most recent.

**Response:** `200 OK`
```json
[
  {
    "id": "uuid",
    "name": null,
    "type": "DIRECT",
    "isArchived": false,
    "lastMessageId": "uuid",
    "lastMessageAt": "2026-08-27T23:00:00.000Z",
    "lastMessageContent": "base64-ciphertext",
    "lastMessageSenderId": "uuid",
    "lastMessageSenderName": "bob",
    "lastMessageIv": "base64",
    "lastMessageTag": "base64",
    "lastMessageSenderKeyEpoch": 1,
    "createdAt": "2026-08-27T23:00:00.000Z",
    "lastReadMessageId": "uuid"
  }
]
```

---

### `GET /channels/:id`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "name": "Project Chat",
  "type": "GROUP",
  "isArchived": false,
  "lastMessageId": "uuid",
  "lastMessageAt": "2026-08-27T23:00:00.000Z",
  "createdAt": "2026-08-27T23:00:00.000Z",
  "updatedAt": "2026-08-27T23:00:00.000Z",
  "role": "ADMIN",
  "members": [
    {
      "id": "uuid",
      "username": "alice",
      "status": "ONLINE",
      "role": "ADMIN",
      "joinedAt": "2026-08-27T23:00:00.000Z"
    }
  ]
}
```

---

### `POST /channels/:id/members`

**Auth:** Bearer JWT (must be ADMIN)  
**Rate limit:** 60 per minute

**Body:**
```json
{
  "userId": "uuid-of-new-member",
  "role": "MEMBER"
}
```

**Response:** `201 Created`
```json
{
  "membershipId": "uuid",
  "user": {
    "id": "uuid",
    "username": "charlie"
  }
}
```

**Errors:** `403 Forbidden` — not admin. `409 Conflict` — already a member.

---

### `DELETE /channels/:id/members/:userId`

**Auth:** Bearer JWT (must be ADMIN, or removing self)  
**Rate limit:** 60 per minute

**Response:** `200 OK`
```json
{ "success": true }
```

---

### `POST /channels/:id/archive`

**Auth:** Bearer JWT (must be ADMIN)  
**Rate limit:** 60 per minute

Toggles the `isArchived` flag.

**Response:** `200 OK`
```json
{ "isArchived": true }
```

---

### `GET /channels/:id/typing`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Returns list of user IDs currently typing in the channel (excludes the requesting user).

**Response:** `200 OK`
```json
["uuid-of-typing-user-1", "uuid-of-typing-user-2"]
```

---

### `GET /channels/:id/read-receipts`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Returns read receipt map (userId → lastReadMessageId) from Redis cache.

**Response:** `200 OK`
```json
{
  "uuid-user-1": "uuid-message-42",
  "uuid-user-2": "uuid-message-38"
}
```

---

## Keys

### `GET /keys/me`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Returns the user's full key material (public + encrypted private + salts + version).

**Response:** `200 OK`
```json
{
  "publicKey": "base64",
  "encryptedPrivateKey": "iv:tag:ciphertext",
  "keySalt": "base64",
  "publicKeySign": "base64",
  "encryptedPrivateKeySign": "iv:tag:ciphertext",
  "keySaltSign": "base64",
  "keyVersion": 1,
  "argon2Params": { "m": 65536, "t": 3, "p": 4 }
}
```

---

### `GET /keys/public?userIds=id1,id2`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Batch-fetches public keys for multiple users.

**Response:** `200 OK`
```json
[
  {
    "userId": "uuid",
    "publicKey": "base64",
    "publicKeySign": "base64",
    "keyVersion": 1
  }
]
```

---

### `POST /keys/rotate`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Enqueues key rotation to BullMQ. Client generates new key pairs, encrypts them with new KEK, and sends the sealed material.

**Body:**
```json
{
  "password": "current-password",
  "newPublicKey": "base64",
  "newEncryptedPrivateKey": "iv:tag:ciphertext",
  "newKeySalt": "base64",
  "newPublicKeySign": "base64",
  "newEncryptedPrivateKeySign": "iv:tag:ciphertext",
  "newKeySaltSign": "base64",
  "newKeyVersion": 2
}
```

**Response:** `202 Accepted`
```json
{ "queued": true }
```

---

### `POST /keys/sender-keys`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Uploads sender keys for a group (batch). Old keys for the same epoch are replaced.

**Body:**
```json
{
  "groupId": "uuid",
  "epoch": 1,
  "items": [
    {
      "receiverId": "uuid",
      "encryptedKey": "base64",
      "keySignature": "base64"
    }
  ]
}
```

**Response:** `201 Created`
```json
{ "uploaded": 3 }
```

---

### `GET /keys/sender-keys/:groupId`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Returns sender keys for the requesting user in the given group.

**Response:** `200 OK`
```json
[
  {
    "id": "uuid",
    "groupId": "uuid",
    "epoch": 1,
    "encryptedKey": "base64",
    "keySignature": "base64",
    "ownerId": "uuid",
    "createdAt": "2026-08-27T23:00:00.000Z"
  }
]
```

---

### `GET /keys/sender-keys/:groupId/all`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Returns all sender keys for the group (admin/debug use).

---

## Reactions

### `POST /reactions`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Body:**
```json
{
  "channelId": "uuid",
  "messageId": "uuid",
  "emoji": "👍"
}
```

Adds a reaction to a message. Idempotent — returns `already_exists` if the user already reacted with the same emoji.

**Response:** `201 Created`
```json
{ "success": true, "action": "added" }
```

**Errors:** `403 Forbidden` — not a member of the channel.

---

### `DELETE /reactions`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

**Body:**
```json
{
  "channelId": "uuid",
  "messageId": "uuid",
  "emoji": "👍"
}
```

Removes a specific reaction from a message.

**Response:** `200 OK`
```json
{ "success": true, "action": "removed" }
```

---

### `GET /reactions?messageId=uuid&channelId=uuid`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute

Returns all reactions for a message, grouped by emoji.

**Response:** `200 OK`
```json
[
  {
    "emoji": "👍",
    "userIds": ["uuid-user-1", "uuid-user-2"],
    "count": 2
  },
  {
    "emoji": "❤️",
    "userIds": ["uuid-user-3"],
    "count": 1
  }
]
```

---

## Uploads

### `POST /uploads`

**Auth:** Bearer JWT  
**Rate limit:** 60 per minute  
**Content-Type:** `multipart/form-data`

**Body:** `file` field with the file to upload.

**Allowed types:**
- Images: JPEG, PNG, GIF, WebP (up to 10MB)
- Documents: PDF, DOC, DOCX, TXT (up to 10MB)

Images are uploaded to Cloudinary with auto-quality and format optimization. A 200x200 face-centered thumbnail is auto-generated for images.

**Response:** `201 Created`
```json
{
  "url": "https://res.cloudinary.com/dfdf/image/upload/v1234567890/zevra/uploads/abc123.jpg",
  "publicId": "zevra/uploads/abc123",
  "format": "jpg",
  "resourceType": "image",
  "bytes": 45230,
  "width": 1920,
  "height": 1080,
  "thumbnailUrl": "https://res.cloudinary.com/dfdf/image/upload/c_fill,h_200,w_200/zevra/uploads/abc123"
}
```

For non-image files:
```json
{
  "url": "https://res.cloudinary.com/dfdf/raw/upload/v1234567890/zevra/uploads/doc456.pdf",
  "publicId": "zevra/uploads/doc456",
  "format": "pdf",
  "resourceType": "raw",
  "bytes": 102400
}
```

**Errors:** `400 Bad Request` — unsupported file type or no file provided. `413 Payload Too Large` — file exceeds 10MB.

**Usage with messaging:** After uploading, send a message with `messageType: "IMAGE"` or `"FILE"` and include metadata:
```json
{
  "channelId": "uuid",
  "encryptedContent": "encrypted-filename-or-caption",
  "contentIv": "...",
  "contentTag": "...",
  "signature": "...",
  "sequenceNumber": 43,
  "senderKeyEpoch": 1,
  "messageType": "IMAGE",
  "metadata": {
    "fileUrl": "https://res.cloudinary.com/.../image.jpg",
    "publicId": "zevra/uploads/abc123",
    "fileName": "photo.jpg",
    "fileSize": 45230,
    "mimeType": "image/jpeg",
    "thumbnailUrl": "https://res.cloudinary.com/.../thumb.jpg"
  }
}
```

---

## Audit

### `GET /api/audit/logs`

**Auth:** Bearer JWT  
**Rate limit:** 30 per minute

**Query params:**
- `userId` (optional)
- `action` (optional) — e.g. LOGIN, REGISTER, KEY_ROTATE
- `from` (optional) — ISO date
- `to` (optional) — ISO date
- `limit` (optional, default 50)
- `offset` (optional, default 0)

**Response:** `200 OK`
```json
[
  {
    "id": "uuid",
    "action": "LOGIN",
    "details": null,
    "ipAddress": "192.168.1.1",
    "userId": "uuid",
    "createdAt": "2026-08-27T23:00:00.000Z"
  }
]
```

---

### `GET /api/audit/security`

**Auth:** Bearer JWT  
**Rate limit:** 10 per minute

Returns the last 50 security events for the requesting user (LOGIN, LOGIN_FAILED, REGISTER, KEY_ROTATE).

**Response:** `200 OK`
```json
[
  {
    "id": "uuid",
    "action": "LOGIN",
    "ipAddress": "192.168.1.1",
    "createdAt": "2026-08-27T23:00:00.000Z"
  }
]
```
