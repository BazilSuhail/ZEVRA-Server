import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ─── Users ──────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: varchar('username', { length: 32 }).notNull().unique(),
    email: varchar('email', { length: 255 }).notNull().unique(),

    // SRP authentication
    srpSalt: varchar('srp_salt', { length: 64 }).notNull(),
    srpVerifier: text('srp_verifier').notNull(),
    argon2Params: jsonb('argon2_params')
      .notNull()
      .default({ m: 65536, t: 3, p: 4 }),

    // Encrypted key material
    publicKey: varchar('public_key', { length: 64 }).notNull(),
    encryptedPrivateKey: text('encrypted_private_key').notNull(),
    keySalt: varchar('key_salt', { length: 64 }).notNull(),
    publicKeySign: varchar('public_key_sign', { length: 64 }).notNull(),
    encryptedPrivateKeySign: text('encrypted_private_key_sign').notNull(),
    keySaltSign: varchar('key_salt_sign', { length: 64 }).notNull(),
    keyVersion: integer('key_version').notNull().default(1),

    status: text('status').notNull().default('OFFLINE'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at'),
  },
  (t) => [
    index('idx_users_email').on(t.email),
    index('idx_users_username').on(t.username),
  ],
);

// ─── Channels ───────────────────────────────────────────────────────────────

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 64 }),
  type: text('type').notNull().default('DIRECT'),
  isArchived: boolean('is_archived').notNull().default(false),
  lastMessageId: uuid('last_message_id'),
  lastMessageAt: timestamp('last_message_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ─── Memberships ────────────────────────────────────────────────────────────

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role').notNull().default('MEMBER'),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
    leftAt: timestamp('left_at'),
    muted: boolean('muted').notNull().default(false),
    lastReadMessageId: uuid('last_read_message_id'),
    lastReadAt: timestamp('last_read_at'),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('idx_memberships_user_channel').on(t.userId, t.channelId)],
);

// ─── Messages (E2EE) ───────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageType: text('message_type').notNull().default('TEXT'),
    encryptedContent: text('encrypted_content').notNull(),
    contentIv: varchar('content_iv', { length: 32 }).notNull(),
    contentTag: varchar('content_tag', { length: 32 }).notNull(),
    signature: text('signature').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    senderKeyEpoch: integer('sender_key_epoch').notNull().default(0),
    metadata: jsonb('metadata'),
    isDeleted: boolean('is_deleted').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('idx_messages_channel_seq').on(t.channelId, t.sequenceNumber),
    index('idx_messages_channel_created').on(t.channelId, t.createdAt),
  ],
);

// ─── Sender Keys ────────────────────────────────────────────────────────────

export const senderKeys = pgTable(
  'sender_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id').notNull(),
    epoch: integer('epoch').notNull().default(0),
    encryptedKey: text('encrypted_key').notNull(),
    keySignature: text('key_signature').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    receiverId: uuid('receiver_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('idx_sender_keys_group_receiver_epoch').on(
      t.groupId,
      t.receiverId,
      t.epoch,
    ),
    index('idx_sender_keys_receiver_group_epoch').on(
      t.receiverId,
      t.groupId,
      t.epoch,
    ),
  ],
);

// ─── Message Reads ──────────────────────────────────────────────────────────

export const messageReads = pgTable(
  'message_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_message_reads_message_user').on(t.messageId, t.userId),
    index('idx_message_reads_user_read_at').on(t.userId, t.readAt),
  ],
);

// ─── Pending Messages ──────────────────────────────────────────────────────

export const pendingMessages = pgTable(
  'pending_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deliveredAt: timestamp('delivered_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_pending_user_undelivered').on(t.userId, t.deliveredAt),
  ],
);

// ─── Refresh Tokens ─────────────────────────────────────────────────────────

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
});

// ─── Audit Log ──────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: varchar('action', { length: 64 }).notNull(),
    details: jsonb('details'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_audit_log_user_created').on(t.userId, t.createdAt)],
);
