# Database

PostgreSQL (Neon) via Drizzle ORM. Schema defined in `src/database/schema.ts`, migrations in `drizzle/`.

## Tables

### `users`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `username` | varchar(32) | | UNIQUE |
| `email` | varchar(255) | | UNIQUE |
| `srp_salt` | varchar(64) | | SRP auth salt |
| `srp_verifier` | text | | SRP verifier (g^x mod N) |
| `argon2_params` | jsonb | `{"m":65536,"t":3,"p":4}` | Argon2id params |
| `public_key` | varchar(64) | | X25519 public key (base64) |
| `encrypted_private_key` | text | | X25519 private key sealed with KEK |
| `key_salt` | varchar(64) | | Salt for Argon2id KEK derivation |
| `public_key_sign` | varchar(64) | | Ed25519 public key (base64) |
| `encrypted_private_key_sign` | text | | Ed25519 private key sealed with KEK |
| `key_salt_sign` | varchar(64) | | Salt for signing KEK derivation |
| `key_version` | integer | `1` | Key rotation version counter |
| `status` | text | `'OFFLINE'` | Presence status (ONLINE/OFFLINE) |
| `is_active` | boolean | `true` | Account active flag |
| `created_at` | timestamp | `now()` | |
| `updated_at` | timestamp | `now()` | |
| `last_login_at` | timestamp | | Nullable |

**Indexes:** `idx_users_email` (btree), `idx_users_username` (btree)

---

### `channels`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `name` | varchar(64) | | Optional channel name |
| `type` | text | `'DIRECT'` | DIRECT or GROUP |
| `is_archived` | boolean | `false` | |
| `last_message_id` | uuid | | Cached last message (no FK) |
| `last_message_at` | timestamp | | Cached timestamp |
| `created_at` | timestamp | `now()` | |
| `updated_at` | timestamp | `now()` | |

**Note:** `participant_ids text[]` was dropped in migration 0001. Membership is tracked via the `memberships` join table.

---

### `memberships`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `role` | text | `'MEMBER'` | MEMBER or ADMIN |
| `joined_at` | timestamp | `now()` | |
| `left_at` | timestamp | | Null = still a member |
| `muted` | boolean | `false` | |
| `last_read_message_id` | uuid | | Read watermark |
| `last_read_at` | timestamp | | |
| `user_id` | uuid | | FK → users (CASCADE) |
| `channel_id` | uuid | | FK → channels (CASCADE) |

**Unique:** `idx_memberships_user_channel` on (user_id, channel_id)

---

### `messages`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `message_type` | text | `'TEXT'` | TEXT, IMAGE, FILE, SYSTEM |
| `encrypted_content` | text | | E2EE ciphertext |
| `content_iv` | varchar(32) | | AES-GCM initialization vector |
| `content_tag` | varchar(32) | | AES-GCM auth tag |
| `signature` | text | | Ed25519 signature |
| `sequence_number` | integer | | Monotonic per channel |
| `sender_key_epoch` | integer | `0` | Key epoch used for encryption |
| `metadata` | jsonb | | Arbitrary extra data |
| `is_deleted` | boolean | `false` | Soft delete |
| `created_at` | timestamp | `now()` | |
| `updated_at` | timestamp | `now()` | |
| `sender_id` | uuid | | FK → users (CASCADE) |
| `channel_id` | uuid | | FK → channels (CASCADE) |

**Unique:** `idx_messages_channel_seq` on (channel_id, sequence_number)  
**Index:** `idx_messages_channel_created` on (channel_id, created_at)

---

### `message_reads`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `message_id` | uuid | | FK → messages (CASCADE) |
| `user_id` | uuid | | FK → users (CASCADE) |
| `read_at` | timestamp | `now()` | |

**Unique:** `idx_message_reads_message_user` on (message_id, user_id)  
**Index:** `idx_message_reads_user_read_at` on (user_id, read_at)

---

### `pending_messages`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `message_id` | uuid | | FK → messages (CASCADE) |
| `user_id` | uuid | | FK → users (CASCADE) |
| `delivered_at` | timestamp | | Null = not yet delivered |
| `created_at` | timestamp | `now()` | |

**Index:** `idx_pending_user_undelivered` on (user_id, delivered_at)

---

### `refresh_tokens`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `token` | text | | UNIQUE, opaque random hex |
| `expires_at` | timestamp | | 7-day expiry |
| `created_at` | timestamp | `now()` | |
| `user_id` | uuid | | FK → users (CASCADE) |

---

### `sender_keys`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `group_id` | uuid | | Channel or key group ID |
| `epoch` | integer | `0` | Key rotation epoch |
| `encrypted_key` | text | | Sender key encrypted for receiver |
| `key_signature` | text | | Signature proving key authenticity |
| `created_at` | timestamp | `now()` | |
| `owner_id` | uuid | | FK → users (CASCADE) — key sender |
| `receiver_id` | uuid | | FK → users (CASCADE) — key recipient |

**Unique:** `idx_sender_keys_group_receiver_epoch` on (group_id, receiver_id, epoch)  
**Index:** `idx_sender_keys_receiver_group_epoch` on (receiver_id, group_id, epoch)

---

### `audit_log`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid | `gen_random_uuid()` | PK |
| `action` | varchar(64) | | LOGIN, REGISTER, LOGIN_FAILED, KEY_ROTATE, etc. |
| `details` | jsonb | | Arbitrary event data |
| `ip_address` | varchar(45) | | IPv4 or IPv6 |
| `user_id` | uuid | | FK → users (SET NULL on delete) |
| `created_at` | timestamp | `now()` | |

**Index:** `idx_audit_log_user_created` on (user_id, created_at)

## Relationships

```
users ─┬─< memberships          (1:N, CASCADE)
       ├─< messages             (1:N, CASCADE)
       ├─< message_reads        (1:N, CASCADE)
       ├─< pending_messages     (1:N, CASCADE)
       ├─< refresh_tokens       (1:N, CASCADE)
       ├─< sender_keys.owner    (1:N, CASCADE)
       ├─< sender_keys.receiver (1:N, CASCADE)
       └─< audit_log            (1:N, SET NULL)

channels ─┬─< memberships      (1:N, CASCADE)
           └─< messages         (1:N, CASCADE)

messages ─┬─< message_reads     (1:N, CASCADE)
          └─< pending_messages  (1:N, CASCADE)
```

**12 foreign keys total.** All CASCADE except `audit_log.user_id` (SET NULL).

**Implicit references (no FK constraint):**
- `channels.last_message_id` → `messages.id`
- `memberships.last_read_message_id` → `messages.id`
- `sender_keys.group_id` → logical channel/group ID

## Migration History

| Migration | Description |
|-----------|-------------|
| `0000_productive_outlaw_kid.sql` | Initial schema: all tables created |
| `0001_drop_participant_ids_add_pending_messages.sql` | Drop `participant_ids text[]` from channels; add `pending_messages` table |

## Key Query Patterns

### Sequence Number Assignment (with row locking)

```sql
-- Inside a transaction:
SELECT id FROM channels WHERE id = $1 FOR UPDATE;          -- serialize per channel
SELECT COALESCE(MAX(sequence_number), 0) FROM messages WHERE channel_id = $1;
INSERT INTO messages (..., sequence_number) VALUES ($1, $2);
```

Unique constraint `idx_messages_channel_seq` prevents duplicate sequence numbers. On collision (Postgres error `23505`), the transaction retries up to 3 times.

### DM Channel Deduplication

```sql
-- Find existing DIRECT channel with exactly these two members:
SELECT channel_id FROM memberships
WHERE user_id IN ($userId, $targetUserId)
GROUP BY channel_id
HAVING COUNT(*) = 2;
```

### Cursor-Based Pagination

```sql
SELECT * FROM messages
WHERE channel_id = $1 AND created_at < $cursor
ORDER BY created_at DESC
LIMIT $limit + 1;   -- extra row to determine hasMore
```

### Read Waterhead (never regress)

```sql
-- Only advance if the new message is newer than current read position:
SELECT created_at FROM messages WHERE id = $currentReadMessageId;
-- If current.createdAt >= newMsg.createdAt → skip (no regression)
```
